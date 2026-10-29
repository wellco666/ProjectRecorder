/* =============================================================
   诊断 [9] 老板收不到工时 / [12] 员工收不到通知

   建一对新账号（密码已知），跑完整流程，每一步都查真实数据。

   用法：
     node diag-sync.js
   ============================================================= */
"use strict";

const URL_BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";
const PASSWORD = "diag123456";

async function api(method, path, options) {
  const opts = options || {};
  const headers = {
    apikey: ANON,
    "Content-Type": "application/json",
    Authorization: "Bearer " + (opts.token || ANON),
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const response = await fetch(URL_BASE + path, {
    method: method, headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, data: data };
}

async function main() {
  const stamp = Date.now().toString(36).slice(-5);
  console.log("=".repeat(64));
  console.log("同步诊断（新建账号跑完整流程）");
  console.log("=".repeat(64));

  /* ---------- 建账号 ---------- */
  const bossCreated = await api("POST", "/rest/v1/rpc/create_boss_account",
    { body: { p_code: "db" + stamp, p_password: PASSWORD, p_name: "诊断老板" } });
  if (!bossCreated.data || !bossCreated.data.ok) {
    console.log("建老板失败：" + JSON.stringify(bossCreated.data));
    return 1;
  }
  const bossCode = bossCreated.data.code;
  const bossLogin = await api("POST", "/auth/v1/token?grant_type=password",
    { body: { email: bossCode + "@boss.pr", password: PASSWORD } });
  const bossToken = bossLogin.data.access_token;
  const bossId = bossLogin.data.user.id;
  console.log("\n老板 " + bossCode + "  id=" + bossId.slice(0, 8) + "…");

  const staffCreated = await api("POST", "/rest/v1/rpc/create_staff_account",
    { token: bossToken,
      body: { p_code: "ds" + stamp, p_password: PASSWORD, p_name: "诊断员工" } });
  if (!staffCreated.data || !staffCreated.data.ok) {
    console.log("建员工失败：" + JSON.stringify(staffCreated.data));
    return 1;
  }
  const staffCode = staffCreated.data.code;
  const staffId = staffCreated.data.id;
  const staffLogin = await api("POST", "/auth/v1/token?grant_type=password",
    { body: { email: staffCode + "@staff.pr", password: PASSWORD } });
  const staffToken = staffLogin.data.access_token;
  console.log("员工 " + staffCode + "  id=" + staffId.slice(0, 8) + "…");

  /* ---------- 派任务 ---------- */
  const today = new Date().toISOString().slice(0, 10);
  const taskId = crypto.randomUUID();
  const assigned = await api("POST", "/rest/v1/tasks", {
    token: bossToken, prefer: "return=representation",
    body: {
      id: taskId, boss_id: bossId, employee_id: staffId,
      title: "诊断任务", detail: "", plan_date: today, est_hours: 2,
      project_name: "", step_name: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  console.log("\n派任务 → HTTP " + assigned.status);

  /* ---------- 查触发器有没有记 assigned ---------- */
  console.log("\n[1] 触发器记的 assigned 事件");
  const ev1 = await api("GET",
    "/rest/v1/task_events?select=id,kind,title,employee_id,boss_id"
    + "&task_id=eq." + taskId, { token: bossToken });
  const ev1rows = Array.isArray(ev1.data) ? ev1.data : [];
  console.log("  条数：" + ev1rows.length);
  ev1rows.forEach(e => console.log("    " + e.kind + "  employee_id="
    + String(e.employee_id).slice(0, 8) + "…  boss_id="
    + String(e.boss_id).slice(0, 8) + "…"));

  /* ---------- 员工能不能拉到这条事件 ---------- */
  console.log("\n[2] 员工端能拉到的事件");
  const ev2 = await api("GET",
    "/rest/v1/task_events?select=id,kind,title&order=created_at.desc",
    { token: staffToken });
  const ev2rows = Array.isArray(ev2.data) ? ev2.data : [];
  console.log("  条数：" + ev2rows.length);
  ev2rows.forEach(e => console.log("    " + e.kind + "  " + e.title));

  /* ---------- 员工完成：写 task_log + worklog + done 事件 ---------- */
  console.log("\n[3] 员工完成（模拟 App 的三次写入）");
  const logWrite = await api("POST", "/rest/v1/task_logs", {
    token: staffToken, prefer: "return=representation",
    body: { id: crypto.randomUUID(), task_id: taskId, employee_id: staffId,
            started_at: null, finished_at: new Date().toISOString(),
            finish_date: today },
  });
  console.log("  task_logs  → HTTP " + logWrite.status
    + (logWrite.status >= 400 ? "  " + JSON.stringify(logWrite.data).slice(0, 140) : ""));

  const worklogId = crypto.randomUUID();
  const wlWrite = await api("POST", "/rest/v1/worklogs", {
    token: staffToken, prefer: "return=representation",
    body: { id: worklogId, boss_id: bossId, employee_id: staffId,
            task_id: taskId, work_date: today, hours: 2,
            content: "诊断任务", project_name: "", source: "task" },
  });
  console.log("  worklogs   → HTTP " + wlWrite.status
    + (wlWrite.status >= 400 ? "  " + JSON.stringify(wlWrite.data).slice(0, 140) : ""));

  const evWrite = await api("POST", "/rest/v1/task_events", {
    token: staffToken, prefer: "return=representation",
    body: { id: crypto.randomUUID(), boss_id: bossId, employee_id: staffId,
            task_id: taskId, kind: "done", title: "诊断任务",
            hours: 2, work_date: today },
  });
  console.log("  task_events→ HTTP " + evWrite.status
    + (evWrite.status >= 400 ? "  " + JSON.stringify(evWrite.data).slice(0, 140) : ""));

  /* ---------- 老板能不能拉到工时 ---------- */
  console.log("\n[4] 老板端能拉到的工时（[9] 失败的那项）");
  const bw = await api("GET",
    "/rest/v1/worklogs?select=id,employee_id,task_id,hours,content",
    { token: bossToken });
  const bwRows = Array.isArray(bw.data) ? bw.data : [];
  console.log("  条数：" + bwRows.length);
  bwRows.forEach(w => console.log("    " + w.hours + " 小时  " + w.content
    + "  employee_id=" + String(w.employee_id).slice(0, 8) + "…"));
  if (bw.status >= 400) console.log("  " + JSON.stringify(bw.data).slice(0, 200));

  /* ---------- 判定 ---------- */
  console.log("\n" + "=".repeat(64));
  console.log("判定");
  console.log("=".repeat(64));
  console.log("  assigned 事件      : " + (ev1rows.length ? "有 ✓" : "没有 ✗"));
  console.log("  员工能拉到事件     : " + (ev2rows.length ? "能 ✓" : "不能 ✗"));
  console.log("  员工能写 task_log  : " + (logWrite.status < 400 ? "能 ✓" : "不能 ✗"));
  console.log("  员工能写 worklog   : " + (wlWrite.status < 400 ? "能 ✓" : "不能 ✗"));
  console.log("  员工能写事件       : " + (evWrite.status < 400 ? "能 ✓" : "不能 ✗"));
  console.log("  老板能拉到工时     : " + (bwRows.length ? "能 ✓" : "不能 ✗"));
  console.log("");
  console.log("（诊断账号：" + bossCode + " / " + staffCode + "）");
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("脚本异常：" + error.message);
  process.exitCode = 1;
});
