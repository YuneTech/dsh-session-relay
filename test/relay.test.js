import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRelay, validateSettings, mergeMessages, receivedMessageIds } from '../relay.js';

const msg = id => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'user' } });
function fixture(overrides = {}) {
  const rows = new Map();
  const target = { id: 'new-session', messages: [], wakes: [] };
  const old = { id: 'old-session', status: 'idle', pending: [], count: 90 };
  let settings = { enabled: true, threshold: 90, autoContinue: true };
  const effects = { compactions: 0, creates: 0, failures: [] };
  let serial = 0;
  const a = {
    get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, row) => { rows.set(id, structuredClone(row)); }, delete: async id => { rows.delete(id); },
    id: () => `id-${++serial}`, now: () => '2026-11-27T00:00:00Z', settings: () => settings,
    configure: async patch => { settings = { ...settings, ...patch }; },
    count: agent => agent.count, eligible: agent => !agent.child, selection: () => ({ provider: 'relay', model: 'model' }), location: () => ({ cwd: '/project' }),
    compact: async () => { effects.compactions++; return [{ type: 'text', text: 'checkpoint' }]; },
    whenIdle: async () => {}, maintain: async (_agent, task) => task(new AbortController().signal),
    target: async row => { if (!row.targetCreated) effects.creates++; return target; },
    pending: agent => agent.pending,
    seed: async (agent, row) => { if (!agent.messages.some(item => item.id === row.seedId)) agent.messages.push(msg(row.seedId)); },
    transfer: async (agent, messages) => { for (const item of messages) if (!agent.messages.some(saved => saved.id === item.id)) agent.messages.push(item); },
    flush: async () => {}, removePending: (agent, ids) => { agent.pending = agent.pending.filter(item => !ids.includes(item.id)); },
    restore: async (agent, messages) => { agent.pending = mergeMessages(agent.pending, messages); },
    wake: async (agent, row) => { agent.wakes.push(row?.continueId ?? 'pending'); },
    report: (id, error) => effects.failures.push({ id, error }),
    ...overrides,
  };
  const relay = new SessionRelay(a);
  const settle = async () => { while (relay.tasks.size) await Promise.all([...relay.tasks.values()]); };
  return { a, old, target, rows, effects, relay, settle };
}

test('settings reject fractional, NaN, negative, invalid and unknown values', () => {
  for (const threshold of [0, 1, -1, 1.5, NaN, Infinity, 10001, '90']) assert.throws(() => validateSettings({ threshold }));
  for (const threshold of [2, 90, 100, 10000]) assert.equal(validateSettings({ threshold }).threshold, threshold);
  for (const modelFilter of [null, [], true, 42]) assert.throws(() => validateSettings({ modelFilter }));
  for (const modelFilter of ['', 'test/model, other\nthird']) assert.deepEqual(validateSettings({ modelFilter }), { modelFilter });
  assert.throws(() => validateSettings({ enabled: 1 }));
  assert.throws(() => validateSettings({ unknown: true }));
});

test('no action below threshold, when disabled, or for a child agent', async () => {
  const f = fixture();
  f.old.count = 89;
  assert.equal(await f.relay.boundary(f.old, [], true), false);
  f.old.count = 90; f.old.child = true;
  assert.equal(await f.relay.boundary(f.old, [], true), false);
  f.old.child = false; await f.a.configure({ enabled: false });
  assert.equal(await f.relay.boundary(f.old, [], true), false);
  assert.equal(f.effects.compactions, 0);
});

test('model allowlist matches exact model or provider/model entries separated by commas or lines', async t => {
  const cases = [
    ['empty allows every model', '', { provider: 'other', model: 'unlisted' }, true],
    ['model ID matches regardless of provider', 'other, model\r\nthird', { provider: 'another', model: 'model' }, true],
    ['qualified entry trims surrounding whitespace', 'other,\n  relay/model  ', { provider: 'relay', model: 'model' }, true],
    ['qualified entry matches only its provider', 'relay/model', { provider: 'other', model: 'model' }, false],
    ['similar model IDs do not match', 'relay/model, model', { provider: 'relay', model: 'model-preview' }, false],
    ['case is not folded', 'relay/Model', { provider: 'relay', model: 'model' }, false],
    ['patterns are not interpreted', 'relay/*, model-*', { provider: 'relay', model: 'model-preview' }, false],
    ['unknown model does not match a configured entry', 'relay/model', null, false],
  ];
  for (const [name, modelFilter, selection, allowed] of cases) await t.test(name, async () => {
    const f = fixture({ selection: () => selection });
    await f.a.configure({ modelFilter });
    assert.equal(await f.relay.boundary(f.old, [], false), allowed);
    await f.settle();
    assert.equal(f.effects.compactions, Number(allowed));
    assert.equal(f.effects.creates, Number(allowed));
    assert.equal(f.rows.size, Number(allowed));
  });
});

