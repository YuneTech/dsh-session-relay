import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function client(fetch, modelCatalog = async () => ({ ok: true, value: { groups } })) {
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
    URL, AbortController, document: { baseURI: 'https://example.test/dsh/' }, fetch,
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => react); } } },
  });
  plugin.apply({
    effect: callback => callback(),
    locale: { register() {}, bind: () => key => key, subscribe() {}, getSnapshot() {} },
    remote: { session: { modelCatalog } },
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
      const tree = expand(Component());
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
