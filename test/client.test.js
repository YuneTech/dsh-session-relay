import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function client(fetch, modelCatalog = async () => ({ ok: true, value: { groups } }), { panel = false, execute, refresh = async () => {}, openSession = () => {}, updatesFetch = async () => Response.json({ ok: true, value: updateInitial }) } = {}) {
  let plugin;
  let cursor;
  let state = [];
  const cleanup = new Map();
  const effects = [];
  const slots = new Map();
  const react = {
    useSyncExternalStore() {},
    useId: () => 'relay-test',
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next; }];
    },
    useRef(initial) {
      const i = cursor++;
      return state[i] ??= { current: initial };
    },
    useEffect(callback, deps) {
      const i = cursor++;
      const previous = state[i];
      if (deps && previous && previous.length === deps.length && deps.every((value, index) => Object.is(value, previous[index]))) return;
      state[i] = deps;
      effects.push(() => {
        cleanup.get(i)?.();
        const dispose = callback();
        if (typeof dispose === 'function') cleanup.set(i, dispose);
        else cleanup.delete(i);
      });
    },
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } }),
  };
  runInNewContext(source, {
    URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, document: { baseURI: 'https://example.test/dsh/' }, fetch: (path, options) => path.endsWith('/updates') ? updatesFetch(path, options) : fetch(path, options),
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => react); } } },
  });
  plugin.apply({
    effect: callback => callback(),
    locale: { register() {}, bind: () => key => key, subscribe() {}, getSnapshot() {} },
    remote: { session: { modelCatalog }, commands: { execute } },
    sessions: { binding: () => undefined, refresh },
    uiWorkspace: { openSession },
    slots: {
      inject: (_name, register) => register(),
      register: ({ name, label }, Component) => slots.set(name, { Component, label }),
    },
  });
  assert.ok(slots.has('conversation.composer.dock'));
  const { Component, label } = slots.get('settings.section');
  assert.equal(label(), 'title');
  const expand = node => {
    if (typeof node?.type === 'function') return expand(node.type(node.props));
    if (node?.props) return { ...node, props: { ...node.props, children: node.props.children.map(expand) } };
    return node;
  };
  return {
    render() {
      cursor = 0;
      const Render = panel ? slots.get('conversation.composer.dock').Component : Component;
      const tree = expand(Render({ sessionId: 'old-session' }));
      effects.splice(0).forEach(effect => effect());
      return tree;
    },
    unmount() { cleanup.forEach(dispose => dispose()); cleanup.clear(); state = []; },
  };
}

function first(node, type, predicate = () => true) {
  if (node?.type === type && predicate(node.props)) return node;
  for (const child of node?.props?.children ?? []) {
    const result = first(child, type, predicate);
    if (result) return result;
  }
}

const updateInitial = { currentVersion: '1.0.2', latestVersion: null, autoUpdate: false, supported: true, status: 'idle', updateAvailable: false, restartRequired: false, checkedAt: null, error: '' };
const initial = { enabled: false, threshold: 90, modelFilter: '', autoContinue: true, autoSwitch: true };
const groups = [
  { id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }, { id: 'other', name: 'Other' }] },
  { id: 'second', name: 'Second Provider', models: [{ id: 'model', name: 'Model' }] },
];
const submit = { preventDefault() {} };
const modelCheckbox = (tree, key) => first(tree, 'input', props => props.type === 'checkbox' && props.value === key).props;
const action = (tree, key) => first(tree, 'button', props => props.children[0] === key).props;

async function loadSettings(ui) {
  ui.render();
  await setImmediate();
  const loading = ui.render();
  assert.equal(first(loading, 'p', props => props.role === 'status').props.children[0], 'loadingModels');
  await setImmediate();
  return ui.render();
}

