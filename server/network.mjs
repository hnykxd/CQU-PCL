import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';

export const USER_AGENT = 'CQUPCL/0.1.0 (Minecraft launcher; local desktop)';
export const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const MODRINTH = 'https://api.modrinth.com/v2';
export const BMCLAPI = 'https://bmclapi2.bangbang93.com';
// Mirror table from https://bmclapidoc.bangbang93.com — BMCLAPI keeps the same
// file layout as Mojang, only the maven roots differ per repository.
const MOJANG_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com'];
const ASSET_HOST = 'resources.download.minecraft.net';
const LIBRARY_HOST = 'libraries.minecraft.net';
const MAVEN_HOSTS = ['maven.minecraftforge.net', 'files.minecraftforge.net', 'maven.neoforged.net', 'maven.fabricmc.net', 'maven.quiltmc.org'];
const MAVEN_PREFIX = /^\/(?:maven|repository\/release|releases)\//;
const META_HOSTS = { 'meta.fabricmc.net': '/fabric-meta', 'meta.quiltmc.org': '/quilt-meta' };
const cache = new Map();
function timeoutError(host, phase) {
  const error = new Error(`${phase === 'headers' ? '连接等待超时' : '下载长时间没有收到数据'}（${host}），请检查网络后重试`);
  error.code = 'DOWNLOAD_TIMEOUT';
  return error;
}
const retryable = error => error.code === 'DOWNLOAD_TIMEOUT' || error.name === 'TimeoutError' ||
  error.message === 'fetch failed' || [408, 425, 429, 500, 502, 503, 504].includes(error.status) ||
  ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code);

// A large Java ZIP may take several minutes. Limit the wait for headers and
// periods with no incoming data, rather than the duration of the whole transfer.
async function fetchWithIdleTimeout(url, { signal, headerTimeoutMs = 60000, idleTimeoutMs = 120000, fetcher = (...args) => fetch(...args), ...options }) {
  const controller = new AbortController();
  const host = new URL(url).hostname;
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  let timer = setTimeout(() => controller.abort(timeoutError(host, 'headers')), headerTimeoutMs);
  timer.unref?.();
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  let response;
  try { response = await fetcher(url, { ...options, signal: controller.signal }); }
  catch (error) { cleanup(); throw controller.signal.aborted ? controller.signal.reason : error; }
  clearTimeout(timer);
  if (!response.body) { cleanup(); return response; }
  const reader = response.body.getReader();
  let finished = false;
  let streamController;
  const finish = () => { if (finished) return; finished = true; cleanup(); controller.signal.removeEventListener('abort', interrupted); };
  const interrupted = () => {
    if (finished) return;
    const reason = controller.signal.reason;
    finish(); streamController.error(reason); void reader.cancel(reason).catch(() => {});
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(timeoutError(host, 'idle')), idleTimeoutMs); timer.unref?.(); };
  const body = new ReadableStream({
    start(target) { streamController = target; controller.signal.addEventListener('abort', interrupted, { once: true }); arm(); if (controller.signal.aborted) interrupted(); },
    async pull(target) {
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done) { finish(); target.close(); }
        else { arm(); target.enqueue(chunk.value); }
      } catch (error) { if (!finished) { finish(); target.error(controller.signal.aborted ? controller.signal.reason : error); } }
    },
    async cancel(reason) { finish(); try { await reader.cancel(reason); } finally { controller.abort(reason); } }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function validateUrl(value) {
  const url = new URL(value);
  const h = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || h === 'localhost' || h.endsWith('.local') || h === '::1' || h.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(h)) throw new Error('下载链接必须是公网 HTTPS 地址');
  return url.href;
}

// Rewrites an official Mojang/Forge/Fabric URL onto the BMCLAPI mirror.
// Anything the mirror does not carry is returned untouched so it stays usable.
export function mirrorUrl(value, source) {
  if (source !== 'bmclapi') return value;
  const url = new URL(value);
  const { hostname, pathname } = url;
  if (MOJANG_HOSTS.includes(hostname)) return BMCLAPI + pathname;
  if (hostname === ASSET_HOST) return BMCLAPI + '/assets' + pathname;
  if (hostname === LIBRARY_HOST) return BMCLAPI + '/maven' + pathname;
  if (MAVEN_HOSTS.includes(hostname)) return BMCLAPI + '/maven' + pathname.replace(MAVEN_PREFIX, '/');
  if (META_HOSTS[hostname]) return BMCLAPI + META_HOSTS[hostname] + pathname;
  return value;
}

// Mirror first, official host second, so a dead mirror only costs one attempt.
export function mirrorCandidates(url, source) {
  return [...new Set([mirrorUrl(url, source), url])];
}

