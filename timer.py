"""计时器：真实流逝，不能快进。

## 先说清能做和不能做

员工的程序跑在他自己的电脑上，**他对那台机器有完全控制权**。
所以本地计时**做不到无法篡改**。真正无法作弊只有一个前提：
计时结果实时上报到服务器。而这套方案是文件交换、不联网，那条路断了。

所以这里做的是**篡改可被发现**，三件事：

1. **时长用单调时钟算**（`time.monotonic()`）
   改系统时间不会让它跳。改成明天、改成昨天，计时器都照常走。

2. **同时记下墙钟时间**，导入时两边交叉核对
   如果员工中途改了系统时间，两个时钟说出来的时长就对不上，
   老板那边会看到「时间戳可疑」。**改得越狠，越明显。**

3. **异常全部报出来**，不静默接受
   一天超 24 小时、时间段重叠、单次超长、跨天没停。

## 为什么保留手工补录

只能计时的话，开会、见客户、临时处理线上问题这些都没法记，
员工会开始**乱计时凑数**——比手工填更糟。
所以补录保留，但**在数据里明确标记**（`source='manual'`），
老板一看就知道哪些是计时的、哪些是补的。
这个区分比「禁止补录」有用得多。
"""
import datetime
import time

__all__ = ["Timer", "format_duration", "parse_timestamp", "check_session",
           "check_worklog", "MIN_SECONDS"]

#: 太短的会话不记账（点错了立刻停）。1 分钟。
MIN_SECONDS = 60

#: 单次会话超过这个小时数就提醒（大概是挂机忘了停）
LONG_SESSION_HOURS = 12

#: 一天总工时超过这个数就提醒
DAILY_LIMIT_HOURS = 24


def now_iso():
    """当前时间的 ISO 文本（秒精度）"""
    return datetime.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def parse_timestamp(text):
    """解析会话里的时间戳。认不出来返回 None。"""
    if not text:
        return None
    raw = str(text).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def format_duration(seconds):
    """秒数变成 3:07:25 这种好读的样子"""
    seconds = max(0, int(seconds or 0))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}"


def format_hours(seconds):
    """秒数变成「3.12 小时」"""
    return f"{max(0.0, float(seconds or 0)) / 3600:.2f}"


class Timer:
    """一个人一个计时器。

    状态放在数据库里（session 表），所以关掉程序再打开，
    计时还能接着走——不会因为「电脑重启了」就丢掉已经干了的时间。

    **时长永远用单调时钟算**，不碰系统时间。
    """

    def __init__(self, store, employee_id, clock=None):
        self.store = store
        self.employee_id = employee_id
        # 允许注入时钟，测试里就不用真的等三小时
        self._clock = clock or time.monotonic
        #: 最近一次 start() 建出来的会话 id，供调用方需要时取用。
        #: 不用返回值传是因为 start/pause/resume/finish 应当返回同一种形状
        #: ——(成功?, 说明)。混着 2 元组和 3 元组迟早会 unpack 出错。
        self.last_session_id = None

    # ------------------------------------------------------------ 查询
    def current(self):
        """当前会话（可能正在跑、可能暂停）。没有就返回 None。"""
        return self.store.running_session(self.employee_id)

    def status(self):
        session = self.current()
        if session is None:
            return "idle"
        return session["status"]

    def elapsed_seconds(self):
        """已经过了多少秒。

        跑着的时候 = 已累计 + (现在 - 起点)。
        暂停时 = 已累计。
        """
        session = self.current()
        if session is None:
            return 0.0
        elapsed = float(session["elapsed"] or 0)
        if session["status"] == "running":
            elapsed += max(0.0, self._clock() - float(session["mono_start"] or 0))
        return elapsed

    # ------------------------------------------------------------ 操作
    def start(self, project_id=None, step_id=None, content="", work_date=None):
        """开始计时。返回 (成功?, 说明)——和其他方法保持同样的形状。

        如果已经有在跑的会话，**先把它停下**再开新的——
        一个人不可能同时干两件事，与其报错让他手动停，
        不如自动停（并把停下的那条记账），这更符合实际。
        """
        stopped = ""
        existing = self.current()
        if existing is not None:
            ok, message = self.finish()
            if not ok:
                return False, message
            stopped = "（已自动结束上一段计时）"

        today = work_date or datetime.date.today().isoformat()
        self.last_session_id = self.store.add_session({
            "employee_id": self.employee_id,
            "project_id": project_id,
            "step_id": step_id,
            "work_date": today,
            "mono_start": self._clock(),
            "elapsed": 0.0,
            "started_at": now_iso(),
            "ended_at": "",
            "status": "running",
            "content": content,
            "manual": 0,
        })
        return True, f"开始计时{stopped}"

    def pause(self):
        """暂停。把已经过的时长固化进 elapsed。"""
        session = self.current()
        if session is None:
            return False, "现在没有在计时的任务。"
        if session["status"] == "paused":
            return False, "已经在暂停中了。"
        self.store.update_session(session["id"], {
            "elapsed": self.elapsed_seconds(),
            "status": "paused",
        })
        return True, "已暂停"

    def resume(self):
        """继续。单调时钟重新取起点，已累计的时长保留。"""
        session = self.current()
        if session is None:
            return False, "现在没有暂停中的任务。"
        if session["status"] == "running":
            return False, "已经在计时了。"
        self.store.update_session(session["id"], {
            "mono_start": self._clock(),
            "status": "running",
        })
        return True, "继续计时"

    def finish(self, content=None):
        """结束并记一条工时。

        太短（不到 1 分钟）就直接丢掉，不生成工时——
        点错了立刻停是常事，记一条 0.02 小时的记录只会添乱。
        """
        session = self.store.running_session(self.employee_id)
        if session is None:
            return False, "现在没有在计时的任务。"

        elapsed = self.elapsed_seconds()
        # 先把会话结束掉，避免后面出错时留下一个一直跑的会话
        self.store.update_session(session["id"], {
            "elapsed": elapsed,
            "ended_at": now_iso(),
            "status": "finished",
            **({"content": content} if content is not None else {}),
        })

        if elapsed < MIN_SECONDS:
            return False, (f"只计了 {format_duration(elapsed)}，太短了没有记账。"
                           "如果确实干了活，用「补录」记上。")

        hours = round(elapsed / 3600.0, 2)
        final_content = content if content is not None else session["content"]
        # 计时器记的**不去重**：同一天做了两段时长相同、说明相同的活，
        # 那是两条真实记录，不能被数据库吞掉。
        self.store.add_worklog({
            "employee_id": self.employee_id,
            "project_id": session["project_id"],
            "step_id": session["step_id"],
            "work_date": session["work_date"],
            "hours": hours,
            "content": final_content or "",
            "source": "timer",
        }, dedupe=False)
        return True, f"已记录 {hours:.2f} 小时（{format_duration(elapsed)}）"

    def cancel(self):
        """丢弃当前会话，不记账。点错了用这个。"""
        session = self.current()
        if session is None:
            return False, "现在没有在计时的任务。"
        self.store.delete_session(session["id"])
        return True, "已丢弃这段计时"

    def update_target(self, project_id=None, step_id=None, content=None):
        """计时过程中换项目/步骤/说明"""
        session = self.current()
        if session is None:
            return False, "现在没有在计时的任务。"
        data = {}
        if project_id is not None:
            data["project_id"] = project_id
        if step_id is not None:
            data["step_id"] = step_id
        if content is not None:
            data["content"] = content
        if data:
            self.store.update_session(session["id"], data)
        return True, "已更新"


