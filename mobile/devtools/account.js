/* =============================================================
   账号界面

   三块东西：
     1. 登录页       —— 老板用手机号、员工用工号
     2. 员工任务页   —— 今日任务，勾选即上报
     3. 账号管理     —— 老板建员工账号、派任务

   ## 设计原则

   **没登录也能用本机的功能**。所以登录页上有一个
   「先不登录，只用本机功能」——否则老用户升级后
   会被一个用不上的登录页挡在外面，本机数据还在却打不开。

   登录状态存在本地（DB.profile），所以**离线也能进主界面**：
   没网时不能把人挡在门外。
   ============================================================= */
"use strict";

/* ---------------------------------------------------------- 登录页 */

/* 当前选的身份。老板用手机号，员工用工号，两套账号在服务端
   是分开的（不同的内部邮箱后缀），所以必须让用户明确选。 */
let loginRole = "boss";

function renderLogin() {
  /* 身份切换按钮：**在渲染时就绑定**，不依赖 bindGlobalEvents。

     为什么绑定放在这里：
       原来绑定只在启动时做一次（bindGlobalEvents 里用 onclick=）。
       那样一旦有任何路径把登录页重新渲染、或者启动顺序变了，
       按钮就成了死按钮——点了没反应，而且不报错。
       放在渲染函数里，保证"画出来的按钮一定能点"。

     用 pointerdown 而不是 click：
       它同时覆盖触摸和鼠标，在安卓 WebView 里响应也更及时。
       同时保留 click 作为兜底，用一个标志位防止两边都触发。 */
  const roleBox = $("login-role");
  if (roleBox) {
    const buttons = roleBox.querySelectorAll("[data-role]");
    buttons.forEach(button => {
      let handled = false;
      const pick = event => {
        if (event) event.preventDefault();
        handled = true;
        loginRole = button.dataset.role;
        renderLogin();
      };
      button.onpointerdown = pick;
      button.onclick = event => {
        if (handled) { handled = false; return; }
        pick(event);
      };
    });
    buttons.forEach(button => {
      button.classList.toggle("on", button.dataset.role === loginRole);
    });
  }

  /* label 跟着身份变——这样一眼就知道该填什么 */
  $("login-code-label").textContent =
    loginRole === "boss" ? "手机号" : "工号";

  const config = syncStatus();
  const box = $("login-cloud");
  if (!config.hasLibrary) {
    /* 这个必须说——云库没打包进去，谁都登不上 */
    box.innerHTML = '<div class="banner warn">云组件没加载上。'
      + '先跑 <b>node fetch-vendor.js</b> 下载，然后重新打包。</div>';
  } else if (!config.configured) {
    /* **没配好时也要说，但不再提"点下面云服务设置"**——
       那个按钮已经删掉了。所以这里直接把配置界面打开，
       而不是让用户去找一个不存在的按钮。 */
    box.innerHTML = '<div class="banner warn">'
      + '这台设备还没配好服务器，登录用不了。</div>';
    const setup = document.createElement("button");
    setup.className = "btn ghost";
    setup.style.width = "100%";
    setup.textContent = "填写服务器地址";
    setup.onclick = () => openCloudSettings();
    box.appendChild(setup);
  } else {
    box.innerHTML = "";
  }

  /* 已经登录过的话，登录页显示"继续使用"而不是重新输密码 */
  const profile = DB.profile;
  if (profile) {
    $("login-form").classList.add("hidden");
    $("login-resume").classList.remove("hidden");
    $("login-resume-name").textContent =
      `${profile.name}（${profile.role === "boss" ? "老板" : "员工"}）`;
  } else {
    $("login-form").classList.remove("hidden");
    $("login-resume").classList.add("hidden");
  }
}

/* 登录。失败时把原因显示在按钮上方，不要只弹一个 toast——
   密码错和"没配云服务"要让人分得清。 */
async function doLogin() {
  const code = $("login-code").value;
  const password = $("login-password").value;
  if (!String(code).trim()) {
    setLoginError("请填" + $("login-code-label").textContent);
    return;
  }
  if (!password) { setLoginError("请填密码"); return; }

  setLoginError("");
  const button = $("btn-login");
  button.disabled = true;
  button.textContent = "登录中…";
  try {
    /* **按选的身份登，但选错了也能进去。**

       界面上的「我是老板 / 我是员工」是为了让人一眼看清身份，
       不该变成"选错就登不上"的陷阱。所以：
         · 先按选的身份试一次
         · 不行再按另一种试一次（在 cloudLogin 里做） */
    const profile = await cloudLogin(code, password,
      loginRole === "employee");
    if (!profile) throw new Error("登录成功但读不到账号资料，联系管理员");
    finishLogin();
  } catch (error) {
    setLoginError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "登录";
  }
}

/* 忘了密码怎么办。

   **这是"死局"的出口。** 以前忘了密码只能去 Supabase 后台，
   手机上根本没办法。

   分两种情况，按身份给不同出路：
     员工  → 找老板，老板能在 App 里重置（员工账号 → 重置密码）
     老板  → 如果还有另一台登着的设备，在那台上改；
            否则只能跑 SQL（sql/rename-boss.sql 里有重置的写法）

   为什么不在这里直接"重置"：那需要给匿名请求改任意账号密码的权限，
   等于谁都能改任何人的密码。**这条路不能开。** */
