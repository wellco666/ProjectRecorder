"""知识星球：把项目经验变成一张会生长的认知地图。

设计不是「再做一个笔记列表」，而是把一条知识放到四个区域里看：
    · 实际知识：已经验证、能直接拿来用的事实和方法
    · 关联知识：跨项目、跨领域连接后产生的新理解
    · 潜在知识：还没说清，但已经值得追下去的直觉
    · 原始知识：刚被记下的种子，可能只是一句话

中间的星图展示知识之间的引力；右侧冰山把显性知识和隐性知识分开。
标签相同的知识会自动出现关系，用户也可以手动建立更明确的关系。
"""
import datetime
import math
import random

from PyQt6.QtCore import QPointF, QRectF, QSize, Qt, pyqtSignal
from PyQt6.QtGui import (
    QColor, QFont, QFontMetrics, QLinearGradient, QPainter, QPainterPath,
    QPen, QRadialGradient,
)
from PyQt6.QtWidgets import (
    QAbstractItemView, QComboBox, QDialog, QDialogButtonBox, QFormLayout,
    QFrame, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QMessageBox, QPushButton, QScrollArea, QSizePolicy, QSpinBox, QSplitter,
    QTabWidget, QTextEdit, QToolTip, QVBoxLayout, QWidget,
)

import theme
from community_ui import CommunityPage
from db import KNOWLEDGE_KINDS, KNOWLEDGE_STATUS, KNOWLEDGE_ZONES
from widgets import SectionTitle, StatCard, label, muted

__all__ = ["KnowledgePlanetPage", "KnowledgeOrbit", "IcebergWidget",
           "KNOWLEDGE_ZONES"]

ZONE_COLORS = {
    "实际知识": "#d9b86e",
    "关联知识": "#86b7d8",
    "潜在知识": "#b49ad6",
    "原始知识": "#91b78b",
}
REFLECTION_PROMPTS = [
    "这条知识解决了一个什么问题？",
    "它和我已有的哪条经验冲突？",
    "如果把它教给新人，第一步会说什么？",
    "它还能迁移到哪个项目或场景？",
    "下一步用什么证据验证它？",
]


def parse_tags(text):
    """标签支持中文逗号、分号、顿号和斜杠，降低录入负担。"""
    raw = str(text or "").replace("，", ",").replace("；", ",")
    raw = raw.replace(";", ",").replace("、", ",").replace("/", ",")
    tags = []
    for part in raw.replace("\n", ",").split(","):
        tag = part.strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _display(value, fallback="—"):
    text = str(value or "").strip()
    return text if text else fallback


def _status_color(status):
    return {"种子": "#8aa77d", "探索中": "#c5a35d",
            "已沉淀": "#7897b2"}.get(status, "#8b939f")


def _kind_color(kind):
    return "#d2b56e" if kind == "隐性知识" else "#86a9c9"


def _pill_style(color):
    return (f"background-color: {color}; color: #ffffff; border-radius: 9px;"
            " padding: 3px 10px; font-size: 11.5px; font-weight: 600;")


def _localize_dialog_buttons(buttons):
    save = buttons.button(QDialogButtonBox.StandardButton.Save)
    cancel = buttons.button(QDialogButtonBox.StandardButton.Cancel)
    if save is not None:
        save.setText("保存")
    if cancel is not None:
        cancel.setText("取消")


