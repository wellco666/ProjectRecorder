/* =============================================================
   云同步（Supabase）

   ## 架构：本地优先，后台同步

   界面代码**一行都不用改**——它仍然同步读 `DB`（localStorage）。
   这个模块在后台跑，负责和服务器交换数据：

       界面  ──同步读写──►  DB（localStorage）
                              ↑↓
                           sync.js   ← 这个文件
                              ↑↓
                           cloudClient

   ## 为什么不把界面改成异步

   服务器调用是异步的，而现在的渲染函数全是同步的
   （`renderDash()` 直接读 `DB.projects`）。如果让界面去 await 数据：

     · 项目里 40 多处调用点都要改成 async
     · **离线时界面完全打不开**——这是不可接受的

   所以本地始终是"唯一真相"，服务器只是同步对象。

   ## 没网时怎么办

   所有改动先写本地 + 进队列，然后**尝试**上传。
   上传失败不清队列，下次网络恢复时补传。
   界面永远只依赖本地数据，所以断网照常能用。
   ============================================================= */
"use strict";

/* Supabase 客户端（从 CDN 载入的全局 UMD 对象）。

   **变量名不能直接叫 `supabase`**：那个库把自己也暴露成全局
   `supabase`，同名的顶层 `let` 会触发
   "Identifier 'supabase' has already been declared"，
   让整个文件一行都不执行（表现为启动白屏）。所以叫 cloudClient。 */
let cloudClient = null;

/*: 同步状态。-1 = 没在跑，0 = 空闲，大于 0 = 正在进行第几步 */
let syncBusy = 0;
let syncTimer = null;
let listeners = [];

/*: 同步循环的间隔。30 秒是个折中：
     太短费电费流量，太长老板看不到"即时"的工时。
     另外切回前台时会立刻同步一次，所以这个间隔只影响
     "应用一直开着"的情况。 */
/* 后台轮询间隔。

   **这个值决定了"多久能收到通知"的上限。**

   原来是 30 秒——老板派了任务，员工手机最多要等半分钟才有反应，
   而且应用一进后台，安卓会冻结 WebView 的定时器，
   实际是"打开 App 才开始同步"。

   改到 15 秒：派任务后最慢 15 秒弹窗，体感上接近"立即"。
   再快（比如 5 秒）会让服务端请求数翻几倍，而这是个人小团队在用，
   没必要为一两秒的差别增加耗电和配额消耗。 */
const SYNC_INTERVAL_MS = 15000;

/*: 一次同步最多处理多少条队列项。
     防止积压太多时一次请求过大、卡住界面。剩下的下轮继续。 */
const QUEUE_BATCH = 40;

/* ---------------------------------------------------------- 配置 */

/*: uuid 的形状。用来在把 id 发给服务端之前先自己检查一遍——
   服务端对类型很严格，发个 "1" 过去会报
   "invalid input syntax for type uuid"，
   而这个报错看不出是哪个字段、哪个员工的问题。 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*: **预置的云服务配置。**

   为什么要预置：让用户手填 URL 和 anon key 太麻烦了——
   那串 key 有一百多个字符，还得先搞清楚该复制哪一个
   （后台有 Project URL / RESTful endpoint / Auth endpoint
   好几个复制按钮，我见过的是粘错了导致
   "Invalid path specified in request URL"）。

   而这两个值**本来就是要打进 apk 的**：安全不靠"藏起来"，
   靠服务端的行级权限策略（RLS）。所以直接写死，用户零配置。

   设置页仍然保留——换项目、自建服务的人可以覆盖。 */
const CLOUD_DEFAULTS = {
  url: "https://edchntmyqqjqvpngylgc.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I",
};

/*: Supabase 连接信息。优先用用户自己填的，没填就用预置的。 */
function syncConfig() {
  const savedUrl = getSetting("supabase_url", "");
  const savedKey = getSetting("supabase_key", "");
  return {
    url: savedUrl || CLOUD_DEFAULTS.url,
    key: savedKey || CLOUD_DEFAULTS.key,
    /* 标记一下是预置的还是用户填的，界面上要区别对待 */
    custom: !!(savedUrl || savedKey),
  };
}

/* 把用户填的 Supabase 地址规整成"只有协议 + 域名"的形式。

   ## 为什么必须做这个

   Supabase 后台有**很多个**复制按钮，位置不同、内容不同：

     Project URL          https://xxx.supabase.co
     RESTful endpoint     https://xxx.supabase.co/rest/v1/
     Auth endpoint        https://xxx.supabase.co/auth/v1

   **用户很可能复制到带路径的那个。**

   而 `createClient(url)` 会自己拼 `url + "/rest/v1"`。
   如果传进去的是 `https://xxx.supabase.co/rest/v1/`，
   最终请求会变成 `https://xxx.supabase.co/rest/v1//rest/v1/...`，
   Supabase 返回 **"Invalid path specified in request URL"**。

   这个报错完全看不出是"地址多粘了一段"，所以这里直接规整掉：
   只保留协议 + 域名 + 端口。 */
