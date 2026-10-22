import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { parse } from 'smol-toml';
import { hashFile, mapLimit } from './network.mjs';

function metadata(file) {
  const zip = new AdmZip(file);
  const read = name => {
    const entry = zip.getEntry(name);
    if (!entry) return null;
    if (entry.header.size > 1024 ** 2) throw new Error('模组描述文件过大');
    return entry.getData().toString('utf8').replace(/^\uFEFF/, '');
  };
  const fabric = read('fabric.mod.json');
  if (fabric) { const data = JSON.parse(fabric); return { modId: data.id, name: data.name || data.id, versionNumber: data.version, loader: 'fabric' }; }
  const quilt = read('quilt.mod.json');
  if (quilt) { const data = JSON.parse(quilt).quilt_loader; return { modId: data.id, name: data.metadata?.name || data.id, versionNumber: data.version, loader: 'quilt' }; }
  for (const [descriptor, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    const text = read(descriptor); if (!text) continue;
    const mods = parse(text).mods; const data = Array.isArray(mods) ? mods[0] : null;
    if (!data) continue;
    let version = data.version;
    if (version === '${file.jarVersion}') {
      const manifest = read('META-INF/MANIFEST.MF')?.replace(/\r?\n /g, '');
      version = /^Implementation-Version:\s*(.+)$/mi.exec(manifest || '')?.[1]?.trim();
    }
    return { modId: data.modId, name: data.displayName || data.modId, versionNumber: version, loader };
  }
  const legacy = read('mcmod.info');
  if (legacy) { const data = JSON.parse(legacy); const mod = (Array.isArray(data) ? data : data.modList)?.[0]; if (mod) return { modId: mod.modid, name: mod.name, versionNumber: mod.version, loader: 'forge' }; }
  return {};
}

// Cache parsed metadata by file identity; disk remains the source of truth.
export class ModScanner {
  constructor() { this.cache = new Map(); }
  async scan(instance, gameDir) {
    const directory = path.join(gameDir, 'mods');
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    const files = entries.filter(entry => entry.isFile() && /\.jar(?:\.disabled)?$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    const previous = instance.mods || []; const inventory = [];
    await mapLimit(files, 4, async entry => {
      const file = path.join(directory, entry.name); const stat = await fs.stat(file);
      const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      let cached = this.cache.get(file);
      if (cached?.fingerprint !== fingerprint) {
        let info = {}, warning;
        try { info = metadata(file); if (!info.modId) warning = '未找到模组描述，按文件名显示'; } catch { warning = '无法读取模组描述，按文件名显示'; }
        const sha1 = await hashFile(file);
        cached = { fingerprint, info, warning, sha1 }; this.cache.set(file, cached);
      }
      const originalName = entry.name.replace(/\.disabled$/i, '');
      const recorded = previous.find(mod => mod.fileName === entry.name || mod.fileName === originalName || mod.fileName + '.disabled' === entry.name);
      const trusted = recorded?.hashes?.sha1 === cached.sha1;
      const info = Object.fromEntries(Object.entries(cached.info).filter(([, value]) => typeof value === 'string' && value));
      inventory.push({ ...(trusted ? recorded : {}), ...info, fileName: entry.name,
        name: info.name || (trusted && recorded.name) || originalName.replace(/\.jar$/i, ''),
        hashes: { ...(trusted ? recorded.hashes : {}), sha1: cached.sha1 }, source: trusted ? recorded.source || 'local' : 'local',
        enabled: !/\.disabled$/i.test(entry.name), recognized: Boolean(info.modId), ...(cached.warning ? { warning: cached.warning } : {}) });
    });
    inventory.sort((a, b) => a.fileName.localeCompare(b.fileName));
    const present = new Set(files.map(entry => path.join(directory, entry.name)));
    for (const file of this.cache.keys()) if (path.dirname(file) === directory && !present.has(file)) this.cache.delete(file);
    const changed = JSON.stringify(previous) !== JSON.stringify(inventory);
    instance.mods = inventory; return changed;
  }
}
