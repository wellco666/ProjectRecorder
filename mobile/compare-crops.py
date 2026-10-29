"""裁切参数对比：一次生成多种方案，直接看图挑。

## 为什么需要它

裁切参数（往哪切、切多少）**没法靠数字盲调**。
上一轮我按"往下移"改了参数，结果从读数看是对的，
但实际看图才发现脸贴到了底边、头发被切掉。

所以这里把**所有候选参数**一次性渲染成一张大图，
横轴是"裁切盒子的位置和大小"，纵轴是 9 张表情。
看完直接挑，不用反复跑脚本。

## 用法

    py compare-crops.py

输出：
    _avatar_debug/crop-compare.png   参数对比大图
"""

import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("需要 Pillow：py -m pip install Pillow")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
ATTACH = r"C:\Users\cj\.dsh\attachments\v1\objects"
OUT_DIR = os.path.join(HERE, "_avatar_debug")

STICKERS = [
    ("01_嗯", "f0/f00bb08c483332de10f6d7afc24b30a3ad81ab9d41d5e60be50cc84bb1c7751b"),
    ("02_好耶", "b2/b251e4098a1198ccff5bbc01132ecd887721ed048ce850d48a82c4d0b2d98875"),
    ("03_睡觉", "71/71b30744f07677f3ecb64942ad13de6975af121e3d54a424dbe4e1c973ea1723"),
    ("04_疑惑", "16/16e7d254a02d782b3ffbf620a1974ac60f7e9c1ebf7757d70c83540aab4cbc7e"),
    ("05_哼", "4b/4b7c918ca0f7d872fdb0da68bf9724089864d5ad6f9ced7156f28248d316f9f7"),
    ("06_惊讶", "68/68e9f76caa95a96ef1c6eae75b408edd0fd31c30dd16719f1204481a8b846edc"),
    ("07_抱抱", "2e/2ea489146ef7e729243a7668aaf9243f36270faa7fa9fcaac83afef112171464"),
    ("08_嗯嗯", "f0/f05f4dc59fa2679dc59f3d10f664ed91125d7aea2b85d4008e75398e9cb80b7c"),
    ("09_暗中观察", "7e/7efe30f07f2dc766f99574c48ec33d9e900297e5ad98cf4053cabb57991b9eb0"),
]

#: 候选方案：名字 -> (左, 上, 右, 下) 都是相对原图的比例
#:
#: 命名规则：先方向后大小
#:   center  以画面正中为基准
#:   face    假定脸在中间偏上（这几张都是这情况：帽子在上、脸居中）
#:   tight   更紧，脸占比更大
#:   head    只取头部，不要肩膀
PLANS = [
    ("A 原参数(偏下)", (0.16, 0.12, 0.84, 0.82)),
    ("B 收紧", (0.20, 0.22, 0.80, 0.76)),
    ("C 上移", (0.18, 0.16, 0.82, 0.76)),
    ("D 上移更多", (0.18, 0.10, 0.82, 0.70)),
    ("E 紧+上移", (0.20, 0.14, 0.80, 0.68)),
    ("F 正方形脸区", (0.22, 0.12, 0.78, 0.68)),
    ("G 大脸", (0.24, 0.16, 0.76, 0.68)),
]

CELL = 128        # 每个头像渲染成多大
PAD = 8
LABEL_H = 20
ROW_LABEL_W = 96


def cut_white(image, white_cut=238, fade=26):
    """去白底。和 prepare-avatars.py 里用的是同一套算法。"""
    image = image.convert("RGBA")
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, _ = pixels[x, y]
            brightness = min(r, g, b)
            if brightness >= white_cut:
                pixels[x, y] = (r, g, b, 0)
            elif brightness > white_cut - fade:
                ratio = (white_cut - brightness) / float(fade)
                pixels[x, y] = (r, g, b, int(255 * ratio))
    return image


def render(source_image, plan, size):
    """按方案裁切 + 去白底 + 缩放。"""
    width, height = source_image.size
    left, top, right, bottom = plan
    crop = source_image.crop((int(width * left), int(height * top),
                             int(width * right), int(height * bottom)))
    # 先缩放再去白底：小图逐像素处理快得多，而且缩放会平滑边缘
    crop = crop.resize((size, size), Image.LANCZOS).convert("RGB")
    return cut_white(crop)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    loaded = []
    for name, rel in STICKERS:
        path = os.path.join(ATTACH, rel)
        if os.path.isfile(path):
            loaded.append((name, Image.open(path)))
    if not loaded:
        print("原图找不到。把 9 张表情重新附件发一次。")
        return 1

    columns = len(PLANS)
    #: 每个单元格画两遍：深色底上一次、棋盘格（看透明）一次
    canvas_w = ROW_LABEL_W + columns * (CELL + PAD) + PAD
    canvas_h = (LABEL_H + PAD) + len(loaded) * (CELL + LABEL_H + PAD) + PAD

    canvas = Image.new("RGB", (canvas_w, canvas_h), (244, 245, 247))
    draw = ImageDraw.Draw(canvas)

    # 表头
    for index, (label, _) in enumerate(PLANS):
        x = ROW_LABEL_W + index * (CELL + PAD)
        draw.text((x + 2, 6), label, fill=(47, 53, 64))

    for row, (name, image) in enumerate(loaded):
        y = LABEL_H + PAD + row * (CELL + LABEL_H + PAD)
        draw.text((6, y + CELL // 2), name, fill=(47, 53, 64))

        for index, (_, plan) in enumerate(PLANS):
            x = ROW_LABEL_W + index * (CELL + PAD)
            avatar = render(image, plan, CELL)
            # 深色底：这就是"深色模式下看起来怎样"
            tile = Image.new("RGB", (CELL, CELL), (25, 27, 31))
            tile.paste(avatar, (0, 0), avatar)
            canvas.paste(tile, (x, y))

        # 行末再画一个小尺寸版（32px），检查缩小后还看不看得清
        x = ROW_LABEL_W + columns * (CELL + PAD)
        if x + 32 <= canvas_w:
            avatar = render(image, PLANS[2][1], 32)
            tile = Image.new("RGB", (CELL, CELL), (25, 27, 31))
            tile.paste(avatar, (2, 2), avatar)
            canvas.paste(tile, (x, y))

    out = os.path.join(OUT_DIR, "crop-compare.png")
    canvas.save(out, "PNG")
    print(f"对比图：{out}")
    print(f"  {canvas_w} x {canvas_h}，共 {len(loaded)} 行 x {columns} 列")
    print()
    print("每格都是叠在深色底上的效果（深色模式就是这个观感）。")
    print("横向对比不同裁切方案，纵向是 9 张表情。")
    print("最右一列是 32px 的小尺寸版——气泡头像的实际大小。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
