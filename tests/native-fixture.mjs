// Loaded only by scripts/test-native.mjs through NODE_OPTIONS, never bundled.
import fs from 'node:fs';
// Hold the real backend alive after its WPF host is killed to exercise ownership.
if (process.env.CQU_PCL_TEST_EXIT_MARKER) process.stdin.once('end', () => {
  fs.writeFileSync(process.env.CQU_PCL_TEST_EXIT_MARKER, 'host-closed');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
});
const realFetch = globalThis.fetch;
let tokenPolls = 0;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.includes('version_manifest_v2.json')) return reply({ latest: { release: '1.21.1' }, versions: [{ id: '1.21.1', type: 'release' }, { id: '1.20.1', type: 'release' }, { id: '24w14a', type: 'snapshot' }] });
  if (url.includes('meta.fabricmc.net')) return reply([{ loader: { version: '0.16.0' } }, { loader: { version: '0.15.0' } }]);
  if (url.includes('api.modrinth.com/v2/search')) return reply({ hits: [{ project_id: 'fixture-project', title: '奶蛙校园冒险', description: '原生界面兼容性测试项目。', author: 'NAIWA', downloads: 1929, project_type: url.includes('project_type%3Amodpack') ? 'modpack' : 'mod' }] });
  if (url.includes('api.modrinth.com/v2/project/')) return reply([{ id: 'fixture-version', version_number: '1.0', version_type: 'release', game_versions: ['1.21.1'], loaders: ['fabric'], date_published: '2026-10-21T00:00:00Z' }]);
  if (url.endsWith('/devicecode')) return reply({ device_code: 'private-fixture-device-code', user_code: 'NAIW-A1929', verification_uri: 'https://www.microsoft.com/link', expires_in: 900, interval: 1 });
  if (url.endsWith('/token')) {
    tokenPolls++;
    if (tokenPolls < 2) return reply({ error: 'authorization_pending' }, 400);
    return reply({ access_token: 'fixture-ms-token', refresh_token: 'fixture-refresh-token', expires_in: 3600 });
  }
  if (url.includes('user.auth.xboxlive.com')) return reply({ Token: 'fixture-xbox-token', DisplayClaims: { xui: [{ uhs: 'fixture-uhs' }] } });
  if (url.includes('xsts.auth.xboxlive.com')) return reply({ Token: 'fixture-xsts-token', DisplayClaims: { xui: [{ uhs: 'fixture-uhs' }] } });
  if (url.includes('authentication/login_with_xbox')) return reply({ access_token: 'fixture-minecraft-token', expires_in: 3600 });
  if (url.includes('entitlements/mcstore')) return reply({ items: [{ name: 'game_minecraft' }] });
  if (url.includes('/minecraft/profile')) return reply({ id: 'a'.repeat(32), name: 'Naiwa_Online', skins: [], capes: [] });
  return realFetch(input, options);
};
