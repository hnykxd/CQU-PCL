import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { createStore, safePath } from '../server/storage.mjs';
import { inspectPack, installPackFiles } from '../server/packs.mjs';
import { JobQueue } from '../server/jobs.mjs';
import { download, hashFile, mirrorCandidates, mirrorUrl, request } from '../server/network.mjs';
import { installGame } from '../server/installer.mjs';
const sha = (data, algorithm = 'sha1') => createHash(algorithm).update(data).digest('hex');
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cqu-pcl-test-'));
function packBuffer(files = [], extra = {}) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0', name: '测试整合包', dependencies: { minecraft: 'fixture-1.0', 'fabric-loader': '0.1.0' }, files, ...extra })));
  zip.addFile('overrides/config/example.json', Buffer.from('{"enabled":true}'));
  zip.addFile('client-overrides/options.txt', Buffer.from('renderDistance:8'));
  zip.addFile('server-overrides/server.properties', Buffer.from('server-port=25565'));
  return zip.toBuffer();
}

test('实例目录隔离、状态恢复和移动后路径重建', async () => {
  const root = await temp(); const store = await createStore(root);
  const a = await store.add({ name: '世界 A', minecraft: '1.21.1' });
  const b = await store.add({ name: '世界 B', minecraft: '1.20.1' });
  assert.notEqual(store.directory(a.id), store.directory(b.id));
  await fs.writeFile(path.join(store.directory(a.id), 'game/saves/world.txt'), 'A');
  await assert.rejects(fs.access(path.join(store.directory(b.id), 'game/saves/world.txt')));
  a.javaPath = 'runtime/java-21/bin/java.exe'; await store.save();
  const restored = await createStore(root); assert.equal(restored.instance(a.id).status, 'error');
  const moved = root + '-moved'; await fs.rename(root, moved);
  const relocated = await createStore(moved); assert.ok(relocated.directory(a.id).startsWith(moved));
  assert.equal(relocated.instance(a.id).javaPath, 'runtime/java-21/bin/java.exe');
  await fs.rm(moved, { recursive: true });
});

test('阻止路径穿越、Windows 设备名和整合包脚本', () => {
  for (const unsafe of ['../escape', '/absolute', 'C:/escape', 'mods\\escape.jar', 'mods/CON.jar', 'mods/name.']) assert.throws(() => safePath(path.resolve('safe'), unsafe));
  assert.throws(() => inspectPack(packBuffer([{ path: '../bad.jar', hashes: { sha1: 'x', sha512: 'y' }, downloads: ['https://cdn.modrinth.com/file.jar'] }])));
  assert.throws(() => inspectPack(packBuffer([{ path: 'mods/malware.exe', hashes: { sha1: 'x', sha512: 'y' }, downloads: ['https://cdn.modrinth.com/file.exe'] }])));
});

test('Modrinth 整合包准确版本、文件校验和客户端 overrides', async () => {
  const directory = await temp(); const realFetch = globalThis.fetch; const jar = Buffer.from('fixture JAR');
  globalThis.fetch = async () => new Response(jar);
  try {
    const pack = inspectPack(packBuffer([
      { path: 'mods/test.jar', hashes: { sha1: sha(jar), sha512: sha(jar, 'sha512') }, downloads: ['https://cdn.modrinth.com/fixture.jar'] },
      { path: 'mods/server.jar', env: { client: 'unsupported' }, hashes: { sha1: sha(jar), sha512: sha(jar, 'sha512') }, downloads: ['https://cdn.modrinth.com/server.jar'] }
    ]));
    assert.equal(pack.minecraft, 'fixture-1.0'); assert.equal(pack.loader, 'fabric'); assert.equal(pack.loaderVersion, '0.1.0');
    const mods = await installPackFiles(pack, directory, { concurrency: 2 }, { signal: new AbortController().signal, update() {} });
    assert.equal(mods.length, 1); assert.equal(await hashFile(path.join(directory, 'mods/test.jar')), sha(jar));
    assert.equal(await fs.readFile(path.join(directory, 'config/example.json'), 'utf8'), '{"enabled":true}');
    assert.equal(await fs.readFile(path.join(directory, 'options.txt'), 'utf8'), 'renderDistance:8');
    await assert.rejects(fs.access(path.join(directory, 'mods/server.jar'))); await assert.rejects(fs.access(path.join(directory, 'server.properties')));
  } finally { globalThis.fetch = realFetch; await fs.rm(directory, { recursive: true }); }
});

