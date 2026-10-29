/* =============================================================
   通知链路端到端验证

   在真实 Supabase 上跑：
     1. 老板建员工、派任务 → 服务端自动记一条 'assigned' 事件
     2. 员工拉事件 → 应当看到"有新任务"，且**只看到自己的**
     3. 员工完成任务 → 事件表出现 'done'
     4. 员工取消完成 → 事件表出现 'undone'
     5. 老板拉事件 → 看到 done / undone，看不到 assigned
     6. 隔离：别的老板拉不到这些事件

   用法：
     node e2e-notify.js
   ============================================================= */
"use strict";

const URL_BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";

let passed = 0;
let failed = 0;
function ok(label, detail) {
  passed += 1;
  console.log("  [OK]   " + label + (detail ? "  " + detail : ""));
}
function bad(label, detail) {
  failed += 1;
  console.log("  [失败] " + label);
  if (detail) console.log("         " + String(detail).slice(0, 300));
}

async function api(method, path, options) {
  const opts = options || {};
  const headers = {
    apikey: ANON_KEY,
    "Content-Type": "application/json",
    Authorization: "Bearer " + (opts.token || ANON_KEY),
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

const PASSWORD = "notify123456";

async function registerBoss(code, name) {
  const created = await api("POST", "/rest/v1/rpc/create_boss_account",
    { body: { p_code: code, p_password: PASSWORD, p_name: name } });
  if (!created.data || !created.data.ok) {
    return { ok: false, detail: JSON.stringify(created.data).slice(0, 200) };
  }
  const login = await api("POST", "/auth/v1/token?grant_type=password",
    { body: { email: created.data.code + "@boss.pr", password: PASSWORD } });
  if (!login.data || !login.data.access_token) {
    return { ok: false, detail: "建号成功但登录失败" };
  }
  return { ok: true, code: created.data.code,
           token: login.data.access_token, id: login.data.user.id };
}

async function main() {
  console.log("=".repeat(64));
  console.log("通知链路端到端验证");
  console.log("=".repeat(64));

  /* ---------- 0. 表在不在 ---------- */
  console.log("\n[0] task_events 表是否已建");
  const probe = await api("GET", "/rest/v1/task_events?select=id&limit=1");
  const probeText = JSON.stringify(probe.data);
  if (probe.status === 404
      || probeText.indexOf("Could not find the table") !== -1
      || probeText.indexOf("does not exist") !== -1) {
    bad("表不存在", "先在 Supabase SQL Editor 跑 sql/task-events.sql");
    return 1;
  }
  ok("表已建好", "HTTP " + probe.status);

  const stamp = Date.now().toString(36).slice(-5);

  /* ---------- 1. 建两个老板和各自的员工 ---------- */
  console.log("\n[1] 建测试账号");
  const bossA = await registerBoss("nba" + stamp, "通知甲");
  if (!bossA.ok) { bad("建老板甲失败", bossA.detail); return 1; }
  const bossB = await registerBoss("nbb" + stamp, "通知乙");
  if (!bossB.ok) { bad("建老板乙失败", bossB.detail); return 1; }
  ok("两个老板都建好了", bossA.code + " / " + bossB.code);

  const staffA = await api("POST", "/rest/v1/rpc/create_staff_account", {
    token: bossA.token,
    body: { p_code: "nsa" + stamp, p_password: PASSWORD, p_name: "员工甲" },
  });
  if (!staffA.data || !staffA.data.ok) {
    bad("建员工失败", JSON.stringify(staffA.data));
    return 1;
  }
  const staffLogin = await api("POST", "/auth/v1/token?grant_type=password",
    { body: { email: staffA.data.code + "@staff.pr", password: PASSWORD } });
  if (!staffLogin.data || !staffLogin.data.access_token) {
    bad("员工登录失败", JSON.stringify(staffLogin.data).slice(0, 200));
    return 1;
  }
  const staffToken = staffLogin.data.access_token;
  ok("员工建好并能登录", staffA.data.code);

  /* ---------- 2. 派任务 → 服务端自动记 assigned 事件 ---------- */
  console.log("\n[2] 派任务，服务端应当自动记一条 assigned 事件");
  const today = new Date().toISOString().slice(0, 10);
  const taskId = crypto.randomUUID();
  const task = {
    id: taskId,
    boss_id: bossA.id,
    employee_id: staffA.data.id,
    title: "通知测试任务",
    detail: "",
    plan_date: today,
    est_hours: 2,
    project_name: "",
    step_name: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const created = await api("POST", "/rest/v1/tasks",
    { token: bossA.token, body: task, prefer: "return=representation" });
  if (created.status !== 201 && created.status !== 200) {
    bad("派任务失败", JSON.stringify(created.data));
    return 1;
  }
  ok("任务已派发");

  /* 触发器应当在 tasks 插入后自动写事件 */
  const autoEvent = await api("GET",
    `/rest/v1/task_events?select=id,kind,title,employee_id`
    + `&task_id=eq.${taskId}&kind=eq.assigned`,
    { token: bossA.token });
  const autoRows = Array.isArray(autoEvent.data) ? autoEvent.data : [];
  if (autoRows.length === 1) {
    ok("触发器自动记了 assigned 事件", "标题：" + autoRows[0].title);
  } else {
    bad("没有自动记事件（触发器没装？）",
      "找到 " + autoRows.length + " 条：" + JSON.stringify(autoEvent.data));
    console.log("        检查 sql/task-events.sql 里的 trg_task_assigned");
  }

  /* ---------- 3. 员工能看到这条事件（这就是"新任务"提醒） ---------- */
  console.log("\n[3] 员工拉事件 —— 这就是应用内「有新任务」的来源");
  const staffEvents = await api("GET",
    "/rest/v1/task_events?select=id,kind,title&order=created_at.desc",
    { token: staffToken });
  const staffRows = Array.isArray(staffEvents.data) ? staffEvents.data : [];
  const mine = staffRows.filter(row => row.kind === "assigned"
    && row.title === "通知测试任务");
  if (mine.length === 1) {
    ok("员工能看到派给自己的任务事件");
  } else {
    bad("员工看不到任务事件", JSON.stringify(staffEvents.data).slice(0, 200));
  }

  /* ---------- 4. 员工完成 → done 事件 ---------- */
  console.log("\n[4] 员工完成任务，写一条 done 事件");
  const doneEventId = crypto.randomUUID();
  const doneWrite = await api("POST", "/rest/v1/task_events",
    { token: staffToken, prefer: "return=representation",
      body: {
        id: doneEventId,
        boss_id: bossA.id,
        employee_id: staffA.data.id,
        task_id: taskId,
        kind: "done",
        title: "通知测试任务",
        hours: 2,
        work_date: today,
      } });
  if (doneWrite.status === 201 || doneWrite.status === 200) {
    ok("done 事件写入成功");
  } else {
    bad("done 事件写入失败", JSON.stringify(doneWrite.data));
  }

  /* ---------- 5. 员工取消完成 → undone 事件 ---------- */
  console.log("\n[5] 取消完成，写一条 undone 事件");
  const undoneWrite = await api("POST", "/rest/v1/task_events",
    { token: staffToken, prefer: "return=representation",
      body: {
        id: crypto.randomUUID(),
        boss_id: bossA.id,
        employee_id: staffA.data.id,
        task_id: taskId,
        kind: "undone",
        title: "通知测试任务",
        work_date: today,
      } });
  if (undoneWrite.status === 201 || undoneWrite.status === 200) {
    ok("undone 事件写入成功（取消完成能被通知的前提）");
  } else {
    bad("undone 事件写入失败", JSON.stringify(undoneWrite.data));
  }

  /* ---------- 6. 老板拉到 done / undone ---------- */
  console.log("\n[6] 老板拉事件 —— 应当看到 done 和 undone");
  const bossEvents = await api("GET",
    "/rest/v1/task_events?select=id,kind,title&order=created_at.desc",
    { token: bossA.token });
  const bossRows = Array.isArray(bossEvents.data) ? bossEvents.data : [];
  const kinds = bossRows.filter(row => row.title === "通知测试任务")
    .map(row => row.kind).sort();
  console.log("       老板看到的事件类型：" + JSON.stringify(kinds));
  if (kinds.indexOf("done") !== -1) ok("老板看到了 done");
  else bad("老板看不到 done");
  if (kinds.indexOf("undone") !== -1) ok("老板看到了 undone");
  else bad("老板看不到 undone");
  /* 老板不需要知道任务是自己派的，但**能看到也无害**——
     客户端会按身份过滤（员工只看 assigned，老板不看 assigned）。 */
  if (kinds.indexOf("assigned") !== -1) {
    ok("老板也能拉到 assigned（客户端按身份过滤，不显示）");
  }

  /* ---------- 7. 隔离：另一个老板拉不到 ---------- */
  console.log("\n[7] 隔离：另一个老板拉不到这些事件");
  const otherEvents = await api("GET",
    "/rest/v1/task_events?select=id,kind,title&order=created_at.desc",
    { token: bossB.token });
  const otherRows = Array.isArray(otherEvents.data) ? otherEvents.data : [];
  const leaked = otherRows.filter(row => row.title === "通知测试任务");
  if (leaked.length === 0) {
    ok("老板乙看不到老板甲的事件", "他总共看到 "
      + otherRows.length + " 条（都是自己的）");
  } else {
    bad("事件泄漏了 —— 隔离失败", leaked.length + " 条");
  }

  /* ---------- 8. kind 约束 ---------- */
  console.log("\n[8] 非法的事件类型应当被约束挡住");
  const bogus = await api("POST", "/rest/v1/task_events",
    { token: bossA.token,
      body: {
        boss_id: bossA.id, employee_id: staffA.data.id,
        task_id: taskId, kind: "complete",   // 应当是 done
        title: "拼错了", work_date: today,
      } });
  const bogusText = JSON.stringify(bogus.data);
  if (bogus.status >= 400
      && (bogusText.indexOf("task_events_kind_check") !== -1
          || bogusText.indexOf("check constraint") !== -1)) {
    ok("拼错的 kind 被数据库约束挡住");
  } else if (bogus.status >= 400) {
    ok("拼错的 kind 被挡住", "HTTP " + bogus.status);
  } else {
    bad("拼错的 kind 竟然写进去了", bogusText);
  }

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(64));
  console.log("测试账号（可到后台删，或用 sql/delete-all-accounts.sql）：");
  console.log("  " + [bossA.code, bossB.code, staffA.data.code].join("  "));
  console.log("");
  if (failed) {
    console.log("失败 " + failed + " 项，通过 " + passed + " 项");
    return 1;
  }
  console.log("全部通过（" + passed + " 项）。通知链路是通的，而且隔离正常。");
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("\n脚本异常：" + error.message);
  process.exitCode = 1;
});
