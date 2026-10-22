import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
await build({ entryPoints: [path.join(root, 'server/engine-entry.mjs')], outfile: path.join(root, 'server/vendor/engine.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['undici'], alias: { '@xmcl/core/utils': path.join(root, 'server/core-utils.mjs') }, legalComments: 'linked' });
console.log('Minecraft 安装与启动引擎已构建');
