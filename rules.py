"""项目预测引擎（本地规则版）。

设计原则：**每条结论都必须能追溯到具体数字**。
老板不会满足于「这个项目有风险」，他要问「凭什么」。
所以这里的 predict() 返回的不是一句话，而是一组「依据条目」：

    {
      "level": "风险",
      "headline": "按当前速度，预计 11 月 12 日才能收尾，比计划晚 12 天",
      "reasons": [
          {"text": "时间已过 60%，但进度只有 35%", "detail": "落后 25 个百分点"},
          {"text": "有 2 个步骤处于「已阻塞」", "detail": "接口联调 / 灰度发布"},
      ],
      "actions": ["先处理 2 个阻塞步骤", "考虑从测试组借调 1 人"],
    }

全部规则不联网、不随机，同样的数据算两次结果完全一样。
"""
import datetime

import metrics
from metrics import (
    budget_usage, days_between, days_left, fmt_date, load_ratio, num,
    parse_date, safe_div, step_stats, sum_hours, text, worklog_window,
)

__all__ = ["predict", "project_metrics", "load_summary", "RISK_LEVELS",
           "ask", "SUGGESTIONS", "urgent_suggestions", "export_conversation",
           "insights", "format_insights", "INSIGHT_GROUPS", "load_ratio"]

RISK_LEVELS = ["健康", "关注", "风险", "严重"]

#: 判定阈值集中放在这里，方便调
DELAY_WARN_DAYS = 3          # 预计延期超过几天算「关注」
DELAY_RISK_DAYS = 10         # 超过几天算「风险」
DELAY_SEVERE_DAYS = 25       # 超过几天算「严重」
OVERLOAD_RATIO = 1.15        # 计划工时超出可用工时多少算超载
BUDGET_WARN = 0.85           # 预算用掉多少比例开始提醒
BUDGET_RISK = 1.0            # 超预算
BLOCKED_WARN = 1             # 几个阻塞步骤开始提醒
STALE_DAYS = 14              # 多久没记工时算「长期无人问津」

# 兼容旧写法：这些名字原先在本模块里，现在统一由 metrics 提供。
# 保留别名是为了不用改动一百多处调用点，但新代码请直接用 metrics 里的名字。
_today = datetime.date.today
_parse = parse_date
_days_between = days_between
_fmt = fmt_date
_worklog_window = worklog_window


# ------------------------------------------------------------------ 取数
def project_metrics(store, project_id):
    """把一个项目的所有原始事实算成一组可用的数字。

    单独的纯函数，不产出结论——结论交给 predict()。
    这样想调判断标准时不用碰取数逻辑。
    """
    project = store.project(project_id)
    if project is None:
        return None
    project = dict(project)

    steps = [dict(row) for row in store.steps(project_id)]
    people = store.query(
        "SELECT DISTINCT employee_id FROM assignment WHERE project_id = ?",
        (project_id,),
    )
    people_ids = [row["employee_id"] for row in people if row["employee_id"]]

    total_hours = float(store.scalar(
        "SELECT COALESCE(SUM(hours), 0) FROM worklog WHERE project_id = ?",
        (project_id,), 0.0,
    ))
    planned_hours = float(store.scalar(
        "SELECT COALESCE(SUM(planned_hours), 0) FROM assignment WHERE project_id = ?",
        (project_id,), 0.0,
    ))
    last_log = store.scalar(
        "SELECT MAX(work_date) FROM worklog WHERE project_id = ?", (project_id,), ""
    )

    # 可用工时：参与本项目的人，按各自每周可用工时 × 项目剩余周数估算
    start = _parse(project["start_date"])
    due = _parse(project["due_date"])
    today = _today()
    total_days = _days_between(start, due)
    used_days = _days_between(start, today)
    left_days = _days_between(today, due)

    capacity = 0.0
    for employee_id in people_ids:
        row = store.employee(employee_id)
        if row is None or not row["active"]:
            continue
        weekly = float(row["weekly_hours"] or 40)
        if left_days is not None and left_days > 0:
            capacity += weekly * (left_days / 7.0)

    blocked = [s for s in steps if s["status"] == "已阻塞"]
    done = [s for s in steps if s["status"] == "已完成"]
    doing = [s for s in steps if s["status"] == "进行中"]
    overdue_steps = []
    for step in steps:
        step_due = _parse(step["due_date"])
        if step_due and step_due < today and step["status"] != "已完成":
            overdue_steps.append(step)

    return {
        "project": project,
        "steps": steps,
        "step_total": len(steps),
        "step_done": len(done),
        "step_doing": len(doing),
        "blocked": blocked,
        "overdue_steps": overdue_steps,
        "people_count": len(people_ids),
        "people_ids": people_ids,
        "total_hours": total_hours,
        "planned_hours": planned_hours,
        "capacity_hours": capacity,
        "last_log_date": last_log,
        "total_days": total_days,
        "used_days": used_days,
        "left_days": left_days,
        "today": today,
        "due": due,
        "start": start,
    }