class KnowledgeOrbit(QWidget):
    """知识引力图：四种知识在不同轨道上，共同标签/手动关系画成连线。"""

    selected = pyqtSignal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("KnowledgeOrbit")
        self.setMinimumSize(420, 340)
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Policy.Expanding,
                           QSizePolicy.Policy.Expanding)
        self._items = []
        self._links = []
        self._selected_id = None
        self._hover_id = None
        self._node_geometry = {}
        self._empty_title = "记录第一颗知识星"
        self._empty_subtitle = "想法会先成为种子，再慢慢长成可复用的方法"
        self._stars = []
        rng = random.Random(20261031)
        for _ in range(118):
            self._stars.append((rng.random(), rng.random(),
                                rng.uniform(0.6, 2.2), rng.randint(32, 135)))

    def sizeHint(self):
        return QSize(620, 500)

    def set_data(self, items, links=None):
        self._items = [dict(row) for row in items]
        self._links = list(links or [])
        if self._selected_id not in {item["id"] for item in self._items}:
            self._selected_id = None
        self.update()

    def set_selected(self, knowledge_id):
        self._selected_id = knowledge_id
        self.update()

    def set_empty_hint(self, title, subtitle):
        self._empty_title = title
        self._empty_subtitle = subtitle
        self.update()

    def _layout_nodes(self):
        self._node_geometry = {}
        width = max(1, self.width())
        height = max(1, self.height())
        center = QPointF(width * 0.5, height * 0.49)
        max_radius = min(width * 0.41, height * 0.39)
        radii = {"实际知识": 0.30, "关联知识": 0.49,
                 "潜在知识": 0.68, "原始知识": 0.86}
        offsets = {"实际知识": -math.pi / 2,
                   "关联知识": -math.pi / 2 + 0.42,
                   "潜在知识": -math.pi / 2 + 0.88,
                   "原始知识": -math.pi / 2 + 1.30}
        for zone in KNOWLEDGE_ZONES:
            zone_items = [item for item in self._items
                          if item.get("zone") == zone]
            n = len(zone_items)
            for index, item in enumerate(zone_items):
                angle = offsets[zone] + 2 * math.pi * index / max(1, n)
                radius = max_radius * radii[zone]
                point = QPointF(
                    center.x() + math.cos(angle) * radius,
                    center.y() + math.sin(angle) * radius * 0.90,
                )
                importance = max(1, min(5, int(item.get("importance") or 3)))
                self._node_geometry[item["id"]] = {
                    "point": point,
                    "radius": 4.5 + importance * 1.25,
                    "item": item,
                }
        return center, max_radius

    def _node_at(self, point):
        nearest = None
        nearest_distance = None
        for knowledge_id, node in self._node_geometry.items():
            distance = math.hypot(point.x() - node["point"].x(),
                                  point.y() - node["point"].y())
            if distance <= node["radius"] + 8:
                if nearest_distance is None or distance < nearest_distance:
                    nearest = knowledge_id
                    nearest_distance = distance
        return nearest

    def mouseMoveEvent(self, event):
        knowledge_id = self._node_at(event.position())
        if knowledge_id != self._hover_id:
            self._hover_id = knowledge_id
            self.update()
        if knowledge_id is None:
            QToolTip.hideText()
            self.unsetCursor()
        else:
            item = next((row for row in self._items
                         if row["id"] == knowledge_id), None)
            if item is not None:
                text = (f"《{item['title']}》\n{item['zone']} · "
                        f"{item['kind']} · {item['status']}")
                QToolTip.showText(event.globalPosition().toPoint(), text, self)
            self.setCursor(Qt.CursorShape.PointingHandCursor)
        super().mouseMoveEvent(event)

    def leaveEvent(self, event):
        self._hover_id = None
        QToolTip.hideText()
        self.unsetCursor()
        self.update()
        super().leaveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            knowledge_id = self._node_at(event.position())
            if knowledge_id is not None:
                self.selected.emit(knowledge_id)
                return
        super().mousePressEvent(event)


    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)

        width = self.width()
        height = self.height()
        background = QLinearGradient(0, 0, width, height)
        background.setColorAt(0.0, QColor("#0d1624"))
        background.setColorAt(0.55, QColor("#16233a"))
        background.setColorAt(1.0, QColor("#101928"))
        painter.fillRect(self.rect(), background)
        painter.setPen(Qt.PenStyle.NoPen)

        for x, y, radius, alpha in self._stars:
            painter.setBrush(QColor(224, 232, 249, alpha))
            painter.drawEllipse(QPointF(x * width, y * height), radius, radius)

        center, max_radius = self._layout_nodes()

        for fraction, dash in ((0.30, False), (0.49, True),
                               (0.68, True), (0.86, True)):
            pen = QPen(QColor(132, 159, 194, 92), 1.1)
            if dash:
                pen.setStyle(Qt.PenStyle.DashLine)
            painter.setPen(pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(center, max_radius * fraction,
                                max_radius * fraction * 0.90)

        # 先画引力线，再画节点，避免线盖住星体
        for link in self._links:
            from_node = self._node_geometry.get(link.get("from_id"))
            to_node = self._node_geometry.get(link.get("to_id"))
            if from_node is None or to_node is None:
                continue
            p1, p2 = from_node["point"], to_node["point"]
            path = QPainterPath(p1)
            midpoint = QPointF((p1.x() + p2.x()) / 2,
                               (p1.y() + p2.y()) / 2)
            dx, dy = p2.x() - p1.x(), p2.y() - p1.y()
            length = max(1.0, math.hypot(dx, dy))
            bend = QPointF(midpoint.x() - dy / length * 16,
                           midpoint.y() + dx / length * 16)
            path.quadTo(bend, p2)
            relation = str(link.get("relation") or "")
            color = QColor(141, 176, 216, 115)
            if relation not in ("同频", ""):
                color = QColor(196, 171, 119, 145)
            painter.setPen(QPen(color, 1.15))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawPath(path)

        # 星球本体 + 光晕
        planet_radius = max(24.0, max_radius * 0.22)
        glow = QRadialGradient(center, planet_radius * 1.75, center)
        glow.setColorAt(0.0, QColor(248, 241, 213, 170))
        glow.setColorAt(0.42, QColor(196, 190, 171, 82))
        glow.setColorAt(1.0, QColor(95, 122, 160, 0))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(glow)
        painter.drawEllipse(center, planet_radius * 1.75,
                            planet_radius * 1.75)

        planet = QRadialGradient(
            QPointF(center.x() - planet_radius * 0.30,
                    center.y() - planet_radius * 0.34),
            planet_radius * 1.25,
        )
        planet.setColorAt(0.0, QColor("#fff9e8"))
        planet.setColorAt(0.34, QColor("#e8dfc8"))
        planet.setColorAt(0.72, QColor("#aab7c2"))
        planet.setColorAt(1.0, QColor("#53677f"))
        painter.setBrush(planet)
        painter.setPen(QPen(QColor(255, 249, 228, 185), 1.2))
        painter.drawEllipse(center, planet_radius, planet_radius)

        painter.setPen(QPen(QColor(93, 108, 124, 52), 0.8))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        for scale in (0.35, 0.55, 0.75):
            painter.drawEllipse(center, planet_radius * scale,
                                planet_radius * scale * 0.42)

        zone_anchor = {"实际知识": (0.16, 0.20), "关联知识": (0.73, 0.19),
                       "潜在知识": (0.13, 0.72), "原始知识": (0.72, 0.72)}
        zone_font = QFont("Microsoft YaHei UI", 9)
        zone_font.setBold(True)
        painter.setFont(zone_font)
        for zone in KNOWLEDGE_ZONES:
            zx, zy = zone_anchor[zone]
            dot = QPointF(width * zx, height * zy)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(ZONE_COLORS[zone]))
            painter.drawEllipse(dot, 3.5, 3.5)
            painter.setPen(QColor(210, 220, 236, 170))
            painter.drawText(QPointF(dot.x() + 9, dot.y() + 4), zone)


        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        for knowledge_id, node in self._node_geometry.items():
            item = node["item"]
            point = node["point"]
            radius = node["radius"]
            color = QColor(ZONE_COLORS.get(item.get("zone"),
                                           ZONE_COLORS["实际知识"]))
            if knowledge_id == self._hover_id:
                color = color.lighter(118)
            glow_color = QColor(color)
            glow_color.setAlpha(45)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(glow_color)
            painter.drawEllipse(point, radius * 2.4, radius * 2.4)
            painter.setBrush(color)
            painter.drawEllipse(point, radius, radius)
            painter.setPen(QPen(QColor(255, 255, 255, 185), 0.9))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(point, radius, radius)
            if knowledge_id == self._selected_id:
                painter.setPen(QPen(QColor(255, 248, 222), 2.0))
                painter.drawEllipse(point, radius + 5, radius + 5)

            importance = int(item.get("importance") or 3)
            if (importance >= 5 or knowledge_id in
                    (self._selected_id, self._hover_id)):
                font = QFont("Microsoft YaHei UI", 9)
                painter.setFont(font)
                metrics = QFontMetrics(font)
                text = metrics.elidedText(str(item.get("title") or ""),
                                          Qt.TextElideMode.ElideRight, 120)
                text_width = metrics.horizontalAdvance(text)
                text_rect = QRectF(point.x() - text_width / 2 - 6,
                                   point.y() + radius + 7,
                                   text_width + 12, 20)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QColor(9, 16, 28, 185))
                painter.drawRoundedRect(text_rect, 5, 5)
                painter.setPen(QColor(234, 239, 248))
                painter.drawText(text_rect, Qt.AlignmentFlag.AlignCenter, text)

        painter.setPen(QPen(QColor(255, 255, 255, 34), 1))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRoundedRect(self.rect().adjusted(1, 1, -2, -2), 10, 10)

        if not self._items:
            painter.setPen(QColor(211, 221, 237, 205))
            empty_font = QFont("Microsoft YaHei UI", 14)
            empty_font.setBold(True)
            painter.setFont(empty_font)
            painter.drawText(self.rect().adjusted(0, -24, 0, -24),
                             Qt.AlignmentFlag.AlignCenter, self._empty_title)
            painter.setPen(QColor(154, 171, 197, 170))
            painter.setFont(QFont("Microsoft YaHei UI", 9))
            painter.drawText(self.rect().adjusted(0, 18, 0, 18),
                             Qt.AlignmentFlag.AlignCenter,
                             self._empty_subtitle)
        painter.end()


