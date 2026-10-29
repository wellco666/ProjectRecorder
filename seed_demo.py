"""灌入一份演示数据，用来试功能、也能当默认示例。

用法：
    py seed_demo.py           # 库里已有项目就跳过，不会覆盖你的真实数据
    py seed_demo.py --force   # 清空后重新灌

数据是刻意造得「有故事」的：
  · 一个项目进度落后、还有阻塞步骤 —— 预测应该报「风险」
  · 一个项目顺利推进 —— 预测应该报「健康」
  · 有人明显超负荷、有人闲着 —— 便于看负荷分析
"""
import datetime
import sys

from db import Store


def _d(offset):
    """相对今天偏移若干天的日期"""
    return (datetime.date.today() + datetime.timedelta(days=offset)).isoformat()


def seed(store):
    # ---------------- 项目 ----------------
    # A：又慢又堵，应该被判为风险
    a = store.add_project({
        "name": "智慧园区二期", "owner": "李工", "client": "城投集团",
        "status": "进行中", "priority": "高",
        "start_date": _d(-60), "due_date": _d(20),
        "budget": 800000, "cost": 700000, "progress": 35,
        "note": "甲方中途加过一次需求",
    })
    for index, (name, status, progress, owner, due_offset) in enumerate([
        ("需求澄清", "已完成", 100, "李工", -50),
        ("接口联调", "已阻塞", 40, "王强", -5),
        ("数据迁移", "进行中", 60, "赵敏", 8),
        ("灰度发布", "已阻塞", 0, "王强", 15),
        ("验收交付", "未开始", 0, "李工", 20),
    ]):
        store.add_step(a, {
            "seq": index + 1, "name": name, "status": status,
            "progress": progress, "owner": owner, "due_date": _d(due_offset),
            "start_date": _d(-55 + index * 8),
        })
    for name, score, weight in [("后端架构", 4, 2), ("前端交互", 3, 1),
                                ("移动端", 2, 1.5), ("运维部署", 3, 1)]:
        store.add_assessment(a, {"kind": "ability", "name": name,
                                 "score": score, "weight": weight})
    for name, score, weight, note in [
        ("甲方内部关系", 5, 2, "对接人是老客户"),
        ("已有硬件设备", 4, 1.5, "一期留下的设备可复用"),
        ("现成组件库", 3, 1, ""),
    ]:
        store.add_assessment(a, {"kind": "resource", "name": name, "score": score,
                                 "weight": weight, "note": note})
    for name, value, unit in [("设备到货率", 60, "%"), ("接口联调完成度", 40, "%"),
                              ("甲方满意度", 72, "分")]:
        for offset in (-30, -20, -10, -2):
            store.add_metric(a, {"metric_date": _d(offset), "name": name,
                                 "value": value + offset * 0.3, "unit": unit})

    # B：顺利，应该被判为健康
    b = store.add_project({
        "name": "内部数据看板", "owner": "赵敏", "client": "自己",
        "status": "进行中", "priority": "中",
        "start_date": _d(-25), "due_date": _d(35),
        "budget": 120000, "cost": 40000, "progress": 55,
        "note": "范围小、目标明确",
    })
    for index, (name, status, progress, owner, due_offset) in enumerate([
        ("指标梳理", "已完成", 100, "赵敏", -15),
        ("取数开发", "进行中", 70, "陈鹏", 10),
        ("页面搭建", "进行中", 50, "陈鹏", 25),
        ("上线试运行", "未开始", 0, "赵敏", 35),
    ]):
        store.add_step(b, {"seq": index + 1, "name": name, "status": status,
                           "progress": progress, "owner": owner,
                           "due_date": _d(due_offset), "start_date": _d(-24 + index * 6)})
    for name, score, weight in [("数据建模", 5, 2), ("前端可视化", 4, 1.5)]:
        store.add_assessment(b, {"kind": "ability", "name": name,
                                 "score": score, "weight": weight})
    store.add_assessment(b, {"kind": "resource", "name": "现成数仓",
                             "score": 5, "weight": 2, "note": "数据都在仓库里，不用对接"})

    # C：已交付，用来看复盘视角
    c = store.add_project({
        "name": "官网改版", "owner": "王强", "client": "市场部",
        "status": "已交付", "priority": "低",
        "start_date": _d(-120), "due_date": _d(-30),
        "budget": 80000, "cost": 76000, "progress": 100, "note": "按期交付",
    })

    # ---------------- 员工 ----------------
    people = {}
    for name, role, level, weekly in [
        ("李工", "技术负责人", "P7", 40),
        ("王强", "后端工程师", "P5", 40),
        ("赵敏", "项目经理", "P6", 40),
        ("陈鹏", "前端工程师", "P5", 40),
        ("孙悦", "测试工程师", "P4", 40),
    ]:
        people[name] = store.add_employee({
            "name": name, "role": role, "level": level,
            "weekly_hours": weekly, "hired_date": _d(-400),
        })

    # ---------------- 分配 ----------------
    a_steps = {s["name"]: s["id"] for s in store.steps(a)}
    b_steps = {s["name"]: s["id"] for s in store.steps(b)}
    for emp, step, planned, start, due in [
        ("李工", "需求澄清", 40, _d(-60), _d(-50)),
        ("李工", "验收交付", 30, _d(10), _d(20)),
        ("王强", "接口联调", 120, _d(-30), _d(-5)),
        ("王强", "灰度发布", 60, _d(5), _d(15)),
        ("赵敏", "数据迁移", 60, _d(-10), _d(8)),
        ("孙悦", "验收交付", 20, _d(12), _d(20)),
    ]:
        store.add_assignment({"project_id": a, "step_id": a_steps.get(step),
                              "employee_id": people[emp], "planned_hours": planned,
                              "start_date": start, "due_date": due,
                              "role_in_task": step})
    for emp, step, planned in [("赵敏", "指标梳理", 24), ("陈鹏", "取数开发", 40),
                               ("陈鹏", "页面搭建", 60), ("赵敏", "上线试运行", 16)]:
        store.add_assignment({"project_id": b, "step_id": b_steps.get(step),
                              "employee_id": people[emp], "planned_hours": planned,
                              "role_in_task": step})

    # ---------------- 工时 ----------------
    # 王强故意记成超负荷（每周 52 小时），孙悦基本闲着（每周 6 小时）
    logs = [
        ("王强", a, "接口联调", 9, "联调支付接口"),
        ("王强", a, "接口联调", 8.5, "处理回调超时"),
        ("王强", a, "接口联调", 9, "写联调文档"),
        ("赵敏", a, "数据迁移", 8, "梳理迁移字段"),
        ("赵敏", b, "指标梳理", 6, "确认口径"),
        ("陈鹏", b, "取数开发", 8, "写 SQL"),
        ("陈鹏", b, "页面搭建", 7, "搭框架"),
        ("李工", a, "需求澄清", 4, "与甲方过需求"),
        ("孙悦", a, "验收交付", 2, "准备测试用例"),
    ]
    for index, (emp, project, step, hours, content) in enumerate(logs):
        step_id = a_steps.get(step) if project == a else b_steps.get(step)
        for day_offset in (-6, -5, -4, -3, -2, -1):
            if index % 3 == day_offset % 3:
                store.add_worklog({
                    "employee_id": people[emp], "project_id": project,
                    "step_id": step_id, "work_date": _d(day_offset),
                    "hours": hours, "content": content,
                })

    return a, b, c


def main():
    store = Store()
    force = "--force" in sys.argv
    existing = store.projects()
    if existing and not force:
        print(f"库里已有 {len(existing)} 个项目，跳过灌数据。")
        print("要重新灌请加 --force（会清空现有数据）")
        return 0
    if existing and force:
        for project in existing:
            store.delete_project(project["id"])
        for employee in store.employees():
            store.delete_employee(employee["id"])
        print("已清空原有数据。")

    seed(store)
    print(f"已灌入演示数据：{len(store.projects())} 个项目、"
          f"{len(store.employees())} 名员工、"
          f"{len(store.worklogs())} 条工时。")
    print(f"数据库：{store.path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
