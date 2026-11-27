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
  let command;
  function makeAgent(id) {
    const queues = { 'next-turn': [], 'next-step': [] };
    const events = [];
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
      id, events, inbox, sent: [], wakes: [], status: 'idle',
      session: { header: { id }, surface: { nodes: [] } },
      ctx: { get: key => key === 'compaction' ? options.scopedCompaction : undefined },
      model: { current: () => ({ provider: 'test', model: 'test' }), select() {} },
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
    sessionProjections: { register: async () => ({ stateOf: () => ({ replies: 90 }), dispose() {} }) },
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
    configEditor: { edit: async () => {} },
    fiber: { entry: 'test-entry' },
    commands: { register: spec => { command = spec.handler; } },
    tools: { register() {} },
    on: (name, callback) => listeners.set(name, callback),
    effect: setup => { setup(); },
    get: key => key === 'compaction' ? options.globalCompaction : undefined,
  };
  await plugin.apply(ctx, plugin.Config({ enabled: true }));
  return {
    plugin, old, target, rows, agents, listeners, effects,
    command: rawInput => command({ agent: old, rawInput, signal: new AbortController().signal }),
    settle: async () => { await new Promise(setImmediate); await Promise.all(maintenance); },
  };
}

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

test('compression resolves the Agent-scoped service when no global service exists', { skip: !hasRuntime }, async () => {
  let calls = 0;
  const scopedCompaction = { compactRegion: async () => { calls++; return { summary }; } };
  const h = await harness(new Map(), { scopedCompaction });
  const { Session } = await import('@deepseek-ai/dsh-session');
  h.old.session = Session.create(h.old.id);
  h.old.session.append('user/message', msg('history'), { surfaceOp: 'append' });
  h.old.events = h.old.session.snapshotEvents();
  const result = await h.listeners.get('agent/pre-step')({ agent: h.old, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
  await h.settle();
  assert.deepEqual(result, { kind: 'reject' });
  assert.equal(calls, 1);
  assert.equal(h.rows.get(h.old.id).phase, 'done');
});
