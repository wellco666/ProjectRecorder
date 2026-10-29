/* =============================================================
   通知

   ## 两套通道，各管一件事

     · **应用内**：底部导航的小红点 + 页面顶部的提示条。
       打开 App 就一定看得到，不依赖任何系统权限。
     · **系统通知**：安卓通知栏的弹窗横幅。前台后台都弹，
       但要申请权限，而且小米/华为等会杀后台，**不保证一定收到**。

   ## 多快能到

     服务端的 task_events 表加了实时发布，App 通过 WebSocket
     订阅它——**服务器主动推**，通常 1～2 秒就到，
     不用等轮询（轮询 15 秒只是兜底，防止订阅掉线时漏掉）。

     代价：**App 必须活着**。安卓会冻结后台 WebView 的定时器，
       所以 App 被杀掉之后 WebSocket/轮询就收不到了；国内多厂商
       离线送达改由个推 SDK 和 OEM 通知通道负责。

   ## 数据从哪来

     服务端 task_events 表记"发生了什么"（派任务 / 完成 / 取消完成）。
     本地的 notifications 存"我收到了什么、读没读"。

   **已读状态只存在本地**：老板手机上看过了，不该让平板也跟着变已读。
   服务端只负责产生事件。

   ## 去重靠 notifyCursor

     每类事件记一个"处理到哪个时间点为止"。同一条事件
     不会提醒第二遍，重启 App 也不会。
   ============================================================= */

/*: 最多留多少条。超了从最旧的开始丢。
    不设上限的话，用一年之后 localStorage 会被通知撑爆——
    而 localStorage 满了会导致**整个数据库存不进去**。 */
const NOTIFY_KEEP = 200;

/*: 项目状态取值。

   **从 app.js 的项目下拉抄过来，不要自己编。**

   我原来在这里写了 "active" / "done"（凭印象的英文值），
   而真实取值是中文——结果判断条件永远为真、直接 return，
   **项目状态通知一次都不会触发**，而且不报错，只是安静地不来。

   这类错误只有把代码和真实数据对照才能发现。
   所以这里给出唯一的权威列表，下面只引用不重写。 */
const PROJECT_STATUS = {
  planning: "规划中",
  active: "进行中",
  paused: "已暂停",
  delivered: "已交付",
  cancelled: "已取消",
};

/*: 哪些状态变化值得提醒。

   · 进行中  —— 项目"发出/启动"了（用户要的"项目发出"提醒）
   · 已交付  —— 项目完成（用户要的"项目完成"提醒）

   暂停和取消不提醒：那是状态整理，不是进展。 */
const PROJECT_NOTIFY_STATUS = [PROJECT_STATUS.active, PROJECT_STATUS.delivered];

/*: 通知的五类，和 notifyPrefs 里的开关一一对应。 */
const NOTIFY_KINDS = {
  assigned: { pref: "onTaskAssigned", icon: "📋", label: "新任务" },
  done: { pref: "onTaskDone", icon: "✅", label: "已完成" },
  undone: { pref: "onTaskUndone", icon: "↩️", label: "已取消" },
  /* 接受 / 延期这一类"双方来回"的消息，共用一个开关。
     分太细反而没人愿意一项项去调——它们本来就是同一件事：
     "这条任务有人在等你回应"。 */
  rejected: { pref: "onTaskReply", icon: "🚫", label: "不接受" },
  extend: { pref: "onTaskReply", icon: "📅", label: "延期申请" },
  extend_ok: { pref: "onTaskReply", icon: "📅", label: "延期批准" },
  extend_no: { pref: "onTaskReply", icon: "🚫", label: "延期驳回" },
  summary: { pref: "onWorklogSummary", icon: "⏱", label: "工时" },
  project: { pref: "onProjectStatus", icon: "📁", label: "项目" },
};

function notifyPrefs() {
  const prefs = DB.notifyPrefs || {};
  return Object.assign({}, emptyDatabase().notifyPrefs, prefs);
}

/* GeTui is optional until the owner configures a GeTui app. The SDK must
   not initialize before the user explicitly accepts its data processing. */
/* 最近一次「设备登记」的结果。

   ## 为什么要有这个

   实测踩到过：App 登录了、推送同意也点了、个推 CID 也生成了，
   但 `push_devices` 里**始终没有这台设备的记录**，
   于是推送发到一个旧地址，**手机上永远收不到，而且一声不响**。

   查下来是这一句的问题：

       if (cid && cloudClient && ...) { upsert ... }

   `cloudClient` 为 null 时**整个 if 被跳过**——
   不抛异常、不打日志、不返回错误，循环 20 秒后静默返回 false。
   界面上什么都不显示，用户以为推送开着。

   所以这里把每次尝试的结果记下来，界面上能看见卡在哪一步。
   和 `lastNotifyAttempt` 是同一个思路：**静默失败必须变成可见的失败**。 */
let lastGetuiRegistration = null;

