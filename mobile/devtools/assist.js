/* =============================================================
   小助手：关键词匹配的问答，**和电脑端 rules.ask() 同一套逻辑**。

   它不做语义理解，只做关键词匹配——所以回答的是「数据是什么」，
   而不是「我猜你想问什么」。匹配不到就老实说明能问什么，
   不硬编一个看起来像答案的东西。

   命中顺序刻意从具体到宽泛：
   先看有没有提到某个项目名 / 人名，再看问的是哪一类。
   ============================================================= */
"use strict";

const SUGGESTIONS = [
  "现在什么情况",
  "哪个项目有风险",
  "谁最忙",
  "谁闲下来了",
  "预算要紧吗",
  "有多少人在岗",
  "哪些任务卡住了",
  "帮我看看有什么问题",
];

/* 按当前数据补几条「现在就值得问」的问题。
   必须给出固定列表里**没有**的问题——重复的会被去重规则吃掉，
   加了等于没加。所以这里带上具体情况（如「哪 3 个任务卡住了」）。 */
function urgentSuggestions() {
  const extra = [];

  const blocked = DB.steps.filter(item => item.status === "已阻塞").length;
  if (blocked) {
    extra.push(blocked > 1 ? `哪 ${blocked} 个任务卡住了`
                           : "那个卡住的任务是谁负责的");
  }

  const overBudget = DB.projects.filter(project => budgetOf(project).over);
  if (overBudget.length) {
    extra.push(overBudget.length === 1
      ? `《${overBudget[0].name}》超了多少`
      : `这 ${overBudget.length} 个超预算的项目分别超了多少`);
  }

  const { rows } = loadRows();
  const overloaded = rows.filter(row => row.ratio > 1);
  if (overloaded.length) extra.push(`${overloaded[0].name} 的负荷是多少`);

  if (!DB.projects.length) return ["现在什么情况"];

  const result = [];
  extra.forEach(item => {
    if (SUGGESTIONS.indexOf(item) === -1 && result.indexOf(item) === -1) {
      result.push(item);
    }
  });
  return result;
}

/* ---------------------------------------------------------- 主入口 */
function ask(question) {
  const text = String(question || "").trim();
  if (!text) return "问点什么吧，比如「谁最忙」「哪个项目有风险」。";

  /* 先处理点名的项目：问「某某项目怎么样」比问「哪个有风险」更具体 */
  for (let i = 0; i < DB.projects.length; i += 1) {
    const project = DB.projects[i];
    if (project.name && text.indexOf(project.name) !== -1) {
      return answerProject(project);
    }
  }
  /* 再处理点名的人 */
  for (let i = 0; i < DB.employees.length; i += 1) {
    const employee = DB.employees[i];
    if (employee.name && text.indexOf(employee.name) !== -1) {
      return answerEmployee(employee);
    }
  }

  if (/什么情况|概况|总览|总结|最近怎么样/.test(text)) return answerOverview();
  if (/超负荷|扛不住|快撑不住|顶不住|加班/.test(text)) return answerOverloaded();
  if (/超预算|超支/.test(text)) return answerOverBudget();
  if (/风险|哪个项目|延期|危险|要出事|红灯/.test(text)) return answerRisk();
  if (/谁最忙|最忙|负荷|工时最多|累/.test(text)) return answerBusy();
  if (/谁闲|闲下来|空闲|没事干|工时最少|有空/.test(text)) return answerIdle();
  if (/预算|花钱|成本|费用/.test(text)) return answerBudget();
  if (/多少人|在岗|人员|团队规模|几个人/.test(text)) return answerHeadcount();
  if (/阻塞|卡住|堵|卡在|卡了/.test(text)) return answerBlocked();
  if (/比一比|横向比较|对比项目|哪个更划算|效率/.test(text)) {
    return formatInsights(insights().filter(item => item.group === "compare"));
  }
  if (/矛盾|对不上|逻辑问题|填错|数据有问题/.test(text)) {
    return formatInsights(insights().filter(item => item.group === "conflict"));
  }
  if (/帮我看看|有什么问题|发现|洞察|检查一遍|体检/.test(text)) {
    return formatInsights(insights());
  }

  return "我没理解这个问题。我能回答这几类：\n"
    + "　· 现在什么情况　　　　整体概况和该先看哪个项目\n"
    + "　· 哪个项目有风险　　　列出需要介入的项目\n"
    + "　· 谁最忙 / 谁超负荷　 按工时和负荷排行\n"
    + "　· 谁闲下来了　　　　　没记工时的人\n"
    + "　· 预算要紧吗 / 哪些超预算了\n"
    + "　· 有多少人在岗　　　　人力和投入总量\n"
    + "　· 哪些任务卡住了　　　所有「已阻塞」的步骤\n\n"
    + "也可以直接说项目名或人名，例如「智慧园区二期怎么样」"
    + "「李工最近做了什么」。";
}

