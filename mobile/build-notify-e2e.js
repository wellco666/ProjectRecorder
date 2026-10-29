/* =============================================================
   生成通知端到端测试页

   ## 为什么需要生成而不是直接写

     测试要**在 vendor/supabase.js 之前**插入 mock-supabase.js，
     这样 window.supabase 被换掉。手写一个 index.html 副本
     会和真实文件脱节（改了真的忘了改副本，测试就变成测旧代码）。

     所以从真实的 index.html 生成：
       · 把 <script src="vendor/supabase.js"> 换成 mock
       · 其余原样
     这样 index.html 的结构变了，生成的副本自动跟上。

   ## 产物

     devtools/_mock-index.html   带 mock 的 App 入口
     devtools/notify-e2e.html    测试页（iframe 加载上面那个）

   用法：
     node build-notify-e2e.js
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const OUT = path.join(HERE, "devtools");

function main() {
  const source = fs.readFileSync(path.join(HERE, "index.html"), "utf8");

  /* 用 mock 顶掉真库 */
  const vendorTag = '<script src="vendor/supabase.js"></script>';
  if (source.indexOf(vendorTag) === -1) {
    console.error("index.html 里找不到 vendor/supabase.js 的引用，"
      + "生成逻辑要跟着改。");
    process.exitCode = 1;
    return;
  }
  const mocked = source.replace(
    vendorTag,
    '<!-- 用假客户端顶掉真库：端到端测试要控制服务端响应 -->\n'
    + '<script src="mock-supabase.js"></script>');

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "_mock-index.html"), mocked, "utf8");

  /* 把 mock 也复制过去 */
  fs.copyFileSync(path.join(HERE, "mock-supabase.js"),
                  path.join(OUT, "mock-supabase.js"));

  /* 确认没有别的地方**还在加载**真库。
     只匹配 <script src="...">，不要匹配注释里提到的文件名——
     注释里写"vendor/supabase.js 必须先到"是给人看的说明。 */
  const stillThere = /<script\s+src="vendor\/supabase\.js"/.test(mocked);
  console.log("生成 devtools/_mock-index.html"
    + (stillThere ? "  ⚠ 还在加载真库" : "  （真库已换掉）"));

  /* 列出 iframe 会用到的脚本，确认顺序 */
  const scripts = mocked.match(/<script src="([^"]+)"/g) || [];
  console.log("");
  console.log("脚本加载顺序：");
  scripts.forEach(tag => {
    const name = tag.replace(/<script src="|"/g, "");
    console.log("  " + name);
  });
}

main();
