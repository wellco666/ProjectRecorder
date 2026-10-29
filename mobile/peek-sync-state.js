/* 读手机上的同步状态：lastSync / syncCursor / 本地任务条数。

   任务已经在库里、RLS 也允许，但界面没显示 —— 先确认
   "同步到底跑没跑、游标推到哪了"。

   用法：
     node peek-sync-state.js
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";
const DIR = "/data/data/" + PKG
  + "/app_webview/Default/Local Storage/leveldb";

function sh(args) {
  return execFileSync(ADB, ["shell"].concat(args), {
    encoding: "buffer", maxBuffer: 256 * 1024 * 1024,
  });
}

const listing = sh(["run-as " + PKG + " ls '" + DIR + "'"]).toString();
const names = listing.split("\n").map(s => s.trim())
  .filter(s => /\.(ldb|log)$/.test(s));

let text = "";
names.forEach(name => {
  try {
    const buf = sh(["run-as " + PKG + " cat '" + DIR + "/" + name + "'"]);
    text += Buffer.from([...buf].filter(b => b !== 0)).toString("latin1") + "\n";
  } catch (e) { /* 跳过 */ }
});

console.log("读取 " + text.length + " 字符");
console.log("");

/* lastSync */
const lsAt = text.indexOf('"lastSync"');
if (lsAt === -1) {
  console.log("lastSync：没找到");
} else {
  const slice = text.slice(lsAt, lsAt + 200);
  const at = /"at":"([^"]*)"/.exec(slice);
  const ok = /"ok":(true|false)/.exec(slice);
  const pending = /"pending":(\d+)/.exec(slice);
  console.log("lastSync.at      = " + (at ? at[1] : "?"));
  console.log("lastSync.ok      = " + (ok ? ok[1] : "?"));
  console.log("lastSync.pending = " + (pending ? pending[1] : "?"));
}

/* syncCursor */
const curAt = text.indexOf('"syncCursor"');
if (curAt === -1) {
  console.log("syncCursor：没找到");
} else {
  console.log("");
  console.log("syncCursor 片段：");
  console.log("  " + JSON.stringify(text.slice(curAt, curAt + 260)));
}

/* 本地任务条数：数 "plan_date" 出现次数，粗估 */
const planCount = (text.match(/"plan_date"/g) || []).length;
console.log("");
console.log("本地出现 plan_date 的次数（约等于任务条数）: " + planCount);
console.log("测试任务标题在不在本地: "
  + (text.indexOf("真机UI测试任务") !== -1 ? "在 ✓" : "不在 ✗"));

/* 拉取诊断：这两个字段是排查"同步成功但数据不来"的关键 */
console.log("");
console.log("=== 拉取诊断 ===");
["pullDebug", "pullError"].forEach(key => {
  const i = text.indexOf(key);
  if (i === -1) {
    console.log("  " + key + "：（不存在）");
    return;
  }
  console.log("  " + key + "：" + JSON.stringify(text.slice(i, i + 200)));
});

/* 保存的登录账号（"点一下就登录"那个功能）。
   **只打印结构，不打印密码** —— 这个是拿来排查的，不该把密码印到终端。 */
console.log("");
console.log("=== 保存的账号 ===");
const savedAt = text.indexOf('"savedAccounts"');
if (savedAt === -1) {
  console.log("  savedAccounts：（本地没有这个字段）");
} else {
  const slice = text.slice(savedAt, savedAt + 900);
  const codes = slice.match(/"code":"([^"]*)"/g) || [];
  const roles = slice.match(/"role":"([^"]*)"/g) || [];
  const names = slice.match(/"name":"([^"]*)"/g) || [];
  const hasPassword = /"password":"[^"]+"/.test(slice);
  console.log("  条数: " + codes.length);
  codes.forEach((c, i) => {
    console.log("    " + (names[i] || "?").replace(/"name":"|"/g, "")
      + "  " + (roles[i] || "?").replace(/"role":"|"/g, "")
      + "  " + c.replace(/"code":"|"/g, ""));
  });
  console.log("  有没有存密码: " + (hasPassword ? "有（正常，点一下要用的）" : "没有"));
}

