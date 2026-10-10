"""生成 README 展示素材。

1. docs/life.gif   —— 立绘的注视 / 眨眼 / 呼吸循环，直接复用渲染层的分层裁剪比例
2. docs/play.png   —— 四个玩法面板拼图

分层比例必须和 src/renderer/style.css 里的 clip-path 保持一致，
否则素材展示的就不是应用里真实的样子。
"""

import math
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = r"D:/Chance/Projects/mcd-project/mcd-desk-mate"
ASSETS = f"{ROOT}/assets"
SELFTEST = f"{ROOT}/.selftest"
DOCS = f"{ROOT}/docs"

# 与 style.css 的 clip-path 对齐
HEAD_BOTTOM = 0.30
BODY_TOP, BODY_BOTTOM = 0.27, 0.64
LEGS_TOP = 0.62
HEAD_ORIGIN_Y = 0.28

GIF_W, GIF_H = 300, 452
PAD = 60


def font(size, bold=False):
    for name in (["msyhbd.ttc", "msyh.ttc", "simhei.ttf"] if bold else ["msyh.ttc", "simhei.ttf"]):
        for base in (r"C:/Windows/Fonts", r"C:/Windows/Fonts/zh-cn"):
            p = os.path.join(base, name)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    pass
    return ImageFont.load_default()


def place(canvas, src, box, origin, sx, sy, dx, dy):
    """把 src 的一块区域按「绕 origin 缩放 + 平移」贴到 canvas 上。

    直接 resize 会让整块区域的位置漂移，所以这里反推粘贴左上角，
    保证 origin 那个点在世界坐标里保持不动 —— 与 CSS 的 transform-origin 语义一致。
    """
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    ox, oy = origin
    rx = (ox - x0) / w
    ry = (oy - y0) / h

    nw = max(1, int(round(w * sx)))
    nh = max(1, int(round(h * sy)))
    piece = src.crop(box).resize((nw, nh), Image.LANCZOS)

    px = ox + dx - rx * nw
    py = oy + dy - ry * nh
    canvas.alpha_composite(piece, (int(round(px + PAD)), int(round(py + PAD))))