async function ensureGetuiPushConsent() {
  const profile = DB && DB.profile;
  const cap = typeof window !== "undefined" ? window.Capacitor : null;
  if (!profile || !cap) return false;
  const plugins = cap.Plugins || {};
  const bridge = plugins.GetuiPush || (cap.getPlugin
    ? cap.getPlugin("GetuiPush") : null);
  if (!bridge || typeof bridge.enable !== "function") return false;

  let consent = getSetting("getui_push_consent", "unset");
  if (consent === "unset") {
    consent = window.confirm(
      "为了让老板派任务、员工完成任务时，即使应用在后台也能收到系统通知，"
      + "本应用将使用个推及手机厂商推送通道。个推会处理设备标识和网络信息，"
      + "并接收通知标题/内容以送达消息。详情：\n"
      + "https://docs.getui.com/privacy/?new_page=1\n\n同意并启用推送？"
    ) ? "granted" : "denied";
    saveSetting("getui_push_consent", consent);
  }
  if (consent !== "granted") {
    lastGetuiRegistration = { at: nowISO(), ok: false, reason: "没有同意隐私授权" };
    return false;
  }

  const record = (ok, reason) => {
    lastGetuiRegistration = { at: nowISO(), ok: ok, reason: reason };
    /* **同时写进设置和日志。**

       只放在内存里的话，出问题时只能靠"再装一次、盯着看"，
       而这一步本来就是静默的——必须能事后读到原因。

       写进设置的好处：可以直接从手机上读出来（排查用），
       也能在界面上显示。 */
    try { saveSetting("getui_push_last_error", String(reason || "")); } catch (e) { }
    try { console.warn("Getui 登记失败：" + reason); } catch (e) { }
    return false;
  };

  try {
    await bridge.enable();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      /* **自己把云客户端准备好。**

         原来等调用方先初始化，但 resumeSession() 里
         ensureGetuiPushConsent() 排在 syncNow() **之前**，
         那一刻 cloudClient 还是 null，于是整个 if 被跳过——
         不报错、不打日志、20 秒后静默返回 false。

         initCloud() 幂等且很便宜，这里主动调一次就稳了。 */
      if (!cloudClient && typeof initCloud === "function") {
        initCloud();
      }

      const result = await bridge.clientId();
      const cid = String(result && result.clientId || "").trim();

      if (!cid) {
        record(false, "拿不到设备 CID（个推还没初始化完）");
      } else if (!cloudClient) {
        record(false, "云客户端没就绪（网络或配置问题）");
      } else if (!DB.profile || DB.profile.id !== profile.id) {
        record(false, "身份已经切换，这次登录不登记");
      } else {
        const saved = await cloudClient.from("push_devices").upsert({
          cid: cid,
          profile_id: profile.id,
          platform: "android",
          notify_settings: notifyPrefs(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "cid" });
        if (!saved.error) {
          saveSetting("getui_push_registered", true);
          saveSetting("getui_push_last_error", "");
          lastGetuiRegistration = {
            at: nowISO(), ok: true, reason: "已登记（CID 尾号 "
              + cid.slice(-6) + "）",
          };
          return true;
        }
        /* **把服务端返回的错误原文记下来。**
           RLS 拒绝、表不存在、字段类型不对，界面上都长一个样，
           只有原文能区分。 */
        const err = saved.error;
        record(false, "写库失败：" + String(
          err.message || err.code || err).slice(0, 100));
      }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
  } catch (error) {
    console.warn("GeTui registration pending", error);
    record(false, "异常：" + String(
      error && error.message ? error.message : error).slice(0, 100));
  }
  return false;
}

async function syncGetuiPushPreferences() {
  try {
    const cap = typeof window !== "undefined" ? window.Capacitor : null;
    const bridge = cap && cap.Plugins && cap.Plugins.GetuiPush;
    if (!bridge || !cloudClient || !DB.profile) return;
    const result = await bridge.clientId();
    const cid = String(result && result.clientId || "").trim();
    if (!cid) return;
    await cloudClient.from("push_devices").update({
      notify_settings: notifyPrefs(),
      updated_at: new Date().toISOString(),
    }).eq("cid", cid).eq("profile_id", DB.profile.id);
  } catch (error) { /* preference sync retries at next login */ }
}

async function unregisterGetuiPushDevice() {
  try {
    if (cloudClient && DB.profile) {
      const cap = typeof window !== "undefined" ? window.Capacitor : null;
      const native = cap && cap.Plugins && cap.Plugins.GetuiPush;
      if (native && native.clientId) {
        const result = await native.clientId();
        const cid = String(result && result.clientId || "");
        if (cid) await cloudClient.from("push_devices").delete()
          .eq("cid", cid).eq("profile_id", DB.profile.id);
      }
    }
  } catch (error) { /* logout must remain available even offline */ }
}

function saveNotifyPrefs(patch) {
  DB.notifyPrefs = Object.assign({}, notifyPrefs(), patch || {});
  _save();
  if (typeof syncGetuiPushPreferences === "function") syncGetuiPushPreferences();
  return DB.notifyPrefs;
}

/* 这一类通知要不要发？总开关关掉就全不发。 */
function notifyEnabled(kind) {
  const prefs = notifyPrefs();
  if (!prefs.enabled) return false;
  const meta = NOTIFY_KINDS[kind];
  if (!meta) return false;
  return prefs[meta.pref] !== false;
}

/* ---------------------------------------------------------- 存 */

function notifications() {
  return Array.isArray(DB.notifications) ? DB.notifications : [];
}

/* 加一条通知。

   `key` 是**去重键**：同一个 key 已经存在就不再加。
   服务端事件用事件 id，本地事件用 "kind:引用id"。
   没有这个的话，每次同步都会把同一件事提醒一遍。 */
function addNotification(data) {
  if (!Array.isArray(DB.notifications)) DB.notifications = [];
  const key = String(data.key || "");
  if (key && DB.notifications.some(item => item.key === key)) return null;

  const kind = NOTIFY_KINDS[data.kind] ? data.kind : "done";
  const item = {
    id: key || ("n" + Date.now() + "_" + Math.random().toString(36).slice(2, 7)),
    key: key,
    kind: kind,
    title: String(data.title || ""),
    body: String(data.body || ""),
    task_id: data.task_id || null,
    employee_id: data.employee_id || null,
    project_id: data.project_id || null,
    at: data.at || nowISO(),
    read: false,
  };
  DB.notifications.unshift(item);
  /* 超出上限就从最旧的开始丢 */
  if (DB.notifications.length > NOTIFY_KEEP) {
    DB.notifications = DB.notifications.slice(0, NOTIFY_KEEP);
  }
  _save();
  return item;
}

function unreadCount(kind) {
  return notifications().filter(item =>
    !item.read && (!kind || item.kind === kind)).length;
}

function markNotificationsRead(kind) {
  let changed = 0;
  notifications().forEach(item => {
    if (!item.read && (!kind || item.kind === kind)) {
      item.read = true;
      changed += 1;
    }
  });
  if (changed) _save();
  return changed;
}

function clearNotifications() {
  DB.notifications = [];
  _save();
}

/* ---------------------------------------------------------- 事件 → 通知 */

/* 服务端事件转成通知文案。

   文案分两种身份写，因为同一件事在两边说法不同：
   派任务对老板是"已派给张三"，对员工是"张三收到了"。 */
function describeEvent(event) {
  const kind = String(event.kind || "");
  const who = String(event.title || "任务");
  if (kind === "assigned") {
    return { kind: "assigned", title: "有新任务", body: who };
  }
  if (kind === "done") {
    return {
      kind: "done",
      title: "有任务完成了",
      body: who + (event.hours ? "（" + num(event.hours) + " 小时）" : ""),
    };
  }
  if (kind === "undone") {
    return {
      kind: "undone",
      title: "有任务被取消完成",
      body: who + "　工时已经撤掉了",
    };
  }

  /* 延期的新日期放在 work_date 里（服务端函数写进去的）。
     没有这个字段就只说"申请延期"，不编一个日期出来。 */
  const newDate = event.work_date
    ? String(event.work_date).slice(0, 10) : "";

  /* ---- 员工不接受任务 ---- */
  if (kind === "rejected") {
    return {
      kind: "rejected",
      title: "员工不接受这条任务",
      body: who + "　去「任务」页看原因",
    };
  }

  /* ---- 员工申请延期 ---- */
  if (kind === "extend") {
    return {
      kind: "extend",
      title: "员工申请延期",
      body: who + (newDate ? "　想挪到 " + newDate : "") + "　去处理一下",
    };
  }

  /* ---- 老板批了延期 ---- */
  if (kind === "extend_ok") {
    return {
      kind: "extend_ok",
      title: "延期申请批了",
      body: who + (newDate ? "　已挪到 " + newDate : ""),
    };
  }

  /* ---- 老板没批 ---- */
  if (kind === "extend_no") {
    return {
      kind: "extend_no",
      title: "延期申请没批",
      body: who + "　还在原计划那天",
    };
  }

  return null;
}

/* 处理一批服务端事件，生成通知。

   `role` 决定哪些事件跟"我"有关：
     员工只关心 assigned（老板派了新活）
     老板关心 done / undone（员工干了什么） */
function ingestEvents(events, role) {
  if (!Array.isArray(events) || !events.length) return [];
  const added = [];
  events.forEach(event => {
    const desc = describeEvent(event);
    if (!desc) return;
    /* **按身份分发。**
       同一个 task_events 表两边都能读到，所以这里要筛：
         员工关心：派了新活、延期被批/被驳
         老板关心：员工完成了/撤销了、不接受、申请延期

       以前写的是"员工只看 assigned、老板不看 assigned"——
       加了接受和延期之后就漏了：员工的延期审批结果、老板的
       不接受提醒，都会被这两句静默丢掉。 */
    const FOR_EMPLOYEE = ["assigned", "extend_ok", "extend_no"];
    const FOR_BOSS = ["done", "undone", "rejected", "extend"];
    if (role === "employee" && FOR_EMPLOYEE.indexOf(desc.kind) === -1) return;
    if (role === "boss" && FOR_BOSS.indexOf(desc.kind) === -1) return;

    /* **取消完成要把老板端那条工时真的撤掉。**

       员工的"取消完成"是把服务端那条 worklog 删掉，
       而增量拉取只拉"更新的行"——**老板端永远收不到"它没了"**
       （mergeRemoteWorklogs 只增改不删）。

       结果：我原来给老板的通知写着"工时已经撤掉了"，
       但看板上那 2 小时还在。**文案在撒谎。**

       这里按事件里的 task_id + work_date 把对应工时删掉——
       和员工端删除时用的是同一组字段，所以两边找的是同一条。

       **在生成通知之前做**：万一后面哪一步抛错，
       也不该出现"通知说撤了、数据没撤"这种不一致。 */
    if (desc.kind === "undone") {
      revokeWorklogFromEvent(event);
    }

    if (!notifyEnabled(desc.kind)) return;

    const item = addNotification({
      key: "ev:" + event.id,
      kind: desc.kind,
      title: desc.title,
      body: desc.body,
      task_id: event.task_id,
      employee_id: event.employee_id,
      at: event.created_at,
    });
    if (item) added.push(item);
  });
  return added;
}

/* 撤销一条工时（员工取消了完成）。

   匹配用 task_id + work_date：
     · task_id  同一条任务
     · work_date 同一天（一天只能完成一次，所以这组字段唯一确定一条）

   两个字段都必须有，缺一个就**不动数据**——
   宁可不撤，也不要因为字段缺失把别的工时误删了。 */
function revokeWorklogFromEvent(event) {
  const taskId = event && event.task_id;
  const date = event && event.work_date;
  if (!taskId || !date) return 0;
  if (!Array.isArray(DB.remoteWorklogs)) return 0;

  const day = String(date).slice(0, 10);
  const before = DB.remoteWorklogs.length;
  DB.remoteWorklogs = DB.remoteWorklogs.filter(row => {
    const sameTask = String(row.task_id) === String(taskId);
    const sameDay = String(row.work_date || "").slice(0, 10) === day;
    return !(sameTask && sameDay);
  });
  const removed = before - DB.remoteWorklogs.length;
  if (removed) _save();
  return removed;
}

/* 工时汇总。

   老板每次同步都可能拉到好几条工时。**逐条提醒会刷屏**，
   所以按"这次同步拉到的今天的工时"合成一条。 */
function ingestWorklogSummary(rows) {
  if (!notifyEnabled("summary")) return null;
  if (!Array.isArray(rows) || !rows.length) return null;
  const today = nowISO().slice(0, 10);
  /* **先滤掉空的元素**：`Array.isArray([{}， null])` 是 true，
     但里面那个 null 取 .work_date 会直接崩。
     通知是次要功能，不该因为它把整个同步搞崩。 */
  const mine = rows.filter(row => row
    && String(row.work_date || "").slice(0, 10) === today);
  if (!mine.length) return null;

  const total = mine.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  const names = [];
  mine.forEach(row => {
    const employee = (DB.employees || []).find(item =>
      String(item.id) === String(row.employee_id));
    const name = employee ? employee.name : "员工";
    if (names.indexOf(name) === -1) names.push(name);
  });
  if (total <= 0) return null;

  /* 去重键用"日期 + 人数 + 总数"，同一天同样数字不重复提醒。
     数字变了（又来了一条）就会生成新的一条——这是想要的行为。 */
  return addNotification({
    key: "summary:" + today + ":" + mine.length + ":" + total.toFixed(2),
    kind: "summary",
    title: "今天收到 " + mine.length + " 条工时",
    body: names.join("、") + "　合计 " + num(total) + " 小时",
  });
}

/* 项目状态变化（发出 / 完成）。

   和别的通知不同，这个**没有服务端事件**——
   项目表只在老板本机，所以是本地算出"状态变了"再提醒。

   比较的是项目状态快照，第一次跑只记录不提醒
   （否则一装 App 就会把现有项目全提醒一遍）。 */
function ingestProjectStatus() {
  if (!notifyEnabled("project")) return null;
  const projects = Array.isArray(DB.projects) ? DB.projects : [];
  const snapshot = DB.notifyCursor.projectStatus;
  const current = {};
  projects.forEach(item => {
    current[String(item.id)] = String(item.status || "");
  });

  /* 第一次跑：只记快照，不提醒 */
  if (!snapshot || typeof snapshot !== "object") {
    DB.notifyCursor.projectStatus = current;
    _save();
    return null;
  }

  const added = [];
  projects.forEach(item => {
    const id = String(item.id);
    const before = snapshot[id];
    const after = String(item.status || "");
    if (before === undefined || before === after) return;
    /* **只提醒进入"进行中"和"已交付"这两种。**

       状态值用 PROJECT_STATUS 里的常量，不要在这里重写中文——
       重写就有写错的机会（我原来就是凭印象写成 "active"/"done"，
       而真实取值是中文，于是这条通知一次都没触发过）。 */
    if (PROJECT_NOTIFY_STATUS.indexOf(after) === -1) return;
    const word = after === PROJECT_STATUS.delivered ? "已完成" : "已启动";
    const note = addNotification({
      key: "proj:" + id + ":" + after + ":" + nowISO().slice(0, 10),
      kind: "project",
      title: "项目" + word,
      body: String(item.name || "项目"),
      project_id: item.id,
    });
    if (note) added.push(note);
  });

  DB.notifyCursor.projectStatus = current;
  _save();
  return added.length ? added : null;
}

/* ---------------------------------------------------------- 界面 */

/* 找元素。

   **不用 app.js 里的 `$`**：那个函数定义在 app.js，而
   notify.js 在它之前加载。靠函数提升勉强能跑，但那是
   **隐式的加载顺序依赖**——一旦有人调整 <script> 顺序、
   或者单独加载 notify.js（自检就是这么做的），这里就会
   "is not defined"。

   自带一个最朴素的实现，依赖就没了。 */
function notifyNode(id) {
  if (typeof document === "undefined") return null;
  return document.getElementById(id);
}

/* 底部导航红点。

   数字直接标在「我的」上——所有通知都归到那一页，
   不按类型分散到各个标签（那会让人不知道该点哪）。

   **受「应用内提示」开关控制。** 关掉之后要把已有的红点清掉，
   不是只是不再画新的——否则关掉之后旧红点还挂着。 */
function renderNotifyBadges() {
  if (typeof document === "undefined") return;
  /* 关掉应用内提示：清掉红点就走 */
  if (!notifyPrefs().inApp) {
    document.querySelectorAll('#nav [data-page="me"]').forEach(button => {
      const badge = button.querySelector(".nav-badge");
      if (badge) badge.remove();
    });
    const menu = notifyNode("btn-menu");
    if (menu && menu.classList) menu.classList.remove("has-dot");
    return;
  }

  const total = unreadCount();
  document.querySelectorAll('#nav [data-page="me"]').forEach(button => {
    let badge = button.querySelector(".nav-badge");
    if (!total) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("i");
      badge.className = "nav-badge";
      button.appendChild(badge);
    }
    badge.textContent = total > 99 ? "99+" : String(total);
  });
  /* 标题栏的「⋯」也标一下，方便不看底部导航的人 */
  const menu = notifyNode("btn-menu");
  if (menu && menu.classList) {
    menu.classList.toggle("has-dot", total > 0);
  }
}

