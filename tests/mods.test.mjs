import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { ModScanner } from '../server/mods.mjs';
import { hashFile } from '../server/network.mjs';
import { createServer } from '../server/index.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-local-mods-')); await fs.mkdir(path.join(directory, 'mods'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
async function jar(directory, fileName, entries) {
  const zip = new AdmZip(); for (const [name, text] of Object.entries(entries)) zip.addFile(name, Buffer.from(text));
  const file = path.join(directory, 'mods', fileName); await fs.writeFile(file, zip.toBuffer()); return file;
}
test('本地识别 Fabric、Quilt、Forge、NeoForge、旧 Forge 名称版本，损坏 JAR 也列出', async t => {
  const game = await fixture(t); const scanner = new ModScanner(); const instance = { mods: [] };
  await jar(game, 'fabric.jar', { 'fabric.mod.json': JSON.stringify({ id: 'fabric', name: 'Fabric 示例', version: '1.2.3' }) });
  await jar(game, 'quilt.jar.disabled', { 'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'quilt', version: '2.0', metadata: { name: 'Quilt 示例' } } }) });
  await jar(game, 'forge.jar', { 'META-INF/mods.toml': 'modLoader = "javafml"\n[[mods]]\nmodId = "forge"\ndisplayName = "Forge # 示例" # comment\nversion = "${file.jarVersion}"\ndescription = """multi\nline"""', 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Version: 3.1\r\n' });
  await jar(game, 'neo.jar', { 'META-INF/neoforge.mods.toml': "modLoader = 'javafml'\n[[mods]]\nmodId = 'neo'\ndisplayName = 'NeoForge 示例'\nversion = '4.0'" });
  await jar(game, 'legacy.jar', { 'mcmod.info': JSON.stringify([{ modid: 'legacy', name: '旧 Forge', version: '0.9' }]) });
  await jar(game, 'installer.jar', { 'installer.json': '{}' });
  await fs.writeFile(path.join(game, 'mods/broken.jar'), 'not-a-zip'); await fs.writeFile(path.join(game, 'mods/readme.txt'), 'ignore');
  assert.equal(await scanner.scan(instance, game), true); assert.equal(instance.mods.length, 7);
  const byId = Object.fromEntries(instance.mods.map(mod => [mod.modId || mod.fileName, mod]));
  assert.equal(byId.fabric.name, 'Fabric 示例'); assert.equal(byId.fabric.versionNumber, '1.2.3');
  assert.equal(byId.quilt.enabled, false); assert.equal(byId.forge.versionNumber, '3.1'); assert.equal(byId.forge.name, 'Forge # 示例');
  assert.equal(byId.neo.loader, 'neoforge'); assert.equal(byId.legacy.versionNumber, '0.9');
  assert.match(byId['broken.jar'].warning, /无法读取/); assert.match(byId['installer.jar'].warning, /未找到/);
  assert.equal(await scanner.scan(instance, game), false); assert.equal(scanner.cache.size, 7);
});

test('磁盘增加、移除、禁用和替换立即更新列表，只有校验匹配时保留联网项目标识', async t => {
  const game = await fixture(t); const scanner = new ModScanner();
  const file = await jar(game, 'one.jar', { 'fabric.mod.json': JSON.stringify({ id: 'one', name: 'One', version: '1' }) });
  const sha1 = await hashFile(file); const instance = { mods: [{ fileName: 'one.jar', projectId: 'project', versionId: 'remote-1', source: 'modrinth', hashes: { sha1 } }, { fileName: 'removed.jar' }] };
  await scanner.scan(instance, game); assert.equal(instance.mods.length, 1); assert.equal(instance.mods[0].projectId, 'project');
  await fs.rename(file, file + '.disabled'); await scanner.scan(instance, game);
  assert.equal(instance.mods[0].enabled, false); assert.equal(instance.mods[0].projectId, 'project');
  await jar(game, 'one.jar.disabled', { 'fabric.mod.json': JSON.stringify({ id: 'one', name: 'One replaced', version: '2.0' }) });
  await scanner.scan(instance, game); assert.equal(instance.mods[0].name, 'One replaced'); assert.equal(instance.mods[0].projectId, undefined);
  assert.equal(instance.mods[0].source, 'local');
  await fs.rm(file + '.disabled'); await scanner.scan(instance, game); assert.equal(instance.mods.length, 0); assert.equal(scanner.cache.size, 0);
});

test('状态接口与手动扫描反映本地文件，打开目录错误可见，删除任务不会删除世界', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-inventory-api-')); const opened = [];
  const service = await createServer({ root, openPath: async target => { if (opened.length) throw new Error('无法打开测试目录'); opened.push(target); } });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const instance = await service.store.add({ name: 'Local', minecraft: 'fixture', loader: 'fabric' }); instance.status = 'ready';
  const game = path.join(service.store.directory(instance.id), 'game'); await jar(game, 'local.jar', { 'fabric.mod.json': JSON.stringify({ id: 'local', name: 'Local Mod', version: '1.0' }) });
  const api = `http://127.0.0.1:${server.address().port}/api`;
  const state = await (await fetch(api + '/state')).json(); assert.equal(state.instances[0].mods[0].name, 'Local Mod');
  await fs.rm(path.join(game, 'mods/local.jar'));
  const scanned = await (await fetch(api + `/instances/${instance.id}/mods/scan`, { method: 'POST' })).json(); assert.deepEqual(scanned.mods, []);
  assert.equal((await fetch(api + `/instances/${instance.id}/open`, { method: 'POST' })).status, 200); assert.equal(opened[0], service.store.directory(instance.id));
  assert.equal((await fetch(api + `/instances/${instance.id}/open`, { method: 'POST' })).status, 400);
  const job = service.jobs.add('finished', instance.id, async () => {}); await service.jobs.tail;
  assert.equal((await fetch(api + `/jobs/${job.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(service.jobs.public(), []); await fs.access(game); assert.equal(service.store.data.instances.length, 1);
});
