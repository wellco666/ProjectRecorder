/* =============================================================
   通知全链路验证（同时模拟两台设备）

   ## 为什么用原始 WebSocket，而不是 supabase-js

   一开始我用 `supabase-js` 的 `client.channel().on("postgres_changes")`
   来收推送，结果**永远收不到**——而同一个时刻：
     · 用原始 WebSocket 手拼协议，能收到
     · 手机上的真 App，也能收到

   也就是说库在**这个 node 环境**里发 postgres_changes 有问题
   （realtime 库依赖浏览器 API，node 下行为不一致）。
   拿它当测试基准会得出"推送坏了"的错误结论——我确实被误导过一轮。

   所以这里直接手拼 phoenix 协议，和 verify-realtime.js 一样。
   客户端用哪套不影响服务端行为，**手拼协议反而更接近真相**：
   它绕开库的所有封装，测的就是"服务端会不会把这一行推给我"。

   用法：
     node verify-push-e2e.js
   ============================================================= */
"use strict";

const BASE = "https://edchntmyqqjqvpngylgc.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkY2hudG15cXFqcXZwbmd5bGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1ODY5ODksImV4cCI6MjEwNzE2Mjk4OX0.6vfi2zxvdbmdLSHoV2U0r4R8zd10UCtO5XGaToqBc7I";
const PASS = "e2e123456";
const WS_URL = BASE.replace("https://", "wss://")
  + "/realtime/v1/websocket?apikey=" + ANON + "&vsn=1.0.0";

let passed = 0;
let failed = 0;
const ok = (l, d) => { passed += 1; console.log("  [OK]   " + l + (d ? "  " + d : "")); };
const bad = (l, d) => { failed += 1; console.log("  [失败] " + l); if (d) console.log("         " + String(d).slice(0, 240)); };