/* 页面顶部的提示条。

   **只显示最新的、还没读过的那一条**，不是把所有通知堆上去——
   堆上去的话页面顶部会被几十条挤满。

   同样受「应用内提示」开关控制。 */
function renderNotifyBanner(targetId) {
  if (typeof document === "undefined") return;
  const box = notifyNode(targetId);
  if (!box) return;

  /* 关掉应用内提示：清空并返回 */
  if (!notifyPrefs().inApp) {
    box.innerHTML = "";
    return;
  }

  const fresh = notifications().filter(item => !item.read);
  if (!fresh.length) {
    box.innerHTML = "";
    return;
  }
  const latest = fresh[0];
  const kind = NOTIFY_KINDS[latest.kind] || NOTIFY_KINDS.done;
  const more = fresh.length > 1
    ? `<span class="notify-more">还有 ${fresh.length - 1} 条</span>` : "";
  /* **做得显眼一点。**

     用户反馈"UI 在里面，不容易看到"。原来的样子是一条
     和普通提示长得差不多的细条，很容易被当成背景忽略。

     现在：图标 + 大字标题 + 右侧"查看"箭头，放在页面最顶部。 */
  box.innerHTML = `
    <div class="notify-banner" data-notify-open="1">
      <span class="notify-icon">${kind.icon || "🔔"}</span>
      <div class="notify-text">
        <b>${escapeHtml(latest.title)}</b>
        <div class="notify-body">${escapeHtml(latest.body || "")}</div>
      </div>
      ${more}
      <span class="notify-go">查看 ›</span>
    </div>`;
  const opener = box.querySelector("[data-notify-open]");
  if (opener) opener.onclick = () => openNotifyCenter();
}

