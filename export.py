"""导出：把所有数据导成 Excel 或 CSV。

为什么不给「导出某一页」这种选项：
    老板要导出，通常是为了发给别人或者在 Excel 里再加工。
    一次给全，比让他一页页导更省事。

xlsx 用 openpyxl（如果装了）；没装就退回 CSV（一次写多个文件）。
不装 openpyxl 也能用，只是格式没那么整齐。
"""
import csv
import os

__all__ = ["export_all", "SHEETS"]


def _sheets(store):
    """返回 [(表名, 表头, 行数据), ...]。中文表名，老板直接看得懂。"""
    data = []

    projects = []
    for row in store.dashboard_rows():
        projects.append([
            row["name"], row["owner"], row["client"], row["status"],
            row["priority"], f"{row['progress'] or 0}%",
            row["start_date"], row["due_date"],
            row["budget"], row["cost"],
            f"{row['step_done']}/{row['step_total']}",
            row["people"], round(float(row["hours"] or 0), 1),
        ])
    data.append((
        "项目总览",
        ["项目", "负责人", "客户", "状态", "优先级", "进度", "开始", "截止",
         "预算", "已花", "步骤完成", "人数", "投入工时"],
        projects,
    ))

    steps = [
        [row["project_name"], row["seq"], row["name"], row["owner"],
         row["status"], f"{row['progress'] or 0}%",
         row["start_date"], row["due_date"], row["note"]]
        for row in store.query(
            """SELECT s.*, p.name AS project_name FROM step s
               LEFT JOIN project p ON p.id = s.project_id
               ORDER BY p.name, s.seq"""
        )
    ]
    data.append((
        "项目步骤",
        ["项目", "序号", "步骤", "负责人", "状态", "进度",
         "开始", "截止", "备注"],
        steps,
    ))

    employees = [
        [row["name"], row["role"], row["level"], row["weekly_hours"],
         "在职" if row["active"] else "离职", row["hired_date"], row["note"]]
        for row in store.query("SELECT * FROM employee ORDER BY active DESC, name")
    ]
    data.append((
        "员工",
        ["姓名", "岗位", "职级", "周工时基准", "状态", "入职日期", "备注"],
        employees,
    ))

    logs = [
        [row["work_date"], row["employee_name"] or "", row["project_name"] or "非项目",
         row["step_name"] or "", row["hours"], row["content"]]
        for row in store.worklogs()
    ]
    data.append((
        "工时记录",
        ["日期", "员工", "项目", "步骤", "工时", "内容"],
        logs,
    ))

    assignments = [
        [row["project_name"] or "", row["step_name"] or "", row["employee_name"] or "",
         row["role_in_task"], row["planned_hours"], row["start_date"],
         row["due_date"], row["status"]]
        for row in store.assignments()
    ]
    data.append((
        "任务分配",
        ["项目", "步骤", "员工", "任务角色", "计划工时", "开始", "截止", "状态"],
        assignments,
    ))

    assessments = [
        [row["project_name"] or "", "技术能力" if row["kind"] == "ability" else "有利资源",
         row["name"], row["score"], row["weight"], row["note"]]
        for row in store.query(
            """SELECT a.*, p.name AS project_name FROM assessment a
               LEFT JOIN project p ON p.id = a.project_id
               ORDER BY p.name, a.kind, a.weight DESC"""
        )
    ]
    data.append((
        "能力与资源",
        ["项目", "类别", "名称", "评分", "权重", "备注"],
        assessments,
    ))

    metrics = [
        [row["project_name"] or "", row["metric_date"], row["name"],
         row["value"], row["unit"], row["note"]]
        for row in store.query(
            """SELECT m.*, p.name AS project_name FROM metric m
               LEFT JOIN project p ON p.id = m.project_id
               ORDER BY p.name, m.metric_date"""
        )
    ]
    data.append((
        "指标数据",
        ["项目", "日期", "指标", "数值", "单位", "备注"],
        metrics,
    ))

    # 预测结果也一并导出：老板发给别人时，结论比原始数据更重要
    forecasts = []
    import rules
    for row in store.projects():
        result = rules.predict(store, row["id"])
        if not result:
            continue
        forecasts.append([
            row["name"], result["level"], result["headline"],
            "；".join(r["text"] for r in result["reasons"]),
            "；".join(result["actions"]),
        ])
    data.append((
        "风险预测",
        ["项目", "等级", "结论", "依据", "建议"],
        forecasts,
    ))

    knowledge_rows = [
        [row["title"], row["zone"], row["kind"], row["status"],
         row["project_name"] or "", row["importance"], row["tags"],
         row["source"], row["next_review"], row["content"],
         row["created_at"], row["updated_at"]]
        for row in store.knowledge_items()
    ]
    data.append((
        "知识星体",
        ["标题", "认知区域", "知识类型", "沉淀阶段", "关联项目", "重要度",
         "标签", "来源", "下次回看", "认知内容", "创建时间", "更新时间"],
        knowledge_rows,
    ))

    knowledge_links = [
        [row["from_title"], row["relation"], row["to_title"], row["note"],
         row["created_at"]]
        for row in store.knowledge_links()
    ]
    data.append((
        "知识关联",
        ["起点", "关系", "终点", "说明", "创建时间"],
        knowledge_links,
    ))

    knowledge_reflections = [
        [row["title"], row["prompt"], row["content"], row["created_at"]]
        for row in store.query(
            """SELECT r.*, k.title FROM knowledge_reflection r
               JOIN knowledge k ON k.id = r.knowledge_id
               ORDER BY r.created_at DESC, r.id DESC"""
        )
    ]
    data.append((
        "知识反思",
        ["知识", "问题", "思考", "反思时间"],
        knowledge_reflections,
    ))

    return data


SHEETS = ["项目总览", "项目步骤", "员工", "工时记录",
          "任务分配", "能力与资源", "指标数据", "风险预测",
          "知识星体", "知识关联", "知识反思"]


def export_all(store, path):
    """按扩展名决定格式。返回导出的表数量。"""
    data = _sheets(store)
    if path.lower().endswith(".xlsx"):
        return _export_xlsx(data, path)
    return _export_csv(data, path)


def _export_xlsx(data, path):
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError:
        raise RuntimeError(
            "导出 Excel 需要 openpyxl。\n"
            "请先安装：py -m pip install openpyxl\n"
            "或者把文件名后缀改成 .csv 导出 CSV。"
        )

    book = Workbook()
    book.remove(book.active)
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="E29393")

    for name, headers, rows in data:
        sheet = book.create_sheet(name[:31])   # Excel 工作表名上限 31 字
        sheet.append(headers)
        for cell in sheet[1]:
            cell.font = head_font
            cell.fill = head_fill
            cell.alignment = Alignment(horizontal="center")
        for row in rows:
            sheet.append(row)
        # 列宽按内容粗估，省得打开后一堆 ####
        for index, header in enumerate(headers, start=1):
            longest = len(str(header))
            for row in rows:
                if index - 1 < len(row):
                    longest = max(longest, len(str(row[index - 1])))
            sheet.column_dimensions[
                sheet.cell(row=1, column=index).column_letter
            ].width = min(38, max(9, longest * 1.6))
        sheet.freeze_panes = "A2"

    book.save(path)
    return len(data)


def _export_csv(data, path):
    """CSV 装不下多张表，所以按表名生成多个文件：原名_表名.csv"""
    base, _ = os.path.splitext(path)
    for name, headers, rows in data:
        target = f"{base}_{name}.csv"
        with open(target, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
            writer.writerows(rows)
    return len(data)
