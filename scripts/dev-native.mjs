import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
execFileSync(process.execPath, [path.join(root, 'scripts/build-native.mjs'), '--dev'], { stdio: 'inherit', cwd: root });
const child = spawn(path.join(root, '.build-cache/CQU-PCL-Native-dev.exe'), ['--workspace', root], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, CQU_PCL_NODE: process.execPath } });
child.on('exit', code => process.exit(code || 0));
child.on('error', error => { console.error(error.message); process.exit(1); });