function normalizeCloudUrl(input) {
  let text = String(input || "").trim();
  if (!text) return "";

  /* 少了协议就补上。用户经常只粘 xxx.supabase.co */
  if (!/^https?:\/\//i.test(text)) text = "https://" + text;

  try {
    const parsed = new URL(text);
    return parsed.protocol + "//" + parsed.host;
  } catch (error) {
    /* 不是合法 URL。原样返回（去掉末尾斜杠），
       让服务端报错时至少能看到用户到底填了什么。 */
    return text.replace(/\/+$/, "");
  }
}

function saveSyncConfig(url, key) {
  saveSetting("supabase_url", normalizeCloudUrl(url));
  saveSetting("supabase_key", String(key || "").trim());
}

function cloudReady() {
  const config = syncConfig();
  return !!(config.url && config.key);
}

/* ---------------------------------------------------------- 初始化 */
function initCloud() {
  if (!cloudReady()) return false;
  if (typeof window.supabase === "undefined") {
    /* CDN 没加载上（离线首启）。不是致命错误——
       下次联网再试，本地功能照常用。 */
    return false;
  }
  const config = syncConfig();
  try {
    cloudClient = window.supabase.createClient(config.url, config.key, {
      auth: {
        /* 会话持久化：关掉 App 再打开不用重新登录 */
        persistSession: true,
        autoRefreshToken: true,
        storageKey: "pr_auth_v1",
      },
    });
    return true;
  } catch (error) {
    cloudClient = null;
    return false;
  }
}

/* ---------------------------------------------------------- 订阅状态 */
/* 界面可以订阅同步状态变化，用来显示"待上传 3 条"这类提示 */
function onSyncChange(fn) {
  listeners.push(fn);
}

function emitSync(status) {
  listeners.forEach(fn => {
    try { fn(status); } catch (error) { /* 单个订阅者出错不影响别人 */ }
  });
}

function syncStatus() {
  const config = syncConfig();
  return {
    enabled: cloudReady(),
    hasLibrary: typeof window.supabase !== "undefined",
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    pending: pendingCount(),
    last: DB.lastSync || { at: "", ok: true, pending: 0, message: "" },
    busy: syncBusy > 0,
    role: DB.profile ? DB.profile.role : null,
    signedIn: !!DB.profile,
    configured: !!(config.url && config.key),
  };
}

/* ---------------------------------------------------------- 认证 */

function profileFromUser(user, extra) {
  return {
    id: user.id,
    code: (extra && extra.code) || user.email || "",
    name: (extra && extra.name) || user.email || "",
    role: (extra && extra.role) || "boss",
    boss_id: (extra && extra.boss_id) || null,
    weekly_hours: num(extra && extra.weekly_hours) || 40,
  };
}

/* 登录。

   用的是 Supabase Auth 的**邮箱密码**方式，但界面上让用户填
   "账号名"。做法是把账号名转成一个内部邮箱：
       boss  →  <账号名>@boss.pr
       staff →  <账号名>@staff.pr
   这样员工不用有真邮箱，而 Supabase 那边仍然是合法的邮箱格式。

   **这个转换必须和老板建账号时一致**，否则登录不上。 */
function loginCodeToEmail(code, isStaff) {
  const clean = String(code || "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  return clean + (isStaff ? "@staff.pr" : "@boss.pr");
}

/* 按指定身份试一次登录。

   **失败时返回错误对象，不抛异常**——因为"自动判断身份"要靠
   "这次失败了、换另一种试试"，抛异常会让调用方很难写。 */
async function tryLoginAs(code, password, isStaff) {
  const email = loginCodeToEmail(code, isStaff);
  let data = null;
  let error = null;

  try {
    const result = await cloudClient.auth.signInWithPassword({
      email: email, password: password,
    });
    data = result.data;
    error = result.error;
  } catch (thrown) {
    error = { message: String(thrown.message || thrown) };
  }

  /* 邮箱没确认 —— 说明服务端的「Confirm email」开关还开着。
     GoTrue 的原文是 "Email not confirmed"，看不懂的人会以为是密码错了。 */
  if (error && /not confirmed|email_not_confirmed/i.test(error.message || "")) {
    try {
      const retry = await cloudClient.auth.signInWithPassword({
        email: email, password: password,
      });
      if (!retry.error && retry.data) { data = retry.data; error = null; }
    } catch (thrown) { /* 保留原错误 */ }
  }

  /* 刚建完的账号可能还没被 GoTrue 完全认到，表现也是 invalid_credentials。
     等 1.2 秒再试一次。 */
  if (error && /invalid.*credentials/i.test(error.message || "")) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    try {
      const retry = await cloudClient.auth.signInWithPassword({
        email: email, password: password,
      });
      if (!retry.error && retry.data) { data = retry.data; error = null; }
    } catch (thrown) { /* 保留原错误 */ }
  }

  if (error) return { ok: false, message: error.message, email: email };
  return { ok: true, data: data, email: email };
}

/* 登录。

   ## 界面上的身份选择 + 选错也能登

   登录页有「我是老板 / 我是员工」。它是**为了让人一眼看清身份**，
   不该变成"选错就登不上"的陷阱。

   所以：**先按选的身份试一次，不行再按另一种试一次。**

   为什么可以这样兜底：
     · 内部邮箱是 `<账号名>@boss.pr` 和 `<账号名>@staff.pr`
     · 同一个人不会既是老板又是员工（除非故意把工号起成手机号）
     · 代价是选错时多一个请求，登录不敏感，可以接受

   `roleHint`：true = 员工，false = 老板，不传 = 直接按老板开始试。 */
async function cloudLogin(code, password, roleHint) {
  if (!initCloud()) throw new Error("云服务没有配置");

  /* 先试调用方指定的身份（界面选的那个）。
     roleHint 没传时按老板开始——老板是登录页的默认身份。 */
  const firstIsStaff = roleHint === true;
  const first = await tryLoginAs(code, password, firstIsStaff);
  if (first.ok) {
    await adoptSession(first.data.user);
    DB.loginRoleGuessed = firstIsStaff ? "employee" : "boss";
    _save();
    return DB.profile;
  }

  /* 指定的身份不行 → 试另一种。
     **这一步就是"选错了也能进去"。** */
  const second = await tryLoginAs(code, password, !firstIsStaff);
  if (second.ok) {
    await adoptSession(second.data.user);
    DB.loginRoleGuessed = firstIsStaff ? "boss" : "employee";
    _save();
    return DB.profile;
  }

  /* 两种都不行。**把"两种身份都试过了"说出来**，
     否则用户会以为是密码错，而其实可能是根本没建号。 */
  const both = String(first.message || "") + String(second.message || "");
  if (/not confirmed|email_not_confirmed/i.test(both)) {
    throw new Error("这个账号还没确认邮箱。\n\n"
      + "去 Supabase 后台把「Confirm email」关掉，"
      + "或者在 Authentication → Users 里确认这个账号。");
  }
  const who = firstIsStaff ? "员工" : "老板";
  throw new Error("账号或密码不对（" + who + "和另一种身份都试过了）。\n\n"
    + "· 老板用手机号登录\n"
    + "· 员工用工号登录\n"
    + "· 都没有账号的话：老板在登录页点「创建一个老板账号」，"
    + "员工让老板在 App 里建号");
}

/* ---------------------------------------------------------- 账号管理 */

/* 改自己的密码。

   **这是"忘了密码就是死局"的一半解药**：只要还记得现在的密码，
   就能自己在 App 里换成新的，不用去 Supabase 后台。

   走 Supabase 的 `updateUser`——它只改"当前登录的那个人"，
   所以不需要任何额外权限，也不会误改别人。 */
async function changeMyPassword(oldPassword, newPassword) {
  const profile = DB.profile;
  if (!profile) throw new Error("还没登录");
  if (String(newPassword || "").length < 6) {
    throw new Error("新密码至少要 6 位");
  }
  if (String(newPassword) === String(oldPassword)) {
    throw new Error("新密码和旧密码一样");
  }
  if (!initCloud()) throw new Error("云组件没加载上，检查网络");

  /* 先验旧密码：拿现在这个密码登一次。
     不验的话，谁拿到手机都能改密码——那是安全隐患。
     （Supabase 的 updateUser 不需要旧密码，所以这一步要自己做。） */
  const email = loginCodeToEmail(profile.code,
    profile.role === "employee");
  const check = await tryLoginAs(profile.code, oldPassword,
    profile.role === "employee");
  if (!check.ok) {
    throw new Error("现在的密码不对");
  }
  void email;

  const { error } = await cloudClient.auth.updateUser({
    password: String(newPassword),
  });
  if (error) throw new Error(translateAuthError(error.message));

  /* 本地那份明文密码（老板能看到员工初始密码那份）也要跟着更新，
     否则老板以后看到的是旧的。 */
  const account = staffAccounts().find(item =>
    String(item.employee_id) === String(profile.id));
  if (account) {
    account.password = String(newPassword);
    _save();
  }
  return true;
}

/* 换登录名（老板：手机号；员工：工号）。

   **客户端做不到**：Supabase 改邮箱要发确认信到新邮箱，
   而我们用的是假邮箱，收不到。所以走服务端函数
   （见 sql/account-management.sql 的 rename_my_login）。

   这一步很实用：老板注册时手机号打错一个数字，
   以前只能跑 SQL 改，现在自己在 App 里就能改。 */
async function changeMyLogin(newCode) {
  const profile = DB.profile;
  if (!profile) throw new Error("还没登录");
  const code = String(newCode || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(code)) {
    throw new Error("只能用字母、数字和 . _ -，长度 3~20 位。\n\n"
      + "（中文和空格不能用——内部要拼成邮箱）");
  }
  if (code === String(profile.code).toLowerCase()) {
    throw new Error("和现在的登录名一样");
  }
  if (!initCloud()) throw new Error("云组件没加载上，检查网络");

  const result = await cloudClient.rpc("rename_my_login", {
    p_new_code: code,
  });
  if (result.error) throw new Error(translateAccountError(result.error.message));
  const payload = result.data || {};
  if (!payload.ok) throw new Error("服务端没有返回成功");

  /* 本地也要跟着改，否则下次登录用的是旧名字 */
  profile.code = payload.code || code;
  _save();
  return profile.code;
}

/* 注销账号。

   **以前只能跑 SQL 删**（我误建的 probe 账号就清不掉）。
   现在自己能在 App 里注销。

   服务端函数只做两件事：确认"你是你自己"，然后删掉那一行。
   `auth.users` 一删，profiles / tasks / logs / worklogs 靠外键级联跟着删。 */
async function deleteMyAccount(password) {
  const profile = DB.profile;
  if (!profile) throw new Error("还没登录");
  if (!password) throw new Error("请输入密码确认");

  /* 验密码：不验的话，别人拿到你手机就能把你账号删了 */
  const check = await tryLoginAs(profile.code, password,
    profile.role === "employee");
  if (!check.ok) throw new Error("密码不对，没有注销");

  if (!initCloud()) throw new Error("云组件没加载上，检查网络");
  const result = await cloudClient.rpc("delete_my_account");
  if (result.error) throw new Error(translateAccountError(result.error.message));

  /* 本地也清干净：退登录 + 清同步状态。
     **本机的项目/工时/习惯不删**——那些是用户自己记的，
     和云端账号是两回事（提示里会说清楚）。 */
  await cloudLogout();
  return true;
}

/* 重置密码（**不需要旧密码**）。

   用途：员工忘了密码、老板也忘了自己设的初始密码。
   以前这种情况只能去 Supabase 后台改，现在 App 里能重置。

   安全性靠什么：
     · 员工：只有**他的老板**能重置（服务端检查 boss_id）
     · 老板：只能重置**自己名下**的员工，不能碰别人的
   也就是说"能重置谁"和"能看见谁"是同一个范围。 */
async function resetStaffPassword(employeeId, newPassword) {
  const profile = DB.profile;
  if (!profile || profile.role !== "boss") {
    throw new Error("只有老板能重置员工的密码");
  }
  if (String(newPassword || "").length < 6) {
    throw new Error("新密码至少要 6 位");
  }
  if (!initCloud()) throw new Error("云组件没加载上，检查网络");

  const result = await cloudClient.rpc("reset_staff_password", {
    p_employee_id: String(employeeId),
    p_new_password: String(newPassword),
  });
  if (result.error) throw new Error(translateAccountError(result.error.message));

  /* 本地的明文副本也更新，方便老板再看一次告诉员工 */
  const account = staffAccounts().find(item =>
    String(item.employee_id) === String(employeeId));
  if (account) {
    account.password = String(newPassword);
    _save();
  }
  return true;
}

/* 账号相关函数的英文报错 → 中文 */
function translateAccountError(message) {
  const text = String(message || "");
  if (/could not find the function|does not exist/i.test(text)
      && /rename_my_login|delete_my_account|reset_staff_password/i.test(text)) {
    return "云端的账号管理功能还没装。\n\n"
      + "去 Supabase 的 SQL Editor 跑一遍 sql/account-management.sql";
  }
  if (/already taken|already exists|duplicate key/i.test(text)) {
    return "这个登录名已经被用了，换一个";
  }
  if (/only a boss/i.test(text)) return "只有老板能做这件事";
  if (/not your staff|not found/i.test(text)) {
    return "这个员工不在你名下，动不了";
  }
  if (/code may only contain/i.test(text)) {
    return "登录名只能用字母、数字和 . _ -，长度 3~20 位";
  }
  if (/password must be at least/i.test(text)) {
    return "密码至少要 6 位";
  }
  if (/not signed in/i.test(text)) return "登录状态过期了，重新登录一次";
  return text;
}

/* 把登录结果落到本地。
   profiles 表里存着角色和所属老板，必须读出来才知道该显示什么界面。 */
async function adoptSession(user) {
  if (!user) { DB.profile = null; _save(); return null; }
  let extra = null;
  try {
    const { data } = await cloudClient.from("profiles")
      .select("*").eq("id", user.id).single();
    extra = data;
  } catch (error) {
    /* 读不到 profile 不阻塞登录——先用基本信息进去，
       界面会提示"资料没同步上"。比直接登录失败好。 */
  }
  DB.profile = profileFromUser(user, extra);
  resetSyncState();
  _save();
  return DB.profile;
}

async function cloudLogout() {
  try { if (cloudClient) await cloudClient.auth.signOut(); } catch (error) { /* 忽略 */ }
  DB.profile = null;
  resetSyncState();
  _save();
}

/* 启动时恢复上次的登录状态。
   **离线也要能恢复**——本地存了 profile 副本，所以没网也能进主界面。 */
async function restoreSession() {
  if (!initCloud()) return DB.profile;
  try {
    const { data } = await cloudClient.auth.getSession();
    if (data && data.session && data.session.user) {
      await adoptSession(data.session.user);
    }
  } catch (error) {
    /* 没网时这里会失败。本地 DB.profile 还在，照常用。 */
  }
  return DB.profile;
}

/* 把 Supabase 的英文报错换成能看懂的中文。
   直接用原文的话，用户看到 "Invalid login credentials" 不知道该干什么。 */
function translateAuthError(message) {
  const text = String(message || "");
  if (/Invalid login credentials/i.test(text)) {
    return "账号或密码不对。老板用手机号登录，员工用工号登录，两边不通用。";
  }
  if (/Email not confirmed/i.test(text)) {
    return "这个账号还没确认邮箱。去 Supabase 后台把"
         + " Authentication → Sign In / Providers → Email 里的"
         + " Confirm email 关掉。";
  }
  if (/User already registered/i.test(text)) return "这个账号名已经被占用了。";
  if (/Password should be at least/i.test(text)) {
    return "密码太短了，至少 6 位。";
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(text)) {
    return "连不上服务器。检查网络，或者确认 Supabase 地址填对了。";
  }
  return text;
}

/* ---------------------------------------------------------- 上传 */

/* 把队列里的变更推上去。

   逐条处理而不是批量：任何一条失败都只影响它自己，
   其余的照常上传。批量提交的话一条脏数据会让整批回滚。

   ## 失败时的处理（这块我改过一次，因为踩了坑）

   原来失败只往 `DB.lastSync.message` 写一句，而**下一轮同步会把它
   覆盖掉**——结果"任务没传上去"这件事在界面上完全看不出来，
   看起来像"已同步"。这是最危险的失败模式：
   用户以为报上去了，老板那边什么都没有。

   现在：
     · 失败的项**留在队列里**，不删（下次还会重试）
     · 每项记下 `lastError`，界面上能看到具体原因
     · 返回失败清单，调用方可以据此提示

   **只有服务端明确说"唯一约束冲突"时才丢弃**——
   那种情况重试多少次都不会成功，留着只会永远堵住队列。 */
async function pushQueue() {
  if (!cloudClient || !DB.profile) return { pushed: 0, failed: [] };
  const queue = DB.syncQueue || [];
  if (!queue.length) return { pushed: 0, failed: [] };

  const batch = queue.slice(0, QUEUE_BATCH);
  const done = [];
  const failed = [];

  for (let i = 0; i < batch.length; i += 1) {
    const item = batch[i];
    try {
      if (item.op === "delete") {
        const result = await cloudClient.from(item.table)
          .delete().eq("id", item.key);
        if (result.error) throw new Error(result.error.message);
      } else {
        const result = await cloudClient.from(item.table)
          .upsert(item.payload, { onConflict: "id" });
        if (result.error) throw new Error(result.error.message);
      }
      done.push(item.id);
      delete item.lastError;
      delete item.lastErrorAt;
    } catch (error) {
      const message = String(error.message || error);

      /* 唯一约束冲突：服务端已经有这条了，重试也不会成功。
         当作成功丢弃，否则队列会被这一条永远堵住。 */
      if (/duplicate key|unique constraint|violates.*unique/i.test(message)) {
        done.push(item.id);
        continue;
      }

      /* 表不存在：sql/migrate-notify.sql 没跑。
 
         **这种也要丢弃**，和唯一约束同理——表不会自己出现，
         留着只会把队列永远堵住，而且用户完全不知道是这个原因。
         通知功能降级（没有通知），但别的功能照常。
 
         记一条提示，让界面能说清楚"要跑哪段 SQL"。
 
         **注意：这个标记要能自己消掉。**
         原来只在这里设 true，没有任何地方设回 false——
         于是"跑完 SQL 之后提示还在"，用户会以为没生效。
         清除在 verifyNotifyTable() 里做（临同步时验一次）。 */
      if (item.table === "task_events"
          && /Could not find the table|does not exist|schema cache/i.test(message)) {
        DB.notifyTableMissing = true;
        done.push(item.id);
        continue;
      }

      /* 其他错误：留着并记下原因。
         **不静默吞掉**——上一轮就是因为吞掉了，
         "tasks 表缺 updated_at 列" 这个错误查了很久。 */
      item.lastError = message;
      item.lastErrorAt = nowISO();
      failed.push({ table: item.table, op: item.op, message: message });
    }
  }

  if (done.length) clearQueueItems(done);
  _save();

  return { pushed: done.length, failed: failed };
}

/* ---------------------------------------------------------- 下载 */

/* 增量拉取。

   用 syncCursor 记各表上次拉到的时间，只拉更新的。
   没有 cursor 就只能每次全量拉——数据一多就明显变慢，
   而且流量全浪费在没变的数据上。

   ## 返回值

   以前只返回"变了多少条"（一个数字）。现在还要给通知模块
   提供**新事件**和**新工时**，所以改成对象：

     { changed, events, newWorklogs }

   `events` 是这次拉到的新 task_events（老板看员工的完成/取消，
   员工看老板派的活）；`newWorklogs` 是这次新拉到的工时行，
   用来合成"今天收到 N 条工时"那条汇总。 */
async function pullAll() {
  const empty = { changed: 0, events: [], newWorklogs: [] };
  if (!cloudClient || !DB.profile) return empty;
  const profile = DB.profile;
  const cursor = DB.syncCursor || {};
  let changed = 0;
  const newWorklogs = [];
  let events = [];

  /* ---- 任务 ---- */
  if (profile.role === "employee") {
    let query = cloudClient.from("tasks").select("*")
      .eq("employee_id", profile.id)
      .order("plan_date", { ascending: false })
      .limit(200);
    if (cursor.tasks) query = query.gt("updated_at", cursor.tasks);
    const { data, error } = await query;
    if (!error && data) {
      changed += mergeTasks(data);
      DB.syncCursor.tasks = nowISO();
    }
  }

  /* ---- 工时（老板端拉员工的，员工端拉自己确认过的） ---- */
  {
    let query = cloudClient.from("worklogs").select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (profile.role === "boss") {
      query = query.eq("boss_id", profile.id);
    } else {
      query = query.eq("employee_id", profile.id);
    }
    if (cursor.worklogs) query = query.gt("created_at", cursor.worklogs);
    const { data, error } = await query;
    if (!error && data) {
      changed += mergeRemoteWorklogs(data);
      DB.syncCursor.worklogs = nowISO();
      /* 记下这次新拉到的行，给"今天收到 N 条工时"那条汇总用。
         只算新拉到的，不是全部——否则每次同步都会提醒一遍。 */
      data.forEach(row => newWorklogs.push(row));
    }
  }

  /* ---- 自己的勾选记录（用来显示"今天完成了几条"） ---- */
  if (profile.role === "employee") {
    let query = cloudClient.from("task_logs").select("*")
      .eq("employee_id", profile.id)
      .order("finished_at", { ascending: false })
      .limit(200);
    if (cursor.taskLogs) query = query.gt("finished_at", cursor.taskLogs);
    const { data, error } = await query;
    if (!error && data) {
      changed += mergeTaskLogs(data);
      DB.syncCursor.taskLogs = nowISO();
    }
  }

  /* ---- 任务事件（通知的来源） ----
     老板拉自己任务上的事件（员工完成 / 取消完成），
     员工拉派给自己的事件（老板派了新活）。

     **拉不到不算错误**：如果服务端还没建 task_events 表
     （sql/migrate-notify.sql 没跑），这里会报 404 之类的错。
     那种情况下应用内其他功能照常，只是没有通知——
     不能因为通知拉不到就让整个同步显示失败。 */
  {
    let query = cloudClient.from("task_events").select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (profile.role === "boss") {
      query = query.eq("boss_id", profile.id);
    } else {
      query = query.eq("employee_id", profile.id);
    }
    if (cursor.taskEvents) query = query.gt("created_at", cursor.taskEvents);
    const { data, error } = await query;
    if (!error && data) {
      events = data;
      DB.syncCursor.taskEvents = nowISO();
    }
  }

  return { changed: changed, events: events, newWorklogs: newWorklogs };
}

/* 把服务端的任务并入本地缓存。

   匹配用**服务端 id**（uuid），不是本地自增 id——
   自增 id 每台机器各自算，两台手机的同一条任务会撞到不同数字上。 */
function mergeTasks(rows) {
  let changed = 0;
  rows.forEach(row => {
    const existing = (DB.tasks || []).find(item => item.id === row.id);
    if (existing) {
      /* 任务内容可能被老板改过，直接覆盖 */
      Object.assign(existing, row);
    } else {
      DB.tasks.push(row);
      changed += 1;
    }
  });
  if (changed || rows.length) _save();
  return changed;
}

function mergeTaskLogs(rows) {
  let changed = 0;
  if (!Array.isArray(DB.taskLogs)) DB.taskLogs = [];
  rows.forEach(row => {
    const existing = DB.taskLogs.find(item => item.id === row.id);
    if (existing) Object.assign(existing, row);
    else { DB.taskLogs.push(row); changed += 1; }
  });
  if (changed || rows.length) _save();
  return changed;
}

/* 老板端收到的员工工时。

   **放进独立的 remoteWorklogs，不混进 worklogs**：
     混在一起的话就没法区分"我自己记的"和"员工报上来的"，
     而这两者的编辑、删除、去重规则完全不同。
     统计的时候两边都算上，展示的时候分开。 */
function mergeRemoteWorklogs(rows) {
  let changed = 0;
  if (!Array.isArray(DB.remoteWorklogs)) DB.remoteWorklogs = [];
  rows.forEach(row => {
    const existing = DB.remoteWorklogs.find(item => item.id === row.id);
    if (existing) Object.assign(existing, row);
    else { DB.remoteWorklogs.push(row); changed += 1; }
  });
  if (changed || rows.length) _save();
  return changed;
}

/* ---------------------------------------------------------- 同步主流程 */

/*: 正在进行的同步。用来让并发调用「等同一个结果」。 */
let syncInFlight = null;

/* 同步一次。

   ## 并发调用必须等同一个 Promise（这是个真 bug 的修法）

   原来是：
       if (syncBusy > 0) return syncStatus();   // 直接返回"同步中"的快照

   问题：`assignTask()`、`completeTask()` 内部都会自动调一次 syncNow，
   调用方（比如界面、测试）可能紧接着又调一次。第二次进来时
   看到 syncBusy > 0，**直接返回旧状态**——
   调用方拿到的是"还没传完"的快照，以为失败了，
   界面上就会显示"待上传 N 条"，看起来像没传上去。

   现在改成**复用在飞的那个 Promise**：并发调用会等到真正结束，
   拿到的是最终状态。 */
/* 验一下服务端的 task_events 表到底在不在，并据此更新提示。

   只在 `DB.notifyTableMissing` 是 true 的时候调用——
   正常情况一次网络请求都不多发。

   为什么需要它：那个标记原来是**只进不出**的。
   用户看到"通知功能没装好"，把 SQL 跑了，提示还在，
   于是以为 SQL 没生效。**其实只是本机记着一个旧结论。**

   判断依据：
     · 读成功（哪怕 0 行）→ 表在，清掉标记
     · 报"找不到表" → 表真不在，保持标记
     · 其他错误（网络断了、权限问题）→ **不动标记**，
       不能因为一次网络抖动就把提示撤掉 */
async function verifyNotifyTable() {
  try {
    const result = await cloudClient.from("task_events")
      .select("id").limit(1);
    if (!result.error) {
      if (DB.notifyTableMissing) {
        DB.notifyTableMissing = false;
        _save();
      }
      return true;
    }
    const message = String(result.error.message || "");
    if (!/Could not find the table|does not exist|schema cache/i.test(message)) {
      /* 不是"表不存在"，是别的毛病（网络、权限）——不轻易下结论 */
      return false;
    }
    return false;
  } catch (error) {
    /* 网络异常：保持现状 */
    return false;
  }
}

async function syncNow(reason) {
  /* 已经有同步在跑：等它，而不是返回中间状态 */
  if (syncInFlight) return syncInFlight;

  if (!cloudReady() || !DB.profile) return syncStatus();
  if (!initCloud()) {
    DB.lastSync = {
      at: nowISO(), ok: false, pending: pendingCount(),
      message: "云组件没加载上，先跑 node fetch-vendor.js 再打包",
    };
    _save();
    return syncStatus();
  }

  syncInFlight = (async () => {
    syncBusy = 1;
    emitSync(syncStatus());
    try {
      syncBusy = 2;
      const pushed = await pushQueue();

      /* **表建好了就把"没装好"的提示撤掉。**

         `DB.notifyTableMissing` 原来只进不出：某次上传失败设成 true，
         之后永远显示"通知功能没装好"，**哪怕用户早就把 SQL 跑了**。
         用户看到提示还在，会以为没生效——这是真发生过的困惑。

         所以每次同步都顺手验一下：能读到表就说明已经装好了。
         只在标记为 true 时才查，正常情况零开销。 */
      if (DB.notifyTableMissing) await verifyNotifyTable();

      syncBusy = 3;
      const pulled = await pullAll();
      const changed = typeof pulled === "number" ? pulled : (pulled.changed || 0);

      /* **通知在同步成功之后才处理。**

         失败时处理会把"没拉到数据"误判成"没有新事件"，
         而且下次同步又会重复提醒同一批。 */
      if (typeof pumpNotifications === "function") {
        await pumpNotifications({
          events: pulled && pulled.events ? pulled.events : null,
          worklogs: pulled && pulled.newWorklogs ? pulled.newWorklogs : null,
        });
      }

      /* **上传失败必须如实显示**，不能被"收到几条新数据"盖过去。

         之前有个 bug 就是这样漏掉的：tasks 表缺一列，
         upsert 一直被拒，而界面显示"已同步"——
         用户以为报上去了，老板那边什么都没有。 */
      if (pushed && pushed.failed && pushed.failed.length) {
        DB.lastSync = {
          at: nowISO(),
          ok: false,
          pending: pendingCount(),
          message: `${pushed.failed.length} 条没传上去：`
            + pushed.failed[0].message,
        };
      } else {
        DB.lastSync = {
          at: nowISO(),
          ok: true,
          pending: pendingCount(),
          message: changed ? `收到 ${changed} 条新数据` : "",
        };
      }
      _save();
    } catch (error) {
      DB.lastSync = {
        at: nowISO(),
        ok: false,
        pending: pendingCount(),
        message: String(error.message || error),
      };
      _save();
    } finally {
      syncBusy = 0;
      syncInFlight = null;
      emitSync(syncStatus());
    }
    return syncStatus();
  })();

  return syncInFlight;
}

/* 启动定时同步 + 网络/前后台事件。

   **切回前台立刻同步一次**——手机上 App 长期挂后台时
   定时器会被系统冻结，只靠 30 秒轮询的话，
   用户切回来看到的还是旧数据。 */
function startSyncLoop() {
  stopSyncLoop();
  syncTimer = setInterval(() => syncNow("timer"), SYNC_INTERVAL_MS);

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncNow("visible");
    });
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", () => syncNow("online"));
  }

  /* **实时订阅：事件一到就立刻同步，不用等轮询。**

     这是"一发就弹窗"的关键。轮询最快也要等 15 秒；
     实时订阅是服务器**主动推**过来，通常 1 秒内就到。

     订阅的是 task_events 表的变更（老板派任务 → assigned，
     员工勾选 → done）。收到推送后调 syncNow 走原来的流程，
     所以通知、红点、提示条全都自动跟上，不用另外写一套。 */
  /* **要 catch**：subscribeRealtime 是 async 的，
     它内部虽然有 try/catch，但 await getSession() 那一步万一
     抛出未预期的错误，没有这个 catch 会变成"未处理的 Promise 拒绝"，
     在某些 WebView 里会直接打断整个同步循环。 */
  subscribeRealtime().catch(error => {
    realtimeState = "订阅异常：" + error.message;
  });
}

