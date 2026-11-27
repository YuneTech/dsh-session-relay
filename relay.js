/** Host-independent handoff coordinator. The DSH adapter lives in index.js. */
export const DEFAULT_THRESHOLD = 90;
export const MIN_THRESHOLD = 2;
export const MAX_THRESHOLD = 10000;

export function validateSettings(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Settings must be an object');
  }
  const allowed = new Set(['enabled', 'threshold', 'modelFilter', 'autoContinue', 'autoSwitch']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Unknown setting: ${key}`);
    if (key === 'threshold') {
      if (!Number.isSafeInteger(patch[key]) || patch[key] < MIN_THRESHOLD || patch[key] > MAX_THRESHOLD) {
        throw new Error(`threshold must be an integer from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}`);
      }
    } else if (key === 'modelFilter') {
      if (typeof patch[key] !== 'string') throw new Error('modelFilter must be a string');
    } else if (typeof patch[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  return patch;
}

function matchesModel(filter, selection) {
  const entries = (filter ?? '').split(/[,，\r\n]+/).map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) return true;
  if (!selection?.model) return false;
  return entries.includes(selection.model)
    || (!!selection.provider && entries.includes(selection.provider + '/' + selection.model));
}

export function mergeMessages(...groups) {
  const seen = new Set();
  return groups.flat().filter(message => {
    if (!message || typeof message.id !== 'string') throw new Error('Cannot transfer an unidentified message');
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/** Inbox insertion is the durable receipt, including the claim-before-admission gap. */
export function receivedMessageIds(events) {
  const ids = new Set();
  for (const event of events) {
    if (event.type === 'user/message') ids.add(event.data.id);
    else if (event.type === 'agent/inbox/spliced') {
      for (const item of event.data.inserted) ids.add(item.id);
    }
  }
  return ids;
}

/** No timers, ambient globals, or DSH writes: all effects belong to the adapter. */
export class SessionRelay {
  constructor(adapter) {
    this.a = adapter;
    this.locks = new Map();
    this.tasks = new Map();
    this.disposed = false;
  }

  /** Interrupted durable work stays stopped until an explicit retry or release. */
  async recover() {
    for (const [id, row] of this.a.entries()) {
      if (row.phase === 'error') continue;
      if (row.phase === 'done' && !row.claimed?.length && !row.pending?.length) continue;
      await this.a.put(id, {
        ...row, phase: 'error', recoveredAt: this.a.now(),
        error: 'Handoff interrupted by restart or reload. Saved inputs are retained; explicitly retry or release it.',
      });
    }
  }

  async locked(id, operation) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.locks.set(id, task);
    try { return await task; }
    finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }

  async capture(agent, messages) {
    return this.locked(agent.id, async () => {
      const row = this.a.get(agent.id);
      if (!row) throw new Error('Handoff record missing');
      const claimed = mergeMessages(row.claimed ?? [], messages);
      const updated = { ...row, claimed };
      await this.a.put(agent.id, updated);
      return updated;
    });
  }

  /** Called only inside the old Agent's open turn, at a balanced boundary. */
  async boundary(agent, messages, resume, signal, modelSelection) {
    if (this.disposed || !this.a.eligible(agent)) return false;
    const existing = this.a.get(agent.id);
    if (existing) {
      if (messages.length) await this.capture(agent, messages);
      if (existing.phase === 'done' && messages.length) this.launch(agent);
      return true; // A failed/incomplete handoff parks work; never hit the old provider again.
    }
    const config = this.a.settings();
    if (!config.enabled || this.a.count(agent) < config.threshold) return false;
    const selection = modelSelection ?? this.a.selection(agent);
    if (!matchesModel(config.modelFilter, selection)) return false;
    const row = {
      phase: 'compressing', createdAt: this.a.now(), targetId: this.a.id(),
      claimed: mergeMessages(messages), resume, seedId: this.a.id(), continueId: this.a.id(),
      selection: selection ?? null, location: this.a.location(agent),
    };
    // Persist claimed inputs before rejecting their step. Failure propagates loudly.
    await this.a.put(agent.id, row);
    try {
      const summary = await this.a.compact(agent, signal);
      if (!summary?.length) throw new Error('Compression returned no usable summary');
      signal?.throwIfAborted();
      await this.locked(agent.id, async () => {
        const saved = this.a.get(agent.id);
        await this.a.put(agent.id, { ...saved, summary, phase: 'prepared' });
      });
      this.launch(agent);
    } catch (error) {
      await this.fail(agent.id, error);
    }
    return true;
  }

  launch(agent) {
    if (this.disposed || this.tasks.has(agent.id)) return;
    // This promise MUST NOT be awaited by a pre-step/turn-stopping listener.
    const task = this.finish(agent).catch(error => this.fail(agent.id, error));
    this.tasks.set(agent.id, task);
    task.finally(() => {
      if (this.tasks.get(agent.id) === task) this.tasks.delete(agent.id);
      const row = this.a.get(agent.id);
      if (!this.disposed && row?.phase === 'done' && row.claimed?.length) this.launch(agent);
    }).catch(() => {});
  }

  async fail(id, error) {
    const text = error instanceof Error ? error.message : String(error);
    await this.locked(id, async () => {
      const row = this.a.get(id);
      if (row) await this.a.put(id, { ...row, phase: 'error', error: text });
    });
    this.a.report(id, text);
  }

  async finish(agent) {
    await this.a.whenIdle(agent);
    if (this.disposed) return;
    await this.a.maintain(agent, async signal => {
      await this.locked(agent.id, async () => {
        let row = this.a.get(agent.id);
        if (row?.phase === 'done' && !row.claimed?.length && !row.pending?.length) return;
        if (!row?.summary?.length) throw new Error('No saved summary; release this handoff to retry compression');
        signal?.throwIfAborted();
        const next = await this.a.target(row, async id => {
          row = { ...row, targetId: id, targetCreated: true, phase: 'transferring' };
          await this.a.put(agent.id, row);
        });
        row = { ...row, targetId: next.id, targetCreated: true, phase: 'transferring' };
        await this.a.put(agent.id, row);
        const pending = this.a.pending(agent);
        // Snapshot before clearing either inbox; recovery can replay stable ids exactly once.
        const transfer = mergeMessages(row.claimed ?? [], row.pending ?? [], pending);
        row = { ...row, pending: transfer };
        await this.a.put(agent.id, row);
        await this.a.seed(next, row, agent.id);
        await this.a.transfer(next, transfer);
        await this.a.flush(next);
        // Remove only the exact old pending ids copied above, never a racing arrival.
        this.a.removePending(agent, transfer.map(message => message.id));
        await this.a.flush(agent);
        const shouldResume = row.resume && this.a.settings().autoContinue && transfer.length === 0;
        // Keep the recovery payload durable until wake succeeds. Stable ids make a
        // crash after wake but before this commit safe to retry.
        if (transfer.length) await this.a.wake(next, null);
        else if (shouldResume) await this.a.wake(next, row);
        // A queued continuation and the wake's inbox mutations must outlive the
        // recovery payload; the earlier flush predates these writes.
        await this.a.flush(next);
        row = { ...row, phase: 'done', error: null, claimed: [], pending: [], completedAt: this.a.now() };
        await this.a.put(agent.id, row);
      });
    });
  }

  /** Explicit retry reuses the durable target and seed; it does not re-summarize. */
  async retry(agent) {
    const row = this.a.get(agent.id);
    if (!row) throw new Error('No pending handoff');
    if (!row.summary?.length) throw new Error('Summary failed. Release the saved input, then retry with a lower threshold or a working summarization model.');
    this.launch(agent);
    return { scheduled: true, targetId: row.targetId };
  }

  /** Release is explicit: restore only captured (already claimed) messages. */
  async release(agent) {
    if (this.tasks.has(agent.id)) throw new Error('Handoff is still running');
    if (agent.status !== 'idle') throw new Error('Wait for the old session to become idle');
    return this.a.maintain(agent, async () => this.locked(agent.id, async () => {
      const row = this.a.get(agent.id);
      if (!row) return { released: false };
      if (row.targetCreated || row.phase === 'done') throw new Error('Work was already transferred; continue in the new session');
      // Disable the automation first, otherwise restoration would immediately trigger again.
      await this.a.configure({ enabled: false });
      await this.a.restore(agent, row.claimed ?? []);
      await this.a.flush(agent);
      await this.a.delete(agent.id);
      return { released: true, restored: row.claimed?.length ?? 0 };
    }));
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.tasks.values()]);
  }
}
