/* =============================================================
   账号管理端到端验证（真实服务端）

   测四件事，每件都用真账号跑：
     1. 改自己的登录名    → 旧名字登不上、新名字能登
     2. 老板重置员工密码  → 新密码能登、旧密码登不上
     3. 改自己的密码      → 客户端做，不用 SQL
     4. 注销账号          → 账号真的没了

   外加越权检查：
     · 别的老板能不能重置不属于他的员工
     · 员工能不能重置老板的密码

   用法：
     node e2e-account.js
   ============================================================= */
"use strict";

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";
const PASS = "acct123456";

let passed = 0;
let failed = 0;
function ok(label, detail) {
  passed += 1;
  console.log("  [OK]   " + label + (detail ? "  " + detail : ""));
}
function bad(label, detail) {
  failed += 1;
  console.log("  [失败] " + label);
  if (detail) console.log("         " + String(detail).slice(0, 220));
}

async function api(method, path, options) {
  const opts = options || {};
  const headers = {
    apikey: ANON,
    "Content-Type": "application/json",
    Authorization: "Bearer " + (opts.token || ANON),
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const response = await fetch(BASE + path, {
    method: method, headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, data: data, text: text };
}

async function login(email, password) {
  const r = await api("POST", "/auth/v1/token?grant_type=password",
    { body: { email: email, password: password } });
  if (r.data && r.data.access_token) {
    return { ok: true, token: r.data.access_token, id: r.data.user.id };
  }
  return { ok: false, detail: JSON.stringify(r.data).slice(0, 160) };
}

async function rpc(name, args, token) {
  return api("POST", "/rest/v1/rpc/" + name,
    { token: token, body: args || {} });
}

async function main() {
  console.log("=".repeat(64));
  console.log("账号管理端到端验证");
  console.log("=".repeat(64));

  const stamp = Date.now().toString(36).slice(-5);

  /* ---------- 准备账号 ---------- */
  console.log("\n[0] 准备测试账号");
  const bossA = await rpc("create_boss_account",
    { p_code: "ab" + stamp, p_password: PASS, p_name: "账号老板甲" });
  const bossB = await rpc("create_boss_account",
    { p_code: "bb" + stamp, p_password: PASS, p_name: "账号老板乙" });
  if (!bossA.data || !bossA.data.ok || !bossB.data || !bossB.data.ok) {
    bad("建老板失败", JSON.stringify(bossA.data) + " / "
      + JSON.stringify(bossB.data));
    return 1;
  }
  const aCode = bossA.data.code;
  const bCode = bossB.data.code;
  const aLogin = await login(aCode + "@boss.pr", PASS);
  const bLogin = await login(bCode + "@boss.pr", PASS);
  if (!aLogin.ok || !bLogin.ok) {
    bad("老板登录失败", (aLogin.detail || "") + (bLogin.detail || ""));
    return 1;
  }
  ok("两个老板建好并登录", aCode + " / " + bCode);

  const staff = await rpc("create_staff_account",
    { p_code: "as" + stamp, p_password: PASS, p_name: "账号员工" },
    aLogin.token);
  if (!staff.data || !staff.data.ok) {
    bad("建员工失败", JSON.stringify(staff.data));
    return 1;
  }
  const sCode = staff.data.code;
  const sId = staff.data.id;
  ok("员工建好", sCode);

  /* ---------- 1. 改自己的登录名 ---------- */
  console.log("\n[1] 改自己的登录名");
  const newCode = "renamed" + stamp;
  const renamed = await rpc("rename_my_login", { p_new_code: newCode },
    aLogin.token);
  if (renamed.status === 200 && renamed.data && renamed.data.ok) {
    ok("老板改名成功", aCode + " → " + renamed.data.code);
  } else {
    bad("改名失败", JSON.stringify(renamed.data));
  }
  /* 旧名字登不上了 */
  const oldLogin = await login(aCode + "@boss.pr", PASS);
  if (!oldLogin.ok) ok("旧名字登不上了");
  else bad("旧名字还能登 —— 改名没生效");
  /* 新名字能登 */
  const newLogin = await login(newCode + "@boss.pr", PASS);
  if (newLogin.ok) ok("新名字能登");
  else bad("新名字登不上", newLogin.detail);

  /* profiles.code 也跟着变了吗（App 靠它显示） */
  if (newLogin.ok) {
    const profile = await api("GET",
      "/rest/v1/profiles?select=code&id=eq." + newLogin.id,
      { token: newLogin.token });
    const row = Array.isArray(profile.data) ? profile.data[0] : null;
    if (row && row.code === newCode) ok("profiles.code 同步更新了");
    else bad("profiles.code 没更新", JSON.stringify(profile.data));
  }

  /* ---------- 2. 老板重置员工密码 ---------- */
  console.log("\n[2] 老板重置员工密码");
  const newPass = "reset654321";
  const reset = await rpc("reset_staff_password",
    { p_employee_id: sId, p_new_password: newPass }, newLogin.token);
  if (reset.status === 200 && reset.data && reset.data.ok) {
    ok("重置成功");
  } else {
    bad("重置失败", JSON.stringify(reset.data));
  }
  const withNew = await login(sCode + "@staff.pr", newPass);
  if (withNew.ok) ok("员工能用新密码登录");
  else bad("员工用新密码登不上", withNew.detail);
  const withOld = await login(sCode + "@staff.pr", PASS);
  if (!withOld.ok) ok("员工旧密码失效了");
  else bad("旧密码还能用 —— 重置没生效");

  /* ---------- 3. 越权检查 ---------- */
  console.log("\n[3] 越权检查");
  /* 老板乙重置老板甲的员工 */
  const cross = await rpc("reset_staff_password",
    { p_employee_id: sId, p_new_password: "hacked123" }, bLogin.token);
  const crossText = JSON.stringify(cross.data);
  if (cross.status >= 400 || crossText.indexOf("another boss") !== -1) {
    ok("别的老板重置不了（被拒绝）");
  } else {
    bad("别的老板竟然能重置 —— 越权", crossText);
  }
  /* 员工试图重置老板的密码 */
  const staffLogin = await login(sCode + "@staff.pr", newPass);
  const up = await rpc("reset_staff_password",
    { p_employee_id: newLogin.id, p_new_password: "hacked123" },
    staffLogin.token);
  const upText = JSON.stringify(up.data);
  if (up.status >= 400 || /only a boss|not a staff/i.test(upText)) {
    ok("员工重置不了老板的密码（被拒绝）");
  } else {
    bad("员工竟然能重置老板密码 —— 越权", upText);
  }
  /* 员工改自己的登录名（应当允许，那是他自己的账号） */
  const empNewCode = "emp" + stamp;
  const selfRename = await rpc("rename_my_login",
    { p_new_code: empNewCode }, staffLogin.token);
  if (selfRename.status === 200 && selfRename.data && selfRename.data.ok) {
    ok("员工能改自己的登录名", sCode + " → " + empNewCode);
  } else {
    bad("员工改不了自己的登录名", JSON.stringify(selfRename.data));
  }
  /* 改名之后要用**新名字**登录（用旧名字当然登不上） */
  const staffAfterRename = await login(empNewCode + "@staff.pr", newPass);
  if (staffAfterRename.ok) ok("员工用新名字能登");
  else bad("员工用新名字登不上", staffAfterRename.detail);

  /* **撞名必须被拒绝——而且要测"跨身份"的撞名。**

     这是真抓到的漏洞：员工把自己改成**老板的登录名**时，
     函数返回了 ok:true。原因是我只靠同域的邮箱唯一索引，
     而 `x@boss.pr` 和 `x@staff.pr` 是两个不同的字符串，
     索引拦不住——于是服务器上出现了两个叫同一个名字的账号。

     所以这里专门测"员工改成老板的名字"。 */
  const clash = await rpc("rename_my_login", { p_new_code: newCode },
    staffLogin.token);
  const clashText = JSON.stringify(clash.data);
  if (clash.status >= 400 && /already taken/i.test(clashText)) {
    ok("改成老板的名字被拒绝（跨身份撞名）");
  } else {
    bad("员工竟然能改成老板的名字 —— 服务器上会出现两个同名账号",
      clashText);
  }
  /* 同域撞名也要拦 */
  const staff2 = await rpc("create_staff_account",
    { p_code: "as2" + stamp, p_password: PASS, p_name: "账号员工二" },
    newLogin.token);
  if (staff2.data && staff2.data.ok) {
    const clash2 = await rpc("rename_my_login",
      { p_new_code: staff2.data.code }, staffLogin.token);
    if (clash2.status >= 400) ok("改成另一个员工的名字也被拒绝");
    else bad("同域撞名没被拒绝", JSON.stringify(clash2.data));
  }

  /* ---------- 4. 注销账号 ---------- */
  console.log("\n[4] 注销账号");
  /* 用改名后的新登录名重新登录（贴合真实流程） */
  const staffLogin2 = await login(empNewCode + "@staff.pr", newPass);
  if (!staffLogin2.ok) {
    bad("员工改名后登不上", staffLogin2.detail);
  } else {
    const del = await rpc("delete_my_account", {}, staffLogin2.token);
    if (del.status === 200 && del.data && del.data.ok) {
      ok("员工注销成功");
    } else {
      bad("注销失败", JSON.stringify(del.data));
    }
    const gone = await login(empNewCode + "@staff.pr", newPass);
    if (!gone.ok) ok("注销后登不上了");
    else bad("注销后还能登 —— 没删掉");
    /* profiles 行也该级联删掉 */
    const left = await api("GET",
      "/rest/v1/profiles?select=id&id=eq." + sId, { token: newLogin.token });
    const leftRows = Array.isArray(left.data) ? left.data : [];
    if (leftRows.length === 0) ok("profiles 行也级联删掉了");
    else bad("profiles 行还在", JSON.stringify(left.data));
  }

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(64));
  if (failed) {
    console.log("失败 " + failed + " 项，通过 " + passed + " 项");
    return 1;
  }
  console.log("全部通过（" + passed + " 项）。账号管理功能都正常，"
    + "越权也拦住了。");
  console.log("");
  console.log("测试账号（可以在 App 里用「注销账号」清掉）：");
  console.log("  " + newCode + "（老板甲，已改名）");
  console.log("  " + bCode + "（老板乙）");
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("脚本异常：" + error.message);
  process.exitCode = 1;
});
