import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayUpdates, checkGitHubUpdate } from '../updates.js';

const candidate = { version: '1.0.3', available: true, specifier: 'github:YuneTech/dsh-session-relay#commit' };
function updater(options = {}) {
  return new RelayUpdates({ currentVersion: '1.0.2', check: async () => candidate, install: async () => {}, autoUpdate: () => false, ...options });
}

test('GitHub checks pin metadata and installation to one commit and never downgrade', async () => {
  const requests = [];
  const sha = 'a'.repeat(40);
  const fetch = async url => {
    requests.push(url);
    return Response.json(url.includes('/commits/') ? { sha } : { name: 'dsh-session-relay', version: '1.1.0' });
  };
  const available = await checkGitHubUpdate('1.0.9', { fetch });
  assert.equal(available.available, true);
  assert.equal(available.specifier, 'github:YuneTech/dsh-session-relay#' + sha);
  assert.equal(requests[1], 'https://raw.githubusercontent.com/YuneTech/dsh-session-relay/' + sha + '/package.json');
  assert.equal((await checkGitHubUpdate('1.1.0', { fetch })).available, false);
  assert.equal((await checkGitHubUpdate('2.0.0', { fetch })).available, false);
  await assert.rejects(checkGitHubUpdate('1.0.2', { fetch: async () => Response.json({ sha: '../main' }) }), /invalid commit/);
  await assert.rejects(checkGitHubUpdate('1.0.2', { fetch: async () => Response.json({}, { status: 429 }) }), /GitHub HTTP 429/);
  await assert.rejects(checkGitHubUpdate('1.0.2', { fetch: async url => Response.json(url.includes('/commits/') ? { sha } : { name: 'different-package', version: '9.0.0' }) }), /Unexpected update package/);
});

test('checking never installs, while a manual update stages the verified candidate once', async () => {
  const installed = [];
  const updates = updater({ install: async value => { installed.push(value); return { restartRequired: true }; } });
  assert.equal((await updates.run(false)).updateAvailable, true);
  assert.deepEqual(installed, []);
  const result = await updates.run(true);
  assert.equal(result.status, 'updated');
  assert.equal(result.currentVersion, '1.0.2');
  assert.equal(result.installedVersion, '1.0.3');
  assert.equal(result.restartRequired, true);
  assert.equal(result.updateAvailable, false);
  await updates.run(true);
  assert.deepEqual(installed, [candidate]);
});

test('automatic checks run only when enabled and stop after staging an update', async () => {
  let enabled = false;
  let checks = 0;
  let installs = 0;
  const updates = updater({ autoUpdate: () => enabled, check: async () => { checks++; return candidate; }, install: async () => { installs++; } });
  await updates.tick();
  assert.equal(checks, 0);
  enabled = true;
  await updates.tick();
  await updates.tick();
  assert.equal(checks, 1);
  assert.equal(installs, 1);
  assert.equal(updates.snapshot().autoUpdate, true);
});

test('turning off automatic updates during a check prevents installation but permits manual updates', async () => {
  let enabled = true;
  let release;
  let installs = 0;
  const updates = updater({ autoUpdate: () => enabled, check: () => new Promise(resolve => { release = resolve; }), install: async () => { installs++; } });
  const pending = updates.tick();
  enabled = false;
  release(candidate);
  assert.equal((await pending).status, 'available');
  assert.equal(installs, 0);
  const manual = updates.run(true);
  release(candidate);
  assert.equal((await manual).status, 'updated');
  assert.equal(installs, 1);
});

test('simultaneous update requests share one check and one installation', async () => {
  let release;
  let installs = 0;
  const updates = updater({ check: () => new Promise(resolve => { release = resolve; }), install: async () => { installs++; } });
  const one = updates.run(true);
  const two = updates.run(true);
  assert.equal(updates.snapshot().status, 'checking');
  assert.equal(one, two);
  release(candidate);
  await Promise.all([one, two]);
  assert.equal(installs, 1);
});

test('check and install failures remain visible and can be retried', async () => {
  let failCheck = true;
  let failInstall = true;
  const updates = updater({
    check: async () => { if (failCheck) throw new Error('offline'); return candidate; },
    install: async () => { if (failInstall) throw new Error('install failed'); },
  });
  const offline = await updates.run(true);
  assert.equal(offline.error, 'offline');
  assert.equal(offline.updateAvailable, false);
  assert.equal(offline.restartRequired, false);
  failCheck = false;
  const failed = await updates.run(true);
  assert.equal(failed.error, 'install failed');
  assert.equal(failed.updateAvailable, true);
  assert.equal(failed.restartRequired, false);
  failInstall = false;
  assert.equal((await updates.run(true)).status, 'updated');
});

test('no newer release and missing host support never install', async () => {
  let installs = 0;
  const current = updater({ check: async () => ({ version: '1.0.1', available: false }), install: async () => { installs++; } });
  assert.equal((await current.run(true)).status, 'current');
  const missing = updater({ supported: () => false, install: async () => { installs++; } });
  assert.match((await missing.run(true)).error, /plugin manager is unavailable/);
  assert.equal(installs, 0);
});
