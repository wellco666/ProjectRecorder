# 个推多厂商推送：一个 APK 覆盖常见安卓品牌

> 项目已集成一个 APK 所需的个推 SDK、常见国内厂商适配器和任务推送云函数。
> 但“SDK 已集成”不等于“所有品牌离线通道已开通”；厂商应用参数、个推后台配置、
> Supabase Webhook 都要齐全并实机验证。

随时运行这句看还差什么：

```powershell
cd E:\miniSoftware\ProjectRecorder\mobile
node check-getui-setup.js
```

---

## 现成的东西（我已核对）

| 部件 | 位置 |
|---|---|
| 一个 APK：个推 + 小米/OPPO/vivo/华为/荣耀/魅族 + UPS（坚果/索尼/海信） | `android/app/build.gradle` |
| 原生插件 | `GetuiPushPlugin.java`、`GetuiPushIntentService.java` |
| 客户端（取 CID → 上报） | `notify.js` |
| 数据库表 | `sql/getui-push.sql` |
| 推送云函数 | `supabase/functions/getui-task-event/index.ts` |

---

# 第 1 件：个推后台建应用

## 要做什么

打开 **https://dev.getui.com** → 注册/登录 → **创建应用**

```
应用名称   项目记录器
包名       com.cj.projectrecorder     ← 必须一模一样
```

创建后进入应用详情，**记下这两个值**（下一步要用）：

| 名称 | 在哪 |
|---|---|
| **AppID** | 应用配置页 |
| **AppKey** | 应用配置页 |

> **MasterSecret 也在这里，但先别用**——它只填到 Supabase 服务端（第 3 件）。
> **绝对不要放进 apk，也不要发到聊天里。**

---

# 第 2 件：开通并填写常见品牌通道（一条命令）

如果目标是后台/熄屏尽可能覆盖主流国内品牌，不能只填个推参数。请分别在
小米、OPPO、vivo、华为、荣耀、魅族开发者平台创建相同包名的应用、开通推送，
再把各平台参数登记到个推应用的厂商通道配置中。个推 UPS 还覆盖坚果、索尼、海信，
这几类不需要额外厂商 AppID。不同品牌的审核、签名证书、消息分类和额度规则可能不同。

同一个 APK 会按设备使用可用的通道，不需要每个品牌单独打包；但不在适配范围内的机型、
用户强行停止/关闭通知、断网或厂商后台限制，无法承诺必达。屏幕熄灭时系统可以展示锁屏通知，
但普通任务消息不能保证强制点亮屏幕。

```powershell
cd E:\miniSoftware\ProjectRecorder\mobile
powershell -File setup-push-params.ps1
```

**它会逐个问你**，你粘贴第 1 步拿到的值即可：

```
个推 AppID [必填]        ← 粘贴
个推 AppKey [必填]       ← 粘贴
vivo AppID               ← 填 vivo 推送平台的值
vivo AppKey              ← 填 vivo 推送平台的值
...（其余已接入厂商都填；UPS 无需另填）
```

上面示例中的“跳过”仅适合暂时没有该厂商账号的情况。要覆盖所有已集成的常见品牌，
每个品牌都要填入真实参数，并在个推控制台启用对应通道；缺一个就代表该品牌离线通道未开通。
填入参数后需重新构建并安装同一个 APK。

**为什么只填一次就够**：脚本写进
`C:\Users\你\.gradle\gradle.properties`，
这个文件不在项目里、不会被提交、也不会打进 apk。

---

# 第 3 件：Supabase 服务端（这步是"真正能推"的关键）

前面两步让手机**能被个推识别**；这一件让**服务器知道要推给谁**。

## 3.1 建表

Supabase → **SQL Editor** → 新建查询 → 粘贴 `sql/getui-push.sql` 的内容 → **Run**

```powershell
Get-Content E:\miniSoftware\ProjectRecorder\mobile\sql\getui-push.sql -Raw | Set-Clipboard
```

## 3.2 部署云函数

**先装 Supabase CLI**（只需一次）：

```powershell
npm install -g supabase
```

**关联项目 + 设置密钥 + 部署**：

```powershell
cd E:\miniSoftware\ProjectRecorder\mobile

# 关联（会打开浏览器让你登录并选项目）
supabase link --project-ref edchntmyqqjqvpngylgc

# 设置 4 个服务端密钥 —— 值自己填，别发给我
supabase secrets set `
  GETUI_APP_ID="个推 AppID" `
  GETUI_APP_KEY="个推 AppKey" `
  GETUI_MASTER_SECRET="个推 MasterSecret" `
  TASK_EVENT_WEBHOOK_SECRET="自己编一段长随机串"

# 部署
supabase functions deploy getui-task-event
```

> **`TASK_EVENT_WEBHOOK_SECRET` 是什么**：防止别人乱调你的推送函数。
> 自己编一段够长的随机串（比如 40 位），**下一步要用一模一样的值**。
> 生成方法：
> ```powershell
> -join ((1..40) | ForEach-Object { "abcdefghijklmnopqrstuvwxyz0123456789"[(Get-Random -Max 36)] })
> ```

## 3.3 配 Webhook（事件一产生就推送）

Supabase Dashboard → **Database → Webhooks** → **Create a new hook**

```
名称     getui-task-event
表       public.task_events
事件     Insert          ← 只勾这一个
类型     HTTP Request
方法     POST
URL      https://edchntmyqqjqvpngylgc.supabase.co/functions/v1/getui-task-event

HTTP Headers
  x-webhook-secret = 上一步那串随机值（必须完全相同）
```

---

# 第 4 件：重新打包和逐品牌验证

```powershell
cd E:\miniSoftware\ProjectRecorder\mobile
node check-getui-setup.js      # 确认没有 [待办] 了
npm run apk
```

装到手机后：**员工和老板都要打开 App 并同意推送**（会弹隐私提示）。

---

# 怎么验证成功

| 检查 | 在哪看 | 应该看到 |
|---|---|---|
| 设备登记了 | Supabase → Table Editor → `push_devices` | 有 CID，`profile_id` 是登录的人 |
| 推送发出去了 | Supabase → Edge Functions → `getui-task-event` → Logs | 有调用记录 |
| 实际效果 | 另一个账号派任务 | 手机弹通知 |

至少用一台相应品牌手机逐项测试：前台 / 切到别的软件 / 锁屏 / 划掉 App。
在每台测试手机上开启通知、横幅和锁屏显示，并按厂商要求允许自启动、后台运行和电池使用。
“强行停止”与划掉最近任务不同；系统可能在强行停止后阻止推送，直到重新打开应用。

---

# 两个坑（提前说，省得白折腾）

**① 华为离线推送**
华为要额外在 AppGallery Connect 配应用和签名，还要放
`agconnect-services.json`。**调试包（debug apk）验证不了华为离线推送**——
这条只有正式签名包才能测。

**② 在设置里"强行停止"App**
安卓会**暂停**这个 App 的推送，直到你重新打开一次。
这不是 bug，是系统行为。

---

# 关于密钥的规矩

| 值 | 放哪 | 能不能发出去 |
|---|---|---|
| AppID / AppKey | `gradle.properties` | ⚠️ 会打进 apk，但本身是公开信息 |
| **MasterSecret** | **只放 Supabase 云函数密钥** | ❌ **绝不能进 apk / 聊天** |
| Webhook 随机串 | Supabase 密钥 + Webhook 请求头 | ❌ 不发 |
| service_role key | Supabase 自带，云函数自动读 | ❌ 不发 |

**我不会问你要任何密钥。** 你自己填就行；填完我帮你检查配置、打包、验证接收链路。
