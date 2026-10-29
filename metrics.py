"""公共计算：把散落各处的口径收拢到一处。

为什么需要这个文件：
    这些计算原先在 rules.py / main.py / detail.py / export.py 里各写了一遍。
    结果出过真实的 bug——「负荷率」有 5 个副本，改口径时漏掉 4 个，
    导致同一个人同一个数据在不同页面显示两个不同的数字；
    「预算占用」有 6 个副本，其中一个忘了除零保护，会让整个驾驶舱崩掉。

    所以：**任何一个计算只允许有一处定义。**
    这不只是少写代码，而是让「改口径」变成一个安全操作。

这里的函数全是纯函数（不碰界面、不碰数据库连接），
所以可以在 check.py 里单独验证，不必启动程序。
"""
import datetime

__all__ = [
    "num", "safe_div", "text", "days_between", "parse_date", "fmt_date",
    "worklog_window", "sum_hours", "load_ratio", "expected_hours",
    "budget_usage", "steps_from_progress", "step_stats", "aggregate_hours",
    "progress_gap", "days_left",
]

#: 负荷分析的默认窗口：先看 7 天，没数据就放宽到 28 天
PREFERRED_DAYS = 7
EXTENDED_DAYS = 28


# ------------------------------------------------------------------ 数值兜底
def num(value, default=0.0):
    """把任意值安全地转成数字。

    `float(x or 0)` 这个写法在项目里出现过 40 多次，
    但它对字符串 "abc" 会抛异常，对 None 才返回默认值。
    统一走这里，免得每处都要想一遍边界情况。
    """
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def safe_div(numerator, denominator, default=0.0):
    """安全除法。分母为 0（或非数字）时返回 default，不抛异常。

    预算、负荷率这类计算全靠它——除零在界面上是崩，不是警告。
    """
    top = num(numerator)
    bottom = num(denominator)
    if bottom == 0:
        return default
    return top / bottom


def text(value, default=""):
    """把可能为 None 的字段转成字符串"""
    if value is None:
        return default
    return str(value)


# ------------------------------------------------------------------ 日期
def parse_date(value):
    """宽松解析日期，返回 datetime.date 或 None。

    库里统一存 YYYY-MM-DD，但手工录入难免有杂音，
    所以多试几种分隔符，而不是直接 strptime 抛异常。
    """
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y%m%d"):
        try:
            return datetime.datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def fmt_date(value):
    """日期转成中文写法，用于结论文本"""
    date = value if isinstance(value, datetime.date) else parse_date(value)
    return date.strftime("%Y年%m月%d日") if date else "（未定）"


def days_between(start, end):
    """两个日期相差几天。任一为空就返回 None。"""
    if isinstance(start, str):
        start = parse_date(start)
    if isinstance(end, str):
        end = parse_date(end)
    if start is None or end is None:
        return None
    return (end - start).days


def days_left(due, today=None):
    """距截止还有几天。已过期返回负数，没截止返回 None。"""
    today = today or datetime.date.today()
    due_date = due if isinstance(due, datetime.date) else parse_date(due)
    if due_date is None:
        return None
    return (due_date - today).days


# ------------------------------------------------------------------ 时间窗口
def worklog_window(store, today=None, preferred=PREFERRED_DAYS,
                   extended=EXTENDED_DAYS):
    """确定负荷分析该看多长时间，返回 (起始日, 结束日, 天数)。

    优先用最近 7 天。但如果 7 天内一条工时都没有（刚上手、或这阵子没记），
    就放宽到 28 天——否则「谁超负荷」这类判断永远发现不了。

    关键：**返回的天数必须一路传到负荷计算里**，
    因为负荷率的分母是「周基准 × 周数」，
    窗口变了而分母不变的话，所有人都被算成超负荷。
    """
    today = today or datetime.date.today()
    for days in (preferred, extended):
        start = today - datetime.timedelta(days=days - 1)
        count = store.scalar(
            "SELECT COUNT(*) FROM worklog WHERE work_date >= ? AND work_date <= ?",
            (start.isoformat(), today.isoformat()), 0,
        )
        if count:
            return start.isoformat(), today.isoformat(), days
    start = today - datetime.timedelta(days=preferred - 1)
    return start.isoformat(), today.isoformat(), preferred


