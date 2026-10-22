import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuthService, resolveLaunchAccount } from '../server/auth.mjs';
import { createServer } from '../server/index.mjs';

const clientId = '00000000-0000-4000-8000-000000000001';
const profile = { id: 'a'.repeat(32), name: 'CQU_Online', skins: [{ id: 'skin-1', url: 'https://textures.minecraft.net/texture/' + 'b'.repeat(64), state: 'ACTIVE', variant: 'SLIM' }], capes: [{ id: 'cape-1', url: 'https://textures.minecraft.net/texture/' + 'c'.repeat(64), state: 'ACTIVE', alias: 'Migrator' }] };
const device = { device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://www.microsoft.com/link', interval: 5, expires_in: 900 };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function fixture({ tokenReplies = [], deviceReply = device, intercept } = {}) {
  let time = Date.now();
  const requests = [];
  const auth = createAuthService({ clientId, now: () => time, fetcher: async (url, options) => {
    requests.push({ url, ...options });
    const intercepted = await intercept?.(url, options);
    if (intercepted) return intercepted;
    if (url.endsWith('/devicecode')) return response(deviceReply);
    if (url.endsWith('/token')) {
      const reply = tokenReplies.shift() || { access_token: 'ms-token', refresh_token: 'refresh-token' };
      return reply instanceof Response ? reply : response(reply, reply.error ? 400 : 200);
    }
    if (url.includes('user.auth.xboxlive.com')) return response({ Token: 'xbox-token' });
    if (url.includes('xsts.auth.xboxlive.com')) return response({ Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } });
    if (url.includes('login_with_xbox')) return response({ access_token: 'minecraft-token', expires_in: 3600 });
    if (url.endsWith('/minecraft/profile')) return response(profile);
    throw new Error('Unexpected authentication request: ' + url);
  } });
  return { auth, requests, tick: seconds => { time += seconds * 1000; } };
}

test('内置公共客户端配置，未配置时拒绝登录且不接受玩家传入 ID', async t => {
  const auth = createAuthService({ clientId: '' }); t.after(auth.close);
  assert.deepEqual(auth.configuration(), { configured: false });
  await assert.rejects(auth.startLogin({ clientId }), /发布者/);
});

test('v2.0 设备码请求、隐私边界、令牌交换和账户绑定', async t => {
  const { auth, requests, tick } = fixture(); t.after(auth.close);
  let bound;
  const flow = await auth.startLogin({ onAuthorized: async result => { bound = result; } });
  assert.equal(requests[0].url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.Accept, 'application/json');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0].body)), { client_id: clientId, scope: 'XboxLive.signin offline_access' });
  assert.deepEqual({ ...flow, flowId: 'opaque' }, { flowId: 'opaque', userCode: 'ABCD-EFGH', verificationUri: 'https://www.microsoft.com/link', interval: 5, expiresIn: 900 });
  assert.doesNotMatch(JSON.stringify(flow), /private-device-code|client_id|redirect|verifier/);
  assert.deepEqual(await auth.pollLogin(flow.flowId), { pending: true, interval: 5, phase: 'waiting' });
  assert.equal(requests.length, 1); tick(5);
  assert.deepEqual(await auth.pollLogin(flow.flowId), { ok: true });
  assert.equal(bound.account.name, profile.name); assert.equal(bound.account.accessToken, 'minecraft-token');
  assert.equal(bound.account.skins[0].url, profile.skins[0].url); assert.equal(bound.account.capes[0].name, 'Migrator');
  assert.equal(bound.refreshToken, 'refresh-token');
  const tokens = new URLSearchParams(requests[1].body);
  assert.equal(requests[1].url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
  assert.deepEqual(Object.fromEntries(tokens), { client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'private-device-code' });
  const xbox = JSON.parse(requests.find(r => r.url.includes('user.auth.xboxlive.com')).body);
  assert.equal(xbox.Properties.RpsTicket, 'd=ms-token');
  assert.equal(JSON.parse(requests.find(r => r.url.includes('xsts.auth.xboxlive.com')).body).RelyingParty, 'rp://api.minecraftservices.com/');
  assert.equal(JSON.parse(requests.find(r => r.url.includes('login_with_xbox')).body).identityToken, 'XBL3.0 x=user-hash;xsts-token');
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer minecraft-token');
  await assert.rejects(auth.pollLogin(flow.flowId), /取消|过期/);
});

test('authorization_pending 持续等待，slow_down 增加后续间隔并限制过早轮询', async t => {
  const { auth, requests, tick } = fixture({ tokenReplies: [{ error: 'authorization_pending' }, { error: 'slow_down' }, { error: 'authorization_pending' }] }); t.after(auth.close);
  const flow = await auth.startLogin(); tick(5);
  assert.deepEqual(await auth.pollLogin(flow.flowId), { pending: true, interval: 5, phase: 'waiting' });
  tick(4); assert.equal((await auth.pollLogin(flow.flowId)).interval, 1); assert.equal(requests.length, 2);
  tick(1); assert.equal((await auth.pollLogin(flow.flowId)).interval, 10); assert.equal(requests.length, 3);
  tick(9); assert.equal((await auth.pollLogin(flow.flowId)).interval, 1); assert.equal(requests.length, 3);
  tick(1); assert.equal((await auth.pollLogin(flow.flowId)).interval, 10);
  tick(10); assert.deepEqual(await auth.pollLogin(flow.flowId), { ok: true });
});

