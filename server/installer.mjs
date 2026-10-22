import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import engine from './vendor/engine.cjs';
const { MinecraftFolder, Version, launch, createNodeInstallRuntime, executeInstallManifest, executeInstallWorkflow, resolveMinecraftJarInstallFile, resolveLibraryInstallFiles, resolveAssetMetadataInstallFiles, resolveAssetObjectInstallFiles, createFabricInstallWorkflow, createQuiltInstallWorkflow, createModernForgeInstallWorkflow, resolveForgeArtifactVersion, getForgeVersionList } = engine;
import { json, request, download, mapLimit, hashFile } from './network.mjs';
import { safePath } from './storage.mjs';
import { gameVersions } from './catalog.mjs';
import { ensureJava } from './java-runtime.mjs';
export { ensureJava } from './java-runtime.mjs';

export async function loaderVersions(loader, minecraft, source = 'official') {
  if (!/^[\w.+-]+$/.test(minecraft)) throw new Error('无效的 Minecraft 版本');
  if (loader === 'fabric' || loader === 'quilt') {
    const host = loader === 'fabric' ? 'meta.fabricmc.net' : 'meta.quiltmc.org';
    const apiVersion = loader === 'quilt' ? 'v3' : 'v2';
    const versions = await json(`https://${host}/${apiVersion}/versions/loader/${encodeURIComponent(minecraft)}`, { source });
    return versions.map(v => v.loader.version);
  }
  if (loader === 'forge') {
    const list = await getForgeVersionList({ minecraft, fetch: (url, options) => request(url, { ...options, source }) });
    return list.versions.map(v => v.version);
  }
  if (loader === 'neoforge') {
    const response = await request('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', { source });
    const xml = await response.text();
    const parts = minecraft.split('.');
    const prefix = `${parts[1]}.${parts[2] || '0'}.`;
    if (minecraft === '1.20.1') {
      const legacy = await request('https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml', { source });
      return [...(await legacy.text()).matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).filter(v => v.startsWith('1.20.1-')).map(v => v.slice(7)).reverse();
    }
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).filter(v => v.startsWith(prefix)).reverse();
  }
  return [];
}