class IcebergWidget(QWidget):
    """显性 / 隐性知识冰山。数字来自真实数据，不是装饰画。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(190)
        self.setSizePolicy(QSizePolicy.Policy.Expanding,
                           QSizePolicy.Policy.Fixed)
        self._explicit = 0
        self._tacit = 0

    def set_counts(self, explicit, tacit):
        self._explicit = max(0, int(explicit or 0))
        self._tacit = max(0, int(tacit or 0))
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        colors = theme.palette()
        width, height = self.width(), self.height()
        painter.fillRect(self.rect(), QColor(colors["bg_chart"]))
        waterline = height * 0.50

        sky = QLinearGradient(0, 0, 0, waterline)
        sky.setColorAt(0, QColor(colors["bg_read"]))
        sky.setColorAt(1, QColor(colors["accent_wash"]))
        painter.fillRect(QRectF(0, 0, width, waterline), sky)
        water = QLinearGradient(0, waterline, 0, height)
        water.setColorAt(0, QColor(colors["accent_wash"]))
        water.setColorAt(1, QColor(colors["bg_read"]))
        painter.fillRect(QRectF(0, waterline, width, height - waterline), water)

        painter.setPen(QPen(QColor(colors["accent_edge"]), 1,
                            Qt.PenStyle.DashLine))
        painter.drawLine(0, int(waterline), width, int(waterline))

        painter.setPen(QPen(QColor(colors["fg_soft"]), 1.1))
        painter.setBrush(QColor(243, 246, 250, 225))
        above = QPainterPath()
        above.moveTo(width * 0.30, waterline)
        above.lineTo(width * 0.42, height * 0.12)
        above.lineTo(width * 0.50, height * 0.28)
        above.lineTo(width * 0.57, height * 0.17)
        above.lineTo(width * 0.70, waterline)
        above.closeSubpath()
        painter.drawPath(above)

        painter.setBrush(QColor(143, 169, 194, 155))
        below = QPainterPath()
        below.moveTo(width * 0.29, waterline)
        below.lineTo(width * 0.38, height * 0.77)
        below.lineTo(width * 0.47, height * 0.94)
        below.lineTo(width * 0.55, height * 0.80)
        below.lineTo(width * 0.67, height * 0.95)
        below.lineTo(width * 0.72, waterline)
        below.closeSubpath()
        painter.drawPath(below)

        painter.setPen(QColor(colors["fg_strong"]))
        font = QFont("Microsoft YaHei UI", 9)
        font.setBold(True)
        painter.setFont(font)
        painter.drawText(QRectF(8, 8, width - 16, 24),
                         Qt.AlignmentFlag.AlignLeft, f"显性知识  {self._explicit}")
        painter.drawText(QRectF(8, waterline + 10, width - 16, 24),
                         Qt.AlignmentFlag.AlignLeft, f"隐性知识  {self._tacit}")
        painter.setFont(QFont("Microsoft YaHei UI", 8))
        painter.setPen(QColor(colors["fg_dim"]))
        painter.drawText(QRectF(8, waterline - 22, 92, 18),
                         Qt.AlignmentFlag.AlignLeft, "已知领域")
        painter.drawText(QRectF(width - 92, waterline - 22, 84, 18),
                         Qt.AlignmentFlag.AlignRight, "未知领域")
        painter.end()


class KnowledgeDialog(QDialog):
    """知识录入/编辑窗口。"""

    def __init__(self, parent, store, item=None):
        super().__init__(parent)
        self.store = store
        self.item = item
        self.data = None
        self.setWindowTitle("编辑知识" if item else "记录一条知识")
        self.setMinimumWidth(660)
        self.setMinimumHeight(620)

        root = QVBoxLayout(self)
        root.setContentsMargins(24, 22, 24, 20)
        root.setSpacing(12)
        root.addWidget(label("编辑知识星体" if item else "捕获一颗新知识星体",
                             "DialogTitle"))
        hint = muted("先记下来，再决定它属于哪个区域。隐性知识和原始种子不需要一开始就完整。")
        hint.setWordWrap(True)
        root.addWidget(hint)

        form = QFormLayout()
        form.setSpacing(10)
        form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        self.title_edit = QLineEdit()
        self.title_edit.setPlaceholderText("一句话说清这条知识")
        form.addRow("标题 *", self.title_edit)

        self.zone_box = QComboBox()
        self.zone_box.addItems(KNOWLEDGE_ZONES)
        self.kind_box = QComboBox()
        self.kind_box.addItems(KNOWLEDGE_KINDS)
        self.status_box = QComboBox()
        self.status_box.addItems(KNOWLEDGE_STATUS)
        row = QHBoxLayout()
        row.setSpacing(8)
        row.addWidget(self.zone_box, 1)
        row.addWidget(self.kind_box, 1)
        row.addWidget(self.status_box, 1)
        form.addRow("认知区域", row)

        self.project_box = QComboBox()
        self.project_box.addItem("不关联项目", None)
        for project in store.projects():
            self.project_box.addItem(project["name"], project["id"])
        form.addRow("关联项目", self.project_box)

        self.tags_edit = QLineEdit()
        self.tags_edit.setPlaceholderText("用逗号分隔，如：用户研究, 复盘, 定价")
        form.addRow("标签", self.tags_edit)
        self.source_edit = QLineEdit()
        self.source_edit.setPlaceholderText("来自哪里？会议、客户反馈、书籍、一次失败…")
        form.addRow("来源", self.source_edit)

        self.importance_box = QSpinBox()
        self.importance_box.setRange(1, 5)
        self.importance_box.setValue(3)
        self.importance_box.setSuffix(" 星")
        form.addRow("重要度", self.importance_box)

        self.review_edit = QLineEdit()
        self.review_edit.setPlaceholderText("YYYY-MM-DD，可留空")
        form.addRow("下次回看", self.review_edit)

        self.content_edit = QTextEdit()
        self.content_edit.setPlaceholderText(
            "展开了什么？适用条件、证据、反例、下一步验证方式…"
        )
        self.content_edit.setMinimumHeight(170)
        self.content_edit.setTabChangesFocus(True)
        form.addRow("认知内容", self.content_edit)
        root.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save
            | QDialogButtonBox.StandardButton.Cancel
        )
        _localize_dialog_buttons(buttons)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)
        if item is not None:
            self._load(item)

    def _load(self, item):
        self.title_edit.setText(item["title"] or "")
        self.zone_box.setCurrentText(item["zone"] or "实际知识")
        self.kind_box.setCurrentText(item["kind"] or "显性知识")
        self.status_box.setCurrentText(item["status"] or "已沉淀")
        index = self.project_box.findData(item["project_id"])
        self.project_box.setCurrentIndex(index if index >= 0 else 0)
        self.tags_edit.setText(item["tags"] or "")
        self.source_edit.setText(item["source"] or "")
        self.importance_box.setValue(int(item["importance"] or 3))
        self.review_edit.setText(item["next_review"] or "")
        self.content_edit.setPlainText(item["content"] or "")

    def _save(self):
        title = self.title_edit.text().strip()
        if not title:
            QMessageBox.warning(self, "还差一个标题", "先给这颗知识星体起个名字。")
            self.title_edit.setFocus()
            return
        review = self.review_edit.text().strip()
        if review:
            try:
                datetime.date.fromisoformat(review)
            except ValueError:
                QMessageBox.warning(
                    self, "日期格式不对",
                    "下次回看请写成 YYYY-MM-DD，例如 2026-11-15。",
                )
                self.review_edit.setFocus()
                return
        self.data = {
            "title": title,
            "zone": self.zone_box.currentText(),
            "kind": self.kind_box.currentText(),
            "status": self.status_box.currentText(),
            "project_id": self.project_box.currentData(),
            "tags": self.tags_edit.text().strip(),
            "source": self.source_edit.text().strip(),
            "importance": self.importance_box.value(),
            "next_review": review,
            "content": self.content_edit.toPlainText().strip(),
        }
        self.accept()


class KnowledgeLinkDialog(QDialog):
    def __init__(self, parent, items, source_id):
        super().__init__(parent)
        self.values = None
        self.source_id = source_id
        self.setWindowTitle("建立知识关联")
        self.setMinimumWidth(520)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 18)
        layout.setSpacing(12)
        layout.addWidget(label("让两颗知识互相吸引", "DialogTitle"))
        hint = muted("关系越具体，以后回看时越容易知道为什么把它们放在一起。")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        form = QFormLayout()
        form.setSpacing(10)
        self.target_box = QComboBox()
        for item in items:
            if item["id"] != source_id:
                self.target_box.addItem(item["title"], item["id"])
        form.addRow("连接到", self.target_box)
        self.relation_box = QComboBox()
        self.relation_box.setEditable(True)
        self.relation_box.addItems(["启发", "支撑", "反例", "同源", "跨域连接"])
        form.addRow("关系", self.relation_box)
        self.note_edit = QLineEdit()
        self.note_edit.setPlaceholderText("为什么有关联？可留空")
        form.addRow("说明", self.note_edit)
        layout.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save
            | QDialogButtonBox.StandardButton.Cancel
        )
        _localize_dialog_buttons(buttons)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        if self.target_box.count() == 0:
            self.target_box.addItem("还没有其他知识可连接", None)

    def _save(self):
        target_id = self.target_box.currentData()
        if target_id is None:
            QMessageBox.information(
                self, "还少一颗星", "至少再记录一条知识，才能建立关联。"
            )
            return
        self.values = (self.source_id, target_id,
                       self.relation_box.currentText().strip() or "关联",
                       self.note_edit.text().strip())
        self.accept()


class ReflectionDialog(QDialog):
    def __init__(self, parent, item):
        super().__init__(parent)
        self.values = None
        self.setWindowTitle("反思这颗知识")
        self.setMinimumWidth(560)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 18)
        layout.setSpacing(12)
        layout.addWidget(label(f"反思：{item['title']}", "DialogTitle"))
        hint = muted("反思不是写总结，是让知识从「知道」变成「能迁移、能验证」。")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        form = QFormLayout()
        form.setSpacing(10)
        self.prompt_box = QComboBox()
        self.prompt_box.setEditable(True)
        self.prompt_box.addItems(REFLECTION_PROMPTS)
        form.addRow("问题", self.prompt_box)
        self.content_edit = QTextEdit()
        self.content_edit.setPlaceholderText("写下此刻想到的答案，不必写得漂亮。")
        self.content_edit.setMinimumHeight(180)
        form.addRow("思考", self.content_edit)
        layout.addLayout(form)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save
            | QDialogButtonBox.StandardButton.Cancel
        )
        _localize_dialog_buttons(buttons)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _save(self):
        content = self.content_edit.toPlainText().strip()
        if not content:
            QMessageBox.information(self, "还差一点", "写一句也行，空着不算一次反思。")
            self.content_edit.setFocus()
            return
        self.values = (self.prompt_box.currentText().strip(), content)
        self.accept()


class KnowledgeDetailPanel(QFrame):
    edit_requested = pyqtSignal()
    delete_requested = pyqtSignal()
    link_requested = pyqtSignal()
    reflect_requested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("KnowledgeDetailPanel")
        self.setMinimumWidth(290)
        root = QVBoxLayout(self)
        root.setContentsMargins(18, 16, 18, 16)
        root.setSpacing(9)

        self.eyebrow = label("知识详情", "KnowledgeEyebrow")
        root.addWidget(self.eyebrow)
        self.title_label = label("选择一颗知识星体", "KnowledgeDetailTitle")
        self.title_label.setWordWrap(True)
        root.addWidget(self.title_label)

        badges = QHBoxLayout()
        badges.setSpacing(6)
        self.zone_badge = QLabel()
        self.kind_badge = QLabel()
        self.status_badge = QLabel()
        for badge in (self.zone_badge, self.kind_badge, self.status_badge):
            badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
            badge.setSizePolicy(QSizePolicy.Policy.Maximum,
                                QSizePolicy.Policy.Fixed)
            badges.addWidget(badge)
        badges.addStretch()
        root.addLayout(badges)

        self.project_label = self._make_meta()
        self.source_label = self._make_meta()
        self.review_label = self._make_meta()
        root.addWidget(self.project_label)
        root.addWidget(self.source_label)
        root.addWidget(self.review_label)

        root.addWidget(SectionTitle("认知内容"))
        self.content_label = QLabel()
        self.content_label.setObjectName("KnowledgeContent")
        self.content_label.setWordWrap(True)
        self.content_label.setTextFormat(Qt.TextFormat.PlainText)
        self.content_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        root.addWidget(self.content_label)

        root.addWidget(SectionTitle("标签与引力"))
        self.tags_label = QLabel()
        self.tags_label.setObjectName("KnowledgeTags")
        self.tags_label.setWordWrap(True)
        root.addWidget(self.tags_label)
        self.related_label = QLabel()
        self.related_label.setObjectName("KnowledgeRelated")
        self.related_label.setWordWrap(True)
        self.related_label.setTextFormat(Qt.TextFormat.PlainText)
        root.addWidget(self.related_label)

        self.reflection_label = QLabel()
        self.reflection_label.setObjectName("KnowledgeReflection")
        self.reflection_label.setWordWrap(True)
        self.reflection_label.setTextFormat(Qt.TextFormat.PlainText)
        root.addWidget(self.reflection_label)

        root.addWidget(SectionTitle("冰山模型"))
        self.iceberg = IcebergWidget()
        root.addWidget(self.iceberg)

        button_row = QHBoxLayout()
        button_row.setSpacing(7)
        self.reflect_button = QPushButton("反思")
        self.reflect_button.setObjectName("PrimaryButton")
        self.reflect_button.clicked.connect(self.reflect_requested)
        self.link_button = QPushButton("建立关联")
        self.link_button.setObjectName("GhostButton")
        self.link_button.clicked.connect(self.link_requested)
        button_row.addWidget(self.reflect_button)
        button_row.addWidget(self.link_button)
        root.addLayout(button_row)

        second_row = QHBoxLayout()
        second_row.setSpacing(7)
        self.edit_button = QPushButton("编辑")
        self.edit_button.setObjectName("GhostButton")
        self.edit_button.clicked.connect(self.edit_requested)
        self.delete_button = QPushButton("删除")
        self.delete_button.setObjectName("DangerButton")
        self.delete_button.clicked.connect(self.delete_requested)
        second_row.addWidget(self.edit_button)
        second_row.addWidget(self.delete_button)
        root.addLayout(second_row)
        root.addStretch()
        self.clear()

    @staticmethod
    def _make_meta():
        value = QLabel()
        value.setObjectName("KnowledgeMetaLine")
        value.setWordWrap(True)
        value.setTextFormat(Qt.TextFormat.PlainText)
        return value

    def clear(self):
        self.title_label.setText("选择一颗知识星体")
        self.zone_badge.hide()
        self.kind_badge.hide()
        self.status_badge.hide()
        self.project_label.setText("从左侧列表或中间星图选择一条知识。")
        self.source_label.setText("")
        self.review_label.setText("")
        self.content_label.setText(
            "每一条被捕获的知识，都会成为下一次判断的引力。\n"
            "先记下来，再通过标签关联和反思慢慢让它长出结构。"
        )
        self.tags_label.setText("还没有标签")
        self.related_label.setText("还没有引力关系")
        self.reflection_label.setText("还没有反思记录")
        for button in (self.reflect_button, self.link_button,
                       self.edit_button, self.delete_button):
            button.setEnabled(False)

    def show_item(self, item, related, reflections, stats):
        self.title_label.setText(item["title"])
        self.zone_badge.setText(item["zone"] or "实际知识")
        self.zone_badge.setStyleSheet(_pill_style(
            ZONE_COLORS.get(item["zone"], "#7c93ad")))
        self.kind_badge.setText(item["kind"] or "显性知识")
        self.kind_badge.setStyleSheet(_pill_style(_kind_color(item["kind"])))
        self.status_badge.setText(item["status"] or "已沉淀")
        self.status_badge.setStyleSheet(_pill_style(_status_color(item["status"])))
        for badge in (self.zone_badge, self.kind_badge, self.status_badge):
            badge.show()

        self.project_label.setText(f"关联项目：{_display(item['project_name'])}")
        self.source_label.setText(f"来源：{_display(item['source'])}")
        self.review_label.setText(f"下次回看：{_display(item['next_review'])}")
        self.content_label.setText(
            item["content"] or "（还没有展开内容。可以先用一句判断把它记下来。）"
        )
        tags = parse_tags(item["tags"])
        self.tags_label.setText(
            "  ".join(f"#{tag}" for tag in tags) if tags else "还没有标签"
        )
        if related:
            lines = [f"·《{relation['title']}》  {relation['relation']}"
                     for relation in related[:7]]
            self.related_label.setText("\n".join(lines))
        else:
            self.related_label.setText(
                "还没有引力关系。给知识加共同标签，或手动建立一条关联。"
            )

        reflection_count = len(reflections)
        if reflection_count:
            latest = reflections[0]
            latest_text = f"{latest['prompt'] or ''}\n{latest['content'] or ''}".strip()
            if len(latest_text) > 150:
                latest_text = latest_text[:150] + "…"
            self.reflection_label.setText(
                f"已反思 {reflection_count} 次。最近一次：\n{latest_text}"
            )
        else:
            self.reflection_label.setText(
                "还没有反思记录。问自己一个问题，知识才会开始反射。"
            )
        self.iceberg.set_counts(stats.get("explicit", 0), stats.get("tacit", 0))
        for button in (self.reflect_button, self.link_button,
                       self.edit_button, self.delete_button):
            button.setEnabled(True)


class KnowledgePlanetPage(QWidget):
    """知识星球主页面。左列表、中星图、右详情，三处指向同一条知识。"""

    def __init__(self, window):
        super().__init__()
        self.window = window
        self.store = window.store
        self.current_id = None
        self._all_items = []
        self._explicit_links = []
        self._combined_links = []
        self._build()

    def _build(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(18, 12, 18, 12)
        outer.setSpacing(0)

        self.sub_tabs = QTabWidget()
        self.sub_tabs.setObjectName("InnerTabs")
        self.community_page = CommunityPage(self.window)
        self.sub_tabs.addTab(self.community_page, "星球广场")

        library = QWidget()
        root = QVBoxLayout(library)
        root.setContentsMargins(10, 10, 10, 8)
        root.setSpacing(12)

        hero = QHBoxLayout()
        hero.setSpacing(10)
        title_block = QVBoxLayout()
        title_block.setSpacing(1)
        title_block.addWidget(label("知识星球", "KnowledgeTitle"))
        title_block.addWidget(label(
            "把项目里的经验、直觉和失败，连成一张会生长的认知网络",
            "KnowledgeSubtitle",
        ))
        hero.addLayout(title_block)
        hero.addStretch()
        self.link_button = QPushButton("建立关联")
        self.link_button.setObjectName("GhostButton")
        self.link_button.clicked.connect(self._open_link)
        hero.addWidget(self.link_button)
        self.add_button = QPushButton("记录知识")
        self.add_button.setObjectName("PrimaryButton")
        self.add_button.clicked.connect(self.open_add)
        hero.addWidget(self.add_button)
        root.addLayout(hero)

        cards = QHBoxLayout()
        cards.setSpacing(10)
        self.card_total = StatCard("知识星体", "0", "颗", "尚无记录")
        self.card_links = StatCard("引力连接", "0", "条", "标签关联 + 手动连线")
        self.card_reflections = StatCard("反思次数", "0", "次", "让知识发生反射")
        self.card_pending = StatCard("待沉淀", "0", "颗", "种子 + 探索中")
        for card in (self.card_total, self.card_links,
                     self.card_reflections, self.card_pending):
            card.setSizePolicy(QSizePolicy.Policy.Expanding,
                               QSizePolicy.Policy.Fixed)
            cards.addWidget(card)
        root.addLayout(cards)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(7)

        left = QFrame()
        left.setObjectName("KnowledgeSide")
        left.setMinimumWidth(230)
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(14, 14, 14, 14)
        left_layout.setSpacing(9)
        head = QHBoxLayout()
        head.addWidget(SectionTitle("知识星体"))
        head.addStretch()
        self.count_label = label("0", "KnowledgeCount")
        head.addWidget(self.count_label)
        left_layout.addLayout(head)

        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("搜索标题 / 内容 / 标签 / 来源")
        self.search_edit.textChanged.connect(self.refresh)
        left_layout.addWidget(self.search_edit)

        self.zone_filter = QComboBox()
        self.zone_filter.addItem("全部区域", "")
        for zone in KNOWLEDGE_ZONES:
            self.zone_filter.addItem(zone, zone)
        self.zone_filter.currentIndexChanged.connect(self.refresh)
        left_layout.addWidget(self.zone_filter)

        self.list_widget = QListWidget()
        self.list_widget.setObjectName("KnowledgeList")
        self.list_widget.setSpacing(3)
        self.list_widget.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection
        )
        self.list_widget.currentItemChanged.connect(self._on_current_changed)
        left_layout.addWidget(self.list_widget, 1)
        splitter.addWidget(left)

        center = QFrame()
        center.setObjectName("KnowledgeMapFrame")
        center_layout = QVBoxLayout(center)
        center_layout.setContentsMargins(0, 0, 0, 0)
        center_layout.setSpacing(0)
        self.orbit = KnowledgeOrbit()
        self.orbit.selected.connect(self._select_id)
        center_layout.addWidget(self.orbit, 1)
        splitter.addWidget(center)

        scroll = QScrollArea()
        scroll.setObjectName("KnowledgeDetailScroll")
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.detail = KnowledgeDetailPanel()
        self.detail.edit_requested.connect(self._open_edit)
        self.detail.delete_requested.connect(self._open_delete)
        self.detail.link_requested.connect(self._open_link)
        self.detail.reflect_requested.connect(self._open_reflect)
        scroll.setWidget(self.detail)
        scroll.setMinimumWidth(310)
        splitter.addWidget(scroll)

        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 0)
        splitter.setSizes([260, 650, 330])
        root.addWidget(splitter, 1)
        self.sub_tabs.addTab(library, "我的知识库")
        outer.addWidget(self.sub_tabs, 1)

    def refresh(self):
        if hasattr(self, "community_page"):
            self.community_page.on_activated()
        keyword = self.search_edit.text().strip()
        zone = self.zone_filter.currentData()
        visible_items = self.store.knowledge_items(zone=zone, keyword=keyword)
        self._all_items = self.store.knowledge_items()
        self._explicit_links = self.store.knowledge_links()
        self._combined_links = self._combine_links(
            self._all_items, self._explicit_links
        )
        stats = self.store.knowledge_stats()
        self._update_cards(stats)
        self._fill_list(visible_items)
        if self._all_items and not visible_items:
            self.orbit.set_empty_hint(
                "没有找到匹配的知识", "换个关键词，或把区域筛选切回全部"
            )
        else:
            self.orbit.set_empty_hint(
                "记录第一颗知识星",
                "想法会先成为种子，再慢慢长成可复用的方法",
            )
        self.orbit.set_data(visible_items, self._combined_links)

        visible_ids = {item["id"] for item in visible_items}
        if self.current_id not in visible_ids:
            self.current_id = visible_items[0]["id"] if visible_items else None
        if self.current_id is None:
            self.orbit.set_selected(None)
            self.detail.clear()
            self.detail.iceberg.set_counts(stats["explicit"], stats["tacit"])
        else:
            self._select_id(self.current_id, from_refresh=True)

    def _update_cards(self, stats):
        pending = int(stats.get("seed", 0)) + int(stats.get("exploring", 0))
        self.card_total.update_values(
            stats["total"], "颗",
            f"显性 {stats['explicit']} · 隐性 {stats['tacit']}",
        )
        self.card_links.update_values(
            len(self._combined_links), "条",
            f"手动 {len(self._explicit_links)} · 自动 "
            f"{max(0, len(self._combined_links) - len(self._explicit_links))}",
        )
        self.card_reflections.update_values(
            stats["reflections"], "次", "把经验变成可迁移的方法"
        )
        self.card_pending.update_values(
            pending, "颗",
            f"种子 {stats['seed']} · 探索中 {stats['exploring']}",
        )
        self.count_label.setText(str(stats["total"]))
        self.link_button.setEnabled(bool(self._all_items))

    def _fill_list(self, items):
        self.list_widget.blockSignals(True)
        self.list_widget.clear()
        for item in items:
            list_item = QListWidgetItem(
                f"{item['title']}\n{item['zone']}  ·  {item['kind']}  ·  {item['status']}"
            )
            list_item.setData(Qt.ItemDataRole.UserRole, item["id"])
            list_item.setSizeHint(QSize(0, 54))
            list_item.setToolTip(item["content"] or item["title"])
            if item["status"] == "种子":
                list_item.setForeground(QColor("#7f9a75"))
            elif item["status"] == "探索中":
                list_item.setForeground(QColor("#ad8d4d"))
            self.list_widget.addItem(list_item)
        self.list_widget.blockSignals(False)


    def _on_current_changed(self, current, previous):
        if current is None:
            return
        knowledge_id = current.data(Qt.ItemDataRole.UserRole)
        self._select_id(knowledge_id)

    def _select_id(self, knowledge_id, from_refresh=False):
        items_by_id = {item["id"]: item for item in self._all_items}
        if knowledge_id not in items_by_id:
            return
        self.current_id = knowledge_id
        self.orbit.set_selected(knowledge_id)
        if not from_refresh:
            for row in range(self.list_widget.count()):
                item = self.list_widget.item(row)
                if item.data(Qt.ItemDataRole.UserRole) == knowledge_id:
                    self.list_widget.blockSignals(True)
                    self.list_widget.setCurrentItem(item)
                    self.list_widget.scrollToItem(item)
                    self.list_widget.blockSignals(False)
                    break
        item = items_by_id[knowledge_id]
        related = self._related_for(item)
        reflections = self.store.knowledge_reflections(knowledge_id)
        stats = self.store.knowledge_stats()
        self.detail.show_item(item, related, reflections, stats)

    def _combine_links(self, items, explicit_links):
        combined = []
        seen = set()
        for link in explicit_links:
            key = tuple(sorted((link["from_id"], link["to_id"])))
            if key in seen:
                continue
            seen.add(key)
            combined.append({
                "from_id": link["from_id"],
                "to_id": link["to_id"],
                "relation": link["relation"],
            })
        for link in self._tag_links(items):
            key = tuple(sorted((link["from_id"], link["to_id"])))
            if key in seen:
                continue
            seen.add(key)
            combined.append(link)
        return combined

    @staticmethod
    def _tag_links(items):
        tag_members = {}
        for item in items:
            for tag in parse_tags(item["tags"]):
                tag_members.setdefault(tag, []).append(item)
        pairs = {}
        for tag, members in tag_members.items():
            if len(members) < 2:
                continue
            for index, left in enumerate(members):
                for right in members[index + 1:]:
                    key = tuple(sorted((left["id"], right["id"])))
                    pairs.setdefault(key, set()).add(tag)
        links = []
        for (left_id, right_id), tags in pairs.items():
            links.append({
                "from_id": left_id,
                "to_id": right_id,
                "relation": "同频",
                "tags": sorted(tags),
            })
            # 一个泛标签可能把几十条知识两两连起来，画出来反而看不清。
            # 保留前 180 条自动关系，超出部分仍可在详情里按标签查到。
            if len(links) >= 180:
                break
        return links

    def _related_for(self, item):
        items_by_id = {row["id"]: row for row in self._all_items}
        related = []
        seen = set()
        for link in self._explicit_links:
            other_id = None
            if link["from_id"] == item["id"]:
                other_id = link["to_id"]
            elif link["to_id"] == item["id"]:
                other_id = link["from_id"]
            if other_id in items_by_id and other_id not in seen:
                seen.add(other_id)
                related.append({
                    "id": other_id,
                    "title": items_by_id[other_id]["title"],
                    "relation": link["relation"] or "关联",
                })
        own_tags = set(parse_tags(item["tags"]))
        if own_tags:
            for other in self._all_items:
                if other["id"] == item["id"] or other["id"] in seen:
                    continue
                common = own_tags.intersection(parse_tags(other["tags"]))
                if common:
                    seen.add(other["id"])
                    related.append({
                        "id": other["id"],
                        "title": other["title"],
                        "relation": "同频：" + "、".join(sorted(common)),
                    })
        return related

    def _flash(self, text):
        if hasattr(self.window, "flash"):
            self.window.flash(text)

    def open_add(self):
        if hasattr(self, "sub_tabs"):
            self.sub_tabs.setCurrentIndex(1)
        if hasattr(self.window, "tabs") and hasattr(self.window, "knowledge_page"):
            self.window.tabs.setCurrentWidget(self.window.knowledge_page)
        dialog = KnowledgeDialog(self.window, self.store)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            knowledge_id = self.store.add_knowledge(dialog.data)
            self.search_edit.blockSignals(True)
            self.search_edit.clear()
            self.search_edit.blockSignals(False)
            self.zone_filter.blockSignals(True)
            self.zone_filter.setCurrentIndex(0)
            self.zone_filter.blockSignals(False)
            self.current_id = knowledge_id
            self.refresh()
            self._flash("一颗新的知识星体已进入星球")


    def _open_edit(self):
        if self.current_id is None:
            return
        item = self.store.knowledge_item(self.current_id)
        if item is None:
            return
        dialog = KnowledgeDialog(self.window, self.store, item)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.store.update_knowledge(self.current_id, dialog.data)
            self.refresh()
            self._flash("知识星体已更新")

    def _open_delete(self):
        if self.current_id is None:
            return
        item = self.store.knowledge_item(self.current_id)
        if item is None:
            return
        answer = QMessageBox.question(
            self, "删除知识",
            f"确定删除《{item['title']}》吗？\n与它相关的手动连线也会一起删除。",
        )
        if answer == QMessageBox.StandardButton.Yes:
            self.store.delete_knowledge(self.current_id)
            self.current_id = None
            self.refresh()
            self._flash("知识星体已删除")

    def _open_link(self):
        if self.current_id is None:
            QMessageBox.information(
                self, "先选一颗星", "从列表或星图中选一条知识，再建立关联。"
            )
            return
        if len(self._all_items) < 2:
            QMessageBox.information(
                self, "还少一颗星", "至少记录两条知识，才能建立关联。"
            )
            return
        dialog = KnowledgeLinkDialog(self.window, self._all_items, self.current_id)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.store.add_knowledge_link(*dialog.values)
            self.refresh()
            self._flash("两颗知识已经产生引力")

    def _open_reflect(self):
        if self.current_id is None:
            return
        item = self.store.knowledge_item(self.current_id)
        if item is None:
            return
        dialog = ReflectionDialog(self.window, item)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            prompt, content = dialog.values
            self.store.add_knowledge_reflection(self.current_id, prompt, content)
            self.refresh()
            self._flash("这次反思已记录，知识发生了一次反射")