/* 通知中心。所有通知都在这，已读未读分开显示。 */
function openNotifyCenter() {
  const list = notifications();
  markNotificationsRead();
  renderNotifyBadges();
  renderNotifyBanner("notify-banner-dash");
  renderNotifyBanner("notify-banner-tasks");

  const prefs = notifyPrefs();
  const body = list.length
    ? list.map(item => {
        const meta = NOTIFY_KINDS[item.kind] || NOTIFY_KINDS.done;
        return `
          <div class="card" style="margin-bottom:8px">
            <div class="row">
              <div class="grow">
                <b>${meta.icon} ${escapeHtml(item.title)}</b>
                <div class="meta">${escapeHtml(item.body)}</div>
              </div>
              <span class="meta">${escapeHtml(String(item.at).slice(5, 16))}</span>
            </div>
          </div>`;
      }).join("")
    : '<div class="empty">还没有通知。</div>';

  openSheet("通知", `
    <div class="meta" style="padding:0 0 10px">
      共 ${list.length} 条
    </div>
    <div class="chips" id="notify-prefs">
      <button class="chip${prefs.inApp ? " on" : ""}" data-pref="inApp">应用内提示</button>
      <button class="chip${prefs.system ? " on" : ""}" data-pref="system">系统通知</button>
      <button class="chip${prefs.onTaskAssigned ? " on" : ""}" data-pref="onTaskAssigned">新任务</button>
      <button class="chip${prefs.onTaskDone ? " on" : ""}" data-pref="onTaskDone">完成任务</button>
      <button class="chip${prefs.onTaskUndone ? " on" : ""}" data-pref="onTaskUndone">取消完成</button>
      <button class="chip${prefs.onTaskReply ? " on" : ""}" data-pref="onTaskReply">接受/延期</button>
      <button class="chip${prefs.onWorklogSummary ? " on" : ""}" data-pref="onWorklogSummary">工时汇总</button>
      <button class="chip${prefs.onProjectStatus ? " on" : ""}" data-pref="onProjectStatus">项目状态</button>
    </div>

    <!-- 自检按钮。

         "通知不弹"这种问题很难查：可能是权限、可能是渠道、
         可能是后台被冻结、也可能是事件根本没到。
         一步步问用户"你看到什么"效率太低。

         这个按钮直接走**完整的通知流程**（ingestEvents → 红点
         → 提示条 → 系统通知），弹出来就说明这套是通的；
         不弹也能立刻缩小范围。 -->
    <button class="btn ghost" id="notify-selftest"
            style="width:100%;margin-top:12px">测试弹窗（自己发一条）</button>
    <button class="btn ghost" id="notify-system-settings"
            style="width:100%;margin-top:8px">打开手机通知设置</button>
    <button class="btn ghost" id="notify-getui-enable"
            style="width:100%;margin-top:8px">启用后台推送 / 更新授权</button>

    <!-- 设备登记状态。

         这一行是**必需的**，不是调试信息：

         推送要能到手机，前提是这台设备的 CID 登记进了服务端的
         push_devices。这一步失败时**完全静默**——界面看着一切正常，
         但消息发到一个旧地址，手机上永远收不到。

         实测踩过：换签名重装后 CID 变了，新 CID 没登记成功，
         旧记录还在库里，于是"推送发出去了但收不到"。

         把结果显示出来，一眼就知道是"没登记"还是"登记了但没收到"。 -->
    <div class="meta" style="padding:10px 2px 0" id="notify-getui-state">
      ${(() => {
        if (typeof lastGetuiRegistration !== "undefined" && lastGetuiRegistration) {
          const ok = lastGetuiRegistration.ok;
          return "后台推送：" + (ok ? "✓ " : "✗ ")
            + escapeHtml(String(lastGetuiRegistration.reason));
        }
        if (getSetting("getui_push_registered", false)) {
          return "后台推送：已登记";
        }
        return "后台推送：还没登记（点上面那个按钮）";
      })()}
    </div>

    <div style="height:10px"></div>
    ${body}
  `, [
    { label: "清空", kind: "danger", onClick: () => {
      clearNotifications();
      closeSheet();
      renderNotifyBadges();
      renderNotifyBanner("notify-banner-dash");
      renderNotifyBanner("notify-banner-tasks");
      toast("通知已清空");
    } },
    { label: "关闭", onClick: closeSheet },
  ]);

  /* 自检按钮：造一条假事件，走真实的通知流程 */
  const selftest = notifyNode("notify-selftest");
  if (selftest) {
    selftest.onclick = async () => {
      closeSheet();
      const me = DB.profile || {};
      /* 按身份造对应的事件类型，走的是真实代码路径 */
      const isBoss = me.role === "boss";
      const fake = {
        id: "selftest-" + Date.now(),
        kind: isBoss ? "done" : "assigned",
        title: isBoss ? "自检：员工完成了一项任务" : "自检：老板派了新任务",
        boss_id: isBoss ? me.id : (me.boss_id || "selftest-boss"),
        employee_id: isBoss ? "selftest-employee" : me.id,
        created_at: new Date().toISOString(),
      };
      const result = await pumpNotifications({ events: [fake] });
      if (result && result.added) {
        toast("自检通知已发出，看通知栏");
      } else {
        toast("没进通知 —— 可能被开关挡住了");
      }
    };
  }

  const systemSettings = notifyNode("notify-system-settings");
  if (systemSettings) {
    systemSettings.onclick = async () => {
      const bridge = notificationSettingsBridge();
      if (!bridge || typeof bridge.openNotificationSettings !== "function") {
        toast("请到手机设置 → 应用 → 项目记录器 → 通知中开启横幅和锁屏通知");
        return;
      }
      try {
        await bridge.openNotificationSettings();
      } catch (error) {
        toast("打开系统设置失败，请手动进入手机应用通知设置");
      }
    };
  }

  const getuiEnable = notifyNode("notify-getui-enable");
  if (getuiEnable) getuiEnable.onclick = async () => {
    saveSetting("getui_push_consent", "unset");
    const ok = await ensureGetuiPushConsent();
    toast(ok ? "后台推送设备已登记" : "暂未登记成功；请检查同意状态、云端配置和网络");
  };

  /* 开关点一下立刻生效并存盘。
     这里也用自己的 notifyNode，不用 app.js 的 $（理由见上面）。 */
  const prefBox = notifyNode("notify-prefs");
  if (prefBox) prefBox.querySelectorAll("[data-pref]").forEach(button => {
    button.onclick = () => {
      const name = button.dataset.pref;
      const next = saveNotifyPrefs({ [name]: !notifyPrefs()[name] });
      button.classList.toggle("on", !!next[name]);
      /* 系统通知刚打开时顺手申请权限 */
      if (name === "system" && next.system) requestNotifyPermission();
    };
  });
}

