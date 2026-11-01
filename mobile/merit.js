/* ---------------------------------------------------------------
 *  记忆源点（功绩点）
 *
 *  一句话：干活赚源点，源点换福利。
 *
 *  ## 为什么余额不存下来
 *
 *  余额永远是 SUM(amount)。如果既存余额又存流水，
 *  总有一天两者会对不上，而且**查不出是哪一步错的**。
 *  现在只有一个真相来源，算术代替同步。
 *
 *  ## 为什么名字做成常量
 *
 *  这个名字改过一次（功绩点 → 记忆源点）。以后可能还会改，
 *  所以界面上一个字都不硬编码，全部从这里取。
 * --------------------------------------------------------------- */

const MERIT = {
  /** 全称，用在标题、说明里 */
  name: "记忆源点",
  /** 单位，跟在数字后面 */
  unit: "源点",
  /** 单价：1 小时 = 多少源点 */
  hourRate: 10,
  /** 验收评级的倍率。C 级不给分（原始需求：扣回相应工时的源点）。 */
  grade: { S: 1.2, A: 1.0, B: 0.8, C: 0 },
  /** 评级说明，直接显示给老板看 */
  gradeText: {
    S: "超预期",
    A: "符合预期",
    B: "有瑕疵",
    C: "不合格",
  },
};

/* ---------------------------------------------------------- 读 */

/* 某人的流水，新的在前。 */
function meritEntries(profileId) {
  const id = String(profileId || "");
  if (!id) return [];
  return (DB.meritLedger || [])
    .filter(row => String(row.profile_id) === id)
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/* 某人的余额 = 所有流水之和。 */
function meritBalance(profileId) {
  return meritEntries(profileId)
    .reduce((sum, row) => sum + num(row.amount), 0);
}

/* 所有人的余额，老板视角用。返回 { profileId: balance } */
function meritBalances() {
  const map = {};
  (DB.meritLedger || []).forEach(row => {
    const id = String(row.profile_id || "");
    if (!id) return;
    map[id] = (map[id] || 0) + num(row.amount);
  });
  return map;
}

/* 某个时间点之后赚到的（默认本自然月），用来显示"本月 +320" */
function meritEarnedSince(profileId, since) {
  const from = since || monthStartISO();
  const floor = new Date(from).getTime();
  return meritEntries(profileId)
    .filter(row => num(row.amount) > 0
      && new Date(String(row.created_at).replace(" ", "T")).getTime() >= floor)
    .reduce((sum, row) => sum + num(row.amount), 0);
}

function monthStartISO() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return start.toISOString();
}

/* ---------------------------------------------------------- 等级 */

/* 累计赚到多少（只算正数流水）。

   **用累计而不是余额**：花掉的源点不该降级。
   不然员工换个奖励就掉段，谁还愿意兑换。 */
function meritLifetime(profileId) {
  return meritEntries(profileId)
    .filter(row => num(row.amount) > 0)
    .reduce((sum, row) => sum + num(row.amount), 0);
}

const MERIT_LEVELS = [
  { name: "青铜", at: 0 },
  { name: "白银", at: 100 },
  { name: "黄金", at: 300 },
  { name: "铂金", at: 700 },
  { name: "钻石", at: 1500 },
];

/* 当前等级 + 离下一级还差多少 */
function meritLevel(profileId) {
  const earned = meritLifetime(profileId);
  let current = MERIT_LEVELS[0];
  let next = null;
  MERIT_LEVELS.forEach((level, index) => {
    if (earned >= level.at) {
      current = level;
      next = MERIT_LEVELS[index + 1] || null;
    }
  });
  return {
    earned: earned,
    current: current,
    next: next,
    toNext: next ? Math.max(0, next.at - earned) : 0,
  };
}

/* ---------------------------------------------------------- 显示 */

/* 1280 → "1,280"。数字要大、要好读，所以带千分位。 */
function meritNumber(value) {
  const n = Math.round(num(value));
  return n.toLocaleString("en-US");
}

