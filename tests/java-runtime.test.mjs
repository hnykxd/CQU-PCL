import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { ensureJava, JAVA_RUNTIME_INDEX } from '../server/java-runtime.mjs';

const digest = (bytes, algorithm = 'sha1') => createHash(algorithm).update(bytes).digest('hex');
const exe = Buffer.from('java-executable-fixture'), dll = Buffer.from('java-runtime-fixture');
const urls = { exe: 'https://piston-data.mojang.com/v1/objects/' + digest(exe) + '/java.exe', dll: 'https://piston-data.mojang.com/v1/objects/' + digest(dll) + '/jvm.dll' };
const manifest = Buffer.from(JSON.stringify({ files: {
  bin: { type: 'directory' }, 'bin/java.exe': { type: 'file', downloads: { raw: { url: urls.exe, sha1: digest(exe), size: exe.length } } },
  'bin/server/jvm.dll': { type: 'file', downloads: { raw: { url: urls.dll, sha1: digest(dll), size: dll.length } } }
} }));
const manifestUrl = 'https://piston-meta.mojang.com/v1/packages/' + digest(manifest) + '/manifest.json';
const index = { 'windows-x64': { 'java-runtime-delta': [{ version: { name: '21.0.7' }, manifest: { url: manifestUrl, sha1: digest(manifest) } }] } };
const reply = value => new Response(typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
function fixture(url) {
  const parsed = new URL(url);
  if (parsed.pathname === new URL(JAVA_RUNTIME_INDEX).pathname) return reply(index);
  if (parsed.pathname === new URL(manifestUrl).pathname) return reply(manifest);
  if (parsed.pathname === new URL(urls.exe).pathname) return reply(exe);
  if (parsed.pathname === new URL(urls.dll).pathname) return reply(dll);
  throw new Error('Unexpected URL: ' + url);
}
async function root(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-java-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
function context(controller = new AbortController()) { const stages = []; return { signal: controller.signal, update: text => stages.push(text), stages }; }
const options = { platform: 'win32', arch: 'x64', probe: async () => '21.0.7', headerTimeoutMs: 25, idleTimeoutMs: 50 };

test('Java 镜像优先、逐文件校验并验证后启用，完整环境再次安装无需联网', async t => {
  const directory = await root(t), calls = [], ctx = context();
  const java = await ensureJava({}, directory, { source: 'bmclapi', concurrency: 2 }, ctx, 21, { ...options, fetcher: async url => { calls.push(url); return fixture(url); } });
  assert.ok(calls.every(url => new URL(url).hostname === 'bmclapi2.bangbang93.com'));
  assert.deepEqual(await fs.readFile(java), exe);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(java), 'server/jvm.dll')), dll);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'runtime/java-21/.cqu-java.json'), 'utf8')).provider, 'mojang');
  assert.ok(ctx.stages.some(stage => stage.includes('MB')));
  assert.ok(ctx.stages.some(stage => stage.includes('验证')));
  assert.equal(await ensureJava({}, directory, { source: 'bmclapi' }, context(), 21, { ...options, fetcher: () => { throw new Error('Cache must not fetch'); } }), java);
});

test('Java 镜像元数据连接超时后立即切官方，后续文件跳过失败镜像', async t => {
  const directory = await root(t), calls = [], ctx = context();
  await ensureJava({}, directory, { source: 'bmclapi' }, ctx, 21, { ...options, fetcher: async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://bmclapi2')) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    return fixture(url);
  } });
  assert.equal(calls.filter(url => url.startsWith('https://bmclapi2')).length, 1);
  assert.equal(calls[1], JAVA_RUNTIME_INDEX);
  assert.ok(ctx.stages.some(stage => stage.includes('BMCLAPI超时') && stage.includes('换源')));
});

