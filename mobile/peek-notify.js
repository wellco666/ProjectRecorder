/* =============================================================
   读手机上的通知记录和实时状态。

   这是**最诚实的验证**：不看我自己的测试脚本，只看真机上
   到底收到了什么。

   用法：
     node peek-notify.js
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";
const DIR = "/data/data/" + PKG
  + "/app_webview/Default/Local Storage/leveldb";

function sh(args) {
  return execFileSync(ADB, ["shell"].concat(args), {
    encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
  });
}

/* 每个文件去掉空字节后再解——同时兼容 utf8 的键和 utf16 的值。 */
function readAll() {
  const listing = sh(["run-as " + PKG + " ls '" + DIR + "'"]).toString();
  const names = listing.split("\n").map(s => s.trim())
    .filter(s => /\.(ldb|log)$/.test(s));
  let text = "";
  names.forEach(name => {
    try {
      const buf = sh(["run-as " + PKG + " cat '" + DIR + "/" + name + "'"]);
      text += Buffer.from([...buf].filter(b => b !== 0)).toString("latin1") + "\n";
    } catch (e) { /* 轮转中 */ }
  });
  return text;
}

const text = readAll();
console.log("读取 " + text.length + " 字符");
console.log("");

/* 通知记录。
 *
 * **不解析 JSON。**
 * 去掉空字节之后的文本里，UTF-16 的中文会留下奇怪字节，
 * 偶尔还夹进控制字符（\t），JSON.parse 直接失败。
 *
 * 只想知道"收到过哪些类型的通知"，用正则数一数就够了，
 * 而且不会因为一个坏字节就全盘读不出来。
 */
console.log("=== 通知记录 ===");
const kinds = { assigned: 0, done: 0, undone: 0, summary: 0, project: 0 };
[...text.matchAll(/"kind":"(assigned|done|undone|summary|project)"/g)]
  .forEach(m => { kinds[m[1]] = (kinds[m[1]] || 0) + 1; });
const totalKinds = Object.values(kinds).reduce((a, b) => a + b, 0);
console.log("  按类型统计（可能出现重复计数，只作参考）：");
Object.keys(kinds).forEach(k => {
  if (kinds[k]) console.log("    " + k + ": " + kinds[k]);
});
console.log("  合计: " + totalKinds);
console.log("");

/* 明确的证据：有没有 assigned / done 这类事件被写进通知 */
["assigned", "done", "undone"].forEach(kind => {
  const hit = text.indexOf('"kind":"' + kind + '"');
  console.log("  " + (hit !== -1 ? "✓" : "✗") + " 出现过 " + kind);
});

/* 通知的键前缀能区分"来自事件"和"自己造的" */
const evKeys = (text.match(/"key":"ev:/g) || []).length;
const pushKeys = (text.match(/"key":"push:/g) || []).length;
console.log("");
console.log("  来自服务端事件的（key: ev:）  : " + evKeys);
console.log("  来自推送消息的（key: push:）  : " + pushKeys);

/* 队列 */
console.log("");
console.log("=== 待上传队列 ===");
const qAt = text.indexOf("\"syncQueue\"");
if (qAt === -1) console.log("  没找到");
else {
  const slice = text.slice(qAt, qAt + 400);
  const empty = /"syncQueue":\[\]/.test(slice);
  console.log("  " + (empty ? "空（都传上去了）" : slice.slice(0, 200)));
}

/* 同步状态 */
console.log("");
console.log("=== 同步状态 ===");
const ls = text.indexOf("\"lastSync\"");
if (ls !== -1) {
  const slice = text.slice(ls, ls + 400);
  const at2 = /"at":"([^"]*)"/.exec(slice);
  const ok = /"ok":(true|false)/.exec(slice);
  const msg = /"message":"([^"]*)"/.exec(slice);
  console.log("  最后同步: " + (at2 ? at2[1] : "-"));
  console.log("  成功    : " + (ok ? ok[1] : "-"));
  if (msg) console.log("  信息    : " + msg[1].slice(0, 100));
}

/* 实时状态 */
const rs = /"realtimeState":"([^"]*)"/.exec(text);
console.log("");
console.log("=== 实时推送 ===");
console.log("  状态: " + (rs ? rs[1] : "（没记录，可能没存盘）"));

/* 登录会话 */
console.log("");
console.log("=== 登录会话 ===");
console.log("  pr_auth_v1 在不在: "
  + (text.indexOf("pr_auth_v1") !== -1 ? "在 ✓" : "不在 ✗"));
