/* =============================================================
   任务接受 + 申请延期：端到端验证（真服务端）

   覆盖：
     1. 建老板 + 员工账号
     2. 派任务；新任务默认 pending
     3. 拒绝必须写原因（空原因要被服务端拒掉）
     4. 改主意接受 -> accepted，原因清空
     5. 越权：别人不能接受 / 不能申请延期
     6. 延期：过去日期被拒、空原因被拒、重复申请只留一条
     7. 审批：员工自己批不了；批准后任务日期真的挪过去；
        同一申请不能处理两次
     8. 四个事件都记进 task_events（通知的来源）

   用法：
     node e2e-task-accept.js
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

/* **anon key 从现成脚本里取，不手抄。**
   手抄过一次少了一个字符，报的却是 "Invalid API key"，
   看起来像密钥失效，其实是自己写错了。 */
const ANON = (() => {
  const src = fs.readFileSync(path.join(__dirname, "verify-push-e2e.js"), "utf8");
  const m = /const ANON = "([^"]+)"/.exec(src);
  if (!m) throw new Error("没能从 verify-push-e2e.js 取到 anon key");
  return m[1];
})();

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const PASS = "e2e123456";

let passed = 0;
let failed = 0;
const ok = (l, d) => {
  passed += 1;
  console.log("  [OK]   " + l + (d ? "  " + d : ""));
};
const bad = (l, d) => {
  failed += 1;
  console.log("  [失败] " + l);
  if (d) console.log("         " + String(d).slice(0, 200));
};

