window.__ModuleLoader__.load({
  id: 'dsh-session-relay',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const settingKeys = ['enabled', 'threshold', 'modelFilter', 'autoContinue', 'autoSwitch'];
    const modelTokens = value => String(value ?? '').split(/[,，\r\n]+/).map(item => item.trim()).filter(Boolean);
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
        title: '会话接力', on: '已开启', off: '未开启', replies: '次模型回复',
        updates: '插件更新', currentVersion: '当前版本', latestVersion: '最新版本', checkUpdates: '检测更新', installUpdate: '立即更新',
        autoUpdate: '自动更新插件', autoUpdateHint: '每 6 小时检测并安装新版本；需要重启时会提示。',
        updateLoading: '正在读取更新状态…', updateChecking: '正在检测更新…', updateInstalling: '正在安装更新…',
        updateAvailable: '有新版本可用', updateCurrent: '已是最新版本', updateInstalled: '更新已安装', updateRestart: '更新已安装，重启 DSH 后生效。',
        updateResultUnknown: '更新连接已断开，请重新读取状态核对当前版本。', updateError: '更新状态异常', updateUnavailable: '当前 DSH 未提供插件更新服务', updateCheckedAt: '上次检测', retryUpdates: '重新读取更新状态',
        enabled: '启用自动接力', threshold: '模型回复次数阈值',
        modelFilter: '触发接力的模型', modelFilterHint: '不限模型，或至少勾选一个。', selectAllModels: '不限模型', loadingModels: '正在加载模型目录…',
        loadModelsError: '无法读取模型目录', retryModels: '重新加载模型', partialModels: '未能加载部分供应商',
        noModels: '当前没有可用模型', unavailableModels: '已保留当前目录未列出的筛选项',
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
        title: 'Session Relay', on: 'On', off: 'Off', replies: 'model replies',
        updates: 'Plugin updates', currentVersion: 'Current version', latestVersion: 'Latest version', checkUpdates: 'Check for updates', installUpdate: 'Update now',
        autoUpdate: 'Update plugin automatically', autoUpdateHint: 'Check and install new versions every 6 hours. A restart prompt appears when needed.',
        updateLoading: 'Loading update status…', updateChecking: 'Checking for updates…', updateInstalling: 'Installing update…',
        updateAvailable: 'An update is available', updateCurrent: 'You have the latest version', updateInstalled: 'Update installed', updateRestart: 'Update installed. Restart DSH to apply it.',
        updateResultUnknown: 'The update connection closed. Reload the status to verify the installed version.', updateError: 'Update status error', updateUnavailable: 'The DSH plugin update service is unavailable', updateCheckedAt: 'Last checked', retryUpdates: 'Reload update status',
        enabled: 'Enable automatic relay', threshold: 'Model reply threshold',
        modelFilter: 'Models that trigger relay', modelFilterHint: 'Allow all models, or check at least one.', selectAllModels: 'Allow all models', loadingModels: 'Loading model catalog…',
        loadModelsError: 'Could not load model catalog', retryModels: 'Reload models', partialModels: 'Some providers could not be loaded',
        noModels: 'No available models', unavailableModels: 'Saved filters not listed in the current catalog were kept',
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
      inject: ['slots', 'sessions', 'uiWorkspace', 'locale', 'remote', 'remote.commands', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('session-relay', words));
        const t = ctx.locale.bind('session-relay');
        const settingsListeners = new Set();
        const requestValue = async (path, signal, patch) => {
          const mount = new URL('.', document.baseURI).pathname.slice(0, -1);
          const response = await fetch(mount + '/api/session-relay/' + path, {
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
        const requestSettings = (signal, patch) => requestValue('settings', signal, patch);
        function SettingsStyles() {
          return h('style', null, `
            .sr-panel{color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;border-top:1px solid var(--dsw-alias-border-l1);padding:4px 8px;margin-top:4px}
            .sr-panel .sr-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:36px}.sr-panel .sr-title{font-weight:600}.sr-panel .sr-status{font-variant-numeric:tabular-nums;margin-inline-start:auto}
            .sr-settings{max-width:100%;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
            .sr-settings h2{font-size:18px;line-height:1.35;margin:0 0 12px;font-weight:600}
            .sr-updates{padding-bottom:16px;margin-bottom:16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.sr-updates h3{font-size:15px;line-height:1.5;margin:0 0 8px;font-weight:600}
            :is(.sr-settings,.sr-panel) p{margin:8px 0;line-height:1.6;overflow-wrap:anywhere}
            :is(.sr-settings,.sr-panel) .sr-muted{color:var(--dsw-alias-label-secondary)}
            :is(.sr-settings,.sr-panel) .sr-form{padding:8px 0}
            :is(.sr-settings,.sr-panel) .sr-option{display:flex;align-items:center;gap:8px;min-height:44px}
            :is(.sr-settings,.sr-panel) .sr-option input{width:16px;height:16px;flex:none;accent-color:var(--dsw-alias-brand-primary)}
            :is(.sr-settings,.sr-panel) .sr-number{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:48px}
            :is(.sr-settings,.sr-panel) .sr-number input{width:104px}
            :is(.sr-settings,.sr-panel) .sr-model{display:grid;gap:6px;margin:8px 0 4px}
            :is(.sr-settings,.sr-panel) .sr-model p{margin:0}
            .sr-model-list{max-height:280px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px}
            .sr-model-list fieldset{border:0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 0 8px;margin:0;min-inline-size:0}
            .sr-model-feedback{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
            .sr-model-list fieldset:last-child{border-bottom:0}.sr-model-list legend{font-weight:600;padding:4px 0}
            .sr-model-list .sr-model-option{display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere}
            .sr-model-list input{width:16px;height:16px;flex:none;accent-color:var(--dsw-alias-brand-primary)}
            :is(.sr-settings,.sr-panel) :is(button,input[type=number]){font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;min-height:44px;box-sizing:border-box}
            :is(.sr-settings,.sr-panel) button{cursor:pointer}
            :is(.sr-settings,.sr-panel) button:disabled{cursor:default;opacity:.6}
            :is(.sr-settings,.sr-panel) button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
            :is(.sr-settings,.sr-panel) :is(button,input):focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
            :is(.sr-settings,.sr-panel) .sr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
            :is(.sr-settings,.sr-panel) .sr-error{color:var(--dsw-alias-state-error-primary)}
            :is(.sr-settings,.sr-panel) .sr-warning{color:var(--dsw-alias-state-warn-primary)}
          `);
        }
        function ModelFilter({ id, value, onChange, disabled }) {
          const [attempt, setAttempt] = React.useState(0);
          const [directory, setDirectory] = React.useState({ groups: [], failures: [], status: 'loading' });
          React.useEffect(() => {
            let active = true;
            const load = async () => {
              try {
                const response = await ctx.remote.session.modelCatalog();
                if (!response?.ok) throw new Error(response?.error?.message ?? t('loadModelsError'));
                const { groups, failures = [] } = response.value;
                if (active) setDirectory({ groups, failures, status: 'ready' });
              } catch (failure) {
                if (active) setDirectory({ groups: [], failures: [], status: 'error', error: String(failure?.message ?? failure) });
              }
            };
            void load();
            return () => { active = false; };
          }, [attempt]);

          const groups = directory.groups.map(group => ({ ...group, models: group.models.map(model => ({
            ...model, key: group.id + '/' + model.id,
          })) }));
          const models = groups.flatMap(group => group.models);
          const selected = new Set(modelTokens(value));
          const unrestricted = selected.size === 0;
          const isChecked = model => unrestricted || selected.has(model.key) || selected.has(model.id);
          const checkedCount = models.filter(isChecked).length;
          const supported = new Set(models.flatMap(model => [model.key, model.id]));
          const unavailable = [...selected].filter(key => !supported.has(key));
          const update = (model, checked) => {
            const next = new Set(unrestricted ? models.map(item => item.key) : selected);
            if (checked) next.add(model.key);
            else {
              next.delete(model.key);
              // Legacy entries may select the same model ID across several providers.
              if (next.delete(model.id)) {
                for (const item of models) if (item.id === model.id && item.key !== model.key) next.add(item.key);
              }
            }
            if (!next.size) return;
            const allSelected = !directory.failures.length && next.size === models.length && models.every(item => next.has(item.key));
            onChange(allSelected ? '' : [...next].join('\n'));
          };
          const retry = () => {
            setDirectory({ groups: [], failures: [], status: 'loading' });
            setAttempt(previous => previous + 1);
          };
          const retryButton = () => h('button', { type: 'button', onClick: retry, disabled }, t('retryModels'));
          return h('div', { className: 'sr-model' },
            h('span', { id: id + '-models-label' }, t('modelFilter')),
            h('p', { id: id + '-models-hint', className: 'sr-muted' }, t('modelFilterHint')),
            directory.status === 'loading' && h('p', { className: 'sr-muted', role: 'status' }, t('loadingModels')),
            directory.status === 'error' && h('div', { className: 'sr-model-feedback' },
              h('p', { className: 'sr-error', role: 'alert' }, t('loadModelsError'), ': ', directory.error), retryButton()),
            directory.status === 'ready' && directory.failures.length > 0 && h('div', { className: 'sr-model-feedback' },
              h('p', { className: 'sr-warning', role: 'status' }, t('partialModels'), ': ', directory.failures.map(item => item.name || item.id).join(', ')), retryButton()),
            directory.status === 'ready' && unavailable.length > 0 && h('p', { className: 'sr-muted' }, t('unavailableModels'), ': ', unavailable.join(', ')),
            directory.status === 'ready' && !models.length && h('p', { className: 'sr-muted' }, t('noModels')),
            h('div', { className: 'sr-model-feedback' },
              h('button', { type: 'button', disabled: disabled || unrestricted, onClick: () => onChange('') }, t('selectAllModels'))),
            directory.status === 'ready' && models.length > 0 && h('div', { className: 'sr-model-list', role: 'group', 'aria-labelledby': id + '-models-label', 'aria-describedby': id + '-models-hint' },
              groups.map(group => h('fieldset', { key: group.id },
                h('legend', null, group.name || group.id),
                group.models.map(model => {
                  const checked = isChecked(model);
                  return h('label', { className: 'sr-model-option', key: model.key },
                    h('input', { type: 'checkbox', value: model.key, checked, disabled: disabled || (checked && checkedCount === 1 && !unavailable.length), onChange: event => update(model, event.target.checked) }),
                    h('span', null, model.name || model.id));
                })))));
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
            h(ModelFilter, { id, value: draft.modelFilter, disabled: busy, onChange: modelFilter => setDraft({ ...draft, modelFilter }) }),
            checkbox('autoContinue'), checkbox('autoSwitch'),
            h('p', { className: 'sr-muted' }, t('scope')),
            h('div', { className: 'sr-actions' }, h('button', { type: 'submit', disabled: busy || !dirty }, t(busy ? 'saving' : 'save')), children));
        }
        function UpdateSettings() {
          const id = React.useId();
          const [data, setData] = React.useState(null);
          const [busy, setBusy] = React.useState(false);
          const [error, setError] = React.useState('');
          const controllerRef = React.useRef(null);
          const pending = React.useRef(false);
          const run = async (action, enabled) => {
            const controller = controllerRef.current;
            if (!controller || controller.signal.aborted || pending.current) return;
            pending.current = true; setBusy(true); setError('');
            if (action === 'check' || action === 'update') setData(value => ({ ...value, status: action === 'update' ? 'updating' : 'checking', error: '' }));
            try {
              const value = await requestValue('updates', controller.signal, action ? { action, ...(action === 'autoUpdate' ? { enabled } : {}) } : undefined);
              if (!controller.signal.aborted) setData(value);
            } catch (failure) {
              if (!controller.signal.aborted) {
                // HMR can unload the calling plugin before its response arrives.
                // Read the replacement instance rather than retrying installation.
                if (action === 'update') {
                  try {
                    const latest = await requestValue('updates', controller.signal);
                    if (controller.signal.aborted) return;
                    if (latest.currentVersion !== data?.currentVersion || ['updated', 'updating'].includes(latest.status)) { setData(latest); return; }
                  } catch {}
                }
                setError(action === 'update' ? t('updateResultUnknown') : String(failure.message ?? failure));
                setData(value => value ? { ...value, status: 'error' } : value);
              }
            } finally {
              if (!controller.signal.aborted) { pending.current = false; setBusy(false); }
            }
          };
          React.useEffect(() => {
            const controller = new AbortController();
            controllerRef.current = controller; pending.current = false;
            void run();
            return () => controller.abort();
          }, []);
          const working = busy || ['checking', 'updating'].includes(data?.status);
          React.useEffect(() => {
            const timer = setInterval(() => { if (!document.hidden) void run(); }, ['checking', 'updating'].includes(data?.status) ? 1500 : 15000);
            return () => clearInterval(timer);
          }, [data?.status]);
          const statusKey = { checking: 'updateChecking', updating: 'updateInstalling', available: 'updateAvailable', current: 'updateCurrent', updated: 'updateInstalled' }[data?.status];
          return h('section', { className: 'sr-updates', 'aria-labelledby': id + '-updates', 'aria-busy': working },
            h('h3', { id: id + '-updates' }, t('updates')),
            !data && !error && h('p', { className: 'sr-muted', role: 'status' }, t('updateLoading')),
            data?.currentVersion && h('p', null, t('currentVersion'), ': ', data.currentVersion, data.latestVersion && ` · ${t('latestVersion')}: ${data.latestVersion}`),
            data && !data.supported && h('p', { className: 'sr-warning' }, t('updateUnavailable')),
            data && h('label', { className: 'sr-option' }, h('input', { type: 'checkbox', checked: !!data.autoUpdate, disabled: working || (!data.supported && !data.autoUpdate), onChange: event => run('autoUpdate', event.target.checked) }), t('autoUpdate')),
            h('p', { className: 'sr-muted' }, t('autoUpdateHint')),
            data && h('div', { className: 'sr-actions' },
              h('button', { type: 'button', disabled: working || !data.supported, onClick: () => run('check') }, t('checkUpdates')),
              data.updateAvailable && h('button', { type: 'button', disabled: working || !data.supported, onClick: () => run('update') }, t('installUpdate'))),
            statusKey && h('p', { role: 'status' }, t(data?.restartRequired ? 'updateRestart' : statusKey)),
            data?.checkedAt && h('p', { className: 'sr-muted' }, t('updateCheckedAt'), ': ', new Date(data.checkedAt).toLocaleString()),
            (error || data?.error) && h('p', { className: 'sr-error', role: 'alert' }, t('updateError'), ': ', error || data.error),
            error && h('button', { type: 'button', disabled: working, onClick: () => run() }, t('retryUpdates')));
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
            h(UpdateSettings),
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
          const fetchRef = React.useRef(null);
          const abortRef = React.useRef(null);
          const loaded = React.useRef(false);
          const opened = React.useRef(null);
          React.useEffect(() => {
            const controller = new AbortController();
            abortRef.current = controller;
            loaded.current = false; opened.current = null;
            setData(null); setError(''); setBusy(false);
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
          return h('section', { className: 'sr-panel', 'aria-label': t('title') },
            h(SettingsStyles),

            h('div', { className: 'sr-top' },
              h('span', { className: 'sr-title' }, t('title')),
              h('span', { className: 'sr-muted' }, data ? t(data.enabled ? 'on' : 'off') : '…'),
              data && h('span', { className: 'sr-status' }, `${data.replies} / ${data.threshold} ${t('replies')}`)),
            phase && h('p', { role: 'status' }, t(phase === 'error' ? 'failed' : phase)),
            error && h('p', { className: 'sr-error', role: 'alert' }, error),
            error && !data && h('button', { type: 'button', disabled: busy, onClick: () => fetchRef.current?.('/relay status', true) }, t(busy ? 'saving' : 'retryLoad')),
            data?.handoff?.error && h('p', { className: 'sr-error', role: 'alert' }, t('error'), data.handoff.error),
            data?.handoff && h('div', { className: 'sr-actions' },
              data.handoff.targetCreated && h('button', { type: 'button', onClick: openTarget }, t('open')),
              phase === 'error' && data.handoff.recoverable && h('button', { type: 'button', disabled: busy, onClick: () => call({ action: 'retry' }) }, t('retry')),
              phase === 'error' && !data.handoff.targetCreated && h('button', { type: 'button', disabled: busy, onClick: () => call({ action: 'release' }) }, t('release'))),
            data?.eligible === false && h('p', { className: 'sr-warning' }, t('subagent')));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'session-relay', order: 100, label: () => t('title') }, RelaySettings));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'session-relay', order: 20 }, RelayPanel));
      },
    };
  },
});
