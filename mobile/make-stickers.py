"""直接把原始表情图缩放后用作头像。不做任何背景处理。

## 为什么改成这样

前面几版我一直在做"去白底 + 描边 + 渐变"，每版都有问题：

  · 按亮度判断背景 → 角色的脸和银发也很亮，被误删 → 深色下脸发黑
  · 改成从边缘漫水填充 → 合成那步用错 API（Image.composite 是整像素
    替换，把透明背景又换回不透明白色）→ 整张图变成一块纯白
  · 修了合成 → 还是纯白 → 又得加诊断输出再查一轮

**每一次都是"改算法 → 出错 → 再改算法"，反复消耗时间。**

## 现在的做法

原图本身就是**设计好的贴纸**：白底 + 完整人物 + 文字和符号，
边缘干净。所以：

  1. 只做缩放（2048 → 320），不碰任何像素
  2. 四周那圈白底**交给 CSS 的径向遮罩**去柔和化开
     （见 style.css 的 .sticker）
  3. 深色主题下给一层很淡的浅色底衬托（.sticker-plate）

这样：
  · **不可能出现全透明** —— 没动 alpha
  · **不可能脸发黑** —— 没动颜色
  · 想调边缘柔化程度，只改 CSS 一个数字，不用重新导出图片

## 用法

    py make-stickers.py
"""

import os
import sys

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：py -m pip install Pillow")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
ATTACH = r"C:\Users\cj\.dsh\attachments\v1\objects"
OUT_DIR = os.path.join(HERE, "icons")

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

#: 输出尺寸。
#:   大图 320px  首屏、空状态的主形象（显示 108~112px，3 倍屏够用）
#:   小图 128px  聊天气泡头像（显示 40px，3 倍屏够用）
#: 原图 2048px 直接缩放，不做裁切——
#: 因为白底在 CSS 里用遮罩化开，不需要预先裁掉边缘。
BIG = 320
SMALL = 128
QUALITY = 90


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 旧的先挪走，成功才删。避免中途出错留下空目录。
    backup = os.path.join(HERE, "_icons_backup")
    os.makedirs(backup, exist_ok=True)
    for name in os.listdir(backup):
        os.remove(os.path.join(backup, name))
    for name in os.listdir(OUT_DIR):
        if name.lower().endswith((".webp", ".png")):
            os.replace(os.path.join(OUT_DIR, name), os.path.join(backup, name))

    done = 0
    missing = []
    total = 0

    for name, rel in STICKERS:
        source = os.path.join(ATTACH, rel)
        if not os.path.isfile(source):
            missing.append(name)
            continue

        image = Image.open(source).convert("RGB")

        for size, suffix in ((BIG, "@hero"), (SMALL, "")):
            scaled = image.resize((size, size), Image.LANCZOS)
            path = os.path.join(OUT_DIR, f"{name}{suffix}.webp")
            scaled.save(path, "WEBP", quality=QUALITY, method=6)
            kb = os.path.getsize(path) / 1024
            total += kb
            if not suffix:
                small_kb = kb
            else:
                big_kb = kb

        done += 1
        print(f"  {name:12} 大图 {big_kb:6.1f} KB   小图 {small_kb:6.1f} KB")

    if missing:
        print()
        print("这些原图找不到，需要重新附件发一次：")
        for name in missing:
            print("  " + name)

    if not done:
        for name in os.listdir(backup):
            os.replace(os.path.join(backup, name), os.path.join(OUT_DIR, name))
        print()
        print("没有生成任何图片，已还原上一版。")
        return 1

    for name in os.listdir(backup):
        os.remove(os.path.join(backup, name))

    print()
    print(f"共 {done} 张表情 × 2 个尺寸，合计 {total:.0f} KB"
          f"（原图约 {done * 500} KB）")
    print(f"  {BIG}px  首屏 / 空状态的主形象")
    print(f"  {SMALL}px  聊天气泡头像")
    print("边缘柔化由 CSS 的 .sticker 遮罩负责，改 style.css 即可，")
    print("不需要重新生成图片。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
