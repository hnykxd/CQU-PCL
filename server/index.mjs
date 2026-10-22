import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './storage.mjs';
import { JobQueue } from './jobs.mjs';
import { json, download, MODRINTH } from './network.mjs';
import { inspectPack, packSummary, installPackFiles } from './packs.mjs';
import { gameVersions, searchProjects, projectVersions, installMod, checkModUpdates, bedrockVersions } from './catalog.mjs';
import { installGame, launchInstance, loaderVersions } from './installer.mjs';
import { createAuthService, resolveLaunchAccount } from './auth.mjs';
import { downloadTexture, skinPng } from './cosmetics.mjs';
import { ModScanner } from './mods.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function createServer({ root = process.env.CQU_PCL_DATA || path.join(projectRoot, '.cqu-pcl'), apiToken, openPath, onAccountBound, protectSecret = value => value, revealSecret = value => value, auth = createAuthService(), textureDownloader = downloadTexture } = {}) {
  const store = await createStore(root);
  const jobs = new JobQueue(); const app = express(); const clients = new Set(); const running = new Map(); const prepared = new Map();
  const scanner = new ModScanner(); let scanning;
  const scanMods = () => {
    if (scanning) return scanning;
    scanning = (async () => {
      let changed = false;
      for (const instance of store.data.instances) if (instance.edition === 'java' && instance.status !== 'installing' && !jobs.busy(instance.id)) {
        changed = await scanner.scan(instance, path.join(store.directory(instance.id), 'game')) || changed;
      }
      if (changed) { await store.save(); broadcast(); }
    })().finally(() => { scanning = null; });
    return scanning;
  };
  let authRevision = 0, authFlowId = null;
  let accountRevision = 0;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) return res.status(403).json({ error: '仅允许本机访问' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: '不允许跨来源请求' });
    if (apiToken && req.headers.authorization !== `Bearer ${apiToken}`) return res.status(401).json({ error: '原生客户端身份验证失败' });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', express.json({ limit: '1mb' }));
  const snapshot = () => {
    const state = store.publicState(jobs.public());
    return { ...state, instances: state.instances.map(instance => ({ ...instance, running: running.has(instance.id) })), microsoftLogin: auth.configuration() };
  };
  let scheduled;
  const broadcast = () => { if (scheduled) return; scheduled = setTimeout(() => { scheduled = null; const message = `data: ${JSON.stringify(snapshot())}\n\n`; for (const client of clients) client.write(message); }, 120); };
  jobs.on('change', broadcast);
  const guard = id => { store.instance(id); if (jobs.busy(id) || running.has(id)) throw new Error('世界正在安装或运行，请等待结束'); };
  const protectAccount = account => account ? { ...account, accessToken: protectSecret(account.accessToken) } : null;
  const revealAccount = () => store.data.account ? { ...store.data.account, accessToken: revealSecret(store.data.account.accessToken) } : null;
  const settings = () => ({ ...store.data.settings, curseforgeKey: revealSecret(store.data.settings.curseforgeKey) });
  async function queueInstall(instance) {
    instance.status = 'installing'; delete instance.error; await store.save();
    return jobs.add(`安装 ${instance.name}`, instance.id, async context => {
      try {
        await installGame(instance, store.directory(instance.id), settings(), context);
        if (instance.packPath) {
          const pack = inspectPack(await fs.readFile(path.join(store.directory(instance.id), 'pack.zip')));
          instance.mods = await installPackFiles(pack, path.join(store.directory(instance.id), 'game'), settings(), context);
        }
        context.signal.throwIfAborted(); instance.status = 'ready'; await store.save();
      } catch (error) { instance.status = 'error'; instance.error = context.signal.aborted ? '安装已取消，可重试' : error.message; await store.save(); throw error; }
    });
  }
  async function addPack(pack, buffer, name, project) {
    if (pack.format === 'curseforge' && !store.data.settings.curseforgeKey) throw new Error('此整合包需要 CurseForge API Key，请先在设置填写');
    const instance = await store.add({ name: name || pack.name, minecraft: pack.minecraft, loader: pack.loader, loaderVersion: pack.loaderVersion, edition: 'java', pack: { ...packSummary(pack), ...project } });
    instance.packPath = 'pack.zip';
    await fs.writeFile(path.join(store.directory(instance.id), instance.packPath), buffer); await store.save(); return instance;
  }
  app.get('/api/state', async (req, res) => { await scanMods(); res.json(snapshot()); });
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    clients.add(res); res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
  });
  app.get('/api/catalog/versions', async (req, res) => res.json(await gameVersions(store.data.settings.source)));
  app.get('/api/catalog/loaders', async (req, res) => res.json({ versions: await loaderVersions(String(req.query.loader), String(req.query.minecraft), store.data.settings.source) }));
  app.get('/api/catalog/search', async (req, res) => {
    const type = req.query.type === 'mod' ? 'mod' : 'modpack';
    res.json(await searchProjects(String(req.query.query || ''), type, String(req.query.minecraft || ''), String(req.query.loader || '')));
  });
  app.get('/api/catalog/projects/:id/versions', async (req, res) => res.json({ versions: await projectVersions(req.params.id, String(req.query.minecraft || ''), String(req.query.loader || '')) }));
  app.get('/api/catalog/bedrock', async (req, res) => res.json({ versions: await bedrockVersions() }));
  app.post('/api/selected', async (req, res) => { store.instance(req.body.id); store.data.selectedId = req.body.id; await store.save(); broadcast(); res.json({ ok: true }); });
  app.patch('/api/settings', async (req, res) => {
    const input = { ...store.data.settings, ...req.body };
    if (!['official', 'bmclapi'].includes(input.source) || !Number.isInteger(input.memory) || input.memory < 512 || input.memory > 32768 || ![2, 4, 6, 8, 12].includes(input.concurrency)) throw new Error('无效的下载源或运行设置');
    if (!/^[A-Za-z0-9_]{1,16}$/.test(input.playerName)) throw new Error('玩家名称须为 1–16 位英文字母、数字或下划线');
    if (!['offline', 'microsoft'].includes(input.loginMode)) throw new Error('请选择正版登录或离线登录');
    if (input.loginMode === 'offline') { authRevision++; authFlowId = null; auth.close(); }
    const next = { source: input.source, memory: input.memory, concurrency: input.concurrency, playerName: input.playerName, loginMode: input.loginMode, javaPath: String(input.javaPath || ''), curseforgeKey: !Object.hasOwn(req.body, 'curseforgeKey') || input.curseforgeKey === '••••••••' ? store.data.settings.curseforgeKey : protectSecret(String(input.curseforgeKey || '')) };
    store.data.settings = next; await store.save(); broadcast(); res.json({ ok: true });
  });
  app.post('/api/instances', async (req, res) => {
    const { name, minecraft, loader = 'vanilla', loaderVersion = '' } = req.body;
    if (!/^[\w.+-]+$/.test(minecraft) || !['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loader) || (loader !== 'vanilla' && !/^[\w.+-]+$/.test(loaderVersion))) throw new Error('无效的游戏或加载器版本');
    const manifest = await gameVersions(store.data.settings.source);
    if (!manifest.versions.some(v => v.id === minecraft)) throw new Error('该版本不在官方版本列表中');
    const instance = await store.add({ name, minecraft, loader, loaderVersion, edition: 'java' });
    const job = await queueInstall(instance); res.status(202).json({ instance, job });
  });
  app.patch('/api/instances/:id', async (req, res) => {
    const instance = store.instance(req.params.id); if (!req.body.name?.trim() || req.body.name.length > 80) throw new Error('无效的世界名称');
    instance.name = req.body.name.trim(); await store.save(); broadcast(); res.json({ ok: true });
  });
  app.delete('/api/instances/:id', async (req, res) => {
    guard(req.params.id); const target = store.directory(req.params.id);
    const base = await fs.realpath(path.join(store.root, 'instances')); const resolved = await fs.realpath(target);
    const relative = path.relative(base, resolved);
    if (relative !== req.params.id || path.isAbsolute(relative)) throw new Error('世界目录路径异常，已停止删除');
    await fs.rm(resolved, { recursive: true }); store.data.instances = store.data.instances.filter(i => i.id !== req.params.id);
    if (store.data.selectedId === req.params.id) store.data.selectedId = store.data.instances[0]?.id || null;
    await store.save(); broadcast(); res.json({ ok: true });
  });
  app.post('/api/instances/:id/retry', async (req, res) => { guard(req.params.id); const instance = store.instance(req.params.id); if (instance.edition !== 'java') throw new Error('请在下载中心重新下载服务端'); const job = await queueInstall(instance); res.status(202).json({ job }); });
  app.post('/api/instances/:id/open', async (req, res) => { const target = store.directory(req.params.id); await fs.access(target); if (!openPath) throw new Error('系统目录打开服务不可用，请复制目录路径'); await openPath(target); res.json({ ok: true }); });
  app.post('/api/instances/:id/mods/scan', async (req, res) => { guard(req.params.id); const instance = store.instance(req.params.id); await scanner.scan(instance, path.join(store.directory(instance.id), 'game')); await store.save(); broadcast(); res.json({ mods: instance.mods }); });
  app.get('/api/instances/:id/logs', async (req, res) => { let text = ''; try { text = (await fs.readFile(path.join(store.directory(req.params.id), 'launcher.log'), 'utf8')).slice(-200000); } catch {} res.json({ text }); });
  app.post('/api/instances/:id/launch', async (req, res) => {
    guard(req.params.id); const instance = store.instance(req.params.id);
    const revision = accountRevision;
    const result = await resolveLaunchAccount(store.data.settings, revealAccount(), revealSecret(store.data.refreshToken), auth.refreshAccount);
    if (revision !== accountRevision) throw new Error('账户已更改，请重新启动游戏');
    if (result.refreshToken) {
      store.data.account = protectAccount(result.account); store.data.refreshToken = protectSecret(result.refreshToken);
      await store.save();
    }
    const proc = await launchInstance(instance, store.directory(instance.id), settings(), result.account); running.set(instance.id, proc);
    proc.once('exit', code => { running.delete(instance.id); if (code) instance.lastExitCode = code; broadcast(); });
    proc.once('error', () => { running.delete(instance.id); broadcast(); });
    instance.lastPlayed = new Date().toISOString(); await store.save(); broadcast(); res.json({ ok: true, pid: proc.pid });
  });
  app.post('/api/packs/inspect', express.raw({ type: 'application/octet-stream', limit: '512mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new Error('请上传整合包文件');
    const pack = inspectPack(req.body); const token = randomUUID();
    // Keep temporary imports on disk, with an expiry, rather than retaining ZIP buffers.
    const tempDir = path.join(store.root, 'imports'); await fs.mkdir(tempDir, { recursive: true });
    for (const [oldToken, value] of prepared) if (value.expires < Date.now()) { await fs.rm(value.file, { force: true }); prepared.delete(oldToken); }
    const file = path.join(tempDir, `${token}.zip`); await fs.writeFile(file, req.body); prepared.set(token, { file, expires: Date.now() + 3600000 });
    res.json({ token, ...packSummary(pack) });
  });
  app.post('/api/packs/install', async (req, res) => {
    const item = prepared.get(req.body.token); if (!item || item.expires < Date.now()) throw new Error('导入信息已过期，请重新选择文件');
    const buffer = await fs.readFile(item.file); const pack = inspectPack(buffer); const instance = await addPack(pack, buffer, req.body.name);
    const job = await queueInstall(instance); prepared.delete(req.body.token); await fs.rm(item.file, { force: true }); res.status(202).json({ instance, job });
  });
  app.post('/api/catalog/packs/install', async (req, res) => {
    const version = await json(`${MODRINTH}/version/${encodeURIComponent(req.body.versionId)}`);
    const file = version.files.find(f => f.primary) || version.files[0];
    if (!file?.filename.endsWith('.mrpack')) throw new Error('此项目版本没有 .mrpack 整合包');
    const job = jobs.add(`下载整合包 ${String(req.body.name || version.name).slice(0, 80)}`, null, async context => {
      const temp = path.join(store.root, 'imports', `${context.job.id}.mrpack`); let instance;
      try {
        await download(file.url, temp, { hashes: file.hashes, signal: context.signal, size: file.size, tracker: context.tracker, connections: Math.min(4, settings().concurrency || 6), onProgress: (bytes, total) => context.update('下载整合包清单', total ? bytes / total * 5 : 2) });
        const buffer = await fs.readFile(temp); const pack = inspectPack(buffer);
        instance = await addPack(pack, buffer, String(req.body.name || pack.name).slice(0, 80), { projectId: version.project_id, versionId: version.id }); context.job.instanceId = instance.id;
        await installGame(instance, store.directory(instance.id), settings(), context);
        instance.mods = await installPackFiles(pack, path.join(store.directory(instance.id), 'game'), settings(), context);
        context.signal.throwIfAborted(); instance.status = 'ready'; await store.save();
      } catch (error) { if (instance) { instance.status = 'error'; instance.error = error.message; await store.save(); } throw error; }
      finally { await fs.rm(temp, { force: true }); }
    }); res.status(202).json({ job });
  });
  app.post('/api/instances/:id/mods/install', async (req, res) => {
    guard(req.params.id); const instance = store.instance(req.params.id); if (instance.status !== 'ready') throw new Error('请先完整安装此世界');
    const job = jobs.add('安装 / 更新模组', instance.id, async context => { try { await scanner.scan(instance, path.join(store.directory(instance.id), 'game')); await installMod(req.body.versionId, instance, path.join(store.directory(instance.id), 'game'), context, new Set(), settings()); } finally { await store.save(); } }); res.status(202).json({ job });
  });
  app.get('/api/instances/:id/updates', async (req, res) => {
    guard(req.params.id); const instance = store.instance(req.params.id); await scanner.scan(instance, path.join(store.directory(instance.id), 'game')); const mods = await checkModUpdates(instance, path.join(store.directory(instance.id), 'game'));
    let pack = null;
    if (instance.pack?.projectId) { const versions = await projectVersions(instance.pack.projectId); const latest = versions.find(v => v.version_type === 'release') || versions[0]; const current = versions.find(v => v.id === instance.pack.versionId); if (latest?.id !== instance.pack.versionId && (!current || Date.parse(latest.date_published) > Date.parse(current.date_published))) pack = latest; }
    await store.save(); res.json({ mods, pack });
  });
  app.post('/api/jobs/:id/cancel', async (req, res) => { const job = jobs.jobs.find(j => j.id === req.params.id); const queued = job?.status === 'queued'; jobs.cancel(req.params.id); if (queued && job.instanceId) { const instance = store.instance(job.instanceId); if (instance.status === 'installing') { instance.status = 'error'; instance.error = '安装已取消，可重试'; await store.save(); } } broadcast(); res.json({ ok: true }); });
  app.delete('/api/jobs/:id', async (req, res) => {
    const job = jobs.jobs.find(j => j.id === req.params.id); const queued = job?.status === 'queued';
    await jobs.remove(req.params.id);
    if (queued && job.instanceId) { const instance = store.instance(job.instanceId); if (instance.status === 'installing') { instance.status = 'error'; instance.error = '安装已取消，可重试'; await store.save(); } }
    broadcast(); res.json({ ok: true });
  });
  app.post('/api/bedrock/install', async (req, res) => {
    const versions = await bedrockVersions(); const entry = versions.find(v => v.url === req.body.url); if (!entry) throw new Error('该地址不在基岩版官方下载列表中');
    const instance = await store.add({ name: `Bedrock Server ${entry.version} (${entry.platform})`, minecraft: entry.version, loader: 'vanilla', edition: 'bedrock-server' });
    const job = jobs.add(`下载 ${instance.name}`, instance.id, async context => { try { await download(entry.url, path.join(store.directory(instance.id), `bedrock-server-${entry.version}.zip`), { signal: context.signal, tracker: context.tracker, connections: Math.min(4, settings().concurrency || 6), onProgress: (bytes, total) => context.update('下载官方服务端 ZIP', total ? bytes / total * 99 : 10) }); context.signal.throwIfAborted(); instance.status = 'ready'; await store.save(); } catch (error) { instance.status = 'error'; instance.error = error.message; await store.save(); throw error; } }); res.status(202).json({ instance, job });
  });
  app.post('/api/auth/start', async (req, res) => {
    const revision = ++authRevision; authFlowId = null;
    const flow = await auth.startLogin({ onAuthorized: async result => {
      if (revision !== authRevision) throw new Error('本次登录已取消，请重新登录');
      accountRevision++; store.data.account = protectAccount(result.account); store.data.refreshToken = protectSecret(result.refreshToken); store.data.settings.loginMode = 'microsoft';
      await store.save(); broadcast();
      try { onAccountBound?.(); } catch { /* Window focus must not invalidate a saved login. */ }
    } });
    if (revision !== authRevision) { auth.cancelLogin(flow.flowId); throw new Error('本次登录已取消，请重新登录'); }
    authFlowId = flow.flowId; res.json(flow);
  });
  app.post('/api/auth/poll', async (req, res) => {
    if (req.body.flowId !== authFlowId) throw new Error('本次登录已取消或过期，请重新登录');
    const revision = authRevision; const result = await auth.pollLogin(req.body.flowId);
    if (revision !== authRevision) throw new Error('本次登录已取消，请重新登录');
    if (!result.pending) authFlowId = null;
    res.json(result);
  });
  app.post('/api/auth/cancel', (req, res) => { if (authFlowId === req.body.flowId) { authRevision++; authFlowId = null; } auth.cancelLogin(req.body.flowId); res.json({ ok: true }); });
  app.get('/api/auth/configuration', (req, res) => res.json(auth.configuration()));
  app.post('/api/auth/logout', async (req, res) => { accountRevision++; authRevision++; authFlowId = null; auth.close(); delete store.data.account; delete store.data.refreshToken; store.data.settings.loginMode = 'offline'; await store.save(); broadcast(); res.json({ ok: true }); });
  app.post('/api/auth/appearance', async (req, res) => {
    const revision = accountRevision;
    let account = revealAccount();
    if (!account) throw new Error('请先登录 Microsoft 正版账户，再获取皮肤和披风');
    let refreshed;
    if (!Number.isFinite(account.expiresAt) || account.expiresAt <= Date.now() + 60000) { refreshed = await auth.refreshAccount(revealSecret(store.data.refreshToken)); account = refreshed.account; }
    const appearance = await auth.getAppearance(account);
    if (revision !== accountRevision) throw new Error('账户已更改，请重新获取外观');
    store.data.account = protectAccount({ ...account, ...appearance });
    if (refreshed) store.data.refreshToken = protectSecret(refreshed.refreshToken);
    await store.save(); broadcast(); res.json({ ok: true });
  });
  let appearanceWork = Promise.resolve();
  function changeAppearance(action) {
    const revision = accountRevision;
    const work = appearanceWork.then(async () => {
      if (revision !== accountRevision) throw new Error('账户已更改，请重试');
      let account = revealAccount();
      if (!account) throw new Error('请先登录 Microsoft 正版账户');
      if (!Number.isFinite(account.expiresAt) || account.expiresAt <= Date.now() + 60000) {
        const refreshed = await auth.refreshAccount(revealSecret(store.data.refreshToken));
        if (revision !== accountRevision) throw new Error('账户已更改，请重试');
        account = refreshed.account; store.data.account = protectAccount(account); store.data.refreshToken = protectSecret(refreshed.refreshToken); await store.save();
      }
      await action(account);
      const appearance = await auth.getAppearance(account);
      if (revision !== accountRevision) throw new Error('账户已更改，请重试');
      store.data.account = protectAccount({ ...account, ...appearance }); await store.save(); broadcast();
    });
    appearanceWork = work.catch(() => {}); return work;
  }
  app.post('/api/auth/skin', async (req, res) => {
    const { variant, png, skinId, reset } = req.body;
    const data = png === undefined ? undefined : skinPng(png);
    await changeAppearance(account => auth.setSkin(account, { variant, data, url: account.skins?.find(skin => skin.id === skinId)?.url, reset: reset === true }));
    res.json({ ok: true });
  });
  app.post('/api/auth/cape', async (req, res) => {
    await changeAppearance(account => auth.setCape(account, req.body.capeId)); res.json({ ok: true });
  });
  app.get('/api/auth/appearance/:kind/:id', async (req, res) => {
    const revision = accountRevision;
    const texture = await textureDownloader(store.root, store.data.account, req.params.kind, req.params.id);
    if (revision !== accountRevision) throw new Error('账户已更改，请重新获取外观');
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.download === '1') res.download(texture.file, texture.name, { dotfiles: 'allow' });
    else res.type('png').sendFile(texture.file, { dotfiles: 'allow' });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, req, res, next) => { console.error(error.message); res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: error.type === 'entity.too.large' ? '整合包大小超过 512 MB 限制' : error.message || '操作失败' }); });
  // The WPF client is the only front end, so the server exposes the API only.
  app.use((req, res) => res.status(404).json({ error: '原生版仅提供启动器服务接口' }));
  await scanMods(); await store.save();
  const modTimer = setInterval(() => { if (clients.size) scanMods().catch(error => console.error('本地模组扫描失败：' + error.message)); }, 3000); modTimer.unref?.();
  return { app, store, jobs, close: () => { clearInterval(modTimer); clearTimeout(scheduled); auth.close(); for (const client of clients) client.end(); } };
}

