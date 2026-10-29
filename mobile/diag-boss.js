/* =============================================================
   看看真实数据：老板 19155025818 名下的员工、任务、事件。

   只读。用来判断"通知为什么不弹"：
     · 压根没有任务 → 不是通知坏了，是还没派过任务
     · 有任务但没 assigned 事件 → 触发器没生效
     · 有事件 → 通知链路的数据侧是通的，问题在手机端

   用法：
     node diag-boss.js            （默认查 19155025818）
     node diag-boss.js 手机号 密码
   ============================================================= */
"use strict";

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";

const CODE = process.argv[2] || "19155025818";
const PASS = process.argv[3] || "";

async function api(method, path, token, body, prefer) {
  const headers = {
    apikey: ANON,
    "Content-Type": "application/json",
    Authorization: "Bearer " + (token || ANON),
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(BASE + path, {
    method: method, headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, data: data, text: text };
}

async function main() {
  console.log("=".repeat(62));
  console.log("查老板账号：" + CODE);
  console.log("=".repeat(62));

  if (!PASS) {
    console.log("\n没给密码。用法：node diag-boss.js 手机号 密码");
    console.log("（我不会瞎试密码——上次瞎探测把账号建到你库里了。）");
    return 1;
  }

  const login = await api("POST",
    "/auth/v1/token?grant_type=password", null,
    { email: CODE + "@boss.pr", password: PASS });
  if (!login.data || !login.data.access_token) {
    console.log("\n登录失败：" + JSON.stringify(login.data).slice(0, 160));
    return 1;
  }
  const token = login.data.access_token;
  const me = login.data.user.id;
  console.log("\n登录成功，id=" + me.slice(0, 8) + "…");

  /* 员工 */
  const profiles = await api("GET",
    "/rest/v1/profiles?select=id,code,name,role,boss_id&order=code", token);
  const rows = Array.isArray(profiles.data) ? profiles.data : [];
  const staff = rows.filter(r => r.role === "employee");
  console.log("\n【员工】" + staff.length + " 个");
  staff.slice(0, 12).forEach(s => console.log("  " + s.code
    + "  " + s.name));

  /* 任务 */
  const tasks = await api("GET",
    "/rest/v1/tasks?select=id,title,employee_id,plan_date,project_name"
    + "&order=created_at.desc&limit=10", token);
  const taskRows = Array.isArray(tasks.data) ? tasks.data : [];
  console.log("\n【任务】" + taskRows.length + " 条");
  const byId = {};
  rows.forEach(r => { byId[String(r.id)] = r.code; });
  taskRows.forEach(t => console.log("  " + String(t.plan_date).slice(0, 10)
    + "  " + String(t.title).slice(0, 18).padEnd(20)
    + " → " + (byId[String(t.employee_id)] || "？（不在我名下）")));

  /* 事件 */
  const events = await api("GET",
    "/rest/v1/task_events?select=id,kind,title,employee_id,created_at"
    + "&order=created_at.desc&limit=15", token);
  const evRows = Array.isArray(events.data) ? events.data : [];
  console.log("\n【事件】" + evRows.length + " 条"
    + (events.status >= 400 ? "  HTTP " + events.status : ""));
  evRows.forEach(e => console.log("  " + String(e.created_at).slice(0, 19)
    + "  " + String(e.kind).padEnd(9) + String(e.title).slice(0, 16)));

  /* 工时 */
  const logs = await api("GET",
    "/rest/v1/worklogs?select=id,work_date,hours,content&limit=10", token);
  const logRows = Array.isArray(logs.data) ? logs.data : [];
  console.log("\n【工时】" + logRows.length + " 条");

  /* 判定 */
  console.log("\n" + "=".repeat(62));
  console.log("判定");
  console.log("=".repeat(62));
  if (!staff.length) {
    console.log("  ✗ 一个员工都没有 —— 先建员工账号，不然没法派任务");
  } else if (!taskRows.length) {
    console.log("  ✗ 有员工但**一条任务都没派过** ——");
    console.log("    那就没有 assigned 事件，通知当然不弹。");
    console.log("    先去「团队 → 派任务」派一条，再看员工手机。");
  } else if (!evRows.length) {
    console.log("  ✗ 有任务但**没有事件** —— 触发器没生效，");
    console.log("    去 Supabase 跑 sql/migrate-notify.sql");
  } else {
    console.log("  ✓ 数据侧是通的：有任务、有事件");
    console.log("    那么【通知不弹】的问题在手机端，不是服务端。");
    const assigned = evRows.filter(e => e.kind === "assigned").length;
    const done = evRows.filter(e => e.kind === "done").length;
    console.log("    assigned（给员工看）: " + assigned + " 条");
    console.log("    done    （给老板看）: " + done + " 条");
  }
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("脚本异常：" + error.message);
  process.exitCode = 1;
});