function stopSyncLoop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  unsubscribeRealtime();
}

/* ---------------------------------------------------------- 实时订阅 */

let realtimeChannel = null;

/* 实时连接的状态。**要能看见。**

   为什么必须做成可见的：实时订阅失败是**静默**的——
   订阅回调会说 SUBSCRIBED，但如果不满足条件（比如没带认证令牌、
   服务端没开实时发布），事件会被服务端悄悄过滤掉，
   客户端什么都不报。用户只觉得"还是慢"，根本无从查起。

   所以我记一个状态字符串，界面（「我的」页）能显示出来，
   出问题时一眼看到卡在哪一步。 */
let realtimeState = "未连接";

/* 订阅 task_events 的变更。

   ## 为什么能只收到"和我有关"的行

   Supabase 的实时推送会**应用 RLS 策略**：
   task_events 的读策略是 `boss_id = auth.uid() or employee_id = auth.uid()`，
   所以员工只会收到派给自己的事件，老板只收到自己名下的。

   ## 关键：必须显式带上登录令牌

   服务端判断 `auth.uid()` 靠的是连接上带的 JWT。
   supabase-js 通常会在登录时把令牌同步给 realtime 客户端，
   但那只在"用户对象发生变化"的事件里做——
   **从本机存储恢复会话时不一定触发**。

   结果就是：连接建立了、订阅回调说 SUBSCRIBED、
   但服务端不知道你是谁，RLS 把每一行都过滤掉，
   **一条推送都收不到，而且完全不报错。**

   所以这里显式取一次 access_token 并 setAuth。 */