async function requestOnce(url, options) {
  options.signal?.throwIfAborted();
  let current = validateUrl(url);
  const headerDeadline = Date.now() + (options.headerTimeoutMs ?? 60000);
  for (let redirects = 0; redirects < 8; redirects++) {
    const remaining = headerDeadline - Date.now();
    if (remaining <= 0) throw timeoutError(new URL(current).hostname, 'headers');
    const response = await fetchWithIdleTimeout(current, { ...options, headerTimeoutMs: remaining, redirect: 'manual', headers: { 'User-Agent': USER_AGENT, ...Object.fromEntries(new Headers(options.headers)) } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = validateUrl(new URL(response.headers.get('location'), current).href);
      if (new URL(next).origin !== new URL(current).origin && options.headers) {
        const headers = new Headers(options.headers); headers.delete('x-api-key'); headers.delete('authorization');
        options = { ...options, headers: Object.fromEntries(headers) };
      }
      current = next; continue;
    }
    if (!response.ok) { await response.body?.cancel(); const error = new Error(`下载服务返回 ${response.status} (${new URL(current).hostname})`); error.status = response.status; throw error; }
    return response;
  }
  throw new Error('下载重定向次数过多');
}

// Requests the mirror when one is configured and transparently retries the
// official host, so callers never have to know which one answered.
export async function request(url, options = {}) {
  options.signal?.throwIfAborted();
  const { source, ...rest } = options;
  let last;
  for (const candidate of mirrorCandidates(url, source)) {
    try { return await requestOnce(candidate, rest); }
    catch (error) { if (rest.signal?.aborted) throw error; last = error; }
  }
  throw last;
}

export async function json(url, options = {}) {
  options.signal?.throwIfAborted();
  const { source, ...rest } = options;
  let last;
  for (const candidate of mirrorCandidates(url, source)) {
    const cacheable = !rest.method && !rest.headers;
    if (cacheable && cache.get(candidate)?.until > Date.now()) return cache.get(candidate).data;
    try {
      const response = await request(candidate, rest);
      const data = await response.json();
      if (cacheable) cache.set(candidate, { data, until: Date.now() + 120000 });
      return data;
    } catch (error) { if (rest.signal?.aborted) throw error; last = error; }
  }
  throw last;
}

export async function hashFile(file, algorithm = 'sha1') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function rangeError(target) { return Object.assign(new Error(`下载源未提供一致的分段数据：${path.basename(target)}`), { code: 'RANGE_UNSUPPORTED' }); }

async function downloadRanges(url, temp, target, total, count, validator, options, notify) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const handle = await fs.open(temp, 'w');
  try { await handle.truncate(total); } finally { await handle.close(); }
  const progress = Array(count).fill(0);
  let failure;
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    const start = Math.floor(total * index / count), end = Math.floor(total * (index + 1) / count) - 1;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          signal.throwIfAborted(); progress[index] = 0; notify(progress.reduce((a, b) => a + b, 0), total, count, true);
          const response = await request(url, { ...options, signal, headers: { ...Object.fromEntries(new Headers(options.headers)), Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity', ...(validator ? { 'If-Range': validator } : {}) } });
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${total}` ||
              (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
            await response.body?.cancel(); throw rangeError(target);
          }
          const meter = new Transform({ transform(chunk, encoding, callback) {
            progress[index] += chunk.length;
            if (progress[index] > end - start + 1) { callback(rangeError(target)); return; }
            notify(progress.reduce((a, b) => a + b, 0), total, count); callback(null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { flags: 'r+', start }), { signal });
          if (progress[index] !== end - start + 1) throw Object.assign(new Error(`文件分段下载不完整：${path.basename(target)}`), { code: 'DOWNLOAD_TIMEOUT' });
          break;
        } catch (error) {
          if (error.status === 416) throw rangeError(target);
          if (signal.aborted || !retryable(error) || attempt + 1 >= options.attempts) throw error;
          if (options.retryDelayMs) {
            const { setTimeout: delay } = await import('node:timers/promises');
            await delay(options.retryDelayMs * 2 ** attempt, undefined, { signal });
          }
        }
      }
    } catch (error) { if (!failure) { failure = error; controller.abort(error); } }
  }));
  if (failure) throw failure;
}

export async function download(urls, target, options = {}) {
  const transfer = options.tracker?.start(target);
  try { return await downloadFile(urls, target, { ...options, onProgress: (bytes, total, connections) => {
    options.tracker?.progress(transfer, bytes, total, connections); options.onProgress?.(bytes, total, connections);
  } }); }
  finally { if (transfer !== undefined) options.tracker.end(transfer); }
}

async function downloadFile(urls, target, { hashes = {}, source = 'official', signal, onProgress, onAttempt, onFailure, headers, attempts = 3, retryDelayMs = 1000, headerTimeoutMs, idleTimeoutMs, fetcher, size = 0, connections = 4, parallelThreshold = 4 * 1024 ** 2, minSegmentSize = 1024 ** 2 } = {}) {
  signal?.throwIfAborted();
  const algorithm = hashes.sha512 ? 'sha512' : hashes.sha256 ? 'sha256' : hashes.sha1 ? 'sha1' : null;
  if (algorithm) { try { if (await hashFile(target, algorithm) === hashes[algorithm]) return target; } catch {} }
  const candidates = [...new Set((Array.isArray(urls) ? urls : [urls]).flatMap(url => mirrorCandidates(url, source)))];
  await fs.mkdir(path.dirname(target), { recursive: true });
  let last;
  for (const url of candidates) for (let attempt = 0; attempt < attempts; attempt++) {
    const temp = `${target}.${randomUUID()}.part`;
    try {
      signal?.throwIfAborted();
      onAttempt?.({ url, attempt: attempt + 1, attempts });
      const limit = Math.max(1, Math.min(8, Math.floor(connections) || 1));
      const requestOptions = { signal, headers: { ...Object.fromEntries(new Headers(headers)), 'Accept-Encoding': 'identity' }, headerTimeoutMs, idleTimeoutMs, fetcher, attempts, retryDelayMs };
      const probe = limit > 1 && size >= parallelThreshold;
      let response;
      try { response = await request(url, { ...requestOptions, headers: { ...requestOptions.headers, ...(probe ? { Range: 'bytes=0-0' } : {}) } }); }
      catch (error) { if (signal?.aborted || !probe || error.status !== 416) throw error; response = await request(url, requestOptions); }
      const range = /^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range') || '');
      let total = response.status === 206 && range ? Number(range[1]) : Number(response.headers.get('content-length')) || 0;
      const etag = response.headers.get('etag');
      const validator = etag && !etag.startsWith('W/') ? etag : response.headers.get('last-modified');
      const count = Math.min(limit, Math.floor(total / Math.max(1, minSegmentSize)));
      let lastNotify = 0;
      const notify = (received, length, active = 1, force = false) => {
        if (force || Date.now() - lastNotify >= 150) { onProgress?.(received, length, active); lastNotify = Date.now(); }
      };
      const encoded = response.headers.get('content-encoding');
      if (count > 1 && Number.isSafeInteger(total) && total >= parallelThreshold && (!encoded || encoded === 'identity') &&
          (algorithm || validator) && ((probe && response.status === 206 && range) || response.headers.get('accept-ranges') === 'bytes')) {
        await response.body?.cancel(); notify(0, total, count, true);
        try {
          await downloadRanges(url, temp, target, total, count, validator, requestOptions, notify);
          if (algorithm && await hashFile(temp, algorithm) !== hashes[algorithm]) throw new Error(`文件校验失败：${path.basename(target)}`);
          if (size > 0 && Number.isSafeInteger(size) && total !== size) throw new Error(`文件大小不符：${path.basename(target)}`);
          signal?.throwIfAborted(); await fs.rename(temp, target); notify(total, total, count, true); return target;
        } catch (error) {
          if (signal?.aborted || error.code !== 'RANGE_UNSUPPORTED') throw error;
          await fs.rm(temp, { force: true });
          response = await request(url, requestOptions); total = Number(response.headers.get('content-length')) || 0;
        }
      } else if (response.status === 206) {
        await response.body?.cancel(); response = await request(url, requestOptions); total = Number(response.headers.get('content-length')) || 0;
      }
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw rangeError(target); }
      let received = 0;
      const hash = algorithm ? createHash(algorithm) : null;
      notify(0, total, 1, true);
      const meter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; hash?.update(chunk); notify(received, total); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp), { signal });
      if (total && received !== total) throw Object.assign(new Error(`文件下载不完整：${path.basename(target)}`), { code: 'DOWNLOAD_TIMEOUT' });
      if (algorithm && hash.digest('hex') !== hashes[algorithm]) throw new Error(`文件校验失败：${path.basename(target)}`);
      if (size > 0 && Number.isSafeInteger(size) && received !== size) throw new Error(`文件大小不符：${path.basename(target)}`);
      signal?.throwIfAborted(); await fs.rename(temp, target); notify(received, total, 1, true); return target;
    } catch (error) {
      last = error; await fs.rm(temp, { force: true });
      if (signal?.aborted) throw error;
      onFailure?.({ url, error, attempt: attempt + 1, attempts });
      if (!retryable(error) || attempt + 1 >= attempts) break;
      if (retryDelayMs) {
        const { setTimeout: delay } = await import('node:timers/promises');
        await delay(retryDelayMs * 2 ** attempt, undefined, { signal });
      }
    }
  }
  throw last || new Error('没有可用的下载地址');
}

export async function mapLimit(items, limit, callback, signal) {
  let index = 0, failure;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (index < items.length && !failure) {
      const i = index++; try { signal?.throwIfAborted(); await callback(items[i], i); } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
}
