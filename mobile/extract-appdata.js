/* =============================================================
   从手机的 LevelDB 文件里把 localStorage 的数据抠出来。

   用途：重装（换签名必须卸载）会清掉本机数据，
   而 App 的数据库就是一整段 JSON 存在 localStorage 里。
   LevelDB 文件是明文的，所以能直接捡出来，重装后再写回去。

   用法：
     node extract-appdata.js <备份目录>
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) {
  console.log("用法: node extract-appdata.js <备份目录>");
  process.exit(1);
}

/* 把备份的 tar 里的 leveldb 文件抽出来（tar 只是简单拼接） */
function findInTar(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const name = buffer.slice(offset, offset + 100)
      .toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const sizeText = buffer.slice(offset + 124, offset + 136)
      .toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeText, 8) || 0;
    const dataAt = offset + 512;
    if (name.indexOf("leveldb") !== -1 && size > 0) {
      files.push({ name, data: buffer.slice(dataAt, dataAt + size) });
    }
    offset = dataAt + Math.ceil(size / 512) * 512;
  }
  return files;
}

/* 从一段二进制里找 "pr_database_v1" 后面的 JSON。

   ## 两个坑，都踩过

   **坑一：文件是混合编码。**
   LevelDB 里**键**是 UTF-8，**值**是 UTF-16LE
   （Chromium 的 localStorage 这么存）。
   所以不能把整个文件按某一种编码解——键会找不到。

   做法：按字节定位键（utf8 能对上 ASCII 键名），
   **从键之后**再把那一段当 UTF-16LE 解。

   **坑二：值前面有几个字节的元数据。**
   `pr_database_v1` 后面跟着 `\xa7\x02\x00` 之类，
   然后才是 `{`。所以要从键往后找第一个 `{`（UTF-16 是 `{ \x00`）。 */
function extractDatabase(buf) {
  const results = [];
  const key = "pr_database_v1";

  /* 在原始字节里找键（ASCII 键在 utf8 和 latin1 下都是同样的字节） */
  let from = 0;
  while (true) {
    const at = buf.indexOf(Buffer.from(key, "latin1"), from);
    if (at === -1) break;
    from = at + key.length;

    /* 值从键后面一小段开始，按 UTF-16LE 解。
       多留 64 字节余量，免得键和值之间还有别的东西。 */
    const valueStart = at + key.length;
    const slice = buf.slice(valueStart);
    const text = slice.toString("utf16le");

    /* 找第一个 `{`，且不能离键太远（太远说明这段不是值） */
    const start = text.indexOf("{");
    if (start === -1 || start > 32) continue;

    /* 括号配平找结尾 */
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length && i < start + 8000000; i += 1) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) continue;

    try {
      results.push(JSON.parse(text.slice(start, end)));
    } catch (error) {
      /* 这段不是完整的值，跳过 */
    }
  }
  return results;
}

/* **直接扫备份目录下的每个文件。**

   不解析 tar 结构（第一版栽在那里），也不假设文件名——
   数据库就是一整段 JSON，逐个文件在字节流里找就行。 */
const entries = fs.readdirSync(dir).filter(name =>
  /\.(ldb|log)$/.test(name));
console.log("备份文件: " + entries.length + " 个");

let best = null;
entries.forEach(name => {
  const data = fs.readFileSync(path.join(dir, name));
  extractDatabase(data).forEach(db => {
    const size = JSON.stringify(db).length;
    if (!best || size > JSON.stringify(best).length) best = db;
  });
});

if (!best) {
  console.log("没抠出数据库 —— 备份可能不含 leveldb");
  process.exit(1);
}

const out = path.join(dir, "pr_database_extracted.json");
fs.writeFileSync(out, JSON.stringify(best, null, 2), "utf8");

console.log("");
console.log("=== 抠出来的数据 ===");
const count = key => (Array.isArray(best[key]) ? best[key].length : "-");
console.log("  项目      : " + count("projects"));
console.log("  员工      : " + count("employees"));
console.log("  工时      : " + count("worklogs"));
console.log("  习惯      : " + count("habits"));
console.log("  任务      : " + count("tasks"));
console.log("  员工账号  : " + count("staffAccounts"));
console.log("  通知      : " + count("notifications"));
console.log("  登录身份  : " + (best.profile
  ? best.profile.role + " / " + best.profile.code : "（未登录）"));
console.log("");
console.log("已写出: " + out);
console.log("");
console.log("重装之后可以在浏览器控制台里执行这段恢复：");
console.log("  localStorage.setItem('pr_database_v1', "
  + "JSON.stringify(<上面那个 json>)); location.reload();");
