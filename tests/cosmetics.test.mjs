import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { textureUrl, profileAppearance, downloadTexture } from '../server/cosmetics.mjs';

const hash = 'b'.repeat(64);
const url = 'https://textures.minecraft.net/texture/' + hash;
const account = { uuid: 'a'.repeat(32), name: 'CQU_Player', skins: [{ id: 'skin-1', url, active: true }], capes: [{ id: 'cape-1', url, active: false }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const temporaryRoot = async t => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-textures-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };

test('官方纹理域名白名单、升级 HTTPS 和皮肤/全部披风规范化', () => {
  assert.equal(textureUrl(url.replace('https:', 'http:')), url);
  for (const bad of [url + '?token=secret', url + '#fragment', url.replace('textures.minecraft.net', 'textures.minecraft.net.evil.example'), url.replace('https://', 'https://user@'), 'file:///etc/passwd', 'http://127.0.0.1/texture/' + hash, url.replace(hash, '../private')]) assert.equal(textureUrl(bad), null);
  const result = profileAppearance({ skins: [{ id: 'skin-1', url, variant: 'SLIM', state: 'ACTIVE' }, { id: '../bad', url }], capes: [{ id: 'cape-1', url, alias: 'Migrator', state: 'ACTIVE' }, { id: 'cape-2', url, alias: 'Cherry' }, { id: 'bad-url', url: 'https://evil.example/cape.png' }] });
  assert.equal(result.skins.length, 1); assert.equal(result.skins[0].variant, 'slim'); assert.equal(result.capes.length, 2); assert.equal(result.capes[1].active, false);
  assert.deepEqual(profileAppearance({ skins: null, capes: null }).capes, []);
});

test('并发预览/下载复用请求，原子写入本机缓存且不发送账户令牌', async t => {
  const root = await temporaryRoot(t); let calls = 0, release;
  const fetcher = async (target, options) => { calls++; assert.equal(target, url); assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error'); await new Promise(resolve => { release = resolve; }); return new Response(png); };
  const first = downloadTexture(root, account, 'skins', 'skin-1', { fetcher });
  const second = downloadTexture(root, account, 'skins', 'skin-1', { fetcher });
  await new Promise(resolve => setTimeout(resolve, 20)); release();
  const [a, b] = await Promise.all([first, second]); assert.equal(calls, 1); assert.equal(a.file, b.file); assert.deepEqual(await fs.readFile(a.file), png);
  assert.equal(path.relative(root, a.file), path.join('account-assets', account.uuid, 'skins', hash + '.png'));
  assert.match(a.name, /^CQU_Player-skin-/);
  await downloadTexture(root, account, 'skins', 'skin-1', { fetcher }); assert.equal(calls, 1);
});

test('拒绝越权纹理、超大文件和非 PNG，下载失败后可以重试', async t => {
  const root = await temporaryRoot(t);
  await assert.rejects(downloadTexture(root, account, '../skins', 'skin-1'), /类型/);
  await assert.rejects(downloadTexture(root, account, 'skins', 'other-account-skin'), /当前账户/);
  await assert.rejects(downloadTexture(root, account, 'skins', 'skin-1', { fetcher: async () => new Response('not a png') }), /PNG/);
  await assert.rejects(downloadTexture(root, account, 'skins', 'skin-1', { fetcher: async () => new Response(png, { headers: { 'Content-Length': 3 * 1024 * 1024 } }) }), /不可用/);
  const result = await downloadTexture(root, account, 'skins', 'skin-1', { fetcher: async () => new Response(png) }); assert.deepEqual(await fs.readFile(result.file), png);
});
