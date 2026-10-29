"""诊断：深色模式下头像"脸全黑"。

## 三种可能，逐个排除

  1. **裁切位置错了** —— 裁到帽子/背景，根本没裁到脸。
     测法：算裁切区域的平均亮度。脸是亮的，帽子是暗的。

  2. **透明区域的 RGB 是黑色** —— 这是最隐蔽的一种。
     很多看图软件、以及部分渲染路径会**把全透明像素当成黑色**。
     如果 PNG/WebP 里那些 alpha=0 的像素 RGB 也是 (0,0,0)，
     图看起来就是"周围一圈黑"或者整片发黑。
     测法：看 alpha=0 的像素，RGB 平均值是多少。

  3. **过渡带把颜色压暗了** —— 我的算法在半透明处乘了 0.94。
     测法：看 alpha 在 1..254 的像素，平均亮度和平均 alpha。

## 用法

    py diagnose-avatar.py
"""

import os
import sys

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：py -m pip install Pillow")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "icons")
ATTACH = r"C:\Users\cj\.dsh\attachments\v1\objects"

#: 测试这几张。01 是正面大头，03 是趴着，06 是惊讶 —— 覆盖典型情况
SAMPLES = [
    ("01_嗯", "f0/f00bb08c483332de10f6d7afc24b30a3ad81ab9d41d5e60be50cc84bb1c7751b"),
    ("03_睡觉", "71/71b30744f07677f3ecb64942ad13de6975af121e3d54a424dbe4e1c973ea1723"),
    ("06_惊讶", "68/68e9f76caa95a96ef1c6eae75b408edd0fd31c30dd16719f1204481a8b846edc"),
]

#: 必须和 prepare-avatars.py 里的 CROPS 保持一致，
#: 否则测的是旧参数，结论会误导。
CROPS = {
    "default": (0.20, 0.22, 0.80, 0.76),
    "03_睡觉": (0.18, 0.30, 0.82, 0.80),
    "09_暗中观察": (0.18, 0.38, 0.82, 0.86),
    "07_抱抱": (0.18, 0.26, 0.82, 0.78),
}


def luma(r, g, b):
    return 0.299 * r + 0.587 * g + 0.114 * b


def stats(image):
    """返回 (平均亮度, alpha=0 的像素数, alpha=0 的像素平均 RGB, 半透明像素数, 半透明平均亮度, 半透明平均 alpha)"""
    rgba = image.convert("RGBA")
    pixels = list(rgba.getdata())

    opaque_lum = []
    transparent = []
    translucent = []

    for r, g, b, a in pixels:
        if a == 0:
            transparent.append((r, g, b))
        elif a == 255:
            opaque_lum.append(luma(r, g, b))
        else:
            translucent.append((luma(r, g, b), a))

    def avg(values):
        return sum(values) / len(values) if values else 0.0

    return {
        "主体亮度": avg(opaque_lum),
        "全透明数": len(transparent),
        "全透明RGB均值": avg([avg(t) for t in transparent]) if transparent else 0.0,
        "全透明RGB最大": max([max(t) for t in transparent]) if transparent else 0,
        "半透明数": len(translucent),
        "半透明亮度": avg([t[0] for t in translucent]),
        "半透明alpha": avg([t[1] for t in translucent]),
    }


def main():
    print("=" * 78)
    print("第 1 步：原图裁切区域有多亮？（脸亮、帽子暗）")
    print("=" * 78)
    print(f"{'名称':12}{'原图尺寸':>12}{'裁切区亮度':>12}{'是否裁到脸':>14}")

    for name, rel in SAMPLES:
        source = os.path.join(ATTACH, rel)
        if not os.path.isfile(source):
            print(f"{name:12}{'原图缺失':>12}")
            continue
        image = Image.open(source)
        width, height = image.size
        left, top, right, bottom = CROPS.get(name, CROPS["default"])
        crop = image.crop((int(width * left), int(height * top),
                           int(width * right), int(height * bottom)))
        gray = crop.convert("L")
        average = sum(gray.getdata()) / (gray.width * gray.height)
        verdict = "是（偏亮）" if average > 150 else (
            "可疑（偏暗）" if average > 100 else "否（很暗）")
        print(f"{name:12}{f'{width}x{height}':>12}{average:>12.1f}{verdict:>14}")

    print()
    print("=" * 78)
    print("第 2 步：透明区域和半透明区域的像素值")
    print("=" * 78)
    print("关键：**全透明RGB均值如果接近 0，说明透明像素是黑的** ——")
    print("      这会让部分看图软件把整片显示成黑色。")
    print()
    header = (f"{'名称':12}{'格式':>6}{'主体亮度':>9}{'全透明RGB':>11}"
              f"{'半透明数':>9}{'半透明亮度':>11}{'半透明α':>9}")
    print(header)
    print("-" * len(header))

    for name, _ in SAMPLES:
        for ext in ("webp", "png"):
            target = os.path.join(ICON_DIR, f"{name}.{ext}")
            if not os.path.isfile(target):
                continue
            image = Image.open(target)
            data = stats(image)
            print(f"{name if ext == 'webp' else '':12}{ext:>6}"
                  f"{data['主体亮度']:>9.1f}"
                  f"{data['全透明RGB均值']:>11.1f}"
                  f"{data['半透明数']:>9}"
                  f"{data['半透明亮度']:>11.1f}"
                  f"{data['半透明alpha']:>9.1f}")

    print()
    print("=" * 78)
    print("第 3 步：导出对照图（叠在深色底 vs 白底）")
    print("=" * 78)
    out_dir = os.path.join(HERE, "_avatar_debug")
    os.makedirs(out_dir, exist_ok=True)

    for name, _ in SAMPLES:
        source = os.path.join(ICON_DIR, f"{name}.webp")
        if not os.path.isfile(source):
            continue
        avatar = Image.open(source).convert("RGBA")
        for label, color in (("white", (255, 255, 255)),
                             ("dark", (25, 27, 31))):
            canvas = Image.new("RGBA", avatar.size, color + (255,))
            canvas.alpha_composite(avatar)
            path = os.path.join(out_dir, f"{name}_on_{label}.png")
            canvas.convert("RGB").save(path, "PNG")
        print(f"  {name}: _avatar_debug/{name}_on_white.png"
              f" / _avatar_debug/{name}_on_dark.png")

    print()
    print("判读方法：")
    print("  · 主体亮度 < 120          → 裁到帽子或背景了，改 CROPS 往下移")
    print("  · 全透明RGB均值接近 0     → 透明像素是黑的，看图软件会显示成黑块")
    print("                             （数据本身没问题，但观感差，应该修）")
    print("  · 半透明亮度 << 主体亮度   → 过渡带把颜色压暗了，改成不压暗")
    print()
    print("最直接的判断：打开 _avatar_debug/*_on_dark.png，")
    print("如果叠在深色底上脸是黑的 → 是我们处理的问题；")
    print("如果 *_on_dark.png 正常、只有 icons/*.png 在黑背景软件里发黑 → ")
    print("那是透明像素 RGB 为 0 导致的显示问题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
