/* 查那条测试任务到底有没有进本机。

   用 **UUID** 搜而不是标题：
   leveldb 的值是 UTF-16LE，我这套「去零字节 + latin1」的读法
   会把中文弄成乱码，搜中文永远搜不到（踩过一次，误判成"没同步"）。
   UUID 是纯 ASCII，两种编码下都能搜到，是可靠的判据。

   用法：
     node peek-task-local.js <任务uuid>
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";
const DIR = "/data/data/" + PKG
  + "/app_webview/Default/Local Storage/leveldb";

const taskId = process.argv[2];
if (!taskId) {
  console.log("用法: node peek-task-local.js <任务uuid>");
  process.exit(1);
}

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

console.log("读取 " + text.length + " 字符，文件 " + names.length + " 个");
console.log("");

const found = text.indexOf(taskId) !== -1;
console.log("任务 UUID " + taskId);
console.log("  在本机数据里: " + (found ? "在 ✓" : "不在 ✗"));

if (found) {
  const at = text.indexOf(taskId);
  console.log("  附近内容:");
  console.log("    " + JSON.stringify(text.slice(Math.max(0, at - 60), at + 220)));
}

/* 顺便看看本地一共有多少条任务：
   数 "accept_status" 出现次数 —— ASCII，可靠。 */
const accepts = (text.match(/accept_status/g) || []).length;
console.log("");
console.log("本地 accept_status 出现次数: " + accepts);

/* 再数一下所有 uuid 里有没有那条 */
const uuids = [...new Set(
  text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)
  || [])];
console.log("本地出现的 uuid 共 " + uuids.length + " 个");
console.log("  目标在列表里: " + (uuids.indexOf(taskId) !== -1 ? "是" : "否"));
