import { randomBytes } from 'node:crypto';
import { microsoftClientId } from './auth-config.mjs';
import { profileAppearance } from './cosmetics.mjs';

const LOGIN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const scope = 'XboxLive.signin offline_access';
const messages = {
  access_denied: '你取消了 Microsoft 授权，可以重新登录',
  authorization_declined: '你拒绝了 Microsoft 授权，可以重新登录',
  expired_token: '登录验证码已过期，请重新登录',
  bad_verification_code: '登录验证码已失效，请重新登录',
  invalid_grant: 'Microsoft 登录已失效，请重新登录',
  invalid_client: '此版本的 Microsoft 登录服务尚未配置完成，请联系启动器发布者',
  unauthorized_client: '此版本的 Microsoft 登录服务暂不可用，请联系启动器发布者',
};
const xboxMessages = {
  2148916233: '此 Microsoft 账户尚未创建 Xbox 档案，请先前往 xbox.com 完成注册后重新登录',
  2148916235: '此账户所在地区暂不支持 Xbox Live 服务',
  2148916236: '此账户需要先在 Xbox 网页完成年龄验证',
  2148916237: '此账户需要先在 Xbox 网页完成年龄验证',
  2148916238: '此儿童账户需要监护人将其加入 Microsoft 家庭并允许 Xbox 游戏访问',
};
class OAuthError extends Error {
  constructor(code) { super(messages[code] || 'Microsoft 授权失败，请稍后重新登录'); this.code = code; }
}
function verificationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ((url.hostname === 'www.microsoft.com' && url.pathname === '/link') || url.hostname === 'login.microsoftonline.com')) return url.href;
  } catch { /* Invalid service response. */ }
  throw new Error('Microsoft 未返回有效验证网址，请重新登录');
}

