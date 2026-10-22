# Microsoft 正版登录：OAuth 2.0 v2.0 设备码流

玩家流程：**点击登录 → 在 Microsoft 网页输入启动器显示的验证码 → 登录并授权 → 自动绑定 Minecraft Java 账户**。使用系统浏览器，无需注册 localhost 回调 URI 或部署授权服务器。启动器自身的本机 HTTP 服务仍用于桌面界面。

## 当前配置

`server/microsoft-app.json` 内置发布者自己的 Azure 应用。发布者于 2026-10-22 确认该应用已通过 Minecraft 应用审核：

```json
{
  "displayName": "CQU PCL",
  "clientId": "此处填写你自己Azure AppID"
}
```

scope 为 `XboxLive.signin offline_access`。客户端 ID 是公共标识，不需要客户端密钥。Microsoft 授权页的应用名称由 Azure 注册决定，应显示 **CQU PCL**；JSON 中的 `displayName` 用于记录应用信息，不会覆盖 Microsoft 授权页的名称。

2026-10-21 的真实账户验证使用的是旧第三方应用，其结果不能作为当前 CQU PCL 应用的在线验证结果。新应用仍需用真实账户验证 Microsoft → Xbox → XSTS → Minecraft 的完整认证链。

2026-10-22 已用当前内置 ID 调用 Microsoft v2.0 设备码接口，返回 HTTP 200、验证网址 `https://www.microsoft.com/link`、5 秒轮询间隔和 900 秒有效期。脱敏结果保存在 `.build-cache/cqu-pcl-devicecode-check.json`，未保存设备码、用户验证码或令牌；此检查尚未完成真实账户授权。


开发时可以覆盖 ID：

```powershell
$env:CQU_PCL_MICROSOFT_CLIENT_ID = '实际公共客户端 ID'
npm run dev
```

正式发布修改 `server/microsoft-app.json` 后重新打包，玩家无需输入 ID。`CQU_PCL_MICROSOFT_CLIENT_ID` 环境变量优先于内置配置；使用正式应用时应移除旧的开发覆盖值。切换 ID 后，旧应用颁发的 refresh token 不能用于新应用，请在账户页重新登录；登录成功后会替换已保存的凭据。

## 协议实现

1. POST `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`，表单字段为 `client_id`、`scope`，发送 `Content-Type: application/x-www-form-urlencoded` 和 `Accept: application/json`。
2. 启动器显示 `user_code` 和服务返回的可信 `verification_uri`。`device_code` 留在后端内存，不返回界面、不存盘。
3. 按响应 `interval` 轮询 `/consumers/oauth2/v2.0/token`，字段为 `client_id`、`grant_type=urn:ietf:params:oauth:grant-type:device_code`、`device_code`。
4. `authorization_pending` 继续等待；`slow_down` 将后续间隔增加 5 秒；拒绝、过期和取消终止本次流程。并发轮询共享一次令牌交换，早于指定间隔的轮询不发送上游请求。
5. 获得 Microsoft 令牌后，Xbox 用户认证继续使用 `RpsTicket: d=<access_token>`。XSTS 使用 `RETAIL` 和 `rp://api.minecraftservices.com/`，Minecraft 使用 `XBL3.0 x=<uhs>;<XSTS token>`，均保持原认证链。
6. 校验 Minecraft Java 档案后保存账户和 refresh token，自动获取皮肤及已拥有披风。关闭账户弹窗或切换界面仍继续等待；取消、退出账户或切换离线登录会终止流程。

## 构建与验证

```powershell
npm test
npm run dist
npm run test:native
node scripts/test-native.mjs --packaged
```

便携版输出到 `release/`，账户数据在 exe 旁的 `CQU-PCL-Data/`。原生版通过 DPAPI 加密保存 access token 和 refresh token；跨电脑或 Windows 用户移动数据后应重新登录。

发布前用拥有 Java 版且已创建角色的个人 Microsoft 账户完成一次真实登录、退出和重启后的游戏启动。自动化测试模拟上游服务，不能替代在线验证。

## 错误诊断

| 提示 | 检查项 |
| --- | --- |
| 登录服务尚未开通 | 内置 ID 是否有效，是否重新构建 |
| `invalid_client` / `unauthorized_client` | ID 是否支持个人账户和公共客户端设备码流 |
| 验证码已过期 / 失效 | 重新申请设备码 |
| `Invalid app registration` | Minecraft 服务未接受当前应用注册，查看服务器指定的 https://aka.ms/AppRegInfo |
| 其他 Minecraft HTTP 403 | 检查账户访问限制及服务状态；不能仅凭 403 断定审核问题 |
| 没有 Java 版档案 | 确认游戏所有权或有效订阅，并创建角色 |
| Xbox 档案 / 家庭限制 | 在 xbox.com 完成档案设置或由监护人授权 |

若使用自行注册的应用，Minecraft 新应用准入说明见 https://help.minecraft.net/hc/en-us/articles/16254801392141 ，申请入口 https://aka.ms/mce-reviewappid 。设备码流本身不会授予 Minecraft API 准入。
