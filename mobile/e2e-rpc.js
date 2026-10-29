/* =============================================================
   验证「老板在 App 里一键建员工账号」这条链路

   它测的是数据库函数 `create_staff_account`：
     · 老板调用 → 成功建号并把员工认领到自己名下
     · 员工调用 → 被拒绝（只有老板能建）
     · 匿名调用 → 被拒绝（没登录）
     · 重复建同一个工号 → 返回"已存在"而不是报错

   **为什么不放在 e2e-cloud.js 里**：那个脚本每次都要注册新账号，
   Supabase 对注册有频率限制，跑多了会被限流。
   这个脚本**只登录不注册**，可以反复跑。

   用法：
     node e2e-rpc.js
   ============================================================= */
"use strict";

const URL_BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";

/*: 这些账号由 e2e-cloud.js 创建。如果被删了，先跑一次那个脚本。 */
const BOSS_EMAIL = process.env.BOSS_EMAIL || "";
const STAFF_EMAIL = process.env.STAFF_EMAIL || "";
const PASSWORD = "test123456";

let passed = 0;
let failed = 0;
function ok(label, detail) {
  passed += 1;
  console.log(`  [OK]   ${label}${detail ? "  " + detail : ""}`);
}
function bad(label, detail) {
  failed += 1;
  console.log(`  [失败] ${label}`);
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

/* 登录，返回 {ok,id} 或 {ok:false,detail}。
   **不抛异常**——这个脚本要靠"失败"来判断时序问题。 */
async function tryLoginRaw(email, password) {
  const result = await api("POST", "/auth/v1/token?grant_type=password", {
    body: { email: email, password: password },
  });
  if (result.data && result.data.access_token) {
    return { ok: true, id: result.data.user.id };
  }
  return { ok: false, detail: JSON.stringify(result.data).slice(0, 200) };
}

/* 登录，拿到 token。抛异常版本——用于必须登录成功的场景。 */
async function login(email) {
  const result = await api("POST", "/auth/v1/token?grant_type=password", {
    body: { email: email, password: PASSWORD },
  });
  if (!result.data || !result.data.access_token) {
    throw new Error("登录失败：" + JSON.stringify(result.data).slice(0, 200));
  }
  return { token: result.data.access_token, id: result.data.user.id };
}

async function main() {
  console.log("=".repeat(62));
  console.log("一键建员工账号 · 链路验证");
  console.log("=".repeat(62));

  /* 函数存在吗 */
  console.log("\n[0] 函数是否存在且是 security definer");
  const probe = await api("POST", "/rest/v1/rpc/create_staff_account",
    { body: { p_code: "probe", p_password: "123456", p_name: "探测" } });
  const probeText = JSON.stringify(probe.data);
  if (probeText.indexOf("Could not find the function") !== -1
      || probe.status === 404) {
    bad("函数不存在", "先在 Supabase SQL Editor 里跑 sql/create-staff-rpc.sql");
    return 1;
  }
  ok("函数已部署", "HTTP " + probe.status);

  /* 匿名调用必须被拒 */
  console.log("\n[1] 未登录调用");
  if (probe.status >= 400 && probeText.indexOf("还没登录") !== -1) {
    ok("匿名调用被拒绝（提示\u201c还没登录\u201d）");
  } else if (probe.status >= 400) {
    ok("匿名调用被拒绝", "HTTP " + probe.status);
  } else {
    bad("匿名竟然能建账号 —— 权限有漏洞", probeText);
  }

  if (!BOSS_EMAIL) {
    console.log();
    console.log("没有提供测试账号，跳过后续检查。");
    console.log("用法：");
    console.log("  $env:BOSS_EMAIL=\"testbossxxx@boss.pr\"");
    console.log("  $env:STAFF_EMAIL=\"teststaffxxx@staff.pr\"");
    console.log("  node e2e-rpc.js");
    console.log();
    console.log("（账号从 e2e-cloud.js 的输出里拿，或者自己建一个）");
    return failed ? 1 : 0;
  }

  /* 老板登录 */
  console.log("\n[2] 老板登录");
  let boss;
  try {
    boss = await login(BOSS_EMAIL);
    ok("登录成功", "id=" + boss.id.slice(0, 8) + "…");
  } catch (error) {
    bad("老板登录", error.message);
    return 1;
  }

  /* 老板建员工账号 */
  console.log("\n[3] 老板一键建员工账号");
  const code = "auto" + Date.now().toString(36).slice(-5);
  const created = await api("POST", "/rest/v1/rpc/create_staff_account", {
    token: boss.token,
    body: { p_code: code, p_password: "staff123456", p_name: "自动建号测试" },
  });
  if (created.status === 200 && created.data && created.data.ok) {
    ok("账号创建成功", "工号 " + code + "（id="
      + String(created.data.id).slice(0, 8) + "…）");
  } else {
    bad("建号失败", JSON.stringify(created.data));
    return 1;
  }
  const staffId = created.data.id;

  /* 建出来的账号能不能登录。
     **这里要等**：刚建完的账号 GoTrue 可能还没完全认到，
     立刻登录会报 invalid_credentials，过一会儿就好了。
     这不是缺陷，但必须量出"要等多久"——否则用户建完号
     马上让员工登录，会看到一个莫名其妙的失败。 */
  console.log("\n[4] 新建的员工账号能不能登录");
  const email = code + "@staff.pr";
  const pass = "staff123456";
  const waitPlan = [0, 1000, 2000, 4000];
  let waited = 0;
  let staff = null;
  for (let i = 0; i < waitPlan.length; i += 1) {
    if (waitPlan[i] > 0) {
      await new Promise(resolve => setTimeout(resolve, waitPlan[i]));
      waited += waitPlan[i];
    }
    staff = await tryLoginRaw(email, pass);
    if (staff.ok) {
      ok(`新员工能登录（等了约 ${waited} 毫秒）`,
        "id=" + staff.id.slice(0, 8) + "…");
      break;
    }
  }
  if (!staff || !staff.ok) {
    bad("新员工始终登录不上", staff ? staff.detail : "未知");
    console.log("       账号建出来了但 GoTrue 一直不认——");
    console.log("       这种情况下要换方案：不再手写 auth.users，");
    console.log("       改用 Supabase 的注册接口建号。");
    return 1;
  }
  if (staff.id !== staffId) {
    bad("登录拿到的 id 和建号返回的不一致",
      "建号 " + staffId + " vs 登录 " + staff.id);
  }
  if (waited > 500) {
    console.log(`       注意：要等约 ${waited} 毫秒才能登录。`);
    console.log("       App 的登录里已经加了自动重试，");
    console.log("       但员工建完号立刻登录时仍可能看到一次失败。");
  }

  /* 归属和角色对不对 */
  console.log("\n[5] 账号的角色和归属");
  const profile = await api("GET",
    `/rest/v1/profiles?select=id,code,name,role,boss_id&id=eq.${staffId}`,
    { token: boss.token });
  if (Array.isArray(profile.data) && profile.data.length === 1) {
    const row = profile.data[0];
    if (row.role === "employee") ok("角色是 employee");
    else bad("角色不对", row.role);
    if (row.boss_id === boss.id) ok("已自动认领给老板（不用再点同步）");
    else bad("归属不对", "boss_id=" + row.boss_id);
    if (row.name === "自动建号测试") ok("姓名正确");
    else bad("姓名不对", row.name);
  } else {
    bad("读不到员工 profile", JSON.stringify(profile.data));
  }

  /* 员工不能建号 */
  console.log("\n[6] 员工试图建号（应当被拒）");
  const illegal = await api("POST", "/rest/v1/rpc/create_staff_account", {
    token: staff.token,
    body: { p_code: "hack001", p_password: "123456", p_name: "越权" },
  });
  const illegalText = JSON.stringify(illegal.data);
  if (illegal.status >= 400 || illegalText.indexOf("只有老板") !== -1) {
    ok("员工建号被拒绝");
  } else {
    bad("员工竟然能建号 —— 权限有漏洞", illegalText);
  }

  /* 重复建同一个工号 */
  console.log("\n[7] 重复建同一个工号");
  const again = await api("POST", "/rest/v1/rpc/create_staff_account", {
    token: boss.token,
    body: { p_code: code, p_password: "whatever123", p_name: "重复" },
  });
  if (again.status === 200 && again.data && again.data.already_existed === true) {
    ok("返回\u201c已存在\u201d而不是报错（可以放心重复点）");
    if (again.data.id === staffId) ok("返回的是同一个 id，没有重复建号");
    else bad("id 变了，说明建了两个账号", again.data.id);
  } else {
    bad("重复建号的处理不对", JSON.stringify(again.data));
  }

  /* 参数校验。
     **断言要匹配 SQL 里的英文报错**——
     那些消息是给开发看的（App 会把它们转成中文提示），
     所以这里检查英文关键词，不检查中文。 */
  console.log("\n[8] 参数校验");
  const cases = [
    [{ p_code: "中文工号", p_password: "123456", p_name: "x" },
     "code may only contain", "中文工号"],
    [{ p_code: "ab", p_password: "123456", p_name: "x" },
     "code may only contain", "工号太短（2 位）"],
    [{ p_code: "valid01", p_password: "123", p_name: "x" },
     "password must be at least", "密码太短（3 位）"],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [body, expectWord, label] = cases[i];
    const result = await api("POST", "/rest/v1/rpc/create_staff_account",
      { token: boss.token, body: body });
    const text = JSON.stringify(result.data);
    /* 函数内部 raise exception，PostgREST 会返回 400 或 500，
       而且 data 里一定带 message。两个条件都接受，
       只要消息里出现了期望的关键词就算拦住。 */
    const blocked = text.indexOf(expectWord) !== -1;
    if (blocked) {
      ok("拦住了非法参数：" + label);
    } else {
      bad("非法参数没被拦住：" + label, text);
    }
  }

  console.log("\n" + "=".repeat(62));
  if (failed) {
    console.log(`失败 ${failed} 项，通过 ${passed} 项`);
    return 1;
  }
  console.log(`全部通过（${passed} 项）。老板能在 App 里一键建员工账号了。`);
  console.log("\n测试账号 " + code + "@staff.pr 可以留着，也可以到后台删掉。");
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("\n脚本异常：" + error.message);
  process.exitCode = 1;
});