test('设备码响应验证和缺省 5 秒间隔', async t => {
  for (const patch of [{ device_code: '' }, { user_code: '<script>' }, { expires_in: 0 }, { interval: -1 }, { interval: 901 }, { verification_uri: 'https://attacker.example/link' }, { verification_uri: 'http://www.microsoft.com/link' }]) {
    const { auth } = fixture({ deviceReply: { ...device, ...patch } }); t.after(auth.close);
    await assert.rejects(auth.startLogin(), /有效/);
  }
  const { auth } = fixture({ deviceReply: { ...device, interval: undefined } }); t.after(auth.close);
  assert.equal((await auth.startLogin()).interval, 5);
});

test('并发轮询只交换一次令牌并只绑定一次', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { auth, requests, tick } = fixture({ intercept: async url => {
    if (url.endsWith('/token')) { entered(); return new Promise(resolve => { release = () => resolve(response({ access_token: 'ms', refresh_token: 'refresh' })); }); }
  } }); t.after(auth.close);
  let bindings = 0;
  const flow = await auth.startLogin({ onAuthorized: async () => { bindings++; } }); tick(5);
  const first = auth.pollLogin(flow.flowId); await waiting;
  const second = auth.pollLogin(flow.flowId); release();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(bindings, 1); assert.equal(requests.filter(r => r.url.endsWith('/token')).length, 1);
});

test('取消处理中登录和重新开始后，迟到响应不能绑定', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { auth, tick } = fixture({ intercept: async url => {
    if (url.endsWith('/token')) { entered(); return new Promise(resolve => { release = () => resolve(response({ access_token: 'ms', refresh_token: 'refresh' })); }); }
  } }); t.after(auth.close);
  let bound = false;
  const flow = await auth.startLogin({ onAuthorized: async () => { bound = true; } }); tick(5);
  const first = auth.pollLogin(flow.flowId); const rejected = assert.rejects(first, /取消|过期/); await waiting;
  const replacement = await auth.startLogin(); release(); await rejected;
  assert.equal(bound, false); assert.equal((await auth.pollLogin(replacement.flowId)).pending, true);
});

test('取消正在申请的设备码不会留下旧流程', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { auth } = fixture({ intercept: async url => {
    if (url.endsWith('/devicecode')) { entered(); return new Promise(resolve => { release = () => resolve(response(device)); }); }
  } }); t.after(auth.close);
  const starting = auth.startLogin(); const rejected = assert.rejects(starting, /取消/);
  await waiting; auth.close(); release(); await rejected;
});

test('本地过期和微软拒绝、过期、失效均终止设备码流程', async t => {
  const { auth, tick } = fixture(); t.after(auth.close);
  let flow = await auth.startLogin(); auth.cancelLogin(flow.flowId); await assert.rejects(auth.pollLogin(flow.flowId), /取消/);
  flow = await auth.startLogin(); tick(901); await assert.rejects(auth.pollLogin(flow.flowId), /过期/);
  for (const [code, message] of [['authorization_declined', /拒绝/], ['access_denied', /取消/], ['expired_token', /过期/], ['bad_verification_code', /失效/], ['invalid_client', /配置/]]) {
    const f = fixture({ tokenReplies: [{ error: code, error_description: 'private details' }] }); t.after(f.auth.close);
    const current = await f.auth.startLogin(); f.tick(5);
    await assert.rejects(f.auth.pollLogin(current.flowId), message);
    await assert.rejects(f.auth.pollLogin(current.flowId), /取消|过期/);
  }
});