# ------------------------------------------------------------------ 预测
def predict(store, project_id):
    """给一个项目做预测。返回结论文本 + 逐条依据 + 建议动作。"""
    metrics = project_metrics(store, project_id)
    if metrics is None:
        return None
    project = metrics["project"]
    reasons = []
    actions = []
    level_score = 0        # 累加风险分，最后映射到四个等级

    # ---- 1. 交付时间：按当前速度外推 ----
    progress = float(project["progress"] or 0)
    eta_line = "进度还不足以推算完工时间"
    if metrics["used_days"] is not None and metrics["used_days"] > 0 and progress > 0:
        used = max(1, metrics["used_days"])
        speed = progress / used                     # 每天推进多少个百分点
        if speed > 0:
            need_days = (100 - progress) / speed
            eta = metrics["today"] + datetime.timedelta(days=int(need_days))
            if metrics["due"]:
                delay = _days_between(metrics["due"], eta) or 0
                if delay > 0:
                    eta_line = (f"按当前速度，预计 {_fmt(eta)} 才能收尾，"
                                f"比计划晚 {delay} 天")
                    if delay >= DELAY_SEVERE_DAYS:
                        level_score += 3
                    elif delay >= DELAY_RISK_DAYS:
                        level_score += 2
                    elif delay >= DELAY_WARN_DAYS:
                        level_score += 1
                    reasons.append({
                        "text": f"预计延期 {delay} 天",
                        "detail": (f"已过 {used} 天完成 {progress:.0f}%，"
                                   f"按此速度还需约 {need_days:.0f} 天，"
                                   f"而计划只剩 {metrics['left_days']} 天"),
                    })
                else:
                    eta_line = (f"按当前速度，预计 {_fmt(eta)} 可收尾，"
                                f"比计划早 {abs(delay)} 天")
                    reasons.append({
                        "text": f"进度领先计划 {abs(delay)} 天",
                        "detail": f"已过 {used} 天完成 {progress:.0f}%",
                    })
            else:
                eta_line = f"按当前速度，预计 {_fmt(eta)} 可收尾（未设计划日期）"

    # ---- 2. 时间与进度的错位 ----
    if metrics["total_days"] and metrics["total_days"] > 0 and metrics["used_days"]:
        time_pct = metrics["used_days"] / metrics["total_days"] * 100
        gap = time_pct - progress
        if gap >= 25:
            level_score += 2
            reasons.append({
                "text": f"时间用掉 {time_pct:.0f}%，进度只有 {progress:.0f}%",
                "detail": f"落后 {gap:.0f} 个百分点",
            })
        elif gap >= 10:
            level_score += 1
            reasons.append({
                "text": f"时间用掉 {time_pct:.0f}%，进度 {progress:.0f}%",
                "detail": f"略落后 {gap:.0f} 个百分点",
            })

    # ---- 3. 已过期还没做完的步骤 ----
    if metrics["overdue_steps"]:
        names = "、".join(s["name"] for s in metrics["overdue_steps"][:3])
        more = "" if len(metrics["overdue_steps"]) <= 3 else f" 等 {len(metrics['overdue_steps'])} 项"
        level_score += 1 if len(metrics["overdue_steps"]) <= 2 else 2
        reasons.append({
            "text": f"{len(metrics['overdue_steps'])} 个步骤已过计划日期仍未完成",
            "detail": names + more,
        })
        actions.append("逐个确认过期步骤：是重新排期，还是需要加人")

    # ---- 4. 阻塞步骤 ----
    if len(metrics["blocked"]) >= BLOCKED_WARN:
        names = "、".join(s["name"] for s in metrics["blocked"][:3])
        more = "" if len(metrics["blocked"]) <= 3 else f" 等 {len(metrics['blocked'])} 项"
        level_score += 2 if len(metrics["blocked"]) >= 2 else 1
        reasons.append({
            "text": f"{len(metrics['blocked'])} 个步骤处于「已阻塞」",
            "detail": names + more,
        })
        actions.append("先解开阻塞——阻塞不解决，加人也没用")

    # ---- 5. 人力负荷 ----
    if metrics["planned_hours"] > 0:
        if metrics["capacity_hours"] > 0:
            load = metrics["planned_hours"] / metrics["capacity_hours"]
            if load >= OVERLOAD_RATIO:
                level_score += 2
                reasons.append({
                    "text": f"计划工时超出可用产能 {load * 100 - 100:.0f}%",
                    "detail": (f"计划 {metrics['planned_hours']:.0f} 小时，"
                               f"{metrics['people_count']} 人剩余产能约 "
                               f"{metrics['capacity_hours']:.0f} 小时"),
                })
                actions.append("要么砍范围，要么加人，否则只能靠加班顶")
            elif load < 0.5:
                reasons.append({
                    "text": "人力有明显空余",
                    "detail": (f"计划 {metrics['planned_hours']:.0f} 小时，"
                               f"可用 {metrics['capacity_hours']:.0f} 小时，"
                               f"用了 {load * 100:.0f}%"),
                })
        else:
            level_score += 2
            reasons.append({
                "text": "有分配任务，但没有可用的在岗人员",
                "detail": f"已分配 {metrics['people_count']} 人，均为离职或缺工时基准",
            })
    elif metrics["people_count"] == 0:
        level_score += 1
        reasons.append({
            "text": "还没有分配任何人",
            "detail": "没有人的项目不会自己推进",
        })
        actions.append("先把任务分配到人")

    # ---- 6. 预算 ----
    usage = budget_usage(project)
    if usage["has_budget"]:
        ratio = usage["used_ratio"]
        if ratio >= BUDGET_RISK:
            level_score += 2
            reasons.append({
                "text": f"已超预算 {ratio * 100 - 100:.0f}%",
                "detail": f"预算 {usage['budget']:,.0f}，已花 {usage['cost']:,.0f}",
            })
            actions.append("核对超支科目，必要时追加预算或砍掉低价值范围")
        elif ratio >= BUDGET_WARN:
            level_score += 1
            reasons.append({
                "text": f"预算已用掉 {ratio * 100:.0f}%",
                "detail": (f"预算 {usage['budget']:,.0f}，已花 {usage['cost']:,.0f}，"
                           f"剩余 {usage['remaining']:,.0f}"),
            })

    # ---- 7. 能力 / 资源评分 ----
    abilities = [dict(r) for r in store.assessments(project_id, "ability")]
    resources = [dict(r) for r in store.assessments(project_id, "resource")]
    ability_score = _weighted(abilities)
    resource_score = _weighted(resources)
    if abilities and ability_score is not None and ability_score < 3.0:
        level_score += 2
        weak = [a["name"] for a in abilities if a["score"] <= 2][:3]
        reasons.append({
            "text": f"技术能力加权分只有 {ability_score:.1f} / 5",
            "detail": "短板：" + ("、".join(weak) if weak else "整体偏低"),
        })
        actions.append("针对短板安排补齐计划，或引入外部支援")
    if resources and resource_score is not None and resource_score >= 4.0:
        reasons.append({
            "text": f"有利资源充足（加权分 {resource_score:.1f} / 5）",
            "detail": "这项是加分项，可以在计划里更积极一些",
        })

    # ---- 8. 最近有没有人干活 ----
    last = _parse(metrics["last_log_date"])
    if last:
        idle = _days_between(last, metrics["today"])
        if idle is not None and idle >= STALE_DAYS and project["status"] == "进行中":
            level_score += 2
            reasons.append({
                "text": f"已经 {idle} 天没有工时记录了",
                "detail": f"最后一次记录是 {metrics['last_log_date']}",
            })
            actions.append("确认项目是否实际停滞，或在库里补记工时")
    elif metrics["people_count"] > 0 and project["status"] == "进行中":
        level_score += 1
        reasons.append({
            "text": "分配了人，但一条工时记录都没有",
            "detail": "无法判断真实投入",
        })

    # ---- 状态本身的影响 ----
    if project["status"] == "已暂停":
        reasons.append({"text": "项目处于「已暂停」状态", "detail": "预测仅供参考"})
    elif project["status"] == "已交付":
        level_score = 0
        reasons.append({"text": "项目已交付", "detail": "以下为复盘视角"})

    # ---- 汇总等级 ----
    level = _level_from_score(level_score)
    headline = _headline(level, eta_line, reasons)

    if not actions and level in ("风险", "严重"):
        actions.append("建议本周内开一次专项对齐会，明确谁在什么时候解决哪个问题")
    if not reasons:
        reasons.append({"text": "没有发现明显异常", "detail": "各项指标都在合理范围"})

    return {
        "level": level,
        "score": level_score,
        "headline": headline,
        "eta_line": eta_line,
        "reasons": reasons,
        "actions": actions,
        "ability_score": ability_score,
        "resource_score": resource_score,
        "metrics": metrics,
    }


