import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { request, download, mirrorUrl, mapLimit, validateUrl } from './network.mjs';
import { safePath } from './storage.mjs';

export const JAVA_RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const components = { 8: 'jre-legacy', 16: 'java-runtime-alpha', 17: 'java-runtime-gamma', 21: 'java-runtime-delta', 25: 'java-runtime-epsilon' };
const mb = bytes => (bytes / 1024 ** 2).toFixed(1);
const sourceName = url => new URL(url).hostname === 'bmclapi2.bangbang93.com' ? 'BMCLAPI' : new URL(url).hostname === 'api.adoptium.net' ? 'Adoptium' : new URL(url).hostname === 'github.com' ? 'GitHub' : 'Minecraft 官方';
const javaMajor = value => { const match = String(value).match(/^(?:1\.)?(\d+)/); return match ? Number(match[1]) : 0; };

async function findJava(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) { const found = await findJava(path.join(directory, entry.name)); if (found) return found; }
    else if (entry.isFile() && entry.name === 'java.exe') return path.join(directory, entry.name);
  }
}

export async function verifyJava(executable, major, signal) {
  signal?.throwIfAborted();
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-version'], { windowsHide: true, signal });
    let text = '';
    child.stdout.on('data', chunk => { text = (text + chunk).slice(-8000); });
    child.stderr.on('data', chunk => { text = (text + chunk).slice(-8000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Java 启动验证超时')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error('Java 运行环境不完整，启动验证失败')); });
  });
  const version = output.match(/(?:openjdk|java) version "([^"]+)"/i)?.[1];
  if (javaMajor(version) !== major) throw new Error(`Java 版本不匹配，需要 Java ${major}`);
  return version;
}

