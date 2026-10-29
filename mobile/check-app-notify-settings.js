/* =============================================================
   查这个 App 的通知总设置，看是不是被系统/用户压低了。

   为什么查：通知记录的 importance 是 2（LOW），而
   `mImportanceExplanation=user` `mIsAppImportanceLocked=true`
   说明**是用户层面的设置把 App 通知压低了**——
   Android 会把新建渠道的级别一起压下去，App 自己改不了。

   这种情况只能去手机设置里改。先读出准确的现状，
   好告诉用户具体点哪一项。

   用法：
     node check-app-notify-settings.js
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";

const text = execFileSync(ADB,
  ["shell", "dumpsys", "notification", "--noredact"],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
const lines = text.split("\n");

console.log("=".repeat(64));
console.log("App 通知总设置");
console.log("=".repeat(64));
console.log("");

/* AppSettings 那一行有 App 级别的开关 */
const appLines = lines.filter(l =>
  l.indexOf("AppSettings: " + PKG) !== -1
  || (l.indexOf(PKG) !== -1 && /importance=|banned=|locked=/i.test(l)
      && l.indexOf("NotificationChannel") === -1));

console.log("[1] App 级别设置");
if (appLines.length) {
  appLines.slice(0, 3).forEach(l => {
    const t = l.trim();
    console.log("  " + t.slice(0, 240));
  });
} else {
  console.log("  （没找到）");
}

console.log("");
console.log("[2] 关键字段逐项解读");
const joined = appLines.join(" ");
const pick = (re, label) => {
  const m = re.exec(joined);
  if (!m) return;
  console.log("  " + label.padEnd(22) + m[1]);
};
pick(/importance=(\w+)/, "App 通知级别");
pick(/banned=(\w+)/, "被屏蔽");
pick(/locked=(\w+)/, "级别被锁");
pick(/userSet=(\w+)/, "用户手动设过");
pick(/priority=(\w+)/, "优先级");
pick(/visibility=(-?\d+)/, "锁屏可见性");

console.log("");
console.log("[3] 渠道级别（和 App 级别对照）");
const chans = {};
lines.forEach(l => {
  const m = /NotificationChannel\{mId='([^']+)'[^}]*?mImportance=(\d+)/.exec(l);
  if (m && /^(pr-|task_|upush)/.test(m[1])) chans[m[1]] = Number(m[2]);
});
Object.keys(chans).sort().forEach(id => {
  console.log("  " + id.padEnd(18) + " 级别 " + chans[id]
    + (chans[id] >= 4 ? "  弹横幅 ✓" : ""));
});

console.log("");
console.log("=".repeat(64));
console.log("");
const appImportance = (/importance=(\w+)/.exec(joined) || [])[1];
if (appImportance && appImportance.toUpperCase() === "LOW") {
  console.log("**App 通知级别是 LOW** —— 所有新渠道都会被压到级别 2，");
  console.log("正好解释为什么 pr-task-v2 / v3 / task_messages 都是 2。");
  console.log("");
  console.log("修法（只能在手机上操作）：");
  console.log("  设置 → 通知与状态栏 → 应用通知管理 → 项目记录器");
  console.log("  → 把「允许通知」相关选项调到「重要」/ 打开横幅");
} else {
  console.log("App 通知级别: " + (appImportance || "读不出"));
  console.log("如果不是 LOW，那压制的来源要看上面的 locked/userSet 两项。");
}
