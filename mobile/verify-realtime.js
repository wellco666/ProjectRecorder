/* =============================================================
   验证：手机有没有真的连上 Supabase 实时通道。

   做法：建一个临时老板账号，让老板"派任务给自己"，
   看事件能不能在 1 秒内通过 WebSocket 推回来。

   这模拟的正是员工手机收到"新任务"的路径。

   用法：
     node verify-realtime.js
   ============================================================= */
"use strict";

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";
const PASS = "rt123456";

let passed = 0;
let failed = 0;
function ok(label, detail) {
  passed += 1;
  console.log("  [OK]   " + label + (detail ? "  " + detail : ""));
}
function bad(label, detail) {
  failed += 1;
  console.log("  [失败] " + label);
  if (detail) console.log("         " + String(detail).slice(0, 220));
}

async function api(method, path, token, body, prefer) {
  const headers = {
    apikey: ANON, "Content-Type": "application/json",
    Authorization: "Bearer " + (token || ANON),
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(BASE + path, {
    method: method, headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: response.status, data: data, text: text };
}

async function main() {
  console.log("=".repeat(62));
  console.log("实时推送端到端验证");
  console.log("=".repeat(62));

  const stamp = Date.now().toString(36).slice(-5);

  /* ---------- 建一个临时老板 ---------- */
  console.log("\n[1] 建临时账号");
  const boss = await api("POST", "/rest/v1/rpc/create_boss_account", null,
    { p_code: "rt" + stamp, p_password: PASS, p_name: "实时测试老板" });
  if (!boss.data || !boss.data.ok) {
    bad("建老板失败", JSON.stringify(boss.data));
    return 1;
  }
  const code = boss.data.code;
  const login = await api("POST", "/auth/v1/token?grant_type=password", null,
    { email: code + "@boss.pr", password: PASS });
  if (!login.data || !login.data.access_token) {
    bad("登录失败", JSON.stringify(login.data).slice(0, 160));
    return 1;
  }
  const token = login.data.access_token;
  const bossId = login.data.user.id;
  ok("临时老板就绪", code + "  id=" + bossId.slice(0, 8) + "…");

  const staff = await api("POST", "/rest/v1/rpc/create_staff_account", token,
    { p_code: "rs" + stamp, p_password: PASS, p_name: "实时测试员工" });
  if (!staff.data || !staff.data.ok) {
    bad("建员工失败", JSON.stringify(staff.data));
    return 1;
  }
  const staffId = staff.data.id;
  ok("临时员工就绪", staff.data.code);

  /* ---------- 用员工的身份订阅（模拟员工手机）---------- */
  console.log("\n[2] 以员工身份订阅任务事件（模拟员工手机）");
  const staffLogin = await api("POST",
    "/auth/v1/token?grant_type=password", null,
    { email: staff.data.code + "@staff.pr", password: PASS });
  if (!staffLogin.data || !staffLogin.data.access_token) {
    bad("员工登录失败", JSON.stringify(staffLogin.data).slice(0, 160));
    return 1;
  }
  const staffToken = staffLogin.data.access_token;

  const wsUrl = BASE.replace("https://", "wss://")
    + "/realtime/v1/websocket?apikey=" + ANON + "&vsn=1.0.0";
  const ws = new WebSocket(wsUrl);

  const arrived = [];
  let subscribedAt = 0;

  const done = new Promise(resolve => {
    const timer = setTimeout(() => resolve("timeout"), 20000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        topic: "realtime:test",
        event: "phx_join",
        payload: {
          config: {
            broadcast: { self: false },
            presence: { key: "" },
            postgres_changes: [{
              event: "INSERT", schema: "public", table: "task_events",
            }],
          },
          access_token: staffToken,
        },
        ref: "1",
      }));
    };

    ws.onmessage = event => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (e) { return; }

      /* **必须看 system 消息。**

         `phx_join` 的回复永远是 `ok`——哪怕订阅根本不可用。
         真正的失败是紧跟着的一条 system 消息：

             "Unable to subscribe to changes with given parameters.
              Please check Realtime is enabled ..."

         我第一版只看 phx_reply，于是"订阅成功"了却永远等不到推送，
         白白查了半天。**凡是"握手成功但功能不生效"的地方，
         都要找找有没有第二条消息。** */
      if (msg.event === "system" && msg.payload
          && msg.payload.status === "error") {
        bad("服务端拒绝订阅", msg.payload.message);
        console.log("");
        console.log("  → 去 Supabase SQL Editor 跑一遍 "
          + "sql/enable-realtime.sql");
        clearTimeout(timer);
        resolve("rejected");
        return;
      }

      if (msg.event === "phx_reply" && msg.payload
          && msg.payload.status === "ok" && !subscribedAt) {
        subscribedAt = Date.now();
        ok("订阅成功", "服务端返回 ok");
        /* 订阅好了就派任务 */
        setTimeout(() => {
          api("POST", "/rest/v1/tasks", token, {
            id: crypto.randomUUID(), boss_id: bossId,
            employee_id: staffId, title: "实时测试任务", detail: "",
            plan_date: new Date().toISOString().slice(0, 10),
            est_hours: 2, project_name: "", step_name: "",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, "return=representation").then(r => {
            if (r.status >= 400) {
              bad("派任务失败", JSON.stringify(r.data).slice(0, 200));
              clearTimeout(timer);
              resolve("error");
            } else {
              console.log("  → 已派任务，等推送…");
            }
          }).catch(error => {
            /* **必须兜住**。

               网络抖动时如果这个 Promise 没人接，
               node 会把整个进程带崩（"fetch failed"），
               测试连结果都打不出来。我第一版就漏了这里，
               网络一抖就只看到一大段堆栈。 */
            bad("派任务请求失败", error.message);
            clearTimeout(timer);
            resolve("error");
          });
        }, 600);
        return;
      }
      if (msg.event === "postgres_changes") {
        const record = msg.payload && msg.payload.data
          && msg.payload.data.record;
        arrived.push({
          at: Date.now(),
          kind: record ? record.kind : "?",
          title: record ? record.title : "?",
        });
        clearTimeout(timer);
        resolve("arrived");
      }
    };

    ws.onerror = () => { clearTimeout(timer); resolve("error"); };
  });

  const outcome = await done;

  /* ---------- 判定 ---------- */
  console.log("");
  if (outcome === "rejected") {
    /* 这条最重要：明确告诉用户去跑哪段 SQL，
       而不是含糊地说"实时不通"。 */
    bad("实时订阅被服务端拒绝 —— 去跑 sql/enable-realtime.sql",
      "不跑也能用，只是会退回 15 秒轮询，延迟大");
  } else if (outcome === "arrived" && arrived.length) {
    const first = arrived[0];
    const delay = first.at - subscribedAt;
    ok("推送到达", first.kind + "  " + first.title);
    ok("延迟", delay + " 毫秒（客户端同步+弹窗再几百毫秒）");
  } else if (subscribedAt) {
    bad("订阅成功但 20 秒内没收到推送", "结果：" + outcome);
  } else {
    bad("订阅没成功", "结果：" + outcome);
  }

  try { ws.close(); } catch (e) { /* 忽略 */ }

  console.log("\n" + "=".repeat(62));
  if (failed) {
    console.log("失败 " + failed + " 项，通过 " + passed + " 项");
    return 1;
  }
  console.log("全部通过（" + passed + " 项）。实时推送是通的，延迟在秒级。");
  console.log("");
  console.log("（临时账号 " + code + "，可以在 App 里用「注销账号」清掉）");
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("脚本异常：" + error.message);
  process.exitCode = 1;
});
