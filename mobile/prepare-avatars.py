"""把表情图处理成 App 用的头像，并生成预览页。

## 为什么不能直接用原图

原图是 2048x2048 的"贴纸"，四周有字和符号（「嗯?」「好耶」、
问号、爱心、星星）。直接用有两个问题：

  1. **体积**：每张约 500 KB，9 张 4.5 MB。apk 从 4 MB 涨到 8 MB。
  2. **缩小后文字变成糊块**：缩到 48px 后那些文字就是一团灰，
     比不放还难看。

所以只保留**人物头部**，缩到 256x256，去掉白底（透明背景，
这样深色主题下不会有一块白方框），再压缩。

## 用法

    py prepare-avatars.py

它做三件事：
  1. 从 attachments 目录读那 9 张原图
  2. 裁出头部、缩到 256、去白底、存到 mobile/icons/
  3. 生成 avatar-preview.html —— **先在浏览器里看效果再决定用不用**

裁切参数在下面的 CROPS 里，位置不对就改那几个数再跑一次。
"""
import os
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
except ImportError:
    print("需要 Pillow。先装：")
    print("    py -m pip install Pillow")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
ATTACH = r"C:\Users\cj\.dsh\attachments\v1\objects"
OUT_DIR = os.path.join(HERE, "icons")
PREVIEW = os.path.join(HERE, "avatar-preview.html")

#: 9 张表情。名字 -> (attachments 里的 sha256 前两位/全名, 用途)
#: 用途说明写在预览页里，方便决定哪个表情放在哪个位置。
STICKERS = [
    ("01_嗯",       "f0/f00bb08c483332de10f6d7afc24b30a3ad81ab9d41d5e60be50cc84bb1c7751b",
     "中性 / 思考", "小助手默认表情"),
    ("02_好耶",     "b2/b251e4098a1198ccff5bbc01132ecd887721ed048ce850d48a82c4d0b2d98875",
     "开心", "一切正常、操作成功"),
    ("03_睡觉",     "71/71b30744f07677f3ecb64942ad13de6975af121e3d54a424dbe4e1c973ea1723",
     "安静", "没有数据、空状态"),
    ("04_疑惑",     "16/16e7d254a02d782b3ffbf620a1974ac60f7e9c1ebf7757d70c83540aab4cbc7e",
     "疑惑", "听不懂的问题"),
    ("05_哼",       "4b/4b7c918ca0f7d872fdb0da68bf9724089864d5ad6f9ced7156f28248d316f9f7",
     "不满 / 警告", "有风险、预算超支"),
    ("06_惊讶",     "68/68e9f76caa95a96ef1c6eae75b408edd0fd31c30dd16719f1204481a8b846edc",
     "惊讶 / 严重", "严重风险、超期"),
    ("07_抱抱",     "2e/2ea489146ef7e729243a7668aaf9243f36270faa7fa9fcaac83afef112171464",
     "亲和", "鼓励、建议"),
    ("08_嗯嗯",     "f0/f05f4dc59fa2679dc59f3d10f664ed91125d7aea2b85d4008e75398e9cb80b7c",
     "认可 / 认真", "确认、正在做"),
    ("09_暗中观察", "7e/7efe30f07f2dc766f99574c48ec33d9e900297e5ad98cf4053cabb57991b9eb0",
     "观察", "小助手等待输入"),
]