def build_gif():
    base = Image.open(f"{ASSETS}/mcn-base.png").convert("RGBA")
    blink = Image.open(f"{ASSETS}/mcn-blink.png").convert("RGBA")
    happy = Image.open(f"{ASSETS}/mcn-happy.png").convert("RGBA")

    # 统一到同一尺寸，避免两张差分图有 1px 差异造成抖动
    if blink.size != base.size:
        blink = blink.resize(base.size, Image.LANCZOS)
    if happy.size != base.size:
        happy = happy.resize(base.size, Image.LANCZOS)

    W, H = base.size
    scale = GIF_H / H
    anim_w = int(round(W * scale))

    TARGET = (anim_w, GIF_H)
    base_s = base.resize(TARGET, Image.LANCZOS)
    blink_s = blink.resize(TARGET, Image.LANCZOS)
    happy_s = happy.resize(TARGET, Image.LANCZOS)

    w, h = TARGET
    head_box = (0, 0, w, int(h * HEAD_BOTTOM))
    body_box = (0, int(h * BODY_TOP), w, int(h * BODY_BOTTOM))
    legs_box = (0, int(h * LEGS_TOP), w, h)
    head_origin = (w / 2, h * HEAD_ORIGIN_Y)

    frames = []
    N = 24
    for i in range(N):
        t = i / N
        # 注视：一次完整的左看 → 右看 → 回正
        gx = math.sin(2 * math.pi * t) * 0.92
        gy = math.sin(4 * math.pi * t) * 0.22
        # 呼吸
        breath = math.sin(2 * math.pi * t * 2)
        bob = -breath * 4.0

        # 表情：第 20~21 帧眨眼；第 5~7 帧笑一下
        if i in (20, 21):
            src = blink_s
        elif i in (5, 6, 7):
            src = happy_s
        else:
            src = base_s

        canvas = Image.new("RGBA", (w + PAD * 2, h + PAD * 2), (0, 0, 0, 0))

        # 下身几乎不动
        place(canvas, src, legs_box, (w / 2, h), 1.0, 1.0, 0, bob * 0.25)
        # 上身跟随一点点
        place(canvas, src, body_box, (w / 2, h * 0.66), 1.0 + abs(gx) * 0.012, 1.0 - breath * 0.010, gx * 2.2, bob * 0.5)
        # 头部承担主要转向：横向位移 + 视觉压缩，模拟转头
        place(canvas, src, head_box, head_origin,
              1.0 - abs(gx) * 0.085, 1.0,
              gx * 7.5, gy * 3.2 + bob * 0.55)

        canvas = canvas.crop((PAD - 6, PAD - 4, PAD + w + 6, PAD + h + 6))
        frames.append(canvas)

    # 桌面感的浅色底：GIF 的 1-bit 透明会把边缘啃出锯齿，垫层底色反而更传神。
    # 底色必须是纯色 —— 渐变会在每帧引入大量噪声，LZW 压缩率崩掉，体积翻倍。
    out = []
    for f in frames:
        bg = Image.new("RGBA", f.size, (246, 247, 250, 255))
        bg.alpha_composite(f)
        out.append(bg.convert("P", palette=Image.ADAPTIVE, colors=128))

    os.makedirs(DOCS, exist_ok=True)
    gif = f"{DOCS}/life.gif"
    # disposal=1（保留上一帧）配合 optimize，Pillow 才会做帧间差分，
    # 只编码变化的那一块。用 disposal=2 会强制每帧独立全量编码，体积直接翻几倍。
    out[0].save(gif, save_all=True, append_images=out[1:], duration=85, loop=0,
                optimize=True, disposal=1)
    print("saved", gif, os.path.getsize(gif) // 1024, "KB", "frames", len(out))
    return gif


def build_play():
    """四个面板截图 2x2 拼图。"""
    shots = [
        ("panel-gacha.png", "扭蛋机 · 真实积分抽奖"),
        ("panel-collection.png", "节气收藏册 · 6/24"),
        ("panel-feed.png", "投喂 · 真实营养数据"),
        ("panel-quiz.png", "猜热量 · 官方营养表出题"),
    ]
    imgs = []
    for name, cap in shots:
        p = f"{SELFTEST}/{name}"
        if not os.path.exists(p):
            print("skip missing", p)
            continue
        imgs.append((Image.open(p).convert("RGB"), cap))

    if not imgs:
        return None

    cell_w = 372
    ratio = imgs[0][0].height / imgs[0][0].width
    cell_h = int(cell_w * ratio)
    gap = 14
    pad = 20
    cols, rows = 2, 2
    W = pad * 2 + cell_w * cols + gap * (cols - 1)
    H = pad * 2 + (cell_h + 26) * rows + gap * (rows - 1)

    canvas = Image.new("RGB", (W, H), (20, 20, 26))
    d = ImageDraw.Draw(canvas)
    f = font(14)

    for idx, (im, cap) in enumerate(imgs[:4]):
        r, c = divmod(idx, cols)
        x = pad + c * (cell_w + gap)
        y = pad + r * (cell_h + 26 + gap)
        canvas.paste(im.resize((cell_w, cell_h), Image.LANCZOS), (x, y))
        d.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=(60, 60, 70))
        d.text((x + 2, y + cell_h + 4), cap, font=f, fill=(150, 150, 160))

    out = f"{DOCS}/play.png"
    os.makedirs(DOCS, exist_ok=True)
    canvas.save(out)
    print("saved", out, canvas.size)
    return out