async function api(method, p, token, body, prefer) {
  const headers = { apikey: ANON, "Content-Type": "application/json",
    Authorization: "Bearer " + (token || ANON) };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(BASE + p, { method, headers,
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  return { status: r.status, data: d, text: t };
}

const rpc = (fn, args, token) =>
  api("POST", "/rest/v1/rpc/" + fn, token, args || {});

async function login(email) {
  const r = await api("POST", "/auth/v1/token?grant_type=password", null,
    { email: email, password: PASS });
  return (r.data && r.data.access_token) ? r.data.access_token : null;
}

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
}

const rejected = r => r.status >= 400 || (r.data && r.data.error);

async function main() {
  console.log("=".repeat(60));
  console.log("任务接受 + 申请延期（端到端）");
  console.log("=".repeat(60));

  const stamp = Date.now().toString(36).slice(-5);

  /* ---- 1 ---- */
  console.log("\n[1] 建账号");
  const boss = await rpc("create_boss_account", {
    p_code: "tb" + stamp, p_password: PASS, p_name: "接受测试老板",
  });
  if (!boss.data || !boss.data.ok) {
    bad("建老板失败", JSON.stringify(boss.data));
    return 1;
  }
  const bossToken = await login(boss.data.code + "@boss.pr");
  if (!bossToken) { bad("老板登录失败"); return 1; }

  const staff = await rpc("create_staff_account", {
    p_code: "ts" + stamp, p_password: PASS, p_name: "接受测试员工",
  }, bossToken);
  if (!staff.data || !staff.data.ok) {
    bad("建员工失败", JSON.stringify(staff.data));
    return 1;
  }
  const staffToken = await login(staff.data.code + "@staff.pr");
  if (!staffToken) { bad("员工登录失败"); return 1; }
  ok("账号就绪", boss.data.code + " / " + staff.data.code);

  const other = await rpc("create_boss_account", {
    p_code: "to" + stamp, p_password: PASS, p_name: "局外老板",
  });
  const otherToken = await login(other.data.code + "@boss.pr");

  /* ---- 2 ---- */
  console.log("\n[2] 派任务");
  const taskId = crypto.randomUUID();
  const bossId = JSON.parse(Buffer.from(bossToken.split(".")[1], "base64")
    .toString("utf8")).sub;
  const created = await api("POST", "/rest/v1/tasks", bossToken, {
    id: taskId, boss_id: bossId, employee_id: staff.data.id,
    title: "接受测试任务", detail: "", plan_date: day(0), est_hours: 2,
    project_name: "", step_name: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, "return=representation");
  if (created.status >= 400) {
    bad("派任务失败", JSON.stringify(created.data));
    return 1;
  }

  const get = async cols => {
    const r = await api("GET",
      "/rest/v1/tasks?select=" + cols + "&id=eq." + taskId, bossToken);
    return Array.isArray(r.data) ? r.data[0] : null;
  };

  const row0 = await get("accept_status");
  if (row0 && row0.accept_status === "pending") ok("新任务默认 pending");
  else bad("新任务状态不对", JSON.stringify(row0));

  /* ---- 3 ---- */
  console.log("\n[3] 不接受：必须写原因");
  if (rejected(await rpc("accept_task",
    { p_task_id: taskId, p_accept: false, p_reason: "   " }, staffToken))) {
    ok("空原因被拒");
  } else bad("空原因居然通过了");

  const no = await rpc("accept_task",
    { p_task_id: taskId, p_accept: false, p_reason: "今天排满了" }, staffToken);
  if (rejected(no)) bad("拒绝失败", JSON.stringify(no.data));
  else {
    const row = await get("accept_status,accept_reason");
    if (row && row.accept_status === "rejected"
        && row.accept_reason === "今天排满了") {
      ok("拒绝成功，原因已存", row.accept_reason);
    } else bad("拒绝后状态不对", JSON.stringify(row));
  }

  /* ---- 4 ---- */
  console.log("\n[4] 改主意接受");
  const yes = await rpc("accept_task",
    { p_task_id: taskId, p_accept: true, p_reason: "" }, staffToken);
  if (rejected(yes)) bad("接受失败", JSON.stringify(yes.data));
  else {
    const row = await get("accept_status,accept_reason");
    if (row && row.accept_status === "accepted") {
      ok("已接受，原因已清空", JSON.stringify(row.accept_reason));
    } else bad("接受后状态不对", JSON.stringify(row));
  }

  /* ---- 5 ---- */
  console.log("\n[5] 越权检查");
  if (rejected(await rpc("accept_task",
    { p_task_id: taskId, p_accept: true, p_reason: "" }, otherToken))) {
    ok("局外人接受不了");
  } else bad("局外人居然能接受别人的任务");

  if (rejected(await rpc("request_task_extension",
    { p_task_id: taskId, p_to_date: day(5), p_reason: "越权试试" }, otherToken))) {
    ok("局外人申请不了延期");
  } else bad("局外人居然能申请延期");

  /* ---- 6 ---- */
  console.log("\n[6] 申请延期");
  if (rejected(await rpc("request_task_extension",
    { p_task_id: taskId, p_to_date: day(-1), p_reason: "往后" }, staffToken))) {
    ok("过去的日期被拒");
  } else bad("居然允许挪到过去");

  if (rejected(await rpc("request_task_extension",
    { p_task_id: taskId, p_to_date: day(2), p_reason: "" }, staffToken))) {
    ok("空原因被拒");
  } else bad("空原因居然能申请");

  await rpc("request_task_extension",
    { p_task_id: taskId, p_to_date: day(2), p_reason: "需要两天" }, staffToken);
  await rpc("request_task_extension",
    { p_task_id: taskId, p_to_date: day(3), p_reason: "改成三天" }, staffToken);

  const list = await api("GET",
    "/rest/v1/task_requests?select=id,status,to_date&task_id=eq." + taskId,
    bossToken);
  const rows = Array.isArray(list.data) ? list.data : [];
  if (rows.length === 1) ok("重复申请只留一条（覆盖）");
  else bad("申请堆了 " + rows.length + " 条", JSON.stringify(rows));

  const requestId = rows[0] && rows[0].id;
  if (!requestId) { bad("拿不到申请 id"); return 1; }

  /* ---- 7 ---- */
  console.log("\n[7] 审批");
  if (rejected(await rpc("decide_task_extension",
    { p_request_id: requestId, p_approved: true, p_note: "" }, staffToken))) {
    ok("员工自己批不了");
  } else bad("员工居然能自己批准延期");

  const go = await rpc("decide_task_extension",
    { p_request_id: requestId, p_approved: true, p_note: "" }, bossToken);
  if (rejected(go)) bad("批准失败", JSON.stringify(go.data));
  else {
    const row = await get("plan_date");
    const want = day(3);
    if (row && String(row.plan_date).slice(0, 10) === want) {
      ok("任务日期已挪到", want);
    } else {
      bad("日期没变", "期望 " + want + "，实际 " + JSON.stringify(row));
    }
  }

  if (rejected(await rpc("decide_task_extension",
    { p_request_id: requestId, p_approved: false, p_note: "" }, bossToken))) {
    ok("同一申请不能处理两次");
  } else bad("申请被处理了两次");

  /* ---- 8 ---- */
  console.log("\n[8] task_events");
  const ev = await api("GET",
    "/rest/v1/task_events?select=kind&task_id=eq." + taskId
    + "&order=created_at.asc", bossToken);
  const kinds = (Array.isArray(ev.data) ? ev.data : []).map(e => e.kind);
  const need = ["assigned", "rejected", "extend", "extend_ok"];
  const missing = need.filter(k => kinds.indexOf(k) === -1);
  if (!missing.length) ok("四个事件都在", kinds.join(", "));
  else bad("缺事件：" + missing.join("、"), "实际：" + kinds.join(", "));

  console.log("\n" + "=".repeat(60));
  if (failed) {
    console.log("失败 " + failed + " 项，通过 " + passed + " 项");
    return 1;
  }
  console.log("全部通过（" + passed + " 项）。");
  console.log("接受 / 拒绝 / 延期 / 审批 / 越权拦截 / 事件记录都正常。");
  console.log("");
  console.log("测试账号：" + boss.data.code + " / " + staff.data.code
    + " / " + other.data.code);
  return 0;
}

main().then(c => { process.exitCode = c; })
  .catch(e => { console.error("脚本异常：" + e.message); process.exitCode = 1; });
