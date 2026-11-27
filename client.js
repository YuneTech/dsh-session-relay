window.__ModuleLoader__.load({
  id: 'dsh-session-relay',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const settingKeys = ['enabled', 'threshold', 'modelFilter', 'autoContinue', 'autoSwitch'];
    const settingsDraft = value => ({
      enabled: value.enabled,
      threshold: String(value.threshold),
      modelFilter: value.modelFilter ?? '',
      autoContinue: value.autoContinue,
      autoSwitch: value.autoSwitch,
    });
    const settingsPatch = (draft, baseline) => {
      const threshold = Number(draft.threshold);
      if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > 10000) return null;
      return Object.fromEntries(settingKeys.filter(key => draft[key] !== baseline[key])
        .map(key => [key, key === 'threshold' ? threshold : draft[key]]));
    };
    const words = {
      zh: {
        title: '会话接力', on: '已开启', off: '未开启', replies: '次模型回复', settings: '设置',
        enabled: '启用自动接力', threshold: '模型回复次数阈值',
        modelFilter: '触发接力的模型', modelFilterHint: '填写模型 ID 或 provider/model，用换行或逗号分隔。留空匹配全部模型。',
        autoContinue: '自动继续未完成的任务', autoSwitch: '接力后自动打开新会话', save: '保存', saving: '保存中…',
        saved: '已保存', loadingSettings: '正在读取设置…', loadSettingsError: '无法读取设置', saveSettingsError: '无法保存设置',
        refresh: '刷新状态', retryLoad: '重试读取状态', open: '打开新会话', retry: '重试续接', release: '停用并恢复未转移输入',
        hint: '包含工具调用回复。默认 90，为摘要请求留余量；旧会话保留。',
        warning: '若中转上限为 100，建议设为 80–90。摘要和重试也可能占用额度。',
        scope: '不迁移子代理、后台任务句柄或临时授权。若商家按账号累计限制，换会话无法重置。',
        error: '续接暂停，输入已保留：', subagent: '子代理不自动切换会话', countError: '请输入 2–10000 之间的整数',
        compressing: '正在压缩', prepared: '等待安全切换', transferring: '正在转移上下文', done: '已接力到新会话', failed: '需要处理',
      },
      en: {
        title: 'Session Relay', on: 'On', off: 'Off', replies: 'model replies', settings: 'Settings',
        enabled: 'Enable automatic relay', threshold: 'Model reply threshold',
        modelFilter: 'Models that trigger relay', modelFilterHint: 'Enter model IDs or provider/model, separated by newlines or commas. Leave blank to match all models.',
        autoContinue: 'Resume unfinished tasks', autoSwitch: 'Open the new session after relay', save: 'Save', saving: 'Saving…',
        saved: 'Saved', loadingSettings: 'Loading settings…', loadSettingsError: 'Could not load settings', saveSettingsError: 'Could not save settings',
        refresh: 'Refresh status', retryLoad: 'Retry loading status', open: 'Open new session', retry: 'Retry handoff', release: 'Disable and restore untransferred input',
        hint: 'Tool-call replies count too. Default: 90, leaving room for a summary. Old sessions are retained.',
        warning: 'For a 100-reply cap, use 80–90. Summaries and retries may consume quota too.',
        scope: 'Child agents, background job handles, and temporary permissions do not migrate. Account-wide caps cannot be reset by a new session.',
        error: 'Handoff paused; input retained: ', subagent: 'Child agents are not rotated', countError: 'Enter an integer from 2 to 10000',
        compressing: 'Summarizing', prepared: 'Waiting for a safe handoff', transferring: 'Transferring context', done: 'Continued in a new session', failed: 'Needs attention',
      },
    };
    return {
      inject: ['slots', 'sessions', 'uiWorkspace', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('session-relay', words));
        const t = ctx.locale.bind('session-relay');
        const settingsListeners = new Set();
        const requestSettings = async (signal, patch) => {
          const mount = new URL('.', document.baseURI).pathname.slice(0, -1);
          const response = await fetch(mount + '/api/session-relay/settings', {
            signal, cache: 'no-store',
            ...(patch === undefined ? {} : {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
            }),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || result?.ok !== true || !result.value) {
            throw new Error(typeof result?.error === 'string' ? result.error : 'HTTP ' + response.status);
          }
          return result.value;
        };
        function SettingsStyles() {
          return h('style', null, `
            .sr-panel{color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;border-top:1px solid var(--dsw-alias-border-l1);padding:4px 8px;margin-top:4px}
            .sr-panel .sr-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:36px}.sr-panel .sr-title{font-weight:600}.sr-panel .sr-status{font-variant-numeric:tabular-nums;margin-inline-start:auto}
            .sr-settings{max-width:100%;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
            .sr-settings h2{font-size:18px;line-height:1.35;margin:0 0 12px;font-weight:600}
            :is(.sr-settings,.sr-panel) p{margin:8px 0;line-height:1.6;overflow-wrap:anywhere}
            :is(.sr-settings,.sr-panel) .sr-muted{color:var(--dsw-alias-label-secondary)}
            :is(.sr-settings,.sr-panel) .sr-form{padding:8px 0}
            :is(.sr-settings,.sr-panel) .sr-option{display:flex;align-items:center;gap:8px;min-height:44px}
            :is(.sr-settings,.sr-panel) .sr-option input{width:16px;height:16px;flex:none;accent-color:var(--dsw-alias-brand-primary)}
            :is(.sr-settings,.sr-panel) .sr-number{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:48px}
            :is(.sr-settings,.sr-panel) .sr-number input{width:104px}
            :is(.sr-settings,.sr-panel) .sr-model{display:grid;gap:6px;margin:8px 0 4px}
            :is(.sr-settings,.sr-panel) .sr-model p{margin:0}
            :is(.sr-settings,.sr-panel) :is(button,input[type=number],textarea){font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;min-height:44px;box-sizing:border-box}
            :is(.sr-settings,.sr-panel) textarea{resize:vertical;width:100%;max-width:100%;min-height:72px}
            :is(.sr-settings,.sr-panel) button{cursor:pointer}
            :is(.sr-settings,.sr-panel) button:disabled{cursor:default;opacity:.6}
            :is(.sr-settings,.sr-panel) button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
            :is(.sr-settings,.sr-panel) :is(button,input,textarea):focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
            :is(.sr-settings,.sr-panel) .sr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
            :is(.sr-settings,.sr-panel) .sr-error{color:var(--dsw-alias-state-error-primary)}
            :is(.sr-settings,.sr-panel) .sr-warning{color:var(--dsw-alias-state-warn-primary)}
          `);
        }
        function SettingsForm({ id, draft, setDraft, busy, save, dirty, children }) {
          const checkbox = key => h('label', { className: 'sr-option', key },
            h('input', { type: 'checkbox', checked: draft[key], disabled: busy, onChange: event => setDraft({ ...draft, [key]: event.target.checked }) }), t(key));
          return h('form', { id, className: 'sr-form', onSubmit: save },
            checkbox('enabled'),
            h('label', { className: 'sr-number', htmlFor: id + '-threshold' }, t('threshold'),
              h('input', { id: id + '-threshold', type: 'number', min: 2, max: 10000, step: 1, required: true, value: draft.threshold, disabled: busy, onChange: event => setDraft({ ...draft, threshold: event.target.value }) })),
            h('p', { className: 'sr-muted' }, t('hint')),
            Number(draft.threshold) > 90 && h('p', { className: 'sr-warning' }, t('warning')),
            h('div', { className: 'sr-model' },
              h('label', { htmlFor: id + '-models' }, t('modelFilter')),
              h('textarea', { id: id + '-models', rows: 3, value: draft.modelFilter, disabled: busy, spellCheck: false, autoCapitalize: 'none',
                'aria-describedby': id + '-models-hint', onChange: event => setDraft({ ...draft, modelFilter: event.target.value }) }),
              h('p', { id: id + '-models-hint', className: 'sr-muted' }, t('modelFilterHint'))),
            checkbox('autoContinue'), checkbox('autoSwitch'),
            h('p', { className: 'sr-muted' }, t('scope')),
            h('div', { className: 'sr-actions' }, h('button', { type: 'submit', disabled: busy || !dirty }, t(busy ? 'saving' : 'save')), children));
        }
        function RelaySettings() {
          React.useSyncExternalStore(ctx.locale.subscribe.bind(ctx.locale), ctx.locale.getSnapshot.bind(ctx.locale));
          const id = React.useId();
          const [baseline, setBaseline] = React.useState(null);
          const [draft, setDraft] = React.useState(null);
          const [status, setStatus] = React.useState('loading');
          const [error, setError] = React.useState('');
          const controllerRef = React.useRef(null);
          const pending = React.useRef(false);
          const run = async patch => {
            const controller = controllerRef.current;
            if (!controller || controller.signal.aborted || pending.current) return;
            pending.current = true;
            setStatus(patch ? 'saving' : 'loading'); setError('');
            try {
              const value = await requestSettings(controller.signal, patch);
              if (controller.signal.aborted) return;
              const next = settingsDraft(value);
              setBaseline(next); setDraft(next);
              setStatus(patch ? 'saved' : 'ready');
              if (patch) for (const refresh of settingsListeners) refresh();
            } catch (failure) {
              if (controller.signal.aborted) return;
              setStatus(patch ? 'saveError' : 'loadError');
              setError(String(failure.message ?? failure));
            } finally {
              if (!controller.signal.aborted) pending.current = false;
            }
          };
          React.useEffect(() => {
            const controller = new AbortController();
            controllerRef.current = controller;
            pending.current = false;
            void run();
            return () => controller.abort();
          }, []);
          const save = event => {
            event.preventDefault();
            const patch = settingsPatch(draft, baseline);
            if (patch === null) { setStatus('invalid'); return; }
            if (Object.keys(patch).length) void run(patch);
          };
          const change = value => { setDraft(value); if (status !== 'ready') { setStatus('ready'); setError(''); } };
          const dirty = draft && settingKeys.some(key => draft[key] !== baseline[key]);
          return h('section', { className: 'sr-settings', 'aria-labelledby': id + '-title' },
            h(SettingsStyles), h('h2', { id: id + '-title' }, t('title')),
            status === 'loading' && h('p', { className: 'sr-muted', role: 'status' }, t('loadingSettings')),
            status === 'loadError' && h('button', { type: 'button', onClick: () => run() }, t('retryLoad')),
            draft && h(SettingsForm, { id: id + '-form', draft, setDraft: change, busy: status === 'saving', save, dirty }),
            status === 'saved' && h('p', { className: 'sr-muted', role: 'status' }, t('saved')),
            status === 'invalid' && h('p', { className: 'sr-error', role: 'alert' }, t('countError')),
            error && h('p', { className: 'sr-error', role: 'alert' }, t(status === 'loadError' ? 'loadSettingsError' : 'saveSettingsError'), ': ', error));
        }
        function RelayPanel({ sessionId }) {
          React.useSyncExternalStore(ctx.locale.subscribe.bind(ctx.locale), ctx.locale.getSnapshot.bind(ctx.locale));
          const [data, setData] = React.useState(null);
          const [error, setError] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const [draft, setDraft] = React.useState(null);
          const baseline = React.useRef(null);
          const [expanded, setExpanded] = React.useState(false);
          const fetchRef = React.useRef(null);
          const abortRef = React.useRef(null);
          const loaded = React.useRef(false);
          const opened = React.useRef(null);
          const id = React.useId();
          React.useEffect(() => {
            const controller = new AbortController();
            abortRef.current = controller;
            loaded.current = false; opened.current = null; baseline.current = null;
            setData(null); setDraft(null); setError(''); setBusy(false);
            let scheduled;
            let lastSeq = -1;
            let request = Promise.resolve();
            let statusPending = false;
            let mutationPending = false;
            const load = (line = '/relay status', mutate = false) => {
              if (controller.signal.aborted || !sessionId) return;
              if (mutate ? mutationPending : statusPending) return;
              if (mutate) { mutationPending = true; setBusy(true); }
              else statusPending = true;
              request = request.then(async () => {
                try {
                  if (controller.signal.aborted) return;
                  const response = await ctx.remote.commands.execute(sessionId, line, [], controller.signal);
                  if (controller.signal.aborted) return;
                  if (!response.ok) throw new Error(response.error.message);
                  const result = response.value?.result;
                  if (result?.kind !== 'success') throw new Error(result?.text ?? 'Session Relay command is unavailable');
                  const value = JSON.parse(result.text);
                  setData(value); setError('');
                  const next = settingsDraft(value);
                  const previous = baseline.current;
                  baseline.current = next;
                  setDraft(draft => {
                    if (!draft || !previous || mutate) return next;
                    return Object.fromEntries(settingKeys.map(key => [key, draft[key] === previous[key] ? next[key] : draft[key]]));
                  });
                  if (!loaded.current && value.handoff?.phase === 'done') opened.current = value.handoff.targetId;
                  if (loaded.current && value.handoff?.phase === 'done' && value.autoSwitch && opened.current !== value.handoff.targetId) {
                    opened.current = value.handoff.targetId;
                    await ctx.sessions.refresh();
                    if (!controller.signal.aborted) ctx.uiWorkspace.openSession(value.handoff.targetId);
                  }
                  loaded.current = true;
                } catch (failure) {
                  if (!controller.signal.aborted) setError(String(failure.message ?? failure));
                } finally {
                  if (mutate) {
                    mutationPending = false;
                    if (!controller.signal.aborted) setBusy(false);
                  } else {
                    statusPending = false;
                  }
                }
              });
              return request;
            };
            fetchRef.current = load;
            const source = ctx.sessions.binding(sessionId)?.eventSource;
            const relevantSeq = entries => {
              for (let index = entries.length - 1; index >= 0; index--) {
                const entry = entries[index];
                if (entry.type === 'event' && /^(assistant\/message$|turn\/end$|compaction\/)/.test(entry.event.type)) return entry.event.seq;
              }
              return -1;
            };
            const watch = () => {
              const change = source.getSnapshot().change;
              const entries = change.kind === 'settle-assistant' ? (change.entry ? [change.entry] : []) : change.entries;
              if (change.kind === 'prepend') return;
              const seq = relevantSeq(entries);
              if (seq === -1 || seq === lastSeq) return;
              lastSeq = seq;
              clearTimeout(scheduled);
              scheduled = setTimeout(() => { void load(); }, 200);
            };
            if (source) lastSeq = relevantSeq(source.getSnapshot().entries);
            const unsubscribe = source?.subscribe(watch);
            settingsListeners.add(load);
            void load();
            return () => { controller.abort(); clearTimeout(scheduled); unsubscribe?.(); settingsListeners.delete(load); fetchRef.current = null; };
          }, [sessionId]);
          const phase = data?.handoff?.phase;
          React.useEffect(() => {
            if (!['compressing', 'prepared', 'transferring'].includes(phase)) return;
            const timer = setInterval(() => { void fetchRef.current?.(); }, 1200);
            return () => clearInterval(timer);
          }, [phase]);
          const call = request => fetchRef.current?.(`/relay ${JSON.stringify(request)}`, true);
          const save = event => {
            event.preventDefault();
            const patch = settingsPatch(draft, baseline.current);
            if (patch === null) { setError(t('countError')); return; }
            if (Object.keys(patch).length) void call({ action: 'configure', settings: patch });
          };
          const openTarget = async () => {
            const controller = abortRef.current;
            const targetId = data.handoff.targetId;
            if (!controller || controller.signal.aborted) return;
            try {
              await ctx.sessions.refresh();
              if (!controller.signal.aborted) ctx.uiWorkspace.openSession(targetId);
            } catch (failure) {
              if (!controller.signal.aborted) setError(String(failure.message ?? failure));
            }
          };
          const dirty = draft && baseline.current && settingKeys.some(key => draft[key] !== baseline.current[key]);
          return h('section', { className: 'sr-panel', 'aria-label': t('title') },
            h(SettingsStyles),

            h('div', { className: 'sr-top' },
              h('span', { className: 'sr-title' }, t('title')),
              h('span', { className: 'sr-muted' }, data ? t(data.enabled ? 'on' : 'off') : '…'),
              data && h('span', { className: 'sr-status' }, `${data.replies} / ${data.threshold} ${t('replies')}`),
              h('button', { type: 'button', 'aria-expanded': expanded, 'aria-controls': `${id}-form`, onClick: () => setExpanded(!expanded) }, t('settings'))),
            phase && h('p', { role: 'status' }, t(phase === 'error' ? 'failed' : phase)),
            error && h('p', { className: 'sr-error', role: 'alert' }, error),
            error && !draft && h('button', { type: 'button', disabled: busy, onClick: () => fetchRef.current?.('/relay status', true) }, t(busy ? 'saving' : 'retryLoad')),
            data?.handoff?.error && h('p', { className: 'sr-error', role: 'alert' }, t('error'), data.handoff.error),
            data?.handoff && h('div', { className: 'sr-actions' },
              data.handoff.targetCreated && h('button', { type: 'button', onClick: openTarget }, t('open')),
              phase === 'error' && data.handoff.recoverable && h('button', { type: 'button', disabled: busy, onClick: () => call({ action: 'retry' }) }, t('retry')),
              phase === 'error' && !data.handoff.targetCreated && h('button', { type: 'button', disabled: busy, onClick: () => call({ action: 'release' }) }, t('release'))),
            expanded && draft && h(SettingsForm, { id: id + '-form', draft, setDraft, busy, save, dirty },
              h('button', { type: 'button', disabled: busy, onClick: () => fetchRef.current?.() }, t('refresh'))),
            expanded && data?.eligible === false && h('p', { className: 'sr-warning' }, t('subagent')));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'session-relay', order: 100, label: () => t('title') }, RelaySettings));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'session-relay', order: 20 }, RelayPanel));
      },
    };
  },
});