def build_desktop():
    """把透明的桌宠窗口合成到一张模拟桌面上。

    这张图要回答的是「她到底会不会挡我干活」：
    所以画布上必须有一个真正的应用窗口，而她只是安静地站在角落。
    """
    shot_path = f"{SELFTEST}/shot.png"
    if not os.path.exists(shot_path):
        print("skip desktop: 缺少 .selftest/shot.png")
        return None

    pet = Image.open(shot_path).convert("RGBA")

    # 桌宠窗口是 320x600，画布要留出任务栏 + 窗口高度，否则她的脚会被任务栏压掉
    W, H = 1000, 700
    bar_h = 44
    desk = Image.new("RGB", (W, H), (14, 18, 34))
    d = ImageDraw.Draw(desk)

    # 壁纸：深海蓝的竖向渐变
    for y in range(H):
        k = y / H
        d.line([(0, y), (W, y)], fill=(int(18 + k * 16), int(22 + k * 12), int(40 + k * 20)))

    # 左侧一个「正在被使用」的文档窗口 —— 证明桌面没有被挡住
    wx, wy, ww, wh = 54, 58, 560, 430
    d.rounded_rectangle([wx, wy, wx + ww, wy + wh], radius=10, fill=(30, 32, 42), outline=(58, 62, 78))
    d.rounded_rectangle([wx, wy, wx + ww, wy + 34], radius=10, fill=(40, 43, 56))
    for i, c in enumerate([(232, 92, 80), (238, 190, 72), (98, 200, 118)]):
        d.ellipse([wx + 14 + i * 18, wy + 13, wx + 24 + i * 18, wy + 23], fill=c)

    f = font(13)
    f_title = font(14, bold=True)
    d.text((wx + 18, wy + 54), "季度复盘 · 草稿", font=f_title, fill=(196, 200, 214))
    for i in range(9):
        y = wy + 86 + i * 24
        width = int(ww * (0.86 if i % 3 else 0.62))
        d.rounded_rectangle([wx + 18, y, wx + 18 + width, y + 9], radius=4, fill=(54, 58, 72))
    d.rounded_rectangle([wx + 18, wy + 86 + 10 * 24, wx + 18 + int(ww * 0.4), wy + 86 + 10 * 24 + 9],
                        radius=4, fill=(64, 70, 92))

    # 任务栏
    d.rectangle([0, H - bar_h, W, H], fill=(16, 18, 27))
    d.line([(0, H - bar_h), (W, H - bar_h)], fill=(44, 47, 60))
    for i in range(5):
        x = 24 + i * 38
        d.rounded_rectangle([x, H - bar_h + 9, x + 26, H - 9], radius=6, fill=(46, 50, 66))
    d.text((W - 74, H - bar_h + 15), "22:41", font=f, fill=(150, 154, 168))

    # 她贴在右下角：桌宠窗口在真实运行时就是 320x600 的透明窗口
    px = W - pet.width - 16
    py = H - bar_h - pet.height
    desk = desk.convert("RGBA")
    desk.alpha_composite(pet, (max(0, px), max(0, py)))

    out = f"{DOCS}/preview.png"
    os.makedirs(DOCS, exist_ok=True)
    desk.convert("RGB").save(out)
    print("saved", out, desk.size)
    return out


def build_dance():
    """把自测连拍的舞蹈帧拼成 docs/dance.gif。

    刻意不用「合成」的方式造这段动画 —— 这些就是应用真实运行时逐拍截下来的
    窗口，换帧、位移、力度全都在里面。素材本身就是证据链，造一遍反而不算数。
    """
    shots = sorted(
        f for f in os.listdir(SELFTEST) if f.startswith("dance-") and f.endswith(".png")
    ) if os.path.isdir(SELFTEST) else []
    if len(shots) < 4:
        print("skip dance: 缺少 .selftest/dance-*.png（用 MCD_SELFTEST_DANCE=1 跑一次）")
        return None

    frames = []
    for name in shots:
        im = Image.open(f"{SELFTEST}/{name}").convert("RGBA")
        # 桌宠窗口 320x600，角色贴在下半部；只截她所在的那块
        box = (0, 118, im.width, im.height)
        crop = im.crop(box)
        # 与 life.gif 同样的浅色底：1-bit 透明会把边缘啃出锯齿
        bg = Image.new("RGBA", (crop.width, crop.height), (246, 247, 250, 255))
        bg.alpha_composite(crop)
        frames.append(bg)

    out = [f.convert("P", palette=Image.ADAPTIVE, colors=128) for f in frames]
    gif = f"{DOCS}/dance.gif"
    os.makedirs(DOCS, exist_ok=True)
    out[0].save(gif, save_all=True, append_images=out[1:], duration=430, loop=0,
                optimize=True, disposal=1)
    print("saved", gif, os.path.getsize(gif) // 1024, "KB", "frames", len(out))
    return gif


if __name__ == "__main__":
    build_gif()
    build_dance()
    build_play()
    build_desktop()