def _weighted(items):
    """加权平均分。权重为 0 的条目忽略。"""
    total = sum(float(i["weight"]) for i in items if float(i["weight"]) > 0)
    if total <= 0:
        return None
    score = sum(float(i["score"]) * float(i["weight"])
                for i in items if float(i["weight"]) > 0)
    return score / total


def _level_from_score(score):
    if score >= 7:
        return "严重"
    if score >= 4:
        return "风险"
    if score >= 2:
        return "关注"
    return "健康"


def _headline(level, eta_line, reasons):
    prefix = {
        "健康": "目前健康。",
        "关注": "需要留意。",
        "风险": "存在风险。",
        "严重": "风险严重。",
    }[level]
    if eta_line and not eta_line.startswith("进度还不足"):
        return prefix + eta_line
    if reasons:
        return prefix + reasons[0]["text"]
    return prefix + "各项指标正常"


# ------------------------------------------------------------------ 驾驶舱
def load_summary(store):
    """所有项目的概况 + 各自的预测等级，供驾驶舱使用"""
    rows = []
    for row in store.dashboard_rows():
        project = dict(row)
        result = predict(store, project["id"])
        project["level"] = result["level"] if result else "健康"
        project["headline"] = result["headline"] if result else ""
        rows.append(project)
    # 严重的排前面
    rows.sort(key=lambda p: (-RISK_LEVELS.index(p["level"]), -p["progress"]))
    return rows


# ------------------------------------------------------------------ 洞察
#: 洞察分类，界面上分组展示
INSIGHT_GROUPS = {
    "compare": "横向比较",
    "conflict": "逻辑矛盾",
}


def _insight(title, detail, advice, group="compare", severity=0):
    """制造一条洞察。

    severity 用来排序：数字越大越该先看。
    每条都必须有 detail（数字依据）——没有数字的「洞察」就是废话。
    """
    return {"title": title, "detail": detail, "advice": advice,
            "group": group, "severity": severity}


def insights(store):
    """主动发现值得注意的事。

    两类：
      compare  —— 横向比较（项目之间、人之间）
      conflict —— 逻辑矛盾（状态填错、分配和工时对不上）

    这两类都不依赖历史数据，任何时刻都能算。
    """
    found = []
    found += _insight_inefficient_projects(store)
    found += _insight_overloaded_people(store)
    found += _insight_scattered_people(store)
    found += _insight_blocked_aging(store)
    found += _insight_junior_on_critical(store)
    found += _insight_done_with_open_deps(store)
    found += _insight_unassigned_hours(store)
    found += _insight_idle_assignments(store)
    # severity 高的排前面
    found.sort(key=lambda item: -item["severity"])
    return found