async function subscribeRealtime() {
  unsubscribeRealtime();

  if (typeof cloudClient === "undefined" || !cloudClient
      || typeof cloudClient.channel !== "function") {
    realtimeState = "库不支持";
    return false;
  }
  if (!DB.profile) {
    realtimeState = "未登录";
    return false;
  }

  try {
    /* **① 先把登录令牌交给实时连接。**
       不做这一步的话，服务端不知道你是谁，推什么都过不了 RLS。 */
    try {
      const session = await cloudClient.auth.getSession();
      const token = session && session.data && session.data.session
        ? session.data.session.access_token : null;
      if (token && cloudClient.realtime
          && typeof cloudClient.realtime.setAuth === "function") {
        cloudClient.realtime.setAuth(token);
        realtimeState = "令牌已设置";
      } else {
        realtimeState = "拿不到令牌";
      }
    } catch (error) {
      realtimeState = "取令牌失败：" + error.message;
    }

    const me = DB.profile.id;
    realtimeChannel = cloudClient
      .channel("task-events-" + me)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "task_events" },
        () => {
          /* 收到推送就同步一次。

             **不直接拿推送里的数据**——推送只带这一行，
             而同步要处理"取消完成时撤销工时"这类跨表逻辑。
             重新拉一遍最省心，而且 syncNow 自己有去重，
             连续几条推送不会打出几次重复请求。 */
          realtimeState = "收到推送 " + timeShort();
          syncNow("realtime");
        })
      .subscribe(status => {
        /* 订阅状态回调。SUBSCRIBED 才算真的连上。
           CHANNEL_ERROR / TIMED_OUT 要能看出来。 */
        realtimeState = "订阅：" + status + " " + timeShort();
      });

    if (!realtimeState || realtimeState === "令牌已设置") {
      realtimeState = "正在连接 " + timeShort();
    }
    return true;
  } catch (error) {
    /* 订阅不上就靠轮询，功能不受影响——但要让界面能说出来 */
    realtimeChannel = null;
    realtimeState = "订阅失败：" + error.message;
    return false;
  }
}