/* ---------------------------------------------------------- 各类回答 */
function answerOverview() {
  const rows = projectSummary();
  if (!rows.length) {
    return "还没有项目。去「看板」页点「+ 新建」建一个。";
  }
  const { rows: loads, window } = loadRows();
  const totalHours = DB.worklogs.reduce((sum, log) => {
    if (log.work_date < window.from || log.work_date > window.to) return sum;
    return sum + num(log.hours);
  }, 0);
  const busy = loads.filter(row => row.hours > 0).length;
  const bad = rows.filter(row => row.result.level === "风险"
                              || row.result.level === "严重");

  const lines = [
    `共 ${rows.length} 个项目，最近 ${window.days} 天投入 `
    + `${totalHours.toFixed(1)} 小时、${busy} 人在干活。`,
    "",
  ];
  if (bad.length) {
    lines.push(`需要优先处理的 ${bad.length} 个：`);
    bad.slice(0, 4).forEach(row => lines.push(
      `　[${row.result.level}] ${row.project.name}：${row.result.headline}`));
  } else {
    lines.push("没有高风险项目。");
    if (rows.length) {
      lines.push(`最需要注意的是：${rows[0].project.name} —— ${rows[0].result.headline}`);
    }
  }
  const problems = worklogProblems();
  if (problems.length) {
    lines.push("", `另外发现 ${problems.length} 处工时异常，问「帮我看看有什么问题」。`);
  }
  return lines.join("\n");
}

function answerRisk() {
  const rows = projectSummary();
  if (!rows.length) return "还没有项目。";
  const bad = rows.filter(row => row.result.level === "风险"
                              || row.result.level === "严重");
  if (!bad.length) {
    const healthy = rows.filter(row => row.result.level === "健康");
    if (healthy.length === rows.length) return "所有项目都是健康状态，暂时不用特别关注。";
    return `目前没有高风险项目。\n最需要注意的是：${rows[0].project.name} —— `
         + rows[0].result.headline;
  }
  const lines = [`有 ${bad.length} 个项目需要处理：`];
  bad.slice(0, 6).forEach(row => {
    lines.push(`　[${row.result.level}] ${row.project.name}`);
    lines.push(`　　　${row.result.headline}`);
  });
  lines.push("", "想细看某一个，直接问它的名字。");
  return lines.join("\n");
}

function answerBusy() {
  const { rows, window } = loadRows();
  const worked = rows.filter(row => row.hours > 0);
  if (!worked.length) {
    return `最近 ${window.days} 天没有人在项目上记过工时。`;
  }
  const lines = [`最近 ${window.days} 天的负荷排行：`];
  const over = [];
  worked.slice(0, 8).forEach(row => {
    let flag = "";
    if (row.ratio > 1) { flag = "　← 超负荷"; over.push(row.name); }
    lines.push(`　${row.name}：${row.hours.toFixed(1)} 小时`
      + `（同期应出 ${row.expected.toFixed(0)} 小时，`
      + `占用 ${Math.round(row.ratio * 100)}%）${flag}`);
  });
  if (over.length) {
    lines.push("");
    lines.push(`${over.join("、")} 已经超出同期应出工时，`
      + "长期这样会出问题——要么加人，要么砍范围。");
  }
  return lines.join("\n");
}

