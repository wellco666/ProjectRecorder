"""图表：QPainter 手绘，不依赖任何绘图库。

四种图，各解决一个具体问题：

    TrendChart      折线图 —— 指标随时间怎么走
    BarChart        柱状图 —— 谁多谁少（支持分组，用于「计划 vs 实际」）
    TimelineChart   时间轴 —— 每一步计划什么时候做完、现在做到哪了
    LoadChart       条形图 —— 每个人的负荷率，超标的一眼看出

配色策略：**界面是冷灰蓝的，数据是莫兰迪的**。
曲线和柱子用一组明度接近、色相分散的低饱和色，
同时区分多条时不会打架。

所有图共用 _ChartBase 的坐标系、网格、空状态和取色，
避免每个图各写一遍，导致同一套坐标轴长得不一样。
"""
import datetime
import math

from PyQt6.QtCore import QEvent, QPointF, QRectF, QSize, Qt
from PyQt6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPen, QPolygonF
from PyQt6.QtWidgets import QWidget

import metrics
import theme

__all__ = ["TrendChart", "BarChart", "TimelineChart", "LoadChart"]

FONT = "Microsoft YaHei UI"


class _ChartBase(QWidget):
    """公共部分：内边距、坐标轴、网格、空状态、取色。

    继承 ThemedWidget：四张图的颜色都取自 theme.palette()，
    不走全局 QSS，所以切主题时要自己重画一遍，
    否则会出现「界面变深色了、图还是浅色的」。
    """

    PAD_LEFT = 62
    PAD_RIGHT = 16
    PAD_TOP = 24
    PAD_BOTTOM = 44

    def __init__(self, parent=None, minimum_height=200):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self._empty_text = "暂无数据"
        self.setMinimumHeight(minimum_height)

    def changeEvent(self, event):
        # StyleChange（不是 StyleSheetChange）= 这个控件的样式变了，
        # 全局样式表被替换时所有控件都会收到，正好当作
        # 「主题变了，重取一次配色」的信号。
        if event.type() in (QEvent.Type.StyleChange,
                            QEvent.Type.PaletteChange):
            self.update()
        super().changeEvent(event)

    def set_empty(self, text):
        self._empty_text = text
        self.update()

    # ---------- 取色 ----------
    @staticmethod
    def colors():
        return theme.palette()

    @staticmethod
    def series_color(index):
        palette = theme.series_colors()
        return QColor(palette[index % len(palette)])

    # ---------- 坐标 ----------
    def _plot_rect(self, legend_rows=0, pad_left=None):
        left = pad_left if pad_left is not None else self.PAD_LEFT
        top = self.PAD_TOP + legend_rows * 20
        width = max(1.0, self.width() - left - self.PAD_RIGHT)
        height = max(1.0, self.height() - top - self.PAD_BOTTOM)
        return QRectF(left, top, width, height)

    @staticmethod
    def nice_max(raw):
        """把轴上界取整到好读的数，避免出现 3721 这种刻度"""
        if raw <= 0:
            return 1.0
        magnitude = 10 ** (len(str(int(raw))) - 1)
        for factor in (1, 1.5, 2, 2.5, 5, 10):
            candidate = magnitude * factor
            if candidate >= raw:
                return float(candidate)
        return float(magnitude * 10)

    def _draw_grid(self, painter, rect, max_value, ticks=4):
        colors = self.colors()
        grid = QColor(colors["line_soft"])
        axis = QColor(colors["line_input"])
        text = QColor(colors["fg_dim"])

        painter.setFont(QFont(FONT, 8))
        for index in range(ticks + 1):
            y = rect.bottom() - rect.height() * index / ticks
            painter.setPen(QPen(grid, 1))
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
            painter.setPen(text)
            painter.drawText(
                QRectF(0, y - 9, rect.left() - 10, 18),
                int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter),
                f"{max_value * index / ticks:,.0f}",
            )
        painter.setPen(QPen(axis, 1))
        painter.drawLine(QPointF(rect.left(), rect.top()),
                         QPointF(rect.left(), rect.bottom()))
        painter.drawLine(QPointF(rect.left(), rect.bottom()),
                         QPointF(rect.right(), rect.bottom()))

    def _draw_empty(self, painter):
        painter.setPen(QColor(self.colors()["fg_dim"]))
        painter.setFont(QFont(FONT, 9))
        painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self._empty_text)


