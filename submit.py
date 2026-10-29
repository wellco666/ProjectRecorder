"""员工提交：导出工时文件、导入工时文件。

为什么用文件交换而不是局域网服务：
    员工可能和老板不在同一个地方，公司网络也常禁止设备互访。
    文件可以通过微信、邮件、共享盘、云同步盘走，
    **不依赖任何网络配置**，出问题的环节少，也好排查。
    顺带的好处：把导出目录指到云同步文件夹里，就变成了「自动送达」。

设计上的三个关键决定：

1. **去重靠指纹，不靠文件名**
   文件可能被改名、被重复转发、员工自己也可能导两次。
   所以每条工时算一个「员工+项目+日期+工时+说明」的指纹，
   导入时按指纹跳过已存在的。**同一个文件导入多少次结果都一样**。

2. **按名字匹配，不按 id**
   员工电脑上的数据库和老板的是两套，同一件东西 id 必然不同。
   所以文件里存的是名字，导入时按名字找。

3. **项目必须已存在，员工可以自动建**
   项目是老板的项目——员工报上一个老板没建过的项目，
   说明两边对不上，应该**报出来让人确认**，而不是悄悄建一个。
   员工则是「人来了就该有」，自动建更省事，而且建了会明确告知。
"""
import datetime
import hashlib
import json
import os

from metrics import num

__all__ = ["source_key", "export_employee", "export_all", "import_file",
           "read_file", "FILE_SUFFIX", "FORMAT_VERSION",
           "export_snapshot", "write_snapshot", "read_snapshot",
           "snapshot_filename", "SNAPSHOT_FORMAT"]

#: 文件名后缀。故意用 .json 而不是自造后缀——
#: 微信和邮件对未知后缀的拦截很凶，.json 能正常发。
FILE_SUFFIX = ".json"

#: 文件格式版本。以后改格式时靠它判断兼容性。
FORMAT_VERSION = 1


