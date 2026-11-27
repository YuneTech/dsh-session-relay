import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const hasRuntime = !!process.env.DSH_INSTALL_DIR;
if (hasRuntime) {
  const resolveFromRuntime = createRequire(pathToFileURL(`${process.env.DSH_INSTALL_DIR}/package.json`));
  registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (error) {
        if (!specifier.startsWith('@deepseek-ai/') && specifier !== 'zod') throw error;
        return { url: pathToFileURL(resolveFromRuntime.resolve(specifier)).href, shortCircuit: true };
      }
    },
  });
}

const msg = id => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'user' } });
const summary = [{ type: 'text', text: 'saved checkpoint' }];
const savedRow = (patch = {}) => ({
  phase: 'error', targetId: 'new-session', targetCreated: true,
  claimed: [], pending: [], resume: true, seedId: 'seed', continueId: 'continue',
  summary, location: { cwd: '/project' }, selection: null, ...patch,
});

/** Local structural doubles; no Host business service or provider is called. */
async function harness(initialRows = new Map(), options = {}) {
  const plugin = await import('../index.js');
  const rows = new Map(initialRows);
  const agents = new Map();
  const listeners = new Map();
  const maintenance = [];
  const effects = { creates: 0, flushes: 0, queries: 0, compactions: 0 };
  const settingValues = { enabled: true, threshold: 90, modelFilter: '', autoContinue: true, autoSwitch: true, ...options.config };
  const config = Object.fromEntries(Object.keys(settingValues).map(key => [key, { get: () => settingValues[key] }]));
  const routes = new Map();
  const configEdits = [];
  let command;
  function makeAgent(id) {
    const queues = { 'next-turn': [], 'next-step': [] };
    const events = [];
    let selection = { provider: 'test', model: 'test' };
    function splice(target, start, count, inserted, outcome) {
      const removed = queues[target].splice(start, count, ...inserted);
      events.push({ type: 'agent/inbox/spliced', data: { target, start, removedCount: count, inserted, ...(outcome ? { outcome } : {}) } });
      return removed;
    }
    const inbox = {
      get nextTurn() { return queues['next-turn']; },
      get nextStep() { return queues['next-step']; },
      prepend: (target, item) => splice(target, 0, 0, [item]),
      remove: id => {
        for (const target of ['next-turn', 'next-step']) {
          const index = queues[target].findIndex(item => item.id === id);
          if (index >= 0) { splice(target, index, 1, [], 'canceled'); return true; }
        }
        return false;
      },
    };
    const agent = {
      id, events, inbox, sent: [], wakes: [], selections: [], replies: 90, status: 'idle',
      session: { header: { id }, surface: { nodes: [] } },
      ctx: { get: key => key === 'compaction' ? options.scopedCompaction : undefined },
      model: {
        current: () => selection,
        select(next) { selection = next; agent.selections.push(next); },
      },
      whenIdle: async () => {},
      runMaintenance: task => {
        const promise = task(new AbortController().signal);
        maintenance.push(promise);
        return promise;
      },
      send: (item, target, wake) => {
        if ([...inbox.nextTurn, ...inbox.nextStep].some(pending => pending.id === item.id)) throw new Error('duplicate pending id');
        splice(target, queues[target].length, 0, [item]);
        agent.sent.push(item);
        if (wake) agent.wakes.push(item.id);
      },
      followup: item => agent.send(item, 'next-turn', true),
      claim: () => {
        for (const target of ['next-step', 'next-turn']) {
          if (queues[target].length) splice(target, 0, queues[target].length, []);
        }
      },
    };
    agents.set(id, agent);
    return agent;
  }
  const old = makeAgent('old-session');
  const target = makeAgent('new-session');
  const table = {
    get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, row) => {
      if (options.failPut?.(id, row)) throw new Error('handoff storage unavailable');
      rows.set(id, structuredClone(row));
    },
    delete: async id => rows.delete(id),
  };
  const ctx = {
    storageDomain: { open: async spec => {
      const { UNIT_NAME_RE } = await import('@deepseek-ai/dsh-storage');
      assert.match(spec.name, UNIT_NAME_RE);
      for (const name of Object.keys(spec.tables)) assert.match(name, UNIT_NAME_RE);
      return { table: () => table, close: async () => {} };
    } },
    sessionProjections: { register: async () => ({
      stateOf: session => ({ replies: agents.get(session.header.id).replies }), dispose() {},
    }) },
    sessionQuery: { observeSession: async id => {
      effects.queries++;
      return { events: agents.get(id).events, [Symbol.dispose]() {} };
    } },
    sessionPersistence: { flush: async () => { effects.flushes++; } },
    sessionController: {
      create: async request => { effects.creates++; if (!agents.has(request.sessionId)) makeAgent(request.sessionId); return { sessionId: request.sessionId }; },
      resolveAgent: async id => ({ agent: agents.get(id) }),
    },
    workingDirectory: { get: () => '/project' },
    agentPresets: { presetForSession: () => null },
    configEditor: { edit: async (_entry, change) => {
      const next = change({ ...settingValues }, {});
      configEdits.push(next);
      Object.assign(settingValues, next);
    } },
    connection: { fetch: { register: spec => {
      const key = spec.path + ':' + spec.methods.join(',');
      routes.set(key, spec);
      return () => routes.delete(key);
    } } },
    fiber: { entry: 'test-entry' },
    commands: { register: spec => { command = spec.handler; } },
    tools: { register() {} },
    on: (name, callback) => listeners.set(name, callback),
    effect: setup => { setup(); },
    get: key => key === 'compaction' ? options.globalCompaction : undefined,
  };
  await plugin.apply(ctx, config);
  return {
    plugin, old, target, rows, agents, listeners, effects, routes, settingValues, configEdits,
    settingsRequest: (method, body, contentType = 'application/json') => {
      const route = routes.get('/api/session-relay/settings:GET,POST');
      assert.ok(route, 'settings route is registered');
      return route.fetch(new Request('http://localhost/api/session-relay/settings', {
        method, ...(body === undefined ? {} : { headers: { 'content-type': contentType }, body: JSON.stringify(body) }),
      }));
    },
    command: rawInput => command({ agent: old, rawInput, signal: new AbortController().signal }),
    settle: async () => { await new Promise(setImmediate); await Promise.all(maintenance); },
  };
}