/* ---------------------------------------------------------- 系统通知 */

/* 拿到系统通知的能力。

   两条路，按顺序试：

     1. **原生桥**（安卓 apk 里）：
        window.Capacitor.Plugins.LocalNotifications
        安卓的 WebView 由 Capacitor 注入运行时，它按
        capacitor.plugins.json 注册原生插件，插件名是
        'LocalNotifications'（见插件源码的 registerPlugin 调用）。

     2. **浏览器降级版**：window.supabase 那样的 UMD 我们没引，
        但 @capacitor/core 的 web 实现会用浏览器 Notification API。
        这条让"在电脑浏览器里也能试一下通知"成为可能。

   两条都没有就返回 null——应用内提示照常工作，
   系统通知这一层安静地不生效（不抛错）。 */
function notifyBridge() {
  const cap = typeof window !== "undefined" ? window.Capacitor : null;
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins.LocalNotifications) {
    return cap.Plugins.LocalNotifications;
  }
  /* Capacitor 8 的 getPlugin 会在原生插件和 web 实现之间自己选 */
  if (typeof cap.getPlugin === "function") {
    try {
      const plugin = cap.getPlugin("LocalNotifications");
      if (plugin) return plugin;
    } catch (error) {
      /* 拿不到就当作没有 */
    }
  }
  return null;
}