function openForgotPassword() {
  openSheet("忘了密码", `
    <div id="forgot-error" class="login-error hidden"></div>
    <label for="fp-code">你的手机号或工号</label>
    <input id="fp-code" autocapitalize="off">

    <label for="fp-new">想换成的新密码</label>
    <input id="fp-new" type="password">

    <label for="fp-old">旧密码（记得就填）</label>
    <input id="fp-old" type="password">

    <div class="hint" style="margin-top:8px">
      <b>员工</b>：让老板重置 ——「团队 → 员工账号」→ 点你名字 → 重置密码<br>
      <b>老板</b>：在另一台登着的手机上改（「我的 → 修改密码」）
    </div>
  `, [
    { label: "关闭", onClick: closeSheet },
    { label: "改密码", kind: "", onClick: () => submitForgotPassword() },
  ]);
}

async function submitForgotPassword() {
  const box = $("forgot-error");
  box.classList.add("hidden");
  const code = $("fp-code").value;
  const newPassword = $("fp-new").value;
  const oldPassword = $("fp-old").value;

  if (!String(code).trim()) {
    box.textContent = "请填手机号或工号";
    box.classList.remove("hidden");
    return;
  }
  if (String(newPassword).length < 6) {
    box.textContent = "新密码至少要 6 位";
    box.classList.remove("hidden");
    return;
  }
  if (!oldPassword) {
    box.textContent = "请填上你现在还记得的旧密码。\n\n"
      + "完全不记得的话：员工找老板重置，"
      + "老板用另一台登着的设备改。";
    box.classList.remove("hidden");
    return;
  }

  const buttons = $("sheet-foot").querySelectorAll(".btn");
  const submit = buttons[buttons.length - 1];
  if (submit) { submit.disabled = true; submit.textContent = "处理中…"; }
  try {
    /* 用"旧密码 + 新密码"直接登录一次并改掉。
       走的是和登录一样的自动判断身份。 */
    await cloudLogin(code, oldPassword);
    await changeMyPassword(oldPassword, newPassword);
    closeSheet();
    finishLogin();
    toast("密码已改，已经用新密码登录");
  } catch (error) {
    box.textContent = error.message;
    box.classList.remove("hidden");
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "改密码"; }
  }
}

function setLoginError(message) {
  const box = $("login-error");
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
}

/* 登录成功后的统一收尾 */
function finishLogin() {
  $("login-password").value = "";
  applyRoleUI();
  startSyncLoop();
  if (typeof registerRemotePush === "function") registerRemotePush();
  /* 登录时顺手确认一次系统通知权限。
     放在这里而不是 App 启动时：那时用户还没进入任何身份，
     弹权限框最容易被拒绝。 */
  refreshNotifyPermission().then(() => renderMe());
  /* 立刻同步一次：员工需要马上看到今天的任务 */
  syncNow("login");
  showPage(DB.profile && DB.profile.role === "employee" ? "tasks" : "dash");
  refreshSyncBadge();
}

/* 重启后恢复上次登录 */
function resumeSession() {
  applyRoleUI();
  startSyncLoop();
  if (typeof registerRemotePush === "function") registerRemotePush();
  refreshNotifyPermission().then(() => renderMe());
  syncNow("resume");
}

function logout() {
  if (!confirm("退出登录？\n\n本机自己记的项目和工时不会丢，"
      + "只是要重新登录才能看到员工报上来的数据。")) return;
  stopSyncLoop();
  cloudLogout().then(() => {
    applyRoleUI();
    closeSheet();
    showPage("login");
    toast("已退出登录");
  });
}

/* ---------------------------------------------------------- 角色 */
/* 按登录身份调整界面。

   员工**看不到**项目、看板、习惯这些东西——那是老板的视角。
   让员工看到一堆自己用不上的按钮只会让人困惑。 */
function applyRoleUI() {
  const profile = DB.profile;
  const isStaff = !!(profile && profile.role === "employee");

  /* 底部导航：员工两个，老板四个。
     两边最后一项都是「我的」——退出登录、云服务设置在那里。 */
  $("nav-staff").classList.toggle("hidden", !isStaff);
  $("nav-boss").classList.toggle("hidden", isStaff);

  /* 员工进任务页而不是看板 */
  if (isStaff && !$("page-tasks").classList.contains("hidden")) {
    /* 已经停在任务页就不用动 */
  }

  refreshSyncBadge();
}

/* 顶部的同步状态小标签。

   **必须让用户看得见同步状态**：
     员工勾完任务如果没上传成功，他会以为报上去了，
     老板那边却没收到。这种"静默失败"最难查。 */
function refreshSyncBadge() {
  const status = syncStatus();
  const nodes = document.querySelectorAll(".sync-badge");
  let text = "";
  let kind = "";

  if (!status.configured || !status.hasLibrary) {
    text = "单机";
    kind = "off";
  } else if (!status.signedIn) {
    text = "未登录";
    kind = "off";
  } else if (status.busy) {
    text = "同步中…";
    kind = "";
  } else if (status.last && status.last.ok === false) {
    /* **同步失败要显眼**。原来这里只显示"待上传 N 条"，
       看起来像"网络慢一点"，实际可能是被服务端一直拒绝——
       用户以为报上去了，老板那边什么都没有。 */
    text = "同步失败";
    kind = "bad";
  } else if (status.pending > 0) {
    text = `待上传 ${status.pending}`;
    kind = "warn";
  } else if (!status.online) {
    text = "离线";
    kind = "off";
  } else if (status.last && status.last.at) {
    text = "已同步";
    kind = "ok";
  } else {
    text = "已登录";
    kind = "";
  }

  /* 失败时把原因也挂到 title 上，长按/悬停能看到具体错误 */
  nodes.forEach(node => {
    node.textContent = text;
    node.className = "sync-badge " + kind;
    node.title = (status.last && status.last.message) || "";
  });
}