# ---------------------------------------------------------------- A 横向比较
def _insight_inefficient_projects(store):
    """花钱多、进度低 —— 单看成本或单看进度都发现不了"""
    rows = [dict(row) for row in store.dashboard_rows()]
    candidates = [r for r in rows
                  if float(r["cost"] or 0) > 0 and r["status"] in ("进行中", "已暂停")]
    if len(candidates) < 2:
        return []

    by_cost = sorted(candidates, key=lambda r: -float(r["cost"]))
    worst = by_cost[0]
    by_progress = sorted(candidates, key=lambda r: (r["progress"] or 0))
    best = by_progress[-1]

    worst_ratio = (worst["progress"] or 0) / max(1.0, float(worst["cost"]))
    best_ratio = (best["progress"] or 0) / max(1.0, float(best["cost"]))
    # 效率差三倍以上才值得提，否则是噪音
    if best_ratio < worst_ratio * 3 or worst["id"] == best["id"]:
        return []

    return [_insight(
        f"《{worst['name']}》投入最大、推进最慢",
        f"已花 {fmt_money(float(worst['cost']))}、进度 {worst['progress'] or 0}%；"
        f"对比《{best['name']}》花了 {fmt_money(float(best['cost']))}、"
        f"进度 {best['progress'] or 0}%",
        "同样的人力在另一个项目上推进得更快。先弄清是范围失控还是执行受阻——"
        "这两种情况处理方式完全相反。",
        severity=3,
    )]


def _insight_overloaded_people(store):
    """谁的工作量压得太满

    窗口不写死：先看最近 7 天，没数据就放宽到 28 天，
    并在文案里说明看的是哪一段——不能让人以为「最近 7 天没事」。
    """
    date_from, date_to, days = _worklog_window(store)
    rows = store.hours_by_employee(date_from, date_to)
    over = []
    for row in rows:
        ratio = load_ratio(row["hours"], row["weekly_hours"], days)
        if ratio > 1:
            over.append((row, ratio))
    if not over:
        return []
    over.sort(key=lambda pair: -pair[1])
    row, ratio = over[0]
    others = "、".join(r["name"] for r, _ in over[1:4])
    detail = (f"最近 {days} 天：{row['name']} {float(row['hours']):.1f} 小时，"
              f"是同期应出 {metrics.expected_hours(row['weekly_hours'], days):.0f} 小时的 "
              f"{ratio * 100:.0f}%")
    if others:
        detail += f"；另有 {others} 也超标"
    return [_insight(
        f"{len(over)} 个人超出同期应出工时",
        detail,
        "超负荷不会立刻出事，但会以质量下降、延期、离职的形式在后面还回来。"
        "要么把事分出去，要么明确砍范围。",
        severity=3,
    )]


def _insight_scattered_people(store):
    """一个人被挂到太多项目上 —— 切换成本会吃掉产能"""
    rows = store.query(
        """SELECT e.id, e.name, COUNT(DISTINCT a.project_id) AS projects,
                  GROUP_CONCAT(DISTINCT p.name) AS names
           FROM assignment a
           JOIN employee e ON e.id = a.employee_id
           JOIN project p ON p.id = a.project_id
           WHERE e.active = 1 AND p.status = '进行中'
           GROUP BY e.id
           HAVING projects >= 2
           ORDER BY projects DESC"""
    )
    if not rows:
        return []
    worst = rows[0]
    count = worst["projects"]
    if count < 3:
        # 只挂两个项目是正常的，不算问题
        return []
    return [_insight(
        f"{worst['name']} 同时挂在 {count} 个项目上",
        f"进行中的项目：{worst['names']}",
        "人在多个项目之间切换，光是切换本身就要花掉不少时间，"
        "实际产出通常低于把工时简单相加的预期。考虑让他专注在其中一两个。",
        severity=2,
    )]


def _insight_blocked_aging(store):
    """阻塞越久越危险"""
    today = _today()
    worst = None
    for row in store.projects():
        for step in store.steps(row["id"]):
            if step["status"] != "已阻塞":
                continue
            due = _parse(step["due_date"])
            overdue = _days_between(due, today) if due else None
            if worst is None or (overdue or 0) > (worst[2] or 0):
                worst = (row["name"], dict(step), overdue)
    if worst is None:
        return []
    project_name, step, overdue = worst
    if overdue is None or overdue < 3:
        return []
    return [_insight(
        f"《{project_name}》的「{step['name']}」已阻塞 {overdue} 天",
        f"计划截止 {step['due_date']}，负责人 {step['owner'] or '未指定'}",
        "阻塞放久了会变成习惯，后面就没人再提。"
        "这周内必须有人明确回答：卡在谁那里、什么时候能解开。",
        severity=3,
        group="compare",
    )]


