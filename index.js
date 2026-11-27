import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { z as schema } from 'zod';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { SessionRelay, DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD, validateSettings, receivedMessageIds } from './relay.js';

export const name = 'session-relay';
export const inject = ['commands', 'tools', 'sessionProjections', 'sessionQuery', 'storageDomain', 'sessionController', 'sessionPersistence', 'workingDirectory', 'agentPresets', 'configEditor'];
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  threshold: z.number().min(MIN_THRESHOLD).max(MAX_THRESHOLD).step(1).default(DEFAULT_THRESHOLD).volatile(),
  autoContinue: z.boolean().default(true).volatile(),
  autoSwitch: z.boolean().default(true).volatile(),
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
    autoContinue: config.autoContinue.get(), autoSwitch: config.autoSwitch.get(),
  });
  const configure = async patch => {
    validateSettings(patch);
    await ctx.configEditor.edit(ctx.fiber.entry, value => ({ ...value, ...patch }));
    return current();
  };
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
      case 'retry': await relay.retry(agent); return status(agent);
      case 'release': return { ...await relay.release(agent), ...status(agent) };
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
      settings: { type: 'object', properties: { enabled: { type: 'boolean' }, threshold: { type: 'integer', minimum: MIN_THRESHOLD, maximum: MAX_THRESHOLD }, autoContinue: { type: 'boolean' }, autoSwitch: { type: 'boolean' } }, additionalProperties: false },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => { if (!exec.agent) throw new Error('Session required'); return action(exec.agent, args ?? {}, exec.signal); },
  });
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    try {
      if (await relay.boundary(payload.agent, decision.messages, true, payload.signal)) return { kind: 'reject' };
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
    await relay.boundary(agent, [], false, signal);
  });
}
