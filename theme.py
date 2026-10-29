"""主题：界面配色，语义 token 化。

这套配色是**这个项目自己的**，不是照搬「墨读」的粉红：
    「墨读」是阅读器，长时间盯着暖粉调舒服；
    这里是管理仪表盘，一屏几十个数字和风险标记，
    中性偏冷的蓝灰骨架更耐看，风险色（绿/黄/橙/红）也不会糊在粉底上。

沿用「墨读」的是**结构**而不是颜色：token 化、留白、卡片分组、
文字按钮默认隐形、自绘图表。改配色只动这个文件，样式表一个字不用改。

配色原则：
  · 强调色是低饱和的石青蓝，只用在按钮、选中态、图表上，不铺大面积
  · 文字分五档明度（正文 / 标题 / 次要 / 说明 / 提示），靠层级而不是靠加粗
  · 风险四色全部降饱和，避免一屏红黄绿像交通灯
  · 深色不是简单反色：强调色提亮、风险色降饱和，否则暗底上会「发光」
"""
from string import Template

__all__ = ["THEMES", "theme_names", "palette", "current_theme", "set_theme",
           "render_stylesheet", "series_colors", "level_colors"]

LIGHT = {
    # 底色
    "bg_win": "#f4f5f7",        # 窗口底：极浅的冷灰
    "bg_panel": "#ffffff",      # 面板 / 卡片 / 表格
    "bg_read": "#fafbfc",       # 大块留白区（预测结论那种），比面板略暗一点点
    "bg_read_line": "#e8ebef",
    "bg_chart": "#ffffff",

    # 文字：五档明度
    "fg": "#2f3540",            # 正文
    "fg_strong": "#1b2028",     # 标题与关键数字
    "fg_soft": "#4d5563",       # 次要信息
    "fg_dim": "#78828f",        # 说明文字
    "fg_faint": "#a2aab5",      # 状态栏提示
    "fg_read": "#333a45",

    # 线条
    "line": "#e3e6ea",
    "line_soft": "#eceef1",
    "line_hair": "#f1f3f5",
    "line_input": "#d8dce2",

    # 交互：石青蓝，低饱和
    "accent": "#7c93ad",
    "accent_dim": "#5f7893",
    "accent_deep": "#4d647c",
    "accent_wash": "#e9eef4",
    "accent_edge": "#b6c5d4",
    "hover": "#eef1f4",
    "pressed": "#e5e9ee",

    # 控件底色
    "btn_bg": "#ffffff",
    "btn_bg_off": "#f4f5f7",
    "field_bg": "#ffffff",
    "field_line": "#e0e3e8",
    "field_focus": "#b6c5d4",
    "disabled_fg": "#bcc2cb",
    "muted_fg": "#78828f",

    # 其它
    "selection": "#d5e0ea",
    "menu_hover": "#eef1f4",
    "track": "#eceef1",
    "scroll": "#d5d9df",
    "scroll_hover": "#bcc2cb",
    "tooltip_bg": "#2f3540",
    "tooltip_fg": "#f4f5f7",
    "warn": "#b06a5a",
}

DARK = {
    "bg_win": "#191b1f",
    "bg_panel": "#22252a",
    "bg_read": "#1d2024",
    "bg_read_line": "#2c3036",
    "bg_chart": "#22252a",

    "fg": "#ccd2da",
    "fg_strong": "#e8ecf1",
    "fg_soft": "#aab2bd",
    "fg_dim": "#8b939f",
    "fg_faint": "#666d78",
    "fg_read": "#c3c9d2",

    "line": "#2e3238",
    "line_soft": "#282b31",
    "line_hair": "#262930",
    "line_input": "#3a3f46",

    # 暗底上强调色要提亮，否则一片糊
    "accent": "#8ea8c4",
    "accent_dim": "#a3bcd6",
    "accent_deep": "#b6cce3",
    "accent_wash": "#252b33",
    "accent_edge": "#3c4653",
    "hover": "#282c32",
    "pressed": "#30343b",

    "btn_bg": "#282b31",
    "btn_bg_off": "#23262b",
    "field_bg": "#1e2125",
    "field_line": "#32363d",
    "field_focus": "#4d5a68",
    "disabled_fg": "#565c66",
    "muted_fg": "#8b939f",

    "selection": "#2f3a46",
    "menu_hover": "#282c32",
    "track": "#282b31",
    "scroll": "#363a41",
    "scroll_hover": "#484d55",
    "tooltip_bg": "#e8ecf1",
    "tooltip_fg": "#191b1f",
    "warn": "#cc8b7a",
}

THEMES = {"light": LIGHT, "dark": DARK}

#: 图表曲线配色。和界面蓝灰岔开——要同时区分多条线，
#: 用一组明度接近但色相分散的莫兰迪色，谁也压不过谁。
SERIES = {
    "light": ["#5f7893", "#a8737d", "#7f9e86", "#c4a76a", "#8a7fa8", "#6a9aa8"],
    "dark": ["#8ea8c4", "#c08893", "#8fb096", "#d4bb80", "#a894c4", "#7fb0c4"],
}

#: 风险等级配色。绿→黄→橙→红，但全部降饱和，
#: 免得一屏红黄绿像交通灯。深色下同样降饱和提亮。
LEVELS = {
    "light": {
        "健康": "#6f9a78",
        "关注": "#c0a860",
        "风险": "#c08457",
        "严重": "#a8606a",
    },
    "dark": {
        "健康": "#82ab8b",
        "关注": "#d0bb78",
        "风险": "#d29a72",
        "严重": "#bd7681",
    },
}

_current = "light"


def theme_names():
    return list(THEMES)


def set_theme(name):
    global _current
    if _current != name and name in THEMES:
        _current = name
    return _current


def current_theme():
    return _current


def palette():
    return dict(THEMES[_current])


def series_colors():
    return list(SERIES[_current])


def level_colors():
    return dict(LEVELS[_current])


def render_stylesheet(template_text, name=None):
    colors = THEMES.get(name or _current, LIGHT)
    return Template(template_text).safe_substitute(colors)