function timeShort() {
  const now = new Date();
  const pad = value => (value < 10 ? "0" : "") + value;
  return pad(now.getHours()) + ":" + pad(now.getMinutes())
    + ":" + pad(now.getSeconds());
}

function unsubscribeRealtime() {
  if (!realtimeChannel) return;
  try {
    cloudClient.removeChannel(realtimeChannel);
  } catch (error) {
    /* 关不掉也无所谓，下次订阅会覆盖 */
  }
  realtimeChannel = null;
}

/* =============================================================
   任务与工时：员工的勾选流程
   ============================================================= */

/* 员工勾选"完成"。

   本地立刻写 + 进队列（界面马上响应），然后**尝试**上传。
   上传失败不影响本地——记录已经在队列里，联网自动补传。

   ## 一个踩过的坑：id 必须是合法的 uuid

   我原来用 `task.id + "_" + date` 当 id，想表达"同一条任务同一天
   只有一条记录"。**但服务端的 id 列是 uuid 类型**，
   "0f8a…-…_2026-10-09" 这种 47 个字符的串直接被拒绝，
   表现是队列卡住两条永远传不上去，老板收不到工时。

   **"同一天只有一条"这件事应该由服务端的唯一约束保证**
   （建表时的 `unique (task_id, finish_date)`），
   而不是靠拼 id。本地要去重就单独查，别把它编进 id 里。 */