# ------------------------------------------------------------------ 负荷
def expected_hours(weekly_hours, days):
    """这段时间里，一个人按周基准应该出多少小时。

    这是负荷率的分母。单独抽出来是因为它原来在 4 个地方各写了一遍
    `weekly * days / 7`，有一处写成了 `weekly`（漏乘周数），
    导致 28 天窗口下所有人被判超负荷。
    """
    return num(weekly_hours) * num(days) / 7.0


def load_ratio(hours, weekly_hours, days):
    """负荷率 = 这段时间的工时 ÷ 同期应出工时。

    1.0 表示刚好满负荷，超过 1.0 是超负荷。
    周基准为 0 或天数非法时返回 0，不抛异常。
    """
    expected = expected_hours(weekly_hours, days)
    if expected <= 0:
        return 0.0
    return num(hours) / expected


def sum_hours(rows, key="hours"):
    """把一批记录的工时加起来。字段缺失或为空都按 0 算。"""
    return sum(num(row[key] if key in row.keys() else 0) for row in (rows or []))


def aggregate_hours(rows):
    """把工时明细按「员工 + 项目 + 步骤」聚合成字典。

    任务分配页要用它来对比「计划工时」和「实际工时」：
    实际工时不单独存，而是从工时记录里按这三个维度算出来的。
    """
    totals = {}
    for log in rows or []:
        key = (log["employee_id"], log["project_id"], log["step_id"])
        totals[key] = totals.get(key, 0.0) + num(log["hours"])
    return totals


# ------------------------------------------------------------------ 预算
def budget_usage(project):
    """预算占用情况，返回一个字典。

    一次性给出界面上要用的所有量，避免每处各自算一遍——
    之前 6 个副本里有 1 个忘了判断预算为 0，会让驾驶舱整个崩掉。

    返回的 used_ratio 在没设预算时是 None（而不是 0），
    这样界面能区分「没设预算」和「花了 0%」。
    """
    budget = num(project["budget"] if "budget" in project.keys() else 0)
    cost = num(project["cost"] if "cost" in project.keys() else 0)
    if budget <= 0:
        return {
            "budget": 0.0, "cost": cost, "used_ratio": None,
            "remaining": 0.0, "over": False, "has_budget": False,
        }
    ratio = cost / budget
    return {
        "budget": budget,
        "cost": cost,
        "used_ratio": ratio,
        "remaining": budget - cost,
        "over": ratio >= 1.0,
        "has_budget": True,
    }


# ------------------------------------------------------------------ 步骤
def step_stats(steps):
    """统计步骤的完成情况。

    原来这套统计在两处各写了一份：一处是 SQL 的子查询（给驾驶舱用），
    一处是 Python 里遍历（给预测引擎用）。口径一致但代码重复，
    改判定标准时要改两个地方。
    """
    steps = steps or []
    total = len(steps)
    done = doing = blocked = not_started = 0
    for step in steps:
        status = text(step["status"] if "status" in step.keys() else "")
        if status == "已完成":
            done += 1
        elif status == "进行中":
            doing += 1
        elif status == "已阻塞":
            blocked += 1
        else:
            not_started += 1
    return {
        "total": total,
        "done": done,
        "doing": doing,
        "blocked": blocked,
        "not_started": not_started,
        # 按「已完成」算的完成率，用来和 project.progress 对比
        "done_ratio": safe_div(done, total),
    }


def steps_from_progress(progress_percent, completed_count, total_count):
    """进度百分比和步骤完成数是否自相矛盾。

    老板经常只改「进度」字段，忘了改步骤状态，
    于是出现「进度写 80%，但 10 个步骤只完成了 2 个」。
    这里给出两者各自的完成率，让上层判断要不要提醒。
    """
    return {
        "progress_ratio": num(progress_percent) / 100.0,
        "step_ratio": safe_div(completed_count, total_count),
    }


def progress_gap(progress_percent, time_ratio):
    """进度和时间的错位：时间是 75% 而进度只有 35%，就落后 40 个百分点。

    返回正数表示落后（时间过得比进度快），负数表示领先。
    """
    return num(time_ratio) - num(progress_percent) / 100.0