test('Minecraft 403 仅在原始错误明确时提示应用注册，并保留档案和家庭错误', async t => {
  for (const [endpoint, data, status, message] of [
    ['login_with_xbox', { errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo for more information' }, 403, /Invalid app registration.*AppRegInfo/],
    ['/minecraft/profile', { error: 'Forbidden', error_description: 'private details' }, 403, /Minecraft 角色档案被拒绝（HTTP 403）/],
    ['/minecraft/profile', {}, 404, /Java 版档案/],
    ['xsts.auth.xboxlive.com', { XErr: 2148916238 }, 401, /监护人/],
  ]) {
    const { auth, tick } = fixture({ intercept: async url => url.includes(endpoint) ? response(data, status) : undefined }); t.after(auth.close);
    const flow = await auth.startLogin(); tick(5); await assert.rejects(auth.pollLogin(flow.flowId), message);
  }
  for (const body of ['', 'private response with sensitive data', JSON.stringify({ errorMessage: 'other private error' })]) {
    const { auth, tick } = fixture({ intercept: async url => url.includes('login_with_xbox') ? new Response(body, { status: 403 }) : undefined }); t.after(auth.close);
    const flow = await auth.startLogin(); tick(5);
    await assert.rejects(auth.pollLogin(flow.flowId), error => {
      assert.match(error.message, /Minecraft 登录被拒绝（HTTP 403）/);
      assert.doesNotMatch(error.message, /审核已获批准|Invalid app registration|private|sensitive/); return true;
    });
  }
});

test('缺少持续登录令牌不能保存账户，刷新使用同一 ID 并轮换 refresh token', async t => {
  const { auth, requests, tick } = fixture({ tokenReplies: [{ access_token: 'ms' }, { access_token: 'ms2', refresh_token: 'rotated' }] }); t.after(auth.close);
  let bound = false;
  const flow = await auth.startLogin({ onAuthorized: async () => { bound = true; } }); tick(5);
  await assert.rejects(auth.pollLogin(flow.flowId), /持续登录授权/); assert.equal(bound, false);
  const result = await auth.refreshAccount('original'); assert.equal(result.refreshToken, 'rotated');
  const tokens = new URLSearchParams(requests.filter(r => r.url.endsWith('/token')).at(-1).body);
  assert.equal(tokens.get('client_id'), clientId); assert.equal(tokens.get('grant_type'), 'refresh_token'); assert.equal(tokens.get('refresh_token'), 'original');
});

test('离线模式不使用正版令牌，正版账户过期或缺少过期时间时刷新', async () => {
  const account = { name: 'CQU_Online', accessToken: 'secret', expiresAt: Date.now() - 1 };
  let calls = 0;
  const refresh = async token => { calls++; assert.equal(token, 'refresh'); return { account: { ...account, accessToken: 'new-token' }, refreshToken: 'new-refresh' }; };
  assert.deepEqual(await resolveLaunchAccount({ loginMode: 'offline' }, account, 'refresh', refresh), { account: null }); assert.equal(calls, 0);
  await assert.rejects(resolveLaunchAccount({ loginMode: 'microsoft' }, null, '', refresh), /完成 Microsoft 正版登录/);
  assert.equal((await resolveLaunchAccount({ loginMode: 'microsoft' }, account, 'refresh', refresh)).account.accessToken, 'new-token');
  await resolveLaunchAccount({ loginMode: 'microsoft' }, { ...account, expiresAt: undefined }, 'refresh', refresh); assert.equal(calls, 2);
});

test('账户 API 设备码授权后加密保存、隐藏凭据、刷新外观、PNG 下载和退出', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-auth-api-'));
  const { auth, tick } = fixture();
  const imageFile = path.join(root, 'fixture.png'); await fs.writeFile(imageFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let focused = 0;
  const service = await createServer({ root, production: true, auth, onAccountBound: () => { focused++; }, protectSecret: value => `protected:${value}`, revealSecret: value => value?.replace(/^protected:/, '') || '', textureDownloader: async (directory, account, kind, id) => {
    assert.equal(directory, root); assert.equal(account.uuid, profile.id); assert.ok(account[kind].some(item => item.id === id)); return { file: imageFile, name: kind + '.png' };
  } });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (endpoint, body, method = 'POST') => {
    const result = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: result.status, data: await result.json() };
  };
  try {
    assert.equal((await call('/settings', { loginMode: 'invalid' }, 'PATCH')).status, 400);
    await call('/settings', { loginMode: 'microsoft', clientId: 'player-cannot-change-this' }, 'PATCH');
    const flow = (await call('/auth/start', { clientId: 'player-cannot-change-this' })).data;
    assert.equal(flow.userCode, 'ABCD-EFGH'); assert.equal(flow.deviceCode, undefined); assert.equal(flow.device_code, undefined); assert.equal(flow.clientId, undefined);
    tick(5); assert.equal((await call('/auth/poll', { flowId: flow.flowId })).status, 200);
    assert.equal(service.store.data.account.accessToken, 'protected:minecraft-token'); assert.equal(focused, 1);
    assert.equal(service.store.data.refreshToken, 'protected:refresh-token');
    const state = (await call('/state', undefined, 'GET')).data;
    assert.equal(state.account.name, 'CQU_Online'); assert.equal(state.account.accessToken, undefined); assert.equal(state.refreshToken, undefined); assert.equal(state.settings.clientId, undefined);
    assert.deepEqual(state.microsoftLogin, { configured: true }); assert.equal(state.microsoftLogin.clientId, undefined);
    assert.equal((await call('/auth/appearance', {})).status, 200); assert.equal(service.store.data.account.skins[0].variant, 'slim');
    const preview = await fetch(base + '/auth/appearance/skins/skin-1'); assert.equal(preview.headers.get('content-type'), 'image/png');
    const download = await fetch(base + '/auth/appearance/capes/cape-1?download=1'); assert.match(download.headers.get('content-disposition'), /attachment/);
    await call('/settings', { loginMode: 'offline', playerName: 'Offline_CQU' }, 'PATCH'); assert.equal(service.store.data.account.name, 'CQU_Online');
    await call('/auth/logout', {}); assert.equal(service.store.data.settings.loginMode, 'offline'); assert.equal(service.store.data.account, undefined);
    assert.equal((await call('/auth/appearance', {})).status, 400);
  } finally { service.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