function completeTask(task, hours) {
  const profile = DB.profile;
  if (!profile) throw new Error("还没登录");
  if (!task) throw new Error("这条任务已经不存在了");

  const now = nowISO();
  const date = todayISO();

  /* 本地去重：同一条任务同一天只留一条 */
  if (!Array.isArray(DB.taskLogs)) DB.taskLogs = [];
  const existing = DB.taskLogs.find(item =>
    String(item.task_id) === String(task.id) && item.finish_date === date);
  if (existing) {
    /* 已经勾过了。重复勾选不产生新记录——服务端也有唯一约束兜着。 */
    return existing;
  }

  const log = {
    id: uuid(),
    task_id: task.id,
    employee_id: profile.id,
    started_at: task.started_at || null,
    finished_at: now,
    finish_date: date,
  };
  DB.taskLogs.push(log);

  /* 工时：优先用实际耗时，其次用任务的预估工时 */
  let worked = num(hours);
  if (!worked && task.started_at) {
    const started = parseDate(task.started_at);
    if (started) worked = Math.max(0.1, (Date.now() - started.getTime()) / 3600000);
  }
  if (!worked) worked = num(task.est_hours);
  if (!worked) worked = 1;                  // 最后的兜底：算 1 小时
  worked = Math.round(worked * 100) / 100;

  const worklog = {
    id: uuid(),
    boss_id: task.boss_id,
    employee_id: profile.id,
    task_id: task.id,
    work_date: date,
    hours: worked,
    content: task.title,
    project_name: task.project_name || "",
    source: "task",
  };

  queueChange("task_logs", "insert", log.id, log);
  queueChange("worklogs", "insert", worklog.id, worklog);

  /* 记一条"完成"事件。

     **为什么单独记事件，不靠服务端 diff task_logs**：
     "完成了"能从 task_logs 推出来，但"取消完成"推不出来——
     那一行是被删掉的，客户端分不清"被删了"和"我还没拉到"。
     所以完成和取消都写成显式事件，老板端才有得拉。 */
  queueChange("task_events", "insert", uuid(), {
    boss_id: task.boss_id,
    employee_id: profile.id,
    task_id: task.id,
    kind: "done",
    title: task.title,
    hours: worked,
    work_date: date,
  });

  _save();

  /* 不等结果——界面已经更新了，上传在后台进行 */
  syncNow("task-complete");
  return log;
}

/* 取消勾选。本地删掉，同时排一个删除任务。

   删除要用**真实的 id**（uuid），不能用"任务+日期"拼出来——
   拼出来的 id 服务端根本没有，删不掉。所以先按 task_id + 日期
   把记录找出来，拿到它的 id 再删。 */