#: 裁切比例（相对原图）。只保留人物头部。
#:
#: ## 这些数字是怎么定出来的
#:
#: 不是猜的，是**看图量的**。以 01_嗯 为例（2048x2048）：
#:
#:   左眼中心   x≈600  y≈900
#:   右眼中心   x≈1010 y≈880
#:   鼻/嘴      x≈860  y≈1120
#:   下巴       x≈840  y≈1290
#:   帽檐上沿   y≈480
#:
#: 所以脸中心大约在 (0.40, 0.47)，下巴到 0.63。
#:
#: ## 上一版错在哪
#:
#: 我按"裁切区平均亮度偏低"就判定要往下收，改成 top=0.22。
#: 但亮度低只说明**深色占比多**，并不告诉我脸在哪——
#: 结果 top=0.22 把额头切掉了，bottom=0.76 又留了一大片黑外套，
#: 脸反而更贴底边。
#:
#: ## 现在的取法
#:
#:   top    = 0.17  从额头略上方开始（保留一点帽子，不然认不出角色）
#:   bottom = 0.72  到下巴下面一点（不要肩膀和手）
#:   left   = 0.19  到头发左缘
#:   right  = 0.79  到头发右缘（含单片眼镜）
#:
#: 这样脸会占满整个圆形区域，深色布料的比例大幅下降。
CROPS = {
    "default": (0.19, 0.17, 0.79, 0.72),
    # 趴着睡：整个头压在桌沿上，位置更低、更宽
    "03_睡觉": (0.17, 0.30, 0.83, 0.80),
    # 只露出眼睛在桌沿上方，主体在下半
    "09_暗中观察": (0.17, 0.36, 0.83, 0.84),
    # 低头蹭书，脸偏下且偏左
    "07_抱抱": (0.17, 0.24, 0.80, 0.76),
}

SIZE = 192
#: 立绘版（整张图 + 边缘渐变淡出）的尺寸。
#: 这个版本用在空状态、首屏这类"大一点"的位置，
#: 形状不是圆的，而是**边缘羽化**——就是参考作品里那个效果。
HERO_SIZE = 320
#: 描边 + 渐变淡出。
#:
#: ## 效果
#:
#: 沿着人物轮廓描一圈深色，然后从某个半径开始向外**渐变到透明**。
#: 这样头像自带形状感（不用靠底色撑），边缘又是柔和地化开，
#: 不会出现一个硬边圆圈。
#:
#: ## 几个参数
#:
#:   OUTLINE_WIDTH   描边粗细（最终尺寸下的像素）。太粗会像贴纸，
#:                   3~6 之间比较自然。
#:   OUTLINE_COLOR   描边颜色。深色描边在浅色背景上成立；
#:                   深色背景上本来想用浅色描边，但那样浅色主题下
#:                   会显得脏，所以统一用深色，靠下面的渐变过渡。
#:   OUTLINE_ALPHA   描边的不透明度。不用纯黑，纯黑太硬。
#:
#:   FADE_START/END  渐变范围（占画面宽度的比例）。
#:                   从 START 开始变淡，到 END 完全透明。
#:                   START 太小会把脸也淡掉，太大就只剩下硬边。
OUTLINE_WIDTH = 5
OUTLINE_COLOR = (38, 34, 44)      # 偏紫的深色，和角色头发/帽子的暗部同调
OUTLINE_ALPHA = 0.55
FADE_START = 0.56
FADE_END = 0.92

#: 去白底的阈值。原图是白底，超过这个亮度就算背景。
WHITE_CUT = 238
#: 过渡带宽度：亮度在这个区间内做渐变，边缘才不会有硬边。
FADE = 26
#: 背景处保留的底色不透明度。设成 0 就是**完全透明**——
#: 因为现在靠描边提供轮廓，不需要底色了。
BACKDROP = (255, 255, 255)
BACKDROP_BLEND_FACE = 0.0
BACKDROP_BLEND_HERO = 0.0

#: 输出格式。WebP 同样画质体积只有 PNG 的 1/4~1/6，
#: 而且安卓 4.2+ 的 WebView 原生支持，所以优先用它。
#: 同时存一份 PNG 兜底——万一某个机型不认 WebP。
#: 质量 88 是肉眼基本看不出损失的档位。
WEBP_QUALITY = 88
KEEP_PNG_FALLBACK = False

#: 打开时会额外打印每个处理步骤的 alpha 分布。
#: 定位"图怎么变成全透明了"这类问题时用它：
#:     py prepare-avatars.py --debug
DEBUG = "--debug" in sys.argv


