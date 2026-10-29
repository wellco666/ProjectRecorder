"""项目详情：一个项目怎么看。

分成几页，顺序按老板实际的思考顺序来：
    概览   —— 是什么项目、进度如何、预测怎么说
    步骤   —— 拆成了哪几步，卡在哪
    评估   —— 技术能力够不够、手上有哪些有利条件
    趋势   —— 关键指标在往哪走
    基本信息 —— 改名字、预算、日期这些

这个文件里还住着两个跨项目的工作流窗口：
    SubmitWindow  员工端：导出自己要交给老板的工时
    ImportDialog  老板端：导入员工发来的工时文件

有意不把「预测」单独做一页——它应该和项目基本信息一起出现，
因为老板看到进度数字的下一句话就是「那会怎么样」。
"""
import datetime
import os

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QFont
from PyQt6.QtWidgets import (
    QAbstractItemView, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox,
    QFileDialog, QFormLayout, QHBoxLayout, QHeaderView, QLabel, QLineEdit,
    QListWidget, QListWidgetItem, QMessageBox, QPushButton, QScrollArea,
    QSizePolicy, QSpinBox, QTableWidget, QTableWidgetItem, QTabWidget,
    QTextEdit, QToolButton, QVBoxLayout, QWidget,
)

import metrics
import rules
import theme
from chart import TimelineChart, TrendChart
from db import ASSIGN_STATUS, PRIORITY, PROJECT_STATUS, STEP_STATUS
from metrics import budget_usage, parse_date
from widgets import (
    Badge, HairLine, SectionTitle, StatCard, fmt_hours, fmt_money, label,
    level_color, muted,
)


# 兼容旧的内部调用；日期解析统一由 metrics 提供
_parse_date = parse_date


