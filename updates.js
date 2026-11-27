export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;

const repository = 'YuneTech/dsh-session-relay';

function releaseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match || !match.slice(1).every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error('Expected a stable release version: ' + value);
  }
  return match.slice(1).map(Number);
}

/** Resolve metadata and installation to the same immutable GitHub commit. */
export async function checkGitHubUpdate(currentVersion, { fetch: request = globalThis.fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(15000);
  const options = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { 'User-Agent': 'dsh-session-relay', Accept: 'application/vnd.github+json' } };
  const json = async url => {
    const response = await request(url, options);
    if (!response.ok) throw new Error('GitHub HTTP ' + response.status);
    return response.json();
  };
  const commit = await json('https://api.github.com/repos/' + repository + '/commits/HEAD');
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('GitHub returned an invalid commit');
  const manifest = await json('https://raw.githubusercontent.com/' + repository + '/' + commit.sha + '/package.json');
  if (manifest.name !== 'dsh-session-relay') throw new Error('Unexpected update package');
  const next = releaseVersion(manifest.version);
  const current = releaseVersion(currentVersion);
  const difference = next.map((part, index) => part - current[index]).find(value => value !== 0) ?? 0;
  return { version: manifest.version, available: difference > 0, specifier: 'github:' + repository + '#' + commit.sha };
}

/** Coordinates manual and automatic updates without overlapping installations. */
export class RelayUpdates {
  constructor({ currentVersion, check, install, autoUpdate, supported = () => true, now = Date.now }) {
    this.currentVersion = currentVersion;
    this.checkRemote = check;
    this.install = install;
    this.autoUpdate = autoUpdate;
    this.supported = supported;
    this.now = now;
    this.status = 'idle';
    this.checkedAt = null;
    this.candidate = null;
    this.installedVersion = null;
    this.restartRequired = false;
    this.error = '';
    this.pending = null;
  }

  snapshot() {
    return {
      currentVersion: this.currentVersion,
      latestVersion: this.candidate?.version ?? null,
      checkedAt: this.checkedAt,
      autoUpdate: this.autoUpdate(),
      supported: this.supported(),
      status: this.status,
      updateAvailable: !!this.candidate?.available && this.candidate.version !== this.installedVersion,
      restartRequired: this.restartRequired,
      installedVersion: this.installedVersion,
      error: this.error,
    };
  }

  run(install, automatic = false) {
    if (this.pending) return this.pending;
    this.pending = this.perform(install, automatic).finally(() => { this.pending = null; });
    return this.pending;
  }

  async perform(install, automatic) {
    try {
      if (!this.supported()) throw new Error('DSH plugin manager is unavailable');
      this.status = 'checking';
      this.error = '';
      this.candidate = null;
      this.candidate = await this.checkRemote();
      this.checkedAt = new Date(this.now()).toISOString();
      if (this.candidate.available && this.candidate.version !== this.installedVersion) {
        if (install && (!automatic || this.autoUpdate())) {
          this.status = 'updating';
          const result = await this.install(this.candidate);
          this.installedVersion = this.candidate.version;
          this.restartRequired = result?.restartRequired === true;
          this.status = 'updated';
        } else this.status = 'available';
      } else this.status = this.installedVersion ? 'updated' : 'current';
    } catch (error) {
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
    }
    return this.snapshot();
  }

  async tick() {
    if (this.autoUpdate() && !this.installedVersion) return this.run(true, true);
    return this.snapshot();
  }
}
