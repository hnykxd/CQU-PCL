import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { download } from '../server/network.mjs';
import { JobQueue } from '../server/jobs.mjs';
import { DownloadTracker } from '../server/download-tracker.mjs';

const content = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 251));
const hashes = { sha256: createHash('sha256').update(content).digest('hex') };
async function target(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-ranges-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'client.jar');
}
const parallelOptions = { hashes, size: content.length, parallelThreshold: 256, minSegmentSize: 128, connections: 4, retryDelayMs: 0 };
const rangeReply = (range, bytes = content, extra = {}) => {
  const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
  return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1, ETag: '"fixture"', ...extra } });
};

test('大文件使用多个同时活动的分段连接，合并校验且统计当前文件和接收字节', async t => {
  const file = await target(t); let active = 0, peak = 0; const ranges = []; let stats;
  const tracker = new DownloadTracker(value => { stats = value; });
  const fetcher = async (url, options) => {
    const range = new Headers(options.headers).get('range'); ranges.push(range);
    if (range === 'bytes=0-0') return rangeReply(range);
    assert.equal(new Headers(options.headers).get('if-range'), '"fixture"');
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return rangeReply(range);
  };
  await download('https://example.com/client.jar', file, { ...parallelOptions, fetcher, tracker });
  assert.equal(peak, 4); assert.equal(ranges.length, 5); assert.deepEqual(await fs.readFile(file), content);
  assert.equal(stats.currentFile, 'client.jar'); assert.equal(stats.downloadedBytes, content.length); assert.equal(stats.speedBytesPerSecond, 0);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['client.jar']);
});

test('服务器忽略 Range 时直接采用完整响应，不重复下载', async t => {
  const file = await target(t); let calls = 0;
  await download('https://example.com/client.jar', file, { ...parallelOptions, fetcher: async () => { calls++; return new Response(content, { headers: { 'Content-Length': content.length } }); } });
  assert.equal(calls, 1); assert.deepEqual(await fs.readFile(file), content);
});

test('下载源拒绝 Range 的 416 响应自动回退普通下载', async t => {
  const file = await target(t); let calls = 0;
  await download('https://example.com/client.jar', file, { ...parallelOptions, fetcher: async (url, options) => {
    calls++;
    return new Headers(options.headers).has('range') ? new Response(null, { status: 416 }) : new Response(content, { headers: { 'Content-Length': content.length } });
  } });
  assert.equal(calls, 2); assert.deepEqual(await fs.readFile(file), content);
});

test('分段响应无效时停止所有分段并回退普通下载，保留跨域凭据保护', async t => {
  const file = await target(t); const ranges = []; let leaked = false;
  const fetcher = async (url, options) => {
    const headers = new Headers(options.headers); const range = headers.get('range');
    if (url.includes('first.example.com')) return new Response(null, { status: 302, headers: { location: 'https://second.example.com/client.jar' } });
    leaked ||= headers.has('authorization') || headers.has('x-api-key'); ranges.push(range);
    if (range === 'bytes=0-0') return rangeReply(range);
    if (range) return rangeReply(range, content, { 'Content-Range': `bytes 0-255/${content.length}` });
    return new Response(content, { headers: { 'Content-Length': content.length } });
  };
  await download('https://first.example.com/client.jar', file, { ...parallelOptions, fetcher, headers: { Authorization: 'secret', 'x-api-key': 'private' } });
  assert.equal(leaked, false); assert.ok(ranges.includes(null)); assert.deepEqual(await fs.readFile(file), content);
});

test('单个分段暂时失败时只重试该段，完整文件仍通过校验', async t => {
  const file = await target(t); const calls = new Map();
  await download('https://example.com/client.jar', file, { ...parallelOptions, fetcher: async (url, options) => {
    const range = new Headers(options.headers).get('range'); calls.set(range, (calls.get(range) || 0) + 1);
    if (range === 'bytes=256-511' && calls.get(range) === 1) return new Response(null, { status: 503 });
    return rangeReply(range);
  } });
  assert.equal(calls.get('bytes=256-511'), 2); assert.equal(calls.get('bytes=512-767'), 1); assert.deepEqual(await fs.readFile(file), content);
});