function answerOverloaded() {
  const { rows, window } = loadRows();
  const over = rows.filter(row => row.ratio > 1)
                   .sort((a, b) => b.ratio - a.ratio);
  if (!over.length) return `最近 ${window.days} 天没有人超出同期应出工时。`;
  const lines = [`最近 ${window.days} 天有 ${over.length} 个人超负荷：`];
  over.forEach(row => lines.push(
    `　${row.name}：${row.hours.toFixed(1)} 小时 / 同期应出 `
    + `${row.expected.toFixed(0)}，超出 ${Math.round(row.ratio * 100 - 100)}%`));
  lines.push("");
  lines.push("超负荷不会立刻出事，但会以质量下降、延期、离职的形式在后面还回来。");
  lines.push("要么把他手上的事分出去，要么明确砍掉一部分范围。");
  return lines.join("\n");
}

function answerIdle() {
  const { rows, window } = loadRows();
  if (!rows.length) return "还没有员工。";
  const idle = rows.filter(row => row.hours <= 0);
  if (!idle.length) {
    const light = rows.slice().sort((a, b) => a.hours - b.hours).slice(0, 3);
    return `没有完全闲着的，最近 ${window.days} 天负荷最轻的三个：\n`
      + light.map(row => `　${row.name}：${row.hours.toFixed(1)} 小时`).join("\n");
  }
  const lines = [`最近 ${window.days} 天有 ${idle.length} 个人没有工时记录：`];
  idle.slice(0, 10).forEach(row => lines.push(
    `　${row.name}（${row.role || "未填岗位"}）`));
  lines.push("", "可能是没记工时，也可能是真的闲着——建议确认一下。");
  return lines.join("\n");
}

function answerBudget() {
  const rows = DB.projects.filter(project => budgetOf(project).has);
  if (!rows.length) {
    return "所有项目都还没填预算，建议补上——不然没法提前发现超支。";
  }
  const lines = ["各项目的预算占用："];
  const problems = [];
  rows.forEach(project => {
    const budget = budgetOf(project);
    if (budget.over) problems.push(project.name);
    lines.push(`　${project.name}：${Math.round(budget.ratio * 100)}%`
      + `（${money(budget.budget)}预算，已花 ${money(budget.cost)}）`);
  });
  if (problems.length) {
    lines.push("");
    lines.push(`${problems.join("、")} 已经超预算，建议核对超支科目。`);
  }
  return lines.join("\n");
}

function answerOverBudget() {
  const over = DB.projects.map(project => ({ project, budget: budgetOf(project) }))
                          .filter(item => item.budget.has && item.budget.over);
  if (!over.length) return "没有项目超出预算。";
  const lines = [`有 ${over.length} 个项目已经超预算：`];
  over.forEach(item => lines.push(
    `　${item.project.name}：${Math.round(item.budget.ratio * 100)}%`
    + `（预算 ${money(item.budget.budget)}，已花 ${money(item.budget.cost)}）`));
  lines.push("");
  lines.push("建议核对超支科目：是估算偏乐观，还是范围变了没走变更。");
  return lines.join("\n");
}

function answerHeadcount() {
  const { rows, window } = loadRows();
  const active = rows.filter(row => row.hours > 0);
  const total = rows.reduce((sum, row) => sum + row.hours, 0);
  const lines = [
    `在岗 ${rows.length} 人，最近 ${window.days} 天有工时的 ${active.length} 人。`,
    `这 ${window.days} 天合计投入 ${total.toFixed(1)} 小时。`,
  ];
  if (active.length < rows.length) {
    lines.push("没记工时的：" + rows.filter(row => row.hours <= 0)
      .map(row => row.name).slice(0, 8).join("、"));
  }
  return lines.join("\n");
}

