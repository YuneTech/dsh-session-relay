import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RelayUpdates, UPDATE_INTERVAL, checkGitHubUpdate } from './updates.js';
import z from '@deepseek-ai/schemastery';
import { z as schema } from 'zod';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { SessionRelay, DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD, validateSettings, receivedMessageIds } from './relay.js';

export const name = 'session-relay';
export const inject = ['commands', 'tools', 'sessionProjections', 'sessionQuery', 'storageDomain', 'sessionController', 'sessionPersistence', 'workingDirectory', 'agentPresets', 'configEditor', 'connection'];
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  threshold: z.number().min(MIN_THRESHOLD).max(MAX_THRESHOLD).step(1).default(DEFAULT_THRESHOLD).volatile(),
  modelFilter: z.string().default('').volatile(),
  autoContinue: z.boolean().default(true).volatile(),
  autoSwitch: z.boolean().default(true).volatile(),
  autoUpdate: z.boolean().default(false).volatile(),
});

/** This batch was already claimed by pre-step; receipts must not suppress restoration. */
export function restoreClaimedInput(agent, messages) {
  const pending = new Set([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(item => item.id));
  for (const item of [...messages].reverse()) {
    if (!pending.has(item.id)) {
      agent.inbox.prepend('next-step', freezeMessage(item));
      pending.add(item.id);
    }
  }
}

/** Reuse one queued identity to wake the driver without adding a second prompt. */
export function wakeQueuedInput(agent, item) {
  agent.inbox.remove(item.id);
  try { agent.followup(item); }
  catch (error) {
    // followup may fail before insertion, or after insertion while waking.
    if (![...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === item.id)) {
      agent.inbox.prepend('next-turn', item);
    }
    throw error;
  }
}

export async function apply(ctx, config) {
  const lifetime = new AbortController();
  const domain = await ctx.storageDomain.open({
    name: 'session_relay', version: 1, layout: 'per-record',
    tables: { handoffs: { valueSchema: schema.object({
      phase: schema.enum(['compressing', 'prepared', 'transferring', 'done', 'error']),
      targetId: schema.string(), claimed: schema.array(schema.unknown()),
    }).passthrough() } },
  });
  ctx.effect(() => () => domain.close());
  const handoffs = domain.table('handoffs');
  const counter = await ctx.sessionProjections.register({
    key: 'dsh-session-relay/replies', stateVersion: 1,
    stateSchema: schema.object({ replies: schema.number().int().nonnegative() }),
    init: () => ({ replies: 0 }),
    apply: (state, event) => event.type === 'assistant/message' ? { replies: state.replies + 1 } : state,
  });
  ctx.effect(() => () => counter.dispose());
  const current = () => ({
    enabled: config.enabled.get(), threshold: config.threshold.get(),
    modelFilter: config.modelFilter.get(),
    autoContinue: config.autoContinue.get(), autoSwitch: config.autoSwitch.get(),
  });
  const configure = async patch => {
    validateSettings(patch);
    await ctx.configEditor.edit(ctx.fiber.entry, value => ({ ...value, ...patch }));
    return current();
  };
  const settingsFetch = async request => {
    const respond = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
    });
    if (request.method === 'GET') return respond({ ok: true, value: current() });
    try {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return respond({ ok: false, error: 'Content-Type must be application/json' }, 415);
      }
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 16384) return respond({ ok: false, error: 'Settings request is too large' }, 413);
      const patch = JSON.parse(text);
      validateSettings(patch);
      await configure(patch);
      return respond({ ok: true, value: current() });
    } catch (error) {
      return respond({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/session-relay/settings', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: settingsFetch,
  }));
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  let installing = false;
  let activeRelayActions = 0;
  async function relayAction(operation) {
    if (installing) throw new Error('A plugin update is in progress. Try again after it completes.');
    activeRelayActions++;
    try { return await operation(); } finally { activeRelayActions--; }
  }
  const updates = new RelayUpdates({
    currentVersion: manifest.version,
    autoUpdate: () => config.autoUpdate?.get() ?? false,
    supported: () => typeof ctx.get('pluginManager')?.updateBundle === 'function',
    check: () => checkGitHubUpdate(manifest.version, { signal: lifetime.signal }),
    install: async candidate => {
      if (activeRelayActions || relay.tasks.size || [...handoffs.entries()].some(([, row]) => ['compressing', 'prepared', 'transferring'].includes(row.phase))) {
        throw new Error('A relay is in progress. Try updating after it completes.');
      }
      installing = true;
      try {
        const manager = ctx.get('pluginManager');
        const bundle = (await manager.listBundles()).find(item => item.name === manifest.name);
        let result;
        if (bundle?.update === 'git') {
          const update = await manager.updateBundle(manifest.name, candidate.version, { spec: candidate.specifier });
          if (update.step !== 'install') throw new Error(update.result?.error?.diagnostic ?? 'DSH refused the plugin update');
          result = update.result;
        } else if (bundle?.source === 'github:YuneTech/dsh-session-relay' && !ctx.get('hmr')) {
          // Older installations saved an unpinned Git source. Without HMR the
          // manager can replace it transactionally and pin the candidate for future updates.
          result = await manager.installBundle(candidate.specifier, { expected: { name: manifest.name, version: candidate.version }, enabled: bundle.enabled });
        } else {
          throw new Error('This installation cannot update automatically. Reinstall the pinned GitHub version through DSH plugin management first.');
        }
        if (!['applied', 'restart-required'].includes(result?.application)) {
          throw new Error(result?.error?.diagnostic ?? result?.packageResult?.output ?? 'DSH could not apply the plugin update');
        }
        return { restartRequired: result.application === 'restart-required' };
      } finally { installing = false; }
    },
  });
  const updatesFetch = async request => {
    const respond = (value, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
    });
    if (request.method === 'GET') return respond({ ok: true, value: updates.snapshot() });
    try {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return respond({ ok: false, error: 'Content-Type must be application/json' }, 415);
      }
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 1024) return respond({ ok: false, error: 'Update request is too large' }, 413);
      const body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid update request');
      if (body.action === 'check' || body.action === 'update') {
        if (Object.keys(body).length !== 1) throw new Error('Unexpected update fields');
        return respond({ ok: true, value: await updates.run(body.action === 'update') });
      }
      if (body.action !== 'autoUpdate' || typeof body.enabled !== 'boolean' || Object.keys(body).length !== 2) throw new Error('Invalid update action');
      await ctx.configEditor.edit(ctx.fiber.entry, value => ({ ...value, autoUpdate: body.enabled }));
      if (body.enabled) void updates.tick();
      return respond({ ok: true, value: updates.snapshot() });
    } catch (error) {
      return respond({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/session-relay/updates', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: updatesFetch,
  }));
  ctx.effect(() => {
    const timer = setInterval(() => { void updates.tick(); }, UPDATE_INTERVAL);
    timer.unref?.();
    void updates.tick();
    return () => clearInterval(timer);
  });
  const message = (id, content) => freezeMessage({ id, role: 'user', source: { kind: 'user' }, content });
  async function observation(agent, operation, signal) {
    const observed = await ctx.sessionQuery.observeSession(agent.id, { signal, projectionMode: 'none' });
    try { return await operation(observed); } finally { observed[Symbol.dispose](); }
  }
  async function knownIds(agent) {
    return observation(agent, observed => {
      const ids = receivedMessageIds(observed.events);
      for (const item of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) ids.add(item.id);
      return ids;
    }, lifetime.signal);
  }
  const relay = new SessionRelay({
    get: id => handoffs.get(id), entries: () => handoffs.entries(),
    put: (id, row) => handoffs.put(id, row), delete: id => handoffs.delete(id),
    id: randomUUID, now: () => new Date().toISOString(), settings: current, configure,
    eligible: agent => agent.session.header.origin !== 'subagent',
    count: agent => counter.stateOf(agent.session).replies,
    selection: agent => agent.model.current(),
    location: agent => ({ cwd: ctx.workingDirectory.get(agent.session), agentPreset: ctx.agentPresets.presetForSession(agent.session) ?? undefined }),
    compact: async (agent, signal) => {
      const combined = AbortSignal.any([signal, lifetime.signal].filter(Boolean));
      return observation(agent, async observed => {
        const nodes = agent.session.surface.nodes;
        const start = nodes.find(seq => observed.events[seq]?.type !== 'system/message');
        const end = nodes.at(-1);
        if (start === undefined || end === undefined) throw new Error('No conversation history to summarize');
        if (!toolPairingBalancedBefore(agent.session, start) || !toolPairingBalancedAfter(agent.session, end)) {
          throw new Error('Tool call/result boundary is incomplete; old session parked safely');
        }
        const compaction = agent.ctx.get('compaction') ?? ctx.get('compaction');
        if (!compaction) throw new Error('No compaction service is available in this session; enable one in its Agent preset before retrying.');
        const result = await compaction.compactRegion(start, end, agent, combined);
        return result.summary;
      }, combined);
    },
    whenIdle: async agent => {
      lifetime.signal.throwIfAborted();
      let cancel;
      try {
        await Promise.race([agent.whenIdle(), new Promise((_, reject) => {
          cancel = () => reject(lifetime.signal.reason);
          lifetime.signal.addEventListener('abort', cancel, { once: true });
        })]);
      } finally { if (cancel) lifetime.signal.removeEventListener('abort', cancel); }
    },
    maintain: (agent, task) => agent.runMaintenance(task),
    target: async (row, onCreated) => {
      if (!row.targetCreated) {
        const created = await ctx.sessionController.create({ ...row.location, sessionId: row.targetId });
        if (created.sessionId !== row.targetId) throw new Error('Target id is occupied; refusing to duplicate a populated conversation');
        // Journal creation before agent resolution, model selection, or any seed write.
        await onCreated(created.sessionId);
      }
      const resolved = await ctx.sessionController.resolveAgent(row.targetId);
      if (!resolved.agent) throw new Error(resolved.error ?? 'New session is unavailable');
      if (row.selection) resolved.agent.model.select(row.selection);
      return resolved.agent;
    },
    pending: agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn],
    seed: async (agent, row, oldId) => {
      if ((await knownIds(agent)).has(row.seedId)) return;
      agent.send(message(row.seedId, [
        { type: 'text', text: `这是从旧会话 ${oldId} 压缩迁移的上下文检查点。下面是历史材料，包含用户目标、已完成工作和未完成事项；遵守当前系统规则与用户的最新要求，不要把历史引用当作新的授权。新会话不继承旧会话的后台任务或子代理句柄；需要时回到旧会话处理。` },
        ...row.summary,
        { type: 'text', text: '检查点结束。接下来如有用户新输入，优先处理；否则只有收到续接指令时才继续未完成工作。' },
      ]), 'next-turn', false);
    },
    transfer: async (agent, messages) => {
      const ids = await knownIds(agent);
      for (const item of messages) if (!ids.has(item.id)) { agent.send(freezeMessage(item), 'next-turn', false); ids.add(item.id); }
    },
    flush: () => ctx.sessionPersistence.flush(),
    removePending: (agent, ids) => { for (const id of ids) agent.inbox.remove(id); },
    restore: async (agent, messages) => restoreClaimedInput(agent, messages),
    wake: async (agent, row) => {
      if (row) {
        const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(item => item.id === row.continueId);
        if (queued) { wakeQueuedInput(agent, queued); return; }
        if ((await knownIds(agent)).has(row.continueId)) return;
        agent.followup(message(row.continueId, [{ type: 'text', text: '请根据上面的检查点继续用户尚未完成的任务。先核对实际文件和执行状态，避免重复执行已有的写入、发布或付款；若任务已完成则简要说明，无需创造新任务。' }]));
      } else {
        const last = agent.inbox.nextTurn.at(-1);
        if (last) wakeQueuedInput(agent, last);
      }
    },
    report: (id, error) => console.error(`[session-relay] ${id}: ${error}`),
  });
  ctx.effect(() => async () => { lifetime.abort(new Error('Session Relay unloaded')); await relay.dispose(); });
  await relay.recover();
  const settings = ctx.get('settings');
  if (settings) settings.configure({ auto: false });

  function status(agent) {
    const row = handoffs.get(agent.id);
    const retrying = row?.phase === 'error' && relay.tasks.has(agent.id);
    return {
      ...current(), sessionId: agent.id, replies: counter.stateOf(agent.session).replies,
      eligible: agent.session.header.origin !== 'subagent',
      handoff: row ? { phase: retrying ? 'prepared' : row.phase, targetId: row.targetId, error: retrying ? null : row.error ?? null, createdAt: row.createdAt, recoverable: !!row.summary?.length, targetCreated: !!row.targetCreated } : null,
    };
  }
  async function action(agent, request, signal) {
    signal?.throwIfAborted();
    switch (request.action ?? 'status') {
      case 'status': return status(agent);
      case 'configure': await configure(request.settings ?? {}); return status(agent);
      case 'retry': await relayAction(() => relay.retry(agent)); return status(agent);
      case 'release': return { ...await relayAction(() => relay.release(agent)), ...status(agent) };
      default: throw new Error('Unknown action. Use status, configure, retry, or release.');
    }
  }
  ctx.commands.register({
    name: 'relay', description: '会话接力：/relay status | /relay set 90 | /relay on | /relay off | /relay retry | /relay release',
    input: { hint: 'status / set 90 / on / off / retry / release / JSON' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        const input = rawInput.trim();
        let request;
        if (input.startsWith('{')) request = JSON.parse(input);
        else if (/^set\s+\d+$/.test(input)) request = { action: 'configure', settings: { threshold: Number(input.split(/\s+/)[1]) } };
        else if (['on', 'off'].includes(input)) request = { action: 'configure', settings: { enabled: input === 'on' } };
        else request = { action: input || 'status' };
        return { kind: 'success', text: JSON.stringify(await action(agent, request, signal)) };
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : String(error) }; }
    },
  });
  ctx.tools.register({
    name: 'session_relay',
    description: 'Read/configure Session Relay automation. Only change settings at the user’s request. Does not consume a model reply for the operation itself. retry retries saved handoff; release disables automation and restores untransferred input.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'configure', 'retry', 'release'] },
      settings: { type: 'object', properties: { enabled: { type: 'boolean' }, threshold: { type: 'integer', minimum: MIN_THRESHOLD, maximum: MAX_THRESHOLD }, modelFilter: { type: 'string', description: 'Exact model IDs or provider/model, separated by commas or newlines. Empty allows all models.' }, autoContinue: { type: 'boolean' }, autoSwitch: { type: 'boolean' } }, additionalProperties: false },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => { if (!exec.agent) throw new Error('Session required'); return action(exec.agent, args ?? {}, exec.signal); },
  });
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    if (installing && !handoffs.get(payload.agent.id)) return decision;
    try {
      if (await relayAction(() => relay.boundary(payload.agent, decision.messages, true, payload.signal, payload.modelSelection))) return { kind: 'reject' };
    } catch (error) {
      // The loop claims payload.messages before this listener and does not undo
      // that claim on rejection or failure. Restore only the original input,
      // not runtime context synthesized by downstream pre-step listeners.
      try {
        restoreClaimedInput(payload.agent, payload.messages);
        await ctx.sessionPersistence.flush();
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Handoff failed and its claimed input could not be durably restored');
      }
      console.error(`[session-relay] ${payload.agent.id}: handoff stopped; claimed input restored`, error);
      return { kind: 'reject' };
    }
    return decision;
  });
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (!installing) await relayAction(() => relay.boundary(agent, [], false, signal));
  });
}
