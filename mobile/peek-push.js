/* =============================================================
   查手机上"个推推送"的实际状态。

   直接读 App 的 localStorage，看三个关键值：
     getui_push_consent       用户同意了吗
     getui_push_registered    CID 上报到服务端成功了吗
     通知偏好                 系统通知开着吗

   用法：
     node peek-push.js
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

/* 这三个值是普通 ASCII，不受 leveldb 混合编码影响，能直接搜 */
const checks = [
  ["getui_push_consent", "用户是否同意了个推推送"],
  ["getui_push_registered", "CID 是否已上报到服务端"],
  ["getui_push", "个推相关设置"],
];

console.log("=== 个推状态 ===");
checks.forEach(([key, label]) => {
  const i = text.indexOf(key);
  if (i === -1) {
    console.log("  " + label + "：" + key + " 没找到");
    return;
  }
  /* 值紧跟在键后面，取一小段看 */
  const slice = text.slice(i, i + 80);
  const m = /(granted|denied|unset|true|false)/.exec(slice);
  console.log("  " + label);
  console.log("    " + key + " = " + (m ? m[1] : "（读不出值）"));
});

console.log("");
console.log("=== 通知偏好 ===");
const prefsAt = text.indexOf("notifyPrefs");
if (prefsAt === -1) {
  console.log("  没找到 notifyPrefs");
} else {
  const slice = text.slice(prefsAt, prefsAt + 300);
  ["enabled", "system", "inApp"].forEach(k => {
    const m = new RegExp('"' + k + '":(true|false)').exec(slice);
    console.log("  " + k + " = " + (m ? m[1] : "?"));
  });
}

console.log("");
console.log("=== 登录会话 ===");
console.log("  pr_auth_v1 " + (text.indexOf("pr_auth_v1") !== -1 ? "在 ✓" : "不在 ✗"));

console.log("");
console.log("=== 解读 ===");
if (text.indexOf("getui_push_consent") === -1) {
  console.log("  · 从没走到过同意流程 —— 说明 ensureGetuiPushConsent() 没被执行");
  console.log("    检查：app.js 启动时有没有调它 / 插件名对不对");
} else if (/getui_push_consent[\s\S]{0,40}granted/.test(text)) {
  console.log("  · 用户已同意 ✓");
  if (/getui_push_registered[\s\S]{0,40}true/.test(text)) {
    console.log("  · CID 已成功写进 push_devices ✓");
  } else {
    console.log("  · **同意过了但 CID 没上报成功**");
    console.log("    可能：push_devices 表不存在 / 网络 / RLS");
  }
} else {
  console.log("  · 用户点了「不同意」，或状态是 unset");
}
