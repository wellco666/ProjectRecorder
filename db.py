"""数据层：SQLite 连接、建表、以及所有增删改查。

界面层不直接写 SQL —— 全走这里。这样有两个好处：
  1. 表结构改动只改一个文件
  2. 查询逻辑可以单独跑、单独验证，不必启动界面

数据文件固定在 ~/ProjectRecorder/projects.db，
和程序放在哪无关，换 exe 位置、重装都不会丢数据。
"""
import os
import sqlite3
import sys
import threading

__all__ = ["Store", "DB_DIR", "DB_PATH", "SCHEMA_PATH", "shared_write_lock",
           "PROJECT_STATUS", "PRIORITY", "STEP_STATUS", "ASSIGN_STATUS",
           "KNOWLEDGE_ZONES", "KNOWLEDGE_KINDS", "KNOWLEDGE_STATUS"]

#: 界面线程和局域网服务线程共用这把锁。
#: SQLite 同一时刻只允许一个写入者，两边必须串起来，
#: 否则会出现「database is locked」或者写入丢失。
_WRITE_LOCK = threading.RLock()


def shared_write_lock():
    return _WRITE_LOCK


# 去重指纹的唯一实现放在 submit.py 里（导入和补历史都靠它）。
# 这里只是转发，避免两处各写一份算法——那正是以前出过问题的模式。
from submit import source_key  # noqa: E402  （放在常量之后，避免循环导入）

DB_DIR = os.path.join(os.path.expanduser("~"), "ProjectRecorder")
DB_PATH = os.path.join(DB_DIR, "projects.db")


def _resource_path(*parts):
    """源码运行和 PyInstaller 打包后都能找到 schema.sql"""
    base = getattr(sys, "_MEIPASS", None)
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, *parts)


SCHEMA_PATH = _resource_path("schema.sql")

PROJECT_STATUS = ["规划中", "进行中", "已暂停", "已交付", "已取消"]
PRIORITY = ["高", "中", "低"]
STEP_STATUS = ["未开始", "进行中", "已完成", "已阻塞"]
ASSIGN_STATUS = ["待开始", "进行中", "已完成"]
KNOWLEDGE_ZONES = ["实际知识", "关联知识", "潜在知识", "原始知识"]
KNOWLEDGE_KINDS = ["显性知识", "隐性知识"]
KNOWLEDGE_STATUS = ["种子", "探索中", "已沉淀"]


