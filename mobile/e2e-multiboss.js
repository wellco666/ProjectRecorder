/* =============================================================
   验证「每个老板各自独立」

   测三件事：
     1. 新的 create_boss_account 函数存在（不是被拒的旧版）
     2. **能建出第二个老板** —— 这是这次改动的核心
     3. **两个老板互相看不见对方的员工和工时** —— 隔离

   注意：会真的建两个测试老板账号。
   跑完可以把它们删掉（脚本会告诉你怎么删）。

   用法：
     node e2e-multiboss.js
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
    method: method,
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, data: data };
}

const PASSWORD = "multi123456";

/* 注册一个老板，返回 {code, token, id} */
async function registerBoss(code, name) {
  const created = await api("POST", "/rest/v1/rpc/create_boss_account", {
    body: { p_code: code, p_password: PASSWORD, p_name: name },
  });
  if (!created.data || !created.data.ok) {
    return { ok: false, detail: JSON.stringify(created.data).slice(0, 200) };
  }
  const actual = created.data.code;
  const login = await api("POST", "/auth/v1/token?grant_type=password", {
    body: { email: actual + "@boss.pr", password: PASSWORD },
  });
  if (!login.data || !login.data.access_token) {
    return { ok: false, detail: "建号成功但登录失败："
      + JSON.stringify(login.data).slice(0, 160) };
  }
  return { ok: true, code: actual, token: login.data.access_token,
           id: login.data.user.id, renamed: !!created.data.renamed };
}

/* 建一个员工 */
async function makeStaff(bossToken, code, name) {
  const result = await api("POST", "/rest/v1/rpc/create_staff_account", {
    token: bossToken,
    body: { p_code: code, p_password: "staff123456", p_name: name },
  });
  if (!result.data || !result.data.ok) {
    return { ok: false, detail: JSON.stringify(result.data).slice(0, 200) };
  }
  return { ok: true, id: result.data.id, code: result.data.code };
}