/* 请求通知权限。**只在用户真的打开系统通知开关、或者登录后**申请——
   一进 App 就弹权限框是最容易被拒绝的做法。 */
const NOTIFY_CHANNEL_ID = "pr-alerts-v2";

/* Android notification settings shortcut. Background delivery is native GeTui/OEM,
   not a foreground service or a live WebView. */
function notificationSettingsBridge() {
  const cap = typeof window !== "undefined" ? window.Capacitor : null;
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins.NotificationSettings) return cap.Plugins.NotificationSettings;
  if (typeof cap.getPlugin === "function") {
    try { return cap.getPlugin("NotificationSettings"); } catch (error) { /* 没有就算了 */ }
  }
  return null;
}

/* 建通知渠道（幂等）。

   **Android 8 以后必须有渠道，否则通知不出横幅。**

   没有渠道的表现：通知照样进通知栏，但不响、不震、不弹横幅，
   只静静躺在下拉栏里——用户根本注意不到，看起来就是"没通知"。

   渠道的重要级别**建好就固定**，改代码里的 importance
   不会更新已存在的渠道。所以名字带版本号：要调级别就换名字。

   ## 为什么要建两个渠道

   实测发现（`node check-push-channel.js`）：

     服务器推来的通知走的是 **个推自己的默认渠道 `upush_default`**，
     那个渠道级别是 3（不弹横幅）。所以推送能收到，
     **但只躺在通知栏里，不弹出来**。

   云函数在推送负载里请求的是 `task_messages`（`channel_level: 4`），
   但那个渠道**一直没被建出来**——厂商通道没配时，
   个推走在线通道，就不会去建它。

   ## 为什么名字里带 v2（踩过的坑）

   我先建了 `task_messages`，代码里写 `importance: 4`。
   装上去一看，**它是级别 2**，还是不弹横幅。

   原因：**个推 SDK 抢先把这个名字建掉了**——推送负载里请求了
   `task_messages`，SDK 就自动建一个，级别给的是 LOW(2)。
   而 **Android 的渠道级别建好就锁死**，
   我们后来的 `createChannel(importance: 4)` 是空操作，级别改不动。

   所以换个 SDK 没碰过的名字。以后**要调级别就换名字**，
   不要指望改 importance 能生效——这一点在 Android 上是硬规则。

   名字必须和云函数里的 `channel_id` **完全一致**，
   差一个字符就退回默认渠道，横幅又没了（selfcheck 会比对这两处）。 */