test('update settings show progress, prevent duplicate checks, and report restart requirements', async () => {
  const requests = [];
  let finishCheck;
  const ui = client(async () => Response.json({ ok: true, value: initial }), undefined, {
    updatesFetch: async (_path, options) => {
      if (!options.body) return Response.json({ ok: true, value: updateInitial });
      const body = JSON.parse(options.body); requests.push(body);
      if (body.action === 'check') return new Promise(resolve => { finishCheck = () => resolve(Response.json({ ok: true, value: { ...updateInitial, status: 'available', latestVersion: '1.0.3', updateAvailable: true } })); });
      return Response.json({ ok: true, value: { ...updateInitial, status: 'updated', latestVersion: '1.0.3', installedVersion: '1.0.3', restartRequired: true } });
    },
  });
  const loaded = await loadSettings(ui);
  action(loaded, 'checkUpdates').onClick();
  action(loaded, 'checkUpdates').onClick();
  const checking = ui.render();
  assert.equal(action(checking, 'checkUpdates').disabled, true);
  assert.equal(first(checking, 'p', props => props.role === 'status').props.children[0], 'updateChecking');
  finishCheck(); await setImmediate();
  await action(ui.render(), 'installUpdate').onClick();
  const installed = ui.render();
  assert.equal(first(installed, 'p', props => props.role === 'status').props.children[0], 'updateRestart');
  assert.deepEqual(requests, [{ action: 'check' }, { action: 'update' }]);
  ui.unmount();
});

test('self-update reconnects with the replacement instance without repeating installation', async () => {
  const requests = [];
  let replaced = false;
  const ui = client(async () => Response.json({ ok: true, value: initial }), undefined, { updatesFetch: async (_path, options) => {
    if (options.body) {
      requests.push(JSON.parse(options.body)); replaced = true;
      throw new Error('connection closed by HMR');
    }
    return Response.json({ ok: true, value: replaced ? { ...updateInitial, currentVersion: '1.0.3' } : { ...updateInitial, updateAvailable: true } });
  } });
  const loaded = await loadSettings(ui);
  await action(loaded, 'installUpdate').onClick();
  const installed = ui.render();
  assert.equal(first(installed, 'p', props => props.role === 'alert'), undefined);
  assert.ok(first(installed, 'p', props => props.children.includes('1.0.3')));
  assert.deepEqual(requests, [{ action: 'update' }]);
  ui.unmount();
});

test('automatic update preference saves independently and reports a failed save', async () => {
  let fail = true;
  const updates = [];
  const ui = client(async () => Response.json({ ok: true, value: initial }), undefined, {
    updatesFetch: async (_path, options) => {
      if (!options.body) return Response.json({ ok: true, value: updateInitial });
      updates.push(JSON.parse(options.body));
      return fail ? Response.json({ ok: false, error: 'write failed' }, { status: 400 })
        : Response.json({ ok: true, value: { ...updateInitial, autoUpdate: true } });
    },
  });
  const toggle = tree => first(first(tree, 'label', props => props.children.includes('autoUpdate')), 'input').props;
  const loaded = await loadSettings(ui);
  await toggle(loaded).onChange({ target: { checked: true } });
  const failed = ui.render();
  assert.equal(toggle(failed).checked, false);
  assert.match(first(failed, 'p', props => props.role === 'alert').props.children.join(''), /write failed/);
  fail = false;
  await toggle(failed).onChange({ target: { checked: true } });
  assert.equal(toggle(ui.render()).checked, true);
  assert.deepEqual(updates, [{ action: 'autoUpdate', enabled: true }, { action: 'autoUpdate', enabled: true }]);
  ui.unmount();
});

test('conversation dock displays status and recovery without a settings entry or form', async () => {
  const commands = [];
  const opened = [];
  let handoff;
  const ui = client(() => { throw new Error('settings must not be requested from the dock'); }, undefined, {
    panel: true, openSession: id => opened.push(id),
    execute: async (_id, line) => {
      commands.push(line);
      return { ok: true, value: { result: { kind: 'success', text: JSON.stringify({ ...initial, replies: 42, handoff }) } } };
    },
  });
  ui.render();
  await setImmediate();
  const loaded = ui.render();
  assert.equal(first(loaded, 'form'), undefined);
  assert.equal(first(loaded, 'input'), undefined);
  assert.equal(first(loaded, 'button'), undefined);
  assert.equal(first(loaded, 'span', props => props.className === 'sr-status').props.children[0], '42 / 90 replies');
  ui.unmount();

  handoff = { phase: 'error', error: 'network failed', recoverable: true, targetCreated: true, targetId: 'new-session' };
  ui.render();
  await setImmediate();
  const failed = ui.render();
  assert.equal(first(failed, 'form'), undefined);
  assert.equal(first(failed, 'button', props => props['aria-expanded'] !== undefined), undefined);
  action(failed, 'retry').onClick();
  await setImmediate();
  assert.equal(commands.at(-1), '/relay {"action":"retry"}');
  await action(ui.render(), 'open').onClick();
  assert.deepEqual(opened, ['new-session']);
  ui.unmount();
});

