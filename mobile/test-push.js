/* =============================================================
   真实推送测试：直接调云函数，让它给手机推一条通知。

   ## 这测的是什么

   完整链路里，除了"数据库 Webhook 有没有触发"这一步，
   其余全部都会真的跑一遍：

     云函数鉴权 → 查 push_devices → 取个推 token
       → 调个推 REST → 个推推给手机 → 手机弹通知

   ## 为什么不用真的事件触发

   真触发需要往 task_events 插一行，那要用老板或员工的登录令牌，
   而我这里没有你的账号密码（也不该有）。

   所以直接构造 Webhook 会发的那种负载调云函数——
   **云函数收到的东西一模一样**，只有"谁调用它"不同。

   用法：
     node test-push.js <接收人的profile_id> [kind] [标题]

   例：
     node test-push.js 54dcec9d-3bd5-4798-a123-36bd4f843f16 assigned "测试任务"
   ============================================================= */
"use strict";

const crypto = require("crypto");

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const URL = BASE + "/functions/v1/getui-task-event";
const SECRET = process.env.WEBHOOK_SECRET
  || "4JZIkLj3GDFVUzNKwnDpZsQVoxQb5aDbGbvxGM3P7WPoPUJW";

const recipient = process.argv[2];
const kind = process.argv[3] || "assigned";
const title = process.argv[4] || "端到端推送测试";

if (!recipient) {
  console.log("用法: node test-push.js <接收人的profile_id> [kind] [标题]");
  console.log("");
  console.log("手机上的员工 uid（从之前的排查里知道）：");
  console.log("  54dcec9d-3bd5-4798-a123-36bd4f843f16");
  process.exit(1);
}

/* 云函数按 kind 决定收件人，所以这里要放对字段 */
const bossId = kind === "assigned"
  ? "00000000-0000-0000-0000-000000000000"   /* 测试用，云函数不看它 */
  : recipient;
const employeeId = kind === "assigned"
  ? recipient
  : "00000000-0000-0000-0000-000000000000";

const eventId = crypto.randomUUID();

/* Supabase 数据库 Webhook 发的就是这个形状 */
const payload = {
  type: "INSERT",
  table: "task_events",
  schema: "public",
  record: {
    id: eventId,
    boss_id: bossId,
    employee_id: employeeId,
    task_id: crypto.randomUUID(),
    kind: kind,
    title: title,
    hours: 2,
    work_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
  },
  old_record: null,
};

(async () => {
  console.log("=".repeat(62));
  console.log("真实推送测试");
  console.log("=".repeat(62));
  console.log("");
  console.log("  云函数  " + URL);
  console.log("  收件人  " + recipient);
  console.log("  类型    " + kind);
  console.log("  标题    " + title);
  console.log("");

  const started = Date.now();
  let res = null;
  let text = "";
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-secret": SECRET,
      },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (error) {
    console.log("  请求失败：" + error.message);
    process.exit(1);
  }

  console.log("  HTTP " + res.status + "   (" + (Date.now() - started) + " ms)");
  console.log("  " + text);
  console.log("");

  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }

  if (res.status === 401) {
    console.log("  ✗ 401：密钥不对");
    console.log("    云函数里的 TASK_EVENT_WEBHOOK_SECRET 和这个脚本用的不一致");
    process.exit(1);
  }

  if (json && typeof json.sent === "number") {
    if (json.sent > 0) {
      console.log("  ✓ 已提交给个推，" + json.sent + " 台设备");
      console.log("");
      console.log("  手机现在应该弹通知了（1～5 秒内）。");
      if (json.failures && json.failures.length) {
        console.log("  部分失败：" + json.failures.join(", "));
      }
    } else {
      console.log("  ⚠ 提交成功，但 0 台设备 —— 说明 push_devices 里没有这条记录");
      console.log("");
      console.log("  查一下：");
      console.log("    1. 手机 App 里同意过推送吗（设置里看 getui_push_registered）");
      console.log("    2. Supabase → Table Editor → push_devices 有没有行");
      console.log("    3. 那行的 profile_id 是不是 " + recipient);
      console.log("    4. notify_settings 里的开关有没有被关掉");
    }
  } else if (json && json.error) {
    console.log("  ✗ 云函数报错：" + json.error);
    console.log("    看 Supabase → Edge Functions → getui-task-event → Logs");
  } else if (json && json.ignored) {
    console.log("  ⚠ 负载被忽略了（type/table/id 对不上）");
  }
})();
