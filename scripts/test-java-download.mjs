import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureJava, verifyJava } from '../server/java-runtime.mjs';

if (process.platform !== 'win32') throw new Error('Java 实际下载检查需要 Windows');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
await fs.mkdir(path.join(root, '.build-cache'), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, '.build-cache/java-download-'));
const major = Number(process.argv.find(value => /^--major=/.test(value))?.split('=')[1] || 21);
const source = process.argv.includes('--official') ? 'official' : 'bmclapi';
const started = Date.now(), stages = [];
let lastLog = 0;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('实际下载检查超过 12 分钟')), 12 * 60 * 1000);
try {
  const executable = await ensureJava({}, directory, { source, concurrency: 6 }, {
    signal: controller.signal,
    update(stage) { stages.push({ elapsed: Math.round((Date.now() - started) / 1000), stage }); if (Date.now() - lastLog > 3000) { console.log(stage); lastLog = Date.now(); } }
  }, major);
  const version = await verifyJava(executable, major, controller.signal);
  const cached = await ensureJava({}, directory, { source }, { signal: controller.signal, update() {} }, major, { fetcher: () => { throw new Error('已安装环境不应重新下载'); } });
  assert.equal(cached, executable);
  const report = { ok: true, source, major, version, executable, seconds: Math.round((Date.now() - started) / 1000), stages };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, stages: undefined }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: false, error: error.stack, stages }, null, 2));
  throw error;
} finally { clearTimeout(timer); }