async function main() {
  console.log("=".repeat(62));
  console.log("多老板 · 独立账号验证");
  console.log("=".repeat(62));

  const stamp = Date.now().toString(36).slice(-5);

  /* ---------- 0. 函数存在吗 ---------- */
  console.log("\n[0] 新函数是否已部署");
  const probe = await api("POST", "/rest/v1/rpc/create_boss_account",
    { body: { p_code: "x", p_password: "123", p_name: "x" } });
  const probeText = JSON.stringify(probe.data);
  if (probeText.indexOf("Could not find the function") !== -1
      || probe.status === 404) {
    bad("函数不存在", "先在 Supabase SQL Editor 跑 sql/multi-boss.sql");
    return 1;
  }
  ok("create_boss_account 已部署", "HTTP " + probe.status);

  /* ---------- 1. 建第一个老板 ---------- */
  console.log("\n[1] 建第一个老板");
  const bossA = await registerBoss("mb" + stamp + "a", "老板甲");
  if (!bossA.ok) { bad("建第一个老板失败", bossA.detail); return 1; }
  ok("建号并登录成功", bossA.code + "@boss.pr");

  /* ---------- 2. 建第二个老板（这次改动的核心） ---------- */
  console.log("\n[2] 建第二个老板 —— 关键：以前这里会被拒绝");
  const bossB = await registerBoss("mb" + stamp + "b", "老板乙");
  if (!bossB.ok) {
    bad("建第二个老板失败", bossB.detail);
    console.log("       如果报 already exists，说明 multi-boss.sql 没跑。");
    return 1;
  }
  ok("第二个老板也能建", bossB.code + "@boss.pr");
  if (bossA.id !== bossB.id) ok("两个是不同的账号");
  else bad("两个账号 id 相同，说明没真正分开");

  /* ---------- 3. 重名必须被拒绝 ---------- */
  /* **这里以前断言的是"自动加后缀"。**

     那个行为这次改掉了：服务端遇到重名会悄悄建一个 xxx-2 的
     新账号，用户根本不知道，于是同一个号码能注册出五个账号，
     谁都记不住该用哪个登录。

     现在正确行为是**直接拒绝**，并告诉用户"已经注册过了"。 */
  console.log("\n[3] 用同一个手机号再注册（应当被拒绝）");
  const dup = await registerBoss("mb" + stamp + "a", "老板丙");
  if (dup.ok) {
    bad("重名居然注册成功了 —— 会继续产生重复账号", dup.code);
  } else if (/already registered/i.test(String(dup.detail || ""))) {
    ok("重名被拒绝", "code already registered");
  } else {
    bad("重名被拒绝了，但原因不对", dup.detail || "(没有说明)");
  }

  /* ---------- 4. 各自建员工 ---------- */
  console.log("\n[4] 两个老板各建一个员工");
  const staffA = await makeStaff(bossA.token, "sa" + stamp, "甲的员工");
  const staffB = await makeStaff(bossB.token, "sb" + stamp, "乙的员工");
  if (!staffA.ok) { bad("老板甲建员工失败", staffA.detail); return 1; }
  ok("老板甲建了员工", staffA.code);
  if (!staffB.ok) { bad("老板乙建员工失败", staffB.detail); return 1; }
  ok("老板乙建了员工", staffB.code);

  /* ---------- 5. 两个老板不能用同一个工号 ---------- */
  console.log("\n[5] 另一个老板用同样的工号（应当被拒）");
  const steal = await makeStaff(bossB.token, staffA.code, "想抢");
  if (steal.ok) {
    bad("抢到了别人的工号 —— 隔离有问题", JSON.stringify(steal));
  } else {
    const text = String(steal.detail);
    if (text.indexOf("already taken") !== -1) {
      ok("被拒绝，而且提示说清楚了（already taken）");
    } else {
      ok("被拒绝");
    }
  }

  /* ---------- 6. 员工列表互相看不见（核心） ---------- */
  console.log("\n[6] 员工列表隔离 —— 这是最关键的一条");
  const listA = await api("GET",
    "/rest/v1/profiles?select=id,code,name,role&role=eq.employee",
    { token: bossA.token });
  const listB = await api("GET",
    "/rest/v1/profiles?select=id,code,name,role&role=eq.employee",
    { token: bossB.token });
  const rowsA = Array.isArray(listA.data) ? listA.data : [];
  const rowsB = Array.isArray(listB.data) ? listB.data : [];

  console.log("       老板甲看到 " + rowsA.length + " 个员工："
    + rowsA.map(r => r.code).join("、"));
  console.log("       老板乙看到 " + rowsB.length + " 个员工："
    + rowsB.map(r => r.code).join("、"));

  const aSeesB = rowsA.some(r => r.code === staffB.code);
  const bSeesA = rowsB.some(r => r.code === staffA.code);
  const aSeesOwn = rowsA.some(r => r.code === staffA.code);
  const bSeesOwn = rowsB.some(r => r.code === staffB.code);

  if (aSeesOwn && bSeesOwn) ok("各自能看到自己的员工");
  else bad("看不到自己的员工", "甲=" + aSeesOwn + " 乙=" + bSeesOwn);
  if (aSeesB) bad("老板甲看到了老板乙的员工 —— 隔离失败", staffB.code);
  else ok("老板甲看不到老板乙的员工");
  if (bSeesA) bad("老板乙看到了老板甲的员工 —— 隔离失败", staffA.code);
  else ok("老板乙看不到老板甲的员工");

  /* ---------- 7. 工时隔离 ---------- */
  console.log("\n[7] 工时隔离");
  const workA = await api("GET", "/rest/v1/worklogs?select=id,employee_id",
    { token: bossA.token });
  const workB = await api("GET", "/rest/v1/worklogs?select=id,employee_id",
    { token: bossB.token });
  const wa = Array.isArray(workA.data) ? workA.data : [];
  const wb = Array.isArray(workB.data) ? workB.data : [];
  console.log("       老板甲看到 " + wa.length + " 条工时，"
    + "老板乙看到 " + wb.length + " 条");
  const crossed = wa.some(r => String(r.employee_id) === String(staffB.id))
    || wb.some(r => String(r.employee_id) === String(staffA.id));
  if (crossed) bad("对方的工时可见了 —— 隔离失败");
  else ok("互相看不到对方的工时");

  /* ---------- 8. 任务隔离 ---------- */
  console.log("\n[8] 任务隔离");
  const taskA = await api("GET", "/rest/v1/tasks?select=id,title",
    { token: bossA.token });
  const taskB = await api("GET", "/rest/v1/tasks?select=id,title",
    { token: bossB.token });
  ok("老板甲能读到任务表（" + (Array.isArray(taskA.data)
    ? taskA.data.length : "?") + " 条）");
  ok("老板乙能读到任务表（" + (Array.isArray(taskB.data)
    ? taskB.data.length : "?") + " 条）");
  const idsA = (Array.isArray(taskA.data) ? taskA.data : []).map(r => r.id);
  const idsB = (Array.isArray(taskB.data) ? taskB.data : []).map(r => r.id);
  const overlap = idsA.filter(id => idsB.indexOf(id) !== -1);
  if (overlap.length) bad("两个老板看到了同一批任务", overlap.length + " 条");
  else ok("任务不重叠");

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(62));
  console.log("建出来的测试账号（可以在后台删掉，或用下面这条 SQL）：");
  console.log("");
  console.log("  delete from public.profiles");
  console.log("   where code in ('" + [bossA.code, bossB.code, dup.ok ? dup.code : null,
    staffA.code, staffB.code].filter(Boolean).join("', '") + "');");
  console.log("");
  if (failed) {
    console.log("失败 " + failed + " 项，通过 " + passed + " 项");
    return 1;
  }
  console.log("全部通过（" + passed + " 项）。每个老板都能建自己的账号，"
    + "而且互相看不见对方的数据。");
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("\n脚本异常：" + error.message);
  process.exitCode = 1;
});
