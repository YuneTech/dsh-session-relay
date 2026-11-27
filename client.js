window.__ModuleLoader__.load({
  id: 'dsh-session-relay',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const words = {
      zh: {
        title: '会话接力', on: '已开启', off: '未开启', replies: '次模型回复', settings: '设置',
        enabled: '启用自动接力（全部主会话）', threshold: '回复次数达到此值后续接',
        autoContinue: '长任务中断时自动继续', autoSwitch: '完成后自动打开新会话', save: '保存', saving: '处理中…',
        refresh: '刷新状态', retryLoad: '重试读取状态', open: '打开新会话', retry: '重试续接', release: '停用并恢复未转移输入',
        hint: '包含工具调用回复。默认 90，为摘要请求留余量；旧会话保留。',
        warning: '若中转上限为 100，建议设为 80–90。摘要和重试也可能占用额度。',
        scope: '不迁移子代理、后台任务句柄或临时授权。若商家按账号累计限制，换会话无法重置。',
        error: '续接暂停，输入已保留：', subagent: '子代理不自动切换会话', countError: '请输入 2–10000 之间的整数',
        compressing: '正在压缩', prepared: '等待安全切换', transferring: '正在转移上下文', done: '已接力到新会话', failed: '需要处理',
      },
      en: {
        title: 'Session Relay', on: 'On', off: 'Off', replies: 'model replies', settings: 'Settings',
        enabled: 'Enable relay for all main sessions', threshold: 'Start a fresh session after this many replies',
        autoContinue: 'Resume interrupted tasks', autoSwitch: 'Open the new session automatically', save: 'Save', saving: 'Working…',
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
        function RelayPanel({ sessionId }) {
          React.useSyncExternalStore(ctx.locale.subscribe.bind(ctx.locale), ctx.locale.getSnapshot.bind(ctx.locale));
          const [data, setData] = React.useState(null);
          const [error, setError] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const [draft, setDraft] = React.useState(null);
          const [expanded, setExpanded] = React.useState(false);
          const fetchRef = React.useRef(null);
          const abortRef = React.useRef(null);
          const loaded = React.useRef(false);
          const opened = React.useRef(null);
          const id = React.useId();
          React.useEffect(() => {
            const controller = new AbortController();
            abortRef.current = controller;
            loaded.current = false; opened.current = null;
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
                  if (!loaded.current || mutate) setDraft({ enabled: value.enabled, threshold: String(value.threshold), autoContinue: value.autoContinue, autoSwitch: value.autoSwitch });
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
            void load();
            return () => { controller.abort(); clearTimeout(scheduled); unsubscribe?.(); fetchRef.current = null; };
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
            const threshold = Number(draft.threshold);
            if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > 10000) { setError(t('countError')); return; }
            void call({ action: 'configure', settings: { ...draft, threshold } });
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
          const checkbox = (key, label) => h('label', { className: 'sr-option', key },
            h('input', { type: 'checkbox', checked: !!draft[key], disabled: busy, onChange: event => setDraft({ ...draft, [key]: event.target.checked }) }), label);
          return h('section', { className: 'sr-panel', 'aria-label': t('title') },
            h('style', null, `
              .sr-panel{color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;border-top:1px solid var(--dsw-alias-border-l1);padding:4px 8px;margin-top:4px}
              .sr-top,.sr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sr-top{min-height:36px}.sr-title{font-weight:600}.sr-muted{color:var(--dsw-alias-label-secondary)}.sr-status{font-variant-numeric:tabular-nums;margin-inline-start:auto}
              .sr-panel button,.sr-panel input[type=number]{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;min-height:44px}.sr-panel button{cursor:pointer}.sr-panel button:disabled{cursor:wait;opacity:.6}.sr-panel button:hover{background:var(--dsw-alias-interactive-bg-hover)}.sr-panel button:focus-visible,.sr-panel input:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
              .sr-panel p{margin:8px 0;line-height:1.6;overflow-wrap:anywhere}.sr-form{padding:8px 0}.sr-option{display:flex;align-items:center;gap:8px;min-height:44px}.sr-option input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}.sr-number{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:48px}.sr-number input{width:104px}.sr-actions{margin-top:8px}.sr-error{color:var(--dsw-alias-state-error-primary)}.sr-warning{color:var(--dsw-alias-state-warn-primary)}
            `),
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
            expanded && draft && h('form', { id: `${id}-form`, className: 'sr-form', onSubmit: save },
              checkbox('enabled', t('enabled')),
              h('label', { className: 'sr-number', htmlFor: `${id}-threshold` }, t('threshold'),
                h('input', { id: `${id}-threshold`, type: 'number', min: 2, max: 10000, step: 1, required: true, value: draft.threshold, disabled: busy, onChange: event => setDraft({ ...draft, threshold: event.target.value }) })),
              checkbox('autoContinue', t('autoContinue')), checkbox('autoSwitch', t('autoSwitch')),
              h('p', { className: 'sr-muted' }, t('hint')),
              Number(draft.threshold) > 90 && h('p', { className: 'sr-warning' }, t('warning')),
              h('p', { className: 'sr-muted' }, t('scope')),
              data?.eligible === false && h('p', { className: 'sr-warning' }, t('subagent')),
              h('div', { className: 'sr-actions' }, h('button', { type: 'submit', disabled: busy }, t(busy ? 'saving' : 'save')),
                h('button', { type: 'button', disabled: busy, onClick: () => fetchRef.current?.() }, t('refresh')))));
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'session-relay', order: 20 }, RelayPanel));
      },
    };
  },
});