class Store:
    """一个连接走天下。桌面单用户场景不需要连接池。

    关于线程：界面用一个 Store，局域网服务用**另一个** Store。
    sqlite3 的连接默认不能跨线程使用，所以服务线程必须自己开一个；
    同时 SQLite 同一时刻只允许一个写入者，两边的写操作用 _write_lock 串起来。
    """

    #: 跨线程写入锁。只有需要被服务线程和界面线程共用的实例才会传进来。
    def __init__(self, path=DB_PATH, write_lock=None):
        # :memory: 是内存库，没有目录可建；空目录名也要跳过，
        # 否则 os.makedirs("") 会抛 FileNotFoundError
        folder = os.path.dirname(path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        self.path = path
        self._lock = write_lock or threading.RLock()
        # check_same_thread=False：允许服务线程用这个连接。
        # 真正的并发保护靠 self._lock，不是靠 sqlite3 的线程检查。
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        # 服务线程和界面同时写时，等锁而不是立刻报 database is locked
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self._create_tables()

    def _create_tables(self):
        try:
            with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
                self.conn.executescript(f.read())
        except OSError as error:
            # 说清楚找的是哪个路径，否则打包后出问题很难查
            raise OSError(
                f"读不到建表脚本，数据库无法初始化。\n"
                f"路径：{SCHEMA_PATH}\n"
                f"原因：{error}"
            ) from error
        self._migrate()
        self.conn.commit()

    def _migrate(self):
        """给老数据库补上后加的列。

        schema.sql 用的是 CREATE TABLE IF NOT EXISTS，对**已存在**的表
        不会补新列。所以每次加了字段，这里也要能把它加上——
        否则老用户升级后一运行就报「no such column」。
        """
        self._ensure_column("worklog", "source_key", "TEXT NOT NULL DEFAULT ''")
        self._ensure_column("worklog", "source", "TEXT NOT NULL DEFAULT 'manual'")
        # 补完列再给老记录填指纹，否则唯一索引建不上（一堆空指纹会撞）
        self._backfill_source_keys()
        # 唯一索引统一在这里建，不放 schema.sql：
        # 老库的 worklog 表那时还没有 source_key 列，
        # schema.sql 里建索引会在添加列之前执行，直接报 no such column。
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_worklog_source "
            "ON worklog(project_id, source_key) WHERE source_key <> ''"
        )

    def _ensure_column(self, table, column, definition):
        columns = [row["name"] for row in
                   self.conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if column not in columns:
            self.conn.execute(
                f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
            )

    def _backfill_source_keys(self):
        """给还没有指纹的老记录算一个。

        指纹按「员工 + 项目 + 日期 + 工时 + 说明」算，
        和导入时用的是同一个算法，所以老数据也不会重复导入。
        """
        rows = self.conn.execute(
            "SELECT id, employee_id, project_id, work_date, hours, content "
            "FROM worklog WHERE source_key = ''"
        ).fetchall()
        for row in rows:
            key = source_key(
                row["employee_id"], row["project_id"], row["work_date"],
                row["hours"], row["content"],
            )
            self.conn.execute(
                "UPDATE worklog SET source_key = ? WHERE id = ?", (key, row["id"])
            )

    def close(self):
        self.conn.close()

    # ------------------------------------------------------------ 通用执行
    def execute(self, sql, params=()):
        """写操作。全程持锁：服务线程和界面同时写时排队，不会撞库。"""
        with self._lock:
            cursor = self.conn.execute(sql, params)
            self.conn.commit()
            return cursor

    def query(self, sql, params=()):
        with self._lock:
            return self.conn.execute(sql, params).fetchall()

    def one(self, sql, params=()):
        with self._lock:
            return self.conn.execute(sql, params).fetchone()

    def scalar(self, sql, params=(), default=0):
        with self._lock:
            row = self.conn.execute(sql, params).fetchone()
        if row is None or row[0] is None:
            return default
        return row[0]

    # ------------------------------------------------------------ 项目
    def projects(self, status=None, keyword=""):
        sql = "SELECT * FROM project"
        where, params = [], []
        if status:
            where.append("status = ?")
            params.append(status)
        if keyword:
            where.append("(name LIKE ? OR owner LIKE ? OR client LIKE ?)")
            params += [f"%{keyword}%"] * 3
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY CASE priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, id DESC"
        return self.query(sql, params)

    def project(self, project_id):
        return self.one("SELECT * FROM project WHERE id = ?", (project_id,))

    def add_project(self, data):
        fields = ("name", "owner", "client", "status", "priority",
                  "start_date", "due_date", "budget", "cost", "progress", "note")
        values = [data.get(f, "") for f in fields]
        cursor = self.execute(
            f"INSERT INTO project ({','.join(fields)}) VALUES ({','.join('?' * len(fields))})",
            values,
        )
        return cursor.lastrowid

    def update_project(self, project_id, data):
        allowed = ("name", "owner", "client", "status", "priority",
                   "start_date", "due_date", "budget", "cost", "progress", "note")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        sql = "UPDATE project SET " + ", ".join(f"{f} = ?" for f, _ in pairs) + " WHERE id = ?"
        self.execute(sql, [v for _, v in pairs] + [project_id])

    def delete_project(self, project_id):
        self.execute("DELETE FROM project WHERE id = ?", (project_id,))

    # ------------------------------------------------------------ 步骤
    def steps(self, project_id):
        return self.query(
            "SELECT * FROM step WHERE project_id = ? ORDER BY seq, id", (project_id,)
        )

    def add_step(self, project_id, data):
        seq = data.get("seq")
        if seq is None:
            seq = int(self.scalar(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM step WHERE project_id = ?",
                (project_id,), 1,
            ))
        cursor = self.execute(
            """INSERT INTO step (project_id, seq, name, owner, status,
                                 start_date, due_date, progress, note)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (project_id, seq, data.get("name", ""), data.get("owner", ""),
             data.get("status", "未开始"), data.get("start_date", ""),
             data.get("due_date", ""), data.get("progress", 0), data.get("note", "")),
        )
        return cursor.lastrowid

    def update_step(self, step_id, data):
        allowed = ("seq", "name", "owner", "status", "start_date",
                   "due_date", "progress", "note")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        sql = "UPDATE step SET " + ", ".join(f"{f} = ?" for f, _ in pairs) + " WHERE id = ?"
        self.execute(sql, [v for _, v in pairs] + [step_id])

    def delete_step(self, step_id):
        self.execute("DELETE FROM step WHERE id = ?", (step_id,))

    # ------------------------------------------------------------ 员工
    def employees(self, only_active=False):
        sql = "SELECT * FROM employee"
        if only_active:
            sql += " WHERE active = 1"
        sql += " ORDER BY active DESC, name"
        return self.query(sql)

    def employee(self, employee_id):
        return self.one("SELECT * FROM employee WHERE id = ?", (employee_id,))

    def add_employee(self, data):
        cursor = self.execute(
            """INSERT INTO employee (name, role, level, weekly_hours,
                                     hired_date, active, note)
               VALUES (?,?,?,?,?,?,?)""",
            (data.get("name", ""), data.get("role", ""), data.get("level", ""),
             data.get("weekly_hours", 40), data.get("hired_date", ""),
             data.get("active", 1), data.get("note", "")),
        )
        return cursor.lastrowid

    def update_employee(self, employee_id, data):
        allowed = ("name", "role", "level", "weekly_hours",
                   "hired_date", "active", "note")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        sql = "UPDATE employee SET " + ", ".join(f"{f} = ?" for f, _ in pairs) + " WHERE id = ?"
        self.execute(sql, [v for _, v in pairs] + [employee_id])

    def delete_employee(self, employee_id):
        self.execute("DELETE FROM employee WHERE id = ?", (employee_id,))

    # ------------------------------------------------------------ 工时
    def worklogs(self, employee_id=None, project_id=None,
                 date_from="", date_to="", limit=None):
        sql = """SELECT w.*, e.name AS employee_name, p.name AS project_name,
                        s.name AS step_name
                 FROM worklog w
                 LEFT JOIN employee e ON e.id = w.employee_id
                 LEFT JOIN project  p ON p.id = w.project_id
                 LEFT JOIN step     s ON s.id = w.step_id
                 WHERE 1 = 1"""
        params = []
        if employee_id:
            sql += " AND w.employee_id = ?"
            params.append(employee_id)
        if project_id:
            sql += " AND w.project_id = ?"
            params.append(project_id)
        if date_from:
            sql += " AND w.work_date >= ?"
            params.append(date_from)
        if date_to:
            sql += " AND w.work_date <= ?"
            params.append(date_to)
        sql += " ORDER BY w.work_date DESC, w.id DESC"
        if limit:
            sql += " LIMIT ?"
            params.append(limit)
        return self.query(sql, params)

    def add_worklog(self, data, dedupe=None):
        """加一条工时。

        关于 source_key 和唯一索引（这里改过一次，说清楚免得再绕）：
            数据库上有 `UNIQUE (project_id, source_key) WHERE source_key <> ''`，
            它是**给导入去重用的**。
            所以只有「参与去重」的记录才写指纹；手录和计时的指纹留空，
            唯一索引就管不到它们，两条一模一样的记录能并存。

            之前让所有记录都写指纹，结果 dedupe=False 想插第二条时
            被唯一索引拦住，直接 IntegrityError 崩掉——
            数据库约束和调用方意图**互相矛盾**了。

        dedupe 参数：
          · True  —— 参与去重。已经有同指纹的就复用，不重复插入。
                     **导入文件和局域网提交必须这样**。
          · False —— 不参与去重（指纹留空）。手录、计时器用这个：
                     上午下午各干 4 小时、备注写一样，是两条真实记录。
          · None（默认）—— 传了 source_key 就当导入处理，否则当手录。
        """
        employee_id = data.get("employee_id")
        project_id = data.get("project_id")
        work_date = data.get("work_date", "")
        hours = data.get("hours", 0)
        content = data.get("content", "")
        if dedupe is None:
            dedupe = bool(data.get("source_key"))

        key = ""
        if dedupe:
            key = data.get("source_key") or source_key(
                employee_id, project_id, work_date, hours, content
            )
            exists = self.one(
                "SELECT id FROM worklog WHERE project_id IS ? AND source_key = ?",
                (project_id, key),
            )
            if exists is not None:
                return exists["id"]

        cursor = self.execute(
            """INSERT INTO worklog (employee_id, project_id, step_id,
                                    work_date, hours, content, source, source_key)
               VALUES (?,?,?,?,?,?,?,?)""",
            (employee_id, project_id, data.get("step_id"),
             work_date, hours, content,
             data.get("source", "manual"), key),
        )
        return cursor.lastrowid

    def find_duplicate_worklog(self, data):
        """库里有没有一条和这条「内容一样」的工时？有就返回它。

        界面用它来提醒「可能重复了」，而不是自己决定要不要插入——
        插不插入应该由人判断。

        **刻意不用指纹来比**：
          · 手录和计时的记录指纹是空的；
          · 导入来的记录，指纹是**员工端的 employee_id** 算出来的
            （他那边你这个人 id 必然不同），拿本地的重算结果去比永远对不上。
        所以直接按「同一个人 + 同一个项目 + 同一天 + 同样的工时 + 同样的说明」
        找，语义清楚，也不受指纹怎么算的影响。
        """
        employee_id = data.get("employee_id")
        project_id = data.get("project_id")
        return self.one(
            "SELECT w.*, e.name AS employee_name, p.name AS project_name "
            "FROM worklog w "
            "LEFT JOIN employee e ON e.id = w.employee_id "
            "LEFT JOIN project  p ON p.id = w.project_id "
            "WHERE w.employee_id IS ? AND w.project_id IS ? "
            "AND w.work_date = ? AND w.hours = ? AND w.content = ? "
            "LIMIT 1",
            (employee_id, project_id, data.get("work_date", ""),
             data.get("hours", 0), data.get("content", "")),
        )

    def update_worklog(self, worklog_id, data):
        """改一条工时。

        指纹的规则（和新增时一致）：
          · **参与去重的记录**（导入来的，指纹非空）→ 改到影响指纹的字段就重算。
            不重算的话，以后员工再提交同一份文件时会算出对不上的新指纹，
            同一条记录被导入第二遍。
          · **手录和计时的记录**（指纹为空）→ 保持为空。
            它们本来就不参与去重，重算反而会给它们套上唯一索引，
            于是「改完和另一条一样」变成 IntegrityError 崩掉。

        调用方（EditWorklogDialog）会先用 worklog_conflict() 查一遍，
        只对参与去重的记录提示重复——手录的两条相同是正常的。
        """
        allowed = ("employee_id", "project_id", "step_id", "work_date",
                   "hours", "content", "source")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return

        # 只有**原本就参与去重**的记录（指纹非空，即导入来的）才重算指纹。
        # 手录和计时的指纹是空的，重算反而会给它们套上唯一索引，
        # 于是「改完和另一条一样」就变成 IntegrityError 崩掉。
        if any(f in data for f in ("employee_id", "project_id", "work_date",
                                   "hours", "content", "source_key")):
            current = self.one("SELECT * FROM worklog WHERE id = ?", (worklog_id,))
            if current is not None:
                if "source_key" in data:
                    # 调用方明确指定了指纹（导入流程用）
                    pairs.append(("source_key", data["source_key"]))
                elif current["source_key"]:
                    merged = {
                        "employee_id": data.get("employee_id",
                                                current["employee_id"]),
                        "project_id": data.get("project_id", current["project_id"]),
                        "work_date": data.get("work_date", current["work_date"]),
                        "hours": data.get("hours", current["hours"]),
                        "content": data.get("content", current["content"]),
                    }
                    pairs.append(("source_key", source_key(**merged)))

        sql = "UPDATE worklog SET " + ", ".join(f"{f} = ?" for f, _ in pairs) \
            + " WHERE id = ?"
        self.execute(sql, [v for _, v in pairs] + [worklog_id])

    def worklog_conflict(self, worklog_id, data):
        """改完会不会和另一条**参与去重的**记录撞指纹？撞上就返回那一条。

        只查指纹非空的记录。手录和计时的指纹是空的，
        它们本来就允许内容相同（上午下午各干 4 小时），不算冲突。
        """
        current = self.one("SELECT * FROM worklog WHERE id = ?", (worklog_id,))
        if current is None:
            return None
        # 手录和计时的记录不参与去重，改多少次都不会冲突
        if not current["source_key"]:
            return None
        merged = {
            "employee_id": data.get("employee_id", current["employee_id"]),
            "project_id": data.get("project_id", current["project_id"]),
            "work_date": data.get("work_date", current["work_date"]),
            "hours": data.get("hours", current["hours"]),
            "content": data.get("content", current["content"]),
        }
        key = source_key(**merged)
        row = self.one(
            "SELECT w.*, e.name AS employee_name, p.name AS project_name "
            "FROM worklog w "
            "LEFT JOIN employee e ON e.id = w.employee_id "
            "LEFT JOIN project  p ON p.id = w.project_id "
            "WHERE w.source_key = ? AND w.source_key <> '' AND w.id <> ?",
            (key, worklog_id),
        )
        return row

    def delete_worklog(self, worklog_id):
        self.execute("DELETE FROM worklog WHERE id = ?", (worklog_id,))

    # ------------------------------------------------------------ 计时会话
    def sessions(self, employee_id=None, status=None, work_date=None,
                 date_from="", date_to=""):
        sql = """SELECT s.*, p.name AS project_name, st.name AS step_name
                 FROM session s
                 LEFT JOIN project p ON p.id = s.project_id
                 LEFT JOIN step    st ON st.id = s.step_id
                 WHERE 1 = 1"""
        params = []
        if employee_id:
            sql += " AND s.employee_id = ?"
            params.append(employee_id)
        if status:
            sql += " AND s.status = ?"
            params.append(status)
        if work_date:
            sql += " AND s.work_date = ?"
            params.append(work_date)
        if date_from:
            sql += " AND s.work_date >= ?"
            params.append(date_from)
        if date_to:
            sql += " AND s.work_date <= ?"
            params.append(date_to)
        sql += " ORDER BY s.work_date DESC, s.id DESC"
        return self.query(sql, params)

    def add_session(self, data):
        cursor = self.execute(
            """INSERT INTO session (employee_id, project_id, step_id, work_date,
                                    mono_start, elapsed, started_at, ended_at,
                                    status, content, manual)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (data.get("employee_id"), data.get("project_id"), data.get("step_id"),
             data.get("work_date", ""), data.get("mono_start", 0.0),
             data.get("elapsed", 0.0), data.get("started_at", ""),
             data.get("ended_at", ""), data.get("status", "running"),
             data.get("content", ""), data.get("manual", 0)),
        )
        return cursor.lastrowid

    def update_session(self, session_id, data):
        allowed = ("project_id", "step_id", "work_date", "mono_start", "elapsed",
                   "started_at", "ended_at", "status", "content", "manual")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        sql = "UPDATE session SET " + ", ".join(f"{f} = ?" for f, _ in pairs) \
            + " WHERE id = ?"
        self.execute(sql, [v for _, v in pairs] + [session_id])

    def delete_session(self, session_id):
        self.execute("DELETE FROM session WHERE id = ?", (session_id,))

    def running_session(self, employee_id):
        """某人正在跑（或暂停）的会话。一个人同时只该有一个。"""
        return self.one(
            "SELECT * FROM session WHERE employee_id = ? "
            "AND status IN ('running', 'paused') ORDER BY id DESC LIMIT 1",
            (employee_id,),
        )

    def hours_by_employee(self, date_from="", date_to=""):
        """每人在这段区间内的总工时，用于负荷率分析。

        顺带带上岗位和职级：负荷分析经常要显示「是谁、什么岗位」，
        少一个字段调用方就得再查一次。
        """
        sql = """SELECT e.id, e.name, e.role, e.level, e.weekly_hours,
                        COALESCE(SUM(w.hours), 0) AS hours
                 FROM employee e
                 LEFT JOIN worklog w ON w.employee_id = e.id
                    AND w.work_date >= ? AND w.work_date <= ?
                 WHERE e.active = 1
                 GROUP BY e.id ORDER BY hours DESC"""
        return self.query(sql, (date_from or "0000-01-01", date_to or "9999-12-31"))

    # ------------------------------------------------------------ 分配
    def assignments(self, project_id=None, employee_id=None):
        sql = """SELECT a.*, e.name AS employee_name, p.name AS project_name,
                        s.name AS step_name
                 FROM assignment a
                 LEFT JOIN employee e ON e.id = a.employee_id
                 LEFT JOIN project  p ON p.id = a.project_id
                 LEFT JOIN step     s ON s.id = a.step_id
                 WHERE 1 = 1"""
        params = []
        if project_id:
            sql += " AND a.project_id = ?"
            params.append(project_id)
        if employee_id:
            sql += " AND a.employee_id = ?"
            params.append(employee_id)
        sql += " ORDER BY p.name, s.seq, e.name"
        return self.query(sql, params)

    def add_assignment(self, data):
        cursor = self.execute(
            """INSERT INTO assignment (project_id, step_id, employee_id,
                                       role_in_task, planned_hours,
                                       start_date, due_date, status)
               VALUES (?,?,?,?,?,?,?,?)""",
            (data.get("project_id"), data.get("step_id"), data.get("employee_id"),
             data.get("role_in_task", ""), data.get("planned_hours", 0),
             data.get("start_date", ""), data.get("due_date", ""),
             data.get("status", "待开始")),
        )
        return cursor.lastrowid

    def update_assignment(self, assignment_id, data):
        allowed = ("project_id", "step_id", "employee_id", "role_in_task",
                   "planned_hours", "start_date", "due_date", "status")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        sql = ("UPDATE assignment SET "
               + ", ".join(f"{f} = ?" for f, _ in pairs) + " WHERE id = ?")
        self.execute(sql, [v for _, v in pairs] + [assignment_id])

    def delete_assignment(self, assignment_id):
        self.execute("DELETE FROM assignment WHERE id = ?", (assignment_id,))

    # ------------------------------------------------------------ 评估
    def assessments(self, project_id, kind=None):
        sql = "SELECT * FROM assessment WHERE project_id = ?"
        params = [project_id]
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        sql += " ORDER BY weight DESC, score DESC, id"
        return self.query(sql, params)

    def add_assessment(self, project_id, data):
        cursor = self.execute(
            """INSERT INTO assessment (project_id, kind, name, score, weight, note)
               VALUES (?,?,?,?,?,?)""",
            (project_id, data.get("kind", "ability"), data.get("name", ""),
             data.get("score", 3), data.get("weight", 1), data.get("note", "")),
        )
        return cursor.lastrowid

    def update_assessment(self, assessment_id, data):
        allowed = ("kind", "name", "score", "weight", "note")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        sql = ("UPDATE assessment SET "
               + ", ".join(f"{f} = ?" for f, _ in pairs) + " WHERE id = ?")
        self.execute(sql, [v for _, v in pairs] + [assessment_id])

    def delete_assessment(self, assessment_id):
        self.execute("DELETE FROM assessment WHERE id = ?", (assessment_id,))

    # ------------------------------------------------------------ 指标
    def metrics(self, project_id, name=None, date_from="", date_to=""):
        sql = "SELECT * FROM metric WHERE project_id = ?"
        params = [project_id]
        if name:
            sql += " AND name = ?"
            params.append(name)
        if date_from:
            sql += " AND metric_date >= ?"
            params.append(date_from)
        if date_to:
            sql += " AND metric_date <= ?"
            params.append(date_to)
        sql += " ORDER BY metric_date, id"
        return self.query(sql, params)

    def metric_names(self, project_id):
        rows = self.query(
            "SELECT DISTINCT name FROM metric WHERE project_id = ? ORDER BY name",
            (project_id,),
        )
        return [row["name"] for row in rows]

    def add_metric(self, project_id, data):
        cursor = self.execute(
            """INSERT INTO metric (project_id, metric_date, name, value, unit, note)
               VALUES (?,?,?,?,?,?)""",
            (project_id, data.get("metric_date", ""), data.get("name", ""),
             data.get("value", 0), data.get("unit", ""), data.get("note", "")),
        )
        return cursor.lastrowid

    def update_metric(self, metric_id, data):
        allowed = ("metric_date", "name", "value", "unit", "note")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        sql = ("UPDATE metric SET "
               + ", ".join(f"{f} = ?" for f, _ in pairs) + " WHERE id = ?")
        self.execute(sql, [v for _, v in pairs] + [metric_id])

    def delete_metric(self, metric_id):
        self.execute("DELETE FROM metric WHERE id = ?", (metric_id,))

    # ------------------------------------------------------------ 知识星球
    def knowledge_items(self, zone="", keyword="", status=""):
        """知识星体列表。标签、正文、来源都参与搜索。"""
        sql = (
            "SELECT k.*, p.name AS project_name FROM knowledge k "
            "LEFT JOIN project p ON p.id = k.project_id"
        )
        where, params = [], []
        if zone:
            where.append("k.zone = ?")
            params.append(zone)
        if status:
            where.append("k.status = ?")
            params.append(status)
        if keyword:
            like = f"%{keyword}%"
            where.append("(k.title LIKE ? OR k.content LIKE ? OR k.tags LIKE ? "
                         "OR k.source LIKE ? OR p.name LIKE ?)")
            params.extend([like] * 5)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += (" ORDER BY CASE k.status WHEN '种子' THEN 0 "
                "WHEN '探索中' THEN 1 ELSE 2 END, "
                "k.importance DESC, k.updated_at DESC, k.id DESC")
        return self.query(sql, params)

    def knowledge_item(self, knowledge_id):
        return self.one(
            "SELECT k.*, p.name AS project_name FROM knowledge k "
            "LEFT JOIN project p ON p.id = k.project_id WHERE k.id = ?",
            (knowledge_id,),
        )

    def add_knowledge(self, data):
        fields = ("title", "content", "zone", "kind", "source", "tags",
                  "project_id", "importance", "status", "next_review")
        values = [data.get(f, "") for f in fields]
        values[2] = values[2] or "实际知识"
        values[3] = values[3] or "显性知识"
        values[6] = values[6] or None
        values[7] = max(1, min(5, int(values[7] or 3)))
        values[8] = values[8] or "已沉淀"
        cursor = self.execute(
            "INSERT INTO knowledge (" + ",".join(fields) + ") VALUES ("
            + ",".join("?" * len(fields)) + ")",
            values,
        )
        return cursor.lastrowid

    def update_knowledge(self, knowledge_id, data):
        allowed = ("title", "content", "zone", "kind", "source", "tags",
                   "project_id", "importance", "status", "next_review")
        pairs = [(f, data[f]) for f in allowed if f in data]
        if not pairs:
            return
        if "importance" in data or "project_id" in data:
            data = dict(data)
            if "importance" in data:
                data["importance"] = max(1, min(5, int(data["importance"] or 3)))
            if "project_id" in data:
                data["project_id"] = data["project_id"] or None
            pairs = [(f, data[f]) for f in allowed if f in data]
        sql = ("UPDATE knowledge SET "
               + ", ".join(f"{f} = ?" for f, _ in pairs)
               + ", updated_at = datetime('now','localtime') WHERE id = ?")
        self.execute(sql, [v for _, v in pairs] + [knowledge_id])

    def delete_knowledge(self, knowledge_id):
        self.execute("DELETE FROM knowledge WHERE id = ?", (knowledge_id,))

    def knowledge_links(self):
        return self.query(
            """SELECT l.*, a.title AS from_title, b.title AS to_title
               FROM knowledge_link l
               JOIN knowledge a ON a.id = l.from_id
               JOIN knowledge b ON b.id = l.to_id
               ORDER BY l.created_at DESC, l.id DESC"""
        )

    def add_knowledge_link(self, from_id, to_id, relation="关联", note=""):
        if from_id is None or to_id is None or from_id == to_id:
            return None
        cursor = self.execute(
            """INSERT OR IGNORE INTO knowledge_link
               (from_id, to_id, relation, note) VALUES (?,?,?,?)""",
            (from_id, to_id, relation or "关联", note or ""),
        )
        return cursor.lastrowid

    def delete_knowledge_link(self, link_id):
        self.execute("DELETE FROM knowledge_link WHERE id = ?", (link_id,))

    def knowledge_reflections(self, knowledge_id):
        return self.query(
            """SELECT * FROM knowledge_reflection
               WHERE knowledge_id = ? ORDER BY created_at DESC, id DESC""",
            (knowledge_id,),
        )

    def add_knowledge_reflection(self, knowledge_id, prompt, content):
        cursor = self.execute(
            """INSERT INTO knowledge_reflection
               (knowledge_id, prompt, content) VALUES (?,?,?)""",
            (knowledge_id, prompt or "", content or ""),
        )
        self.execute(
            "UPDATE knowledge SET updated_at = datetime('now','localtime') "
            "WHERE id = ?", (knowledge_id,),
        )
        return cursor.lastrowid

    def knowledge_stats(self):
        rows = self.query(
            "SELECT zone, kind, status, COUNT(*) AS n FROM knowledge "
            "GROUP BY zone, kind, status"
        )
        result = {
            "total": 0, "explicit": 0, "tacit": 0,
            "seed": 0, "exploring": 0, "settled": 0,
            "zones": {zone: 0 for zone in KNOWLEDGE_ZONES},
            "reflections": int(self.scalar(
                "SELECT COUNT(*) FROM knowledge_reflection", (), 0)),
            "links": int(self.scalar(
                "SELECT COUNT(*) FROM knowledge_link", (), 0)),
        }
        for row in rows:
            n = int(row["n"] or 0)
            result["total"] += n
            result["zones"][row["zone"]] = result["zones"].get(row["zone"], 0) + n
            if row["kind"] == "隐性知识":
                result["tacit"] += n
            else:
                result["explicit"] += n
            if row["status"] == "种子":
                result["seed"] += n
            elif row["status"] == "探索中":
                result["exploring"] += n
            else:
                result["settled"] += n
        return result

    # ------------------------------------------------------------ 汇总
    def dashboard_rows(self):
        """驾驶舱要用的多项目汇总。

        一次 SQL 拿全，不在 Python 里循环查——项目多了循环查会明显变慢。
        """
        return self.query(
            """SELECT p.*,
                      (SELECT COUNT(*) FROM step s WHERE s.project_id = p.id) AS step_total,
                      (SELECT COUNT(*) FROM step s
                        WHERE s.project_id = p.id AND s.status = '已完成') AS step_done,
                      (SELECT COUNT(DISTINCT a.employee_id) FROM assignment a
                        WHERE a.project_id = p.id) AS people,
                      (SELECT COALESCE(SUM(w.hours), 0) FROM worklog w
                        WHERE w.project_id = p.id) AS hours,
                      julianday(p.due_date) - julianday(date('now','localtime')) AS days_left
               FROM project p
               ORDER BY CASE p.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
                        p.id DESC"""
        )
