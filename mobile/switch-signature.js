/* =============================================================
   换签名时保留 App 数据的一次性工具。

   ## 为什么需要它

   Android 不允许"签名不同"的包覆盖安装。我们刚从 debug 签名
   换成了正式签名，所以必须**先卸载再装**——
   而卸载会把 App 数据（登录会话、本地工时、设置）一起删掉。

   直接卸载重装的话，用户要重新登录，本机上还没上传的数据会丢。

   ## 做法

     1. 用 run-as 把 App 数据打包（debug 包允许 run-as）
     2. 卸载
     3. 装新包
     4. 推回数据、解开

   这样登录状态和本地数据都还在。

   ## 注意

   `run-as` 只对 **debug 包**有效。正式发布包用不了这招
   （也不需要——正常升级不会换签名）。

   用法：
     node switch-signature.js
   ============================================================= */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ADB = "E:\\android-sdk\\platform-tools\\adb.exe";
const PKG = "com.cj.projectrecorder";
const APK = path.join(__dirname, "android", "app", "build", "outputs",
  "apk", "debug", "app-debug.apk");
const TAR = path.join(__dirname, "_appdata.tar");

function sh(args, opts) {
  return execFileSync(ADB, args, Object.assign({
    encoding: "buffer", maxBuffer: 512 * 1024 * 1024,
  }, opts || {}));
}

function shText(args) {
  return sh(args).toString().trim();
}

console.log("=".repeat(62));
console.log("换签名并保留数据");
console.log("=".repeat(62));
console.log("");

/* ---------- 0. 前置检查 ---------- */
if (!fs.existsSync(APK)) {
  console.log("找不到 APK：" + APK);
  console.log("先跑 npm run apk");
  process.exit(1);
}

const devices = shText(["devices"]).split("\n")
  .filter(l => /\tdevice$/.test(l));
if (!devices.length) {
  console.log("没有连上设备。插上 USB 并允许调试。");
  process.exit(1);
}
console.log("  设备: " + devices[0].split("\t")[0]);

/* 判断现在的包能不能 run-as（即是不是 debug 包） */
let canRunAs = true;
try {
  shText(["shell", "run-as " + PKG + " ls"]);
} catch (error) {
  canRunAs = false;
}

/* ---------- 1. 备份 ---------- */
console.log("");
console.log("[1/5] 备份 App 数据");
if (!canRunAs) {
  console.log("  run-as 不可用（当前装的是正式包或已损坏）。");
  console.log("  **将无法保留数据** —— 卸载后需要重新登录。");
} else {
  /* **不要用 cmd 的重定向。**

     第一版写的是
        cmd /c "adb" exec-out run-as PKG tar -cf - . > "file"
     结果 cmd 报 "The filename, directory name, or volume label
     syntax is incorrect."——那条命令的引号嵌套不对，
     备份**静默失败**，而卸载已经执行了，数据就这么丢了。

     改法：让 Node 直接接住 stdout 的字节再写文件，
     完全绕开 shell 的引号和重定向。
     execFileSync 的 buffer 模式拿到的就是原始字节，
     不会像 PowerShell 重定向那样损坏二进制。 */
  try {
    const buf = execFileSync(ADB,
      ["exec-out", "run-as", PKG, "tar", "-cf", "-", "."],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
    if (buf && buf.length > 1024) {
      fs.writeFileSync(TAR, buf);
      console.log("  已备份 " + Math.round(buf.length / 1024) + " KB → "
        + path.basename(TAR));
    } else {
      console.log("  备份内容太小（" + (buf ? buf.length : 0) + " 字节），"
        + "可能失败");
      canRunAs = false;
    }
  } catch (error) {
    console.log("  备份失败：" + String(error.message).slice(0, 140));
    canRunAs = false;
  }
}

/* ---------- 2. 卸载 ---------- */
console.log("");
console.log("[2/5] 卸载旧包");
try {
  const r = shText(["uninstall", PKG]);
  console.log("  " + r);
} catch (error) {
  console.log("  卸载返回错误（可能本来就没装），继续");
}

/* ---------- 3. 安装 ---------- */
console.log("");
console.log("[3/5] 安装新包（正式签名）");
let installed = false;
for (let i = 1; i <= 3 && !installed; i += 1) {
  const out = sh(["install", "-r", APK]).toString();
  if (/Success/.test(out)) {
    console.log("  安装成功");
    installed = true;
  } else {
    console.log("  第 " + i + " 次失败：" + out.split("\n")
      .filter(l => /Failure|Error/.test(l)).join(" ").slice(0, 120));
    execFileSync(ADB, ["shell", "sleep", "2"]);
  }
}
if (!installed) {
  console.log("  装不上。如果提示签名冲突，先手动卸载再跑本脚本。");
  process.exit(1);
}

/* ---------- 4. 还原数据 ---------- */
console.log("");
console.log("[4/5] 还原数据");
if (canRunAs && fs.existsSync(TAR)) {
  try {
    shText(["push", TAR, "/data/local/tmp/_appdata.tar"]);
    shText(["shell", "run-as " + PKG + " tar -xf /data/local/tmp/_appdata.tar"]);
    shText(["shell", "rm -f /data/local/tmp/_appdata.tar"]);
    console.log("  已还原（登录状态应该还在）");
  } catch (error) {
    console.log("  还原失败：" + String(error.message).slice(0, 120));
    console.log("  需要重新登录一次");
  }
} else {
  console.log("  没有备份可还原 —— 需要重新登录一次");
}

/* ---------- 5. 启动 ---------- */
console.log("");
console.log("[5/5] 启动 App");
try {
  shText(["shell", "am", "start", "-n", PKG + "/.MainActivity"]);
  console.log("  已启动");
} catch (error) {
  console.log("  启动失败：" + String(error.message).slice(0, 100));
}

/* ---------- 清理 ---------- */
if (fs.existsSync(TAR)) {
  fs.unlinkSync(TAR);
  console.log("");
  console.log("  已删除临时备份文件");
}

console.log("");
console.log("=".repeat(62));
console.log("完成。");
console.log("");
console.log("  如果 App 里显示「要重新登录」，登录一次即可 ——");
console.log("  之前的会话数据在换签名时丢失是正常的。");
