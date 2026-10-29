/* 验证「游标里的 + 号会让查询失败」。

   现象：App 的 tasks 拉取永远返回空，光标卡在
   `2026-10-15T13:27:10+00:00` 不再前进。

   怀疑：这个值原样拼进 query string 后，URL 里的 `+` 被当成空格，
   服务端解析成非法的 timestamp，返回 400。

   做法：同一对账号、同一条查询，只改 `+` 有没有编码，对比结果。

   用法：
     node diag-cursor-encoding.js
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const ANON = (() => {
  const src = fs.readFileSync(path.join(__dirname, "verify-push-e2e.js"), "utf8");
  return /const ANON = "([^"]+)"/.exec(src)[1];
})();

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const PASS = "e2e123456";
const CURSOR = "2026-10-15T13:27:10+00:00";

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

const rpc = (fn, args, token) => api("POST", "/rest/v1/rpc/" + fn, token, args || {});

async function login(email) {
  const r = await api("POST", "/auth/v1/token?grant_type=password", null,
    { email, password: PASS });
  return (r.data && r.data.access_token) ? r.data.access_token : null;
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
}

(async () => {
  const stamp = Date.now().toString(36).slice(-5);
  const boss = await rpc("create_boss_account", {
    p_code: "cb" + stamp, p_password: PASS, p_name: "游标测试老板",
  });
  const bossToken = await login(boss.data.code + "@boss.pr");
  const bossId = JSON.parse(Buffer.from(bossToken.split(".")[1], "base64")
    .toString("utf8")).sub;

  const staff = await rpc("create_staff_account", {
    p_code: "cs" + stamp, p_password: PASS, p_name: "游标测试员工",
  }, bossToken);
  const staffToken = await login(staff.data.code + "@staff.pr");

  await api("POST", "/rest/v1/tasks", bossToken, {
    id: crypto.randomUUID(), boss_id: bossId, employee_id: staff.data.id,
    title: "游标测试任务", detail: "", plan_date: today(), est_hours: 1,
    project_name: "", step_name: "",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, "return=representation");

  const base = "/rest/v1/tasks?select=id,title,updated_at&employee_id=eq."
    + staff.data.id + "&order=plan_date.desc&limit=200&updated_at=gte.";

  console.log("游标原始值: " + CURSOR);
  console.log("");

  /* A. 原样拼（+ 不编码）—— 模拟 supabase-js 如果真的没编码 */
  const raw = await api("GET", base + CURSOR, staffToken);
  console.log("A) 不编码 +  :  HTTP " + raw.status
    + "  拿到 " + (Array.isArray(raw.data) ? raw.data.length : 0) + " 条");
  if (raw.status >= 400) {
    console.log("   服务端说明: " + String(raw.text).slice(0, 160));
  }

  /* B. 把 + 编码成 %2B */
  const enc = await api("GET", base + encodeURIComponent(CURSOR), staffToken);
  console.log("B) 编码 %2B :  HTTP " + enc.status
    + "  拿到 " + (Array.isArray(enc.data) ? enc.data.length : 0) + " 条");

  /* C. 换成 Z 结尾（ISO 习惯写法） */
  const z = CURSOR.replace("+00:00", "Z");
  const zm = await api("GET", base + z, staffToken);
  console.log("C) 改成 Z   :  HTTP " + zm.status
    + "  拿到 " + (Array.isArray(zm.data) ? zm.data.length : 0) + " 条");

  console.log("");
  if (raw.status >= 400 && enc.status === 200) {
    console.log("结论：**游标里的 + 号导致查询失败**。");
    console.log("修法两种都行：请求前编码，或把游标规范成 Z 结尾。");
  } else if (raw.status === 200) {
    console.log("结论：+ 号不影响 —— 原因在别处。");
  }
})();