class TrendChart(_ChartBase):
    """折线图：指标随时间变化"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("TrendChart")
        self._labels = []
        self._series = []   # [{"name": str, "data": [float]}]

    def set_series(self, curve):
        curve = curve or {}
        self._labels = [str(x) for x in (curve.get("labels") or [])]
        self._series = [
            {"name": str(s.get("name", "")),
             "data": [metrics.num(v) for v in (s.get("data") or [])]}
            for s in (curve.get("series") or [])
        ]
        self.update()

    @property
    def has_data(self):
        return bool(self._labels and self._series)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if not self.has_data:
            self._draw_empty(painter)
            painter.end()
            return

        values = [v for s in self._series for v in s["data"]]
        max_value = self.nice_max(max(values) if values else 1.0)
        self._draw_legend(painter)
        rect = self._plot_rect(legend_rows=1)
        self._draw_grid(painter, rect, max_value)

        count = len(self._labels)
        if count == 1:
            centers = [rect.left() + rect.width() / 2]
        else:
            step = rect.width() / (count - 1)
            centers = [rect.left() + step * i for i in range(count)]

        for index, series in enumerate(self._series):
            color = self.series_color(index)
            points = [
                QPointF(centers[i], rect.bottom() - rect.height() * value / max_value)
                for i, value in enumerate(series["data"][:count])
            ]
            if not points:
                continue
            painter.setPen(QPen(color, 2))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            if len(points) > 1:
                painter.drawPolyline(QPolygonF(points))
            painter.setBrush(color)
            painter.setPen(QPen(QColor(self.colors()["bg_chart"]), 1.5))
            for point in points:
                painter.drawEllipse(point, 3.0, 3.0)

        self._draw_x_labels(painter, rect, centers)
        painter.end()

    def _draw_legend(self, painter):
        painter.setFont(QFont(FONT, 8))
        fm = QFontMetrics(painter.font())
        color = QColor(self.colors()["fg_dim"])
        x = self.PAD_LEFT
        for index, series in enumerate(self._series):
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self.series_color(index))
            painter.drawEllipse(QPointF(x + 4, 12), 4.0, 4.0)
            painter.setPen(color)
            painter.drawText(QPointF(x + 12, 16), series["name"])
            x += 12 + fm.horizontalAdvance(series["name"]) + 20

    def _draw_x_labels(self, painter, rect, centers):
        painter.setFont(QFont(FONT, 8))
        painter.setPen(QColor(self.colors()["fg_dim"]))
        count = len(self._labels)
        stride = max(1, (count + 7) // 8)
        fm = QFontMetrics(painter.font())
        for index, label in enumerate(self._labels):
            if index % stride:
                continue
            painter.drawText(
                QRectF(centers[index] - 42, rect.bottom() + 7, 84, 16),
                int(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop),
                fm.elidedText(label, Qt.TextElideMode.ElideRight, 84),
            )


class BarChart(_ChartBase):
    """柱状图。支持两种模式：

    单组（每项一根柱）：谁多谁少
    双组（每项两根柱并排）：计划 vs 实际 —— 一眼看出谁超了、超多少
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("BarChart")
        self._bars = []
        self._group_names = []

    def set_bars(self, bars, group_names=None):
        """bars: [{"label", "values": [v1, v2?], "note"}]"""
        self._bars = []
        for bar in (bars or []):
            values = bar.get("values")
            if values is None:
                values = [metrics.num(bar.get("value"))]
            self._bars.append({
                "label": str(bar.get("label", "")),
                "values": [max(0.0, metrics.num(v)) for v in values],
                "note": str(bar.get("note", "")),
            })
        self._group_names = list(group_names or [])
        self.update()

    @property
    def has_data(self):
        return bool(self._bars)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if not self.has_data:
            self._draw_empty(painter)
            painter.end()
            return

        groups = max(len(bar["values"]) for bar in self._bars)
        max_value = self.nice_max(
            max((max(bar["values"]) if bar["values"] else 0.0) for bar in self._bars)
        )
        if groups > 1:
            self._draw_legend(painter, groups)
        rect = self._plot_rect(legend_rows=1 if groups > 1 else 0)
        self._draw_grid(painter, rect, max_value)

        colors = self.colors()
        count = len(self._bars)
        slot = rect.width() / count
        bar_width = max(3.0, min(slot * (0.55 if groups == 1 else 0.38), 56.0))
        group_width = bar_width * groups + (groups - 1) * 2

        painter.setFont(QFont(FONT, 8))
        fm = QFontMetrics(painter.font())
        stride = max(1, (count + 7) // 8)

        for index, bar in enumerate(self._bars):
            center = rect.left() + slot * index + slot / 2
            start_x = center - group_width / 2
            for group, value in enumerate(bar["values"]):
                height = rect.height() * value / max_value
                x = start_x + group * (bar_width + 2)
                y = rect.bottom() - height
                color = QColor(self.series_color(group if groups > 1 else index))
                # 交替深浅，相邻柱子之间才有分界
                color.setAlpha(230 if (groups > 1 or index % 2 == 0) else 170)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(color)
                painter.drawRoundedRect(
                    QRectF(x, y, bar_width, max(height, 1.0)), 3, 3
                )
                # 柱顶标数值：老板不用去对轴
                if value > 0 and count <= 14:
                    painter.setPen(QColor(colors["fg_soft"]))
                    painter.drawText(
                        QRectF(x - 16, y - 15, bar_width + 32, 13),
                        int(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignBottom),
                        f"{value:,.0f}",
                    )

            if index % stride == 0:
                painter.setPen(QColor(colors["fg_dim"]))
                painter.drawText(
                    QRectF(rect.left() + slot * index - 8, rect.bottom() + 7,
                           slot + 16, 16),
                    int(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop),
                    fm.elidedText(bar["label"], Qt.TextElideMode.ElideRight,
                                  int(slot) + 16),
                )
        painter.end()

    def _draw_legend(self, painter, groups):
        """双组模式要说明哪根是计划、哪根是实际"""
        if not self._group_names:
            return
        painter.setFont(QFont(FONT, 8))
        fm = QFontMetrics(painter.font())
        color = QColor(self.colors()["fg_dim"])
        x = self.PAD_LEFT
        for index in range(min(groups, len(self._group_names))):
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self.series_color(index))
            painter.drawRoundedRect(QRectF(x, 7, 10, 10), 2, 2)
            painter.setPen(color)
            painter.drawText(QPointF(x + 15, 16), self._group_names[index])
            x += 15 + fm.horizontalAdvance(self._group_names[index]) + 18