def add_outline_and_fade(image, width=OUTLINE_WIDTH,
                         color=OUTLINE_COLOR, alpha=OUTLINE_ALPHA,
                         fade_start=FADE_START, fade_end=FADE_END):
    """沿轮廓描一圈深色，再向外渐变到透明。

    ## 思路

     1. **描边**：把 alpha 通道"膨胀"若干像素，得到一圈比人物大一圈的
        区域；把这一圈染成深色，中间原来的人物保持不动。
        膨胀用 PIL 的 MaxFilter，它取邻域最大值——alpha 是 255 的地方
        会向四周扩散，扩散出来的就是描边。

     2. **渐变**：以画面中心为圆心，从 fade_start 半径开始把 alpha
        线性降到 0，到 fade_end 处完全透明。
        只乘 alpha、不动颜色，所以渐变区是"淡出"而不是"变暗"。

    ## 顺序很重要

    必须先描边再渐变。反过来的话，渐变先生成的半透明边缘会被 MaxFilter
    当成"有效像素"再次膨胀，描边就会长到图像外面去。
    """
    image = image.convert("RGBA")
    size = image.width

    # ---- 1. 描边 ----
    if width > 0:
        source_alpha = image.getchannel("A")
        # MaxFilter 在 PIL.ImageFilter 里，不在 PIL.Image 里。
        # 它的尺寸必须是奇数：width=3 → 7x7 的邻域。
        kernel = width * 2 + 1
        grown = source_alpha.filter(ImageFilter.MaxFilter(kernel))

        # 描边 = 膨胀后的区域。整体染成深色，再按原图的 alpha
        # 把人物自己"盖回去"——这样描边只出现在人物外面那一圈。
        outline = Image.new("RGBA", image.size, color + (0,))
        outline.putalpha(grown.point(lambda value: int(value * alpha)))
        image = Image.alpha_composite(outline, image)

    # ---- 2. 径向渐变淡出 ----
    if fade_end > 0:
        fade = Image.new("L", (size, size), 0)
        draw = ImageDraw.Draw(fade)
        center = size / 2.0
        inner = center * fade_start
        outer = center * fade_end
        # 从内到外画很多个同心圆，颜色从 255 递减到 0。
        # 用同心圆而不是逐像素计算：几百次画圆比 10 万次像素运算快得多。
        steps = 160
        for step in range(steps + 1):
            ratio = step / float(steps)
            radius = inner + (outer - inner) * ratio
            value = int(255 * (1 - ratio))
            draw.ellipse((center - radius, center - radius,
                          center + radius, center + radius),
                         fill=value)

        alpha_channel = image.getchannel("A")
        # 取两者较小的那个：原来透明的还是透明，渐变区按渐变值压低。
        # 用 ImageChops.darker 比逐像素循环快得多。
        out = ImageChops.darker(alpha_channel, fade)
        image.putalpha(out)

    return image


