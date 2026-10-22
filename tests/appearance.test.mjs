import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../server/auth.mjs';
import { skinPng } from '../server/cosmetics.mjs';

const account = { accessToken: 'private', uuid: 'a'.repeat(32), skins: [{ id: 'skin', url: 'https://textures.minecraft.net/texture/' + 'b'.repeat(64) }], capes: [{ id: 'cape' }] };
test('皮肤 PNG 尺寸和文件类型验证', () => {
  const png = Buffer.alloc(45); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(13,8); png.write('IHDR',12); png.writeUInt32BE(64,16); png.writeUInt32BE(64,20);
  assert.deepEqual(skinPng(png.toString('base64')), png);
  png.writeUInt32BE(32,20); assert.deepEqual(skinPng(png.toString('base64')), png);
  png.writeUInt32BE(128,16); assert.throws(() => skinPng(png.toString('base64')), /64/);
  assert.throws(() => skinPng(Buffer.from('not png').toString('base64')), /PNG/);
});
test('上传/切换/重置皮肤，装备/隐藏披风均调用官方 API，不能装备其他账户披风', async t => {
  const calls = [];
  const auth = createAuthService({ fetcher: async (url, options) => { calls.push({ url, ...options }); return new Response(null, { status: 204 }); } }); t.after(auth.close);
  await auth.setSkin(account, { variant: 'slim', data: Buffer.from('png') });
  assert.equal(calls[0].url, 'https://api.minecraftservices.com/minecraft/profile/skins');
  assert.equal(calls[0].body.get('variant'), 'slim'); assert.equal(await calls[0].body.get('file').text(), 'png');
  assert.equal(calls[0].headers.Authorization, 'Bearer private'); assert.equal(calls[0].headers['Content-Type'], undefined);
  await auth.setSkin(account, { variant: 'classic', url: account.skins[0].url }); assert.equal(JSON.parse(calls[1].body).url, account.skins[0].url);
  await auth.setSkin(account, { reset: true }); assert.equal(calls[2].method, 'DELETE'); assert.ok(calls[2].url.endsWith('/skins/active'));
  await auth.setCape(account, 'cape'); assert.equal(calls[3].method, 'PUT'); assert.deepEqual(JSON.parse(calls[3].body), { capeId: 'cape' });
  await auth.setCape(account, null); assert.equal(calls[4].method, 'DELETE');
  await assert.rejects(auth.setCape(account, 'unowned'), /已拥有/); await assert.rejects(auth.setSkin(account, {variant:'classic',url:'https://attacker.example/skin'}), /当前账户/);
  assert.equal(calls.length,5);
});
