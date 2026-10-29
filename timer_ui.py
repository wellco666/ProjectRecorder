"""计时界面：一块常驻的计时条。

放在员工最容易看到的地方（窗口底部常驻），而不是藏进某个页签——
**计时器只有唾手可得才会被真正使用**。藏起来的话，
员工干完活才想起来"忘了开"，一切就白设计了。

三种状态对应三种按钮组合：

    空闲   [开始计时]                        选项目/步骤/说明
    计时中 [暂停] [结束并记录] [丢弃]         显示走动的时长
    暂停中 [继续] [结束并记录] [丢弃]         时长停住

刷新用 QTimer 每秒跳一次，只更新时间文字，不重建控件——
重建会导致按钮闪、焦点丢。
"""
import datetime

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QComboBox, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout, QLabel,
    QLineEdit, QMessageBox, QPushButton, QVBoxLayout, QWidget,
)

import theme
import timer as timer_module
from widgets import label, muted


class TimerBar(QWidget):
    """底部常驻的计时条。"""

    def __init__(self, window):
        super().__init__(window)
        self.window = window
        self.store = window.store
        self._timer = None          # 当前员工的 Timer 对象

        self.setObjectName("TimerBar")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)

        row = QHBoxLayout(self)
        row.setContentsMargins(18, 8, 18, 8)
        row.setSpacing(10)

        row.addWidget(label("计时", "PanelHeading"))

        # 选人（一台电脑可能几个人共用）
        self.f_employee = QComboBox()
        self.f_employee.setMinimumWidth(110)
        self.f_employee.currentIndexChanged.connect(self._on_employee_changed)
        row.addWidget(self.f_employee)

        self.f_project = QComboBox()
        self.f_project.setMinimumWidth(150)
        self.f_project.currentIndexChanged.connect(self._reload_steps)
        row.addWidget(self.f_project)

        self.f_step = QComboBox()
        self.f_step.setMinimumWidth(130)
        row.addWidget(self.f_step)

        self.f_content = QLineEdit()
        self.f_content.setPlaceholderText("在做什么")
        self.f_content.setMinimumWidth(160)
        row.addWidget(self.f_content, 1)

        self.clock_label = QLabel("0:00:00")
        self.clock_label.setObjectName("TimerClock")
        self.clock_label.setMinimumWidth(88)
        self.clock_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        row.addWidget(self.clock_label)

        self.start_button = QPushButton("开始计时")
        self.start_button.setObjectName("PrimaryButton")
        self.start_button.clicked.connect(self._start)
        row.addWidget(self.start_button)

        self.pause_button = QPushButton("暂停")
        self.pause_button.setObjectName("GhostButton")
        self.pause_button.clicked.connect(self._pause)
        row.addWidget(self.pause_button)

        self.finish_button = QPushButton("结束并记录")
        self.finish_button.setObjectName("GhostButton")
        self.finish_button.clicked.connect(self._finish)
        row.addWidget(self.finish_button)

        self.drop_button = QPushButton("丢弃")
        self.drop_button.setObjectName("DangerButton")
        self.drop_button.clicked.connect(self._drop)
        row.addWidget(self.drop_button)

        self.manual_button = QPushButton("补录")
        self.manual_button.setObjectName("TextButton")
        self.manual_button.setToolTip("开会、见客户、忘了开计时器时用这个")
        self.manual_button.clicked.connect(self._manual)
        row.addWidget(self.manual_button)

        # 每秒跳一次。只改文字，不动控件。
        self._tick_timer = QTimer(self)
        self._tick_timer.setInterval(1000)
        self._tick_timer.timeout.connect(self._tick)

        self.reload_employees()
        self.refresh()

    # ------------------------------------------------------------ 数据
    def refresh_sources(self):
        """重读员工和项目列表。别处新建了项目 / 加了员工时调用。

        **不能动正在跑的会话**：计时中如果重建下拉，
        会把当前选的项目/步骤冲掉。所以有会话时只刷新列表内容，
        刷新完再把选中项切回会话记录的那一组。
        """
        session = self._timer.current() if self._timer is not None else None

        self.reload_employees()

        if session is not None:
            # 恢复成会话记录的项目/步骤，别让刷新把正在计时的状态弄乱
            self._select(self.f_project, session["project_id"])
            self._reload_steps()
            self._select(self.f_step, session["step_id"])
            self.f_content.setText(session["content"] or "")

    def reload_employees(self):
        """刷新员工下拉。保留当前选中的人。"""
        current = self.f_employee.currentData()
        self.f_employee.blockSignals(True)
        self.f_employee.clear()
        for row in self.store.employees(only_active=True):
            self.f_employee.addItem(row["name"], row["id"])
        self.f_employee.blockSignals(False)
        if current is not None:
            index = self.f_employee.findData(current)
            if index >= 0:
                self.f_employee.setCurrentIndex(index)
        self._on_employee_changed()

    def _on_employee_changed(self):
        employee_id = self.f_employee.currentData()
        if employee_id is None:
            self._timer = None
        else:
            self._timer = timer_module.Timer(self.store, employee_id)
        self._reload_projects()
        self.refresh()

    def _reload_projects(self):
        current = self.f_project.currentData()
        self.f_project.blockSignals(True)
        self.f_project.clear()
        self.f_project.addItem("（非项目事务）", None)
        for row in self.store.projects():
            if row["status"] in ("已交付", "已取消"):
                continue
            self.f_project.addItem(row["name"], row["id"])
        if current is not None:
            index = self.f_project.findData(current)
            if index >= 0:
                self.f_project.setCurrentIndex(index)
        self.f_project.blockSignals(False)
        self._reload_steps()

    def _reload_steps(self):
        current = self.f_step.currentData()
        self.f_step.blockSignals(True)
        self.f_step.clear()
        self.f_step.addItem("（不指定步骤）", None)
        project_id = self.f_project.currentData()
        if project_id:
            for row in self.store.steps(project_id):
                self.f_step.addItem(row["name"], row["id"])
        if current is not None:
            index = self.f_step.findData(current)
            if index >= 0:
                self.f_step.setCurrentIndex(index)
        self.f_step.blockSignals(False)

    # ------------------------------------------------------------ 显示
    def refresh(self):
        """按当前状态切换按钮可用性和时钟显示。"""
        if self._timer is None:
            self.clock_label.setText("0:00:00")
            self._set_state("idle", show_options=True)
            return

        session = self._timer.current()
        if session is None:
            self._set_state("idle", show_options=True)
            self.clock_label.setText("0:00:00")
            return

        # 有会话：把下拉切到它记录的项目/步骤，并锁住不让改
        self._select(self.f_project, session["project_id"])
        self._reload_steps()
        self._select(self.f_step, session["step_id"])
        self.f_content.setText(session["content"] or "")
        self.clock_label.setText(
            timer_module.format_duration(self._timer.elapsed_seconds())
        )
        self._set_state(session["status"], show_options=False)

    @staticmethod
    def _select(combo, value):
        index = combo.findData(value)
        combo.blockSignals(True)
        if index >= 0:
            combo.setCurrentIndex(index)
        combo.blockSignals(False)

    def _set_state(self, state, show_options):
        """state: idle / running / paused"""
        for widget in (self.f_project, self.f_step, self.f_content):
            widget.setEnabled(show_options)

        running = state == "running"
        paused = state == "paused"
        idle = state == "idle"

        self.start_button.setVisible(idle)
        self.pause_button.setVisible(running)
        self.pause_button.setText("暂停")
        self.finish_button.setVisible(running or paused)
        self.drop_button.setVisible(running or paused)

        if paused:
            # 暂停时主按钮变成「继续」，和结束按钮区分开
            self.start_button.setText("继续")
            self.start_button.setVisible(True)

        color = theme.palette()["fg_strong"]
        if running:
            color = theme.palette()["accent_dim"]
        elif paused:
            color = theme.level_colors()["关注"]
        self.clock_label.setStyleSheet(
            f"color: {color}; font-size: 17px; font-weight: 600;"
            " font-family: Consolas, 'Microsoft YaHei UI';"
        )

        # 只在需要的时候才跑每秒刷新，省电
        if running and not self._tick_timer.isActive():
            self._tick_timer.start()
        elif not running and self._tick_timer.isActive():
            self._tick_timer.stop()

    def _tick(self):
        if self._timer is None:
            self._tick_timer.stop()
            return
        self.clock_label.setText(
            timer_module.format_duration(self._timer.elapsed_seconds())
        )

    # ------------------------------------------------------------ 操作
    def _start(self):
        if self._timer is None:
            QMessageBox.information(self, "还没有人", "先在「员工与工时」里加一个员工。")
            return
        session = self._timer.current()
        if session is not None and session["status"] == "paused":
            ok, message = self._timer.resume()
        else:
            # 项目必填：和员工提交那边一致，不让它静悄悄变成「非项目」
            project_id = self.f_project.currentData()
            ok, message = self._timer.start(
                project_id=project_id,
                step_id=self.f_step.currentData(),
                content=self.f_content.text().strip(),
            )
        self.refresh()
        self.window.flash(message)

    def _pause(self):
        if self._timer is None:
            return
        ok, message = self._timer.pause()
        self.refresh()
        self.window.flash(message)

    def _finish(self):
        if self._timer is None:
            return
        elapsed = self._timer.elapsed_seconds()
        if elapsed < timer_module.MIN_SECONDS:
            ok, message = self._timer.finish()
            self.refresh()
            QMessageBox.information(self, "计时太短", message)
            return

        # 结束时把说明带上（员工可能刚开始没写）
        content = self.f_content.text().strip()
        ok, message = self._timer.finish(content=content)
        self.refresh()
        self.window.refresh_all()
        self.window.flash(message)

    def _drop(self):
        if self._timer is None:
            return
        answer = QMessageBox.question(
            self, "丢弃计时",
            "这段计时会被丢掉、不记账。确定吗？\n"
            "（如果只是记错了项目，应该点「结束并记录」，再去工时列表里改）",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        ok, message = self._timer.cancel()
        self.refresh()
        self.window.flash(message)

    def _manual(self):
        """手工补录。标记为 manual，老板那边能看出来是补的。"""
        from main import WorklogDialog
        dialog = WorklogDialog(self.window, self.f_employee.currentData())
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        values = dialog.values()
        values["source"] = "manual"

        twin = self.window.store.find_duplicate_worklog(values)
        if twin is not None:
            where = twin["project_name"] or "非项目"
            answer = QMessageBox.question(
                self, "可能重复了",
                "已经有一条一样的记录：\n\n"
                f"　{twin['work_date']}　{twin['employee_name']}　{where}　"
                f"{float(twin['hours']):g} 小时\n"
                f"　{twin['content'] or '（没有说明）'}\n\n"
                "如果确实是两段分开的工作，就继续添加。",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if answer != QMessageBox.StandardButton.Yes:
                return

        self.window.store.add_worklog(values, dedupe=False)
        self.window.refresh_all()
        self.window.flash("已补录（老板那边会看到这是补录的）")


class SessionListDialog(QDialog):
    """看这一段时间的计时明细，用来核对「时长和起止时间对不对得上」。"""

    def __init__(self, parent, store, employee_id, date_from, date_to):
        super().__init__(parent)
        self.setWindowTitle("计时明细")
        self.setMinimumSize(720, 460)

        from PyQt6.QtWidgets import (
            QAbstractItemView, QHeaderView, QTableWidget, QTableWidgetItem,
        )
        layout = QVBoxLayout(self)
        hint = muted(
            "「时长」是用单调时钟算出来的真实流逝时间，"
            "「起止」是从系统时间取的。两者对不上就说明中途改过系统时间。"
        )
        hint.setWordWrap(True)
        layout.addWidget(hint)

        rows = store.sessions(employee_id=employee_id,
                              date_from=date_from, date_to=date_to)
        table = QTableWidget(len(rows), 6)
        table.setHorizontalHeaderLabels(
            ["日期", "项目", "开始", "结束", "时长", "核对"]
        )
        table.verticalHeader().setVisible(False)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        table.setShowGrid(False)
        header = table.horizontalHeader()
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.Stretch)

        for index, session in enumerate(rows):
            problems = timer_module.check_session({
                "manual": session["manual"],
                "elapsed": session["elapsed"],
                "started_at": session["started_at"],
                "ended_at": session["ended_at"],
            })
            values = [
                session["work_date"],
                session["project_name"] or "非项目",
                (session["started_at"] or "")[-8:] or "—",
                (session["ended_at"] or "")[-8:] or "—",
                timer_module.format_duration(session["elapsed"]),
                "；".join(problems) if problems else (
                    "补录" if session["manual"] else "正常"
                ),
            ]
            for column, text in enumerate(values):
                item = QTableWidgetItem(str(text))
                if problems:
                    item.setForeground(Qt.GlobalColor.darkRed)
                table.setItem(index, column, item)
        layout.addWidget(table)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.button(QDialogButtonBox.StandardButton.Close).setText("关闭")
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