test('global settings route reads and persists partial updates without a session', { skip: !hasRuntime }, async () => {
  const h = await harness();
  const read = await h.settingsRequest('GET');
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { ok: true, value: h.settingValues });

  const patch = { threshold: 73, modelFilter: 'vendor/model-a\nmodel-b' };
  const saved = await h.settingsRequest('POST', patch);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, value: h.settingValues });
  assert.deepEqual(h.settingValues, { enabled: true, threshold: 73, modelFilter: patch.modelFilter, autoContinue: true, autoSwitch: true });
  assert.deepEqual(h.configEdits, [h.settingValues]);

  const invalid = await h.settingsRequest('POST', { threshold: 1 });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { ok: false, error: 'threshold must be an integer from 2 to 10000' });
  assert.equal(h.settingValues.threshold, 73);
  assert.equal(h.configEdits.length, 1);
  const wrongContentType = await h.settingsRequest('POST', { enabled: false }, 'text/plain');
  assert.equal(wrongContentType.status, 415);
  assert.equal(h.settingValues.enabled, true);
});

test('Host imports against installed DSH without requiring a global compaction service', { skip: !hasRuntime }, async () => {
  const plugin = await import('../index.js');
  assert.equal(plugin.name, 'session-relay');
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.inject.includes('compaction'), false);
  const value = plugin.Config({});
  assert.equal(value.enabled.get(), false);
  assert.equal(value.threshold.get(), 90);
  const h = await harness(new Map([['old-session', savedRow({ phase: 'prepared' })]]));
  assert.equal(h.rows.get(h.old.id).phase, 'error');
  assert.match(h.rows.get(h.old.id).error, /restart or reload/);
  assert.equal(h.effects.creates, 0);
  assert.equal(h.effects.queries, 0);
});