def cut_white_background(image, backdrop=(255, 255, 255), blend=0.5):
    """去掉白底。**用"从边缘漫水填充"而不是"按亮度判断"。**

    ## 为什么不能用亮度判断

    我前几版都是"像素够亮就当背景"。问题是**角色本身也很亮**：

        银发   #d8d5e8   最暗通道 213
        脸     #f2e4e0   最暗通道 224
        白底   #fdfdfd   最暗通道 253

    选 238 当阈值 → 脸的一部分（≥238）被判成背景删掉；
    选 245 → 背景又删不干净，留一圈白边。
    **这两类像素在数值上没有清晰的分界**，所以怎么调都不对。

    这正是"深色模式下脸发黑"的根源：脸被弄成半透明，
    深色背景透过来就是黑的。

    ## 漫水填充的做法

    从**四条边**开始，沿着"够亮"的像素往外扩散（BFS）。
    只有**和图像边缘连通**的亮区才被认定为背景。

    关键性质：
      · 脸被头发和帽子包住，**和边缘不连通** → 一定是前景，保住
      · 脸和背景之间隔着头发 → 不会"漏"进去
      · 背景是连成一片的 → 能干净地全部找到

    这比调阈值靠谱得多：**判定依据从"亮度"变成了"连通性"**。

    ## 描边为什么要靠这个

    描边的做法是把 alpha 通道膨胀几像素。如果 alpha 本身是错的
    （脸被删了），就无从描边。
    """
    image = image.convert("RGB")
    width, height = image.size

    #: 什么算"够亮、可能是背景"。只用于漫水填充的扩散条件，
    #: 因为还有连通性兜底，所以可以给得宽松一点。
    spread_cut = 230
    #: 前景的不透明度。小于 255 时角色本身也会半透明，
    #: 深色背景下会透过去。所以保持 255。
    opaque = 255

    def is_light(x, y):
        r, g, b = image.getpixel((x, y))
        return min(r, g, b) >= spread_cut

    # BFS：从四边所有够亮的像素出发
    background = bytearray(width * height)
    queue = []
    for x in range(width):
        for y in (0, height - 1):
            if is_light(x, y) and not background[y * width + x]:
                background[y * width + x] = 1
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if is_light(x, y) and not background[y * width + x]:
                background[y * width + x] = 1
                queue.append((x, y))

    head = 0
    while head < len(queue):
        x, y = queue[head]
        head += 1
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= width or ny >= height:
                continue
            index = ny * width + nx
            if background[index]:
                continue
            if not is_light(nx, ny):
                continue
            background[index] = 1
            queue.append((nx, ny))

    # 生成 alpha：背景处透明，前景不透明
    alpha = Image.new("L", (width, height), opaque)
    alpha_pixels = alpha.load()
    for y in range(height):
        for x in range(width):
            if background[y * width + x]:
                alpha_pixels[x, y] = int(255 * blend)

    # 生成结果：背景处按 blend 给 alpha，前景保持不透明。
    #
    # **这里必须用 Image.blend 混颜色，不能用 Image.composite。**
    #
    # 我上一版写的是：
    #     plate  = Image.new("RGBA", size, backdrop + (255,))
    #     result = Image.composite(plate, result, mask)
    # Image.composite 是**整像素替换**——连 alpha 一起换成 plate 的 255。
    # 于是刚设好的透明背景又被换回不透明白色，整张图变成一块白的。
    # 生成的文件只有 0.4 KB、看图是一片纯白，就是这个原因。
    #
    # Image.blend(图A, 图B, α) 是逐通道线性插值，alpha 通道也会按 α 插值，
    # 正是"背景保留一点底色"想要的效果。
    # 而且 blend=0 时它就等于原图，不需要额外分支。
    result = image.convert("RGBA")
    result.putalpha(alpha)
    if blend > 0:
        plate = Image.new("RGBA", (width, height), backdrop + (255,))
        result = Image.blend(result, plate, blend)
    return result


