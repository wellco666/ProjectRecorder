/* =============================================================
   查"任务派给了谁" —— 用户反馈：给别人发任务，
   结果发到了自己的员工号上。

   只读。用现有账号登录，看真实数据。

   用法：
     $env:BOSS_CODE="testboss001"
     $env:BOSS_PASS="test123456"
     node diag-assign.js
   ============================================================= */
"use strict";

const URL_BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";

const CODE = process.env.BOSS_CODE || "";
const PASS = process.env.BOSS_PASS || "";

async function api(method, path, options) {
  const opts = options || {};
  const headers = {
    apikey: ANON,
    "Content-Type": "application/json",
    Authorization: "Bearer " + (opts.token || ANON),
  };
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
  if (!CODE || !PASS) {
    console.log("请先设置账号：");
    console.log('  $env:BOSS_CODE="testboss001"');
    console.log('  $env:BOSS_PASS="test123456"');
    return 1;
  }

  console.log("=".repeat(64));
  console.log("任务派给了谁 —— 只读诊断");
  console.log("=".repeat(64));

  /* 登录 */
  const login = await api("POST", "/auth/v1/token?grant_type=password",
    { body: { email: CODE + "@boss.pr", password: PASS } });
  if (!login.data || !login.data.access_token) {
    console.log("\n登录失败：" + JSON.stringify(login.data).slice(0, 200));
    return 1;
  }
  const token = login.data.access_token;
  const myId = login.data.user.id;
  console.log("\n老板 id: " + myId);

  /* ---------- 1. 这个老板名下的所有"员工"---------- */
  console.log("\n[1] 我名下的员工账号");
  const profiles = await api("GET",
    "/rest/v1/profiles?select=id,code,name,role,boss_id&order=code",
    { token: token });
  const rows = Array.isArray(profiles.data) ? profiles.data : [];
  if (!rows.length) {
    console.log("  （看不到任何 profile —— RLS 或登录有问题）");
    console.log("  " + JSON.stringify(profiles.data).slice(0, 200));
  }
  rows.forEach(row => {
    const mine = row.boss_id === myId ? "  ← 我的员工" : "";
    const self = row.id === myId ? "  ← 就是我自己" : "";
    console.log("  " + String(row.role).padEnd(9) + String(row.code).padEnd(18)
      + String(row.name || "").padEnd(12) + mine + self);
  });

  /* ---------- 2. 有没有"我自己的员工号" ---------- */
  console.log("\n[2] 关键：我名下有没有一个和我自己是同一个人的账号？");
  const selfAsStaff = rows.filter(row =>
    row.role === "employee" && row.name && row.name === rows.find(r =>
      r.id === myId) && false);
  void selfAsStaff;
  const myProfile = rows.find(row => row.id === myId);
  console.log("  我的老板账号：" + (myProfile ? myProfile.code : "?"));
  const sameCode = rows.filter(row =>
    row.id !== myId && String(row.code) === String(myProfile && myProfile.code));
  if (sameCode.length) {
    console.log("  ⚠ 存在工号和我的手机号相同的账号：");
    sameCode.forEach(row => console.log("     " + row.role + " " + row.code
      + " " + row.name));
  } else {
    console.log("  没有同名的其他账号 ✓");
  }

  /* ---------- 3. 最近的任务都派给了谁 ---------- */
  console.log("\n[3] 我派出去的任务（最近 20 条）");
  const tasks = await api("GET",
    "/rest/v1/tasks?select=id,title,employee_id,plan_date,created_at"
    + "&order=created_at.desc&limit=20",
    { token: token });
  const taskRows = Array.isArray(tasks.data) ? tasks.data : [];
  if (!taskRows.length) {
    console.log("  （还没有任务，或者看不到）");
    if (!Array.isArray(tasks.data)) {
      console.log("  " + JSON.stringify(tasks.data).slice(0, 200));
    }
  }
  const byId = {};
  rows.forEach(row => { byId[row.id] = row; });
  taskRows.forEach(task => {
    const who = byId[task.employee_id];
    const label = who ? (who.name + "（" + who.code + "）")
      : "未知账号 " + String(task.employee_id).slice(0, 8);
    const flag = task.employee_id === myId ? "   ⚠ 派给了自己！" : "";
    console.log("  " + String(task.plan_date).padEnd(12)
      + String(task.title).slice(0, 22).padEnd(24) + "→ " + label + flag);
  });

  /* ---------- 4. 派给自己的任务有几条 ---------- */
  const toSelf = taskRows.filter(task => task.employee_id === myId);
  console.log("");
  if (toSelf.length) {
    console.log("⚠ **有 " + toSelf.length + " 条任务派给了老板自己**");
    console.log("   这说明派任务时选到了老板自己的账号。");
  } else {
    console.log("没有发现派给自己的任务。");
  }

  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("脚本异常：" + error.message);
  process.exitCode = 1;
});
