# 厂商推送通道：就剩这些

> **目标**：一个 APK 覆盖常见品牌。同一个包根据手机品牌自动挑通道，**不用按品牌分别打包**。

---

## 已经做好的（不用再动）

| 项目 | 状态 |
|---|---|
| 个推应用（AppID / AppKey 已填进本机） | ✅ |
| Supabase 4 个密钥（含 `TASK_EVENT_WEBHOOK_SECRET`） | ✅ 已核对 |
| `push_devices` 表 | ✅ |
| `getui-task-event` 云函数（已部署） | ✅ |
| 数据库 Webhook（`task_events` INSERT） | ✅ |
| 通知渠道 `pr-alerts-v1`（级别 4，弹横幅） | ✅ |
| **真机实测推送 + 横幅** | ✅ 已验证 |

**个推在线通道已经能用了。** 下面这些是给「App 被划掉 / 系统深度休眠」时加保险。

---

## 第 1 步：先建正式签名（**必须排在厂商注册之前**）

```powershell
cd E:\miniSoftware\ProjectRecorder\mobile
powershell -File make-release-keystore.ps1
```

**为什么必须先做**：华为、荣耀注册时要填**签名证书指纹**。先用 debug 签名注册、以后换成正式签名 → **所有厂商注册全部失效，要重来**。

脚本会：
- 生成 `android/app/release.keystore`
- 生成 `android/app/keystore.properties`（已在 `.gitignore` 里）
- **打印 SHA-256**（华为/荣耀要填这个）

> ⚠️ **把这两个文件备份好**。丢了就永远发不了这个 App 的更新。

---

## 第 2 步：各厂商后台注册应用

**包名一律填**：

```
com.cj.projectrecorder
```

| 品牌 | 去哪注册 | 要拿的参数 | 本机要填 |
|---|---|---|---|
| **vivo** | [dev.vivo.com.cn](https://dev.vivo.com.cn) → 推送 | AppID、AppKey | `VIVO_APP_ID`<br>`VIVO_APP_KEY` |
| **小米** | [dev.mi.com](https://dev.mi.com) → 推送 | AppID、AppKey | `XIAOMI_APP_ID`<br>`XIAOMI_APP_KEY` |
| **OPPO** | [open.oppomobile.com](https://open.oppomobile.com) → 推送 | AppKey、AppSecret | `OPPO_APP_KEY`<br>`OPPO_APP_SECRET` |
| **华为** | [developer.huawei.com](https://developer.huawei.com) → Push Kit | AppID **+ 签名 SHA-256** | `HUAWEI_APP_ID` |
| **荣耀** | [developer.honor.com](https://developer.honor.com) → 推送 | AppID **+ 签名 SHA-256** | `HONOR_APP_ID` |
| **魅族** | [open.flyme.cn](https://open.flyme.cn) → 推送 | AppID、AppKey | `MEIZU_APP_ID`<br>`MEIZU_APP_KEY` |

**坚果 / 索尼 / 海信**：走个推 UPS，**不用填**。

> 各平台可能要开发者认证、应用审核、上架。**以页面提示为准**，先拿参数。

---

## 第 3 步：在个推后台登记厂商参数

个推开发者中心 → 「项目记录器」→ **配置管理 → 应用配置**

1. 确认包名是 `com.cj.projectrecorder`
2. 把第 2 步拿到的厂商参数逐个填进去
3. 保存后**开启对应厂商通道**
4. 检查**没有设静默时段**（设了的话离线推送会被压住）

**厂商参数在个推后台登记 + 本机也填** —— 两边都要，缺一边该品牌就不走离线通道。

---

## 第 4 步：填进本机

```powershell
cd E:\miniSoftware\ProjectRecorder\mobile
powershell -File setup-push-params.ps1
```

**每个提示都会告诉你值从哪来**，照着一项项填（还没有的直接回车跳过）。

填完会显示品牌覆盖：

```
=== Brand coverage ===
  vivo     ready
  Xiaomi   ready
  OPPO     half done, still needs: OPPO_APP_SECRET
  Huawei   not configured
  Honor    not configured
  Meizu    not configured

  2 of 6 brands have an offline channel.
```

**脚本只显示「已设置（N 字符）」，不会把值打出来。**

写进：`C:\Users\cj\.gradle\gradle.properties`（不在项目里、不会提交）

> ⚠️ **MasterSecret 不要填进这个文件**（它只放 Supabase）。脚本连问都不会问。

---

## 第 5 步：告诉我，我来构建

**填好后跟我说「本机参数已填好」**，我：
1. 检查配置
2. 重新构建签名 APK
3. 装机验证

**你自己不用打包。**

---

## 第 6 步：逐品牌测试（装好之后）

每台手机都要做：

```
① 登录老板/员工账号，接受 App 内的推送授权
② 系统设置里允许通知，打开「横幅/悬浮通知」和「锁屏通知」
③ 允许「自启动、后台运行、后台耗电」
   vivo：设置里搜「自启动」和「后台耗电管理」
④ 让老板派个新任务，分别测：
     前台 → 切到别的软件 → 锁屏 → 从最近任务划掉
```

**两个注意**：

| 注意 | 说明 |
|---|---|
| **别用「设置里的强行停止」** | 那和「划掉最近任务」不一样。强行停止后 Android 会拦截推送，直到你重新打开 App |
| 通知栏有消息但没横幅 | 检查该品牌手机上「任务提醒」这个渠道是否允许弹出 |

**黑屏时能显示锁屏通知，但不保证强制点亮屏幕**（系统限制，普通消息做不到）。

---

## 随时自查

```powershell
node check-getui-setup.js
```

会报：本机参数、品牌覆盖、Supabase 侧状态。

---

## 出问题时用的工具

| 命令 | 用途 |
|---|---|
| `node test-push.js 54dcec9d-3bd5-4798-a123-36bd4f843f16 assigned "标题"` | 手动发一条测试推送 |
| `node check-push-channel.js` | 查渠道级别对不对（排「不弹横幅」） |
| `node check-getui-function.js` | 云函数部署前检查 |
