import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { safePath } from './storage.mjs';
import { download, json, mapLimit } from './network.mjs';

const MAX_EXPANDED = 4 * 1024 ** 3;
const FORBIDDEN = /(^|\/)(launcher_profiles\.json|launcher_accounts\.json)$|\.(exe|dll|bat|cmd|ps1|vbs|lnk)$/i;
export function inspectPack(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  let expanded = 0;
  if (entries.length > 50000) throw new Error('整合包文件数量过多');
  for (const entry of entries) {
    safePath(path.resolve('pack-check'), entry.entryName.replace(/\/$/, '') || 'empty');
    expanded += entry.header.size;
    if (expanded > MAX_EXPANDED || (entry.header.attr >>> 16 & 0xf000) === 0xa000) throw new Error('整合包过大或包含符号链接');
  }
  const mr = zip.getEntry('modrinth.index.json');
  const cf = zip.getEntry('manifest.json');
  const manifest = mr || cf;
  if (!manifest) throw new Error('未识别的整合包：需要 modrinth.index.json 或 CurseForge manifest.json');
  if (manifest.header.size > 8 * 1024 ** 2) throw new Error('整合包清单过大');
  const data = JSON.parse(manifest.getData().toString('utf8'));
  if (mr) {
    if (data.formatVersion !== 1 || data.game !== 'minecraft' || !data.dependencies?.minecraft || !Array.isArray(data.files)) throw new Error('无效的 Modrinth 整合包清单');
    const loaders = ['fabric-loader', 'quilt-loader', 'forge', 'neoforge'].filter(k => data.dependencies[k]);
    if (loaders.length > 1) throw new Error('整合包声明了多个不兼容的加载器');
    const key = loaders[0];
    for (const file of data.files) {
      safePath(path.resolve('pack-check'), file.path);
      if (FORBIDDEN.test(file.path) || !file.hashes?.sha1 || !file.hashes?.sha512 || !Array.isArray(file.downloads) || !file.downloads.length) throw new Error('整合包文件缺少校验值或包含可执行脚本');
    }
    return { zip, data, format: 'modrinth', name: data.name || 'Modrinth 整合包', version: data.versionId, minecraft: data.dependencies.minecraft, loader: key ? key.replace('-loader', '') : 'vanilla', loaderVersion: key ? data.dependencies[key] : '', fileCount: data.files.filter(f => f.env?.client !== 'unsupported').length };
  }
  if (data.manifestType !== 'minecraftModpack' || !data.minecraft?.version || !Array.isArray(data.files)) throw new Error('无效的 CurseForge 整合包清单');
  const loaderId = (data.minecraft.modLoaders?.find(l => l.primary) || data.minecraft.modLoaders?.[0])?.id || '';
  const match = /^(forge|fabric|quilt|neoforge)-(.+)$/.exec(loaderId);
  if (loaderId && !match) throw new Error(`暂不支持加载器 ${loaderId}`);
  if (data.overrides) safePath(path.resolve('pack-check'), data.overrides);
  return { zip, data, format: 'curseforge', name: data.name || 'CurseForge 整合包', version: data.version, minecraft: data.minecraft.version, loader: match?.[1] || 'vanilla', loaderVersion: match?.[2] || '', fileCount: data.files.length };
}

export function packSummary(pack) { const { name, version, minecraft, loader, loaderVersion, fileCount, format } = pack; return { name, version, minecraft, loader, loaderVersion, fileCount, format }; }

export async function installPackFiles(pack, gameDir, settings, context) {
  const { update, signal } = context;
  let files;
  if (pack.format === 'modrinth') files = pack.data.files.filter(f => f.env?.client !== 'unsupported').map(f => ({ ...f, urls: f.downloads }));
  else {
    if (!settings.curseforgeKey) throw new Error('此整合包需要 CurseForge API Key，请在设置中填写后重新安装');
    files = [];
    await mapLimit(pack.data.files, 4, async file => {
      const headers = { 'x-api-key': settings.curseforgeKey };
      const response = await json(`https://api.curseforge.com/v1/mods/${Number(file.projectID)}/files/${Number(file.fileID)}`, { headers });
      const f = response.data;
      let url = f.downloadUrl;
      if (!url) url = (await json(`https://api.curseforge.com/v1/mods/${Number(file.projectID)}/files/${Number(file.fileID)}/download-url`, { headers })).data;
      if (!url) throw new Error(`作者未允许第三方下载：${f.displayName}`);
      files.push({ path: `mods/${f.fileName}`, urls: [url], hashes: { sha1: f.hashes?.find(h => h.algo === 1)?.value }, headers });
    }, signal);
  }
  let done = 0;
  await mapLimit(files, settings.concurrency || 6, async file => {
    await download(file.urls, safePath(gameDir, file.path), { hashes: file.hashes, signal, headers: file.headers, size: file.fileSize, connections: Math.min(4, settings.concurrency || 6), tracker: context.tracker });
    done++; update(`下载整合包文件 · ${done}/${files.length}`, 75 + 22 * done / Math.max(1, files.length));
  }, signal);
  update('写入整合包配置', 98);
  const prefixes = pack.format === 'modrinth' ? ['overrides/', 'client-overrides/'] : [(pack.data.overrides || 'overrides') + '/'];
  for (const prefix of prefixes) for (const entry of pack.zip.getEntries()) {
    signal.throwIfAborted();
    if (!entry.entryName.startsWith(prefix) || entry.isDirectory) continue;
    const relative = entry.entryName.slice(prefix.length);
    if (FORBIDDEN.test(relative)) throw new Error(`整合包包含可执行脚本：${relative}`);
    const target = safePath(gameDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, entry.getData());
  }
  return files.filter(f => f.path.startsWith('mods/')).map(f => ({ fileName: path.basename(f.path), hashes: f.hashes, source: pack.format }));
}