/* 带正负号：+120 / -50 */
function meritSigned(value) {
  const n = Math.round(num(value));
  if (n > 0) return "+" + n.toLocaleString("en-US");
  return n.toLocaleString("en-US");
}

/* 一条流水的说明。kind 决定措辞，避免出现技术词。 */
function meritReason(row) {
  const reason = String((row && row.reason) || "").trim();
  if (reason) return reason;
  const kind = String((row && row.kind) || "");
  if (kind === "grade") {
    /* 验收流水在服务端没有 reason 文本（sql 文件必须纯 ASCII），
       所以在这里用 source_id 反查任务名，拼一句人话。 */
    const taskId = String((row && row.source_id) || "");
    const task = taskId
      ? (DB.tasks || []).find(item => String(item.id) === taskId)
      : null;
    if (task) {
      const title = String(task.title || "").trim();
      const short = title.length > 12 ? title.slice(0, 12) + "…" : title;
      return "任务「" + short + "」" + (task.grade ? task.grade + " 级" : "验收");
    }
    return "验收评分";
  }
  if (kind === "task") return "完成任务";
  if (kind === "grade") return "验收评分";
  if (kind === "hours") return "工时结算";
  if (kind === "redeem") return "兑换奖励";
  if (kind === "leave") return "请假";
  return "调整";
}

/* 一条流水的时间，只显示 月-日 时:分。**按本地时区。**

   原来直接 slice 字符串，而服务端给的是 UTC（...+00:00），
   于是所有时间都比手机上的慢 8 小时 —— 下午三点收的工
   显示成上午七点，用户以为记错日期了。 */
function meritTime(value) {
  const raw = String(value || "");
  if (!raw) return "";
  /* "2026-11-01 14:53:19" 这种空格分隔的，Date 也认，
     但换成 T 更稳 */
  const date = new Date(raw.indexOf("T") === -1
    ? raw.replace(" ", "T") : raw);
  if (!isFinite(date.getTime())) return raw.slice(0, 16);
  const pad = n => String(n).padStart(2, "0");
  return pad(date.getMonth() + 1) + "/" + pad(date.getDate())
    + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/* 某个时间点在**本地时区**是哪一天（YYYY-MM-DD）。

   不能直接 slice 字符串：服务端是 UTC，晚上 8 点以后
   在东八区已经是第二天了，slice 出来是前一天。 */
function meritDayKey(value) {
  const raw = String(value || "");
  const date = new Date(raw.indexOf("T") === -1
    ? raw.replace(" ", "T") : raw);
  if (!isFinite(date.getTime())) return raw.slice(0, 10);
  const pad = n => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1)
    + "-" + pad(date.getDate());
}

/* 一周前那天的本地日期（YYYY-MM-DD），用来算「本周」。

   算最近 7 天，不是自然周：周一早上打开 App 时，
   「本周」不该是空的。 */
function weekAgoKey() {
  const date = new Date(Date.now() - 6 * 86400000);
  const pad = n => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1)
    + "-" + pad(date.getDate());
}

/* ---------------------------------------------------------- 任务算分 */

/* 一条任务"实际做了多久"（小时）。

   来源是完成记录里的 started_at → finished_at，也就是
   **员工接受任务后计时器量出来的时间**。
   老板填的预估工时只是参考，不再参与算钱。

   没有计时（老任务，或者员工从没点过接受）时返回 0，
   调用方回退到预估。 */
function taskActualHours(task) {
  if (!task) return 0;
  const log = typeof taskLogFor === "function" ? taskLogFor(task.id) : null;
  if (!log || !log.started_at || !log.finished_at) return 0;
  const start = new Date(String(log.started_at).replace(" ", "T")).getTime();
  const end = new Date(String(log.finished_at).replace(" ", "T")).getTime();
  if (!isFinite(start) || !isFinite(end) || end <= start) return 0;
  /* 上限一天：忘了点完成的话，别按一周算 */
  return Math.min(24, (end - start) / 3600000);
}

