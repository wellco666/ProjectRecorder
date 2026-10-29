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
     所以 App 被杀掉之后就收不到了——那种情况只有真正的
     推送服务（FCM）能解决。

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
  summary: { pref: "onWorklogSummary", icon: "⏱", label: "工时" },
  project: { pref: "onProjectStatus", icon: "📁", label: "项目" },
};

function notifyPrefs() {
  const prefs = DB.notifyPrefs || {};
  return Object.assign({}, emptyDatabase().notifyPrefs, prefs);
}

function saveNotifyPrefs(patch) {
  DB.notifyPrefs = Object.assign({}, notifyPrefs(), patch || {});
  _save();
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
    /* 员工不需要知道自己完成任务的回执；
       老板不需要知道任务是自己派的。 */
    if (role === "employee" && desc.kind !== "assigned") return;
    if (role === "boss" && desc.kind === "assigned") return;

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
  const more = fresh.length > 1
    ? `<span class="meta">　还有 ${fresh.length - 1} 条</span>` : "";
  box.innerHTML = `
    <div class="banner info notify-banner" data-notify-open="1">
      <b>${escapeHtml(latest.title)}</b>
      <div class="meta" style="margin-top:2px">
        ${escapeHtml(latest.body)}${more}
      </div>
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
    : '<div class="empty">还没有通知。<br>'
      + "老板派任务、员工完成任务时，这里会有记录。</div>";

  openSheet("通知", `
    <div class="meta" style="padding:0 0 10px">
      共 ${list.length} 条，保留最近 ${NOTIFY_KEEP} 条
    </div>
    <div class="chips" id="notify-prefs">
      <button class="chip${prefs.inApp ? " on" : ""}" data-pref="inApp">应用内提示</button>
      <button class="chip${prefs.system ? " on" : ""}" data-pref="system">系统通知</button>
      <button class="chip${prefs.onTaskAssigned ? " on" : ""}" data-pref="onTaskAssigned">新任务</button>
      <button class="chip${prefs.onTaskDone ? " on" : ""}" data-pref="onTaskDone">完成任务</button>
      <button class="chip${prefs.onTaskUndone ? " on" : ""}" data-pref="onTaskUndone">取消完成</button>
      <button class="chip${prefs.onWorklogSummary ? " on" : ""}" data-pref="onWorklogSummary">工时汇总</button>
      <button class="chip${prefs.onProjectStatus ? " on" : ""}" data-pref="onProjectStatus">项目状态</button>
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
const NOTIFY_CHANNEL_ID = "pr-alerts-v1";

/* ---------------------------------------------------------- FCM 推送 */

/* 本地通知只能在 WebView 还活着时工作。FCM 由 Android 系统直接展示，
   因此手机锁屏、App 在后台甚至 WebView 被挂起时仍能弹窗。 */
function pushBridge() {
  const cap = typeof window !== "undefined" ? window.Capacitor : null;
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins.PushNotifications) {
    return cap.Plugins.PushNotifications;
  }
  if (typeof cap.getPlugin === "function") {
    try { return cap.getPlugin("PushNotifications"); } catch (error) { }
  }
  return null;
}

async function savePushToken(token) {
  const value = String(token || "").trim();
  if (!value || !DB.profile || typeof cloudClient === "undefined" || !cloudClient) {
    return false;
  }
  DB.pushToken = value;
  DB.pushRegisteredAt = nowISO();
  _save();
  try {
    const result = await cloudClient.from("push_tokens").upsert({
      token: value, user_id: DB.profile.id, platform: "android", updated_at: nowISO(),
    }, { onConflict: "token" });
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    /* 下次登录/恢复会话时重试。 */
    return false;
  }
}

let pushListenersReady = false;
async function registerRemotePush() {
  const bridge = pushBridge();
  if (!bridge || !DB.profile) return { supported: false, granted: false };
  try {
    let permission = await bridge.checkPermissions();
    if (permission.receive !== "granted") permission = await bridge.requestPermissions();
    if (permission.receive !== "granted") return { supported: true, granted: false };

    if (!pushListenersReady) {
      pushListenersReady = true;
      await bridge.addListener("registration", event => savePushToken(event && event.value));
      await bridge.addListener("registrationError", error => {
        DB.pushRegistrationError = String(error && (error.error || error));
        _save();
      });
      await bridge.addListener("pushNotificationReceived", event => {
        /* FCM 前台消息不会自动出系统横幅，接回现有红点/通知中心。 */
        const data = event && event.data ? event.data : {};
        const kind = ["assigned", "done", "undone"].indexOf(data.kind) >= 0
          ? data.kind : "done";
        const item = addNotification({
          key: "push:" + String(data.event_id || event.id || Date.now()),
          kind: kind,
          title: String(event.title || data.title || "项目记录器"),
          body: String(event.body || data.body || "有新的项目消息"),
          task_id: data.task_id || null,
          employee_id: data.employee_id || null,
          at: nowISO(),
        });
        if (item) {
          renderNotifyBadges();
          renderNotifyBanner("notify-banner-dash");
          renderNotifyBanner("notify-banner-tasks");
        }
      });
      await bridge.addListener("pushNotificationActionPerformed", event => {
        if (typeof syncNow === "function") syncNow("push-open");
        const data = event && event.notification && event.notification.data;
        if (data && data.kind === "assigned" && typeof showPage === "function") {
          showPage("tasks");
        }
      });
    }
    await bridge.register();
    DB.notifyPermission = Object.assign({}, DB.notifyPermission || {}, {
      push: true, supported: true, granted: true,
    });
    _save();
    return { supported: true, granted: true };
  } catch (error) {
    DB.notifyPermission = Object.assign({}, DB.notifyPermission || {}, {
      push: false, supported: true, granted: false,
      error: String(error.message || error),
    });
    _save();
    return { supported: true, granted: false, error: error.message };
  }
}

/* 建通知渠道（幂等）。

   **Android 8 以后必须有渠道，否则通知不出横幅。**

   没有渠道的表现：通知照样进通知栏，但不响、不震、不弹横幅，
   只静静躺在下拉栏里——用户根本注意不到，看起来就是"没通知"。

   渠道的重要级别**建好就固定**，改代码里的 importance
   不会更新已存在的渠道。所以名字带版本号：要调级别就换名字。 */
async function ensureNotifyChannel() {
  const bridge = notifyBridge();
  if (!bridge || typeof bridge.createChannel !== "function") return false;
  try {
    await bridge.createChannel({
      id: NOTIFY_CHANNEL_ID,
      name: "任务提醒",
      description: "派任务、完成任务、工时汇总",
      /* importance 4 = HIGH，会弹出横幅 */
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
    });
    return true;
  } catch (error) {
    /* 建渠道失败不该影响功能，大不了退回无横幅的通知 */
    return false;
  }
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
async function pushSystemNotification(item) {
  if (!notifyPrefs().enabled || !notifyPrefs().system) return false;
  if (!item) return false;

  /* 这里**故意没有** `if (!document.hidden) return false`。
     那行原来存在，作用是"前台不弹"——已按用户要求删掉。
     别再把它加回来。 */

  const bridge = notifyBridge();
  if (!bridge) return false;

  try {
    const permission = await bridge.checkPermissions();
    if (permission.display !== "granted") return false;
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
    return true;
  } catch (error) {
    return false;
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