test('settings save and reload catalog selections without a session, then restore all models', async () => {
  let value = initial;
  const requests = [];
  const ui = client(async (path, options) => {
    const patch = options.body ? JSON.parse(options.body) : undefined;
    requests.push([path, options.method ?? 'GET', patch]);
    if (patch) value = { ...value, ...patch };
    return Response.json({ ok: true, value });
  });
  const loaded = await loadSettings(ui);
  assert.equal(first(loaded, 'textarea'), undefined);
  for (const key of ['provider/model', 'provider/other', 'second/model']) {
    assert.equal(modelCheckbox(loaded, key).checked, true);
  }
  modelCheckbox(loaded, 'provider/model').onChange({ target: { checked: false } });
  const changed = ui.render();
  assert.equal(modelCheckbox(changed, 'provider/model').checked, false);
  assert.equal(modelCheckbox(changed, 'second/model').checked, true);
  first(changed, 'form').props.onSubmit(submit);
  await setImmediate();
  const saved = ui.render();
  assert.equal(first(saved, 'p', props => props.role === 'status').props.children[0], 'saved');
  assert.equal(first(saved, 'button', props => props.type === 'submit').props.disabled, true);
  ui.unmount();

  const reloaded = await loadSettings(ui);
  assert.equal(modelCheckbox(reloaded, 'provider/model').checked, false);
  assert.equal(modelCheckbox(reloaded, 'provider/other').checked, true);
  assert.equal(modelCheckbox(reloaded, 'second/model').checked, true);
  action(reloaded, 'selectAllModels').onClick();
  const reset = ui.render();
  for (const key of ['provider/model', 'provider/other', 'second/model']) {
    assert.equal(modelCheckbox(reset, key).checked, true);
  }
  first(reset, 'form').props.onSubmit(submit);
  await setImmediate();
  assert.deepEqual(requests, [
    ['/dsh/api/session-relay/settings', 'GET', undefined],
    ['/dsh/api/session-relay/settings', 'POST', { modelFilter: 'provider/other\nsecond/model' }],
    ['/dsh/api/session-relay/settings', 'GET', undefined],
    ['/dsh/api/session-relay/settings', 'POST', { modelFilter: '' }],
  ]);
  ui.unmount();
});

test('settings surface a save failure without clearing the draft', async () => {
  const ui = client(async (_path, { method }) => method === 'POST'
    ? Response.json({ ok: false, error: 'write failed' }, { status: 400 })
    : Response.json({ ok: true, value: initial }));
  const loaded = await loadSettings(ui);
  modelCheckbox(loaded, 'provider/model').onChange({ target: { checked: false } });
  first(ui.render(), 'form').props.onSubmit(submit);
  await setImmediate();
  const failed = ui.render();
  assert.equal(modelCheckbox(failed, 'provider/model').checked, false);
  assert.equal(modelCheckbox(failed, 'second/model').checked, true);
  assert.equal(first(failed, 'p', props => props.role === 'alert').props.children.join(''), 'saveSettingsError: write failed');
  assert.equal(first(failed, 'button', props => props.type === 'submit').props.disabled, false);
  ui.unmount();
});

test('settings report a model catalog error and retry with the host', async () => {
  let catalogRequests = 0;
  const ui = client(async () => Response.json({ ok: true, value: { ...initial, modelFilter: 'provider/model' } }),
    async () => ++catalogRequests === 1
      ? { ok: false, error: { message: 'catalog unavailable' } }
      : { ok: true, value: { groups } });

  const failed = await loadSettings(ui);
  assert.equal(first(failed, 'p', props => props.role === 'alert').props.children.join(''), 'loadModelsError: catalog unavailable');
  assert.equal(first(failed, 'textarea'), undefined);
  assert.equal(first(failed, 'input', props => props.type === 'checkbox' && props.value === 'provider/model'), undefined);

  action(failed, 'retryModels').onClick();
  const loading = ui.render();
  assert.equal(first(loading, 'p', props => props.role === 'status').props.children[0], 'loadingModels');
  await setImmediate();
  const recovered = ui.render();
  assert.equal(catalogRequests, 2);
  assert.equal(first(recovered, 'p', props => props.role === 'alert'), undefined);
  assert.equal(modelCheckbox(recovered, 'provider/model').checked, true);
  assert.equal(modelCheckbox(recovered, 'second/model').checked, false);
  assert.equal(first(recovered, 'button', props => props.type === 'submit').props.disabled, true);
  ui.unmount();
});