const PUSH_CHANNEL_ID = NOTIFY_CHANNEL_ID;

async function ensureNotifyChannel() {
  const bridge = notifyBridge();

  /* **优先用原生建渠道。**

     Capacitor 的 `createChannel({ importance: 4 })` 实测不可靠：
     同样参数，`pr-alerts-v1` 建成 4，`pr-task-v3` 却建成 2。
     而渠道级别建好就锁死，建错了只能换名字重来。

     原生那个方法用 `IMPORTANCE_HIGH` 常量，而且**把实际级别读回来**，
     调用方能核对是不是真的成了。 */
  const nativeBridge = notificationSettingsBridge();
  if (nativeBridge && typeof nativeBridge.createHeadsUpChannel === "function") {
    try {
      const result = await nativeBridge.createHeadsUpChannel({
        id: PUSH_CHANNEL_ID,
        name: "任务消息",
        description: "老板派任务、员工完成任务的推送",
      });
      const level = result && typeof result.importance === "number"
        ? result.importance : -1;
      if (level >= 4) return true;
      /* 级别不够：多半是这个 id 早就被别处建过了（比如推送 SDK）。
         记下来，界面能显示，也方便排查。 */
      if (typeof console !== "undefined") {
        console.warn("推送渠道 " + PUSH_CHANNEL_ID + " 实际级别是 " + level
          + "（不是 4）—— 这个 id 可能已被占用，弹不出横幅");
      }
    } catch (error) {
      /* 原生方法失败就退回下面那套，不阻断流程 */
    }
  }

  /* 退回 Capacitor 的插件（级别不保证，但至少有渠道） */
  if (!bridge || typeof bridge.createChannel !== "function") return false;
  let ok = false;

  /* 本地发的通知（App 内事件）用这个 */
  try {
    await bridge.createChannel({
      id: NOTIFY_CHANNEL_ID,
      name: "任务提醒",
      description: "派任务、完成任务、工时汇总",
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
    });
    ok = true;
  } catch (error) {
    /* 建渠道失败不该影响功能，大不了退回无横幅的通知 */
  }

  /* 服务器推来的通知（个推）用这个。名字要和服务端一致。 */
  try {
    await bridge.createChannel({
      id: PUSH_CHANNEL_ID,
      name: "任务消息",
      description: "老板派任务、员工完成任务的推送",
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
    });
    ok = true;
  } catch (error) {
    /* 同上 */
  }

  return ok;
}

async function requestNotifyPermission() {
  const bridge = notifyBridge();
  if (!bridge) {
    /* 没有桥（普通浏览器、或者 Capacitor 没注入）。
       不算错误——应用内提示照常工作。 */
    return { supported: false, granted: false };
  }
  try {
    /* 先建渠道再要权限。反过来的话，用户在权限框点了"允许"，
       第一条通知却因为没有渠道而不出横幅。 */
    await ensureNotifyChannel();
    let permission = await bridge.checkPermissions();
    if (permission.display !== "granted") {
      permission = await bridge.requestPermissions();
    }
    return {
      supported: true,
      granted: permission.display === "granted",
    };
  } catch (error) {
    return { supported: true, granted: false, error: error.message };
  }
}

/* 检查系统通知权限，把结果记在本地。

   **为什么要缓存**：checkPermissions 是异步的，而 renderMe 是
   同步渲染的。不缓存的话，界面永远拿不到这个结果，
   "权限没给"这句提示就永远不会出现。 */
async function refreshNotifyPermission() {
  const result = await requestNotifyPermission();
  DB.notifyPermission = result;
  _save();
  return result;
}

/* 通知页的权限行文案（给设置页用） */
function notifyPermissionText() {
  const permission = DB.notifyPermission;
  if (!permission) return "还没检查";
  if (!permission.supported) return "这个环境不支持系统通知";
  return permission.granted ? "已允许" : "没允许（去手机设置里打开）";
}

