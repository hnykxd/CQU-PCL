import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { download, json, mirrorCandidates, request } from '../server/network.mjs';

const content = Buffer.from('streaming-download-content');
const hashes = { sha256: createHash('sha256').update(content).digest('hex') };
async function target(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-network-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return path.join(root, 'java.zip'); }
test('持续传输超过连接超时仍成功，只有停滞才超时', async t => {
  const file = await target(t);
  await download('https://example.com/java.zip', file, { hashes, headerTimeoutMs: 10, idleTimeoutMs: 100, fetcher: async () => {
    let index = 0;
    return new Response(new ReadableStream({ async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (index < content.length) controller.enqueue(content.subarray(index, ++index)); else controller.close();
    } }), { headers: { 'Content-Length': content.length } });
  } });
  assert.deepEqual(await fs.readFile(file), content);
});
test('停滞超时自动重试成功，临时文件被清理', async t => {
  const file = await target(t); let calls = 0;
  await download('https://example.com/java.zip', file, { hashes, idleTimeoutMs: 15, retryDelayMs: 0, fetcher: async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(content.subarray(0, 1)); } }));
    return new Response(content);
  } });
  assert.equal(calls, 2); assert.deepEqual(await fs.readFile(file), content);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['java.zip']);
});
test('重试中取消立即终止，超时错误说明具体下载主机', async t => {
  const file = await target(t); const controller = new AbortController(); let calls = 0;
  const fetching = download('https://example.com/java.zip', file, { hashes, idleTimeoutMs: 15, retryDelayMs: 1000, signal: controller.signal, fetcher: async () => { calls++; return new Response(new ReadableStream({})); } });
  const rejected = assert.rejects(fetching); setTimeout(() => controller.abort(), 40); await rejected; assert.equal(calls, 1);
  // Keep a ref'ed timer to model a live request while the idle watchdog runs.
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(download('https://example.com/java.zip', file, { attempts: 1, idleTimeoutMs: 15, fetcher: async () => new Response(new ReadableStream({})) }), /没有收到数据.*example.com/); }
  finally { clearInterval(keepAlive); }
});
test('重定向共享连接等待时限，不会每跳重新等待完整超时', async () => {
  let calls = 0;
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(request('https://example.com/first', { headerTimeoutMs: 50, fetcher: async (url, options) => {
      calls++;
      if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 35)); return new Response('', { status: 302, headers: { location: 'https://example.com/next' } }); }
      assert.ok(options.signal);
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } }), /连接等待超时/);
    assert.equal(calls, 2);
  } finally { clearInterval(keepAlive); }
});

test('元数据请求优先走镜像，镜像不可用才回退官方并缓存结果', async () => {
  const keepAlive = setInterval(() => {}, 100);
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push(url);
    assert.ok(options.signal === undefined || typeof options.signal === 'object');
    if (url.includes('bmclapi2.bangbang93.com')) return new Response('', { status: 502 });
    return new Response(JSON.stringify({ latest: { release: 'fixture-1.0' } }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const data = await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { source: 'bmclapi', fetcher });
    assert.deepEqual(data, { latest: { release: 'fixture-1.0' } });
    assert.deepEqual(seen, ['https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json']);
    seen.length = 0;
    // The official answer is cached, so only the mirror is probed again.
    assert.deepEqual(await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { source: 'bmclapi', fetcher }), { latest: { release: 'fixture-1.0' } });
    assert.deepEqual(seen, ['https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json']);
    assert.equal(mirrorCandidates('https://cdn.modrinth.com/file.jar', 'bmclapi').length, 1);
    await assert.rejects(request('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { source: 'bmclapi', fetcher: async () => new Response('', { status: 500 }) }), /下载服务返回/);
  } finally { clearInterval(keepAlive); }
});
