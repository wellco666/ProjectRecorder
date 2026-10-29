import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

/* 推送用的通知渠道。

   **必须和客户端 notify.js 里的 PUSH_CHANNEL_ID 一模一样。**
   客户端负责把这个渠道建出来（级别 4）；这里只负责"往这个渠道发"。

   名字对不上 → 通知落到 App 默认渠道（级别 2）→ 不弹横幅，
   而且**完全静默不报错**。selfcheck 会比对这两处。 */
const PUSH_CHANNEL_ID = "pr-alerts-v2";

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const expected = Deno.env.get("TASK_EVENT_WEBHOOK_SECRET") ?? "";
  if (!expected || req.headers.get("x-webhook-secret") !== expected) {
    return new Response("unauthorized", { status: 401, headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const event = payload?.record;
    if (payload?.type !== "INSERT" || payload?.table !== "task_events" || !event?.id) {
      return Response.json({ ignored: true }, { headers: corsHeaders });
    }

    const recipient = event.kind === "assigned" ? event.employee_id
      : (event.kind === "done" || event.kind === "undone") ? event.boss_id : null;
    if (!recipient) return Response.json({ ignored: true }, { headers: corsHeaders });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: devices, error: queryError } = await client
      .from("push_devices").select("cid,notify_settings").eq("profile_id", recipient);
    if (queryError) throw queryError;
    const prefKey = event.kind === "assigned" ? "onTaskAssigned"
      : event.kind === "done" ? "onTaskDone" : "onTaskUndone";
    const targets = (devices ?? []).filter((device) =>
      device.notify_settings?.enabled !== false
      && device.notify_settings?.system !== false
      && device.notify_settings?.[prefKey] !== false
    );
    if (!targets.length) return Response.json({ sent: 0 }, { headers: corsHeaders });

    const appId = Deno.env.get("GETUI_APP_ID")!;
    const appKey = Deno.env.get("GETUI_APP_KEY")!;
    const masterSecret = Deno.env.get("GETUI_MASTER_SECRET")!;
    if (!appId || !appKey || !masterSecret) throw new Error("GeTui server credentials are not configured");

    const base = `https://restapi.getui.com/v2/${appId}`;
    const timestamp = String(Date.now());
    const sign = await sha256Hex(appKey + timestamp + masterSecret);
    const authRes = await fetch(`${base}/auth`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appkey: appKey, timestamp, sign }),
    });
    const authJson = await authRes.json();
    if (!authRes.ok || authJson.code !== 0 || !authJson.data?.token) {
      throw new Error(`GeTui auth failed (${authJson.code ?? authRes.status})`);
    }

    const title = event.kind === "assigned" ? "收到新任务"
      : event.kind === "done" ? "员工已完成任务" : "员工撤销了任务完成";
    const body = String(event.title || "项目记录器中有新的任务动态").slice(0, 100);
    let sent = 0;
    const failures: string[] = [];
    for (const device of targets) {
      const pushRes = await fetch(`${base}/push/single/cid`, {
        method: "POST",
        headers: { "content-type": "application/json", token: authJson.data.token },
        body: JSON.stringify({
          request_id: (await sha256Hex(`${event.id}:${device.cid}`)).slice(0, 32),
          settings: { ttl: 86400000, strategy: { default: 1 } },
          audience: { cid: [device.cid] },
          /* **渠道要写在两个地方，缺一个就落到默认渠道。**

             个推有两条下发路径：
               · 在线通道（自有）——读 push_message.notification
               · 厂商通道（vivo/华为/…）——读 push_channel.android.ups

             我一开始只写在 ups 里。没配厂商通道时走在线通道，
             那个路径根本不看 ups，通知落到 App 的 `Default` 渠道
             （级别 2）——**收到了但不弹横幅**。
             dumpsys 里能直接看到 `Notification(channel=Default)`，
             而请求的明明是 pr-alerts-v1。

             所以两块都写，值保持一致。 */
          push_message: { notification: {
            title, body, click_type: "startapp",
            channel_id: PUSH_CHANNEL_ID,
            channel_name: "任务提醒",
            channel_level: 4,
          } },
          push_channel: { android: { ups: { notification: {
            title, body, click_type: "startapp",
            /* **渠道名要和客户端建的完全一致。**

               客户端（notify.js 的 PUSH_CHANNEL_ID）会主动建这个渠道，
               级别 4（HIGH，会弹横幅）。

               名字对不上就落到默认渠道（级别 2），
               "收到了但不弹出来"——这种失败**完全静默**，不报错。

               也不要随手换新名字：这台手机上实测，
               新建的渠道会被系统压到级别 2（App 通知级别被锁成 LOW，
               `mIsAppImportanceLocked=true`），
               只有 `pr-alerts-v1` 是在那次锁定之前建好的、级别真的是 4。

               （selfcheck 会比对这两个文件里的渠道名。） */
            channel_id: PUSH_CHANNEL_ID,
            channel_name: "任务提醒", channel_level: 4,
          } } } },
        }),
      });
      const result = await pushRes.json();
      if (pushRes.ok && result.code === 0) sent++;
      else failures.push(String(result.msg || result.code || pushRes.status));
    }
    return Response.json({ sent, failures }, { headers: corsHeaders });
  } catch (error) {
    console.error("getui-task-event failed", error);
    return Response.json({ error: "push dispatch failed" }, { status: 500, headers: corsHeaders });
  }
});
