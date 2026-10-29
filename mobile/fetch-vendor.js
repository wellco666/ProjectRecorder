/* =============================================================
   下载 Supabase 浏览器库到 vendor/，打包进 apk。

   ## 为什么必须下载到本地

   不能用 `<script src="https://cdn...">` 引用：

     · **App 离线时就加载不上** —— 而使用场景正是"员工在外面
       报工时"，很可能没网。CDN 在国内还可能很慢或被墙。
     · 启动速度依赖网络，白屏风险大。

   所以下载一份放进工程，和网页一起打进 apk。约 120 KB。

   ## 用法

       node fetch-vendor.js

   如果下载失败（网络问题），脚本会给出提示。
   没有这个文件程序也能跑（登录功能会提示"云服务没配好"），
   但账号系统用不了。
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const HERE = __dirname;
const DIR = path.join(HERE, "vendor");
const OUT = path.join(DIR, "supabase.js");

/*: 固定大版本 2，不跟 latest——
     自动升级可能带来不兼容的改动，而这是个要打包进 apk 的依赖，
     升级必须是有意识的动作。 */
const SOURCES = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js",
  "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js",
];

function download(url, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error("重定向次数过多")); return; }
    https.get(url, { timeout: 60000 }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400
          && response.headers.location) {
        resolve(download(response.headers.location, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error("HTTP " + response.statusCode));
        return;
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject).on("timeout", function () {
      this.destroy();
      reject(new Error("超时"));
    });
  });
}

async function main() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

  for (let i = 0; i < SOURCES.length; i += 1) {
    const url = SOURCES[i];
    process.stdout.write(`尝试 ${url}\n`);
    try {
      const data = await download(url, 0);
      /* 简单校验：UMD 包里一定有 supabase 这个全局名。
         下载到错误页面（比如 404 HTML）也能通过 HTTP 200，
         不校验的话会打进去一个坏文件，出问题很难查。 */
      const text = data.toString("utf8");
      if (text.indexOf("supabase") === -1 || data.length < 20000) {
        throw new Error("内容不像 Supabase 库（" + data.length + " 字节）");
      }
      fs.writeFileSync(OUT, data);
      console.log(`已保存 vendor/supabase.js`
        + `（${(data.length / 1024).toFixed(1)} KB）`);
      console.log("\n下一步：node build-www.js && npx cap sync android");
      return 0;
    } catch (error) {
      console.log("  失败：" + error.message);
    }
  }

  console.log();
  console.log("两个源都下载失败。可能原因：");
  console.log("  · 网络不通，或者被墙");
  console.log("  · 需要代理");
  console.log();
  console.log("手动下载的办法：");
  console.log("  1. 浏览器打开 https://cdn.jsdelivr.net/npm/"
    + "@supabase/supabase-js@2/dist/umd/supabase.js");
  console.log("  2. 全选内容，另存为 vendor/supabase.js");
  console.log();
  console.log("没有这个文件也能继续开发，但登录功能用不了。");
  return 1;
}

main().then(code => { process.exitCode = code; });
