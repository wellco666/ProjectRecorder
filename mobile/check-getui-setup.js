/* =============================================================
   个推推送：配置状态检查

   一条命令看清"还差什么"，不用翻文档、不用回忆。

   用法：
     node check-getui-setup.js

   ## 它检查什么

     1. 本机 gradle.properties 里个推/厂商参数填了没有
     2. 打包能不能带上这些参数（build.gradle 的占位符）
     3. SQL / 云函数 / 客户端代码在不在
     4. Supabase 那边部署了没有（能查的查，查不到的列成待办）

   **只报"设了/没设"和值的长度，不打印任何密钥内容。**
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HERE = __dirname;
let todo = [];
let okCount = 0;

function ok(label, detail) {
  okCount += 1;
  console.log("  [OK]   " + label + (detail ? "  " + detail : ""));
}
function missing(label, detail) {
  todo.push(label);
  console.log("  [待办] " + label);
  if (detail) console.log("         " + detail);
}
function info(label) {
  console.log("  [--]   " + label);
}

console.log("=".repeat(64));
console.log("个推推送：配置状态");
console.log("=".repeat(64));

/* ---------- 1. 本机参数 ---------- */
console.log("\n[1] 本机参数（gradle.properties；只检查状态，不显示参数值）");
const propsFile = path.join(os.homedir(), ".gradle", "gradle.properties");
const props = {};
if (!fs.existsSync(propsFile)) {
  missing("gradle.properties 不存在",
    "跑一次：powershell -File setup-push-params.ps1");
} else {
  fs.readFileSync(propsFile, "utf8").split("\n").forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const i = t.indexOf("=");
    if (i === -1) return;
    props[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });

  /* 当前目标是单 APK 覆盖已集成的主流国内厂商离线通道。
     缺少 OEM 参数不能误报成"全部就绪"；实际值绝不打印。 */
  const groups = [
    { title: "个推服务端（必需）", keys: ["GETUI_APPID", "GETUI_APPKEY"], required: true },
    { title: "vivo 离线通道", keys: ["VIVO_APP_ID", "VIVO_APP_KEY"], required: true },
    { title: "小米离线通道", keys: ["XIAOMI_APP_ID", "XIAOMI_APP_KEY"], required: true },
    { title: "OPPO 离线通道", keys: ["OPPO_APP_KEY", "OPPO_APP_SECRET"], required: true },
    { title: "华为离线通道", keys: ["HUAWEI_APP_ID"], required: true },
    { title: "荣耀离线通道", keys: ["HONOR_APP_ID"], required: true },
    { title: "魅族离线通道", keys: ["MEIZU_APP_ID", "MEIZU_APP_KEY"], required: true },
  ];

  groups.forEach(group => {
    const set = group.keys.filter(k => props[k]);
    const label = group.title;
    if (set.length === group.keys.length) {
      ok(label, set.map(k => k + "(" + props[k].length + "字符)").join(" "));
    } else if (set.length === 0) {
      if (group.required) {
        missing(label, "必填；请申请参数并登记到个推后台");
      } else {
        missing(label + " 未配置",
          "目标是多品牌后台推送；申请该厂商参数并登记到个推后台");
      }
    } else {
      const lack = group.keys.filter(k => !props[k]);
      missing(label + " 只填了一半", "还缺 " + lack.join("、"));
    }
  });

  /* 绝不能出现在这里的键 */
  const forbidden = ["GETUI_MASTERSECRET", "MASTERSECRET", "GETUI_MASTER_SECRET"];
  const leaked = forbidden.filter(k => props[k]);
  if (leaked.length) {
    missing("MasterSecret 不该放在这个文件里",
      "发现 " + leaked.join("、")
      + "——它打进 apk 就等于公开。删掉，只放 Supabase 云函数密钥。");
  } else {
    ok("MasterSecret 没有写进本机文件（正确）");
  }
}

/* ---------- 2. 打包会带上参数吗 ---------- */
console.log("\n[2] 打包配置");
const gradle = fs.existsSync(path.join(HERE, "android", "app", "build.gradle"))
  ? fs.readFileSync(path.join(HERE, "android", "app", "build.gradle"), "utf8")
  : "";
