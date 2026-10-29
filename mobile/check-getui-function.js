/* =============================================================
   部署前检查个推云函数。

   部署一次要等、还可能因为小错失败，所以先在本地把它看一遍：
     · 有没有 Deno.serve 入口
     · 有没有校验 Webhook 密钥（不校验的话谁都能调你的推送）
     · 读了哪几个环境变量（部署时要一个个 set，漏一个就跑不起来）
     · 有没有把密钥硬编码进去（那就不该进仓库）

   用法：
     node check-getui-function.js
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "supabase", "functions",
  "getui-task-event", "index.ts");

if (!fs.existsSync(file)) {
  console.log("  ✗ 找不到云函数：" + file);
  process.exit(1);
}

const src = fs.readFileSync(file, "utf8");
let problems = 0;
const ok = (label, detail) => {
  console.log("  [OK]   " + label + (detail ? "  " + detail : ""));
};
const bad = (label, detail) => {
  problems += 1;
  console.log("  [问题] " + label + (detail ? "  " + detail : ""));
};

console.log("=".repeat(62));
console.log("个推云函数：部署前检查");
console.log("=".repeat(62));
console.log("");
console.log("  文件: supabase/functions/getui-task-event/index.ts");
console.log("  行数: " + src.split("\n").length);
console.log("");

/* 入口 */
if (src.indexOf("Deno.serve") !== -1) ok("有 Deno.serve 入口");
else bad("没有 Deno.serve —— 这不是一个 Edge Function");

/* Webhook 密钥校验 */
if (src.indexOf("TASK_EVENT_WEBHOOK_SECRET") !== -1) {
  ok("会校验 Webhook 密钥");
} else {
  bad("没校验 Webhook 密钥 —— 任何人都能调用它给别人发推送");
}

/* 环境变量 */
const envs = [...new Set(
  [...src.matchAll(/Deno\.env\.get\("([A-Z_]+)"\)/g)].map(m => m[1]))];
if (envs.length) {
  ok("读取的环境变量 " + envs.length + " 个", envs.join(", "));
  console.log("");
  console.log("  部署前要逐个设置（值自己填，别发出来）：");
  envs.forEach(name => {
    if (name === "SUPABASE_URL" || name === "SUPABASE_SERVICE_ROLE_KEY") {
      console.log("    " + name + "   ← Supabase 自动注入，不用设");
    } else {
      console.log("    " + name);
    }
  });
} else {
  bad("一个环境变量都没读 —— 密钥可能被硬编码了");
}

/* 有没有把密钥写死在代码里 */
const inlineSecrets = [];
if (/[A-Za-z0-9_-]{32,}/.test(src.replace(/\/\*[\s\S]*?\*\//g, ""))) {
  /* 长串可能是密钥，也可能是注释里的示例——去掉注释再看一次 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const m = code.match(/["'][A-Za-z0-9_-]{32,}["']/g);
  if (m) inlineSecrets.push(...m.map(s => s.slice(0, 12) + "…"));
}
if (inlineSecrets.length) {
  bad("代码里疑似硬编码了长串（可能是密钥）", inlineSecrets.join(", "));
} else {
  ok("代码里没有硬编码密钥");
}

/* 个推接口 */
if (/restapi\.getui\.com|getui/.test(src) && /oauth2|token/.test(src)) {
  ok("会先取 access_token 再调个推 REST 接口");
} else {
  console.log("  [--]   没看到个推 REST 调用（可能用了别的写法，人工确认一下）");
}

/* 收尾 */
console.log("");
console.log("=".repeat(62));
if (problems) {
  console.log("发现 " + problems + " 个问题，**先修再部署**");
  process.exit(1);
}
console.log("检查通过，可以部署。");
console.log("");
console.log("  cd " + __dirname);
console.log("  supabase functions deploy getui-task-event");