/* 一条任务的"基数"：满分能拿多少源点。

   **先用实际计时，没有才用预估。**
   老板的预估和真实耗时经常差一截，这里以计时器为准。

   小时数一律夹到 0~24：库里有 500 小时的脏预估，
   不夹的话一个手滑就能发出几千分。 */
function taskBaseMerit(task) {
  if (!task) return 0;
  const explicit = num(task.est_merit);
  if (explicit > 0) return Math.round(explicit);
  const actual = taskActualHours(task);
  const hours = actual > 0
    ? actual
    : Math.min(Math.max(num(task.est_hours), 0), 24);
  return Math.round(hours * MERIT.hourRate);
}

/* 这次算分用的是实际时间还是预估 —— 界面上要说清楚 */
function taskMeritSource(task) {
  const actual = taskActualHours(task);
  if (actual > 0) return { kind: "actual", hours: actual };
  return {
    kind: "estimate",
    hours: Math.min(Math.max(num(task && task.est_hours), 0), 24),
  };
}

/* 按评级算实际能拿多少。C 级是 0（原始需求：不合格不给分）。 */
function taskGradeAmount(task, grade) {
  const multiplier = MERIT.grade[String(grade || "").toUpperCase()];
  if (!multiplier) return 0;
  return Math.round(taskBaseMerit(task) * multiplier);
}

/* ---------------------------------------------------------- 画 */

/* 员工任务页顶部那张卡。
 *
 * 三块内容，从大到小：余额 → 本月赚了多少 → 最近几笔。
 * 不放图表、不放按钮 —— 这里只需要"我赚了多少"这一个答案。 */
function renderMeritCard() {
  const card = $("merit-card");
  if (!card) return;

  const profile = DB.profile;
  if (!profile || !profile.id) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  /* 标题和单位都从常量取，改名只改一处 */
  const title = $("merit-title");
  if (title) title.textContent = "我的" + MERIT.name;
  const unit = $("merit-unit");
  if (unit) unit.textContent = MERIT.unit;

  const balance = meritBalance(profile.id);
  const balanceBox = $("merit-balance");
  if (balanceBox) {
    balanceBox.textContent = meritNumber(balance);
    /* 负数用红色，零用灰色，正数用默认色 */
    balanceBox.className = balance < 0 ? "neg" : (balance === 0 ? "zero" : "");
  }

  const earned = meritEarnedSince(profile.id);
  const monthBox = $("merit-month");
  if (monthBox) {
    monthBox.textContent = earned > 0 ? "本月 +" + meritNumber(earned) : "";
  }

  /* 等级：用累计赚到的算，花掉的不会降级 */
  const levelBox = $("merit-level");
  if (levelBox) {
    const info = meritLevel(profile.id);
    levelBox.innerHTML = '<span class="level-name">' + info.current.name + '</span>'
      + (info.next
        ? '<span class="level-next">再赚 ' + meritNumber(info.toNext)
          + ' 升 ' + info.next.name + '</span>'
        : '<span class="level-next">已经是最高级</span>');
  }

  /* 最近三笔。没有记录时给一句人话，不要留一片空白。 */
  const list = $("merit-recent");
  if (!list) return;
  const rows = meritEntries(profile.id).slice(0, 3);
  if (!rows.length) {
    list.innerHTML = '<div class="merit-empty">还没有记录</div>';
    return;
  }

  list.innerHTML = rows.map(row => {
    const amount = num(row.amount);
    const tone = amount > 0 ? "up" : (amount < 0 ? "down" : "");
    return '<div class="merit-row">'
      + '<span class="merit-when">' + escapeHtml(meritTime(row.created_at))
      + '</span>'
      + '<span class="merit-what">' + escapeHtml(meritReason(row))
      + '</span>'
      + '<span class="merit-delta ' + tone + '">'
      + escapeHtml(meritSigned(amount)) + '</span>'
      + '</div>';
  }).join("");
}

