"""界面自检：逐个构造每个窗口和控件，看哪个会崩。

为什么需要这个：
    窗口打不开时，traceback 只告诉你最终崩在哪一行，
    如果崩在构造过程中，往往要反复试好几轮才能定位。
    这个脚本**按顺序把每个部件单独造一遍**，
    谁出问题就立刻指出来，一次跑完。

它不开窗口、不等你点，全程自动，跑完就退。

用法：
    py selfcheck.py

注意：它会用 ~/ProjectRecorder/projects.db（和正常使用同一个库），
但**只读不写**，不会改动你的数据。
"""
import os
import sys
import traceback

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication      # noqa: E402

RESULTS = []


def step(label, func):
    """跑一步，记下成功或失败"""
    try:
        value = func()
        RESULTS.append((True, label, ""))
        print(f"  [OK]   {label}")
        return value
    except Exception as error:                # noqa: BLE001
        detail = f"{type(error).__name__}: {error}"
        RESULTS.append((False, label, detail))
        print(f"  [失败] {label}")
        print(f"         {detail}")
        traceback.print_exc()
        print()
        return None


def main():
    print("=" * 60)
    print("界面自检：逐个构造部件")
    print("=" * 60)

    app = QApplication(sys.argv)

    # ---- 1. 样式表能渲染吗 ----
    print("\n[1] 样式与主题")
    import re

    import main as main_module
    import theme

    def check_qss(name):
        """渲染样式表，确认没有残留的 $token。

        **要先剥掉注释**：文件头那句说明里写着 `$token 由 theme.py 替换`，
        那不是真 token，直接扫全文会误报。
        """
        theme.set_theme(name)
        text = main_module.load_stylesheet_text()
        assert text, f"{name} 主题渲染出来是空的"
        body = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        leftovers = sorted(set(re.findall(r"\$[A-Za-z_][A-Za-z0-9_]*", body)))
        assert not leftovers, (
            f"{name} 主题还有没替换的 token：{leftovers[:5]}"
            "——theme.py 里缺这些 key"
        )
        return len(text)

    step("渲染浅色主题的样式表", lambda: check_qss("light"))
    step("渲染深色主题的样式表", lambda: check_qss("dark"))
    theme.set_theme("light")

    # ---- 2. 数据库 ----
    print("\n[2] 数据库")
    import db

    def open_store():
        store = db.Store()
        count = store.scalar("SELECT COUNT(*) FROM project", (), 0)
        print(f"         （库里现有 {count} 个项目）")
        return store

    store = step("打开数据库", open_store)
    if store is None:
        print("\n数据库都打不开，后面的没法测。")
        return 1

    # ---- 3. 主窗口（最容易出问题的一步）----
    print("\n[3] 主窗口")
    window = step("构造 MainWindow", main_module.MainWindow)
    if window is None:
        print("\n主窗口构造失败——上面那个 traceback 就是原因。")
        return 1

    # ---- 4. 各页面 ----
    print("\n[4] 页面")
    for name in ("dashboard", "assistant_page", "employee_page",
                 "staffing_page", "timer_bar"):
        widget = getattr(window, name, None)
        if widget is None:
            print(f"  [缺失] {name} —— 主窗口上没有这个属性")
            RESULTS.append((False, name, "属性不存在"))
            continue
        step(f"{name} 刷新", widget.refresh)

    # ---- 5. 图表（纯自绘，最容易崩在 paintEvent 里）----
    print("\n[5] 图表（真的画一遍）")
    from PyQt6.QtGui import QPixmap, QPainter

    def paint_chart(chart, label):
        """把图放进 QPixmap 里真画一次——paintEvent 里出错就会在这里暴露"""
        chart.resize(640, 320)
        pixmap = QPixmap(640, 320)
        pixmap.fill()
        painter = QPainter(pixmap)
        try:
            chart.render(painter)
        finally:
            painter.end()
        assert not pixmap.isNull(), f"{label} 画出来是空的"
        return pixmap.width()

    from chart import BarChart, LoadChart, TimelineChart, TrendChart

    trend = step("构造 TrendChart", TrendChart)
    if trend is not None:
        step("TrendChart 空数据", lambda: paint_chart(trend, "trend"))
        step("TrendChart 有数据", lambda: (
            trend.set_series({
                "labels": ["1月", "2月", "3月"],
                "series": [{"name": "到货率", "data": [10, 55, 90]}],
            }),
            paint_chart(trend, "trend"),
        )[-1])
        step("TrendChart 单点 + 全零", lambda: (
            trend.set_series({"labels": ["只有一天"],
                              "series": [{"name": "x", "data": [0]}]}),
            paint_chart(trend, "trend"),
        )[-1])

    bars = step("构造 BarChart", BarChart)
    if bars is not None:
        step("BarChart 空数据", lambda: paint_chart(bars, "bar"))
        step("BarChart 单组", lambda: (
            bars.set_bars([{"label": "王强", "values": [12]},
                           {"label": "李工", "values": [8]}]),
            paint_chart(bars, "bar"),
        )[-1])
        step("BarChart 双组（计划/实际）", lambda: (
            bars.set_bars([{"label": "王强", "values": [20, 34]},
                           {"label": "李工", "values": [16, 9]}],
                          group_names=["计划", "实际"]),
            paint_chart(bars, "bar"),
        )[-1])

    timeline = step("构造 TimelineChart", TimelineChart)
    if timeline is not None:
        step("TimelineChart 空数据", lambda: paint_chart(timeline, "timeline"))
        step("TimelineChart 正常步骤", lambda: (
            timeline.set_steps([
                {"name": "接口联调", "start": "2026-01-05",
                 "due": "2026-02-10", "progress": 60, "status": "进行中"},
                {"name": "前端开发", "start": "2026-01-10",
                 "due": "2026-02-20", "progress": 100, "status": "已完成"},
                {"name": "灰度发布", "start": "2026-02-15",
                 "due": "2026-03-01", "progress": 0, "status": "已阻塞"},
            ]),
            paint_chart(timeline, "timeline"),
        )[-1])
        step("TimelineChart 只有一头日期", lambda: (
            timeline.set_steps([
                {"name": "只有截止", "start": "", "due": "2026-03-01",
                 "progress": 0, "status": "未开始"},
            ]),
            paint_chart(timeline, "timeline"),
        )[-1])
        step("TimelineChart 全无日期（应显示空状态）", lambda: (
            timeline.set_steps([{"name": "没日期", "start": "", "due": "",
                                 "progress": 0, "status": "未开始"}]),
            paint_chart(timeline, "timeline"),
        )[-1])

    load = step("构造 LoadChart", LoadChart)
    if load is not None:
        step("LoadChart 空数据", lambda: paint_chart(load, "load"))
        step("LoadChart 有负荷", lambda: (
            load.set_rows([
                {"name": "王强", "hours": 60, "ratio": 1.5},
                {"name": "李工", "hours": 40, "ratio": 1.0},
                {"name": "赵敏", "hours": 10, "ratio": 0.25},
            ]),
            paint_chart(load, "load"),
        )[-1])
        step("LoadChart 全零负荷", lambda: (
            load.set_rows([{"name": "新来的", "hours": 0, "ratio": 0}]),
            paint_chart(load, "load"),
        )[-1])

    # ---- 6. 各种对话框 ----
    print("\n[6] 对话框")
    from detail import ImportDialog, ProjectDialog, SubmitWindow, StepDialog
    from timer_ui import SessionListDialog

    step("SubmitWindow（员工导出）", lambda: SubmitWindow(window))
    step("ProjectDialog（新建项目）", lambda: ProjectDialog(window, None))

    project_rows = window.store.projects()
    if project_rows:
        step("ProjectDialog（已有项目）",
             lambda: ProjectDialog(window, project_rows[0]["id"]))
    else:
        print("  [跳过] ProjectDialog（已有项目）—— 库里还没有项目")

    step("StepDialog（新增步骤）", lambda: StepDialog(window, None))
    step("WorklogDialog（录工时）",
         lambda: main_module.WorklogDialog(window, None))
    step("AssignmentDialog（任务分配）",
         lambda: main_module.AssignmentDialog(window))
    step("EmployeeDialog（新增员工）",
         lambda: main_module.EmployeeDialog(window))

    employee_rows = window.store.employees()
    if employee_rows:
        employee = dict(employee_rows[0])
        step("EditWorklogDialog",
             lambda: main_module.EditWorklogDialog(window, {
                 "id": 0, "employee_id": employee["id"], "project_id": None,
                 "step_id": None, "work_date": "2026-01-01", "hours": 8,
                 "content": "测试", "source": "manual",
             }))
        step("SessionListDialog（计时明细）", lambda: SessionListDialog(
            window, window.store, employee["id"], "2026-01-01", "2026-12-31"))
    else:
        print("  [跳过] 员工相关对话框 —— 库里还没有员工")

    # ---- 7. 小助手问答（构造气泡）----
    print("\n[7] 小助手")
    window.assistant_page.ask_now("现在什么情况")
    step("问一句并渲染气泡", lambda: window.assistant_page.refresh())

    # ---- 8. 切主题（递归崩过的地方）----
    # 这里踩过一个狠的：ChatBubble.apply_theme() 调 setStyleSheet()，
    # 而 setStyleSheet 自己会触发 StyleChange 事件 → 又调 apply_theme()
    # → 无限递归 → 栈溢出。那是 C++ 层的崩溃，Python 的 try/except
    # 拦不住，整个进程直接消失。所以这一段要真的来回切几次。
    print("\n[8] 切换主题（事件处理路径）")

    def switch_many(times):
        """来回切若干次。有递归的话次数越多越容易崩。"""
        for index in range(times):
            window.change_theme("dark" if index % 2 else "light")
        return times

    step("切到深色", lambda: window.change_theme("dark"))
    step("再切回浅色", lambda: window.change_theme("light"))
    step("连续来回切十次", lambda: switch_many(10))

    # 气泡的 apply_theme 就是递归源头，所以再问一句造出新气泡、然后切主题
    step("提问造出气泡", lambda: window.assistant_page.ask_now("谁最忙") or "ok")
    step("有气泡的情况下再切主题",
         lambda: switch_many(4) and window.change_theme("light"))
    step("切主题后图表仍能画", lambda: paint_chart(trend, "trend"))

    # ---- 汇总 ----
    failed = [item for item in RESULTS if not item[0]]
    print("\n" + "=" * 60)
    print(f"共 {len(RESULTS)} 项，失败 {len(failed)} 项")
    if failed:
        print("\n失败清单：")
        for _ok, label, detail in failed:
            print(f"  · {label}")
            if detail:
                print(f"      {detail}")
    else:
        print("界面全部构造成功，没有崩溃。")
    print("=" * 60)

    store.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