test('Java 镜像文件校验失败切官方；后续工作不再访问失败镜像', async t => {
  const directory = await root(t), calls = [], ctx = context();
  await ensureJava({}, directory, { source: 'bmclapi', concurrency: 2 }, ctx, 21, { ...options, fetcher: async url => {
    calls.push(url);
    if (url.startsWith('https://bmclapi2') && new URL(url).pathname === new URL(urls.exe).pathname) return reply('corrupt');
    return fixture(url);
  } });
  assert.ok(calls.includes(urls.exe));
  assert.ok(ctx.stages.some(stage => stage.includes('失败') && stage.includes('换源')));
  assert.ok(!calls.some(url => url.includes('adoptium')));
});

test('Java 清单 SHA1 校验失败时不会使用镜像返回的文件链接', async t => {
  const directory = await root(t), calls = [];
  await ensureJava({}, directory, { source: 'bmclapi' }, context(), 21, { ...options, fetcher: async url => {
    calls.push(url);
    if (url.startsWith('https://bmclapi2') && new URL(url).pathname === new URL(manifestUrl).pathname) return reply({ files: { 'bin/java.exe': { downloads: { raw: { url: 'https://example.com/evil' } } } } });
    return fixture(url);
  } });
  assert.ok(calls.includes(manifestUrl));
  assert.ok(!calls.some(url => url.includes('example.com')));
});

test('官方运行环境不可用时备用 Adoptium 校验解压，修复残缺目录并清理旧 staging', async t => {
  const directory = await root(t), calls = [], ctx = context();
  const zip = new AdmZip(); zip.addFile('jre/bin/java.exe', exe); zip.addFile('jre/bin/server/jvm.dll', dll); const archive = zip.toBuffer();
  await fs.mkdir(path.join(directory, 'runtime/java-21/bin'), { recursive: true });
  await fs.writeFile(path.join(directory, 'runtime/java-21/bin/java.exe'), 'broken');
  await fs.mkdir(path.join(directory, 'runtime/java-21.installing'), { recursive: true });
  await fs.writeFile(path.join(directory, 'runtime/java-21.installing/stale'), 'stale');
  const java = await ensureJava({}, directory, { source: 'bmclapi' }, ctx, 21, { ...options,
    probe: async file => { if ((await fs.readFile(file)).toString() === 'broken') throw new Error('Incomplete runtime'); return '21.0.7'; },
    fetcher: async url => { calls.push(url); if (url.includes('adoptium.net')) return reply([{ binary: { package: { link: 'https://github.com/fixture/java.zip', checksum: digest(archive, 'sha256') } } }]); if (url.includes('github.com')) return reply(archive); return new Response('', { status: 503 }); }
  });
  assert.deepEqual(await fs.readFile(java), exe);
  assert.equal(path.relative(directory, java), path.join('runtime/java-21/jre/bin/java.exe'));
  await assert.rejects(fs.access(path.join(directory, 'runtime/java-21/stale')));
  await assert.rejects(fs.access(path.join(directory, 'runtime/java-21.installing')));
  assert.ok(ctx.stages.some(stage => stage.includes('备用')));
});

test('Java 元数据等待可取消，取消不会启动备用来源或启用残缺目录', async t => {
  const directory = await root(t), controller = new AbortController(), calls = [];
  const result = ensureJava({}, directory, { source: 'bmclapi' }, context(controller), 21, { ...options, headerTimeoutMs: 2000, fetcher: async (url, init) => {
    calls.push(url); controller.abort(new Error('任务已取消')); init.signal.throwIfAborted();
  } });
  await assert.rejects(result, /任务已取消/);
  assert.equal(calls.length, 1);
  await assert.rejects(fs.access(path.join(directory, 'runtime/java-21')));
  await assert.rejects(fs.access(path.join(directory, 'runtime/java-21.installing')));
});

test('所有 Java 来源失败后显示错误且不残留假就绪环境', async t => {
  const directory = await root(t);
  await assert.rejects(ensureJava({}, directory, { source: 'official' }, context(), 21, { ...options, fetcher: async () => new Response('', { status: 503 }) }), /自动安装失败.*指定已有 Java/);
  await assert.rejects(fs.access(path.join(directory, 'runtime/java-21')));
  await assert.rejects(fs.access(path.join(directory, 'runtime/java-21.installing')));
});