// Use Minecraft's runtime files so BMCLAPI can mirror both metadata and binaries.
// A failed mirror is skipped for the rest of this install, rather than delaying
// every one of the hundreds of runtime files by another connection timeout.
export async function ensureJava(instance, directory, settings, context, major, options = {}) {
  const { signal, update } = context;
  const { fetcher, probe = verifyJava, platform = process.platform, arch = process.arch, headerTimeoutMs = 10000, idleTimeoutMs = 25000 } = options;
  signal.throwIfAborted();
  if (settings.javaPath) { await fs.access(settings.javaPath); return settings.javaPath; }
  if (!Number.isInteger(major) || major < 8 || major > 99) throw new Error('无效的 Java 主版本');
  const javaRoot = path.join(directory, 'runtime', `java-${major}`);
  try {
    const found = await findJava(javaRoot);
    if (found) { await probe(found, major, signal); return found; }
  } catch (error) { if (signal.aborted) throw error; }
  if (platform !== 'win32') throw new Error('此发行版的 Java 自动安装适用于 Windows，请在设置中指定 Java 路径');
  if (!['x64', 'arm64'].includes(arch)) throw new Error('此发行版的 Java 自动安装需要 Windows x64 或 ARM64');
  const staging = `${javaRoot}.installing`;
  let mirrorFailed = false;
  const candidates = url => [...new Set(settings.source === 'bmclapi' && !mirrorFailed ? [mirrorUrl(url, 'bmclapi'), url] : [url])];
  const failed = ({ url, error }) => {
    if (sourceName(url) === 'BMCLAPI') mirrorFailed = true;
    update(`Java ${major} · ${sourceName(url)}${error.code === 'DOWNLOAD_TIMEOUT' ? '超时' : '失败'}，正在换源`, 9);
  };
  async function metadata(url, label, sha1) {
    let last;
    for (const candidate of candidates(url)) {
      signal.throwIfAborted();
      const started = Date.now();
      const notify = () => update(`${label} · ${sourceName(candidate)} · 等待 ${Math.floor((Date.now() - started) / 1000)} 秒`, 9);
      notify(); const timer = setInterval(notify, 1000);
      try {
        const response = await request(candidate, { signal, fetcher, headerTimeoutMs, idleTimeoutMs });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (sha1 && createHash('sha1').update(bytes).digest('hex') !== sha1) throw new Error('Java 清单校验失败');
        return JSON.parse(bytes.toString('utf8'));
      } catch (error) { if (signal.aborted) throw error; last = error; failed({ url: candidate, error }); }
      finally { clearInterval(timer); }
    }
    throw last;
  }
  async function resetStaging() { await fs.rm(staging, { recursive: true, force: true }); await fs.mkdir(staging, { recursive: true }); }
  async function installMojang() {
    const component = components[major];
    if (!component) throw new Error(`Minecraft 未提供 Java ${major} 运行环境`);
    const index = await metadata(JAVA_RUNTIME_INDEX, `获取 Java ${major} 版本清单`);
    const target = index[`windows-${arch}`]?.[component]?.find(item => javaMajor(item.version?.name) === major);
    if (!target || !/^[a-f0-9]{40}$/i.test(target.manifest?.sha1)) throw new Error(`Minecraft 未提供此架构的 Java ${major}`);
    const manifest = await metadata(target.manifest.url, `获取 Java ${major} 文件清单`, target.manifest.sha1);
    if (!manifest.files || typeof manifest.files !== 'object') throw new Error('Java 文件清单无效');
    const files = [];
    for (const [name, entry] of Object.entries(manifest.files)) {
      const destination = safePath(staging, name);
      if (entry.type === 'directory') continue;
      const raw = entry.downloads?.raw;
      if (entry.type !== 'file' || !raw || !/^[a-f0-9]{40}$/i.test(raw.sha1) || !Number.isSafeInteger(raw.size) || raw.size < 0) throw new Error('Java 文件清单包含无效文件');
      validateUrl(raw.url); files.push({ destination, ...raw });
    }
    if (!files.some(file => file.destination === path.join(staging, 'bin', 'java.exe'))) throw new Error('Java 清单中未找到可执行文件');
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const progress = new Map();
    let complete = 0, lastNotice = 0;
    const active = new Map();
    const report = (force = false) => {
      if (!force && Date.now() - lastNotice < 250) return;
      lastNotice = Date.now();
      const received = [...progress.values()].reduce((a, b) => a + b, 0);
      const transfer = [...active.values()][0];
      const waiting = transfer ? ` · ${sourceName(transfer.url)} · ${Math.floor((Date.now() - transfer.started) / 1000)} 秒` : '';
      update(`下载 Java ${major} · ${mb(received)}/${mb(total)} MB · ${complete}/${files.length} 文件${waiting}`, 9 + (total ? received / total * 9 : 0));
    };
    const timer = setInterval(() => report(true), 1000);
    try {
      await mapLimit(files, Math.min(8, Math.max(2, settings.concurrency || 6)), async file => {
        // Compute candidates when a worker starts, after any earlier mirror failure.
        const transferOptions = { hashes: { sha1: file.sha1 }, signal, fetcher, attempts: 1, headerTimeoutMs, idleTimeoutMs, size: file.size, connections: Math.min(4, settings.concurrency || 6), tracker: context.tracker,
          onAttempt: ({ url }) => { progress.set(file.destination, 0); active.set(file.destination, { url, started: Date.now() }); report(true); },
          onFailure: event => { progress.set(file.destination, 0); failed(event); },
          onProgress: bytes => { progress.set(file.destination, bytes); report(); }
        };
        try { await download(candidates(file.url), file.destination, transferOptions); }
        catch (error) {
          signal.throwIfAborted();
          // Retry transient failures after trying the alternative, not before it.
          if (error.code !== 'DOWNLOAD_TIMEOUT' && error.message !== 'fetch failed' && ![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
          update(`Java ${major} · 重试官方文件 ${path.basename(file.destination)}`, 9);
          await download(file.url, file.destination, transferOptions);
        }
        active.delete(file.destination); progress.set(file.destination, file.size); complete++; report();
      }, signal);
    } finally { clearInterval(timer); }
    return { provider: 'mojang', version: target.version.name };
  }
  async function installAdoptium() {
    const architecture = arch === 'arm64' ? 'aarch64' : 'x64';
    let binary;
    for (const type of ['jre', 'jdk']) {
      const list = await metadata(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${architecture}&image_type=${type}&os=windows&vendor=eclipse`, `获取 Adoptium Java ${major}`);
      binary = list[0]?.binary;
      if (binary) break;
    }
    const pkg = binary?.package;
    if (!pkg || !/^[a-f0-9]{64}$/i.test(pkg.checksum)) throw new Error(`未找到 Windows Java ${major}`);
    const archive = path.join(staging, 'temurin.zip');
    let message = `连接 Java ${major} 备用下载源`, started = Date.now();
    const timer = setInterval(() => update(`${message} · ${Math.floor((Date.now() - started) / 1000)} 秒`, 9), 1000);
    try {
      await download(pkg.link, archive, { hashes: { sha256: pkg.checksum }, signal, fetcher, attempts: 1, headerTimeoutMs, idleTimeoutMs, size: pkg.size, connections: Math.min(4, settings.concurrency || 6), tracker: context.tracker,
        onAttempt: ({ url }) => { message = `连接 Java ${major} · ${sourceName(url)}`; started = Date.now(); update(message, 9); }, onFailure: failed,
        onProgress: (bytes, total) => { message = `下载 Java ${major} · ${mb(bytes)}${total ? '/' + mb(total) : ''} MB`; update(message, 9 + (total ? bytes / total * 9 : 0)); }
      });
    } finally { clearInterval(timer); }
    update(`解压 Java ${major} 运行环境`, 18);
    const zip = new AdmZip(archive);
    for (const entry of zip.getEntries()) {
      signal.throwIfAborted();
      const destination = safePath(staging, entry.entryName.replace(/\/$/, ''));
      if (entry.isDirectory) continue;
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, entry.getData());
    }
    await fs.rm(archive, { force: true });
    return { provider: 'adoptium' };
  }
  const errors = [];
  try {
    for (const install of [installMojang, installAdoptium]) {
      try {
        await resetStaging();
        const info = await install();
        update(`验证 Java ${major} 运行环境`, 18);
        const executable = await findJava(staging);
        if (!executable) throw new Error('Java 运行环境中未找到可执行文件');
        info.version = await probe(executable, major, signal);
        await fs.writeFile(path.join(staging, '.cqu-java.json'), JSON.stringify({ ...info, major }));
        signal.throwIfAborted();
        await fs.rm(javaRoot, { recursive: true, force: true });
        await fs.rename(staging, javaRoot);
        return path.join(javaRoot, path.relative(staging, executable));
      } catch (error) {
        if (signal.aborted) throw error;
        errors.push(error.message);
        update(`Java ${major} 当前来源失败，尝试备用来源`, 9);
      }
    }
    throw new Error(`Java ${major} 自动安装失败：${errors.join('；')}。可重试，或在设置中指定已有 Java 的 java.exe 路径`);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