/* ---------------------------------------------------------- 员工任务页 */

function renderTasks() {
  const today = todayISO();
  const tasks = tasksOn(today);
  const done = tasks.filter(task => taskLogFor(task.id)).length;

  $("tasks-sub").textContent = tasks.length
    ? `今天 ${done}/${tasks.length} 条完成`
    : "今天还没有任务";

  const row = $("tasks-list");
  if (!tasks.length) {
    row.innerHTML = '<div class="empty">今天没有派给你的任务。<br>'
      + "老板派了任务之后，这里会自动出现。</div>";
    renderTaskHistory();
    refreshSyncBadge();
    return;
  }

  row.innerHTML = tasks.map(task => {
    const log = taskLogFor(task.id);
    const isDone = !!log;
    const started = !!task.started_at;
    /* 按钮状态用文字说清楚，不要只靠颜色——
       员工看不懂"灰的能不能点"。 */
    let action = "完成";
    if (isDone) action = "已完成";
    else if (started) action = "完成";

    return `
      <div class="card task ${isDone ? "done" : ""}">
        <div class="task-main">
          <button class="task-check ${isDone ? "on" : ""}"
                  data-task-check="${task.id}"
                  aria-label="${isDone ? "取消完成" : "标记完成"}">
            <span>${isDone ? "✓" : ""}</span>
          </button>
          <div class="task-body">
            <div class="task-title">${escapeHtml(task.title)}</div>
            ${task.detail
              ? `<div class="meta">${escapeHtml(task.detail)}</div>` : ""}
            <div class="meta">
              ${task.project_name
                ? escapeHtml(task.project_name) + " · " : ""}
              ${num(task.est_hours) > 0
                ? "预估 " + num(task.est_hours) + " 小时 · " : ""}
              ${isDone
                ? "完成于 " + escapeHtml(String(log.finished_at).slice(11, 16))
                : (started ? "计时中" : "未开始")}
            </div>
          </div>
        </div>
        ${isDone ? "" : `
          <div class="btn-row" style="margin-top:10px">
            <button class="btn ghost" data-task-start="${task.id}"
                    ${started ? "disabled" : ""}>
              ${started ? "已开始（" + escapeHtml(String(task.started_at).slice(11, 16)) + "）" : "开始"}
            </button>
            <button class="btn" data-task-done="${task.id}">${action}</button>
          </div>`}
      </div>`;
  }).join("");

  document.querySelectorAll("[data-task-start]").forEach(button => {
    button.onclick = () => {
      try {
        startTask(NumberOrString(button.dataset.taskStart));
        renderTasks();
        toast("已开始计时");
      } catch (error) { toast(error.message); }
    };
  });

  document.querySelectorAll("[data-task-done], [data-task-check]").forEach(button => {
    button.onclick = () => {
      const id = NumberOrString(button.dataset.taskDone
        || button.dataset.taskCheck);
      const task = taskById(id);
      if (!task) { toast("这条任务已经不存在了"); return; }
      try {
        if (taskLogFor(id)) {
          /* 取消完成。要问一下——员工可能只是手滑点错了 */
          if (!confirm(`取消「${task.title}」的完成状态？\n\n`
              + "报上去的工时也会一起撤掉。")) return;
          uncompleteTask(id);
          toast("已取消");
        } else {
          completeTask(task);
          if (navigator.vibrate) navigator.vibrate(16);
          toast("已上报，老板那边会自动收到");
        }
      } catch (error) {
        toast(error.message);
      }
      renderTasks();
      refreshSyncBadge();
    };
  });

  renderTaskHistory();
  refreshSyncBadge();
}

/* 最近几天完成的任务。给员工一个"我报过什么"的回看入口——
   没有这个的话，员工会怀疑自己的记录到底有没有上去。 */
function renderTaskHistory() {
  const today = todayISO();
  const logs = (DB.taskLogs || []).filter(log => log.finish_date !== today)
    .sort((a, b) => String(b.finish_date).localeCompare(String(a.finish_date)))
    .slice(0, 15);
  const box = $("tasks-history");
  if (!logs.length) { box.innerHTML = ""; return; }

  box.innerHTML = `
    <div class="section-head"><span>之前报过的</span></div>
    <div class="card">
      ${logs.map(log => {
        const task = taskById(log.task_id);
        return `<div class="row" style="margin-top:6px">
          <div class="grow meta">${escapeHtml(log.finish_date)} ·
            ${escapeHtml(task ? task.title : "（任务已删除）")}</div>
          <span class="meta">已上报</span>
        </div>`;
      }).join("")}
    </div>`;
}

/* 任务的 id 是 uuid 字符串，但员工端可能拿到本地生成的 id。
   两种都要能用，不能强转成 Number——uuid 转数字会变 NaN。 */
function NumberOrString(value) {
  const text = String(value);
  return /^\d+$/.test(text) ? Number(text) : text;
}

