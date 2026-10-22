import { createServer } from '../server/index.mjs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
const host = process.env.CQU_PCL_HOST;
const crypto = (mode, input) => {
  const result = spawnSync(host, ['--crypto', mode], { input, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error('账户加密信息无法读取，请重新登录');
  return result.stdout.trim();
};
// WPF transfers a non-inheritable directory-lock handle before granting startup.
// If the host dies during that transfer, no configuration/install work begins.
let hostClosed = false;
process.stdin.once('end', () => { hostClosed = true; });
if (process.env.CQU_PCL_WAIT_FOR_HOST === '1') {
  const input = createInterface({ input: process.stdin });
  await new Promise(resolve => {
    const stopped = () => process.exit(0);
    input.once('close', stopped);
    input.once('line', line => { if (line !== 'CQU_START') process.exit(1); input.removeListener('close', stopped); resolve(); });
  });
}
const service = await createServer({ apiToken: process.env.CQU_PCL_API_TOKEN, root: process.env.CQU_PCL_DATA,
  protectSecret: value => value ? 'dpapi:' + crypto('encrypt', value) : '',
  revealSecret: value => value?.startsWith('dpapi:') ? crypto('decrypt', value.slice(6)) : value?.startsWith('encrypted:') ? '' : value || '',
  openPath: target => new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.WINDIR || 'C:/Windows', 'explorer.exe'), [path.resolve(target)], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  }),
  onAccountBound: () => console.log('CQU_FOCUS')
});
const server = service.app.listen(0, '127.0.0.1', () => console.log('CQU_READY http://127.0.0.1:' + server.address().port));
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  service.close(); server.close();
  for (const job of service.jobs.public()) if (['queued', 'running'].includes(job.status)) service.jobs.cancel(job.id);
  // Keep the duplicated directory ownership until cancellation and final writes finish.
  await service.jobs.tail;
  await service.store.save();
  process.exit(0);
};
process.on('SIGTERM', close); process.on('SIGINT', close);
process.stdin.resume(); process.stdin.on('end', close);
if (hostClosed) await close();
