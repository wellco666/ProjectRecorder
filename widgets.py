"""共享的小控件：徽标、卡片、区块标题、线条。

这些在多个页面里反复出现，抽出来避免每个页面各写一遍、
导致同一个东西在驾驶舱是圆的、在详情页是方的。
"""
from PyQt6.QtCore import QEvent, QPoint, QRect, QSize, Qt
from PyQt6.QtGui import QColor, QFont, QPainter, QPen
from PyQt6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QLayout, QToolButton, QVBoxLayout, QWidget,
)

import theme

__all__ = ["Badge", "StatCard", "SectionTitle", "LevelDot", "HairLine",
           "ChatBubble", "SuggestionChips", "ThemedWidget",
           "level_color", "label", "muted", "fmt_money", "fmt_hours"]


def level_color(level):
    """风险等级 → 颜色。统一从这里取，避免各处配色不一致。"""
    return theme.level_colors().get(level, theme.palette()["fg_dim"])


def label(text, object_name="", bold=False, size=None, color=None):
    """快速造一个 QLabel"""
    widget = QLabel(text)
    if object_name:
        widget.setObjectName(object_name)
    font = widget.font()
    if bold:
        font.setBold(True)
    if size:
        font.setPointSizeF(size)
    widget.setFont(font)
    if color:
        widget.setStyleSheet(f"color: {color};")
    return widget


def muted(text):
    return label(text, "PanelHint")


class Badge(QLabel):
    """状态徽标：圆角小块，用来标风险等级、项目状态"""

    def __init__(self, text="", color=None, parent=None):
        super().__init__(text, parent)
        self.setObjectName("Badge")
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.set_color(color or theme.palette()["fg_dim"])

    def set_color(self, color):
        self.setStyleSheet(
            f"#Badge {{ background-color: {color}; color: #ffffff;"
            f" border-radius: 9px; padding: 2px 10px;"
            f" font-size: 11.5px; font-weight: 600; }}"
        )

    def set_level(self, level):
        self.setText(level)
        self.set_color(level_color(level))


class StatCard(QFrame):
    """一张指标卡：大数字 + 小标题 + 一行说明。

    驾驶舱顶部那一排就是它。刻意只放「会让人立刻做决定」的数字，
    不是把所有能统计出来的数都堆上去。
    """

    def __init__(self, title="", value="", unit="", note="", parent=None):
        super().__init__(parent)
        self.setObjectName("Card")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(2)

        self.title_label = label(title, "CardTitle")
        layout.addWidget(self.title_label)

        row = QHBoxLayout()
        row.setSpacing(4)
        self.value_label = label(str(value), "CardValue")
        row.addWidget(self.value_label)
        self.unit_label = label(unit, "CardUnit")
        self.unit_label.setAlignment(
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignBottom
        )
        row.addWidget(self.unit_label)
        row.addStretch()
        layout.addLayout(row)

        self.note_label = label(note, "CardNote")
        layout.addWidget(self.note_label)

    def update_values(self, value="", unit="", note="", color=None):
        self.value_label.setText(str(value))
        self.unit_label.setText(unit)
        self.note_label.setText(note)
        if color:
            self.value_label.setStyleSheet(f"color: {color};")