/* ---------------------------------------------------------- 老板自助注册 */

/* 注册表单。

   **每个老板都能建自己的账号，各自独立**——不是"只允许一个"。
   两个老板用同一个手机号时，服务端会自动加数字后缀，
   这里必须把最终登录名告诉用户，否则他下次登录会登不上。 */
function openBossRegister() {
  openSheet("创建老板账号", `
    <label for="rg-name">怎么称呼你 *</label>
    <input id="rg-name">

    <label for="rg-phone">手机号（登录用）*</label>
    <input id="rg-phone" inputmode="text" autocapitalize="off">
    <div class="hint" style="margin-top:4px">
      字母、数字和 <code>. _ -</code>，3~20 位，不要中文或空格。
      被别人用了会自动加数字后缀，建好会告诉你最终登录名。
    </div>

    <label for="rg-password">密码 *</label>
    <input id="rg-password" type="password">

    <div id="rg-error" class="login-error hidden"></div>
  `, [
    { label: "取消", onClick: closeSheet },
    { label: "创建并登录", kind: "", onClick: () => submitBossRegister() },
  ]);
}

async function submitBossRegister() {
  const box = $("rg-error");
  box.classList.add("hidden");

  const buttons = $("sheet-foot").querySelectorAll(".btn");
  const submit = buttons[buttons.length - 1];
  if (submit) { submit.disabled = true; submit.textContent = "创建中…"; }

  try {
    const result = await registerBoss({
      name: $("rg-name").value,
      phone: $("rg-phone").value,
      password: $("rg-password").value,
    });
    closeSheet();
    finishLogin();

    /* **重名时一定要说清楚最终登录名**，
       否则用户下次拿原来填的那个名字试，会登不上。 */
    if (result.renamed) {
      toast("账号建好了。这个号已经被用了，你的登录名是 "
        + result.code);
    } else {
      toast("账号建好了，已登录："
        + (result.profile ? result.profile.name : ""));
    }
  } catch (error) {
    /* **错误要显示在表单里，不能只弹气泡**。
       注册失败的原因（手机号格式不对、密码太短）
       用户要能停下来看清楚再改。 */
    box.textContent = error.message;
    box.classList.remove("hidden");
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "创建并登录"; }
  }
}

/* ---------------------------------------------------------- 账号管理 */

/* 改密码。

   验旧密码是**必做的**：Supabase 的 updateUser 不需要旧密码，
   不自己验的话，谁拿到这台手机就能改密码。 */
function openChangePassword() {
  openSheet("修改密码", `
    <label for="cp-old">现在的密码</label>
    <input id="cp-old" type="password">

    <label for="cp-new">新密码</label>
    <input id="cp-new" type="password">

    <label for="cp-new2">再输一次新密码</label>
    <input id="cp-new2" type="password">

    <div id="cp-error" class="login-error hidden"></div>
  `, [
    { label: "取消", onClick: closeSheet },
    { label: "改密码", kind: "", onClick: () => submitChangePassword() },
  ]);
}

async function submitChangePassword() {
  const box = $("cp-error");
  box.classList.add("hidden");
  const oldPassword = $("cp-old").value;
  const newPassword = $("cp-new").value;
  const again = $("cp-new2").value;

  const fail = message => {
    box.textContent = message;
    box.classList.remove("hidden");
  };

  if (!oldPassword) return fail("请填现在的密码");
  if (String(newPassword).length < 6) return fail("新密码至少要 6 位");
  if (newPassword !== again) return fail("两次输入的新密码不一样");

  const buttons = $("sheet-foot").querySelectorAll(".btn");
  const submit = buttons[buttons.length - 1];
  if (submit) { submit.disabled = true; submit.textContent = "修改中…"; }
  try {
    await changeMyPassword(oldPassword, newPassword);
    closeSheet();
    toast("密码已改，下次登录用新密码");
  } catch (error) {
    fail(error.message);
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "改密码"; }
  }
}

/* 改登录名（老板的手机号 / 员工的工号）。 */
function openChangeLogin() {
  const profile = DB.profile;
  const isBoss = !!(profile && profile.role === "boss");
  const label = isBoss ? "手机号" : "工号";

  openSheet("改" + label, `
    <label for="cl-new">新的${label}</label>
    <input id="cl-new" autocapitalize="off"
           value="${escapeHtml(profile ? profile.code : "")}">
    <div class="hint" style="margin-top:4px">
      字母、数字和 <code>. _ -</code>，3~20 位，不要中文或空格。
      改完下次登录用新${label}，密码不变。
    </div>
    <div id="cl-error" class="login-error hidden"></div>
  `, [
    { label: "取消", onClick: closeSheet },
    { label: "保存", kind: "", onClick: () => submitChangeLogin() },
  ]);
}

async function submitChangeLogin() {
  const box = $("cl-error");
  box.classList.add("hidden");
  const buttons = $("sheet-foot").querySelectorAll(".btn");
  const submit = buttons[buttons.length - 1];
  if (submit) { submit.disabled = true; submit.textContent = "保存中…"; }
  try {
    const code = await changeMyLogin($("cl-new").value);
    closeSheet();
    renderMe();
    toast("登录名已改成 " + code);
  } catch (error) {
    box.textContent = error.message;
    box.classList.remove("hidden");
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "保存"; }
  }
}

