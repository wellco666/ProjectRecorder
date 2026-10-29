/* =============================================================
   从 apk 里确认通知插件真的打进去了。

   为什么要查这个：我在 AndroidManifest 里加了权限、在
   capacitor.build.gradle 里看到了插件依赖，但**"依赖声明了"
   不等于"类真的进了包"**。装到手机上才发现插件不生效的话，
   现象是"开了系统通知但收不到"，很难查。

   用 node 的 zlib 手动解 zip。不依赖 Expand-Archive——
   PowerShell 5.1 那个对 apk 后缀和某些文件名会失败。
   ============================================================= */
"use strict";
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const APK = "android/app/build/outputs/apk/debug/app-debug.apk";

/* 读 zip 的中央目录，拿到每个条目的名字和本地头偏移 */
function listEntries(buffer) {
  /* 从尾部找 End of Central Directory 签名 0x06054b50 */
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 70000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("不是合法的 zip（找不到中央目录）");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/* 取出一个条目的内容（必要时解压） */
function readEntry(buffer, entry) {
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;              // 没压缩
  if (entry.method === 8) return zlib.inflateRawSync(raw);  // deflate
  return null;
}

const buffer = fs.readFileSync(APK);
const entries = listEntries(buffer);
console.log("apk 条目数 :", entries.length);

/* 1. 有没有 dex，dex 里有没有插件的类 */
const dexes = entries.filter(e => e.name.endsWith(".dex"));
console.log("dex 文件   :", dexes.map(e => e.name).join(", "));

const wanted = [
  /* **包名要用真实的。**
     我一开始猜成 "capacitor/localnotifications"，
     于是报告"没找到"——而其实它在
     com.capacitorjs.plugins.localnotifications。
     猜包名会让这个检查给出假的失败。 */
  "com/capacitorjs/plugins/localnotifications",
  "LocalNotificationsPlugin",       // 插件主类
  "com/getcapacitor",               // Capacitor 框架
];
const hits = {};
wanted.forEach(w => { hits[w] = []; });

dexes.forEach(entry => {
  const data = readEntry(buffer, entry);
  if (!data) return;
  const text = data.toString("latin1");
  wanted.forEach(w => {
    if (text.indexOf(w) !== -1) hits[w].push(entry.name);
  });
});

console.log("");
console.log("--- dex 里找到的类 ---");
let missing = 0;
wanted.forEach(w => {
  const ok = hits[w].length > 0;
  if (!ok) missing += 1;
  console.log("  " + (ok ? "有 " : "没有 ") + w
    + (ok ? "  (" + hits[w].join(",") + ")" : ""));
});

/* 2. 权限有没有合并进二进制清单 */
const manifestEntry = entries.find(e => e.name === "AndroidManifest.xml");
if (manifestEntry) {
  const data = readEntry(buffer, manifestEntry);
  /* 二进制清单里的字符串是 UTF-16，但权限名通常是 ASCII 字面量 */
  const utf16 = data.toString("utf16le");
  const latin = data.toString("latin1");
  const has = s => utf16.indexOf(s) !== -1 || latin.indexOf(s) !== -1;
  console.log("");
  console.log("--- 合并后的权限 ---");
  ["POST_NOTIFICATIONS", "VIBRATE", "INTERNET"].forEach(p => {
    console.log("  " + (has(p) ? "有 " : "没有 ") + p);
  });
}

/* 3. 插件清单文件 */
const pluginJson = entries.find(e =>
  e.name.indexOf("capacitor.plugins.json") !== -1);
if (pluginJson) {
  console.log("");
  console.log("--- capacitor.plugins.json ---");
  console.log(readEntry(buffer, pluginJson).toString("utf8").slice(0, 400));
}

console.log("");
console.log(missing === 0
  ? "结论：通知插件已经打进 apk"
  : "结论：有 " + missing + " 项没找到 —— 系统通知可能不生效");

process.exitCode = missing ? 1 : 0;
