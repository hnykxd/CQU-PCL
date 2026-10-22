import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const development = process.argv.includes('--dev');
if (process.platform !== 'win32') throw new Error('WPF 原生版需要在 Windows 上构建。');
const cache = path.join(root, '.build-cache');
const output = path.join(cache, 'native-payload');
await fs.mkdir(cache, { recursive: true });
const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
await fs.access(compiler).catch(() => { throw new Error('请安装 .NET Framework 4.8（包含 Windows WPF 与 C# 编译器）。'); });
const resourceArgs = [];
if (!development) {
  // Clean only this verified staging directory so old WebView/React files never enter the package.
  if (path.dirname(output) !== cache || path.basename(output) !== 'native-payload') throw new Error('无效的构建缓存目录');
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, 'server'), { recursive: true });
  await build({ entryPoints: [path.join(root, 'native/backend.mjs')], outfile: path.join(output, 'server/backend.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: true, banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" } });
  await fs.copyFile(path.join(root, 'server/microsoft-app.json'), path.join(output, 'server/microsoft-app.json'));
  await fs.copyFile(process.execPath, path.join(output, 'node.exe'));
  await fs.copyFile(path.join(root, 'public/icon.ico'), path.join(output, 'icon.ico'));
  await fs.copyFile(path.join(root, 'server/vendor/engine.cjs.LEGAL.txt'), path.join(output, 'server/engine.LEGAL.txt'));
  await fs.copyFile(path.join(root, 'node_modules/adm-zip/LICENSE'), path.join(output, 'server/adm-zip.LICENSE.txt'));
  await fs.copyFile(path.join(root, 'node_modules/express/LICENSE'), path.join(output, 'server/express.LICENSE.txt'));
  await fs.copyFile(path.join(root, 'node_modules/undici/LICENSE'), path.join(output, 'server/undici.LICENSE.txt'));
  const zip = new AdmZip(); zip.addLocalFolder(output); zip.writeZip(path.join(cache, 'native-payload.zip'));
  resourceArgs.push('/resource:' + path.join(cache, 'native-payload.zip') + ',payload.zip');
}
const binary = path.join(root, development ? '.build-cache/CQU-PCL-Native-dev.exe' : 'release/CQU-PCL-Native.exe');
await fs.mkdir(path.dirname(binary), { recursive: true });
const sources = (await fs.readdir(path.join(root, 'native/wpf'))).filter(name => name.endsWith('.cs')).map(name => path.join(root, 'native/wpf', name));
const references = ['System.dll', 'System.Core.dll', 'System.Security.dll', 'System.Web.Extensions.dll', 'System.Net.Http.dll', 'System.Xaml.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'].map(name => path.join(framework, name));
references.push(...['WindowsBase.dll', 'PresentationCore.dll', 'PresentationFramework.dll'].map(name => path.join(framework, 'WPF', name)));
execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', '/win32manifest:' + path.join(root, 'native/wpf/app.manifest'), '/win32icon:' + path.join(root, 'public/icon.ico'), '/out:' + binary, '/resource:' + path.join(root, 'native/wpf/Shell.xaml') + ',Shell.xaml', '/resource:' + path.join(root, 'public/brand/logo.png') + ',brand-logo.png', ...resourceArgs, ...references.map(name => '/reference:' + name), ...sources], { stdio: 'inherit', cwd: root });
await fs.writeFile(binary + '.config', '<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup><runtime><AppContextSwitchOverrides value="Switch.System.Windows.DoNotScaleForDpiChanges=false"/></runtime></configuration>');
console.log(`WPF 原生版已构建：${binary} (${((await fs.stat(binary)).size / 1024 ** 2).toFixed(1)} MB)`);
if (!development) console.log('仅包含 WPF 界面和 Node 游戏引擎，不包含 Electron、WebView2 或网页资源。');
