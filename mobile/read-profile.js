/* 从手机上读出当前登录的 profile（id / 工号 / 姓名 / 身份）。

   为什么要这一步：服务端 push_devices 里那条记录的 profile_id 是
   `fd097678-...`，而我一直往旧账号 `54dcec9d-...` 发测试推送，
   所以"推送发出去了但手机没反应"。

   用途：拿到准确的 profile.id，才能对着正确的用户测推送。

   用法：
     node read-profile.js
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";
const DIR = "/data/data/" + PKG
  + "/app_webview/Default/Local Storage/leveldb";

/* 路径里有空格，必须整体加引号传给 adb shell。 */
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
  } catch (e) { /* 跳过轮转中的文件 */ }
});

console.log("读取 " + text.length + " 字符");
console.log("");

/* 所有 uuid —— 里面会有一个是当前 profile.id */
const uuids = [...new Set(
  text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)
  || [])];
console.log("=== 出现过的 uuid（" + uuids.length + " 个）===");
uuids.slice(0, 10).forEach(u => console.log("  " + u));

console.log("");
console.log("=== profile 片段 ===");
/* profile 是个 JSON 对象，取出现位置后面一段 */
const at = text.indexOf("profile");
if (at === -1) {
  console.log("  没找到 profile");
} else {
  /* 找 "id":"<uuid>" 这种形状 */
  const slice = text.slice(Math.max(0, at - 40), at + 420);
  console.log("  " + JSON.stringify(slice.slice(0, 380)));
}

console.log("");
console.log("=== 关键值 ===");
const idMatch = /"id":"([0-9a-f-]{36})"/.exec(text);
if (idMatch) console.log("  最可能 profile.id = " + idMatch[1]);
const codeMatch = /"code":"([^"]{1,20})"/.exec(text);
if (codeMatch) console.log("  工号/登录名        = " + codeMatch[1]);
const roleMatch = /"role":"(boss|employee)"/.exec(text);
if (roleMatch) console.log("  身份               = " + roleMatch[1]);