class TimelineChart(_ChartBase):
    """进度时间轴：每一步计划什么时候做完、现在做到哪了。

    每一行是一个步骤：一条横条表示计划区间，实心部分表示已完成进度，
    中间一条虚线是「今天」。

    为什么值得单独画一张：表格里「已过期」只是三个字，
    而在这张图上，「今天」那条竖线穿过了没做完的横条——**视觉上直接看出来**。
    """

    ROW_HEIGHT = 26
    LABEL_WIDTH = 104

    def __init__(self, parent=None):
        super().__init__(parent, minimum_height=180)
        self.setObjectName("TimelineChart")
        self._steps = []

    def set_steps(self, steps):
        """steps: [{"name", "start", "due", "progress", "status"}]"""
        self._steps = []
        for step in (steps or []):
            start = metrics.parse_date(step.get("start"))
            due = metrics.parse_date(step.get("due"))
            # 两头都没有日期的步骤没法画在时间轴上，直接跳过
            if start is None and due is None:
                continue
            self._steps.append({
                "name": str(step.get("name", "")),
                "start": start,
                "due": due,
                "progress": max(0, min(100, int(metrics.num(step.get("progress"))))),
                "status": str(step.get("status", "")),
            })
        self.update()

    @property
    def has_data(self):
        return bool(self._steps)

    @property
    def dated_count(self):
        """真正画进时间轴的步骤数（有日期的那些）"""
        return len(self._steps)

    def sizeHint(self):
        return QSize(
            0, max(180, self.PAD_TOP + self.PAD_BOTTOM
                   + len(self._steps) * self.ROW_HEIGHT)
        )

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if not self.has_data:
            self._draw_empty(painter)
            painter.end()
            return

        colors = self.colors()
        levels = theme.level_colors()
        today = datetime.date.today()

        # 时间范围：所有步骤的最早开始 ~ 最晚截止，并把今天包进来
        starts = [s["start"] for s in self._steps if s["start"]]
        dues = [s["due"] for s in self._steps if s["due"]]
        first = min(starts) if starts else today
        last = max(dues) if dues else today
        first = min(first, today)
        last = max(last, today)
        span = max(1, (last - first).days)

        left = self.LABEL_WIDTH + 12
        right = self.width() - self.PAD_RIGHT - 36   # 留出右侧进度数字的位置
        width = max(1.0, right - left)
        top = self.PAD_TOP
        rows_height = len(self._steps) * self.ROW_HEIGHT

        def x_of(day):
            """把日期换算成横坐标。day 为 None 时返回 None。

            参数名故意不叫 date —— 那会和 datetime.date 撞车，
            读代码时容易搞不清用的是哪个。
            """
            if day is None:
                return None
            return left + width * ((day - first).days / span)

        # 月份刻度
        painter.setFont(QFont(FONT, 8))
        cursor = first.replace(day=1)
        while cursor <= last:
            x = x_of(cursor)
            if x is not None and left <= x <= right:
                painter.setPen(QPen(QColor(colors["line_soft"]), 1))
                painter.drawLine(QPointF(x, top - 4), QPointF(x, top + rows_height + 4))
                painter.setPen(QColor(colors["fg_dim"]))
                painter.drawText(
                    QRectF(x - 24, top - 20, 48, 14),
                    int(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignBottom),
                    f"{cursor.year % 100}/{cursor.month}",
                )
            # 跳到下个月一号
            cursor = (cursor.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)

        bar_h = 12
        for index, step in enumerate(self._steps):
            y = top + index * self.ROW_HEIGHT + (self.ROW_HEIGHT - bar_h) / 2

            # 步骤名
            painter.setPen(QColor(colors["fg"]))
            painter.setFont(QFont(FONT, 8))
            painter.drawText(
                QRectF(0, y - 4, self.LABEL_WIDTH, bar_h + 8),
                int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter),
                QFontMetrics(painter.font()).elidedText(
                    step["name"], Qt.TextElideMode.ElideRight, self.LABEL_WIDTH
                ),
            )

            start_x = x_of(step["start"])
            end_x = x_of(step["due"])
            # 只填了一头日期的步骤，用今天把另一头补上，才画得出长度
            if start_x is None:
                start_x = x_of(today)
            if end_x is None:
                end_x = x_of(today)
            if end_x < start_x:
                start_x, end_x = end_x, start_x
            # 同一天的步骤也要看得见，给个最小宽度
            if end_x - start_x < 3:
                end_x = start_x + 3

            done = step["status"] == "已完成"
            blocked = step["status"] == "已阻塞"

            # 计划区间：浅色底
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(colors["track"]))
            painter.drawRoundedRect(QRectF(start_x, y, end_x - start_x, bar_h), 3, 3)

            # 进度填充
            if step["progress"] > 0:
                if done:
                    fill = QColor(levels["健康"])
                elif blocked:
                    fill = QColor(levels["严重"])
                else:
                    fill = QColor(colors["accent_dim"])
                fill.setAlpha(210)
                painter.setBrush(fill)
                painter.drawRoundedRect(
                    QRectF(start_x, y,
                           max(2.0, (end_x - start_x) * step["progress"] / 100.0),
                           bar_h),
                    3, 3,
                )

            # 过期未完成：在截止处画一道警示竖线
            due = step["due"]
            if due and due < today and not done:
                over_x = x_of(due)
                if over_x is not None:
                    painter.setPen(QPen(QColor(levels["风险"]), 2))
                    painter.drawLine(QPointF(over_x, y - 3),
                                     QPointF(over_x, y + bar_h + 3))

            painter.setPen(QColor(colors["fg_dim"]))
            painter.drawText(
                QRectF(right + 6, y - 2, 36, bar_h + 4),
                int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter),
                f"{step['progress']}%",
            )

        # 今天：贯穿全图的虚线
        today_x = x_of(today)
        if today_x is not None and left <= today_x <= right:
            painter.setPen(QPen(QColor(colors["accent_dim"]), 1, Qt.PenStyle.DashLine))
            painter.drawLine(QPointF(today_x, top - 4),
                             QPointF(today_x, top + rows_height + 4))
            painter.setPen(QColor(colors["accent_dim"]))
            painter.drawText(
                QRectF(today_x - 24, top + rows_height + 6, 48, 14),
                int(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop),
                "今天",
            )
        painter.end()


