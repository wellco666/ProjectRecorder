/* =============================================================
   把 App 的源文件复制到 devtools/，让里面的开发用测试页能独立运行。

   ## 为什么需要这个

   devtools/ 里的测试页用 iframe 加载 App（`src="index.html"`）。
   但它们**不能**进 apk——它们是开发工具，会白占体积。

   所以它们放在 devtools/，而这里把 App 文件复制一份过去，
   让那些页面能直接双击打开、不依赖 www/ 是否构建过。

   ## 用法

       node build-devtools.js
       # 然后打开 devtools/ 下的任意测试页
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const OUT = path.join(HERE, "devtools");

/* 和 build-www.js 的 FILES 一致。两处要同步——
   这里少一个文件，测试页就会静默缺功能。 */
const FILES = [
  "index.html",
  "style.css",
  "store.js",
  "calc.js",
  "charts.js",
  "assist.js",
  "sync.js",
  "notify.js",
  "account.js",
  "app.js",
];

const ICON_DIR = "icons";
const VENDOR_DIR = "vendor";

/* 测试页自己。**加新测试页时必须加到这里**，
   否则下次跑这个脚本会被当成"旧文件"删掉。 */
const PAGES = [
  "bootcheck.html",        // 启动自检：函数是否都在、页面能否渲染
  "e2e-ui.html",           // 完整业务流程：登录 → 派任务 → 勾选 → 收到
  "layout-check.html",     // 布局诊断：有没有横向溢出、导航是否隐藏
  "login-check.html",      // 登录页交互：身份按钮、URL 规整化、注册表单
  "touch-check.html",      // 触摸事件诊断
  "boss-entry-check.html", // 老板的管理入口能不能进得去
  "label-check.html",      // 每个输入框都要有可见标签
  "notify-check.html",     // 通知：API、降级、红点、提示条
  "notify-e2e.html",       // 通知端到端（用假客户端顶掉真库）
  "me-preview.html",       // 「我的」页预览（老板 / 员工两种身份）
  "_mock-index.html",      // 上面那个端到端测试用的入口（由脚本生成）
];

function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  let copied = 0;
  const missing = [];
  FILES.forEach(name => {
    const from = path.join(HERE, name);
    if (!fs.existsSync(from)) { missing.push(name); return; }
    fs.copyFileSync(from, path.join(OUT, name));
    copied += 1;
  });

  if (missing.length) {
    console.error("缺少这些文件：" + missing.join("、"));
    process.exitCode = 1;
  }

  /* 头像和云库也要（App 启动会用到） */
  let extras = 0;
  [ICON_DIR, VENDOR_DIR].forEach(dir => {
    const from = path.join(HERE, dir);
    const to = path.join(OUT, dir);
    if (!fs.existsSync(from)) {
      console.warn("缺少目录 " + dir + "，测试页可能显示不全");
      return;
    }
    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from).forEach(file => {
      fs.copyFileSync(path.join(from, file), path.join(to, file));
      extras += 1;
    });
  });

  /* 测试页：从项目根目录复制进 devtools/。

     **之前只检查存在性、没复制**，所以我把测试页写在根目录后，
     这个脚本会报告"还没有创建"——而其实文件是有的，
     只是没被搬过去。现在改成真的复制。 */
  let pages = 0;
  const missingPages = [];
  PAGES.forEach(name => {
    const from = path.join(HERE, name);
    if (!fs.existsSync(from)) { missingPages.push(name); return; }
    fs.copyFileSync(from, path.join(OUT, name));
    pages += 1;
  });

  /* 清理：不该留在 devtools 里的东西删掉，但保留测试页。
     **必须放在复制之后**，否则刚复制进去的会被删掉。 */
  const keep = FILES.concat([ICON_DIR, VENDOR_DIR]).concat(PAGES);
  fs.readdirSync(OUT).forEach(name => {
    if (keep.indexOf(name) === -1) {
      fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
    }
  });

  console.log(`devtools/ 已就绪：${copied} 个 App 文件 + ${extras} 个资源`
    + ` + ${pages} 个测试页`);
  if (missingPages.length) {
    console.log("");
    console.log("注意：这些测试页在项目根目录里找不到，请先创建：");
    missingPages.forEach(name => console.log("  " + name));
  }
  console.log("");
  console.log("可用的测试页（用浏览器打开 devtools/ 下的文件）：");
  PAGES.forEach(name => {
    const ok = fs.existsSync(path.join(OUT, name));
    console.log("  " + (ok ? "✓" : " ") + " " + name);
  });
}

main();
