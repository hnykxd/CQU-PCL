import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('原生单实例检查需要 Windows。');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packaged = process.argv.includes('--packaged');
if (!packaged) execFileSync(process.execPath, [path.join(root, 'scripts/build-native.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });
const binary = path.join(root, packaged ? 'release/CQU-PCL-Native.exe' : '.build-cache/CQU-PCL-Native-dev.exe');
const directory = await fs.mkdtemp(path.join(root, '.build-cache/single-instance-'));
const data = path.join(directory, 'Shared Data');
const independent = path.join(directory, 'Independent Data');
const allChildren = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function launch(dataDirectory, extraEnv = {}) {
  const child = spawn(binary, packaged ? [] : ['--workspace', root], {
    cwd: root, windowsHide: true,
    env: { ...process.env, CQU_PCL_DATA_OVERRIDE: dataDirectory, CQU_PCL_NODE: process.execPath, NODE_OPTIONS: '--import ' + JSON.stringify(pathToFileURL(path.join(root, 'tests/native-fixture.mjs')).href), ...extraEnv }
  });
  child.done = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); });
  allChildren.push(child); return child;
}
async function finish(child, timeout = 12000) {
  let timer;
  try { return await Promise.race([child.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Process did not exit: ' + child.pid)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function state(child, action = 'state') {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/native-window-test.ps1'), '-ProcessId', String(child.pid), '-Action', action], { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
}
async function owner(dataDirectory) {
  return Number((await fs.readFile(path.join(dataDirectory, '.launcher-instance.lock'), 'utf8')).split('\n')[0]);
}
async function ready(child, dataDirectory) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (child.exitCode !== null) throw new Error('Owner exited during startup: ' + child.exitCode);
    const value = state(child);
    if (value.window && value.backendPids.length === 1) {
      try { await fs.access(path.join(dataDirectory, 'launcher.json')); return value; } catch {}
    }
    await sleep(200);
  }
  throw new Error('Owner did not create one window/backend.');
}
const report = { packaged, checks: [], directory };
try {
  await fs.mkdir(data, { recursive: true });
  // A previous crash can leave bytes, but no live Windows file handle.
  await fs.writeFile(path.join(data, '.launcher-instance.lock'), '999999\n0\nLocal\\CQU-PCL-Activate-stale');
  const first = launch(data);
  for (let attempt = 0; attempt < 200 && await owner(data) !== first.pid; attempt++) await sleep(50);
  assert.equal(await owner(data), first.pid);
  const burst = Array.from({ length: 5 }, () => launch(path.join(data.toUpperCase(), '.')));
  await ready(first, data);
  assert.equal(await owner(data), first.pid, 'first launch owns the directory');
  assert.deepEqual(await Promise.all(burst.map(child => finish(child))), [0, 0, 0, 0, 0]);
  assert.equal(state(first).backendPids.length, 1);
  report.checks.push('stale-lock-recovery', 'rapid-duplicate-launches', 'case-and-dot-aliases', 'one-backend');

  const junction = path.join(directory, 'Data Junction');
  await fs.symlink(data, junction, 'junction');
  assert.equal(await finish(launch(junction)), 0, 'junction path still identifies the same physical lock');
  assert.equal(await owner(data), first.pid);
  report.checks.push('junction-alias');

  const configBefore = await fs.readFile(path.join(data, 'launcher.json'), 'utf8');
  assert.equal(state(first, 'minimize').minimized, true);
  const repeated = launch(data); assert.equal(await finish(repeated), 0);
  assert.equal(state(first).minimized, false, 'repeat launch restores the existing window');
  assert.equal(await fs.readFile(path.join(data, 'launcher.json'), 'utf8'), configBefore);
  report.checks.push('restore-minimized-window', 'duplicate-keeps-config');

  const secret = 'single-instance-dpapi-fixture';
  const options = { input: secret, encoding: 'utf8', windowsHide: true, env: { ...process.env, CQU_PCL_DATA_OVERRIDE: data } };
  const encrypted = execFileSync(binary, ['--crypto', 'encrypt'], options).trim();
  assert.equal(execFileSync(binary, ['--crypto', 'decrypt'], { ...options, input: encrypted }).trim(), secret);
  report.checks.push('crypto-helper-bypasses-guard');

  const other = launch(independent); await ready(other, independent);
  assert.equal(await owner(independent), other.pid);
  assert.equal(first.exitCode, null);
  state(other, 'close'); assert.equal(await finish(other), 0);
  report.checks.push('independent-data-directories');

  state(first, 'close'); assert.equal(await finish(first), 0);
  const exitMarker = path.join(directory, 'backend-exit-marker');
  const restarted = launch(data, { CQU_PCL_TEST_EXIT_MARKER: exitMarker }); await ready(restarted, data);
  assert.equal(await owner(data), restarted.pid);
  report.checks.push('normal-exit-restart');

  restarted.kill(); await finish(restarted);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.access(exitMarker); break; } catch {}
    await sleep(20);
  }
  await fs.access(exitMarker);
  const lockPath = path.join(data, '.launcher-instance.lock').replaceAll("'", "''");
  const lockState = execFileSync('powershell.exe', ['-NoProfile', '-Command', `try { $taskLock = [System.IO.File]::Open('${lockPath}', 'OpenOrCreate', 'ReadWrite', 'Read'); $taskLock.Dispose(); 'unlocked' } catch [System.IO.IOException] { 'locked' }`], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(lockState, 'locked', 'backend retains the directory while its killed host cannot');
  report.checks.push('backend-holds-lock-after-host-kill');
  const recovered = launch(data); await ready(recovered, data);
  assert.equal(await owner(data), recovered.pid);
  assert.equal(state(recovered).backendPids.length, 1);
  state(recovered, 'close'); assert.equal(await finish(recovered), 0);
  report.checks.push('forced-exit-restart');
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; }
finally {
  for (const child of allChildren) if (child.exitCode === null) {
    try { state(child, 'close'); await finish(child, 5000); } catch { child.kill(); }
  }
}
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