class LoadChart(_ChartBase):
    """负荷条形图：每个人的负荷率，超标的那根变红。

    横向摆而不是竖着——人名放在左侧标签里放得下，
    竖柱状图的人名一多就得斜着写或者省略。
    """

    ROW_HEIGHT = 28
    LABEL_WIDTH = 76

    def __init__(self, parent=None):
        super().__init__(parent, minimum_height=140)
        self.setObjectName("LoadChart")
        self._rows = []

    def set_rows(self, rows):
        """rows: [{"name", "hours", "ratio"}]，ratio 是负荷率（1.0 = 满）"""
        self._rows = [
            {
                "name": str(row.get("name", "")),
                "hours": metrics.num(row.get("hours")),
                "ratio": metrics.num(row.get("ratio")),
            }
            for row in (rows or [])
        ]
        self.update()

    @property
    def has_data(self):
        return bool(self._rows)

    def sizeHint(self):
        return QSize(
            0, max(140, self.PAD_TOP + self.PAD_BOTTOM
                   + len(self._rows) * self.ROW_HEIGHT)
        )

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if not self.has_data:
            self._draw_empty(painter)
            painter.end()
            return

        colors = self.colors()
        levels = theme.level_colors()

        # 横轴按最大负荷率定，但至少到 100%，否则「满负荷」的位置看不出来
        top_ratio = max(1.0, max(row["ratio"] for row in self._rows))
        ticks = 4
        axis_max = math.ceil(top_ratio * ticks) / ticks
        if axis_max <= top_ratio:
            axis_max = top_ratio * 1.05

        left = self.LABEL_WIDTH + 12
        right = self.width() - 54
        width = max(1.0, right - left)
        top = self.PAD_TOP
        rows_height = len(self._rows) * self.ROW_HEIGHT
        bar_h = 13

        painter.setFont(QFont(FONT, 8))
        for index in range(ticks + 1):
            ratio = axis_max * index / ticks
            x = left + width * index / ticks
            painter.setPen(QPen(QColor(colors["line_soft"]), 1))
            painter.drawLine(QPointF(x, top - 4), QPointF(x, top + rows_height))
            painter.setPen(QColor(colors["fg_dim"]))
            painter.drawText(
                QRectF(x - 24, top + rows_height + 2, 48, 14),
                int(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop),
                f"{ratio * 100:.0f}%",
            )

        # 100% 基准线：超没超负荷就看它
        base_x = left + width * (1.0 / axis_max)
        if base_x <= right:
            painter.setPen(QPen(QColor(colors["line_input"]), 1, Qt.PenStyle.DashLine))
            painter.drawLine(QPointF(base_x, top - 4), QPointF(base_x, top + rows_height))

        for index, row in enumerate(self._rows):
            y = top + index * self.ROW_HEIGHT + (self.ROW_HEIGHT - bar_h) / 2
            painter.setPen(QColor(colors["fg"]))
            painter.drawText(
                QRectF(0, y - 2, self.LABEL_WIDTH, bar_h + 4),
                int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter),
                QFontMetrics(painter.font()).elidedText(
                    row["name"], Qt.TextElideMode.ElideRight, self.LABEL_WIDTH
                ),
            )

            bar_width = width * min(row["ratio"] / axis_max, 1.0)
            if row["ratio"] > 1.0:
                fill = QColor(levels["风险"])
            elif row["ratio"] >= 0.85:
                fill = QColor(levels["关注"])
            else:
                fill = QColor(colors["accent"])
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(fill)
            painter.drawRoundedRect(QRectF(left, y, max(bar_width, 2.0), bar_h), 3, 3)

            painter.setPen(QColor(levels["风险"] if row["ratio"] > 1.0
                                  else colors["fg_dim"]))
            painter.drawText(
                QRectF(left + bar_width + 6, y - 2, 48, bar_h + 4),
                int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter),
                f"{row['ratio'] * 100:.0f}%",
            )
        painter.end()