class ProjectDialog(QDialog):
    """项目详情窗口。project_id 为 None 时是新建。"""

    def __init__(self, window, project_id=None):
        super().__init__(window)
        self.window = window
        self.store = window.store
        self.project_id = project_id
        self.is_new = project_id is None

        self.setWindowTitle("新建项目" if self.is_new else "项目详情")
        self.setMinimumSize(960, 700)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        layout.addWidget(self._make_header())

        # 基本信息表单**一律创建**：详情页的「编辑基本信息」也要用它，
        # 而且 _load() 要往这些字段里填值。
        # 之前只在新建时创建，导致打开已有项目就 AttributeError。
        self.basic_page = self._make_basic_form()

        if self.is_new:
            self.tabs = None
            layout.addWidget(self.basic_page, 1)
        else:
            self.tabs = QTabWidget()
            self.tabs.setObjectName("InnerTabs")
            self.tabs.addTab(self._make_overview_tab(), "概览")
            self.tabs.addTab(self.basic_page, "基本信息")
            self.tabs.addTab(self._make_steps_tab(), "步骤")
            self.tabs.addTab(self._make_assess_tab(), "能力与资源")
            self.tabs.addTab(self._make_metric_tab(), "指标趋势")
            layout.addWidget(self.tabs, 1)

        layout.addWidget(self._make_buttons())
        self._load()

    # ------------------------------------------------------------ 顶部
    def _make_header(self):
        header = QWidget()
        header.setObjectName("ToolBar")
        header.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        row = QHBoxLayout(header)
        row.setContentsMargins(20, 12, 20, 12)
        row.setSpacing(10)

        self.title_label = label("新建项目", "ToolTitle")
        row.addWidget(self.title_label)
        self.badge = Badge("", theme.palette()["fg_dim"])
        row.addWidget(self.badge)
        row.addStretch()

        self.meta_label = label("", "ToolMeta")
        row.addWidget(self.meta_label)
        return header

    # ------------------------------------------------------------ 基本信息
    def _make_basic_form(self):
        page = QWidget()
        outer = QVBoxLayout(page)
        outer.setContentsMargins(20, 16, 20, 16)
        outer.setSpacing(12)

        form = QFormLayout()
        form.setSpacing(10)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.f_name = QLineEdit()
        self.f_name.setPlaceholderText("例如：智慧园区二期")
        self.f_owner = QLineEdit()
        self.f_client = QLineEdit()

        self.f_status = QComboBox()
        self.f_status.addItems(PROJECT_STATUS)
        self.f_priority = QComboBox()
        self.f_priority.addItems(PRIORITY)
        self.f_priority.setCurrentText("中")

        self.f_start = QLineEdit()
        self.f_start.setPlaceholderText("YYYY-MM-DD")
        self.f_due = QLineEdit()
        self.f_due.setPlaceholderText("YYYY-MM-DD")

        self.f_budget = QDoubleSpinBox()
        self.f_budget.setRange(0, 1e9)
        self.f_budget.setDecimals(0)
        self.f_budget.setSingleStep(10000)
        self.f_cost = QDoubleSpinBox()
        self.f_cost.setRange(0, 1e9)
        self.f_cost.setDecimals(0)
        self.f_cost.setSingleStep(10000)

        self.f_progress = QSpinBox()
        self.f_progress.setRange(0, 100)
        self.f_progress.setSuffix(" %")

        self.f_note = QTextEdit()
        self.f_note.setFixedHeight(80)
        self.f_note.setPlaceholderText("背景、变更、风险备忘…")

        form.addRow("项目名称", self.f_name)
        form.addRow("负责人", self.f_owner)
        form.addRow("客户 / 需求方", self.f_client)
        form.addRow("状态", self.f_status)
        form.addRow("优先级", self.f_priority)
        form.addRow("开始日期", self.f_start)
        form.addRow("计划截止", self.f_due)
        form.addRow("预算", self.f_budget)
        form.addRow("已花费", self.f_cost)
        form.addRow("当前进度", self.f_progress)
        form.addRow("备注", self.f_note)
        outer.addLayout(form)
        outer.addStretch()
        return page

    # ------------------------------------------------------------ 概览
    def _make_overview_tab(self):
        page = QWidget()
        outer = QVBoxLayout(page)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(14)

        # 指标卡
        cards = QHBoxLayout()
        cards.setSpacing(10)
        self.card_progress = StatCard("进度", "0%")
        self.card_days = StatCard("剩余天数", "—")
        self.card_budget = StatCard("预算使用", "—")
        self.card_hours = StatCard("投入工时", "0", "小时")
        for card in (self.card_progress, self.card_days,
                     self.card_budget, self.card_hours):
            cards.addWidget(card)
        outer.addLayout(cards)

        # 预测结论
        outer.addWidget(SectionTitle("预测与依据"))
        self.advice = QWidget()
        self.advice.setObjectName("AdviceBox")
        self.advice.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        advice_layout = QVBoxLayout(self.advice)
        advice_layout.setContentsMargins(18, 14, 18, 14)
        advice_layout.setSpacing(6)
        self.advice_headline = label("", "AdviceHeadline")
        self.advice_headline.setWordWrap(True)
        self.advice_body = QLabel("")
        self.advice_body.setObjectName("AdviceReason")
        self.advice_body.setWordWrap(True)
        self.advice_body.setTextFormat(Qt.TextFormat.PlainText)
        self.advice_actions = QLabel("")
        self.advice_actions.setObjectName("AdviceAction")
        self.advice_actions.setWordWrap(True)
        advice_layout.addWidget(self.advice_headline)
        advice_layout.addWidget(self.advice_body)
        advice_layout.addWidget(self.advice_actions)
        outer.addWidget(self.advice)

        # 备注 + 编辑按钮
        note_row = QHBoxLayout()
        note_row.addWidget(SectionTitle("备注"))
        note_row.addStretch()
        edit = QPushButton("编辑基本信息")
        edit.setObjectName("GhostButton")
        edit.clicked.connect(self._edit_basic)
        note_row.addWidget(edit)
        outer.addLayout(note_row)

        self.note_view = QTextEdit()
        self.note_view.setReadOnly(True)
        self.note_view.setFixedHeight(90)
        outer.addWidget(self.note_view)
        outer.addStretch()
        return page

    # ------------------------------------------------------------ 步骤
    def _make_steps_tab(self):
        page = QWidget()
        outer = QVBoxLayout(page)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(10)

        row = QHBoxLayout()
        row.addWidget(SectionTitle("进度时间轴"))
        row.addStretch()
        self.timeline_hint = muted("")
        row.addWidget(self.timeline_hint)
        outer.addLayout(row)

        # 计划 vs 实际：表格里「已过期」只是三个字，
        # 这张图上「今天」那条竖线会直接穿过没做完的横条
        self.timeline = TimelineChart()
        self.timeline.set_empty("步骤填上开始或截止日期后，这里显示时间轴")
        outer.addWidget(self.timeline)
        # 时间轴的高度跟着步骤数走，不必占满整页
        self.timeline.setSizePolicy(QSizePolicy.Policy.Preferred,
                                    QSizePolicy.Policy.Fixed)

        row = QHBoxLayout()
        row.addWidget(SectionTitle("分析步骤"))
        row.addStretch()
        add = QPushButton("新增步骤")
        add.setObjectName("GhostButton")
        add.clicked.connect(self._add_step)
        row.addWidget(add)
        edit = QPushButton("编辑选中")
        edit.setObjectName("GhostButton")
        edit.clicked.connect(self._edit_step)
        row.addWidget(edit)
        remove = QPushButton("删除选中")
        remove.setObjectName("DangerButton")
        remove.clicked.connect(self._delete_step)
        row.addWidget(remove)
        outer.addLayout(row)

        self.step_table = QTableWidget(0, 7)
        self.step_table.setHorizontalHeaderLabels(
            ["序号", "步骤", "负责人", "状态", "进度", "截止", "备注"]
        )
        self.step_table.verticalHeader().setVisible(False)
        self.step_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.step_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.step_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.step_table.setShowGrid(False)
        self.step_table.itemDoubleClicked.connect(lambda _: self._edit_step())
        header = self.step_table.horizontalHeader()
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.Stretch)
        for column in (0, 2, 3, 4, 5):
            header.setSectionResizeMode(column, QHeaderView.ResizeMode.ResizeToContents)
        outer.addWidget(self.step_table, 1)
        return page

    # ------------------------------------------------------------ 评估
    def _make_assess_tab(self):
        page = QWidget()
        outer = QVBoxLayout(page)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(10)

        hint = muted(
            "技术能力：这项本事够不够用（1~5 分）。有利资源：手上有什么有利条件。"
            "权重是「这项有多重要」，用来算加权总分。"
        )
        hint.setWordWrap(True)
        outer.addWidget(hint)

        for kind, title in (("ability", "技术能力"), ("resource", "有利资源")):
            outer.addWidget(SectionTitle(title))
            table = QTableWidget(0, 4)
            table.setHorizontalHeaderLabels(["名称", "评分", "权重", "备注"])
            table.verticalHeader().setVisible(False)
            table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
            table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
            table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
            table.setShowGrid(False)
            table.setMaximumHeight(170)
            header = table.horizontalHeader()
            header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
            header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
            header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
            header.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
            outer.addWidget(table)

            buttons = QHBoxLayout()
            buttons.addStretch()
            add = QPushButton(f"新增{title}")
            add.setObjectName("GhostButton")
            add.clicked.connect(lambda _, k=kind: self._add_assessment(k))
            buttons.addWidget(add)
            remove = QPushButton("删除选中")
            remove.setObjectName("DangerButton")
            remove.clicked.connect(lambda _, k=kind: self._delete_assessment(k))
            buttons.addWidget(remove)
            outer.addLayout(buttons)

            if kind == "ability":
                self.ability_table = table
                self.ability_score_label = muted("")
                outer.addWidget(self.ability_score_label)
            else:
                self.resource_table = table
                self.resource_score_label = muted("")
                outer.addWidget(self.resource_score_label)
        outer.addStretch()
        return page

    # ------------------------------------------------------------ 指标
    def _make_metric_tab(self):
        page = QWidget()
        outer = QVBoxLayout(page)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(10)

        row = QHBoxLayout()
        row.addWidget(SectionTitle("指标趋势"))
        row.addStretch()
        self.metric_picker = QComboBox()
        self.metric_picker.setMinimumWidth(160)
        self.metric_picker.currentTextChanged.connect(self._render_metric_chart)
        row.addWidget(label("指标", "PanelHint"))
        row.addWidget(self.metric_picker)
        add = QPushButton("录入指标")
        add.setObjectName("GhostButton")
        add.clicked.connect(self._add_metric)
        row.addWidget(add)
        outer.addLayout(row)

        self.metric_chart = TrendChart()
        self.metric_chart.set_empty("录入指标后这里显示趋势")
        outer.addWidget(self.metric_chart, 1)

        self.metric_table = QTableWidget(0, 4)
        self.metric_table.setHorizontalHeaderLabels(["日期", "数值", "单位", "备注"])
        self.metric_table.verticalHeader().setVisible(False)
        self.metric_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.metric_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.metric_table.setShowGrid(False)
        self.metric_table.setMaximumHeight(190)
        header = self.metric_table.horizontalHeader()
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        for column in (0, 1, 2):
            header.setSectionResizeMode(column, QHeaderView.ResizeMode.ResizeToContents)
        outer.addWidget(self.metric_table)
        return page

    # ------------------------------------------------------------ 底部
    def _make_buttons(self):
        bar = QWidget()
        bar.setObjectName("StatusBar")
        bar.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        row = QHBoxLayout(bar)
        row.setContentsMargins(20, 10, 20, 10)
        row.setSpacing(8)
        row.addStretch()

        if not self.is_new:
            delete = QPushButton("删除项目")
            delete.setObjectName("DangerButton")
            delete.clicked.connect(self._delete_project)
            row.addWidget(delete)

        close = QPushButton("关闭" if not self.is_new else "取消")
        close.setObjectName("GhostButton")
        close.clicked.connect(self.reject)
        row.addWidget(close)

        if self.is_new:
            save = QPushButton("创建")
            save.setObjectName("PrimaryButton")
            save.clicked.connect(self._create)
            row.addWidget(save)
        else:
            save = QPushButton("保存")
            save.setObjectName("PrimaryButton")
            save.clicked.connect(self._save_basic)
            row.addWidget(save)
        return bar

    # ------------------------------------------------------------ 载入
    def _load(self):
        if self.is_new:
            return
        row = self.store.project(self.project_id)
        if row is None:
            self.reject()
            return
        self.project = dict(row)
        self.title_label.setText(self.project["name"])
        self.badge.setText(self.project["status"])
        self.badge.set_color(theme.palette()["accent_dim"])
        self.meta_label.setText(
            f"{self.project['owner'] or '未指定负责人'} · "
            f"{self.project['start_date'] or '—'} → {self.project['due_date'] or '—'}"
        )
        self._fill_basic(self.project)
        self._load_overview()
        self._load_steps()
        self._load_assessments()
        self._load_metrics()

    def _fill_basic(self, project):
        """把项目数据填进表单。新建时的表单和详情页共用这一套字段。"""
        for name, widget in (
            ("f_name", project.get("name", "")),
            ("f_owner", project.get("owner", "")),
            ("f_client", project.get("client", "")),
            ("f_start", project.get("start_date", "")),
            ("f_due", project.get("due_date", "")),
        ):
            getattr(self, name).setText(str(widget))
        self.f_status.setCurrentText(project.get("status", "进行中"))
        self.f_priority.setCurrentText(project.get("priority", "中"))
        self.f_budget.setValue(float(project.get("budget", 0) or 0))
        self.f_cost.setValue(float(project.get("cost", 0) or 0))
        self.f_progress.setValue(int(project.get("progress", 0) or 0))
        self.f_note.setPlainText(project.get("note", ""))

    def _collect_basic(self):
        return {
            "name": self.f_name.text().strip(),
            "owner": self.f_owner.text().strip(),
            "client": self.f_client.text().strip(),
            "status": self.f_status.currentText(),
            "priority": self.f_priority.currentText(),
            "start_date": self.f_start.text().strip(),
            "due_date": self.f_due.text().strip(),
            "budget": self.f_budget.value(),
            "cost": self.f_cost.value(),
            "progress": self.f_progress.value(),
            "note": self.f_note.toPlainText().strip(),
        }

    def _load_overview(self):
        result = rules.predict(self.store, self.project_id)
        if not result:
            return
        metrics = result["metrics"]
        self.card_progress.update_values(f"{self.project['progress']}%", "",
                                        f"{metrics['step_done']}/{metrics['step_total']} 步完成")
        days = metrics["left_days"]
        if self.project["status"] == "已交付":
            self.card_days.update_values("已交付", "", "")
        elif days is None:
            self.card_days.update_values("—", "", "未设计划截止")
        elif days < 0:
            self.card_days.update_values(f"{abs(days)}", "天", "已超期",
                                         color=level_color("风险"))
        else:
            note = ""
            if metrics["used_days"] is not None and metrics["total_days"]:
                pct = metrics["used_days"] / max(1, metrics["total_days"]) * 100
                note = f"工期已过 {pct:.0f}%"
            self.card_days.update_values(f"{days}", "天", note)

        usage = budget_usage(self.project)
        if usage["has_budget"]:
            note = (f"预算 {fmt_money(usage['budget'])}，"
                    f"已花 {fmt_money(usage['cost'])}")
            color = None
            if usage["over"]:
                color = level_color("严重")
            elif usage["used_ratio"] >= 0.85:
                color = level_color("关注")
            self.card_budget.update_values(
                f"{usage['used_ratio'] * 100:.0f}%", "", note, color=color
            )
        else:
            self.card_budget.update_values("—", "", "未设预算")

        self.card_hours.update_values(
            f"{metrics['total_hours']:,.1f}", "小时",
            f"计划 {metrics['planned_hours']:,.0f} 小时",
        )

        self.advice_headline.setText(f"【{result['level']}】{result['headline']}")
        self.advice_headline.setStyleSheet(
            f"color: {level_color(result['level'])}; font-weight: 600; font-size: 14px;"
        )
        self.advice_body.setText("\n".join(
            f"· {r['text']}　（{r.get('detail', '')}）" for r in result["reasons"]
        ))
        self.advice_actions.setText(
            "建议：\n" + "\n".join(f"· {a}" for a in result["actions"])
            if result["actions"] else ""
        )
        self.note_view.setPlainText(self.project["note"])

    def _load_steps(self):
        rows = self.store.steps(self.project_id)
        # 时间轴和表格用同一批数据，一次查出来分给两边
        self._draw_timeline(rows)
        self.step_table.setRowCount(len(rows))
        for index, row in enumerate(rows):
            values = [str(row["seq"]), row["name"], row["owner"] or "—",
                      row["status"], f"{row['progress'] or 0}%",
                      row["due_date"] or "—", row["note"] or ""]
            for column, text in enumerate(values):
                item = QTableWidgetItem(text)
                if column in (0, 3, 4, 5):
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                if column == 3:
                    color = {"已完成": level_color("健康"),
                             "进行中": theme.palette()["accent_dim"],
                             "已阻塞": level_color("严重")}.get(row["status"])
                    if color:
                        item.setForeground(QColor(color))
                if column == 0:
                    item.setData(Qt.ItemDataRole.UserRole, row["id"])
                self.step_table.setItem(index, column, item)

    def _draw_timeline(self, rows):
        """把步骤喂给时间轴，并按行数调整高度。

        时间轴只画有日期的步骤。一个都没有时给出提示，
        免得用户以为图坏了——大多是没填日期，不是程序问题。
        """
        steps = [
            {
                "name": row["name"],
                "start": row["start_date"],
                "due": row["due_date"],
                "progress": row["progress"],
                "status": row["status"],
            }
            for row in rows
        ]
        self.timeline.set_steps(steps)
        dated = self.timeline.dated_count
        self.timeline.setFixedHeight(self.timeline.sizeHint().height())

        if not rows:
            self.timeline_hint.setText("")
        elif dated == 0:
            self.timeline_hint.setText(
                f"{len(rows)} 个步骤都没填日期，时间轴画不出来——"
                "在步骤里补上开始或截止日期。"
            )
        elif dated < len(rows):
            self.timeline_hint.setText(
                f"{len(rows) - dated} 个步骤没填日期，没有画进时间轴。"
            )
        else:
            self.timeline_hint.setText("")

    def _load_assessments(self):
        for kind, table, score_label in (
            ("ability", self.ability_table, self.ability_score_label),
            ("resource", self.resource_table, self.resource_score_label),
        ):
            rows = self.store.assessments(self.project_id, kind)
            table.setRowCount(len(rows))
            for index, row in enumerate(rows):
                values = [row["name"], str(row["score"]), f"{row['weight']:g}",
                          row["note"] or ""]
                for column, text in enumerate(values):
                    item = QTableWidgetItem(text)
                    if column in (1, 2):
                        item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                    if column == 0:
                        item.setData(Qt.ItemDataRole.UserRole, row["id"])
                    table.setItem(index, column, item)
            score = rules._weighted([dict(r) for r in rows])
            total = sum(float(r["weight"]) for r in rows if float(r["weight"]) > 0)
            if score is None:
                score_label.setText("还没有评分")
            else:
                score_label.setText(
                    f"加权总分 {score:.2f} / 5（参与计算权重合计 {total:g}）"
                )

    def _load_metrics(self):
        names = self.store.metric_names(self.project_id)
        current = self.metric_picker.currentText()
        self.metric_picker.blockSignals(True)
        self.metric_picker.clear()
        self.metric_picker.addItems(names)
        if current in names:
            self.metric_picker.setCurrentText(current)
        self.metric_picker.blockSignals(False)
        self._render_metric_chart()

    def _render_metric_chart(self):
        name = self.metric_picker.currentText()
        if not name:
            self.metric_chart.set_series({})
            self.metric_chart.set_empty("先录入指标，或在上方选择一个指标")
            self.metric_table.setRowCount(0)
            return
        rows = self.store.metrics(self.project_id, name)
        self.metric_chart.set_series({
            "labels": [row["metric_date"] for row in rows],
            "series": [{"name": f"{name}({rows[0]['unit']})" if rows and rows[0]["unit"] else name,
                        "data": [float(row["value"]) for row in rows]}],
        })
        self.metric_table.setRowCount(len(rows))
        for index, row in enumerate(rows):
            values = [row["metric_date"], f"{row['value']:,.2f}",
                      row["unit"] or "", row["note"] or ""]
            for column, text in enumerate(values):
                item = QTableWidgetItem(text)
                if column in (0, 1, 2):
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                if column == 0:
                    item.setData(Qt.ItemDataRole.UserRole, row["id"])
                self.metric_table.setItem(index, column, item)

    # ------------------------------------------------------------ 操作
    def _create(self):
        data = self._collect_basic()
        if not data["name"]:
            QMessageBox.warning(self, "缺少名称", "项目名称不能为空。")
            return
        self.project_id = self.store.add_project(data)
        self.accept()

    def _save_basic(self):
        data = self._collect_basic()
        if not data["name"]:
            QMessageBox.warning(self, "缺少名称", "项目名称不能为空。")
            return
        self.store.update_project(self.project_id, data)
        self.project = dict(self.store.project(self.project_id))
        self.title_label.setText(self.project["name"])
        self.meta_label.setText(
            f"{self.project['owner'] or '未指定负责人'} · "
            f"{self.project['start_date'] or '—'} → {self.project['due_date'] or '—'}"
        )
        self._load_overview()
        self.window.refresh_all()

    def _edit_basic(self):
        """详情页里改基本信息：开一个独立的小弹窗，不动主表单的控件"""
        dialog = ProjectFormDialog(self, self.project)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            data = dialog.values()
            if not data["name"]:
                QMessageBox.warning(self, "缺少名称", "项目名称不能为空。")
                return
            self.store.update_project(self.project_id, data)
            self.project = dict(self.store.project(self.project_id))
            self.title_label.setText(self.project["name"])
            self.meta_label.setText(
                f"{self.project['owner'] or '未指定负责人'} · "
                f"{self.project['start_date'] or '—'} → {self.project['due_date'] or '—'}"
            )
            self._load_overview()
            self.window.refresh_all()

    def _delete_project(self):
        answer = QMessageBox.question(
            self, "删除项目",
            f"确定删除《{self.project['name']}》？\n"
            "该项目的步骤、分配、评估、指标会一并删除，不能撤销。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer == QMessageBox.StandardButton.Yes:
            self.store.delete_project(self.project_id)
            self.window.refresh_all()
            self.accept()

    # ---- 步骤 ----
    def _add_step(self):
        dialog = StepDialog(self, None)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.store.add_step(self.project_id, dialog.values())
            self._load_steps()
            self.window.refresh_all()

    def _edit_step(self):
        row_index = self.step_table.currentRow()
        if row_index < 0:
            return
        step_id = self.step_table.item(row_index, 0).data(Qt.ItemDataRole.UserRole)
        step = self.store.one("SELECT * FROM step WHERE id = ?", (step_id,))
        if step is None:
            return
        dialog = StepDialog(self, dict(step))
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.store.update_step(step_id, dialog.values())
            self._load_steps()
            self.window.refresh_all()

    def _delete_step(self):
        row_index = self.step_table.currentRow()
        if row_index < 0:
            QMessageBox.information(self, "未选中", "先选中一行步骤。")
            return
        step_id = self.step_table.item(row_index, 0).data(Qt.ItemDataRole.UserRole)
        if QMessageBox.question(
            self, "删除步骤", "确定删除这个步骤？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        ) == QMessageBox.StandardButton.Yes:
            self.store.delete_step(step_id)
            self._load_steps()
            self.window.refresh_all()

    # ---- 评估 ----
    def _add_assessment(self, kind):
        dialog = AssessmentDialog(self, kind, None, self.project_id)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.store.add_assessment(self.project_id, dialog.values())
            self._load_assessments()
            self.window.refresh_all()

    def _delete_assessment(self, kind):
        table = self.ability_table if kind == "ability" else self.resource_table
        row_index = table.currentRow()
        if row_index < 0:
            QMessageBox.information(self, "未选中", "先选中一行。")
            return
        assessment_id = table.item(row_index, 0).data(Qt.ItemDataRole.UserRole)
        if QMessageBox.question(
            self, "删除", "确定删除这一条？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        ) == QMessageBox.StandardButton.Yes:
            self.store.delete_assessment(assessment_id)
            self._load_assessments()
            self.window.refresh_all()

    # ---- 指标 ----
    def _add_metric(self):
        dialog = MetricDialog(self, None, self.store, self.project_id)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.store.add_metric(self.project_id, dialog.values())
            self._load_metrics()
            self.window.refresh_all()


# ================================================================== 子对话框
class ProjectFormDialog(QDialog):
    """项目基本信息的独立表单弹窗。

    和 ProjectDialog 新建时那套字段一致，但**控件是独立的**——
    不能在详情页上复用同一批控件，那会把它们从原布局里抢走。
    """

    def __init__(self, parent, project=None):
        super().__init__(parent)
        project = dict(project or {})
        self.setWindowTitle("编辑基本信息")
        self.setMinimumWidth(480)

        layout = QVBoxLayout(self)
        form = QFormLayout()
        form.setSpacing(10)

        self.f_name = QLineEdit(project.get("name", ""))
        self.f_owner = QLineEdit(project.get("owner", ""))
        self.f_client = QLineEdit(project.get("client", ""))
        self.f_status = QComboBox()
        self.f_status.addItems(PROJECT_STATUS)
        self.f_status.setCurrentText(project.get("status", "进行中"))
        self.f_priority = QComboBox()
        self.f_priority.addItems(PRIORITY)
        self.f_priority.setCurrentText(project.get("priority", "中"))
        self.f_start = QLineEdit(project.get("start_date", ""))
        self.f_start.setPlaceholderText("YYYY-MM-DD")
        self.f_due = QLineEdit(project.get("due_date", ""))
        self.f_due.setPlaceholderText("YYYY-MM-DD")
        self.f_budget = QDoubleSpinBox()
        self.f_budget.setRange(0, 1e9)
        self.f_budget.setDecimals(0)
        self.f_budget.setSingleStep(10000)
        self.f_budget.setValue(float(project.get("budget", 0) or 0))
        self.f_cost = QDoubleSpinBox()
        self.f_cost.setRange(0, 1e9)
        self.f_cost.setDecimals(0)
        self.f_cost.setSingleStep(10000)
        self.f_cost.setValue(float(project.get("cost", 0) or 0))
        self.f_progress = QSpinBox()
        self.f_progress.setRange(0, 100)
        self.f_progress.setSuffix(" %")
        self.f_progress.setValue(int(project.get("progress", 0) or 0))
        self.f_note = QTextEdit()
        self.f_note.setFixedHeight(80)
        self.f_note.setPlainText(project.get("note", ""))

        form.addRow("项目名称", self.f_name)
        form.addRow("负责人", self.f_owner)
        form.addRow("客户 / 需求方", self.f_client)
        form.addRow("状态", self.f_status)
        form.addRow("优先级", self.f_priority)
        form.addRow("开始日期", self.f_start)
        form.addRow("计划截止", self.f_due)
        form.addRow("预算", self.f_budget)
        form.addRow("已花费", self.f_cost)
        form.addRow("当前进度", self.f_progress)
        form.addRow("备注", self.f_note)
        layout.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("保存")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def values(self):
        return {
            "name": self.f_name.text().strip(),
            "owner": self.f_owner.text().strip(),
            "client": self.f_client.text().strip(),
            "status": self.f_status.currentText(),
            "priority": self.f_priority.currentText(),
            "start_date": self.f_start.text().strip(),
            "due_date": self.f_due.text().strip(),
            "budget": self.f_budget.value(),
            "cost": self.f_cost.value(),
            "progress": self.f_progress.value(),
            "note": self.f_note.toPlainText().strip(),
        }


# ================================================================== 员工提交
class SubmitWindow(QDialog):
    """员工端：导出自己要交给老板的工时文件。

    这个窗口是给**员工**用的，所以刻意做得极简：
    选自己 → 选时间段 → 导出 → 把文件发给老板。
    没有项目、预算、预测这些他不需要看的东西。

    员工电脑上这份数据库可能是空的（他从没用过），
    所以这里也提供「补记工时」，让他没记录时能先把活补上再导出。
    """

    def __init__(self, window):
        super().__init__(window)
        self.window = window
        self.store = window.store
        self.setWindowTitle("导出我的工时")
        self.setMinimumSize(620, 520)
        self._last_path = ""

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        header = QWidget()
        header.setObjectName("ToolBar")
        header.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        head_row = QHBoxLayout(header)
        head_row.setContentsMargins(20, 12, 20, 12)
        head_row.addWidget(label("导出我的工时", "ToolTitle"))
        head_row.addStretch()
        head_row.addWidget(label("导出后把文件发给老板", "ToolMeta"))
        layout.addWidget(header)

        body = QWidget()
        outer = QVBoxLayout(body)
        outer.setContentsMargins(20, 16, 20, 16)
        outer.setSpacing(12)

        hint = muted(
            "老板那边靠「名字」认人，靠「项目名」认项目，所以这两样要填对。\n"
            "同一个文件重复导入不会重复记账，多发几次也没关系。"
        )
        hint.setWordWrap(True)
        outer.addWidget(hint)

        form = QFormLayout()
        form.setSpacing(10)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.f_employee = QComboBox()
        self.f_employee.setEditable(True)
        for row in self.store.employees(only_active=True):
            self.f_employee.addItem(row["name"], row["id"])
        self.f_employee.currentIndexChanged.connect(self._preview)

        self.f_from = QLineEdit(_days_ago(30))
        self.f_from.setPlaceholderText("YYYY-MM-DD")
        self.f_to = QLineEdit(datetime.date.today().isoformat())
        self.f_to.setPlaceholderText("YYYY-MM-DD")
        self.f_from.textChanged.connect(self._preview)
        self.f_to.textChanged.connect(self._preview)

        self.f_note = QLineEdit()
        self.f_note.setPlaceholderText("想跟老板说的话（可选）")

        form.addRow("你是谁", self.f_employee)
        form.addRow("从哪天", self.f_from)
        form.addRow("到哪天", self.f_to)
        form.addRow("附言", self.f_note)
        outer.addLayout(form)

        # 预览：让他导出前就知道自己要交多少
        outer.addWidget(SectionTitle("这次会导出什么"))
        self.preview = QTableWidget(0, 4)
        self.preview.setHorizontalHeaderLabels(["日期", "项目", "工时", "内容"])
        self.preview.verticalHeader().setVisible(False)
        self.preview.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.preview.setShowGrid(False)
        preview_header = self.preview.horizontalHeader()
        preview_header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        for column in (0, 1, 2):
            preview_header.setSectionResizeMode(column, QHeaderView.ResizeMode.ResizeToContents)
        outer.addWidget(self.preview, 1)

        self.summary = muted("")
        self.summary.setWordWrap(True)
        outer.addWidget(self.summary)

        layout.addWidget(body, 1)

        # 底部按钮
        bar = QWidget()
        bar.setObjectName("StatusBar")
        bar.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        bar_row = QHBoxLayout(bar)
        bar_row.setContentsMargins(20, 10, 20, 10)
        bar_row.setSpacing(8)
        add_log = QPushButton("补记一条工时")
        add_log.setObjectName("GhostButton")
        add_log.clicked.connect(self._add_worklog)
        bar_row.addWidget(add_log)
        bar_row.addStretch()
        close = QPushButton("关闭")
        close.setObjectName("GhostButton")
        close.clicked.connect(self.accept)
        bar_row.addWidget(close)
        self.export_button = QPushButton("导出并保存…")
        self.export_button.setObjectName("PrimaryButton")
        self.export_button.clicked.connect(self._export)
        bar_row.addWidget(self.export_button)
        layout.addWidget(bar)

        self._preview()

    def _employee_id(self):
        return self.f_employee.currentData()

    def _preview(self):
        """实时显示将要导出什么，避免导出后才发现是空的。"""
        employee_id = self._employee_id()
        if employee_id is None:
            self.preview.setRowCount(0)
            self.summary.setText(
                "名单里还没有人。先点左下角「补记一条工时」，"
                "填上自己的名字就能开始。"
            )
            return
        try:
            import submit
            data = submit.export_employee(
                self.store, employee_id,
                self.f_from.text().strip(), self.f_to.text().strip(),
            )
        except (ValueError, OSError):
            self.preview.setRowCount(0)
            self.summary.setText("读不到工时记录。")
            return

        entries = data["entries"]
        self.preview.setRowCount(len(entries))
        for index, entry in enumerate(entries):
            values = [entry["work_date"], entry["project"] or "非项目",
                      f"{entry['hours']:g}", entry["content"]]
            for column, text in enumerate(values):
                item = QTableWidgetItem(str(text))
                if column in (0, 2):
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                self.preview.setItem(index, column, item)

        total = sum(entry["hours"] for entry in entries)
        if not entries:
            self.summary.setText(
                "这段时间没有任何工时记录，导出会得到空文件。"
                "先点「补记一条工时」把活补上。"
            )
        else:
            self.summary.setText(
                f"共 {len(entries)} 条、合计 {total:g} 小时。"
                "导出后把文件发给老板，他导入后你的工时就在他那边了。"
            )
        # 记住上次选的人，下次打开不用重选
        self.window.window_settings_set("submit_employee", employee_id)

    def _add_worklog(self):
        """补记一条。员工电脑上可能一条记录都没有，得给个入口。

        WorklogDialog 定义在 main.py 里，而 main.py 又导入本模块——
        模块级导入会循环，所以这里局部导入。
        """
        from main import WorklogDialog
        dialog = WorklogDialog(self.window, self._employee_id())
        if dialog.exec() == QDialog.DialogCode.Accepted:
            values = dialog.values()
            self.window.store.add_worklog(values, dedupe=False)
            # 补记的人可能是新建的，刷新下拉
            current = values.get("employee_id")
            self.f_employee.blockSignals(True)
            self.f_employee.clear()
            for row in self.store.employees(only_active=True):
                self.f_employee.addItem(row["name"], row["id"])
            index = self.f_employee.findData(current)
            if index >= 0:
                self.f_employee.setCurrentIndex(index)
            self.f_employee.blockSignals(False)
            self._preview()
            self.window.flash("已补记一条工时")

    def _export(self):
        employee_id = self._employee_id()
        if employee_id is None:
            QMessageBox.information(self, "还没有人", "先点「补记一条工时」填上自己。")
            return
        import submit
        try:
            data = submit.export_employee(
                self.store, employee_id,
                self.f_from.text().strip(), self.f_to.text().strip(),
                self.f_note.text().strip(),
            )
        except ValueError as error:
            QMessageBox.warning(self, "导出失败", str(error))
            return
        if not data["entries"]:
            QMessageBox.information(
                self, "没有可导出的",
                "这段时间没有工时记录。先「补记一条工时」，或者改一下时间段。",
            )
            return

        # 默认存到桌面，员工最容易找到
        suggested = os.path.join(
            os.path.expanduser("~"), "Desktop", submit.suggested_filename(data)
        )
        path, _ = QFileDialog.getSaveFileName(
            self, "导出工时文件", suggested, "工时文件 (*.json)"
        )
        if not path:
            return
        if not path.lower().endswith(".json"):
            path += ".json"
        try:
            submit.write_file(data, path)
        except OSError as error:
            QMessageBox.warning(self, "保存失败", f"写不进这个位置：{error}")
            return

        self._last_path = path
        QMessageBox.information(
            self, "导出完成",
            f"已保存到：\n{path}\n\n"
            f"共 {len(data['entries'])} 条、"
            f"合计 {sum(e['hours'] for e in data['entries']):g} 小时。\n\n"
            "把这个文件发给老板（微信、邮件都可以），"
            "他在程序里点「导入员工提交」就能收进去。"
        )


def _days_ago(count):
    return (datetime.date.today() - datetime.timedelta(days=count)).isoformat()


# ================================================================== 导入对话框
class ImportDialog(QDialog):
    """老板端：导入员工发来的工时文件，并给出人话报告。

    报告比「导入成功」重要得多——数据对不上时，
    老板需要知道**哪几条没进来、为什么**，否则无从查起。
    """

    def __init__(self, parent, paths):
        super().__init__(parent)
        self.window = parent
        self.store = parent.store
        self.setWindowTitle("导入员工提交")
        self.setMinimumSize(660, 520)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        header = QWidget()
        header.setObjectName("ToolBar")
        header.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        head_row = QHBoxLayout(header)
        head_row.setContentsMargins(20, 12, 20, 12)
        head_row.addWidget(label("导入员工提交", "ToolTitle"))
        head_row.addStretch()
        self.count_label = label(f"{len(paths)} 个文件", "ToolMeta")
        head_row.addWidget(self.count_label)
        layout.addWidget(header)

        body = QWidget()
        outer = QVBoxLayout(body)
        outer.setContentsMargins(20, 16, 20, 16)
        outer.setSpacing(10)

        self.file_list = QTableWidget(0, 3)
        self.file_list.setHorizontalHeaderLabels(["文件", "结果", "明细"])
        self.file_list.verticalHeader().setVisible(False)
        self.file_list.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.file_list.setShowGrid(False)
        self.file_list.setWordWrap(True)
        file_header = self.file_list.horizontalHeader()
        file_header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        file_header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        file_header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        outer.addWidget(self.file_list, 1)

        self.result_label = label("", "PanelHeading")
        self.result_label.setWordWrap(True)
        outer.addWidget(self.result_label)

        self.detail = QTextEdit()
        self.detail.setReadOnly(True)
        self.detail.setFixedHeight(140)
        outer.addWidget(self.detail)

        layout.addWidget(body, 1)

        bar = QWidget()
        bar.setObjectName("StatusBar")
        bar.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        bar_row = QHBoxLayout(bar)
        bar_row.setContentsMargins(20, 10, 20, 10)
        bar_row.addStretch()
        self.import_button = QPushButton("确认导入")
        self.import_button.setObjectName("PrimaryButton")
        self.import_button.clicked.connect(lambda: self._run(paths))
        bar_row.addWidget(self.import_button)
        close = QPushButton("关闭")
        close.setObjectName("GhostButton")
        close.clicked.connect(self.reject)
        bar_row.addWidget(close)
        layout.addWidget(bar)

        self._paths = paths
        self._fill_preview()

    def _fill_preview(self):
        """导入前先说明每个文件是谁的、有多少条，让人确认。"""
        import submit
        self.file_list.setRowCount(len(self._paths))
        for index, path in enumerate(self._paths):
            data, error = submit.read_file(path)
            name = os.path.basename(path)
            if data is None:
                values = [name, "无法读取", error]
            else:
                count = len(data["entries"])
                total = sum(e.get("hours", 0) for e in data["entries"]
                            if isinstance(e, dict))
                values = [name, "待导入",
                          f"{data['employee']['name']}，{count} 条，合计 {total:g} 小时"]
            for column, text in enumerate(values):
                self.file_list.setItem(index, column, QTableWidgetItem(str(text)))
        self.result_label.setText("确认上面这些文件没问题，就点「确认导入」。")
        self.detail.setPlainText("")

    def _run(self, paths):
        import submit
        reports = []
        for path in paths:
            reports.append(submit.import_file(self.store, path))

        # 文件列表刷新成结果
        for index, report in enumerate(reports):
            if index >= self.file_list.rowCount():
                break
            status = "已导入" if report["ok"] else "未导入"
            if report["duplicated"] and not report["added"]:
                status = "全部重复"
            self.file_list.setItem(index, 1, QTableWidgetItem(status))
            self.file_list.setItem(index, 2, QTableWidgetItem(report["summary"]))

        added = sum(r["added"] for r in reports)
        duplicated = sum(r["duplicated"] for r in reports)
        failed = [r for r in reports if not r["ok"]]

        parts = [f"本次新增 {added} 条工时"]
        if duplicated:
            parts.append(f"跳过已存在 {duplicated} 条")
        if failed:
            parts.append(f"{len(failed)} 个文件没导进去")
        self.result_label.setText("，".join(parts) + "。")

        lines = []
        for report in reports:
            lines.append(report["summary"])
            for item in report["skipped"]:
                lines.append(f"　· 跳过：{item}")
            if report["unknown_projects"]:
                lines.append(
                    "　· 这些项目在你的库里不存在，相关记录没有导入："
                    + "、".join(report["unknown_projects"])
                )
                lines.append(
                    "　　要么先在驾驶舱建好同名项目再导一次，"
                    "要么确认员工是不是写错了项目名。"
                )
            if report["error"] and not report["ok"]:
                lines.append(f"　· {report['error']}")
        self.detail.setPlainText("\n".join(lines))

        # 导完就刷新界面，让老板立刻看到新工时
        self.window.refresh_all()
        self.import_button.setText("再导入一次")
        self.window.flash(f"导入完成：新增 {added} 条工时")


class StepDialog(QDialog):
    """新增 / 编辑一个项目步骤"""

    def __init__(self, parent, step=None):
        super().__init__(parent)
        self.step = step or {}
        self.setWindowTitle("编辑步骤" if step else "新增步骤")
        self.setMinimumWidth(420)

        layout = QVBoxLayout(self)
        form = QFormLayout()
        form.setSpacing(10)

        self.f_name = QLineEdit(self.step.get("name", ""))
        self.f_owner = QLineEdit(self.step.get("owner", ""))
        self.f_status = QComboBox()
        self.f_status.addItems(STEP_STATUS)
        self.f_status.setCurrentText(self.step.get("status", "未开始"))
        self.f_progress = QSpinBox()
        self.f_progress.setRange(0, 100)
        self.f_progress.setSuffix(" %")
        self.f_progress.setValue(int(self.step.get("progress", 0) or 0))
        self.f_start = QLineEdit(self.step.get("start_date", ""))
        self.f_start.setPlaceholderText("YYYY-MM-DD")
        self.f_due = QLineEdit(self.step.get("due_date", ""))
        self.f_due.setPlaceholderText("YYYY-MM-DD")
        self.f_note = QLineEdit(self.step.get("note", ""))

        form.addRow("步骤名称", self.f_name)
        form.addRow("负责人", self.f_owner)
        form.addRow("状态", self.f_status)
        form.addRow("进度", self.f_progress)
        form.addRow("开始日期", self.f_start)
        form.addRow("计划截止", self.f_due)
        form.addRow("备注", self.f_note)
        layout.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("确定")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def values(self):
        return {
            "name": self.f_name.text().strip(),
            "owner": self.f_owner.text().strip(),
            "status": self.f_status.currentText(),
            "progress": self.f_progress.value(),
            "start_date": self.f_start.text().strip(),
            "due_date": self.f_due.text().strip(),
            "note": self.f_note.text().strip(),
        }


class AssessmentDialog(QDialog):
    """新增一条能力 / 资源评估"""

    def __init__(self, parent, kind, item=None, project_id=None):
        super().__init__(parent)
        self.kind = kind
        self.item = item or {}
        title = "技术能力" if kind == "ability" else "有利资源"
        self.setWindowTitle(f"新增{title}")
        self.setMinimumWidth(400)

        layout = QVBoxLayout(self)
        hint = label(
            "评分 1~5：能力够不够用 / 资源有多充分。\n"
            "权重：这项对项目有多重要，用来算加权总分（默认 1）。",
            "DialogHint",
        )
        hint.setWordWrap(True)
        layout.addWidget(hint)

        form = QFormLayout()
        form.setSpacing(10)
        self.f_name = QLineEdit(self.item.get("name", ""))
        self.f_name.setPlaceholderText("例如：后端架构 / 甲方内部关系")
        self.f_score = QSpinBox()
        self.f_score.setRange(1, 5)
        self.f_score.setValue(int(self.item.get("score", 3) or 3))
        self.f_weight = QDoubleSpinBox()
        self.f_weight.setRange(0, 10)
        self.f_weight.setSingleStep(0.5)
        self.f_weight.setDecimals(1)
        self.f_weight.setValue(float(self.item.get("weight", 1) or 1))
        self.f_note = QLineEdit(self.item.get("note", ""))

        form.addRow("名称", self.f_name)
        form.addRow("评分", self.f_score)
        form.addRow("权重", self.f_weight)
        form.addRow("备注", self.f_note)
        layout.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("确定")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def values(self):
        return {
            "kind": self.kind,
            "name": self.f_name.text().strip(),
            "score": self.f_score.value(),
            "weight": self.f_weight.value(),
            "note": self.f_note.text().strip(),
        }


class MetricDialog(QDialog):
    """录入一个指标数值"""

    def __init__(self, parent, item=None, store=None, project_id=None):
        super().__init__(parent)
        self.item = item or {}
        self.setWindowTitle("录入指标")
        self.setMinimumWidth(400)

        layout = QVBoxLayout(self)
        layout.addWidget(label(
            "指标名自己定，例如「毛利率」「设备到货率」「客户满意度」。\n"
            "同一个名字的多次录入会连成一条趋势曲线。",
            "DialogHint",
        ))

        form = QFormLayout()
        form.setSpacing(10)
        self.f_date = QLineEdit(
            self.item.get("metric_date") or datetime.date.today().isoformat()
        )
        self.f_date.setPlaceholderText("YYYY-MM-DD")
        self.f_name = QComboBox()
        self.f_name.setEditable(True)
        if store is not None and project_id is not None:
            self.f_name.addItems(store.metric_names(project_id))
        self.f_name.setCurrentText(self.item.get("name", ""))
        self.f_value = QDoubleSpinBox()
        self.f_value.setRange(-1e9, 1e9)
        self.f_value.setDecimals(2)
        self.f_value.setValue(float(self.item.get("value", 0) or 0))
        self.f_unit = QLineEdit(self.item.get("unit", ""))
        self.f_unit.setPlaceholderText("例如 % / 分 / 万")
        self.f_note = QLineEdit(self.item.get("note", ""))

        form.addRow("日期", self.f_date)
        form.addRow("指标名", self.f_name)
        form.addRow("数值", self.f_value)
        form.addRow("单位", self.f_unit)
        form.addRow("备注", self.f_note)
        layout.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("确定")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def values(self):
        return {
            "metric_date": self.f_date.text().strip(),
            "name": self.f_name.currentText().strip(),
            "value": self.f_value.value(),
            "unit": self.f_unit.text().strip(),
            "note": self.f_note.text().strip(),
        }
