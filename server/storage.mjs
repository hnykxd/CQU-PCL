import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\x00-\x1f]/.test(relative) || relative.includes(':') || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error('整合包包含不安全的文件路径');
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('文件路径超出了世界目录');
  return target;
}

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

export async function createStore(root) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'launcher.json');
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('启动器配置损坏，请先备份 launcher.json 后修复');
    data = { settings: { source: 'bmclapi', memory: 4096, javaPath: '', playerName: 'CQU_Player', loginMode: 'offline', curseforgeKey: '', concurrency: 6 }, instances: [], selectedId: null };
    await atomicJson(file, data);
  }
  // Interrupted installs must never appear ready after restarting.
  if (!['offline', 'microsoft'].includes(data.settings.loginMode)) data.settings.loginMode = data.account ? 'microsoft' : 'offline';
  delete data.settings.clientId;
  for (const instance of data.instances) if (instance.status === 'installing') { instance.status = 'error'; instance.error = '上次安装被中断，可重新安装'; }
  let pending = Promise.resolve();
  const save = () => { const snapshot = structuredClone(data); pending = pending.then(() => atomicJson(file, snapshot)); return pending; };
  return {
    root, data, save,
    instance(id) { const item = data.instances.find(i => i.id === id); if (!item) throw new Error('世界不存在'); return item; },
    directory(id) { this.instance(id); return path.join(root, 'instances', id); },
    async add(input) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('世界名称须为 1–80 个字符');
      const instance = { id: randomUUID(), name: input.name.trim(), minecraft: input.minecraft, loader: input.loader || 'vanilla', loaderVersion: input.loaderVersion || '', edition: input.edition || 'java', status: 'installing', mods: [], createdAt: new Date().toISOString(), ...input };
      instance.id = randomUUID();
      this.data.instances.push(instance); this.data.selectedId = instance.id;
      for (const folder of ['game/saves', 'game/mods', 'game/config', 'game/resourcepacks', 'runtime']) await fs.mkdir(path.join(root, 'instances', instance.id, folder), { recursive: true });
      await save(); return instance;
    },
    publicState(jobs = []) {
      return { settings: { ...data.settings, curseforgeKey: data.settings.curseforgeKey ? '••••••••' : '' }, instances: data.instances.map(i => ({ ...i, directory: this.directory(i.id) })), selectedId: data.selectedId, jobs, root, account: data.account ? { name: data.account.name, uuid: data.account.uuid, expiresAt: data.account.expiresAt, skins: data.account.skins || [], capes: data.account.capes || [], updatedAt: data.account.updatedAt } : null };
    }
  };
}