function uncompleteTask(taskId) {
  const date = todayISO();
  if (!Array.isArray(DB.taskLogs)) return false;
  const log = DB.taskLogs.find(item =>
    String(item.task_id) === String(taskId) && item.finish_date === date);
  if (!log) return false;

  DB.taskLogs = DB.taskLogs.filter(item => item.id !== log.id);

  /* 对应的工时记录也找出来一起删。
     按 task_id 匹配（本地和云端都用这个字段关联）。 */
  const worklog = (DB.remoteWorklogs || []).find(item =>
    String(item.task_id) === String(taskId) && item.work_date === date)
    || (DB.cloudWorklogIndex || {})[taskId];

  queueChange("task_logs", "delete", log.id, {});
  if (worklog && worklog.id) {
    queueChange("worklogs", "delete", worklog.id, {});
  }

  /* 记一条"取消完成"事件。

     **这条是通知功能里唯一必须显式记录的东西**：
     取消完成之后 task_logs 和 worklogs 里那一行就没了，
     老板端只靠拉数据**看不出"曾经有、现在被撤了"**——
     它分不清"被删了"和"我还没拉到"。

     所以取消也要写成事件。老板端拉到 kind='undone'
     就知道该把工时撤掉并提醒老板。

     boss_id 必须是**任务的老板**。而员工端 DB.profile 是员工自己，
     所以要读 profile.boss_id（建号时服务端设的归属）。 */
  const task = taskById(taskId)
    || (DB.tasks || []).find(item => String(item.id) === String(taskId));
  const profile = DB.profile;
  const bossId = (task && task.boss_id)
    || (profile && profile.boss_id) || null;
  if (!bossId) {
    /* 没有 boss_id 的话事件写不进（那一列是 not null）。
       宁可在这里说清楚，也不要静默丢一条事件。 */
    throw new Error("不知道这条任务属于哪个老板，取消完成没法上报");
  }
  queueChange("task_events", "insert", uuid(), {
    boss_id: bossId,
    employee_id: profile ? profile.id : null,
    task_id: taskId,
    kind: "undone",
    title: (task && task.title) || "",
    work_date: date,
  });

  _save();
  syncNow("task-uncomplete");
  return true;
}

/* 员工点"开始"。只记时间，不产生工时记录。 */
function startTask(taskId) {
  const task = taskById(taskId);
  if (!task) throw new Error("这条任务已经不存在了");
  task.started_at = nowISO();
  _save();
  return task.started_at;
}

/* ---------------------------------------------------------- 老板端 */

/* 老板创建员工账号。

   ## 一次调用搞定

   走数据库函数 `create_staff_account`（见 sql/create-staff-rpc.sql）。
   那个函数是 SECURITY DEFINER，以数据库属主身份运行，
   所以能写 auth.users —— 而 service_role key 始终留在数据库里，
   客户端看不到。

   **不再需要去 Supabase 后台建号、也不需要"同步账号"那一步**：
   函数建完号直接把 boss_id 设成当前老板，员工立刻就能登录、
   立刻能看到派给自己的任务。

   ## 为什么不用 signUp

   Supabase 的 `auth.signUp()` 会把当前会话换成新注册那个账号，
   老板建完一个员工就被登出了。 */
async function createEmployeeLocal(data) {
  const name = String(data.name || "").trim();
  const code = String(data.code || "").trim();
  if (!name) throw new Error("员工姓名不能为空");
  if (!code) throw new Error("登录工号不能为空");
  if (!/^[a-zA-Z0-9._-]{3,20}$/.test(code)) {
    throw new Error("工号只能用字母数字和 . _ -，长度 3~20 位");
  }
  if (String(data.password || "").length < 6) {
    throw new Error("密码至少要 6 位");
  }

  const profile = DB.profile;
  if (!profile || profile.role !== "boss") {
    throw new Error("只有老板能创建员工账号");
  }
  if (staffAccounts().some(item =>
      String(item.code).toLowerCase() === code.toLowerCase())) {
    throw new Error("工号 " + code + " 已经被用了");
  }

  /* 先把员工记录建在本地。
     这样即使网络断了，人员名单也是完整的，任务可以先派好，
     等联网再建云端账号。 */
  const employee = addEmployee({
    name: name,
    role: data.role || "",
    level: data.level || "",
    weekly_hours: data.weekly_hours || 40,
  });

  const account = {
    id: "local_" + employee.id,
    code: code,
    name: name,
    password: String(data.password),
    employee_id: employee.id,
    pending: true,
    created_at: nowISO(),
  };
  DB.staffAccounts.push(account);
  _save();

  /* 然后就建云端账号。 */
  await createCloudStaff(account);
  return account;
}

/* 在云端真正创建账号。

   失败不抛异常——本地记录已经建好了，标记 pending 就行，
   界面上显示"待创建"，联网后再点一次。
   **不抛的原因是**：老板在没网的时候也需要能把人员名单录进去。 */
async function createCloudStaff(account) {
  if (!cloudReady() || !DB.profile) {
    account.lastError = "还没登录云服务，账号只在本地";
    _save();
    return false;
  }
  if (!initCloud()) {
    account.lastError = "云组件没加载上";
    _save();
    return false;
  }

  try {
    const result = await cloudClient.rpc("create_staff_account", {
      p_code: account.code,
      p_password: account.password,
      p_name: account.name,
    });
    if (result.error) throw new Error(result.error.message);

    const payload = result.data || {};
    if (!payload.ok || !payload.id) {
      throw new Error("服务端没有返回账号 id");
    }

    /* 关键：把本地员工的 id 换成云端 uuid。

       员工报上来的工时里 employee_id 是云端 uuid，
       本地员工用的是自增整数。两边不统一的话，
       负荷统计找不到对应员工，员工报的工时会"消失"。 */
    const oldId = account.employee_id;
    const employee = (DB.employees || []).find(item =>
      String(item.id) === String(oldId));
    if (employee) {
      employee.id = payload.id;
      employee.cloud_id = payload.id;
      /* 本地所有引用这个旧 id 的地方都改过来 */
      (DB.worklogs || []).forEach(log => {
        if (String(log.employee_id) === String(oldId)) log.employee_id = payload.id;
      });
      (DB.assignments || []).forEach(item => {
        if (String(item.employee_id) === String(oldId)) item.employee_id = payload.id;
      });
      (DB.habits || []).forEach(item => {
        if (String(item.employee_id) === String(oldId)) item.employee_id = payload.id;
      });
    }
    account.employee_id = payload.id;
    account.cloud_id = payload.id;
    account.pending = false;
    delete account.lastError;
    if (payload.already_existed) {
      account.lastNote = "云端已经有这个工号了";
    }
    _save();
    return true;
  } catch (error) {
    /* 把数据库的英文报错转成能看懂的说明 */
    account.lastError = translateStaffError(error.message);
    account.pending = true;
    _save();
    return false;
  }
}

/* 数据库函数抛的英文错误 → 中文提示。
   直接用原文的话，老板看到 "code may only contain letters..."
   不知道该怎么办。 */