test('adapter does not duplicate target input or seed after durable claim before user admission', { skip: !hasRuntime }, async () => {
  const h = await harness(new Map([['old-session', savedRow({ claimed: [msg('input')] })]]));
  h.target.send(msg('seed'), 'next-turn', false);
  h.target.send(msg('input'), 'next-turn', false);
  h.target.claim();
  h.target.sent.length = 0;
  const result = await h.command('retry'); await h.settle();
  assert.equal(result.kind, 'success');
  assert.equal(h.rows.get(h.old.id).phase, 'done');
  assert.deepEqual(h.target.sent, []);
  assert.deepEqual(h.target.wakes, []);
});

test('adapter wakes an already queued continuation using the same message identity', { skip: !hasRuntime }, async () => {
  const h = await harness(new Map([['old-session', savedRow()]]));
  h.target.send(msg('seed'), 'next-turn', false);
  h.target.claim();
  h.target.send(msg('continue'), 'next-turn', false);
  h.target.sent.length = 0;
  await h.command('retry'); await h.settle();
  assert.deepEqual(h.target.wakes, ['continue']);
  assert.deepEqual(h.target.inbox.nextTurn.map(item => item.id), ['continue']);
  assert.equal(h.rows.get(h.old.id).phase, 'done');
});

test('adapter does not replay a continuation already claimed by the target', { skip: !hasRuntime }, async () => {
  const h = await harness(new Map([['old-session', savedRow()]]));
  h.target.send(msg('seed'), 'next-turn', false);
  h.target.send(msg('continue'), 'next-turn', false);
  h.target.claim();
  h.target.sent.length = 0;
  await h.command('retry'); await h.settle();
  assert.deepEqual(h.target.wakes, []);
  assert.deepEqual(h.target.sent, []);
  assert.equal(h.rows.get(h.old.id).phase, 'done');
});

test('first journal write failure restores only the original claimed batch and rejects the step', { skip: !hasRuntime }, async t => {
  t.mock.method(console, 'error', () => {});
  const h = await harness(new Map(), { failPut: () => true });
  const input = [msg('one'), msg('two')];
  const decision = await h.listeners.get('agent/pre-step')({ agent: h.old, messages: input, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [...input, msg('runtime-context')] }));
  assert.deepEqual(decision, { kind: 'reject' });
  assert.deepEqual(h.old.inbox.nextStep.map(item => item.id), ['one', 'two']);
  assert.equal(h.rows.size, 0);
  assert.deepEqual(h.old.wakes, []);
  assert.equal(h.effects.flushes, 1);
});

test('capture write failure restores newly claimed input ahead of racing pending input', { skip: !hasRuntime }, async t => {
  t.mock.method(console, 'error', () => {});
  const initial = savedRow({ targetCreated: false, claimed: [msg('saved')] });
  const h = await harness(new Map([['old-session', initial]]), { failPut: (_id, row) => row.claimed.length > 1 });
  h.old.send(msg('racing'), 'next-step', false);
  const input = [msg('fresh')];
  const decision = await h.listeners.get('agent/pre-step')({ agent: h.old, messages: input, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: input }));
  assert.deepEqual(decision, { kind: 'reject' });
  assert.deepEqual(h.old.inbox.nextStep.map(item => item.id), ['fresh', 'racing']);
  assert.deepEqual(h.rows.get(h.old.id).claimed.map(item => item.id), ['saved']);
  assert.deepEqual(h.old.wakes, []);
});

test('queued wake insertion failure parks the same input instead of losing it', { skip: !hasRuntime }, async () => {
  const h = await harness();
  h.target.send(msg('continue'), 'next-turn', false);
  h.target.followup = () => { throw new Error('insertion failed'); };
  assert.throws(() => h.plugin.wakeQueuedInput(h.target, h.target.inbox.nextTurn[0]), /insertion failed/);
  assert.deepEqual(h.target.inbox.nextTurn.map(item => item.id), ['continue']);
  assert.deepEqual(h.target.wakes, []);
});

test('release restores claimed input even though its original inbox receipt already exists', { skip: !hasRuntime }, async () => {
  const initial = savedRow({ targetCreated: false, summary: undefined, claimed: [msg('saved')] });
  const h = await harness(new Map([['old-session', initial]]));
  h.old.send(msg('saved'), 'next-turn', false);
  h.old.claim();
  const response = await h.command('release');
  assert.equal(response.kind, 'success');
  assert.deepEqual(h.old.inbox.nextStep.map(item => item.id), ['saved']);
  assert.equal(h.rows.size, 0);
  assert.deepEqual(h.old.wakes, []);
});