# ------------------------------------------------------------------ 校验
def check_session(session):
    """检查一段计时会话有没有可疑之处。返回问题列表（空表示正常）。

    这里就是「篡改可被发现」的落点：
    单调时钟说过了多久、墙钟说过了多久，两者必须对得上。
    """
    problems = []
    elapsed = float(session.get("elapsed") or 0)
    started = parse_timestamp(session.get("started_at"))
    ended = parse_timestamp(session.get("ended_at"))

    if session.get("manual"):
        return problems        # 补录本来就没有真实的起止时间

    if elapsed < 0:
        problems.append("时长为负")
    if started and ended:
        wall_seconds = (ended - started).total_seconds()
        diff = abs(wall_seconds - elapsed)
        # 允许 90 秒误差：进程调度、系统休眠恢复都可能有点偏差
        if diff > 90:
            problems.append(
                f"时间戳对不上：时长说 {format_duration(elapsed)}，"
                f"起止时间说 {format_duration(wall_seconds)}——"
                "中途可能改过系统时间"
            )
        if ended < started:
            problems.append("结束时间早于开始时间")
    if elapsed > LONG_SESSION_HOURS * 3600:
        problems.append(
            f"单次计时 {elapsed / 3600:.1f} 小时，"
            "可能是挂机忘了停，请确认"
        )
    return problems


def check_worklog(entries):
    """检查一批工时记录有没有互相矛盾之处。

    这里抓的是**光看单条发现不了的问题**：
    一天加起来超过 24 小时、同一时段有两段计时。

    entries 是 [{"work_date", "hours", "source", "started_at", "ended_at",
                 "content", "project"}]
    返回 [(日期, 问题描述), ...]
    """
    problems = []

    # 按天汇总
    by_day = {}
    for entry in entries or []:
        day = str(entry.get("work_date") or "").strip()
        if not day:
            continue
        by_day.setdefault(day, []).append(entry)

    for day, items in sorted(by_day.items()):
        total = sum(float(item.get("hours") or 0) for item in items)
        if total > DAILY_LIMIT_HOURS:
            problems.append((day, f"这天合计 {total:.1f} 小时，超过 24 小时"))

        # 时间段重叠：只对带起止时间的计时记录做
        spans = []
        for item in items:
            if item.get("manual"):
                continue
            start = parse_timestamp(item.get("started_at"))
            end = parse_timestamp(item.get("ended_at"))
            if start and end and end > start:
                spans.append((start, end, item))
        spans.sort(key=lambda pair: pair[0])
        for index in range(1, len(spans)):
            prev_start, prev_end, _ = spans[index - 1]
            cur_start, cur_end, cur = spans[index]
            if cur_start < prev_end:
                where = cur.get("project") or "非项目"
                problems.append(
                    (day, f"时间段重叠：{prev_start:%H:%M}~{prev_end:%H:%M} "
                          f"与 {cur_start:%H:%M}~{cur_end:%H:%M}（{where}）")
                )
    return problems