if (gradle.indexOf("GETUI_APPID") !== -1
    && gradle.indexOf("manifestPlaceholders") !== -1) {
  ok("build.gradle 会从 gradle.properties 读 GETUI_APPID");
} else {
  missing("build.gradle 里没有 GETUI_APPID 占位符");
}
const sdk = (gradle.match(/com\.getui[^\s'"]*/g) || []);
if (sdk.length) {
  ok("个推 SDK 依赖", sdk.length + " 个（含厂商通道）");
} else {
  missing("build.gradle 里没有个推 SDK 依赖");
}
[
  ["小米", "com.getui.opt:xmp:"], ["OPPO", "com.assist-v3:oppo:"],
  ["vivo", "com.assist-v3:vivo:"], ["华为", "com.getui.opt:hwp:"],
  ["荣耀", "com.getui.opt:honor:"], ["魅族", "com.getui.opt:mzp:"],
  ["UPS（坚果/索尼/海信）", "com.getui.opt:ups:"],
].forEach(([label, artifact]) => {
  if (gradle.indexOf(artifact) !== -1) ok(label + " 适配器已集成");
  else missing(label + " 适配器缺失", artifact);
});

/* ---------- 3. 代码部件 ---------- */
console.log("\n[3] 代码部件");
const parts = [
  ["sql/getui-push.sql", "数据库迁移", true],
  ["supabase/functions/getui-task-event/index.ts", "推送云函数", true],
  ["android/app/src/main/java/com/cj/projectrecorder/GetuiPushPlugin.java", "原生插件", true],
  ["android/app/src/main/java/com/cj/projectrecorder/GetuiPushIntentService.java", "消息接收服务", true],
];
parts.forEach(([file, label, required]) => {
  if (fs.existsSync(path.join(HERE, file))) ok(label + " 在");
  else if (required) missing(label + " 不见了", file);
});

/* 客户端：取 CID 并上报 */
const notify = fs.existsSync(path.join(HERE, "notify.js"))
  ? fs.readFileSync(path.join(HERE, "notify.js"), "utf8") : "";
if (notify.indexOf("push_devices") !== -1 && notify.indexOf("GetuiPush") !== -1) {
  ok("客户端会取 CID 并上报到 push_devices");
} else {
  missing("客户端没有接个推（找不到 GetuiPush / push_devices）");
}

/* ---------- 4. Supabase 侧（能查的查） ---------- */
console.log("\n[4] Supabase 侧");
const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";

(async () => {
  /* push_devices 表建了没有 */
  try {
    const r = await fetch(BASE + "/rest/v1/push_devices?select=cid&limit=1",
      { headers: { apikey: ANON, Authorization: "Bearer " + ANON } });
    const t = await r.text();
    if (r.status === 404 || t.indexOf("Could not find") !== -1) {
      missing("push_devices 表还没建",
        "跑 sql/getui-push.sql（Supabase SQL Editor）");
    } else {
      ok("push_devices 表已建好");
    }
  } catch (error) {
    info("查 push_devices 失败（网络）：" + error.message);
  }

  /* 云函数部署了没有 */
  try {
    const r = await fetch(BASE + "/functions/v1/getui-task-event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const t = await r.text();
    if (r.status === 404 || t.indexOf("Function not found") !== -1
        || t.indexOf("NOT_FOUND") !== -1) {
      missing("getui-task-event 云函数还没部署",
        "supabase functions deploy getui-task-event");
    } else if (r.status === 401 || t.indexOf("unauthorized") !== -1
        || t.indexOf("secret") !== -1) {
      ok("云函数已部署（拒绝无密钥请求）");
    } else {
      ok("云函数已部署", "HTTP " + r.status);
    }
  } catch (error) {
    info("查云函数失败（网络）：" + error.message);
  }

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(64));
  if (todo.length === 0) {
    console.log("本机参数和代码检查通过（" + okCount + " 项）。");
    console.log("");
    console.log("仍需人工确认：个推后台厂商通道已启用、厂商应用审核/签名已完成、");
    console.log("Supabase Database Webhook 已创建且密钥一致，然后逐品牌实机测试。");
    console.log("打包：npm run apk");
  } else {
    console.log("还差 " + todo.length + " 件事：");
    todo.forEach((item, i) => console.log("  " + (i + 1) + ". " + item));
    console.log("");
    console.log("（已完成 " + okCount + " 项）");
  }
})();