test('configured threshold summarizes once, transfers claimed+both pending queues once and wakes new work', async () => {
  const f = fixture();
  await f.a.configure({ threshold: 91 });
  assert.equal(await f.relay.boundary(f.old, [], true), false);
  assert.equal(f.effects.compactions, 0);
  f.old.count = 91;
  f.old.pending = [msg('pending'), msg('claimed')];
  assert.equal(await f.relay.boundary(f.old, [msg('claimed')], true, new AbortController().signal), true);
  await f.settle();
  assert.equal(f.effects.compactions, 1);
  assert.equal(f.effects.creates, 1);
  assert.equal(f.rows.get(f.old.id).phase, 'done');
  assert.deepEqual(f.target.messages.slice(1).map(item => item.id), ['claimed', 'pending']);
  assert.deepEqual(f.old.pending, []);
  assert.deepEqual(f.target.wakes, ['pending']);
});

test('an interrupted tool loop resumes, but a naturally completed turn creates an idle target', async () => {
  for (const resume of [true, false]) {
    const f = fixture();
    await f.relay.boundary(f.old, [], resume, new AbortController().signal);
    await f.settle();
    assert.equal(f.target.wakes.length, resume ? 1 : 0);
  }
});

test('disabling automatic continuation still forwards real pending user input', async () => {
  const f = fixture(); await f.a.configure({ autoContinue: false });
  await f.relay.boundary(f.old, [msg('actual-input')], true, new AbortController().signal);
  await f.settle();
  assert.deepEqual(f.target.wakes, ['pending']);
});

test('failed compression parks claimed input and never launches a target or falls through', async () => {
  const f = fixture({ compact: async () => { throw new Error('quota reached'); } });
  assert.equal(await f.relay.boundary(f.old, [msg('one')], true), true);
  assert.equal(f.rows.get(f.old.id).phase, 'error');
  assert.equal(await f.relay.boundary(f.old, [msg('two')], true), true);
  assert.deepEqual(f.rows.get(f.old.id).claimed.map(item => item.id), ['one', 'two']);
  assert.equal(f.effects.creates, 0);
  await assert.rejects(f.relay.retry(f.old), /Summary failed/);
  const result = await f.relay.release(f.old);
  assert.equal(result.restored, 2);
  assert.deepEqual(f.old.pending.map(item => item.id), ['one', 'two']);
  assert.equal(f.a.settings().enabled, false);
  assert.equal(f.rows.size, 0);
});

test('new input is forwarded through an old completed session even after its model is filtered out', async () => {
  const f = fixture();
  await f.relay.boundary(f.old, [], false); await f.settle();
  await f.a.configure({ modelFilter: 'other/model' });
  assert.equal(await f.relay.boundary(f.old, [msg('later')], true), true);
  await f.settle();
  assert.equal(f.effects.compactions, 1);
  assert.equal(f.effects.creates, 1);
  assert.deepEqual(f.target.messages.slice(1).map(item => item.id), ['later']);
  assert.deepEqual(f.target.wakes, ['pending']);
});

test('transfer failure preserves old inbox; retry reuses target and stable message ids', async () => {
  let first = true;
  const f = fixture({ flush: async () => { if (first) { first = false; throw new Error('disk temporarily unavailable'); } } });
  f.old.pending = [msg('pending')];
  await f.relay.boundary(f.old, [msg('claimed')], true); await f.settle();
  assert.equal(f.rows.get(f.old.id).phase, 'error');
  assert.equal(f.old.pending.length, 1);
  await assert.rejects(f.relay.release(f.old), /already transferred/);
  await f.relay.retry(f.old); await f.settle();
  assert.equal(f.effects.creates, 1);
  assert.equal(f.effects.compactions, 1);
  assert.deepEqual(f.target.messages.slice(1).map(item => item.id), ['claimed', 'pending']);
  assert.equal(f.rows.get(f.old.id).phase, 'done');
});

