/* =============================================================
   给手机上的员工派一条测试任务，用来在真机上看新 UI。

   ## 为什么这样能行

   tasks 的读策略是 `employee_id = auth.uid()` —— 员工能看到
   任何派给自己的任务，不管是谁派的。
   写的策略是 `boss_id = auth.uid()` —— 老板只能写自己名下。

   所以：临时建一个老板，用它派一条给目标员工，
   员工下次同步就能拉到、看到「接受 / 不接受」按钮。

   ## 用完要清掉

   脚本最后会删掉这条任务（用同一个老板身份删）。
   如果中途失败，任务会留在库里斯，跑一次 --clean 也能删。

   用法：
     node make-test-task.js <员工uuid>
     node make-test-task.js <员工uuid> --clean
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const ANON = (() => {
  const src = fs.readFileSync(path.join(__dirname, "verify-push-e2e.js"), "utf8");
  const m = /const ANON = "([^"]+)"/.exec(src);
  if (!m) throw new Error("没能取到 anon key");
  return m[1];
})();

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const PASS = "e2e123456";
const TITLE = "真机UI测试任务";

const employeeId = process.argv[2];
const clean = process.argv.indexOf("--clean") !== -1;

if (!employeeId) {
  console.log("用法: node make-test-task.js <员工uuid> [--clean]");
  process.exit(1);
}

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
  /* 建（或复用）一个临时老板。code 固定，重复跑不会堆账号。 */
  const code = "uitestboss";
  let boss = await api("POST", "/rest/v1/rpc/create_boss_account", null, {
    p_code: code, p_password: PASS, p_name: "UI测试老板",
  });
  if (!boss.data || !boss.data.ok) {
    /* 已存在时会失败，直接用已知密码登录 */
    const token = await login(code + "@boss.pr");
    if (!token) {
      console.log("临时老板建不出来也登不上：" + JSON.stringify(boss.data));
      process.exit(1);
    }
    boss = { data: { code: code, token: token } };
  }
  const bossToken = boss.data.token || await login(code + "@boss.pr");
  if (!bossToken) { console.log("老板登录失败"); process.exit(1); }
  const bossId = JSON.parse(Buffer.from(bossToken.split(".")[1], "base64")
    .toString("utf8")).sub;

  if (clean) {
    const r = await api("DELETE",
      "/rest/v1/tasks?boss_id=eq." + bossId + "&title=eq."
      + encodeURIComponent(TITLE), bossToken);
    console.log("清理：" + (r.status < 400 ? "已删除测试任务" : "失败 " + r.status));
    return;
  }

  const task = await api("POST", "/rest/v1/tasks", bossToken, {
    id: crypto.randomUUID(),
    boss_id: bossId,
    employee_id: employeeId,
    title: TITLE,
    detail: "用来验证接受/延期界面的，看到就可以忽略",
    plan_date: today(),
    est_hours: 2,
    project_name: "",
    step_name: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, "return=representation");

  if (task.status >= 400) {
    console.log("派任务失败 HTTP " + task.status + "：" + task.text.slice(0, 200));
    process.exit(1);
  }
  console.log("已派测试任务给 " + employeeId);
  console.log("  task_id: " + task.data[0].id);
  console.log("  老板: " + code + " / " + bossId.slice(0, 8) + "…");
  console.log("");
  console.log("手机上等下次同步（15 秒内）就能看到。");
  console.log("验证完跑：node make-test-task.js " + employeeId + " --clean");
})();