def alpha_stats(label, image):
    """打印一张图 alpha 通道的分布。用来定位"图怎么变全透明了"。"""
    channel = image.getchannel("A") if image.mode == "RGBA" else None
    if channel is None:
        print(f"    [{label}] 不是 RGBA，无法看 alpha")
        return
    values = list(channel.getdata())
    total = len(values)
    zero = sum(1 for v in values if v == 0)
    full = sum(1 for v in values if v == 255)
    print(f"    [{label}] alpha  全透明 {zero * 100.0 / total:5.1f}%"
          f"   完全不透明 {full * 100.0 / total:5.1f}%"
          f"   最小 {min(values)}  最大 {max(values)}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 先把旧文件挪到一边，而不是直接删。
    # 上一版是"开头清空、中途报错"，结果 icons/ 变成空目录，
    # 界面头像全没了（自检立刻报了 18 个文件缺失）。
    # 现在成功才真删，失败就还原。
    stale = [name for name in os.listdir(OUT_DIR)
             if name.lower().endswith((".png", ".webp"))]
    backup = os.path.join(HERE, "_icons_backup")
    if os.path.isdir(backup):
        for name in os.listdir(backup):
            os.remove(os.path.join(backup, name))
    else:
        os.makedirs(backup, exist_ok=True)
    for name in stale:
        os.replace(os.path.join(OUT_DIR, name), os.path.join(backup, name))

    results = []
    missing = []

    for name, rel, mood, usage in STICKERS:
        source = os.path.join(ATTACH, rel)
        if not os.path.isfile(source):
            missing.append((name, source))
            continue

        image = Image.open(source)

        # ---- 版本一：脸特写，圆形头像 ----
        # 用在聊天气泡那种很小的地方（32~56px）。
        # 小尺寸下必须只留脸，整身立绘缩到 32px 就成一团了。
        width, height = image.size
        left, top, right, bottom = CROPS.get(name, CROPS["default"])
        box = (int(width * left), int(height * top),
               int(width * right), int(height * bottom))
        face = image.crop(box).resize((SIZE, SIZE), Image.LANCZOS)
        if face.mode != "RGB":
            face = face.convert("RGB")
        if DEBUG and not results:
            gray = face.convert("L")
            values = list(gray.getdata())
            print(f"\n  === 诊断 {name} ===")
            print(f"    裁切区亮度  最小 {min(values)}  "
                  f"最大 {max(values)}  平均 {sum(values) / len(values):.1f}")

        face = cut_white_background(face, BACKDROP, BACKDROP_BLEND_FACE)
        if DEBUG and not results:
            alpha_stats("去白底后", face)
        # 描边 + 向外渐变淡出。这就是"外面轮廓深一圈、再化开"的效果。
        face = add_outline_and_fade(face)
        if DEBUG and not results:
            alpha_stats("描边+渐变后", face)

        face_path = os.path.join(OUT_DIR, f"{name}.webp")
        face.save(face_path, "WEBP", quality=WEBP_QUALITY, method=6)
        face_kb = os.path.getsize(face_path) / 1024
        if DEBUG and not results:
            print(f"    写出 {face_kb:.1f} KB")

        # ---- 版本二：整张立绘 ----
        # 用在空状态、首屏这类大一点的位置。
        # **这里不裁**——保留完整造型（贝雷帽、羽毛笔、手）。
        # 同样描边 + 渐变，只是描边粗一点（图更大，细描边看不出来）。
        hero = image.resize((HERO_SIZE, HERO_SIZE), Image.LANCZOS)
        if hero.mode != "RGB":
            hero = hero.convert("RGB")
        hero = cut_white_background(hero, BACKDROP, BACKDROP_BLEND_HERO)
        hero = add_outline_and_fade(
            hero,
            width=max(2, int(OUTLINE_WIDTH * HERO_SIZE / SIZE)),
            fade_start=FADE_START, fade_end=FADE_END)

        hero_path = os.path.join(OUT_DIR, f"{name}@hero.webp")
        hero.save(hero_path, "WEBP", quality=WEBP_QUALITY, method=6)
        hero_kb = os.path.getsize(hero_path) / 1024

        results.append((name, mood, usage, f"icons/{name}.webp", face_kb))
        print(f"  {name:12} 脸 {face_kb:6.1f} KB   立绘 {hero_kb:6.1f} KB")

    if missing:
        print()
        print("以下原图找不到（attachments 目录会被清理，你可能需要重新附一次）：")
        for name, path in missing:
            print(f"  {name}: {path}")

    if not results:
        print()
        print("没有处理任何图片。把 9 张表情图重新附件发一次，")
        print("或者手动把图片放到本目录下，改 STICKERS 里的路径。")
        # 还原备份的旧文件，别让 icons/ 空着
        for name in os.listdir(backup):
            os.replace(os.path.join(backup, name), os.path.join(OUT_DIR, name))
        print("已还原上一版头像。")
        return 1

    # 成功了，删掉备份
    for name in os.listdir(backup):
        os.remove(os.path.join(backup, name))

    total = sum(item[4] for item in results)
    print()
    print(f"共 {len(results)} 张表情，每张两个版本：")
    print(f"  脸特写   {SIZE}x{SIZE}   用于小尺寸（聊天气泡）"
          f"  合计 {total:.0f} KB")
    print(f"  整身立绘 {HERO_SIZE}x{HERO_SIZE}  用于大尺寸（空状态/首屏），"
          f"已烘焙描边和渐变")
    print(f"原图共约 {len(results) * 500} KB，质量 {WEBP_QUALITY}")

    write_preview(results)
    print(f"预览页：{PREVIEW}")
    return 0


def write_preview(results):
    """生成预览页：看裁切对不对、透明效果如何、深色下什么样。"""
    rows = "\n".join(f"""
      <div class="item">
        <div class="avatar"><img src="{path}" alt="{name}"></div>
        <div class="name">{name}</div>
        <div class="mood">{mood}</div>
        <div class="usage">{usage}</div>
        <div class="size">{size:.1f} KB</div>
      </div>""" for name, mood, usage, path, size in results)

    small = "\n".join(f"""
      <div class="tiny-row">
        <img src="{path}" alt="{name}">
        <span>{name} —— 实际显示尺寸（32 / 40 / 56px）</span>
      </div>""" for name, mood, usage, path, size in results)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>表情头像预览</title>
<style>
  body {{
    margin: 0; padding: 28px;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei UI", sans-serif;
    background: #f4f5f7; color: #2f3540; font-size: 14px;
  }}
  h1 {{ font-size: 19px; margin: 0 0 6px; }}
  .note {{ color: #78828f; font-size: 13px; margin-bottom: 22px; line-height: 1.7; }}
  h2 {{ font-size: 15px; margin: 30px 0 12px; color: #4d5563; }}

  .grid {{ display: flex; flex-wrap: wrap; gap: 14px; }}
  .item {{
    width: 150px; background: #fff; border: 1px solid #e3e6ea;
    border-radius: 12px; padding: 12px; text-align: center;
  }}
  .avatar {{
    width: 96px; height: 96px; margin: 0 auto 8px;
    border-radius: 50%; overflow: hidden;
    /* 棋盘格背景，方便看透明处理得好不好 */
    background-image:
      linear-gradient(45deg, #e8eaed 25%, transparent 25%),
      linear-gradient(-45deg, #e8eaed 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #e8eaed 75%),
      linear-gradient(-45deg, transparent 75%, #e8eaed 75%);
    background-size: 14px 14px;
    background-position: 0 0, 0 7px, 7px -7px, -7px 0;
  }}
  .avatar img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
  .name {{ font-weight: 600; color: #1b2028; }}
  .mood {{ font-size: 12px; color: #5f7893; margin-top: 2px; }}
  .usage {{ font-size: 12px; color: #78828f; margin-top: 3px; line-height: 1.5; }}
  .size {{ font-size: 11px; color: #a2aab5; margin-top: 5px; }}

  /* 深色底上看效果 */
  .dark {{ background: #191b1f; border-color: #2e3238; }}
  .dark .name {{ color: #e8ecf1; }}
  .dark .mood {{ color: #a3bcd6; }}
  .dark .usage {{ color: #8b939f; }}
  .dark .avatar {{
    background-image:
      linear-gradient(45deg, #22252a 25%, transparent 25%),
      linear-gradient(-45deg, #22252a 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #22252a 75%),
      linear-gradient(-45deg, transparent 75%, #22252a 75%);
  }}

  /* 实际显示尺寸 */
  .tiny-row {{
    display: flex; align-items: center; gap: 10px;
    padding: 6px 0; border-bottom: 1px solid #eceef1;
  }}
  .tiny-row img {{ width: 32px; height: 32px; border-radius: 50%; }}
  .tiny-row img:nth-child(2) {{ width: 40px; height: 40px; }}
  .tiny-row img:nth-child(3) {{ width: 56px; height: 56px; }}
</style>
</head>
<body>
  <h1>表情头像预览</h1>
  <div class="note">
    这些是**裁掉四周文字和符号后**的头像，256×256、透明背景、压缩过。<br>
    棋盘格是透明区域的示意。看两件事：<br>
    ① <b>脸有没有裁正</b>（偏上/偏下/切到脸）<br>
    ② <b>白底去干净没有</b>（边缘有没有一圈白边）<br>
    如果不对，改 <code>prepare-avatars.py</code> 里的 <code>CROPS</code> 再跑一次。
  </div>

  <h2>浅色主题下</h2>
  <div class="grid">{rows}</div>

  <h2>深色主题下</h2>
  <div class="grid">{
    rows.replace('class="item"', 'class="item dark"')
  }</div>

  <h2>实际显示尺寸</h2>
  <div>{small}</div>
</body>
</html>
"""
    with open(PREVIEW, "w", encoding="utf-8") as handle:
        handle.write(html)


if __name__ == "__main__":
    sys.exit(main())
