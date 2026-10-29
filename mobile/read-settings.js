/* =============================================================
   读 App 里所有 getui / notify / auth 相关的持久化设置。

   用途：App 的 JS 日志有时抓不到（logcat 缓冲区小、进程复用时
   看不到启动期的日志）。而这些关键状态都落在 localStorage 里，
   直接读反而更可靠。

   注意：leveldb 的键是 UTF-8、值常常是 UTF-16LE，所以按字节
   去掉 0 再按 latin1 解 —— 中文会花，但 ASCII 的键名和值
   （cid、true/false、错误码）都能读准。

   用法：
     node read-settings.js
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";
const DIR = "/data/data/" + PKG
  + "/app_webview/Default/Local Storage/leveldb";

/* 路径里有空格，**必须加引号**。
   直接传 ["shell","run-as","pkg","ls","/path with space"] 会被
   adb 当成多个参数，报 "No such file or directory"（踩过）。 */
function shQuote(args) {
  return execFileSync(ADB, ["shell"].concat(args), {
    encoding: "buffer", maxBuffer: 256 * 1024 * 1024,
  });
}

const listing = shQuote(["run-as " + PKG + " ls '" + DIR + "'"]).toString();
const names = listing.split("\n").map(s => s.trim())
  .filter(s => /\.(ldb|log)$/.test(s));

let text = "";
names.forEach(name => {
  try {
    const buf = shQuote(["run-as " + PKG + " cat '" + DIR + "/" + name + "'"]);
    text += Buffer.from([...buf].filter(b => b !== 0)).toString("latin1") + "\n";
  } catch (e) { /* 轮转中，跳过 */ }
});

console.log("读取 " + text.length + " 字符，文件 " + names.length + " 个");
console.log("");

/* 关心这些键 */
const KEYS = [
  "getui_push_consent",
  "getui_push_registered",
  "getui_push_last_error",
  "notifyPermission",
  "getui_push",
  "notifyPrefs",
  "realtimeState",
];

console.log("=== 设置项 ===");
KEYS.forEach(key => {
  const i = text.indexOf(key);
  if (i === -1) {
    console.log("  " + key.padEnd(24) + "（不存在）");
    return;
  }
  /* 键后面紧跟值，取一小段。值可能是 true/false、授权状态或错误文本。 */
  const slice = text.slice(i, i + 220);
  console.log("  " + key.padEnd(24) + "存在");
  console.log("        " + JSON.stringify(slice.slice(0, 160)));
});

console.log("");
console.log("=== 登录会话 ===");
console.log("  pr_auth_v1  " + (text.indexOf("pr_auth_v1") !== -1 ? "在" : "不在"));
console.log("  pr_profile  " + (text.indexOf("pr_profile") !== -1 ? "在" : "不在"));

console.log("");
console.log("=== 解读 ===");
if (text.indexOf("getui_push_registered") !== -1) {
  console.log("  · 设备已登记 ✓");
} else if (text.indexOf("getui_push_last_error") !== -1) {
  console.log("  · **登记失败过**，原因见上面的 getui_push_last_error");
} else {
  console.log("  · 既没登记成功、也没记录失败 → ");
  console.log("    ensureGetuiPushConsent() **根本没跑到 record()**");
  console.log("    可能是：函数没被调用 / 在 record 之前就返回了");
}
