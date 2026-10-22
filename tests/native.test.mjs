import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';

test('原生服务不加载网页，验证会话凭据，并支持状态事件与设置写入', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cqu-native-api-'));
  const service = await createServer({ root, apiToken: 'native-test-session' });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { service.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer native-test-session' };
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memory: 6144 }) })).status, 401);
  assert.equal(service.store.data.settings.memory, 4096);
  const page = await fetch(base, { headers }); assert.equal(page.status, 404); assert.match(page.headers.get('content-type'), /json/);
  const events = await fetch(base + '/api/events', { headers });
  const reader = events.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /^data: /); assert.equal(JSON.parse(initial.slice(6)).settings.memory, 4096);
  const updated = await fetch(base + '/api/settings', { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ memory: 6144, playerName: 'Native_QA' }) }); assert.equal(updated.status, 200);
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.equal(JSON.parse(event.slice(6)).settings.memory, 6144); assert.equal(JSON.parse(event.slice(6)).settings.playerName, 'Native_QA');
  await reader.cancel();
  const foreign = await fetch(base + '/api/state', { headers: { ...headers, Origin: 'https://example.com' } }); assert.equal(foreign.status, 403);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'launcher.json'))).settings.memory, 6144);
});