export function createAuthService({ clientId = microsoftClientId, fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const pending = new Map();
  const configured = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);
  const configuration = () => ({ configured });
  function cancelLogin(id) {
    const flow = pending.get(id);
    if (flow) { clearTimeout(flow.expiryTimer); flow.controller.abort(); }
    pending.delete(id);
  }
  const close = () => { for (const id of pending.keys()) cancelLogin(id); };
  async function read(url, options = {}) {
    const response = await fetcher(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    let data;
    if (response.status === 204) return {};
    try { data = await response.json(); } catch { /* Some services return an empty or HTML error body. */ }
    // A 403 alone does not identify an app-registration error. Never expose
    // arbitrary account-service data in the player-facing message.
    if (response.status === 403 && new URL(url).hostname === 'api.minecraftservices.com') {
      const stage = url.endsWith('/authentication/login_with_xbox') ? 'Minecraft 登录' : 'Minecraft 角色档案';
      if (typeof data?.errorMessage === 'string' && data.errorMessage.startsWith('Invalid app registration')) {
        throw new Error(`${stage}被拒绝（HTTP 403）：Minecraft 服务未接受当前应用注册（Invalid app registration）。应用注册说明：https://aka.ms/AppRegInfo`);
      }
      throw new Error(`${stage}被拒绝（HTTP 403），请检查账户访问限制和登录服务状态；该状态码本身无法确定应用审核情况。`);
    }
    if (url.endsWith('/minecraft/profile') && response.status === 404) throw new Error('此账户没有可用的 Minecraft Java 版档案，请确认已拥有游戏并创建角色');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('账户服务返回异常，请稍后重试');
    if (data.XErr) throw new Error(xboxMessages[data.XErr] || 'Xbox 拒绝了账户授权，请检查 Xbox 档案及家庭设置');
    if (data.error && new URL(url).hostname === 'login.microsoftonline.com') throw new OAuthError(data.error);
    if (!response.ok) {
      if (response.status === 401) throw new Error('游戏账户授权已失效，请重新登录 Microsoft');
      throw new Error(`账户服务暂时不可用（HTTP ${response.status}），请稍后重新登录`);
    }
    return data;
  }
  const form = (body, signal, endpoint = '/token') => read(LOGIN + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body).toString(), signal });
  const post = (url, body, signal) => read(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal });
  async function exchangeMinecraft(accessToken, signal) {
    if (!accessToken) throw new Error('Microsoft 未返回有效授权，请重新登录');
    const xbox = await post('https://user.auth.xboxlive.com/user/authenticate', { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }, signal);
    const xsts = await post('https://xsts.auth.xboxlive.com/xsts/authorize', { Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }, signal);
    const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (!xsts.Token || !uhs) throw new Error('无法获取 Xbox 游戏授权，请检查账户的 Xbox 档案');
    const minecraft = await post('https://api.minecraftservices.com/authentication/login_with_xbox', { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }, signal);
    const profile = await read('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${minecraft.access_token}` }, signal });
    if (!/^[a-f0-9]{32}$/i.test(profile.id) || !/^[A-Za-z0-9_]{1,16}$/.test(profile.name) || !minecraft.access_token || !Number.isFinite(minecraft.expires_in) || minecraft.expires_in <= 0) throw new Error('此账户没有有效的 Minecraft Java 版游戏档案');
    return { uuid: profile.id, name: profile.name, accessToken: minecraft.access_token, expiresAt: now() + minecraft.expires_in * 1000, ...profileAppearance(profile) };
  }
  function assertActive(id, flow) {
    if (pending.get(id) !== flow) throw new Error('本次登录已取消或过期，请重新登录');
    if (now() >= flow.expires) { cancelLogin(id); throw new Error('登录验证码已过期，请重新登录'); }
    flow.controller.signal.throwIfAborted();
  }
  async function startLogin({ onAuthorized = async () => {} } = {}) {
    if (!configured) throw new Error('此版本尚未开通 Microsoft 正版登录，请联系启动器发布者完成授权服务配置');
    close();
    const id = randomBytes(24).toString('base64url');
    const flow = { phase: 'starting', controller: new AbortController(), onAuthorized };
    pending.set(id, flow);
    try {
      const data = await form({ client_id: clientId, scope }, flow.controller.signal, '/devicecode');
      if (pending.get(id) !== flow || flow.controller.signal.aborted) throw new Error('本次登录已取消，请重新登录');
      const expiresIn = data.expires_in;
      const interval = data.interval === undefined ? 5 : data.interval;
      if (typeof data.device_code !== 'string' || !data.device_code || data.device_code.length > 8192 ||
          typeof data.user_code !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(data.user_code) ||
          !Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 86400 ||
          !Number.isInteger(interval) || interval <= 0 || interval > expiresIn) throw new Error('Microsoft 未返回有效登录验证码，请重新登录');
      const verificationUri = verificationUrl(data.verification_uri);
      Object.assign(flow, { phase: 'waiting', deviceCode: data.device_code, expires: now() + expiresIn * 1000, interval, nextPoll: now() + interval * 1000 });
      flow.expiryTimer = setTimeout(() => cancelLogin(id), expiresIn * 1000);
      flow.expiryTimer.unref();
      // device_code is a credential and stays in the main process.
      return { flowId: id, userCode: data.user_code, verificationUri, interval, expiresIn };
    } catch (error) {
      const cancelled = pending.get(id) !== flow || flow.controller.signal.aborted;
      if (pending.get(id) === flow) cancelLogin(id);
      if (cancelled) throw new Error('本次登录已取消，请重新登录');
      throw error;
    }
  }
  async function exchangeFlow(id, flow) {
    try {
      const tokens = await form({ client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: flow.deviceCode }, flow.controller.signal);
      assertActive(id, flow);
      flow.phase = 'processing';
      if (!tokens.refresh_token) throw new Error('Microsoft 未返回持续登录授权，请重新登录');
      const account = await exchangeMinecraft(tokens.access_token, flow.controller.signal);
      assertActive(id, flow);
      await flow.onAuthorized({ account, refreshToken: tokens.refresh_token });
      assertActive(id, flow);
      cancelLogin(id);
      return { ok: true };
    } catch (error) {
      if (pending.get(id) !== flow || flow.controller.signal.aborted) throw new Error('本次登录已取消或过期，请重新登录');
      if (error instanceof OAuthError && ['authorization_pending', 'slow_down'].includes(error.code)) {
        assertActive(id, flow);
        if (error.code === 'slow_down') flow.interval += 5;
        flow.nextPoll = now() + flow.interval * 1000;
        return { pending: true, interval: flow.interval, phase: 'waiting' };
      }
      cancelLogin(id);
      throw error;
    }
  }
  async function pollLogin(id) {
    const flow = pending.get(id);
    if (!flow) throw new Error('本次登录已取消或过期，请重新登录');
    assertActive(id, flow);
    // Concurrent polls share a single request and binding. Early polls never
    // increase the request rate imposed by Microsoft.
    if (flow.inFlight) return flow.inFlight;
    if (now() < flow.nextPoll) return { pending: true, interval: Math.max(1, Math.ceil((flow.nextPoll - now()) / 1000)), phase: flow.phase };
    flow.inFlight = exchangeFlow(id, flow).finally(() => { flow.inFlight = null; });
    return flow.inFlight;
  }
  async function refreshAccount(refreshToken) {
    if (!configured || !refreshToken) throw new Error('Microsoft 登录已失效，请重新登录');
    const data = await form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope });
    return { account: await exchangeMinecraft(data.access_token), refreshToken: data.refresh_token || refreshToken };
  }
  async function getAppearance(account) {
    if (!account?.accessToken) throw new Error('请先登录 Microsoft 正版账户');
    const profile = await read('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${account.accessToken}` } });
    if (profile.id !== account.uuid) throw new Error('账户已更改，请重新登录后获取外观');
    return profileAppearance(profile);
  }
  async function setSkin(account, { variant, data, url, reset = false }) {
    if (!account?.accessToken) throw new Error('请先登录 Microsoft 正版账户');
    const endpoint = 'https://api.minecraftservices.com/minecraft/profile/skins';
    const headers = { Authorization: `Bearer ${account.accessToken}` };
    if (reset) return read(endpoint + '/active', { method: 'DELETE', headers });
    if (!['classic', 'slim'].includes(variant)) throw new Error('请选择经典或纤细手臂模型');
    let body;
    if (data) {
      body = new FormData(); body.append('variant', variant);
      body.append('file', new Blob([data], { type: 'image/png' }), 'skin.png');
    } else {
      if (!account.skins?.some(skin => skin.url === url)) throw new Error('请先获取当前账户的皮肤');
      headers['Content-Type'] = 'application/json'; body = JSON.stringify({ variant, url });
    }
    return read(endpoint, { method: 'POST', headers, body });
  }
  async function setCape(account, capeId) {
    if (!account?.accessToken) throw new Error('请先登录 Microsoft 正版账户');
    const headers = { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' };
    if (capeId === null) return read('https://api.minecraftservices.com/minecraft/profile/capes/active', { method: 'DELETE', headers });
    if (!account.capes?.some(cape => cape.id === capeId)) throw new Error('只能装备当前账户已拥有的披风');
    return read('https://api.minecraftservices.com/minecraft/profile/capes/active', { method: 'PUT', headers, body: JSON.stringify({ capeId }) });
  }
  return { configuration, startLogin, pollLogin, cancelLogin, refreshAccount, getAppearance, setSkin, setCape, close };
}

export async function resolveLaunchAccount(settings, account, refreshToken, refresh) {
  if (settings.loginMode === 'offline') return { account: null };
  if (!account?.accessToken) throw new Error('请先在设置中完成 Microsoft 正版登录，或切换为离线登录');
  if (!Number.isFinite(account.expiresAt) || account.expiresAt <= Date.now() + 60000) return refresh(refreshToken);
  return { account };
}
