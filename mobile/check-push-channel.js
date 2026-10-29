/* =============================================================
   查刚收到的那条推送用的是哪个通知渠道、能不能弹横幅。

   为什么单独查：云函数请求的渠道是 `task_messages`（级别 4）。
   如果这个渠道没被真正建出来，通知会进通知栏**但不弹横幅**——
   用户看到的现象是"有通知但没弹出来"，和"完全没收到"很难区分。

   用法：
     node check-push-channel.js
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";

function dumpsys() {
  return execFileSync(ADB, ["shell", "dumpsys", "notification", "--noredact"], {
    encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
  });
}

const text = dumpsys();
const lines = text.split("\n");

console.log("=".repeat(62));
console.log("推送通知渠道检查");
console.log("=".repeat(62));
console.log("");

/* 1. App 自己的渠道有哪些（在 mId='pr- / task_ / getui 里找） */
console.log("[1] App 自己的通知渠道");
const appChannels = [];
lines.forEach(line => {
  const m = /NotificationChannel\{mId='([^']+)'[^}]*?mImportance=(\d+)/.exec(line);
  if (!m) return;
  const id = m[1];
  if (/^(pr-|task_|getui|upush)/.test(id)) {
    appChannels.push({ id, importance: Number(m[2]) });
  }
});
if (appChannels.length) {
  appChannels.forEach(c => {
    const heads = c.importance >= 4 ? "会弹横幅 ✓" : "不弹横幅";
    console.log("  " + c.id.padEnd(20) + " 级别 " + c.importance + "   " + heads);
  });
} else {
  console.log("  （没找到）");
}

/* 2. 那条推送通知的记录 */
console.log("");
console.log("[2] 收到的推送通知");
const recs = [];
lines.forEach((line, i) => {
  if (!/NotificationRecord\(/.test(line)) return;
  if (line.indexOf(PKG) === -1) return;
  /* 往后找它的 channelId 和标题 */
  let channel = null;
  let title = null;
  for (let j = i; j < Math.min(i + 40, lines.length); j += 1) {
    const t = lines[j];
    const cm = /mChannelId='([^']+)'|channelId=([A-Za-z0-9_.-]+)/.exec(t);
    if (cm && !channel) channel = cm[1] || cm[2];
    const tm = /android\.title=String \((.+?)\)/.exec(t);
    if (tm && !title) title = tm[1];
    if (/NotificationRecord\(/.test(t) && j > i) break;
  }
  recs.push({ channel, title });
});

if (recs.length) {
  recs.forEach(r => {
    console.log("  标题: " + (r.title || "?"));
    console.log("  渠道: " + (r.channel || "（读不出，可能在别的字段）"));
    console.log("");
  });
} else {
  console.log("  （没找到 App 的通知记录）");
}

/* 3. 结论 */
console.log("=".repeat(62));
const hasTask = appChannels.some(c => c.id === "task_messages");
console.log("");
if (hasTask) {
  const c = appChannels.find(x => x.id === "task_messages");
  console.log("task_messages 渠道存在，级别 " + c.importance
    + (c.importance >= 4 ? "（会弹横幅）" : "（**不会弹横幅**，要提到 4）"));
} else {
  console.log("**task_messages 渠道不存在**");
  console.log("");
  console.log("云函数请求它（channel_level: 4），但它没被建出来。");
  console.log("后果：通知能进通知栏，但可能**不弹横幅**。");
  console.log("");
  console.log("修法：在 App 里主动建这个渠道（和 pr-alerts-v1 一样），");
  console.log("      这样级别一定是 4，不依赖推送 SDK 去建。");
}