test('CurseForge ZIP 识别准确 Forge 版本并要求平台 Key', async () => {
  const zip = new AdmZip(); zip.addFile('manifest.json', Buffer.from(JSON.stringify({ manifestType: 'minecraftModpack', name: 'CF Pack', version: '1', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.3.0', primary: true }] }, files: [{ projectID: 1, fileID: 2 }], overrides: 'overrides' })));
  const pack = inspectPack(zip.toBuffer()); assert.equal(pack.loader, 'forge'); assert.equal(pack.loaderVersion, '47.3.0');
  await assert.rejects(installPackFiles(pack, '/unused', {}, { signal: new AbortController().signal, update() {} }), /API Key/);
});

test('下载校验失败回退官方、取消不覆盖完整文件、跨域不泄露凭证', async () => {
  const directory = await temp(); const realFetch = globalThis.fetch; const content = Buffer.from('verified'); const file = path.join(directory, 'client.jar'); let urls = [];
  try {
    globalThis.fetch = async url => { urls.push(url); return new Response(url.includes('bmclapi') ? 'bad' : content); };
    await download('https://piston-data.mojang.com/file.jar', file, { source: 'bmclapi', hashes: { sha1: sha(content) } });
    assert.equal(urls.length, 2); assert.equal(await hashFile(file), sha(content));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(download('https://cdn.modrinth.com/file.jar', file, { hashes: { sha1: 'bad' }, signal: controller.signal }));
    assert.equal(await hashFile(file), sha(content));
    let nextHeaders;
    globalThis.fetch = async (url, options) => url.includes('api.curseforge.com') ? new Response(null, { status: 302, headers: { location: 'https://cdn.modrinth.com/file' } }) : (nextHeaders = options.headers, new Response('{}'));
    await request('https://api.curseforge.com/file', { headers: { 'x-api-key': 'private', Authorization: 'secret' } });
    assert.equal(nextHeaders['x-api-key'], undefined); assert.equal(nextHeaders.Authorization, undefined); assert.equal(nextHeaders.authorization, undefined);
    assert.equal(mirrorUrl('https://resources.download.minecraft.net/ab/file', 'bmclapi'), 'https://bmclapi2.bangbang93.com/assets/ab/file');
  } finally { globalThis.fetch = realFetch; await fs.rm(directory, { recursive: true }); }
});

test('取消运行任务直到写入结束前保持实例锁，失败不会阻塞队列', async () => {
  const queue = new JobQueue(); let finish;
  const first = queue.add('first', 'instance', async ({ signal }) => { await new Promise(resolve => { finish = resolve; }); signal.throwIfAborted(); });
  await new Promise(resolve => setImmediate(resolve)); queue.cancel(first.id); assert.equal(queue.busy('instance'), true);
  const second = queue.add('second', 'other', async () => {});
  finish(); await queue.tail; assert.equal(first.status, 'cancelled'); assert.equal(second.status, 'complete'); assert.equal(queue.busy('instance'), false);
});

test('安装引擎安装准确 Minecraft/Fabric 版本、游戏库和资源', async () => {
  const directory = await temp(); const realFetch = globalThis.fetch;
  const clientZip = new AdmZip(); clientZip.addFile('fixture-client.txt', Buffer.from('client'));
  const libraryZip = new AdmZip(); libraryZip.addFile('fixture-library.txt', Buffer.from('library'));
  const client = clientZip.toBuffer(); const library = libraryZip.toBuffer(); const asset = Buffer.from('asset');
  const index = JSON.stringify({ objects: { 'sound/fixture.ogg': { hash: sha(asset), size: asset.length } } });
  const metadata = JSON.stringify({ id: 'fixture-1.0', type: 'release', assets: 'fixture', assetIndex: { id: 'fixture', sha1: sha(index), size: index.length, url: 'https://fixtures.example.com/index.json' }, downloads: { client: { url: 'https://fixtures.example.com/client.jar', sha1: sha(client), size: client.length } }, javaVersion: { component: 'java-runtime', majorVersion: 21 }, libraries: [{ name: 'test:library:1', downloads: { artifact: { path: 'test/library/1/library-1.jar', url: 'https://fixtures.example.com/library.jar', sha1: sha(library), size: library.length } } }], mainClass: 'net.minecraft.client.main.Main', arguments: { game: [], jvm: [] }, releaseTime: '2026-01-01T00:00:00Z', time: '2026-01-01T00:00:00Z' });
  const routes = { 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': JSON.stringify({ latest: { release: 'fixture-1.0' }, versions: [{ id: 'fixture-1.0', url: 'https://fixtures.example.com/version.json', sha1: sha(metadata) }] }), 'https://fixtures.example.com/version.json': metadata, 'https://fixtures.example.com/index.json': index, 'https://fixtures.example.com/client.jar': client, 'https://fixtures.example.com/library.jar': library };
  globalThis.fetch = async url => {
    if (url.includes('meta.fabricmc.net')) return new Response(JSON.stringify({ id: 'fixture-1.0-fabric', inheritsFrom: 'fixture-1.0', libraries: [], mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', arguments: { game: [], jvm: [] }, releaseTime: '2026-01-01T00:00:00Z', time: '2026-01-01T00:00:00Z' }));
    if (url.includes('resources.download.minecraft.net')) return new Response(asset);
    if (!(url in routes)) throw new Error(`Unexpected fixture URL: ${url}`);
    return new Response(routes[url]);
  };
  const instance = { minecraft: 'fixture-1.0', loader: 'fabric', loaderVersion: '0.1.0' };
  const java = path.join(directory, 'fake-java.exe'); await fs.writeFile(java, '');
  try {
    await installGame(instance, directory, { source: 'official', javaPath: java, concurrency: 2 }, { signal: new AbortController().signal, update() {} });
    assert.equal(instance.launchVersion, 'fixture-1.0-fabric0.1.0');
    assert.equal(await hashFile(path.join(directory, 'game/versions/fixture-1.0/fixture-1.0.jar')), sha(client));
    assert.equal(await hashFile(path.join(directory, 'game/libraries/test/library/1/library-1.jar')), sha(library));
    assert.equal(await hashFile(path.join(directory, 'game/assets/objects', sha(asset).slice(0, 2), sha(asset))), sha(asset));
  } finally { globalThis.fetch = realFetch; await fs.rm(directory, { recursive: true }); }
});

test('BMCLAPI 镜像表覆盖文档中的官方域名，镜像优先且保留官方回退', () => {
  const mappings = {
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    'https://piston-data.mojang.com/v1/objects/ab/client.jar': 'https://bmclapi2.bangbang93.com/v1/objects/ab/client.jar',
    'https://launchermeta.mojang.com/v1/products/java-runtime/x/all.json': 'https://bmclapi2.bangbang93.com/v1/products/java-runtime/x/all.json',
    'https://resources.download.minecraft.net/ab/file': 'https://bmclapi2.bangbang93.com/assets/ab/file',
    'https://libraries.minecraft.net/com/google/guava/guava/21/guava-21.jar': 'https://bmclapi2.bangbang93.com/maven/com/google/guava/guava/21/guava-21.jar',
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.40/x.jar': 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.21.1-52.0.40/x.jar',
    'https://files.minecraftforge.net/maven/net/minecraftforge/forge/1.21.1-52.0.40/x.jar': 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.21.1-52.0.40/x.jar',
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.100/x.jar': 'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.100/x.jar',
    'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/x.jar': 'https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/0.16.9/x.jar',
    'https://maven.quiltmc.org/repository/release/x.jar': 'https://bmclapi2.bangbang93.com/maven/x.jar',
    'https://meta.fabricmc.net/v2/versions/loader/1.21.1': 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.21.1',
    'https://meta.quiltmc.org/v3/versions/loader/1.21.1': 'https://bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader/1.21.1'
  };
  for (const [official, mirror] of Object.entries(mappings)) assert.equal(mirrorUrl(official, 'bmclapi'), mirror);
  // Hosts BMCLAPI does not carry stay untouched, and the official source never rewrites.
  for (const plain of ['https://api.modrinth.com/v2/search', 'https://cdn.modrinth.com/file.jar', 'https://api.curseforge.com/v1/mods/1'])
    assert.equal(mirrorUrl(plain, 'bmclapi'), plain);
  assert.equal(mirrorUrl('https://libraries.minecraft.net/x.jar', 'official'), 'https://libraries.minecraft.net/x.jar');
  assert.deepEqual(mirrorCandidates('https://piston-data.mojang.com/client.jar', 'bmclapi'), ['https://bmclapi2.bangbang93.com/client.jar', 'https://piston-data.mojang.com/client.jar']);
  assert.deepEqual(mirrorCandidates('https://cdn.modrinth.com/file.jar', 'bmclapi'), ['https://cdn.modrinth.com/file.jar']);
  assert.deepEqual(mirrorCandidates('https://piston-data.mojang.com/client.jar', 'official'), ['https://piston-data.mojang.com/client.jar']);
});
