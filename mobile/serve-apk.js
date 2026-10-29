/* =============================================================
   让手机能用浏览器下载 apk。

   ## 为什么需要它

     数据线要过四道关（线的类型、USB 模式、调试授权、厂商限制），
     微信传文件会改后缀名。**"手机扫码打开一个网页点下载"最省事。**

   ## 做什么

     在局域网里起一个只读的小网页服务，根目录就是 apk 所在文件夹。
     手机连同一个 WiFi，浏览器打开 http://<电脑IP>:8899 就能下载。

   ## 安全

     · **只监听局域网**，不是公网
     · 只读，不提供上传
     · 用完按 Ctrl+C 就关掉了
     · 根目录锁死在 apk 那个文件夹，不是整个项目

   用法：
     node serve-apk.js
   ============================================================= */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 8899;
const ROOT = path.join(__dirname, "android", "app", "build", "outputs",
                        "apk", "debug");

/* 只允许这几个文件被下载，不做目录浏览 */
const ALLOWED = ["app-debug.apk", "项目记录器.zip"];

function lanAddresses() {
  const list = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach(name => {
    (interfaces[name] || []).forEach(item => {
      if (item.family === "IPv4" && !item.internal) {
        list.push({ name: name, address: item.address });
      }
    });
  });
  return list;
}

function human(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

const server = http.createServer((request, response) => {
  const url = decodeURIComponent(request.url.split("?")[0]);

  /* 首页：列两个文件，点一下就能下 */
  if (url === "/" || url === "/index.html") {
    const rows = ALLOWED.filter(name =>
      fs.existsSync(path.join(ROOT, name))).map(name => {
      const size = fs.statSync(path.join(ROOT, name)).size;
      const tip = name.endsWith(".apk") ? "（点这个装）" : "（打包好的 zip）";
      return `<li><a href="/${encodeURIComponent(name)}">${name}</a>
        <span class="meta">${human(size)} ${tip}</span></li>`;
    }).join("");

    const body = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>项目记录器 · 下载</title>
<style>
  body { margin:0; padding:24px 18px; background:#f4f5f7; color:#2f3540;
         font-family:-apple-system,"PingFang SC","Microsoft YaHei UI",sans-serif;
         font-size:15px; line-height:1.8; }
  .box { max-width:520px; margin:0 auto; background:#fff;
         border:1px solid #e3e6ea; border-radius:12px; padding:22px; }
  h1 { font-size:19px; margin:0 0 4px; }
  .sub { color:#78828f; font-size:13.5px; margin-bottom:16px; }
  ul { padding-left:0; list-style:none; margin:0; }
  li { padding:12px 0; border-top:1px solid #eef1f4; }
  li:first-child { border-top:none; }
  a { color:#3b6ea5; font-weight:600; text-decoration:none; }
  .meta { display:block; color:#78828f; font-size:13px; font-weight:400; }
  .note { margin-top:16px; padding-top:14px; border-top:1px solid #eef1f4;
          color:#78828f; font-size:13px; }
</style></head><body>
<div class="box">
  <h1>项目记录器</h1>
  <div class="sub">手机版 · 点文件名下载</div>
  <ul>${rows}</ul>
  <div class="note">
    下载完点开安装。如果提示"未知来源"，去设置里允许浏览器安装应用。<br><br>
    装好后打开 App：老板填手机号，员工填工号，<b>不用选身份</b>。
  </div>
</div>
</body></html>`;

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(body);
    return;
  }

  /* 下载文件 */
  const name = url.replace(/^\//, "");
  if (ALLOWED.indexOf(name) === -1) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("没有这个文件");
    return;
  }
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("文件不存在，先打包");
    return;
  }

  const stat = fs.statSync(file);
  response.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": stat.size,
    "Content-Disposition": "attachment; filename=\"" + name + "\"",
  });
  fs.createReadStream(file).pipe(response);
  console.log("  有人下载了 " + name + "（" + human(stat.size) + "）");
});

server.listen(PORT, "0.0.0.0", () => {
  const addresses = lanAddresses();
  console.log("=".repeat(58));
  console.log("apk 下载服务已启动");
  console.log("=".repeat(58));
  console.log("");
  console.log("文件位置：" + ROOT);
  console.log("");
  addresses.forEach(item => {
    console.log("  在手机上打开（要和电脑连同一个 WiFi）：");
    console.log("    http://" + item.address + ":" + PORT);
    console.log("    （网卡：" + item.name + "）");
    console.log("");
  });
  console.log("  电脑上自己看：http://127.0.0.1:" + PORT);
  console.log("");
  console.log("按 Ctrl + C 停止这个服务。");
  console.log("");
});
