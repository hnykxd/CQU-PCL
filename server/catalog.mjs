import { json, MODRINTH, MANIFEST, download, mapLimit, hashFile } from './network.mjs';
import { safePath } from './storage.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';

// `json` already prefers the BMCLAPI mirror and falls back to Mojang on failure.
export async function gameVersions(source) {
  return json(MANIFEST, { source });
}
export async function searchProjects(query = '', type = 'modpack', minecraft = '', loader = '') {
  const facets = [[`project_type:${type}`]];
  if (minecraft) facets.push([`versions:${minecraft}`]);
  if (loader && loader !== 'vanilla') facets.push([`categories:${loader}`]);
  const params = new URLSearchParams({ query, facets: JSON.stringify(facets), limit: '24', index: query ? 'relevance' : 'downloads' });
  return json(`${MODRINTH}/search?${params}`);
}
export async function projectVersions(id, minecraft = '', loader = '') {
  const params = new URLSearchParams();
  if (minecraft) params.set('game_versions', JSON.stringify([minecraft]));
  if (loader && loader !== 'vanilla') params.set('loaders', JSON.stringify([loader]));
  const versions = await json(`${MODRINTH}/project/${encodeURIComponent(id)}/version?${params}`);
  return versions.sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published));
}
export async function installMod(versionId, instance, gameDir, context, visited = new Set(), settings = {}) {
  if (visited.has(versionId)) return;
  visited.add(versionId);
  const version = await json(`${MODRINTH}/version/${encodeURIComponent(versionId)}`);
  const installed = instance.mods.find(m => m.projectId === version.project_id);
  if (installed?.versionId === version.id) return;
  if (!version.game_versions.includes(instance.minecraft) || !version.loaders.includes(instance.loader)) throw new Error('此 Mod 与当前 Minecraft 或加载器版本不兼容');
  for (const dependency of version.dependencies || []) if (dependency.dependency_type === 'required') {
    let next = dependency.version_id;
    if (!next && dependency.project_id) next = (await projectVersions(dependency.project_id, instance.minecraft, instance.loader)).find(v => v.version_type === 'release')?.id;
    if (!next) throw new Error('找不到适配此世界的必要 Mod 依赖');
    await installMod(next, instance, gameDir, context, visited, settings);
  }
  const file = version.files.find(f => f.primary) || version.files[0];
  if (!file || !file.filename.endsWith('.jar')) throw new Error('此项目没有可安装的 Java Mod 文件');
  context.update(`下载 Mod · ${version.name}`, 50);
  await download(file.url, safePath(gameDir, `mods/${file.filename}`), { hashes: file.hashes, signal: context.signal, size: file.size, tracker: context.tracker, connections: Math.min(4, settings.concurrency || 6),
    onProgress: (bytes, total) => context.update(`下载 Mod · ${version.name}`, total ? bytes / total * 95 : 50) });
  // Remove the replaced JAR only after its replacement passed checksum validation.
  if (installed && installed.fileName !== file.filename) await fs.rm(safePath(gameDir, `mods/${installed.fileName}`), { force: true });
  instance.mods = instance.mods.filter(m => m.projectId !== version.project_id);
  instance.mods.push({ projectId: version.project_id, versionId: version.id, name: version.name, versionNumber: version.version_number, fileName: file.filename, hashes: file.hashes, source: 'modrinth' });
}

export async function identifyPackMods(instance, gameDir) {
  const unidentified = instance.mods.filter(m => m.enabled !== false && !m.projectId && m.hashes?.sha1);
  if (!unidentified.length) return;
  const response = await json(`${MODRINTH}/version_files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: unidentified.map(m => m.hashes.sha1), algorithm: 'sha1' }) });
  for (const mod of unidentified) {
    const v = response[mod.hashes.sha1];
    if (v) Object.assign(mod, { projectId: v.project_id, versionId: v.id, name: v.name, versionNumber: v.version_number, source: 'modrinth' });
  }
}

export async function checkModUpdates(instance, gameDir) {
  await identifyPackMods(instance, gameDir);
  const updates = [];
  await mapLimit(instance.mods.filter(m => m.enabled !== false && m.projectId), 4, async mod => {
    const versions = await projectVersions(mod.projectId, instance.minecraft, instance.loader);
    const latest = versions.find(v => v.version_type === 'release') || versions[0];
    const current = versions.find(v => v.id === mod.versionId);
    if (latest && latest.id !== mod.versionId && (!current || Date.parse(latest.date_published) > Date.parse(current.date_published))) updates.push({ ...mod, latestId: latest.id, latestVersion: latest.version_number });
  });
  return updates;
}

export async function bedrockVersions() {
  const response = await fetch('https://www.minecraft.net/en-us/download/server/bedrock', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('基岩版官方下载页暂时无法连接，请使用官方入口');
  const html = await response.text();
  const matches = [...html.matchAll(/https:\/\/[^"\s<>]+\/bin-(win|linux)[^"\s<>]*\/bedrock-server-([\d.]+)\.zip/g)];
  const seen = new Set();
  return matches.map(m => ({ platform: m[1] === 'win' ? 'windows' : 'linux', version: m[2], url: m[0].replace(/&amp;/g, '&') })).filter(v => { const key = v.url; if (seen.has(key)) return false; seen.add(key); return true; });
}