function translateStaffError(message) {
  const text = String(message || "");
  if (/code may only contain/i.test(text)) {
    return "工号只能用字母、数字和 . _ -，长度 3~20 位";
  }
  if (/password must be at least/i.test(text)) {
    return "密码至少要 6 位";
  }
  if (/only a boss/i.test(text)) {
    return "只有老板能创建员工账号";
  }
  if (/not signed in/i.test(text)) {
    return "登录状态过期了，重新登录一次";
  }
  if (/Could not find the function|does not exist/i.test(text)) {
    /* 指向整合后的那个文件。原来写的是 create-staff-rpc.sql，
       但那个函数现在也在 migrate-notify.sql 里重新定义了一遍
       （带去重和孤儿接管），所以让用户跑后者更准。 */
    return "云端的建号功能还没装。"
      + "去 Supabase SQL Editor 跑一遍 sql/migrate-notify.sql";
  }
  return text;
}

/* 重试所有还没建成功的账号。老板在账号页点一下就行。 */
async function retryPendingStaff() {
  const list = staffAccounts().filter(item => item.pending);
  let done = 0;
  const failures = [];
  for (let i = 0; i < list.length; i += 1) {
    const ok = await createCloudStaff(list[i]);
    if (ok) done += 1;
    else failures.push(list[i].code + "：" + (list[i].lastError || "未知原因"));
  }
  return { done: done, total: list.length, failures: failures };
}

function staffAccounts() {
  return Array.isArray(DB.staffAccounts) ? DB.staffAccounts : [];
}

/* 老板派发任务 */
function assignTask(data) {
  const profile = DB.profile;
  if (!profile || profile.role !== "boss") {
    throw new Error("只有老板能派任务");
  }
  const title = String(data.title || "").trim();
  if (!title) throw new Error("任务内容不能为空");
  if (!data.employee_id) throw new Error("要选一个员工");

  /* **先查格式，再查名单。**

     顺序不能反：
       · 格式不对（本地自增数字 "7"）→ 说"还没建云端账号"最准确
       · 格式对但不在名单里 → 说明选中的值失效了，让重选
     反过来的话，那种"还没建号的员工"会被报成"不在名单里"，
     用户按提示去重选，但问题其实是号没建好——**指错了方向**。 */
  const employeeId = String(data.employee_id);
  const account = staffAccounts().find(item =>
    String(item.employee_id) === employeeId);

  if (!UUID_PATTERN.test(employeeId)) {
    const reason = account && account.lastError
      ? "：" + account.lastError
      : "（还没有在云端建号）";
    throw new Error("这个员工还没有云端账号，派不了任务" + reason
      + "\n\n去「团队 → 员工账号」点「重试创建」，建好再派。");
  }
  if (!account) {
    throw new Error("选中的这个员工不在名单里，可能名单刚刷新过。\n\n"
      + "请重新选一次「派给谁」。");
  }

  const task = {
    /* 用 uuid 而不是本地自增 id：两台手机会算出相同的自增数字，
       撞在一起就会把别人的任务覆盖掉。 */
    id: uuid(),
    boss_id: profile.id,
    employee_id: employeeId,
    title: title,
    detail: String(data.detail || ""),
    plan_date: data.plan_date || todayISO(),
    est_hours: num(data.est_hours),
    project_name: String(data.project_name || ""),
    step_name: String(data.step_name || ""),
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  if (!Array.isArray(DB.tasks)) DB.tasks = [];
  DB.tasks.push(task);
  queueChange("tasks", "insert", task.id, task);
  /* **"派了新任务"这条事件不在这里写。**

     服务端 tasks 表上有个 after insert 触发器
     （见 sql/migrate-notify.sql 的 trg_task_assigned），
     插入任务时自动记一条 kind='assigned' 的事件。

     为什么放服务端：那样**任何建任务的路径都会产生事件**——
     App、脚本、直接在后台手写 insert。放在客户端就多一处会忘。 */
  _save();
  syncNow("assign");
  return task;
}

function deleteTask(taskId) {
  const before = (DB.tasks || []).length;
  DB.tasks = (DB.tasks || []).filter(item => String(item.id) !== String(taskId));
  if (DB.tasks.length === before) return false;
  queueChange("tasks", "delete", taskId, {});
  _save();
  syncNow("task-delete");
  return true;
}

/* 本机生成 uuid。优先用 crypto.randomUUID（安卓 WebView 支持），
   没有就退回手写版本——不能因为缺一个 API 就崩掉。 */
function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, ch => {
    const rand = Math.random() * 16 | 0;
    const value = ch === "x" ? rand : ((rand & 0x3) | 0x8);
    return value.toString(16);
  });
}

/* ---------------------------------------------------------- 汇总 */
/* 本地自己记的 + 员工报上来的 = 全部工时。

   **委托给 worklogsFor({includeRemote: true})**，不在这里自己拼一遍。
   两处各写一套的话，将来改字段名或来源标记时很容易漏掉一处，
   表现就是"同一个数字在两个页面显示得不一样"。 */
function allWorklogs() {
  return worklogsFor({ includeRemote: true });
}

/* =============================================================
   老板自助注册
   ============================================================= */

/* 创建一个老板账号。

   ## 每个老板都能建，各自独立

   之前是"只能有一个老板，先到先得"——那个设计是错的：
   你要的是**每个老板都能自己建账号，互相看不到对方的人和数据**。

   数据隔离靠的是 RLS：tasks / task_logs / worklogs 全都按
   `boss_id = auth.uid()` 判断，所以两个老板天然互不可见。
   每个老板建的员工，boss_id 都指向他自己。

   ## 重名怎么办

   两个老板可能都想用同一个手机号当登录名。这时**不拒绝**，
   而是在后面加个数字（`19155025818-2`），并把**最终的名字返回**，
   让界面告诉用户"你的登录名是这个"。

   这一点很重要：如果只是静默改名，用户下次登录会发现自己
   记的名字登不上。 */
async function registerBoss(data) {
  const name = String(data.name || "").trim();
  const code = String(data.phone || "").trim();
  if (!name) throw new Error("请填姓名（或者一个称呼）");
  if (!code) throw new Error("请填手机号");
  if (!/^[a-zA-Z0-9._-]{3,20}$/.test(code)) {
    throw new Error("手机号只能用字母数字和 . _ -，长度 3~20 位");
  }
  if (String(data.password || "").length < 6) {
    throw new Error("密码至少要 6 位");
  }
  if (!initCloud()) throw new Error("云组件没加载上，检查一下网络");

  const result = await cloudClient.rpc("create_boss_account", {
    p_code: code,
    p_password: String(data.password),
    p_name: name,
  });
  if (result.error) throw new Error(translateBossError(result.error.message));

  const payload = result.data || {};
  const actualCode = payload.code || code;

  /* 用**服务端返回的最终名字**登录，不是用户填的那个 */
  const profile = await cloudLogin(actualCode, data.password, false);

  return {
    profile: profile,
    code: actualCode,
    renamed: !!payload.renamed,
  };
}

/* 注册相关的英文报错 → 中文说明 */
function translateBossError(message) {
  const text = String(message || "");
  if (/code may only contain/i.test(text)) {
    return "手机号只能用字母、数字和 . _ -，长度 3~20 位";
  }
  if (/password must be at least/i.test(text)) {
    return "密码至少要 6 位";
  }
  if (/too many accounts/i.test(text)) {
    return "这个手机号被太多次用过了，换一个吧";
  }
  if (/Could not find the function|does not exist/i.test(text)) {
    return "云端的注册功能还没装。\n\n"
      + "去 Supabase 的 SQL Editor 跑一遍 sql/migrate-notify.sql";
  }
  return text;
}