def _insight_junior_on_critical(store):
    """低职级的人负责关键步骤 —— 要么没人可用，要么安排有问题"""
    levels = {}
    for row in store.employees():
        levels[row["id"]] = (row["level"] or "").strip().upper()

    def rank(level):
        """把 P4 / P5 这类职级变成可比较的数字，认不出来就返回 None"""
        digits = "".join(ch for ch in level if ch.isdigit())
        return int(digits) if digits else None

    ranked = {key: rank(value) for key, value in levels.items()}
    known = [value for value in ranked.values() if value is not None]
    if len(known) < 2:
        return []
    median = sorted(known)[len(known) // 2]

    hits = []
    for row in store.projects():
        if row["status"] not in ("进行中", "规划中"):
            continue
        for step in store.steps(row["id"]):
            if step["status"] == "已完成" or not step["owner"]:
                continue
            owner = None
            for employee in store.employees():
                if employee["name"] == step["owner"]:
                    owner = employee
                    break
            if owner is None:
                continue
            level = ranked.get(owner["id"])
            if level is not None and level <= median:
                hits.append((row["name"], step["name"], owner["name"], level))
    if not hits:
        return []
    shown = "；".join(f"{p}/{s}（{n} P{l}）" for p, s, n, l in hits[:3])
    return [_insight(
        f"有 {len(hits)} 个未完成步骤由职级偏低的人负责",
        shown,
        "不一定是错——可能是培养，也可能是没人可用。"
        "但如果这些步骤在关键路径上，建议配一个有经验的人兜底。",
        severity=1,
    )]


# ---------------------------------------------------------------- B 逻辑矛盾
def _insight_done_with_open_deps(store):
    """标记为已完成，但前面还有没做完的步骤 —— 矛盾"""
    hits = []
    for row in store.projects():
        steps = [dict(s) for s in store.steps(row["id"])]
        seen_open = []
        for step in steps:
            if step["status"] == "已完成":
                if seen_open:
                    hits.append((row["name"], step["name"],
                                 seen_open[0]["name"]))
            elif step["status"] != "已完成":
                seen_open.append(step)
    if not hits:
        return []
    shown = "；".join(f"{p}：「{s}」完成了但「{before}」还没" 
                     for p, s, before in hits[:2])
    return [_insight(
        f"{len(hits)} 处步骤顺序矛盾",
        shown + ("…" if len(hits) > 2 else ""),
        "要么状态填错了，要么顺序乱了两者都会让进度百分比失真。"
        "花五分钟核对一下，比后面按错的进度做决策便宜得多。",
        severity=2,
        group="conflict",
    )]


def _insight_unassigned_hours(store):
    """记了工时，但没有对应的任务分配 —— 项目管理的盲区"""
    rows = store.query(
        """SELECT p.name AS project_name,
                  COALESCE(SUM(w.hours), 0) AS hours,
                  COUNT(*) AS entries
           FROM worklog w
           JOIN project p ON p.id = w.project_id
           WHERE w.project_id IS NOT NULL
             AND NOT EXISTS (
                 SELECT 1 FROM assignment a
                 WHERE a.project_id = w.project_id
                   AND a.employee_id = w.employee_id
             )
           GROUP BY w.project_id
           HAVING hours > 0
           ORDER BY hours DESC"""
    )
    if not rows:
        return []
    worst = rows[0]
    total = sum_hours(rows)
    return [_insight(
        f"{len(rows)} 个项目有「没分配到人」的工时",
        f"合计 {total:,.1f} 小时；最多的是《{worst['project_name']}》，"
        f"{num(worst['hours']):,.1f} 小时、{worst['entries']} 条记录",
        "这些工时不知道该算在哪个任务上，也就没法判断哪一步超支。"
        "要么补上分配，要么确认这些是计划外的工作。",
        severity=2,
        group="conflict",
    )]


def _insight_idle_assignments(store, days=14):
    """分配了任务、填了计划工时，但实际一点没动"""
    today = _today()
    date_from = (today - datetime.timedelta(days=days)).isoformat()
    rows = store.query(
        """SELECT a.id, a.planned_hours, a.start_date, a.status,
                  e.name AS employee_name, p.name AS project_name,
                  s.name AS step_name,
                  COALESCE((SELECT SUM(w.hours) FROM worklog w
                            WHERE w.employee_id = a.employee_id
                              AND w.project_id = a.project_id
                              AND (a.step_id IS NULL OR w.step_id = a.step_id)), 0)
                      AS used_hours
           FROM assignment a
           JOIN employee e ON e.id = a.employee_id
           JOIN project p ON p.id = a.project_id
           LEFT JOIN step s ON s.id = a.step_id
           WHERE p.status = '进行中' AND a.status != '已完成'
           ORDER BY a.planned_hours DESC"""
    )
    hits = []
    for row in rows:
        if float(row["planned_hours"] or 0) <= 0:
            continue
        if float(row["used_hours"] or 0) > 0:
            continue
        started = _parse(row["start_date"])
        if started is None or (today - started).days < days:
            continue
        hits.append(row)
    if not hits:
        return []
    worst = hits[0]
    shown = "；".join(
        f"{row['employee_name']}／{row['project_name']}"
        + (f"／{row['step_name']}" if row["step_name"] else "")
        for row in hits[:3]
    )
    return [_insight(
        f"{len(hits)} 条分配计划了工时但一直没开工",
        shown + ("…" if len(hits) > 3 else ""),
        f"这些分配都开始超过 {days} 天了，实际工时还是 0。"
        "要么是人被别的事占住，要么是这些分配已经作废但没清理。",
        severity=2,
        group="conflict",
    )]


def fmt_money(value):
    """洞察文本里用的金额显示：一万以上用「万」"""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return "0"
    if abs(number) >= 10000:
        return f"{number / 10000:,.1f} 万"
    return f"{number:,.0f}"


def format_insights(found):
    """把洞察列表拼成一段可读的文本，供小助手直接显示"""
    if not found:
        return (
            "我把项目、人、工时都对了一遍，没发现明显的异常。\n\n"
            "随着数据变多（多几个项目、多几周的工时），能发现的东西会更多。"
        )
    lines = [f"我主动看了一遍，发现 {len(found)} 件值得注意的事：", ""]
    for group_key in ("compare", "conflict"):
        group_items = [item for item in found if item["group"] == group_key]
        if not group_items:
            continue
        lines.append(f"—— {INSIGHT_GROUPS[group_key]} ——")
        lines.append("")
        for item in group_items:
            lines.append(f"· {item['title']}")
            lines.append(f"　　{item['detail']}")
            lines.append(f"　　建议：{item['advice']}")
            lines.append("")
    return "\n".join(lines).rstrip()


# ------------------------------------------------------------------ 小助手
#: 小助手常问的问题。界面上做成「点一下就问」的按钮。
SUGGESTIONS = [
    "现在什么情况",
    "哪个项目有风险",
    "谁最忙",
    "谁闲下来了",
    "预算要紧吗",
    "有多少人在岗",
    "哪些任务卡住了",
    "帮我看看有什么问题",
]


def urgent_suggestions(store):
    """根据当前数据，补充几条「现在就值得问」的问题。

    固定列表回答的是「助手会什么」；这里回答的是「你现在该关心什么」。

    注意：**必须给出固定列表里没有的问题**。
    去重规则会把与固定列表同名的条目过滤掉，
    所以这里要带上具体情况（如「哪 3 个任务卡住了」），
    否则加了等于没加——这个坑踩过一次。
    """
    extra = []

    # 有阻塞步骤：把数量写进问题里，既比固定那条具体，也不会被去重吃掉
    blocked = store.scalar(
        "SELECT COUNT(*) FROM step WHERE status = '已阻塞'", (), 0
    )
    if blocked:
        extra.append(f"哪 {blocked} 个任务卡住了" if blocked > 1
                     else "那个卡住的任务是谁负责的")

    # 有超预算的项目：点名是哪个
    over_names = []
    for row in store.projects():
        usage = budget_usage(row)
        if usage["has_budget"] and usage["over"]:
            over_names.append(row["name"])
    if over_names:
        extra.append(f"《{over_names[0]}》超了多少" if len(over_names) == 1
                     else f"这 {len(over_names)} 个超预算的项目分别超了多少")

    # 有人超负荷：点名是谁、超到什么程度
    date_from, date_to, days = _worklog_window(store)
    worst = None
    for row in store.hours_by_employee(date_from, date_to):
        ratio = load_ratio(row["hours"], row["weekly_hours"], days)
        if ratio > 1 and (worst is None or ratio > worst[1]):
            worst = (row, ratio)
    if worst:
        row, ratio = worst
        extra.append(f"{row['name']} 的负荷是多少")

    # 没有项目时给最容易上手的
    if not store.projects():
        extra = ["现在什么情况"]

    # 去重，并去掉已经在固定列表里的
    result = []
    for question in extra:
        if question not in SUGGESTIONS and question not in result:
            result.append(question)
    return result


def export_conversation(store, history, path):
    """把一次问答导出成纯文本，方便贴给别人或存档。

    history 是 [(是否用户提问, 文本), ...]
    """
    lines = [
        "项目记录器 —— 小助手问答记录",
        f"导出时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"数据文件：{store.path}",
        "（所有结论由本机规则引擎计算，不联网、不上传）",
        "",
        "=" * 50,
        "",
    ]
    for is_user, text in history:
        who = "问" if is_user else "答"
        lines.append(f"【{who}】")
        lines.append(text)
        lines.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return len(history)


def ask(store, question):
    """小助手：把自然语言问题映射到一次查询，再用中文回答。

    它**不做语义理解**，只做关键词匹配——所以回答的是「数据是什么」，
    而不是「我猜你想问什么」。匹配不到就老实地说明能问什么，
    不硬编一个看起来像答案的东西。

    命中顺序刻意从具体到宽泛：
    先看有没有提到某个项目名 / 人名，再看问的是哪一类。
    """
    text = (question or "").strip()
    if not text:
        return "问点什么吧，比如「谁最忙」「哪个项目有风险」。"
    today = _today()
    week_ago = (today - datetime.timedelta(days=6)).isoformat()

    # 先处理点名的项目：问「某某项目怎么样」比问「哪个有风险」更具体
    for row in store.projects():
        name = row["name"] or ""
        if name and name in text:
            return _answer_project(store, row)

    # 再处理点名的人
    for row in store.employees():
        name = row["name"] or ""
        if name and name in text:
            return _answer_employee(store, row, text)

    # ---- 主动发现：横向比较 ----
    if any(k in text for k in ("比一比", "横向比较", "对比项目", "哪个更划算", "效率")):
        found = [i for i in insights(store) if i["group"] == "compare"]
        return format_insights(found)

    # ---- 主动发现：逻辑矛盾 ----
    if any(k in text for k in ("矛盾", "对不上", "逻辑问题", "填错", "数据有问题")):
        found = [i for i in insights(store) if i["group"] == "conflict"]
        return format_insights(found)

    # ---- 主动发现：全部 ----
    if any(k in text for k in ("帮我看看", "有什么问题", "发现", "洞察", "检查一遍", "体检")):
        return format_insights(insights(store))

    # ---- 整体概况 ----
    if any(k in text for k in ("什么情况", "概况", "总览", "总结", "最近怎么样", "怎么样了")):
        return _answer_overview(store)

    # ---- 谁超负荷（比「谁最忙」更具体，要先判） ----
    if any(k in text for k in ("超负荷", "扛不住", "快撑不住", "顶不住", "加班")):
        return _answer_overloaded(store, week_ago, today)

    # ---- 超预算（比「预算」更具体，要先判） ----
    if any(k in text for k in ("超预算", "超支")):
        return _answer_over_budget(store)

    # ---- 风险 / 延期 ----
    if any(k in text for k in ("风险", "哪个项目", "延期", "危险", "要出事", "红灯")):
        return _answer_risk(store)

    # ---- 忙碌 / 负荷 ----
    if any(k in text for k in ("谁最忙", "最忙", "负荷", "工时最多", "累")):
        return _answer_busy(store, week_ago, today)

    # ---- 空闲 ----
    if any(k in text for k in ("谁闲", "闲下来", "空闲", "没事干", "工时最少", "有空")):
        return _answer_idle(store, week_ago, today)

    # ---- 预算 ----
    if any(k in text for k in ("预算", "花钱", "成本", "费用")):
        return _answer_budget(store)

    # ---- 人 ----
    if any(k in text for k in ("多少人", "在岗", "人员", "团队规模", "几个人")):
        return _answer_headcount(store, week_ago, today)

    # ---- 阻塞 ----
    if any(k in text for k in ("阻塞", "卡住", "堵", "卡在", "卡了")):
        return _answer_blocked(store)

    # ---- 兜底：老实说能问什么 ----
    return (
        "我没理解这个问题。我能回答这几类：\n"
        "　· 现在什么情况　　　　整体概况和该先看哪个项目\n"
        "　· 哪个项目有风险　　　列出需要介入的项目\n"
        "　· 谁最忙 / 谁超负荷　 按工时和负荷排行\n"
        "　· 谁闲下来了　　　　　没记工时的人\n"
        "　· 预算要紧吗 / 哪些超预算了\n"
        "　· 有多少人在岗　　　　人力和本周总投入\n"
        "　· 哪些任务卡住了　　　所有「已阻塞」的步骤\n\n"
        "也可以直接说项目名或人名，例如「智慧园区二期怎么样」「李工最近做了什么」。"
    )


# ---- 各类回答。都返回纯文本，界面直接显示 ----
def _answer_overview(store):
    rows = load_summary(store)
    if not rows:
        return "还没有项目。点右上角「新建项目」开始。"
    # 概况里的工时也该用同一个窗口，否则「最近 7 天」和负荷分析的窗口对不上
    date_from, date_to, days = _worklog_window(store)
    hours = store.hours_by_employee(date_from, date_to)
    total_hours = sum_hours(hours)
    busy = [row for row in hours if num(row["hours"]) > 0]
    bad = [p for p in rows if p["level"] in ("风险", "严重")]

    lines = [
        f"共 {len(rows)} 个项目，最近 {days} 天投入 {total_hours:,.1f} 小时、"
        f"{len(busy)} 人在干活。",
        "",
    ]
    if bad:
        lines.append(f"需要优先处理的 {len(bad)} 个：")
        for project in bad[:4]:
            lines.append(f"　[{project['level']}] {project['name']}：{project['headline']}")
    else:
        lines.append("没有高风险项目。")
        if rows:
            lines.append(f"最需要注意的是：{rows[0]['name']} —— {rows[0]['headline']}")
    return "\n".join(lines)


def _answer_risk(store):
    rows = load_summary(store)
    if not rows:
        return "还没有项目。"
    bad = [p for p in rows if p["level"] in ("风险", "严重")]
    if not bad:
        healthy = [p for p in rows if p["level"] == "健康"]
        if len(healthy) == len(rows):
            return "所有项目都是健康状态，暂时不用特别关注。"
        return ("目前没有高风险项目。\n"
                f"最需要注意的是：{rows[0]['name']} —— {rows[0]['headline']}")
    lines = [f"有 {len(bad)} 个项目需要处理："]
    for project in bad[:6]:
        lines.append(f"　[{project['level']}] {project['name']}")
        lines.append(f"　　　{project['headline']}")
    lines.append("")
    lines.append("想细看某一个，直接问它的名字，例如「智慧园区二期怎么样」。")
    return "\n".join(lines)


def _answer_busy(store, week_ago, today):
    date_from, date_to, days = _worklog_window(store)
    rows = store.hours_by_employee(date_from, date_to)
    if not rows:
        return "还没有员工记录。"
    worked = [row for row in rows if float(row["hours"] or 0) > 0]
    if not worked:
        return f"最近 {days} 天没有人在项目上记过工时。"
    lines = [f"最近 {days} 天的负荷排行："]
    over = []
    for row in worked[:8]:
        ratio = load_ratio(row["hours"], row["weekly_hours"], days)
        flag = ""
        if ratio > 1:
            flag = "　← 超负荷"
            over.append(row["name"])
        lines.append(f"　{row['name']}：{float(row['hours']):.1f} 小时"
                     f"（同期应出 {metrics.expected_hours(row['weekly_hours'], days):.0f} 小时，"
                     f"占用 {ratio * 100:.0f}%）{flag}")
    if over:
        lines.append("")
        lines.append(f"{'、'.join(over)} 已经超出同期应出工时，"
                     "长期这样会出问题——要么加人，要么砍范围。")
    return "\n".join(lines)


def _answer_idle(store, week_ago, today):
    date_from, date_to, days = _worklog_window(store)
    rows = store.hours_by_employee(date_from, date_to)
    if not rows:
        return "还没有员工记录。"
    idle = [row for row in rows if float(row["hours"] or 0) <= 0]
    if not idle:
        light = sorted(rows, key=lambda r: float(r["hours"] or 0))[:3]
        lines = [f"没有完全闲着的，最近 {days} 天负荷最轻的三个："]
        for row in light:
            lines.append(f"　{row['name']}：{float(row['hours']):.1f} 小时")
        return "\n".join(lines)
    lines = [f"最近 {days} 天有 {len(idle)} 个人没有工时记录："]
    for row in idle[:10]:
        role = row["role"] if "role" in row.keys() else ""
        lines.append(f"　{row['name']}（{role or '未填岗位'}）")
    lines.append("")
    lines.append("可能是没记工时，也可能是真的闲着——建议确认一下。")
    return "\n".join(lines)


def _answer_budget(store):
    rows = store.projects()
    if not rows:
        return "还没有项目。"
    lines = []
    problems = []
    for row in rows:
        usage = budget_usage(row)
        if not usage["has_budget"]:
            continue
        ratio = usage["used_ratio"]
        if usage["over"]:
            problems.append(row["name"])
        lines.append(f"　{row['name']}：{ratio * 100:.0f}%"
                     f"（{usage['budget'] / 10000:,.1f} 万预算，"
                     f"已花 {usage['cost'] / 10000:,.1f} 万）")
    if not lines:
        return "所有项目都还没填预算，建议补上——不然没法提前发现超支。"
    header = ["各项目的预算占用："] + lines
    if problems:
        header.append("")
        header.append(f"{'、'.join(problems)} 已经超预算，建议核对超支科目。")
    return "\n".join(header)


def _answer_headcount(store, week_ago, today):
    date_from, date_to, days = _worklog_window(store)
    rows = store.hours_by_employee(date_from, date_to)
    active = [row for row in rows if float(row["hours"] or 0) > 0]
    total = sum(float(row["hours"] or 0) for row in rows)
    lines = [
        f"在岗 {len(rows)} 人，最近 {days} 天有工时的 {len(active)} 人。",
        f"这 {days} 天合计投入 {total:,.1f} 小时。",
    ]
    if len(active) < len(rows):
        idle = [row["name"] for row in rows if float(row["hours"] or 0) <= 0]
        lines.append(f"没记工时的：{'、'.join(idle[:8])}")
    return "\n".join(lines)


def _answer_blocked(store):
    found = []
    for row in store.projects():
        for step in store.steps(row["id"]):
            if step["status"] == "已阻塞":
                found.append((row["name"], dict(step)))
    if not found:
        return "所有项目都没有「已阻塞」的步骤。"
    lines = [f"有 {len(found)} 个步骤卡住了："]
    for project_name, step in found:
        due = f"，计划 {step['due_date']}" if step["due_date"] else ""
        lines.append(f"　{project_name} / {step['name']}"
                     f"（负责人 {step['owner'] or '未指定'}{due}）")
    lines.append("")
    lines.append("阻塞通常不是靠加人能解决的——先弄清楚卡在谁那里。")
    return "\n".join(lines)


def _answer_overloaded(store, week_ago, today):
    """只看超负荷的人——比「谁最忙」更聚焦，直接给处理建议"""
    date_from, date_to, days = _worklog_window(store)
    rows = store.hours_by_employee(date_from, date_to)
    over = []
    for row in rows:
        ratio = load_ratio(row["hours"], row["weekly_hours"], days)
        if ratio > 1:
            over.append((row, ratio))
    if not over:
        return f"最近 {days} 天没有人超出同期应出工时。"

    over.sort(key=lambda pair: -pair[1])
    lines = [f"最近 {days} 天有 {len(over)} 个人超负荷："]
    for row, ratio in over:
        lines.append(
            f"　{row['name']}：{float(row['hours']):.1f} 小时 / 同期应出 "
            f"{metrics.expected_hours(row['weekly_hours'], days):.0f}，超出 {ratio * 100 - 100:.0f}%"
        )
    lines.append("")
    lines.append("超负荷不会立刻出事，但会以质量下降、延期、离职的形式在后面还回来。")
    lines.append("要么把他手上的事分出去，要么明确砍掉一部分范围。")
    return "\n".join(lines)


def _answer_over_budget(store):
    """只看超预算的项目"""
    over = []
    for row in store.projects():
        usage = budget_usage(row)
        if usage["has_budget"] and usage["over"]:
            over.append((row, usage["used_ratio"]))
    if not over:
        return "没有项目超出预算。"
    lines = [f"有 {len(over)} 个项目已经超预算："]
    for row, ratio in over:
        lines.append(
            f"　{row['name']}：{ratio * 100:.0f}%"
            f"（预算 {float(row['budget']) / 10000:,.1f} 万，"
            f"已花 {float(row['cost']) / 10000:,.1f} 万）"
        )
    lines.append("")
    lines.append("建议核对超支科目：是估算偏乐观，还是范围变了没走变更。")
    return "\n".join(lines)


def _answer_project(store, row):
    result = predict(store, row["id"])
    if not result:
        return f"读不到《{row['name']}》的数据。"
    lines = [
        f"《{row['name']}》—— {result['level']}",
        f"负责人 {row['owner'] or '未指定'} · 状态 {row['status']} · "
        f"进度 {row['progress']}%",
        "",
        result["headline"],
        "",
    ]
    for reason in result["reasons"]:
        detail = reason.get("detail", "")
        lines.append(f"　· {reason['text']}" + (f"（{detail}）" if detail else ""))
    if result["actions"]:
        lines.append("")
        lines.append("建议：")
        for action in result["actions"]:
            lines.append(f"　· {action}")

    metrics = result["metrics"]
    lines.append("")
    lines.append(f"投入 {metrics['total_hours']:,.1f} 小时、"
                 f"{metrics['people_count']} 人；"
                 f"步骤完成 {metrics['step_done']}/{metrics['step_total']}。")
    return "\n".join(lines)


def _answer_employee(store, row, text):
    """回答关于某个人的问题。

    「负荷」用和洞察一致的窗口和算法——不能这里 7 天、那里 28 天，
    否则同一个人同一个数据会给出两个答案。
    """
    today = _today()
    month_start = today.replace(day=1).isoformat()
    logs = store.worklogs(employee_id=row["id"],
                          date_from=month_start, date_to=today.isoformat())
    total = sum(float(log["hours"] or 0) for log in logs)

    date_from, date_to, days = _worklog_window(store)
    window_rows = [r for r in store.hours_by_employee(date_from, date_to)
                   if r["id"] == row["id"]]
    window_hours = float(window_rows[0]["hours"]) if window_rows else 0.0
    weekly = float(row["weekly_hours"] or 40)
    ratio = load_ratio(window_hours, weekly, days)

    lines = [
        f"{row['name']}（{row['role'] or '未填岗位'}"
        + (f" · {row['level']}" if row["level"] else "") + "）",
        "",
        f"本月 {total:.1f} 小时，共 {len(logs)} 条记录。",
        f"最近 {days} 天 {window_hours:.1f} 小时，"
        f"同期应出 {weekly * days / 7:.0f} 小时，负荷 {ratio * 100:.0f}%"
        + ("　← 超负荷" if ratio > 1 else ""),
    ]
    if logs:
        lines.append("")
        lines.append("最近几条：")
        for log in logs[:8]:
            where = log["project_name"] or "非项目"
            lines.append(f"　{log['work_date']}　{float(log['hours']):.1f}h　"
                         f"[{where}] {log['content'][:24]}")
    else:
        lines.append("")
        lines.append("本月还没有工时记录。")
    return "\n".join(lines)