export async function installGame(instance, directory, settings, context) {
  const { signal, update } = context;
  const folder = MinecraftFolder.from(path.join(directory, 'game'));
  update('获取 Minecraft 版本元数据', 2);
  const manifest = await gameVersions(settings.source);
  const meta = manifest.versions.find(v => v.id === instance.minecraft);
  if (!meta) throw new Error(`Minecraft ${instance.minecraft} 不在官方版本列表中`);
  const versionJson = safePath(folder.root, `versions/${instance.minecraft}/${instance.minecraft}.json`);
  await download(meta.url, versionJson, { hashes: { sha1: meta.sha1 }, source: settings.source, signal, tracker: context.tracker });
  let resolved = await Version.parse(folder, instance.minecraft);
  const javaMajor = resolved.javaVersion?.majorVersion || 8;
  const javaPath = await ensureJava(instance, directory, settings, context, javaMajor);
  instance.javaPath = settings.javaPath ? undefined : path.relative(directory, javaPath);
  let low = 20, high = 35, stage = '下载游戏文件';
  const runtime = createNodeInstallRuntime({ signal, checksum: hashFile,
    download: async files => {
      let complete = 0;
      await mapLimit(files, settings.concurrency || 6, async file => {
        // Upgrade archival Maven URLs to HTTPS before selecting mirrors.
        const urls = file.urls.map(u => u.replace(/^http:\/\//, 'https://'));
        await download(urls, file.path, { hashes: file.checksum ? { [file.checksum.algorithm]: file.checksum.value } : {}, source: settings.source, signal,
          size: file.size, connections: Math.min(4, settings.concurrency || 6), tracker: context.tracker,
          onProgress: (bytes, total) => update(`${stage} · ${complete}/${files.length}`, low + (high - low) * (complete + (total ? bytes / total : 0)) / Math.max(1, files.length)) });
        complete++; update(`${stage} · ${complete}/${files.length}`, low + (high - low) * complete / Math.max(1, files.length));
      }, signal);
    },
    runJava: async command => {
      signal.throwIfAborted(); update('运行加载器安装处理器', 48);
      await new Promise((resolve, reject) => {
        const proc = spawn(command.executable, command.args, { cwd: command.cwd, env: command.env ? { ...process.env, ...command.env } : process.env, windowsHide: true, signal });
        let stderr = ''; proc.stdout?.resume(); proc.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
        proc.once('error', reject); proc.once('exit', code => code === 0 ? resolve() : reject(new Error(`加载器安装失败 (${code})：${stderr.slice(-1200)}`)));
      });
    }
  });
  const executeFiles = async files => executeInstallManifest({ schemaVersion: 1, tasks: [{ id: stage, type: 'files', files: files.filter(Boolean) }] }, runtime, { signal, attempts: 2 });
  await executeFiles([resolveMinecraftJarInstallFile(resolved), ...resolveLibraryInstallFiles(resolved.libraries, folder), ...resolveAssetMetadataInstallFiles(resolved, folder)]);
  instance.launchVersion = instance.minecraft;
  if (instance.loader !== 'vanilla') {
    low = 36; high = 52; stage = `安装 ${instance.loader}`;
    const options = { minecraftVersion: instance.minecraft, version: instance.loaderVersion, minecraft: folder, side: 'client', fetch: (url, init) => request(url, { ...init, signal, source: settings.source }), signal };
    if (instance.loader === 'fabric' || instance.loader === 'quilt') {
      const workflow = instance.loader === 'fabric' ? createFabricInstallWorkflow(options) : createQuiltInstallWorkflow(options);
      instance.launchVersion = await executeInstallWorkflow(workflow, runtime, { signal });
    } else {
      const neo = instance.loader === 'neoforge';
      const neoLegacy = neo && instance.minecraft === '1.20.1';
      const artifact = neo && !neoLegacy ? instance.loaderVersion : resolveForgeArtifactVersion(instance.minecraft, instance.loaderVersion);
      const base = neo ? `https://maven.neoforged.net/releases/net/neoforged/${neoLegacy ? 'forge' : 'neoforge'}` : 'https://maven.minecraftforge.net/net/minecraftforge/forge';
      const filename = `${neo && !neoLegacy ? 'neoforge' : 'forge'}-${artifact}-installer.jar`;
      const url = `${base}/${artifact}/${filename}`;
      let checksum;
      try { checksum = { algorithm: 'sha1', value: (await (await request(url + '.sha1', { source: settings.source })).text()).trim().split(/\s/)[0] }; } catch {}
      const result = await executeInstallWorkflow(createModernForgeInstallWorkflow({ id: instance.loader, minecraft: folder, minecraftVersion: instance.minecraft, artifactVersion: artifact, installer: { path: path.join(directory, 'runtime', filename), urls: [url], checksum, validator: 'zip' }, java: javaPath, installOptions: { side: 'client', java: javaPath }, side: 'client' }), runtime, { signal });
      instance.launchVersion = result.version;
    }
    resolved = await Version.parse(folder, instance.launchVersion);
    low = 53; high = 58; stage = '下载加载器运行库';
    await executeFiles(resolveLibraryInstallFiles(resolved.libraries, folder));
  }
  low = 59; high = 74; stage = '下载游戏资源';
  await executeFiles(await resolveAssetObjectInstallFiles(resolved, folder));
  // Old asset indexes require additional virtual/resource directory layouts.
  if (resolved.assetIndex) {
    const assetIndex = JSON.parse(await fs.readFile(path.join(folder.root, 'assets', 'indexes', resolved.assets + '.json'), 'utf8'));
    if (assetIndex.virtual || assetIndex.map_to_resources) for (const [name, object] of Object.entries(assetIndex.objects)) {
      signal.throwIfAborted();
      const target = safePath(assetIndex.map_to_resources ? path.join(folder.root, 'resources') : path.join(folder.root, 'assets', 'virtual', resolved.assets), name);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(folder.getAsset(object.hash), target);
    }
  }
  return instance;
}

export async function launchInstance(instance, directory, settings, account) {
  if (instance.edition !== 'java') throw new Error('服务端 ZIP 已下载，请打开世界目录并按官方说明启动');
  if (instance.status !== 'ready') throw new Error('世界安装尚未完成');
  const java = settings.javaPath || (instance.javaPath && (path.isAbsolute(instance.javaPath) ? instance.javaPath : path.join(directory, instance.javaPath)));
  if (!java) throw new Error('未找到 Java，请重新安装或在设置中指定 Java 路径');
  const game = path.join(directory, 'game');
  const name = account?.name || settings.playerName;
  const offline = (await import('node:crypto')).createHash('md5').update(`OfflinePlayer:${name}`).digest();
  offline[6] = (offline[6] & 0x0f) | 0x30; offline[8] = (offline[8] & 0x3f) | 0x80;
  const proc = await launch({ gamePath: game, resourcePath: game, javaPath: java, version: instance.launchVersion, gameProfile: { name, id: account?.uuid || offline.toString('hex') }, accessToken: account?.accessToken || '', launcherName: 'CQU PCL', launcherBrand: 'CQU', maxMemory: settings.memory, minMemory: Math.min(1024, settings.memory), extraExecOption: { windowsHide: true } });
  const logPath = path.join(directory, 'launcher.log');
  const redact = text => account?.accessToken ? String(text).replaceAll(account.accessToken, '[REDACTED]') : String(text);
  await fs.writeFile(logPath, `${new Date().toISOString()} 启动 ${instance.name}\n`);
  proc.stdout?.on('data', chunk => fs.appendFile(logPath, redact(chunk)).catch(() => {}));
  proc.stderr?.on('data', chunk => fs.appendFile(logPath, redact(chunk)).catch(() => {}));
  proc.on('error', error => fs.appendFile(logPath, redact(`\n${error.message}`)).catch(() => {}));
  return proc;
}
