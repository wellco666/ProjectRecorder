"""深色主题下头像处理的方案对比。

## 问题

角色是银发 + 白衬衫 + 淡紫，整体很浅。透明背景在深色界面上
**缺一圈边界**，看起来像一团漂浮的雾——不是"白边没去干净"，
而是"原本（虽然不好看但有用）的那个边界被去掉了"。

## 这里对比 4 种处理

  A 不加处理        —— 当前的透明版，作为基准
  B 极细浅色描边    —— box-shadow 做一圈 1px 的 inset 描边
  C 描边 + 底色     —— 描边再加一层很淡的底，让头像有"承托"
  D 略微压暗        —— filter 降低亮度提高对比，让浅色不那么刺眼

**在浅色主题下也应该看一遍**——B/C 的白圈在浅色底上可能会显得多余。
所以这个页面**浅色和深色都画**，每种方案一行。

## 用法

    py preview-dark.py
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "icons")
PREVIEW = os.path.join(HERE, "avatar-dark-preview.html")

#: 优先用 WebP，没有就退回 PNG
NAMES = ["01_嗯", "02_好耶", "03_睡觉", "04_疑惑", "05_哼",
         "06_惊讶", "07_抱抱", "08_嗯嗯", "09_暗中观察"]

#: 三种显示尺寸，都要看——32px 下描边会不会太抢
SIZES = [("气泡", 32), ("首屏", 56), ("空状态", 72)]


def asset_for(name):
    """返回可用的图片相对路径，优先 WebP。"""
    webp = os.path.join(ICON_DIR, f"{name}.webp")
    png = os.path.join(ICON_DIR, f"{name}.png")
    if os.path.isfile(webp):
        return f"icons/{name}.webp"
    if os.path.isfile(png):
        return f"icons/{name}.png"
    return None


def main():
    available = [(name, asset_for(name)) for name in NAMES]
    available = [(name, path) for name, path in available if path]
    if not available:
        print("icons 目录里没有图片。先跑：py prepare-avatars.py")
        return 1

    print(f"找到 {len(available)} 张头像")
    missing = [name for name in NAMES if not asset_for(name)]
    if missing:
        print("缺少：" + "、".join(missing))

    write_preview(available)
    print(f"预览页：{PREVIEW}")
    return 0


def write_preview(items):
    def row(variant, label, note):
        """一种方案，一行：浅色 + 深色，各三种尺寸。"""
        cells = []
        for theme in ("light", "dark"):
            for size_label, size in SIZES:
                pics = "\n".join(
                    f'<div class="cell">'
                    f'<img class="av {variant}" src="{path}" alt="{name}" '
                    f'style="width:{size}px;height:{size}px">'
                    f'<span class="cap">{name}</span></div>'
                    for name, path in items[:5])
                cells.append(
                    f'<div class="panel {theme}">'
                    f'<div class="panel-head">{theme == "light" and "浅色" or "深色"}'
                    f' · {size_label} {size}px</div>'
                    f'<div class="cells">{pics}</div></div>')
        return (f'<h2>{label}</h2><div class="note">{note}</div>'
                f'<div class="panels">{"".join(cells)}</div>')

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>深色头像方案对比</title>
<style>
  body {{
    margin: 0; padding: 26px;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei UI", sans-serif;
    background: #f4f5f7; color: #2f3540; font-size: 14px;
  }}
  h1 {{ font-size: 19px; margin: 0 0 8px; }}
  h2 {{ font-size: 15px; margin: 30px 0 4px; color: #1b2028; }}
  .note {{ color: #78828f; font-size: 13px; line-height: 1.7; margin-bottom: 10px; }}

  .panels {{ display: flex; flex-wrap: wrap; gap: 12px; }}
  .panel {{ border-radius: 12px; padding: 12px; min-width: 260px; }}
  .panel.light {{ background: #f4f5f7; border: 1px solid #e3e6ea; }}
  .panel.dark  {{ background: #191b1f; border: 1px solid #2e3238; }}
  .panel-head {{ font-size: 11px; margin-bottom: 9px; letter-spacing: .3px; }}
  .panel.light .panel-head {{ color: #a2aab5; }}
  .panel.dark  .panel-head {{ color: #666d78; }}
  .cells {{ display: flex; align-items: flex-end; gap: 10px; }}
  .cell {{ text-align: center; }}
  .cap {{ display: block; font-size: 9px; margin-top: 4px; }}
  .panel.light .cap {{ color: #a2aab5; }}
  .panel.dark  .cap {{ color: #5a616b; }}

  /* ---- A 基准：不加任何处理 ---- */
  .av {{ border-radius: 50%; display: block; object-fit: cover; }}

  /* ---- B 极细浅色描边 ---- */
  /* 用 inset 阴影而不是 border：border 会占掉尺寸、把图挤小。
     0.5px 在高分屏上就是一条发丝线。 */
  .av.ring {{
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .5),
                0 0 0 1px rgba(120, 130, 145, .18);
  }}

  /* ---- C 描边 + 很淡的底色 ---- */
  /* 底色用半透明白，让头像有一点"承托"，
     同时不会在浅色主题上显得突兀。 */
  .av.ring-bg {{
    background: rgba(255, 255, 255, .10);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .45),
                0 0 0 1px rgba(120, 130, 145, .16);
  }}

  /* ---- D 略微压暗 ---- */
  /* 降低亮度、提高对比，让浅色部分不那么"发光"。
     不动背景，所以不会有白边问题。 */
  .av.dim {{ filter: brightness(.93) contrast(1.1) saturate(1.05); }}
</style>
</head>
<body>
  <h1>深色主题下的头像处理 —— 4 种方案</h1>
  <div class="note">
    角色是银发 + 白衬衫 + 淡紫，整体很浅。透明背景在深色界面上**缺一圈边界**，
    看起来像浮着。<br>
    下面每种方案都画了<b>浅色和深色</b>、以及<b>三种实际尺寸</b>。
    <b>重点看 32px 那栏</b>——描边在小尺寸下会不会太抢、会不会糊。<br>
    请告诉我用哪个（A / B / C / D，或者"深色用 B、浅色用 A"这种组合）。
  </div>

  {row("", "A · 不加处理（当前）", "透明背景，深浅主题一个样。基准方案。")}
  {row("ring", "B · 极细浅色描边", "1px 的 rgba(255,255,255,.5) 内描边 + 极淡的外描边。深色下有边界，浅色下几乎看不出。")}
  {row("ring-bg", "C · 描边 + 淡淡底色", "在 B 的基础上加 10% 白色的底，头像有「承托」，但浅色主题上可能显得脏。")}
  {row("dim", "D · 略微压暗", "brightness(.93) + contrast(1.1)。不动背景，浅色部分不那么刺眼，但深色下的「浮」还在。")}

  <h2>建议</h2>
  <div class="note">
    我倾向 <b>深色用 B、浅色用 A</b>——用 CSS 的 <code>[data-theme=dark]</code>
    分别控制，图片本身只存一份。<br>
    D 可以叠加在任何一个方案上，如果觉得银发在深色下太亮，就在 B 之上再加 D。
  </div>
</body>
</html>
"""
    with open(PREVIEW, "w", encoding="utf-8") as handle:
        handle.write(html)


if __name__ == "__main__":
    raise SystemExit(main())
