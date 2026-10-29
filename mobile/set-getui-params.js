/* =============================================================
   把个推参数写进本机 gradle.properties

   用法：
     node set-getui-params.js <AppID> <AppKey>

   ## 为什么单独写这个脚本

   setup-push-params.ps1 是交互式的（一个个问），
   适合你自己坐着填。

   但如果你已经把值给了我，我这边用这个脚本一次性写好——
   不用你再来回按回车。

   ## 安全

   只写 AppID 和 AppKey（都是要打进 apk 的公开标识）。
   **MasterSecret 不在参数里，也不会被这个脚本碰。**
   写完只打印长度，不打印值。
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const appId = (process.argv[2] || "").trim();
const appKey = (process.argv[3] || "").trim();

if (!appId || !appKey) {
  console.log("用法: node set-getui-params.js <AppID> <AppKey>");
  process.exit(1);
}

const gradleDir = path.join(os.homedir(), ".gradle");
const propsFile = path.join(gradleDir, "gradle.properties");

/* 读现有的，保留别的键 */
let lines = [];
const existing = {};
if (fs.existsSync(propsFile)) {
  lines = fs.readFileSync(propsFile, "utf8").split(/\r?\n/);
  lines.forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.indexOf("=") === -1) return;
    existing[t.slice(0, t.indexOf("=")).trim()] = true;
  });
  console.log("读到现有配置 " + Object.keys(existing).length + " 项");
}

/* 去掉旧的这两个键（要替换） */
const drop = ["GETUI_APPID", "GETUI_APPKEY"];
lines = lines.filter(line => {
  const t = line.trim();
  if (!t || t.startsWith("#") || t.indexOf("=") === -1) return true;
  const key = t.slice(0, t.indexOf("=")).trim();
  return drop.indexOf(key) === -1;
});

/* 收尾：去掉尾部空行，再加一段 */
while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
lines.push("");
lines.push("# --- Getui push (written by set-getui-params.js) ---");
lines.push("GETUI_APPID=" + appId);
lines.push("GETUI_APPKEY=" + appKey);

if (!fs.existsSync(gradleDir)) {
  fs.mkdirSync(gradleDir, { recursive: true });
}
fs.writeFileSync(propsFile, lines.join("\n") + "\n", "utf8");

console.log("");
console.log("=== 已写入 ===");
console.log("  " + propsFile);
console.log("");
console.log("  GETUI_APPID   " + appId.length + " 字符");
console.log("  GETUI_APPKEY  " + appKey.length + " 字符");
console.log("");
console.log("（只显示长度，不打印值）");
console.log("");

/* 顺手检查有没有误放 MasterSecret —— 那个绝不能出现在本机文件里 */
const content = fs.readFileSync(propsFile, "utf8");
const leaked = ["MASTERSECRET", "MASTER_SECRET", "GETUI_MASTERSECRET"]
  .filter(k => content.toUpperCase().indexOf(k) !== -1);
if (leaked.length) {
  console.log("**警告**：文件里出现了 " + leaked.join("、"));
  console.log("MasterSecret 打进 apk 等于公开，必须删掉，只放 Supabase。");
} else {
  console.log("安全检查：本机文件里没有 MasterSecret ✓");
}
