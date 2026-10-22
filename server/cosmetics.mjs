import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const inFlight = new Map();

export function skinPng(value) {
  if (typeof value !== 'string' || value.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('请选择有效的 PNG 皮肤文件');
  const data = Buffer.from(value, 'base64');
  if (data.length < 45 || data.length > 256 * 1024 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.toString('ascii', 12, 16) !== 'IHDR' || data.readUInt32BE(8) !== 13 || data.readUInt32BE(16) !== 64 || ![32, 64].includes(data.readUInt32BE(20))) throw new Error('皮肤必须是 64×64 或 64×32 的 PNG 文件（最大 256 KB）');
  return data;
}

export function textureUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || url.username || url.password || url.port || url.search || url.hash || !/^\/texture\/[a-f0-9]{32,64}$/i.test(url.pathname)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch { return null; }
}

export function profileAppearance(profile) {
  const normalize = (list, kind) => (Array.isArray(list) ? list : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const url = textureUrl(item.url);
    if (!url || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)) return [];
    return [{ id: item.id, url, active: item.state === 'ACTIVE', ...(kind === 'skins' ? { variant: item.variant === 'SLIM' ? 'slim' : 'classic' } : { name: String(item.alias || 'Minecraft 披风').slice(0, 80) }) }];
  });
  return { skins: normalize(profile.skins, 'skins'), capes: normalize(profile.capes, 'capes'), updatedAt: Date.now() };
}

export async function downloadTexture(root, account, kind, id, { fetcher = (...args) => fetch(...args) } = {}) {
  if (!['skins', 'capes'].includes(kind)) throw new Error('不支持的外观类型');
  const item = account?.[kind]?.find(texture => texture.id === id);
  const url = textureUrl(item?.url);
  if (!account || !/^[a-f0-9]{32}$/i.test(account.uuid) || !url) throw new Error('请先获取当前账户的皮肤与披风');
  const hash = new URL(url).pathname.split('/').pop();
  const directory = path.join(root, 'account-assets', account.uuid, kind);
  const file = path.join(directory, hash + '.png');
  try { await fs.access(file); } catch {
    if (inFlight.has(file)) { await inFlight.get(file); return { file, name: textureName(account, kind, hash), texture: item }; }
    const work = (async () => {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('外观下载暂时不可用，请稍后重试');
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > 2 * 1024 * 1024) throw new Error('外观文件超过大小限制'); chunks.push(Buffer.from(chunk)); }
      const data = Buffer.concat(chunks);
      const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (data.length < 33 || !data.subarray(0, 8).equals(signature) || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('外观服务未返回有效 PNG 文件');
      const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
      if (width < 1 || height < 1 || width > 1024 || height > 1024) throw new Error('外观文件尺寸不正确');
      await fs.mkdir(directory, { recursive: true });
      const temp = file + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temp, data); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }); }
    })();
    inFlight.set(file, work);
    try { await work; } finally { inFlight.delete(file); }
  }
  return { file, name: textureName(account, kind, hash), texture: item };
}

const textureName = (account, kind, hash) => `${String(account.name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16)}-${kind === 'skins' ? 'skin' : 'cape'}-${hash.slice(0, 8)}.png`;