test('取消分段下载等待所有写入结束，删除临时文件且不覆盖原文件', async t => {
  const file = await target(t); const original = Buffer.from('existing-file'); await fs.writeFile(file, original);
  const controller = new AbortController(); let started = 0;
  const fetching = download('https://example.com/client.jar', file, { ...parallelOptions, signal: controller.signal, fetcher: async (url, options) => {
    const range = new Headers(options.headers).get('range'); if (range === 'bytes=0-0') return rangeReply(range);
    started++;
    if (started === 4) setTimeout(() => controller.abort(new Error('cancelled')), 15);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
    return new Response(new ReadableStream({ start(target) { target.enqueue(content.subarray(start, start + 1)); } }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${content.length}` } });
  } });
  await assert.rejects(fetching); assert.equal(started, 4); assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['client.jar']);
});

test('分段校验失败切换官方源，不将错误文件提交到目标路径', async t => {
  const file = await target(t); const seen = [];
  await download('https://piston-data.mojang.com/client.jar', file, { ...parallelOptions, source: 'bmclapi', fetcher: async (url, options) => {
    seen.push(url); const range = new Headers(options.headers).get('range');
    return rangeReply(range, url.includes('bmclapi') ? Buffer.alloc(content.length, 0) : content);
  } });
  assert.ok(seen.some(url => url.includes('bmclapi'))); assert.ok(seen.some(url => url.includes('piston-data')));
  assert.deepEqual(await fs.readFile(file), content);
});

test('未知大小的大文件从响应获取长度后启用分段，小文件只下载一次', async t => {
  const file = await target(t); const seen = [];
  await download('https://example.com/client.jar', file, { ...parallelOptions, size: 0, fetcher: async (url, options) => {
    const range = new Headers(options.headers).get('range'); seen.push(range);
    return range ? rangeReply(range) : new Response(content, { headers: { 'Content-Length': content.length, 'Accept-Ranges': 'bytes' } });
  } });
  assert.equal(seen.length, 5); assert.equal(seen[0], null); assert.deepEqual(await fs.readFile(file), content);
});

test('网速按活动文件总量滚动统计，停滞后归零，重试不会产生负数', () => {
  let time = 0, stats; const tracker = new DownloadTracker(value => { stats = value; }, () => time);
  const a = tracker.start('one.jar'), b = tracker.start('two.jar');
  time = 1000; tracker.progress(a, 1000, 2000, 4); tracker.progress(b, 500, 1000, 1); tracker.report();
  assert.equal(stats.speedBytesPerSecond, 1500); assert.equal(stats.connections, 5); assert.equal(stats.activeFiles.length, 2);
  time = 2000; tracker.report(); time = 3500; tracker.report();
  assert.equal(stats.speedBytesPerSecond, 0);
  tracker.progress(a, 0, 2000); tracker.progress(a, 1000, 2000); tracker.report(); assert.equal(stats.downloadedBytes, 2500);
  tracker.finish(); assert.equal(stats.connections, 0); assert.equal(stats.speedBytesPerSecond, 0);
});

test('删除运行任务先取消并保留实例锁直到清理结束，等待任务删除不会执行', async () => {
  const queue = new JobQueue(); let release;
  const job = queue.add('running', 'world', async ({ signal }) => { await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); });
  await new Promise(resolve => setImmediate(resolve));
  let executed = false; const queued = queue.add('queued', 'other', async () => { executed = true; });
  await queue.remove(queued.id); assert.equal(queue.jobs.some(job => job.id === queued.id), false);
  const deleting = queue.remove(job.id); assert.equal(queue.busy('world'), true); assert.equal(queue.public()[0].status, 'running');
  release(); await deleting; await queue.tail;
  assert.equal(executed, false); assert.equal(queue.busy('world'), false); assert.deepEqual(queue.public(), []);
  assert.equal(queue.completions.size, 0);
});