function answerBlocked() {
  const found = [];
  DB.projects.forEach(project => {
    projectSteps(project.id).forEach(step => {
      if (step.status === "已阻塞") found.push({ project: project.name, step });
    });
  });
  if (!found.length) return "所有项目都没有「已阻塞」的步骤。";
  const lines = [`有 ${found.length} 个步骤卡住了：`];
  found.forEach(item => {
    const due = item.step.due_date ? `，计划 ${item.step.due_date}` : "";
    lines.push(`　${item.project} / ${item.step.name}`
      + `（负责人 ${item.step.owner || "未指定"}${due}）`);
  });
  lines.push("");
  lines.push("阻塞通常不是靠加人能解决的——先弄清楚卡在谁那里。");
  return lines.join("\n");
}

function answerProject(project) {
  const result = predict(project);
  const stats = result.metrics;
  const lines = [
    `《${project.name}》—— ${result.level}`,
    `负责人 ${project.owner || "未指定"} · 状态 ${project.status} · `
    + `进度 ${stats.progress}%`,
    "",
    result.headline,
    "",
  ];
  if (result.reasons.length) {
    result.reasons.forEach(reason => {
      lines.push(`　· ${reason.text}`
        + (reason.detail ? `（${reason.detail}）` : ""));
    });
  } else {
    lines.push("　· 没有发现异常");
  }
  if (result.actions.length) {
    lines.push("", "建议：");
    result.actions.forEach(action => lines.push(`　· ${action}`));
  }
  lines.push("");
  lines.push(`投入 ${stats.hours.toFixed(1)} 小时、${stats.peopleCount} 人；`
    + `步骤完成 ${stats.done}/${stats.total}。`);
  return lines.join("\n");
}

function answerEmployee(employee) {
  const logs = worklogsFor({ employee_id: employee.id });
  const total = logs.reduce((sum, log) => sum + num(log.hours), 0);
  const { rows } = loadRows();
  const load = rows.find(row => row.id === employee.id);

  const lines = [
    `${employee.name}（${employee.role || "未填岗位"}`
    + (employee.level ? ` · ${employee.level}` : "") + "）",
    "",
    `共 ${logs.length} 条记录、${total.toFixed(1)} 小时。`,
  ];
  if (load) {
    lines.push(`最近 ${worklogWindow().days} 天 ${load.hours.toFixed(1)} 小时，`
      + `同期应出 ${load.expected.toFixed(0)} 小时，`
      + `负荷 ${Math.round(load.ratio * 100)}%`
      + (load.ratio > 1 ? "　← 超负荷" : ""));
  }
  if (logs.length) {
    lines.push("", "最近几条：");
    logs.slice(0, 8).forEach(log => lines.push(
      `　${log.work_date}　${num(log.hours).toFixed(1)}h　`
      + `[${projectName(log.project_id) || "非项目"}] `
      + `${(log.content || "").slice(0, 24)}`));
  } else {
    lines.push("", "还没有工时记录。");
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------- 洞察文本 */
function formatInsights(found) {
  if (!found || !found.length) {
    return "我把项目、人、工时都对了一遍，没发现明显的异常。\n\n"
      + "随着数据变多（多几个项目、多几周的工时），能发现的东西会更多。";
  }
  const groups = { compare: "横向比较", conflict: "逻辑矛盾" };
  const lines = [`我主动看了一遍，发现 ${found.length} 件值得注意的事：`, ""];
  ["compare", "conflict"].forEach(key => {
    const items = found.filter(item => item.group === key);
    if (!items.length) return;
    lines.push(`—— ${groups[key]} ——`, "");
    items.forEach(item => {
      lines.push(`· ${item.title}`);
      lines.push(`　　${item.detail}`);
      lines.push(`　　建议：${item.advice}`);
      lines.push("");
    });
  });
  return lines.join("\n").replace(/\s+$/, "");
}