async function api(method, p, token, body, prefer) {
  const headers = { apikey: ANON, "Content-Type": "application/json",
    Authorization: "Bearer " + (token || ANON) };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(BASE + p, { method, headers,
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  return { status: r.status, data: d, text: t };
}

async function login(email) {
  const r = await api("POST", "/auth/v1/token?grant_type=password", null,
    { email: email, password: PASS });
  return (r.data && r.data.access_token) ? r.data.access_token : null;
}

/* 一台"设备"：手拼协议订阅 task_events，把收到的行存起来 */
class Device {
  constructor(name, token) {
    this.name = name;
    this.token = token;
    this.received = [];
    this.subscribed = false;
    this.serverError = null;
  }

  connect() {
    return new Promise(resolve => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      let settled = false;
      const finish = value => {
        if (!settled) { settled = true; resolve(value); }
      };
      const timer = setTimeout(() => finish(false), 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          topic: "realtime:" + this.name,
          event: "phx_join",
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: "" },
              postgres_changes: [{
                event: "*", schema: "public", table: "task_events",
              }],
            },
            access_token: this.token,
          },
          ref: "1",
        }));
      };

      ws.onmessage = event => {
        let msg = null;
        try { msg = JSON.parse(String(event.data)); } catch (e) { return; }

        /* **必须看 system 消息。**
           phx_reply 永远回 ok（握手成功），真正的拒绝是隔一拍
           发来的 system 消息。只看前者会把"表没加进发布"误判成成功。 */
        if (msg.event === "system" && msg.payload
            && msg.payload.status === "error") {
          this.serverError = msg.payload.message;
          clearTimeout(timer);
          finish(false);
          return;
        }
        if (msg.event === "system" && msg.payload
            && /Subscribed to PostgreSQL/i.test(msg.payload.message || "")) {
          this.subscribed = true;
          clearTimeout(timer);
          finish(true);
          return;
        }
        if (msg.event === "postgres_changes") {
          /* 手拼协议收到的形状：payload.data.record（和 supabase-js
             那套 payload.new 不一样——**两套封装的字段名不同**，
             写测试时按自己这套读，别混用）。 */
          const data = msg.payload && msg.payload.data;
          const record = (data && data.record) || {};
          this.received.push({
            at: Date.now(),
            kind: record.kind,
            title: record.title,
            employee_id: record.employee_id,
            boss_id: record.boss_id,
          });
        }
      };

      ws.onerror = () => { clearTimeout(timer); finish(false); };
      ws.onclose = () => { /* 断开时什么都不做，靠超时兜底 */ };
    });
  }

  async waitFor(kind, ms) {
    const until = Date.now() + (ms || 12000);
    while (Date.now() < until) {
      const hit = this.received.find(x => x.kind === kind);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 50));
    }
    return null;
  }

  async observe(ms) {
    await new Promise(r => setTimeout(r, ms));
    return this.received.slice();
  }

  clear() { this.received = []; }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function main() {
  console.log("=".repeat(66));
  console.log("通知全链路验证（两台设备，同时在线）");
  console.log("=".repeat(66));

  const stamp = Date.now().toString(36).slice(-5);
  const today = new Date().toISOString().slice(0, 10);

  /* ---------- 账号 ---------- */
  console.log("\n[0] 准备账号");
  const boss = await api("POST", "/rest/v1/rpc/create_boss_account", null,
    { p_code: "eb" + stamp, p_password: PASS, p_name: "链路老板" });
  if (!boss.data || !boss.data.ok) { bad("建老板失败", JSON.stringify(boss.data)); return 1; }
  const bossToken = await login(boss.data.code + "@boss.pr");
  const bossId = JSON.parse(Buffer.from(bossToken.split(".")[1], "base64")
    .toString("utf8")).sub;

  const staff = await api("POST", "/rest/v1/rpc/create_staff_account", bossToken,
    { p_code: "es" + stamp, p_password: PASS, p_name: "链路员工" });
  if (!staff.data || !staff.data.ok) { bad("建员工失败", JSON.stringify(staff.data)); return 1; }
  const staffId = staff.data.id;
  const staffToken = await login(staff.data.code + "@staff.pr");
  ok("账号就绪", boss.data.code + " / " + staff.data.code);

  /* ---------- 两台设备上线 ---------- */
  console.log("\n[1] 两台设备建立实时连接");
  const emp = new Device("emp", staffToken);
  const bossDev = new Device("boss", bossToken);
  const [e1, b1] = await Promise.all([emp.connect(), bossDev.connect()]);
  if (!e1) bad("员工设备订阅失败", emp.serverError || "超时");
  else ok("员工设备已订阅");
  if (!b1) bad("老板设备订阅失败", bossDev.serverError || "超时");
  else ok("老板设备已订阅");
  if (!e1 || !b1) {
    console.log("\n  订阅不上就测不了。检查 sql/enable-realtime.sql。");
    emp.close(); bossDev.close();
    return 1;
  }

  /* ---------- 场景 1：派任务 → 员工收到 ---------- */
  console.log("\n[2] 老板派任务 → 员工设备应收到 assigned");
  emp.clear(); bossDev.clear();
  const t1 = Date.now();
  const task = await api("POST", "/rest/v1/tasks", bossToken, {
    id: crypto.randomUUID(), boss_id: bossId, employee_id: staffId,
    title: "链路任务A", detail: "", plan_date: today, est_hours: 2,
    project_name: "", step_name: "",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, "return=representation");
  if (task.status >= 400) {
    bad("派任务失败", JSON.stringify(task.data).slice(0, 200));
  } else {
    const got = await emp.waitFor("assigned");
    if (got) ok("员工设备收到 assigned", (got.at - t1) + " ms");
    else bad("员工设备 12 秒内没收到", JSON.stringify(emp.received));

    /* **老板设备也会收到 assigned —— 这是对的，别当成 bug。**

       `task_events` 的读策略是
           boss_id = auth.uid() or employee_id = auth.uid()
       派任务时 boss_id 就是老板自己，所以他**确实有权限**
       收到这一行，服务端推给他没问题。

       "老板不该看到 新任务 提醒"是**客户端**过滤的：
       notify.js 的 describeEvent 里有一句
           if (role === "boss" && desc.kind === "assigned") return;

       好处是老板端照样同步到这条事件（红点不重复、数据完整），
       只是不显示成"提醒"。

       我第一版断言写的是"老板不该收到"——**把设计当成了 bug**，
       白报了一项失败。这里改成修正确认：收到了，但只是数据。 */
    const also = await bossDev.waitFor("assigned", 2000);
    if (also) {
      ok("老板设备也收到 assigned（数据同步用，界面会过滤掉）");
    } else {
      ok("老板设备没收到 assigned（服务端也可过滤，都算正常）");
    }
  }

  /* ---------- 场景 2：完成 → 老板收到 ---------- */
  console.log("\n[3] 员工完成任务 → 老板设备应收到 done");
  emp.clear(); bossDev.clear();
  await api("POST", "/rest/v1/task_logs", staffToken, {
    id: crypto.randomUUID(), task_id: task.data[0].id, employee_id: staffId,
    started_at: null, finished_at: new Date().toISOString(), finish_date: today,
  }, "return=representation");
  await api("POST", "/rest/v1/worklogs", staffToken, {
    id: crypto.randomUUID(), boss_id: bossId, employee_id: staffId,
    task_id: task.data[0].id, work_date: today, hours: 2,
    content: "链路任务A", project_name: "", source: "task",
  }, "return=representation");
  const t2 = Date.now();
  await api("POST", "/rest/v1/task_events", staffToken, {
    id: crypto.randomUUID(), boss_id: bossId, employee_id: staffId,
    task_id: task.data[0].id, kind: "done", title: "链路任务A",
    hours: 2, work_date: today,
  }, "return=representation");
  const gotDone = await bossDev.waitFor("done");
  if (gotDone) ok("老板设备收到 done", (gotDone.at - t2) + " ms");
  else bad("老板设备 12 秒内没收到 done", JSON.stringify(bossDev.received));

  /* ---------- 场景 3：取消完成 → 老板收到 ---------- */
  console.log("\n[4] 员工取消完成 → 老板设备应收到 undone");
  emp.clear(); bossDev.clear();
  const t3 = Date.now();
  await api("POST", "/rest/v1/task_events", staffToken, {
    id: crypto.randomUUID(), boss_id: bossId, employee_id: staffId,
    task_id: task.data[0].id, kind: "undone", title: "链路任务A",
    work_date: today,
  }, "return=representation");
  const gotUndone = await bossDev.waitFor("undone");
  if (gotUndone) ok("老板设备收到 undone", (gotUndone.at - t3) + " ms");
  else bad("老板设备 12 秒内没收到 undone", JSON.stringify(bossDev.received));

  /* ---------- 场景 4：隔离 ---------- */
  console.log("\n[5] 隔离：局外人不该收到");
  const outBoss = await api("POST", "/rest/v1/rpc/create_boss_account", null,
    { p_code: "ex" + stamp, p_password: PASS, p_name: "局外老板" });
  const outToken = await login(outBoss.data.code + "@boss.pr");
  const outsider = new Device("outsider", outToken);
  await outsider.connect();
  outsider.clear();
  await api("POST", "/rest/v1/tasks", bossToken, {
    id: crypto.randomUUID(), boss_id: bossId, employee_id: staffId,
    title: "隔离任务", detail: "", plan_date: today, est_hours: 1,
    project_name: "", step_name: "",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, "return=representation");
  const leaked = await outsider.observe(4000);
  if (leaked.length === 0) ok("局外老板一条都没收到");
  else bad("局外老板收到 " + leaked.length + " 条 —— 隔离有问题", JSON.stringify(leaked));

  emp.close(); bossDev.close(); outsider.close();

  console.log("\n" + "=".repeat(66));
  if (failed) {
    console.log("失败 " + failed + " 项，通过 " + passed + " 项");
    return 1;
  }
  console.log("全部通过（" + passed + " 项）。三个方向通知都通，隔离正确。");
  console.log("");
  console.log("测试账号：" + boss.data.code + " / " + staff.data.code
    + " / " + outBoss.data.code);
  return 0;
}

main().then(c => { process.exitCode = c; })
  .catch(e => { console.error("脚本异常：" + e.message); process.exitCode = 1; });