def source_key(employee_id, project_id, work_date, hours, content):
    """算一条工时的去重指纹。

    用「员工 + 项目 + 日期 + 工时 + 说明」做输入：
      · 同一个人同一天在同一个项目上做了两件不同的事 → 说明不同 → 两条都保留
      · 同一个人同一天在同一个项目上报了两次相同的工时和说明 → 视为重复
    这是有意的保守选择：宁可少去重，也不要把真实的第二条记录吃掉。
    """
    raw = "|".join([
        str(employee_id or ""),
        str(project_id or ""),
        str(work_date or ""),
        f"{num(hours):.4f}",          # 定点格式，避免 8 和 8.0 算出两个指纹
        str(content or "").strip(),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


# ---------------------------------------------------------------- 导出
def export_employee(store, employee_id, date_from="", date_to="", note=""):
    """把一个员工的工时打包成可提交的数据（dict）。

    只导出「这个人」的工时——员工只能看到自己的，这也符合直觉。
    """
    employee = store.employee(employee_id)
    if employee is None:
        raise ValueError("找不到这个员工")
    employee = dict(employee)

    logs = store.worklogs(employee_id=employee_id,
                          date_from=date_from, date_to=date_to)
    entries = []
    for log in logs:
        entries.append({
            "work_date": log["work_date"],
            "project": log["project_name"] or "",
            "step": log["step_name"] or "",
            "hours": round(num(log["hours"]), 2),
            "content": log["content"] or "",
            "source": log["source"] or "manual",
            "key": source_key(employee_id, log["project_id"], log["work_date"],
                              log["hours"], log["content"]),
        })

    # 附上计时会话的起止时间，供老板那边交叉核对。
    # 这是「篡改可被发现」的关键：单调时钟算出的时长，
    # 和起止时间算出的时长必须对得上，对不上就说明中途改过系统时间。
    checks = []
    for session in store.sessions(employee_id=employee_id,
                                  date_from=date_from, date_to=date_to):
        if session["manual"] or not session["started_at"]:
            continue
        checks.append({
            "work_date": session["work_date"],
            "project": session["project_name"] or "",
            "step": session["step_name"] or "",
            "started_at": session["started_at"],
            "ended_at": session["ended_at"],
            "elapsed": round(num(session["elapsed"]), 1),
            "content": session["content"] or "",
        })

    return {
        "format": "ProjectRecorder.worklog",
        "version": FORMAT_VERSION,
        "exported_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "employee": {
            "name": employee["name"],
            "role": employee["role"],
            "level": employee["level"],
            "weekly_hours": num(employee["weekly_hours"], 40),
        },
        "range": {"from": date_from or "", "to": date_to or ""},
        "note": note,
        "entries": entries,
        "checks": checks,
    }


def export_all(store, date_from="", date_to="", note=""):
    """把所有在岗员工各打一个包，返回 [(文件名, 数据), ...]。

    一个人一个文件：合并成一个文件的话，
    老板收到后分不清哪条是谁的，也没法只导入其中一个人的。
    """
    result = []
    for employee in store.employees(only_active=True):
        data = export_employee(store, employee["id"], date_from, date_to, note)
        if not data["entries"]:
            continue        # 没有工时的员工不生成空文件，免得白发一堆
        result.append((suggested_filename(data), data))
    return result


# ---------------------------------------------------------------- 全量快照
#: 手机 App 用的包格式。和工时包区分开，免得互相导入。
SNAPSHOT_FORMAT = "ProjectRecorder.snapshot"


def export_snapshot(store, date_from="", date_to="", note=""):
    """导出**整个数据库**的快照，给手机 App 用。

    和 export_all 的区别：
      · export_all 是「所有员工的工时」，一人一个文件，给老板导入用；
      · 这个快照含项目、步骤、员工、分配、评估、指标、工时**全部数据**，
        手机那边拿它当镜像的数据源。

    项目、步骤、员工这些结构性数据**总是全量带上**——
    少了它们手机那边没有项目名可以对应。
    工时条数可能很大，所以允许按日期只导一部分。
    """
    employees = [dict(row) for row in store.employees()]

    projects = []
    for row in store.projects():
        project = dict(row)
        project["steps"] = [
            {
                "name": step["name"], "seq": step["seq"],
                "owner": step["owner"], "status": step["status"],
                "start_date": step["start_date"], "due_date": step["due_date"],
                "progress": step["progress"], "note": step["note"],
            }
            for step in store.steps(project["id"])
        ]
        project["assessments"] = [
            {"kind": item["kind"], "name": item["name"], "score": item["score"],
             "weight": item["weight"], "note": item["note"]}
            for item in store.assessments(project["id"])
        ]
        project["metrics"] = [
            {"metric_date": item["metric_date"], "name": item["name"],
             "value": item["value"], "unit": item["unit"], "note": item["note"]}
            for item in store.metrics(project["id"])
        ]
        projects.append(project)

    assignments = [
        {"project": row["project_name"] or "", "step": row["step_name"] or "",
         "employee": row["employee_name"] or "",
         "role_in_task": row["role_in_task"],
         "planned_hours": num(row["planned_hours"]),
         "start_date": row["start_date"], "due_date": row["due_date"],
         "status": row["status"]}
        for row in store.assignments()
    ]

    worklogs = [
        {
            "employee": row["employee_name"] or "",
            "project": row["project_name"] or "",
            "step": row["step_name"] or "",
            "work_date": row["work_date"],
            "hours": num(row["hours"]),
            "content": row["content"] or "",
            "source": row["source"] or "manual",
            "key": row["source_key"] or "",
        }
        for row in store.worklogs(date_from=date_from, date_to=date_to)
    ]

    return {
        "format": SNAPSHOT_FORMAT,
        "version": FORMAT_VERSION,
        "exported_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "range": {"from": date_from or "", "to": date_to or ""},
        "note": note,
        "employees": employees,
        "projects": projects,
        "assignments": assignments,
        "worklogs": worklogs,
    }


def snapshot_filename():
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
    return f"项目快照_{stamp}{FILE_SUFFIX}"


def write_snapshot(store, path, date_from="", date_to="", note=""):
    """导出快照并写文件。返回 (数据, 错误信息)。"""
    try:
        data = export_snapshot(store, date_from, date_to, note)
        write_file(data, path)
        return data, ""
    except OSError as error:
        return None, f"写不进这个位置：{error}"


def read_snapshot(path):
    """读一个**手机快照**文件并校验。返回 (数据, 错误信息)。"""
    data, error = load_json(path)
    if data is None:
        return None, error
    if data.get("format") != SNAPSHOT_FORMAT:
        # 拿错了要指明拿的是什么，别只说「不对」
        if data.get("format") == "ProjectRecorder.worklog":
            return None, ("这是员工工时文件，不是手机快照。"
                          "快照请在电脑上用「员工提交 → 导出手机快照」生成。")
        return None, ("这不是项目快照文件。"
                      "快照请在电脑上用「导出手机快照」生成。")
    if not isinstance(data.get("projects"), list):
        return None, "快照里没有项目数据。"
    if not isinstance(data.get("worklogs"), list):
        return None, "快照里没有工时数据。"
    return data, ""


def suggested_filename(data):
    """生成建议的文件名。员工直接用它，老板一眼能看出是谁的。"""
    name = data["employee"]["name"]
    start = data["range"]["from"] or "开始"
    end = data["range"]["to"] or "今天"
    return f"工时_{name}_{start}_到_{end}{FILE_SUFFIX}"


def write_file(data, path):
    """把导出的数据写成文件。UTF-8 无 BOM，中文名和说明都能正常显示。"""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    return path


# ---------------------------------------------------------------- 导入
#: 本程序产出的所有包格式。加新格式时记得一起补上。
KNOWN_FORMATS = ("ProjectRecorder.worklog", SNAPSHOT_FORMAT)


def load_json(path):
    """读文件 + 解析 JSON + 确认是**本程序的包** + 检查版本。

    不判断是哪种包（工时文件还是快照），那交给 read_file / read_snapshot。

    检查顺序**必须是「先认是不是我们的文件，再看版本」**：
    别的程序导出的 json 通常没有 version 字段，
    先查版本的话用户会看到「版本（None）比当前程序新」——
    完全误导，他拿的根本不是本程序的文件。
    这个顺序问题踩过一次。
    """
    if not os.path.isfile(path):
        return None, "文件不存在。"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except UnicodeDecodeError:
        return None, "文件不是 UTF-8 文本，可能选错了文件。"
    except ValueError as error:
        return None, f"文件不是有效的提交文件（内容解析失败：{error}）。"

    if not isinstance(data, dict):
        return None, "文件内容格式不对——不是本程序导出的文件。"
    if data.get("format") not in KNOWN_FORMATS:
        return None, ("这不是本程序导出的文件。"
                      "本程序的包有「员工工时文件」和「手机快照」两种，"
                      "请在电脑上用对应的菜单导出。")
    version = data.get("version")
    if not isinstance(version, int) or version > FORMAT_VERSION:
        return None, (f"文件版本（{version}）比当前程序新，"
                      "请把程序更新到同一版本再导入。")
    return data, ""


def read_file(path):
    """读一个**员工工时**提交文件并校验。返回 (数据, 错误信息)。"""
    data, error = load_json(path)
    if data is None:
        return None, error
    if data.get("format") != "ProjectRecorder.worklog":
        # 顺手认一下快照，给出更准的提示而不是笼统的「不是本程序的文件」
        if data.get("format") == SNAPSHOT_FORMAT:
            return None, ("这是手机快照文件，不是员工工时文件。"
                          "快照要用手机版 App 导入；"
                          "如果想让电脑收下手机记的工时，"
                          "请在手机版里点「导出交给电脑」。")
        return None, ("这不是本程序导出的工时文件。"
                      "请让员工在程序里用「导出工时」生成文件。")
    if not isinstance(data.get("entries"), list):
        return None, "文件里没有工时记录。"
    if not isinstance(data.get("employee"), dict) \
            or not str(data["employee"].get("name", "")).strip():
        return None, "文件里没有说清是谁提交的。"
    return data, ""


def import_file(store, path, create_missing_employee=True):
    """把一个提交文件导入数据库。

    返回一份**给人看的报告**，而不是只回一个成功/失败：
    老板需要知道「导入了几条、跳过几条、哪几条没导进去、为什么」，
    否则数据对不上的时候无从查起。
    """
    data, error = read_file(path)
    if data is None:
        return {"ok": False, "error": error, "added": 0, "duplicated": 0,
                "skipped": [], "created_employee": "", "employee": "",
                "unknown_projects": [], "summary": error}

    employee_name = str(data["employee"]["name"]).strip()
    employee = _find_employee(store, employee_name)
    created_employee = ""
    if employee is None:
        if not create_missing_employee:
            message = f"名单里没有「{employee_name}」，已跳过整个文件。"
            return {"ok": False, "error": message, "added": 0, "duplicated": 0,
                    "skipped": [], "created_employee": "", "employee": employee_name,
                    "unknown_projects": [], "summary": message}
        # 自动建人：人来了就该有。建了会明确告知，不会偷偷做。
        info = data["employee"]
        new_id = store.add_employee({
            "name": employee_name,
            "role": str(info.get("role", "") or ""),
            "level": str(info.get("level", "") or ""),
            "weekly_hours": num(info.get("weekly_hours"), 40) or 40,
            "active": 1,
        })
        employee = store.employee(new_id)
        created_employee = employee_name

    added = 0
    duplicated = 0
    skipped = []
    unknown_projects = []
    timed = 0
    manual = 0

    for index, entry in enumerate(data["entries"], start=1):
        if not isinstance(entry, dict):
            skipped.append(f"第 {index} 条：格式不对")
            continue

        work_date = str(entry.get("work_date", "")).strip()
        if not _valid_date(work_date):
            skipped.append(f"第 {index} 条：日期「{work_date}」不对")
            continue

        hours = num(entry.get("hours"))
        if hours <= 0 or hours > 24:
            skipped.append(f"第 {index} 条：工时 {hours:g} 不合理")
            continue

        project_name = str(entry.get("project", "")).strip()
        project = _find_project(store, project_name)
        if project_name and project is None:
            # 项目不存在就跳过这一条，而不是自动建——
            # 那多半说明两边对不上，应该让人确认
            if project_name not in unknown_projects:
                unknown_projects.append(project_name)
            continue
        project_id = project["id"] if project is not None else None

        content = str(entry.get("content", "") or "")
        key = source_key(employee["id"], project_id, work_date, hours, content)

        # 指纹已经在库里就跳过。这一条让「同一个文件导两次」是安全的。
        exists = store.one(
            "SELECT id FROM worklog WHERE project_id IS ? AND source_key = ?",
            (project_id, key),
        )
        if exists is not None:
            duplicated += 1
            continue

        step_id = None
        step_name = str(entry.get("step", "")).strip()
        if step_name and project_id is not None:
            for step in store.steps(project_id):
                if step["name"] == step_name:
                    step_id = step["id"]
                    break

        # 来源跟着文件走：计时器记的和手工补录的分开存，
        # 老板一看就知道哪些是真实计时的。
        source = "timer" if str(entry.get("source", "")) == "timer" else "manual"
        if source == "timer":
            timed += 1
        else:
            manual += 1

        store.add_worklog({
            "employee_id": employee["id"],
            "project_id": project_id,
            "step_id": step_id,
            "work_date": work_date,
            "hours": hours,
            "content": content,
            "source": source,
            "source_key": key,
        }, dedupe=True)
        added += 1

    # ---- 交叉核对：抓光看单条发现不了的问题 ----
    warnings = _audit_entries(data)

    ok = added > 0 or duplicated > 0
    summary = f"{employee_name}：新增 {added} 条"
    if timed or manual:
        summary += f"（计时 {timed}、补录 {manual}）"
    if duplicated:
        summary += f"，已存在跳过 {duplicated} 条"
    if skipped:
        summary += f"，格式不对 {len(skipped)} 条"
    if unknown_projects:
        summary += f"，未知项目 {len(unknown_projects)} 个"
    if warnings:
        summary += f"，{len(warnings)} 处需要核对"
    if created_employee:
        summary = f"（新建员工 {created_employee}）" + summary

    return {
        "ok": ok,
        "error": "" if ok else "文件里没有可导入的记录。",
        "added": added,
        "duplicated": duplicated,
        "skipped": skipped,
        "created_employee": created_employee,
        "employee": employee_name,
        "unknown_projects": unknown_projects,
        "timed": timed,
        "manual": manual,
        "warnings": warnings,
        "summary": summary,
    }


def _audit_entries(data):
    """对文件里的记录和计时证据做交叉核对，返回警告列表。

    这里检查的是「单看一条看不出来」的问题：
    一天加起来超 24 小时、时间段重叠、时长和起止时间对不上。
    用的是文件里的原始数据，所以员工改过什么都会在这里露出来。
    """
    import timer

    entries = [item for item in (data.get("entries") or [])
               if isinstance(item, dict)]
    checks = [item for item in (data.get("checks") or [])
              if isinstance(item, dict)]

    warnings = []

    # 1. 时长和起止时间对不对得上（单调时钟 vs 墙钟）
    for item in checks:
        session = {
            "manual": 0,
            "elapsed": num(item.get("elapsed")),
            "started_at": item.get("started_at"),
            "ended_at": item.get("ended_at"),
        }
        for problem in timer.check_session(session):
            where = item.get("project") or "非项目"
            warnings.append(f"{item.get('work_date', '')} {where}：{problem}")

    # 2. 把计时证据里的起止时间合并进工时记录，才能看时间段重叠。
    #    一份计时会生成一条工时 + 一条证据，两边的日期和项目一致，
    #    所以按 (日期, 项目) 配对；同一天同一项目有多段时按顺序一一对上。
    checks_by_day_project = {}
    for item in checks:
        key = (item.get("work_date"), item.get("project") or "")
        checks_by_day_project.setdefault(key, []).append(item)

    merged = []
    for entry in entries:
        row = {
            "work_date": entry.get("work_date"),
            "hours": num(entry.get("hours")),
            "project": entry.get("project"),
            "manual": str(entry.get("source", "")) != "timer",
            "started_at": "",
            "ended_at": "",
        }
        if not row["manual"]:
            key = (row["work_date"], row["project"] or "")
            pool = checks_by_day_project.get(key) or []
            if pool:
                hit = pool.pop(0)        # 用掉一个，避免下一段重复配对
                row["started_at"] = hit.get("started_at", "")
                row["ended_at"] = hit.get("ended_at", "")
        merged.append(row)

    # 3. 补录总量占比过高也值得提一句——说明流程没落地
    total_timed = sum(row["hours"] for row in merged if not row["manual"])
    total_manual = sum(row["hours"] for row in merged if row["manual"])
    total = total_timed + total_manual
    if total > 0 and total_manual / total > 0.5:
        warnings.append(
            f"补录占 {total_manual / total * 100:.0f}%"
            f"（{total_manual:g} / {total:g} 小时），计时器用得少"
        )

    for day, problem in timer.check_worklog(merged):
        warnings.append(f"{day}：{problem}")

    # 去重，同一句话不重复说
    result = []
    for item in warnings:
        if item not in result:
            result.append(item)
    return result


# ---------------------------------------------------------------- 内部
def _find_employee(store, name):
    """按名字找员工。重名时取第一个在岗的，并让调用方能看出来。"""
    if not name:
        return None
    rows = store.query(
        "SELECT * FROM employee WHERE name = ? ORDER BY active DESC, id", (name,)
    )
    return rows[0] if rows else None


def _find_project(store, name):
    """按名字找项目。已交付的也能找到——导入历史工时时需要。"""
    if not name:
        return None
    row = store.one("SELECT * FROM project WHERE name = ? ORDER BY id LIMIT 1", (name,))
    return row


def _valid_date(text):
    if not text:
        return False
    try:
        datetime.datetime.strptime(text, "%Y-%m-%d")
        return True
    except ValueError:
        return False