test('boundary does not await idle and captures arrivals during summarization', async () => {
  let resolveIdle;
  let resolveSummary;
  const f = fixture({
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve; }),
    compact: () => new Promise(resolve => { resolveSummary = resolve; }),
  });
  const boundary = f.relay.boundary(f.old, [msg('first')], true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await f.relay.boundary(f.old, [msg('racing')], true), true);
  resolveSummary([{ type: 'text', text: 'summary' }]);
  await boundary;
  resolveIdle(); await f.settle();
  assert.deepEqual(f.target.messages.slice(1).map(item => item.id), ['first', 'racing']);
});

test('message merge preserves ordering and rejects unidentifiable input', () => {
  assert.deepEqual(mergeMessages([msg('a')], [msg('a'), msg('b')]).map(item => item.id), ['a', 'b']);
  assert.throws(() => mergeMessages([{}]), /unidentified/);
});

test('durable inbox insertion receipts survive claim, cancellation and missing user admission', () => {
  const events = [
    { type: 'agent/inbox/spliced', data: { inserted: [msg('claimed'), msg('canceled')] } },
    { type: 'agent/inbox/spliced', data: { inserted: [], removedCount: 1 } },
    { type: 'agent/inbox/spliced', data: { inserted: [], removedCount: 1, outcome: 'canceled' } },
    { type: 'user/message', data: msg('committed') },
  ];
  assert.deepEqual([...receivedMessageIds(events)], ['claimed', 'canceled', 'committed']);
});

test('startup recovery parks interrupted phases and unforwarded done inputs without launching', async () => {
  const f = fixture();
  for (const phase of ['compressing', 'prepared', 'transferring']) {
    f.rows.set(phase, { phase, targetId: 'target', claimed: [msg(phase)], summary: [{ type: 'text', text: 'saved' }] });
  }
  const completed = { phase: 'done', targetId: 'completed', claimed: [], pending: [] };
  const failed = { phase: 'error', targetId: 'failed', claimed: [msg('error')], error: 'original failure' };
  f.rows.set('completed', completed);
  f.rows.set('failed', failed);
  f.rows.set('late-input', { ...completed, claimed: [msg('later')] });
  await f.relay.recover();
  for (const key of ['compressing', 'prepared', 'transferring', 'late-input']) {
    assert.equal(f.rows.get(key).phase, 'error');
    assert.match(f.rows.get(key).error, /restart or reload/);
    assert.equal(f.rows.get(key).claimed.length, 1);
  }
  assert.equal(f.rows.get('prepared').summary[0].text, 'saved');
  assert.equal(f.rows.get('completed'), completed);
  assert.equal(f.rows.get('failed'), failed);
  assert.equal(f.effects.creates, 0);
  assert.equal(f.relay.tasks.size, 0);
});

test('wake mutations are flushed before marking the handoff done', async () => {
  const f = fixture();
  const sequence = [];
  const save = f.a.put;
  f.a.put = async (id, row) => { sequence.push(`put:${row.phase}`); await save(id, row); };
  f.a.wake = async () => { sequence.push('wake'); };
  f.a.flush = async agent => { sequence.push(`flush:${agent.id}`); };
  await f.relay.boundary(f.old, [], true); await f.settle();
  const wakeIndex = sequence.indexOf('wake');
  const lastFlush = sequence.lastIndexOf(`flush:${f.target.id}`);
  const doneIndex = sequence.lastIndexOf('put:done');
  assert.ok(wakeIndex >= 0 && wakeIndex < lastFlush && lastFlush < doneIndex, sequence.join(', '));
});

test('post-wake durability failure remains retryable with the same continuation identity', async () => {
  const f = fixture();
  let fail = true;
  f.a.wake = async (agent, row) => {
    if (!agent.wakes.includes(row.continueId)) agent.wakes.push(row.continueId);
  };
  f.a.flush = async agent => {
    if (agent === f.target && f.target.wakes.length && fail) {
      fail = false;
      throw new Error('continuation flush failed');
    }
  };
  await f.relay.boundary(f.old, [], true); await f.settle();
  const saved = f.rows.get(f.old.id);
  assert.equal(saved.phase, 'error');
  assert.match(saved.error, /continuation flush failed/);
  assert.ok(saved.summary.length);
  await f.relay.retry(f.old); await f.settle();
  assert.equal(f.rows.get(f.old.id).phase, 'done');
  assert.deepEqual(f.target.wakes, [saved.continueId]);
  assert.equal(f.effects.creates, 1);
});
