import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function client(fetch) {
  let plugin;
  let cursor;
  let state = [];
  let cleanup = [];
  let effects = [];
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
    useEffect(callback) {
      const i = cursor++;
      if (!(i in state)) { state[i] = true; effects.push(callback); }
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
      cleanup.push(...effects.splice(0).map(effect => effect()));
      return tree;
    },
    unmount() { cleanup.splice(0).forEach(dispose => dispose()); state = []; },
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
const submit = { preventDefault() {} };

test('settings load and save without session, and use the host mount prefix', async () => {
  let value = initial;
  const requests = [];
  const ui = client(async (path, options) => {
    const patch = options.body ? JSON.parse(options.body) : undefined;
    requests.push([path, options.method ?? 'GET', patch]);
    if (patch) value = { ...value, ...patch };
    return Response.json({ ok: true, value });
  });
  ui.render();
  await setImmediate();
  const filter = 'model-a, provider/model-b\nmodel-c';
  first(ui.render(), 'textarea').props.onChange({ target: { value: filter } });
  first(ui.render(), 'form').props.onSubmit(submit);
  await setImmediate();
  const saved = ui.render();
  assert.equal(first(saved, 'p', props => props.role === 'status').props.children[0], 'saved');
  assert.equal(first(saved, 'button', props => props.type === 'submit').props.disabled, true);
  ui.unmount();
  ui.render();
  await setImmediate();
  assert.equal(first(ui.render(), 'textarea').props.value, filter);
  assert.deepEqual(requests, [
    ['/dsh/api/session-relay/settings', 'GET', undefined],
    ['/dsh/api/session-relay/settings', 'POST', { modelFilter: filter }],
    ['/dsh/api/session-relay/settings', 'GET', undefined],
  ]);
  ui.unmount();
});

test('settings surface a save failure without clearing the draft', async () => {
  const ui = client(async (_path, { method }) => method === 'POST'
    ? Response.json({ ok: false, error: 'write failed' }, { status: 400 })
    : Response.json({ ok: true, value: initial }));
  ui.render();
  await setImmediate();
  first(ui.render(), 'textarea').props.onChange({ target: { value: 'provider/model' } });
  first(ui.render(), 'form').props.onSubmit(submit);
  await setImmediate();
  const failed = ui.render();
  assert.equal(first(failed, 'textarea').props.value, 'provider/model');
  assert.equal(first(failed, 'p', props => props.role === 'alert').props.children.join(''), 'saveSettingsError: write failed');
  assert.equal(first(failed, 'button', props => props.type === 'submit').props.disabled, false);
  ui.unmount();
});