/* 注销账号。**两段确认 + 验密码**——这是不可恢复的操作。 */
function openDeleteAccount() {
  const profile = DB.profile;
  const isBoss = !!(profile && profile.role === "boss");
  openSheet("注销账号", `
    <div class="banner bad">
      不能撤销。云端这个账号${isBoss ? "和你名下所有员工" : ""}
      的任务、工时都会被永久删除。
    </div>
    ${isBoss
      ? '<div class="hint" style="margin-top:0">你的员工还在用的话，'
        + "他们会一起被删掉。</div>"
      : ""}

    <label for="da-password">输入密码确认</label>
    <input id="da-password" type="password">

    <label for="da-confirm">再输入一遍这个字：<b>注销</b></label>
    <input id="da-confirm" autocapitalize="off">

    <div id="da-error" class="login-error hidden"></div>
  `, [
    { label: "取消", onClick: closeSheet },
    { label: "永久注销", kind: "danger", onClick: () => submitDeleteAccount() },
  ]);
}

async function submitDeleteAccount() {
  const box = $("da-error");
  box.classList.add("hidden");
  const fail = message => {
    box.textContent = message;
    box.classList.remove("hidden");
  };

  if ($("da-confirm").value.trim() !== "注销") {
    return fail("请把「注销」两个字照着输一遍");
  }
  const password = $("da-password").value;
  if (!password) return fail("请输入密码");

  const buttons = $("sheet-foot").querySelectorAll(".btn");
  const submit = buttons[buttons.length - 1];
  if (submit) { submit.disabled = true; submit.textContent = "注销中…"; }
  try {
    await deleteMyAccount(password);
    closeSheet();
    renderLogin();
    showPage("login");
    toast("账号已注销");
  } catch (error) {
    fail(error.message);
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "永久注销"; }
  }
}

/* 老板重置员工的密码。
   员工忘了密码时唯一的出路——以前只能去 Supabase 后台。 */
function openResetStaffPassword(account) {
  openSheet("重置 " + account.name + " 的密码", `
    <label for="rp-new">新的初始密码</label>
    <input id="rp-new" value="${escapeHtml(account.password || "")}">
    <div class="hint" style="margin-top:4px">
      不需要旧密码。改完把新密码告诉他。
    </div>

    <div id="rp-error" class="login-error hidden"></div>
  `, [
    { label: "取消", onClick: closeSheet },
    { label: "重置", kind: "", onClick: () => submitResetStaffPassword(account) },
  ]);
}

async function submitResetStaffPassword(account) {
  const box = $("rp-error");
  box.classList.add("hidden");
  const newPassword = $("rp-new").value;
  if (String(newPassword).length < 6) {
    box.textContent = "密码至少要 6 位";
    box.classList.remove("hidden");
    return;
  }

  const buttons = $("sheet-foot").querySelectorAll(".btn");
  const submit = buttons[buttons.length - 1];
  if (submit) { submit.disabled = true; submit.textContent = "重置中…"; }
  try {
    await resetStaffPassword(account.employee_id, newPassword);
    closeSheet();
    renderStaff();
    toast("已重置。" + account.name + " 现在用 "
      + newPassword + " 登录");
  } catch (error) {
    box.textContent = error.message;
    box.classList.remove("hidden");
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "重置"; }
  }
}

/* ---------------------------------------------------------- 老板：员工账号 */

function renderStaff() {
  const list = staffAccounts();
  const box = $("staff-list");
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有员工账号。<br>'
      + "点右上「+ 账号」建一个，把工号和密码给员工。</div>";
    updateStaffRetryButton();
    return;
  }
  const employeesById = {};
  (DB.employees || []).forEach(item => {
    employeesById[String(item.id)] = item;
  });

  box.innerHTML = list.map(account => {
    /* 两种状态要说清楚，别让老板猜：
         pending  → 云端没建成（附原因）
         否则      → 已生效，员工可以登录 */
    const statusLine = account.pending
      ? '<div class="meta" style="color:var(--watch)">云端没建成'
        + (account.lastError ? "：" + escapeHtml(account.lastError) : "")
        + "</div>"
      : '<div class="meta" style="color:var(--ok)">已生效，可以登录'
        + (account.lastNote ? "（" + escapeHtml(account.lastNote) + "）" : "")
        + "</div>";
    return `
      <div class="card">
        <div class="row">
          <div class="grow">
            <b>${escapeHtml(account.name)}</b>
            <div class="meta">工号 ${escapeHtml(account.code)}</div>
            ${statusLine}
          </div>
          <button class="icon-btn" data-staff-edit="${account.id}">查看</button>
        </div>
      </div>`;
  }).join("");

  box.querySelectorAll("[data-staff-edit]").forEach(button => {
    button.onclick = () => {
      const account = staffAccounts().find(item =>
        item.id === button.dataset.staffEdit);
      if (account) editStaff(account);
    };
  });

  updateStaffRetryButton();
}

/* 还有账号没建成功时，把"重试创建"按钮点亮并显示数量。
   都建好了就禁用——点了没反应比按钮变灰更让人困惑。 */