async function addHistory(agent) {
  const { Session } = await import('@deepseek-ai/dsh-session');
  agent.session = Session.create(agent.id);
  agent.session.append('user/message', msg('history'), { surfaceOp: 'append' });
  agent.events = agent.session.snapshotEvents();
}

const signal = () => new AbortController().signal;

test('adapter inherits an allowed model across two handoffs and does not wake after natural completion', { skip: !hasRuntime }, async () => {
  const { AgentModel, modelSelectionProjectionDefinition } = await import('@deepseek-ai/dsh-agent');
  const compacted = [];
  const scopedCompaction = { compactRegion: async (_start, _end, agent) => { compacted.push(agent.id); return { summary }; } };
  const selection = { provider: 'test-route', model: 'selected-model', reasoningEffort: 'high' };
  const h = await harness(new Map(), { scopedCompaction, config: { threshold: 3, modelFilter: 'test-route/selected-model' } });
  const preStep = (agent, modelSelection = agent.model.current()) => h.listeners.get('agent/pre-step')(
    { agent, messages: [], signal: signal(), modelSelection }, async () => ({ kind: 'enter', messages: [] }),
  );
  const stopTurn = agent => h.listeners.get('agent/turn-stopping')({ agent, signal: signal() });

  await addHistory(h.old);
  h.old.model = new AgentModel(modelSelectionProjectionDefinition.init, h.old.session, selection);
  assert.deepEqual(h.old.model.current(), selection);
  h.old.replies = 2;
  assert.deepEqual(await preStep(h.old), { kind: 'enter', messages: [] });
  assert.equal(h.rows.size, 0);
  h.old.replies = 3;
  // A step keeps its captured route even if the current selection changed mid-boundary.
  assert.deepEqual(await preStep(h.old, { ...selection, provider: 'other-route' }), { kind: 'enter', messages: [] });
  assert.equal(h.rows.size, 0);
  assert.deepEqual(await preStep(h.old), { kind: 'reject' });
  await h.settle();
  const firstHandoff = h.rows.get(h.old.id);
  assert.equal(firstHandoff.phase, 'done');
  assert.deepEqual(firstHandoff.selection, selection);
  const second = h.agents.get(firstHandoff.targetId);
  assert.notEqual(second.id, h.old.id);
  assert.deepEqual(second.selections, [selection]);
  assert.deepEqual(second.wakes, [firstHandoff.continueId]);
  assert.deepEqual(second.inbox.nextTurn.map(item => item.id), [firstHandoff.seedId, firstHandoff.continueId]);

  second.claim();
  await addHistory(second);
  second.replies = 2;
  await stopTurn(second);
  assert.equal(h.rows.has(second.id), false);
  second.replies = 3;
  await stopTurn(second);
  await h.settle();
  const secondHandoff = h.rows.get(second.id);
  assert.equal(secondHandoff.phase, 'done');
  assert.deepEqual(secondHandoff.selection, selection);
  const third = h.agents.get(secondHandoff.targetId);
  assert.equal(new Set([h.old.id, second.id, third.id]).size, 3);
  assert.deepEqual(third.selections, [selection]);
  assert.deepEqual(third.wakes, []);
  assert.deepEqual(third.inbox.nextTurn.map(item => item.id), [secondHandoff.seedId]);
  assert.deepEqual(compacted, [h.old.id, second.id]);
  assert.equal(h.effects.creates, 2);
});

test('compression resolves the Agent-scoped service when no global service exists', { skip: !hasRuntime }, async () => {
  let calls = 0;
  const scopedCompaction = { compactRegion: async () => { calls++; return { summary }; } };
  const h = await harness(new Map(), { scopedCompaction });
  await addHistory(h.old);
  const result = await h.listeners.get('agent/pre-step')({ agent: h.old, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
  await h.settle();
  assert.deepEqual(result, { kind: 'reject' });
  assert.equal(calls, 1);
  assert.equal(h.rows.get(h.old.id).phase, 'done');
});