/* 弹一条系统通知。

   **任何时候都弹，包括 App 正在前台。**

   用户的原话是"我要的是直接弹到手机上"——他看着 App 时收到弹窗，
   恰恰证明通知是活的；看不到弹窗反而以为功能坏了。

   嫌吵的人可以在通知中心里关掉「系统通知」那一项。 */
/* 系统通知的"体检记录"。

   ## 为什么要记这个

   系统通知失败是**完全静默**的：
     · 权限没给 → 直接 return false
     · 通道没建 → 通知进了通知栏但不弹横幅
     · 插件没桥 → 直接 return false
     · 图标资源名写错 → 插件抛异常，被 catch 吞掉

   上面每一种，用户看到的都是同一件事："没弹窗"。
   而他告诉我"没弹窗"，我也只能猜。**猜过好几轮了。**

   所以把最后一次尝试的结果记下来，界面能显示出来。
   再看"没弹窗"时，一眼就知道卡在哪一步。 */
let lastNotifyAttempt = null;

async function pushSystemNotification(item) {
  const record = reason => {
    lastNotifyAttempt = { at: nowISO(), reason: reason };
    return false;
  };

  if (!notifyPrefs().enabled) return record("总开关关着");
  if (!notifyPrefs().system) return record("「系统通知」开关关着");
  if (getSetting("getui_push_registered", false)) {
    return record("已登记个推设备，系统通知由个推发送");
  }
  if (!item) return record("没有通知内容");

  /* 这里**故意没有** `if (!document.hidden) return false`。
     那行原来存在，作用是"前台不弹"——已按用户要求删掉。
     别再把它加回来。 */

  const bridge = notifyBridge();
  if (!bridge) return record("拿不到通知插件（浏览器里就是这样）");

  try {
    const permission = await bridge.checkPermissions();
    if (permission.display !== "granted") {
      return record("系统权限没给（当前：" + permission.display + "）");
    }
    await bridge.schedule({
      notifications: [{
        /* 立刻发。id 用时间戳取模，重复 id 会把前一条顶掉。 */
        id: Math.floor(Date.now() % 2147483647),
        title: item.title,
        body: item.body,
        /* **图标必须用一个真实存在的资源名。**

           我原来写了 "ic_stat_icon"——那是我打算建但没建的文件。
           Android 找不到资源会直接抛异常，通知发不出去，
           而应用内提示照常工作，所以现象是"开了系统通知但收不到"。

           ic_dialog_info 也不行：那是**平台内部**的资源，
           插件的 getResourceId 只在本 App 的 R 类里找，找不到。

           用 ic_launcher（一定存在，就是我们自己的图标）。
           等做了单色小图标再换成更好的。 */
        smallIcon: "ic_launcher",
        channelId: NOTIFY_CHANNEL_ID,
      }],
    });
    lastNotifyAttempt = { at: nowISO(), reason: "已发出", ok: true };
    return true;
  } catch (error) {
    /* **把异常原文记下来。**
       这里原来只 return false，插件抛什么错都看不到——
       而"图标资源名写错"那次的教训就是：异常里写得清清楚楚。 */
    return record("插件报错：" + String(error && error.message
      ? error.message : error).slice(0, 120));
  }
}

/* ---------------------------------------------------------- 入口 */

/* 同步之后调用：把新事件变成通知，刷新界面标记。

   **同步失败时不调用**——否则会把"没拉到新数据"误判成"没有新事件"，
   下次同步又会重复提醒。

   ## 顺序很重要

   先处理事件（其中"取消完成"会**撤销**对应的工时），
   再用**撤销之后剩下的**数据算工时汇总。

   反过来的话：员工在同一次同步里先完成又取消，
   那条工时已经撤了，但汇总还把它算进去——
   老板会看到"收到 1 条工时 2 小时"而看板上 0 条。
   **通知和数据不一致比不通知更糟。** */
async function pumpNotifications(options) {
  const opts = options || {};
  const profile = DB.profile;
  if (!profile) return { added: 0 };

  let added = [];

  /* 1. 先处理事件（含撤销工时） */
  let revoked = 0;
  if (opts.events) {
    /* 先数一遍会撤销多少，用来修正汇总的输入 */
    const before = (DB.remoteWorklogs || []).length;
    added = added.concat(ingestEvents(opts.events, profile.role));
    revoked = before - (DB.remoteWorklogs || []).length;
  }

  /* 2. 工时汇总（老板才关心）。
        把被撤销的那几条从输入里剔掉，免得汇总报出已经不存在的工时。 */
  if (profile.role === "boss" && opts.worklogs) {
    const alive = (DB.remoteWorklogs || []).map(row => String(row.id));
    const fresh = opts.worklogs.filter(row =>
      row && alive.indexOf(String(row.id)) !== -1);
    const summary = ingestWorklogSummary(fresh);
    if (summary) added.push(summary);
  }

  /* 3. 项目状态（本地比较，老板才有项目） */
  if (profile.role === "boss") {
    const projectNotes = ingestProjectStatus();
    if (projectNotes) added = added.concat(projectNotes);
  }

  if (added.length || revoked) {
    renderNotifyBadges();
    renderNotifyBanner("notify-banner-dash");
    renderNotifyBanner("notify-banner-tasks");
    /* 系统通知：前台也发（pushSystemNotification 里不再判断前台） */
    for (let i = 0; i < added.length; i += 1) {
      await pushSystemNotification(added[i]);
    }
  }
  return { added: added.length, items: added, revoked: revoked };
}