function updateStaffRetryButton() {
  const button = $("btn-sync-staff");
  if (!button) return;
  const pending = staffAccounts().filter(item => item.pending).length;
  button.textContent = pending
    ? `重试创建（还有 ${pending} 个没建成功）`
    : "全部已在云端生效";
  button.disabled = pending === 0;

  /* **说明只在需要时出现。**

     原来页面上常驻三段解释（"建号是一次完成的""这个按钮只在没网时
     有用""密码明文存在本机"）——正常使用时一个都不需要。
     现在只有真有账号没建成时才写一句，而且就说"怎么办"。 */
  const hint = $("staff-retry-hint");
  if (hint) {
    hint.innerHTML = pending
      ? "这几个账号是在<b>没网的时候</b>建的，云端还没有。"
        + "连上网点上面这个按钮补齐。"
      : "";
  }
}

function editStaff(account) {
  const employee = (DB.employees || []).find(item =>
    String(item.id) === String(account.employee_id));
  openSheet("员工账号", `
    <label>姓名</label>
    <div class="meta" style="padding:6px 0">${escapeHtml(account.name)}</div>
    <label>工号（登录用）</label>
    <div class="meta" style="padding:6px 0">${escapeHtml(account.code)}</div>
    <label>密码</label>
    <div class="meta" style="padding:6px 0">${escapeHtml(account.password)}</div>
    <label>云端状态</label>
    <div class="meta" style="padding:6px 0">
      ${account.pending
        ? "没建成" + (account.lastError
            ? "：" + escapeHtml(account.lastError) : "")
        : "已生效（" + escapeHtml(String(account.cloud_id || "").slice(0, 8))
          + "…）"}
    </div>
    <div class="hint">
      告诉员工：工号 <b>${escapeHtml(account.code)}</b>，密码
      <b>${escapeHtml(account.password)}</b>。
    </div>
  `, [
    { label: "关闭", onClick: closeSheet },
    /* **重置密码**：员工忘了密码时唯一的出路。
       以前只能去 Supabase 后台，手机上办不到。 */
    ...(!account.pending ? [{ label: "重置密码", kind: "", onClick: () => {
      closeSheet();
      openResetStaffPassword(account);
    } }] : []),
    ...(account.pending ? [{ label: "重试创建", kind: "", onClick: async () => {
      const ok = await createCloudStaff(account);
      closeSheet();
      renderStaff();
      toast(ok ? "创建成功，员工现在可以登录了"
               : "还是失败：" + (account.lastError || ""));
    } }] : []),
    ...(employee ? [{ label: "删除员工", kind: "danger", onClick: () => {
      if (!confirm(`删除 ${account.name}？\n\n`
          + "本机的员工记录和工时会一起删掉。\n"
          + "云端的账号要用「注销账号」或者去 Supabase 后台删。")) return;
      DB.staffAccounts = staffAccounts().filter(item => item.id !== account.id);
      deleteEmployee(employee.id);
      closeSheet();
      renderStaff();
      toast("已删除");
    } }] : []),
  ]);
}

/* ---------------------------------------------------------- 老板：派任务 */

function renderAssign() {
  const date = $("assign-date").value || todayISO();
  $("assign-date").value = date;
  /* 上一次的选中值失效了吗（员工被重建、uuid 变了）。
     用来在下面提示"请重新选一次"。 */
  let staleSelection = false;

  /* 人员下拉。

     **只列有云端账号的员工。**

     没有云端账号的员工（建号那步失败，employee_id 还是本地自增数字）
     派任务会被 assignTask 拒绝，因为那个数字不是 uuid。
     与其让人选完再报错，不如**根本不列出来**——
     并告诉老板去哪儿把号建好。 */
  const employeeSelect = $("assign-employee");
  const all = staffAccounts();
  const staff = all.filter(account =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(String(account.employee_id)));
  const notReady = all.length - staff.length;

  if (!all.length) {
    employeeSelect.innerHTML = '<option value="">先建员工账号</option>';
  } else if (!staff.length) {
    employeeSelect.innerHTML =
      '<option value="">员工还没在云端建号</option>';
  } else {
    /* **按工号排序，而且重建后要确认选中值还在。**

       ## 为什么必须检查

       `employeeSelect.value = current` 只在 current **确实存在于
       新列表里**时才生效。employee_id 变化时（createCloudStaff
       就会把它从本地数字换成 uuid）current 匹配不到任何一项，
       浏览器把它设成"未选中" → **select 自动回到第一项**。

       用户反馈过："给别人发任务，结果发到我自己的员工号上了"——
       就是这么来的。任务静默派给了列表里的第一个人。

       assignTask 里已经加了兜底校验（不在名单里就拒绝），
       这里再做一层：**检测到选中值失效就清空选择**，
       让用户必须重新选一次，而不是默默换成别人。 */
    const current = employeeSelect.value;
    const sorted = staff.slice().sort((a, b) =>
      String(a.code).localeCompare(String(b.code)));
    employeeSelect.innerHTML = sorted.map(account =>
      `<option value="${escapeHtml(String(account.employee_id))}">`
      + `${escapeHtml(account.name)}（${escapeHtml(account.code)}）</option>`
    ).join("");

    if (current && sorted.some(item =>
        String(item.employee_id) === String(current))) {
      employeeSelect.value = current;
    } else {
      /* 选中值失效（或者本来就没选）→ 明确清空，
         并在下面提示一句。**不要让它悄悄变成第一个人。** */
      employeeSelect.value = "";
      staleSelection = !!current;
    }
  }

  /* 提示条：把"名单有变化"和"有员工没建号"都说清楚。

     **选中失效必须明确提示。** 不提示的话，下拉会停在第一项，
     用户以为是刚才选的那个人——**这就是"派错人"的发生方式**。 */
  const warnBox = $("assign-warn");
  if (warnBox) {
    const lines = [];
    if (staleSelection) {
      lines.push("员工名单刚更新过，<b>请重新选一次「派给谁」</b>。");
    }
    if (notReady) {
      lines.push("有 " + notReady + " 个员工还没在云端建号，派不了任务。"
        + "去「团队 → 员工账号」点「重试创建」。");
    }
    warnBox.innerHTML = lines.length
      ? '<div class="banner warn">' + lines.join("<br>") + "</div>"
      : "";
  }

  /* 项目下拉（可选，用来把工时归到项目上） */
  const projectSelect = $("assign-project");
  projectSelect.innerHTML = '<option value="">不关联项目</option>'
    + (DB.projects || []).map(project =>
        `<option value="${escapeHtml(project.name)}">`
        + `${escapeHtml(project.name)}</option>`).join("");

  renderAssignList(date);
}

