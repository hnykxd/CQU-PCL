import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packaged = process.argv.includes('--packaged');
if (!packaged) execFileSync(process.execPath, [path.join(root, 'scripts/build-native.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });
const data = await fs.mkdtemp(path.join(root, '.build-cache/native-qa-'));
const id = 'native-qa-world';
await fs.mkdir(path.join(data, 'instances', id, 'game'), { recursive: true });
await fs.writeFile(path.join(data, 'launcher.json'), JSON.stringify({ settings: { source: 'bmclapi', memory: 4096, javaPath: '', playerName: 'Fixture', loginMode: 'offline', curseforgeKey: '', concurrency: 6 }, instances: [{ id, name: '原生界面测试世界', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0', edition: 'java', status: 'ready', mods: [], lastPlayed: '2026-10-21T02:30:00Z' }], selectedId: id }));
const zip = new AdmZip(); zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', name: '原生导入测试', versionId: '1.0', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' }, files: [] })));
zip.writeZip(path.join(data, 'fixture.mrpack'));
const binary = path.join(root, packaged ? 'release/CQU-PCL-Native.exe' : '.build-cache/CQU-PCL-Native-dev.exe');
const secret = 'native-dpapi-fixture';
const encrypted = execFileSync(binary, ['--crypto', 'encrypt'], { input: secret, encoding: 'utf8', windowsHide: true }).trim();
if (!encrypted || encrypted.includes(secret)) throw new Error('DPAPI 没有加密测试凭据');
if (execFileSync(binary, ['--crypto', 'decrypt'], { input: encrypted, encoding: 'utf8', windowsHide: true }).trim() !== secret) throw new Error('DPAPI 无法恢复测试凭据');
const started = Date.now();
const child = spawn(binary, [...(packaged ? [] : ['--workspace', root]), '--smoke-test'], { cwd: root, windowsHide: true, env: { ...process.env, CQU_PCL_DATA_OVERRIDE: data, CQU_PCL_NODE: process.execPath, NODE_OPTIONS: '--import ' + JSON.stringify(pathToFileURL(path.join(root, 'tests/native-fixture.mjs')).href), CQU_PCL_NATIVE_QA: '1' } });
const metrics = [];
const sampler = setInterval(() => {
  try {
    const script = `$taskProcesses = Get-CimInstance Win32_Process; $taskIds = @(${child.pid}); for ($taskLevel=0; $taskLevel -lt 3; $taskLevel++) { $taskIds += @($taskProcesses | Where-Object { $_.ParentProcessId -in $taskIds } | ForEach-Object ProcessId) }; Get-Process -Id ($taskIds | Select-Object -Unique) -ErrorAction SilentlyContinue | Select-Object ProcessName,WorkingSet64 | ConvertTo-Json -Compress`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    metrics.push(JSON.parse(output));
  } catch { /* Process may exit between inventory and measurement. */ }
}, 1200);
const timeout = setTimeout(() => { child.kill(); }, 60000);
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); clearTimeout(timeout); clearInterval(sampler);
const resultFile = path.join(data, 'native-qa/result.json');
const result = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(async error => { console.error(await fs.readFile(path.join(data, 'startup-error.log'), 'utf8').catch(() => error.message)); throw error; }));
result.dpapi = true;
const observed = metrics.flat();
result.seconds = (Date.now() - started) / 1000;
result.processes = [...new Set(observed.map(p => p.ProcessName))];
result.peakSampledWorkingSetMB = Math.max(0, ...metrics.map(sample => [sample].flat().reduce((sum, p) => sum + p.WorkingSet64, 0) / 1024 ** 2));
await fs.writeFile(path.join(data, 'native-qa/result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ data, code, ...result }, null, 2));
if (result.processes.some(name => /electron|webview|chrome|msedge/i.test(name))) throw new Error('原生测试出现浏览器进程');
if (!result.ok || code !== 0) process.exitCode = 1;
