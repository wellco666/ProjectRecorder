/* =============================================================
   查刚收到的那条推送走的哪个渠道、会不会弹横幅。

   ## 为什么要专门查这个

   推送能收到**不等于**会弹横幅：
     · 落到级别 3 的渠道 → 只进通知栏，不弹
     · 落到级别 4 的渠道 → 弹横幅

   而"落到哪个渠道"取决于推送负载里的 channel_id 和
   客户端有没有把那个渠道建出来。名字对不上就静默退化。

   用法：
     node check-delivered-channel.js
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
console.log("推送落地渠道检查");
console.log("=".repeat(64));
console.log("");

/* 1. 找 App 的通知记录，读它的渠道 */
console.log("[1] App 当前的通知记录");
const records = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/NotificationRecord\(/.test(lines[i])) continue;
  if (lines[i].indexOf(PKG) === -1) continue;
  /* 往后扫一段，抓渠道和标题 */
  let channel = null;
  let title = null;
  let group = null;
  for (let j = i; j < Math.min(i + 45, lines.length); j += 1) {
    const t = lines[j];
    if (j > i && /NotificationRecord\(/.test(t)) break;
    const cm = /(?:mChannelId|channelId)=([^\s,}]+)/.exec(t);
    if (cm && !channel) channel = cm[1];
    const tm = /android\.title=String \((.*)\)/.exec(t);
    if (tm && !title) title = tm[1];
    const gm = /(?:mGroupKey|groupKey)=([^\s,}]+)/.exec(t);
    if (gm && !group) group = gm[1];
  }
  records.push({ channel, title, group });
}

records.forEach((r, i) => {
  console.log("  [" + (i + 1) + "] " + (r.title || "（无标题）"));
  console.log("      渠道: " + (r.channel || "（读不出）"));
});

if (!records.length) console.log("  （没有通知记录）");

/* 2. 列出相关渠道的真实级别 */
console.log("");
console.log("[2] 相关渠道的真实级别");
const wanted = ["pr-alerts-v1", "pr-task-v3", "pr-task-v2", "task_messages",
  "upush_default", "pr-keepalive"];
const levels = {};
lines.forEach(line => {
  const m = /NotificationChannel\{mId='([^']+)'[^}]*?mImportance=(\d+)/.exec(line);
  if (m && wanted.indexOf(m[1]) !== -1) levels[m[1]] = Number(m[2]);
});
Object.keys(levels).forEach(id => {
  const lv = levels[id];
  console.log("  " + id.padEnd(18) + " 级别 " + lv + "   "
    + (lv >= 4 ? "弹横幅 ✓" : "不弹横幅"));
});

/* 3. 结论 */
console.log("");
console.log("=".repeat(64));
const latest = records.find(r => r.title && r.title.indexOf("任务") !== -1)
  || records[0];
if (latest && latest.channel && levels[latest.channel] !== undefined) {
  const lv = levels[latest.channel];
  console.log("");
  console.log("最新推送走的是 " + latest.channel + "，级别 " + lv);
  if (lv >= 4) {
    console.log("**会弹横幅** —— 这正是我们要的结果 ✓");
  } else {
    console.log("**不弹横幅**。要把推送渠道换成级别 4 的那个。");
  }
} else if (latest) {
  console.log("");
  console.log("最新通知渠道读不出来（试试看日志），标题是：" + latest.title);
}