class SectionTitle(QWidget):
    """区块标题：左侧一条粉色短竖线 + 文字。

    用它代替「画一整条横线分隔」，界面不会碎成一块块。
    """

    def __init__(self, text="", parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        self.text_label = label(text, "CardTitle")
        self.text_label.setStyleSheet(
            f"font-size: 13px; font-weight: 600; color: {theme.palette()['fg']};"
        )
        layout.addWidget(self.text_label)
        layout.addStretch()

    def setText(self, text):
        self.text_label.setText(text)


class HairLine(QFrame):
    """一条极淡的分隔线，只在确实需要时才用"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(1)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setPen(QPen(QColor(theme.palette()["line_soft"]), 1))
        painter.drawLine(0, 0, self.width(), 0)
        painter.end()


class LevelDot(QWidget):
    """风险等级小圆点。表格里用，比塞一个徽标省地方。"""

    def __init__(self, level="健康", parent=None):
        super().__init__(parent)
        self._level = level
        self.setFixedSize(12, 12)
        self.setToolTip(level)

    def set_level(self, level):
        self._level = level
        self.setToolTip(level)
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(level_color(self._level)))
        painter.drawEllipse(2.0, 2.0, 8.0, 8.0)
        painter.end()


# ------------------------------------------------------------------ 小助手
class ThemedWidget:
    """给自绘 / 自带样式表的控件用的混入：主题换了就自己更新。

    为什么需要它：
        chart.py 里的图取色于 theme.palette()，ChatBubble 把背景色
        写进了自己的样式表——这两类都**不走全局 QSS**。
        切主题时全局样式表换了，它们却纹丝不动，
        要等数据再刷新一次才更新，看起来就像"切了主题但图没变"。

    **必须记住「已经套用过哪个主题」**：
        apply_theme() 里会调 setStyleSheet()，
        而 setStyleSheet() 自己就会触发一次 StyleChange 事件，
        于是 changeEvent 又调 apply_theme()……**无限递归到栈溢出**，
        而且是 C++ 层的崩溃，Python 的 try/except 拦不住，
        整个进程直接消失。这个坑踩过，所以下面用 _applied_theme 挡一道。

    用法：
        class Foo(ThemedWidget, QWidget):
            def apply_theme(self):
                ...按新配色重设颜色...
    """

    #: 已经按哪个主题设过颜色。None 表示还没设过。
    _applied_theme = None

    def changeEvent(self, event):
        # StyleChange（不是 StyleSheetChange）= 这个控件的样式变了，
        # 全局样式表被替换时所有控件都会收到。
        # StyleChange 是正确枚举名，凭印象写成 StyleSheetChange 会直接崩。
        if event.type() in (QEvent.Type.StyleChange,
                            QEvent.Type.PaletteChange):
            self._refresh_theme_once()
        super().changeEvent(event)

    def _refresh_theme_once(self):
        """只在主题真的变了时才重设颜色，避免 setStyleSheet 触发递归"""
        current = theme.current_theme()
        if self._applied_theme == current:
            return
        self._applied_theme = current
        self.apply_theme()

    def apply_theme(self):
        """子类覆盖：按当前主题重设颜色。默认什么都不做。"""
        self.update()


# ------------------------------------------------------------------ 小助手
class ChatBubble(ThemedWidget, QFrame):
    """一条对话气泡。

    助手的气泡靠左、白底细边；用户的气泡靠右、用强调底色。
    刻意不做头像和圆角尾巴——那会让界面变花，
    而这里要的是能快速扫读的答案。

    颜色是写进自己样式表的，所以继承了 ThemedWidget，
    切主题时自己更新，不用主窗口挨个去刷。
    """

    def __init__(self, text="", is_user=False, parent=None):
        super().__init__(parent)
        self.is_user = is_user
        # 先记下「按当前主题设过了」，免得 setStyleSheet 触发
        # StyleChange 时又走一遍 apply_theme
        self._applied_theme = theme.current_theme()
        self.setObjectName("BubbleUser" if is_user else "BubbleBot")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.setSpacing(4)

        self.body = QLabel(text)
        self.body.setWordWrap(True)
        self.body.setTextFormat(Qt.TextFormat.PlainText)
        # 允许选中复制——老板可能要把结论贴给别人
        self.body.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        layout.addWidget(self.body)

        self.apply_theme()

    def apply_theme(self):
        colors = theme.palette()
        if self.is_user:
            background = colors["accent_wash"]
            border = colors["accent_edge"]
        else:
            background = colors["bg_panel"]
            border = colors["line"]
        self.setStyleSheet(
            f"#{self.objectName()} {{ background-color: {background};"
            f" border: 1px solid {border}; border-radius: 10px; }}"
        )
        self.body.setStyleSheet(
            f"color: {colors['fg']}; font-size: 13px;"
        )


class SuggestionChips(QWidget):
    """「点一下就问」的建议问题，自动换行排列。

    没有它，用户得猜这个助手会什么——那是很差的体验。
    有了它，能力边界一眼可见。问题一多就得换行，
    所以用 FlowLayout 而不是固定一行。
    """

    def __init__(self, suggestions=(), on_click=None, parent=None):
        super().__init__(parent)
        self._on_click = on_click
        self._layout = FlowLayout(self, h_spacing=6, v_spacing=6)
        self.set_suggestions(suggestions)

    def set_suggestions(self, suggestions):
        # 清空旧按钮
        while self._layout.count():
            item = self._layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        for text in suggestions:
            chip = QToolButton()
            chip.setObjectName("TextButton")
            chip.setText(text)
            chip.setCursor(Qt.CursorShape.PointingHandCursor)
            chip.clicked.connect(lambda _, t=text: self._emit(t))
            self._layout.addWidget(chip)

    def _emit(self, text):
        if self._on_click:
            self._on_click(text)


class FlowLayout(QLayout):
    """自动换行的水平布局。

    Qt 没有内置的流式布局，而建议问题数量会变，
    固定一行会在窗口窄的时候把按钮挤扁。
    """

    def __init__(self, parent=None, margin=0, h_spacing=6, v_spacing=6):
        super().__init__(parent)
        self._items = []
        self._h_spacing = h_spacing
        self._v_spacing = v_spacing
        self.setContentsMargins(margin, margin, margin, margin)

    def addItem(self, item):
        self._items.append(item)

    def count(self):
        return len(self._items)

    def itemAt(self, index):
        if 0 <= index < len(self._items):
            return self._items[index]
        return None

    def takeAt(self, index):
        if 0 <= index < len(self._items):
            return self._items.pop(index)
        return None

    def expandingDirections(self):
        return Qt.Orientation(0)

    def hasHeightForWidth(self):
        return True

    def heightForWidth(self, width):
        return self._do_layout(QRect(0, 0, width, 0), test_only=True)

    def setGeometry(self, rect):
        super().setGeometry(rect)
        self._do_layout(rect, test_only=False)

    def sizeHint(self):
        return self.minimumSize()

    def minimumSize(self):
        size = QSize()
        for item in self._items:
            size = size.expandedTo(item.minimumSize())
        margins = self.contentsMargins()
        return size + QSize(margins.left() + margins.right(),
                            margins.top() + margins.bottom())

    def _do_layout(self, rect, test_only):
        margins = self.contentsMargins()
        effective = rect.adjusted(margins.left(), margins.top(),
                                  -margins.right(), -margins.bottom())
        x = effective.x()
        y = effective.y()
        line_height = 0

        for item in self._items:
            hint = item.sizeHint()
            next_x = x + hint.width() + self._h_spacing
            if next_x - self._h_spacing > effective.right() and line_height > 0:
                # 放不下了，换行
                x = effective.x()
                y = y + line_height + self._v_spacing
                next_x = x + hint.width() + self._h_spacing
                line_height = 0
            if not test_only:
                item.setGeometry(QRect(QPoint(x, y), hint))
            x = next_x
            line_height = max(line_height, hint.height())
        return y + line_height - rect.y() + margins.bottom()


# ------------------------------------------------------------------ 格式化
def fmt_money(value):
    """金额：一万以上用「万」，否则带千分位"""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return "0"
    if abs(number) >= 10000:
        return f"{number / 10000:,.1f} 万"
    return f"{number:,.0f}"


def fmt_hours(value):
    try:
        return f"{float(value or 0):,.1f}"
    except (TypeError, ValueError):
        return "0"