function renderAssignList(date) {
  const tasks = (DB.tasks || []).filter(item => item.plan_date === date)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const box = $("assign-list");
  if (!tasks.length) {
    box.innerHTML = '<div class="meta">这一天还没有任务。</div>';
    return;
  }
  const nameById = {};
  staffAccounts().forEach(account => { nameById[account.employee_id] = account.name; });
  (DB.employees || []).forEach(item => {
    if (!nameById[item.id]) nameById[item.id] = item.name;
  });

  box.innerHTML = tasks.map(task => `
    <div class="list-item">
      <div class="row">
        <div class="grow">
          <b>${escapeHtml(task.title)}</b>
          <div class="meta">
            ${escapeHtml(nameById[task.employee_id] || "未知")}
            ${num(task.est_hours) > 0 ? " · 预估 " + num(task.est_hours) + " 小时" : ""}
            ${task.project_name ? " · " + escapeHtml(task.project_name) : ""}
          </div>
        </div>
        <button class="icon-btn" data-assign-del="${escapeHtml(String(task.id))}">删</button>
      </div>
    </div>`).join("");

  box.querySelectorAll("[data-assign-del]").forEach(button => {
    button.onclick = () => {
      if (!confirm("删掉这条任务？员工那边也会消失。")) return;
      deleteTask(button.dataset.assignDel);
      renderAssignList(date);
      toast("已删除");
    };
  });
}

function submitAssign() {
  try {
    /* 记住派给谁了——**成功提示里要说出来**。

       原来只提示"已派发，员工登录后会看到"，
       万一选错了人，用户完全看不出来。现在把名字报出来，
       选错的话自己就发现了。 */
    const employeeId = $("assign-employee").value;
    const account = staffAccounts().find(item =>
      String(item.employee_id) === String(employeeId));

    assignTask({
      title: $("assign-title").value,
      detail: $("assign-detail").value,
      employee_id: employeeId,
      plan_date: $("assign-date").value || todayISO(),
      est_hours: $("assign-hours").value,
      project_name: $("assign-project").value,
    });
    $("assign-title").value = "";
    $("assign-detail").value = "";
    renderAssignList($("assign-date").value || todayISO());
    toast(account
      ? "已派给 " + account.name + "（" + account.code + "）"
      : "已派发，员工登录后会看到");
  } catch (error) {
    toast(error.message);
  }
}

/* ---------------------------------------------------------- 老板：建员工账号 */

/* 新建员工账号。

   现在**一次就建好了**：走数据库函数 `create_staff_account`，
   它建号 + 认领 + 同步 id 全部在服务端完成。

   （以前要在 Supabase 后台手动建一遍再来认领，因为客户端的
     signUp 会把老板自己顶下线。用 SECURITY DEFINER 函数绕过了
     那个限制，同时不用把管理密钥打进 apk。） */
function editNewStaff() {
  openSheet("新建员工账号", `
    <label for="st-name">员工姓名 *</label>
    <input id="st-name">
    <div class="row2">
      <div><label for="st-code">登录工号 *</label>
        <input id="st-code" autocapitalize="off"></div>
      <div><label for="st-password">初始密码 *</label>
        <input id="st-password"></div>
    </div>
    <div class="row2">
      <div><label for="st-role">岗位</label>
        <input id="st-role"></div>
      <div><label for="st-weekly">周工时</label>
        <input id="st-weekly" type="number" value="40"></div>
    </div>
    <div class="hint">
      建好之后告诉员工这三样：<b>工号、密码、App 里的「我是员工」</b>。
      <br><br>
      他装同一个 apk，选「我是员工」，用工号登录就能看到你派的任务。
      <br><br>
      没网也能建——会先存在本机，联网后点一下「重试创建」就补上了。
    </div>
  `, [
    { label: "取消", onClick: closeSheet },
    { label: "创建", kind: "", onClick: () => submitNewStaff() },
  ]);
}

async function submitNewStaff() {
  const button = $("sheet-foot").querySelector(".btn:not(.ghost)");
  const name = $("st-name").value;
  const code = $("st-code").value;
  if (button) { button.disabled = true; button.textContent = "创建中…"; }
  try {
    const account = await createEmployeeLocal({
      name: name,
      code: code,
      password: $("st-password").value,
      role: $("st-role").value,
      weekly_hours: $("st-weekly").value,
    });
    closeSheet();
    renderStaff();

    if (account.pending) {
      /* 本地建好了但云端没建成。**必须说清楚是哪一种失败**，
         否则老板以为建成功了，员工却登不上。 */
      toast("已存到本机，但云端没建成功：" + (account.lastError || ""));
    } else {
      toast(`已创建：${account.name}（工号 ${account.code}）`);
      if (navigator.vibrate) navigator.vibrate(16);
    }
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = "创建"; }
  }
}

