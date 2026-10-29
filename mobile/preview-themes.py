"""生成一张浅色 / 深色对比图，模拟贴纸在界面上的实际观感。

## 为什么需要它

手机版的边缘柔化是用 CSS 的 mask 做的，而 CSS 效果我在这边看不到
（read_image 只能读静态图片）。所以这里**在 Python 里模拟同样的径向遮罩**，
把结果叠在浅色底和深色底上，导出一张 PNG。

这样：
  · 我看得到（能读 PNG）
  · 你看得到（不用开浏览器）
  · 而且**模拟的参数和 style.css 里的 mask 一一对应**，
    改下面的 MASK_STOPS 就等于改 CSS

## 用法

    py preview-themes.py

输出：_avatar_debug/theme-compare.png
"""

import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("需要 Pillow：py -m pip install Pillow")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "icons")
OUT_DIR = os.path.join(HERE, "_avatar_debug")

NAMES = ["01_嗯", "02_好耶", "03_睡觉", "04_疑惑", "05_哼",
         "06_惊讶", "07_抱抱", "08_嗯嗯", "09_暗中观察"]

#: 和 style.css 里 .sticker 的 mask 对应：
#:   radial-gradient(circle at 50% 50%, #000 58%, rgba(0,0,0,.75) 74%, transparent 92%)
#: 每个元组是 (半径比例, 该处的不透明度)
MASK_STOPS = [(0.58, 1.0), (0.74, 0.75), (0.92, 0.0)]

#: 界面的实际底色（取自 style.css 的 --bg / --panel）
LIGHT_BG = (244, 245, 247)
LIGHT_PANEL = (255, 255, 255)
DARK_BG = (25, 27, 31)
DARK_PANEL = (34, 37, 42)

#: 深色主题下 .sticker 那层柔和的浅色底：
#:   radial-gradient(circle at 50% 50%,
#:     rgba(255,255,255,.07) 0%, rgba(255,255,255,.03) 55%, transparent 78%)
DARK_PLATE_STOPS = [(0.55, 0.07), (0.78, 0.0)]

#: 实际显示尺寸。首屏 108px、气泡 40px —— 两个都要看
SIZES = [("首屏", 108), ("气泡", 40)]


def radial_mask(size, stops):
    """按 stops 生成一张径向渐变遮罩（L 模式）。

    stops 是 (半径比例, 值) 的列表，值域 0~1。
    最后一个 stop 之后全是 0。
    """
    mask = Image.new("L", (size, size), 0)
    pixels = mask.load()
    center = (size - 1) / 2.0
    max_radius = size / 2.0

    for y in range(size):
        for x in range(size):
            distance = ((x - center) ** 2 + (y - center) ** 2) ** 0.5
            ratio = distance / max_radius
            value = 0.0
            for index in range(len(stops) - 1):
                start_r, start_v = stops[index]
                end_r, end_v = stops[index + 1]
                if ratio <= start_r:
                    value = start_v
                    break
                if ratio <= end_r:
                    span = end_r - start_r
                    t = (ratio - start_r) / span if span > 0 else 0.0
                    value = start_v + (end_v - start_v) * t
                    break
            else:
                value = stops[-1][1] if ratio <= stops[-1][0] else 0.0
            if ratio <= stops[0][0]:
                value = stops[0][1]
            pixels[x, y] = int(255 * max(0.0, min(1.0, value)))
    return mask


def composite_sticker(source, size, background, plate_stops=None):
    """把贴纸按实际渲染流程叠到背景上。

    流程和浏览器一致：
      1. 贴纸缩放到显示尺寸
      2. 深色主题时先画那层柔和的浅色底（plate）
      3. 贴纸用径向遮罩合成上去
    """
    canvas = Image.new("RGB", (size, size), background)

    if plate_stops:
        plate = Image.new("RGB", (size, size), (255, 255, 255))
        plate_mask = radial_mask(size, plate_stops)
        canvas = Image.composite(plate, canvas, plate_mask)

    sticker = source.resize((size, size), Image.LANCZOS).convert("RGB")
    mask = radial_mask(size, MASK_STOPS)
    return Image.composite(sticker, canvas, mask)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    loaded = []
    for name in NAMES:
        path = os.path.join(ICON_DIR, f"{name}@hero.webp")
        if os.path.isfile(path):
            loaded.append((name, Image.open(path)))
    if not loaded:
        print("icons 里没有立绘。先跑：py make-stickers.py")
        return 1

    cell = 150
    pad = 10
    label_h = 22
    header_h = 30
    row_h = cell + label_h + pad

    width = pad + len(loaded) * (cell + pad)
    # 四行：浅色 首屏 / 浅色 气泡 / 深色 首屏 / 深色 气泡
    height = header_h + row_h * 4 + pad

    canvas = Image.new("RGB", (width, height), (250, 250, 251))
    draw = ImageDraw.Draw(canvas)

    rows = [
        ("浅色 · 首屏 108px", LIGHT_BG, None, 108),
        ("浅色 · 气泡 40px", LIGHT_PANEL, None, 40),
        ("深色 · 首屏 108px", DARK_BG, DARK_PLATE_STOPS, 108),
        ("深色 · 气泡 40px", DARK_PANEL, DARK_PLATE_STOPS, 40),
    ]

    for row_index, (label, background, plate, size) in enumerate(rows):
        y = header_h + row_index * row_h
        # 整行的底色带，方便看出"贴纸和界面的对比"
        draw.rectangle((0, y, width, y + cell), fill=background)
        draw.text((pad, y + cell + 4), label, fill=(90, 98, 110))

        for col_index, (name, image) in enumerate(loaded):
            x = pad + col_index * (cell + pad)
            tile = composite_sticker(image, size, background, plate)
            # 居中放
            offset_x = x + (cell - size) // 2
            offset_y = y + (cell - size) // 2
            canvas.paste(tile, (offset_x, offset_y))

    draw.text((pad, 8), "贴纸在界面上的实际观感（遮罩参数与 style.css 一致）",
              fill=(47, 53, 64))

    out = os.path.join(OUT_DIR, "theme-compare.png")
    canvas.save(out, "PNG")
    print(f"对比图：{out}")
    print(f"  {canvas.width} x {canvas.height}")
    print()
    print("四行分别是：")
    for label, _, _, _ in rows:
        print("  " + label)
    print()
    print("看两件事：")
    print("  1. 深色下贴纸四周那圈白光晕明不明显（.sticker 的 mask 收紧可解决）")
    print("  2. 40px 那行还能不能认出是什么表情（小尺寸是气泡头像的实际大小）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
