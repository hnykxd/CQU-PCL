# CQU PCL

Windows Minecraft 启动器（原生版）。界面为 C# / WPF，图标与标志采用奶蛙医学院校徽；不加载 Electron、WebView2 或网页，游戏安装与启动继续由 Node / XMCL 引擎完成。

支持独立世界目录、Minecraft / Fabric / Forge / Quilt / NeoForge 安装与启动、Modrinth 整合包与模组、CurseForge ZIP 导入、更新检查、下载取消与重试、Microsoft 正版登录、离线角色、皮肤和披风预览及 PNG 保存。基岩版提供官方服务端 ZIP 下载与目录入口，需解压后按官方说明运行。

下载任务显示当前文件、实时网速、累计接收量与连接数。可以取消或删除任务；删除进行中的任务会先停止全部下载并等待清理完成，再移除记录，保留世界与已下载文件。设置中的「并行下载文件数」控制文件并发，大于等于 4 MB 的文件按下载源能力自动使用最多 4 个分段连接，逐段重试并在校验通过后启用；不支持 Range 的服务自动回退普通下载。

本地 `game/mods` 文件夹会在启动、读取状态和界面运行期间自动扫描，也可在世界设置中手动刷新。支持 Fabric、Quilt、Forge、NeoForge 和旧 Forge 描述文件，显示名称、版本和禁用状态；没有描述或损坏的 JAR 仍列出并标注原因，首页计数只包含已识别且启用的模组。目录按钮由 WPF 调用 Windows Shell 打开，并显示路径不存在或打开失败的错误。

下载源默认使用 [BMCLAPI](https://bmclapidoc.bangbang93.com/) 镜像，按镜像站的路径映射转发版本清单、版本 JSON、游戏本体、资源、运行库、Forge / NeoForge / Fabric / Quilt Maven 与 Mojang Java 运行环境；镜像不可用或校验不符时自动回退 Mojang、Forge、Fabric、Quilt、NeoForge 官方站点，并可在设置中改回「Minecraft 官方源」。

要求 Windows 10/11 x64、.NET Framework 4.8。开发和构建使用 Node.js 24；构建脚本使用 Windows 自带 C# 编译器，无需安装 .NET SDK。

```powershell
npm install
npm run dev
npm run dist
```

`npm run dev` 启动 WPF 开发版；`npm run dist` 生成 `release/CQU-PCL-Native.exe`。直接运行 exe，旁边的 `.exe.config` 建议一起保留。程序包含界面、校徽、图标和引擎，首次启动会把 Node 解包到 `%LOCALAPPDATA%/CQU-PCL/runtime/`。

Microsoft 正版登录使用发布者自己的 Azure 应用 **CQU PCL**（客户端 ID：`你猜猜是什么`），采用 OAuth 2.0 v2.0 设备码流：在系统浏览器输入验证码授权，切换页面后仍会继续等待；凭据使用 Windows DPAPI 加密保存。从旧版升级后，请重新登录以取得新应用的授权。账户页可获取、预览及保存官方皮肤和已拥有的披风。配置与验证说明见 [Microsoft 登录配置](docs/MICROSOFT_SETUP.md)。

```powershell
npm test
npm run test:native
node scripts/test-native.mjs --packaged
npm run test:single-instance
```

原生测试使用隔离目录和模拟服务，不修改真实账户、世界，也不下载游戏。截图与报告保存在 `.build-cache/native-qa-*/native-qa/`；实际微软授权与真实游戏下载仍需要联网验证。

数据保存在 exe 旁的 `CQU-PCL-Data/`，开发版继续使用 `.cqu-pcl/`。可通过 `CQU_PCL_DATA_OVERRIDE` 指定数据目录。`.launcher-instance.lock` 是程序自动维护的占用文件，正常或异常退出后均由 Windows 释放占用，无需手动删除。

架构、单实例保护、QA 范围与后续方向见 [原生重构说明](docs/NATIVE_REFACTOR.md)。

程序源图保存在 `public/brand/naiwa-university.jpg`。重新生成透明圆形标志与多尺寸 Windows 图标：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-brand-assets.ps1 -Source "路径/校徽.jpg"
```