/* 同步账号：把云端已经建好的员工账号认领成自己的员工。

   做法：拉取 profiles 表，找出 role=employee 且还没绑老板的记录，
   和本地 staffAccounts 按工号对上，然后把 boss_id 写成自己。

   这一步需要 profiles 表有对应的 RLS 策略允许老板更新自己的员工
   （建表 SQL 里的 "boss updates staff"）。 */
/* 重试创建还没建成功的员工账号。

   现在建号是**一次调用就完成**的（走数据库函数 create_staff_account），
   所以不再需要「先记本地、再去后台建号、最后回来认领」那一套。
   这个按钮只处理一种情况：**当时没网**，账号只存了本地，
   联网后点一下补齐。 */
async function retryStaffFromUI() {
  const pending = staffAccounts().filter(item => item.pending);
  if (!pending.length) { toast("没有需要重试的账号"); return; }
  if (!initCloud()) { toast("云服务连不上，检查一下网络"); return; }

  const button = $("btn-sync-staff");
  if (button) { button.disabled = true; button.textContent = "创建中…"; }
  try {
    const result = await retryPendingStaff();
    renderStaff();
    if (result.failures.length) {
      toast(result.done + " 个建好了，" + result.failures.length
        + " 个还是失败：" + result.failures[0]);
    } else {
      toast("全部创建成功，" + result.done + " 个员工现在可以登录了");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    updateStaffRetryButton();
  }
}

/* 旧名字保留成别名——免得别处还引用它时直接报未定义。 */
const syncStaffAccounts = retryStaffFromUI;

/* 员工端的「更多」菜单。员工只有这几件事可做。 */
function openStaffMenu() {
  const status = syncStatus();
  openSheet("更多", `
    <div class="meta" style="padding:4px 0 10px">
      ${DB.profile ? escapeHtml(DB.profile.name + "（" + DB.profile.code + "）") : "未登录"}
      <br>${status.pending > 0
        ? `<span style="color:var(--watch)">${status.pending} 条还没上传</span>`
        : "所有记录都已上传"}
      ${status.last && status.last.at
        ? `<br>上次同步 ${escapeHtml(String(status.last.at).slice(11, 16))}` : ""}
    </div>
    <button class="btn ghost" id="sm-sync" style="width:100%">立即同步</button>
    <div style="height:10px"></div>
    <button class="btn ghost" id="sm-theme" style="width:100%">
      切换主题（当前：${escapeHtml(chartTheme === "dark" ? "深色" : "浅色")}）</button>
    <div style="height:10px"></div>
    <button class="btn danger" id="sm-logout" style="width:100%">退出登录</button>
  `, [{ label: "关闭", onClick: closeSheet }]);

  $("sm-sync").onclick = () => {
    closeSheet();
    syncNow("manual").then(result => {
      /* 这个菜单在任务页和「我的」页都可能打开，
         两个都刷新一下，避免显示的待上传数量是旧的。 */
      renderTasks();
      renderMe();
      toast(result && result.pending
        ? `还有 ${result.pending} 条待上传` : "已同步");
    });
  };
  $("sm-theme").onclick = () => {
    const next = chartTheme === "dark" ? "light" : "dark";
    applyTheme(next);
    closeSheet();
    showPage(currentPageName());
    toast("已切到" + (next === "dark" ? "深色" : "浅色"));
  };
  $("sm-logout").onclick = () => { closeSheet(); logout(); };
}


function openCloudSettings() {
  const config = syncConfig();
  openSheet("云服务设置", `
    <label for="cloud-url">Supabase Project URL</label>
    <input id="cloud-url" value="${escapeHtml(config.url)}" autocapitalize="off">
    <div class="hint" style="margin-top:6px">
      <b>只填到 .supabase.co 为止，后面不要带 /rest/v1/</b>。<br>
      后台那一排复制按钮里，请点 <b>Project URL</b> 那个；
      复制到 <code>RESTful endpoint</code> 或 <code>Auth endpoint</code>
      的话会多出路径，登录时报
      "Invalid path specified in request URL"。<br>
      多粘了也没关系——保存时会自动裁掉。
    </div>

    <label for="cloud-key">anon public key</label>
    <textarea id="cloud-key" rows="3" autocapitalize="off">${escapeHtml(config.key)}</textarea>
    <div class="hint">
      在 <b>Project Settings → API</b> 里找 <b>Project API keys</b>，
      复制 <b>anon</b> <b>public</b> 那一个。
      <br><br>
      anon key 打进 apk 是安全的——数据安全靠服务端的
      行级权限策略保证。**不要填 service_role key**，
      那个是管理密钥，泄露等于数据库裸奔。
    </div>
  `, [
    { label: "取消", onClick: closeSheet },
    { label: "保存", kind: "", onClick: () => {
      saveSyncConfig($("cloud-url").value, $("cloud-key").value);
      initCloud();
      closeSheet();
      renderLogin();
      applyRoleUI();
      toast("已保存");
    } },
  ]);
}
