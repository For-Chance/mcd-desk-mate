"""生成 README 展示素材。

1. docs/life.gif          —— 立绘的注视 / 眨眼 / 呼吸循环，直接复用渲染层的分层裁剪比例
2. docs/dance.gif         —— 应用真实运行时按节拍截下来的舞蹈
3. docs/dance-frames.png  —— 六张姿态帧序列（说明「舞蹈靠换素材，不靠变形」）
4. docs/layers.png        —— 三层立绘分层原理图
5. docs/play.png          —— 四个玩法面板拼图
6. docs/preview.png       —— 合成到模拟桌面上的效果图
7. docs/settings.png      —— 设置窗口

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
        # .selftest 是临时目录，会被清掉；docs 里留着上一轮回灌的正式素材
        p = next((q for q in (f"{SELFTEST}/{name}", f"{DOCS}/{name}") if os.path.exists(q)), None)
        if not p:
            print("skip missing", name)
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


DANCE_SEQ = [
    ("base", "待机"),
    ("d1", "挥手"),
    ("d2", "跳跃"),
    ("d3", "比心"),
    ("d4", "指天"),
    ("d5", "展臂"),
    ("d6", "屈膝"),
]


def build_banner():
    """README 顶部的横向主视觉。"""
    W, H = 1200, 420
    canvas = Image.new("RGB", (W, H), (16, 18, 30))
    d = ImageDraw.Draw(canvas)

    # 斜向渐变 + 右上角一抹红，避免大块纯色显得死
    for y in range(H):
        k = y / H
        d.line([(0, y), (W, y)], fill=(int(15 + k * 14), int(17 + k * 8), int(28 + k * 10)))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r in range(300, 0, -6):
        a = (1 - r / 300) ** 2
        gd.ellipse([W - 200 - r, -60 - r * 0.6, W - 200 + r, -60 + r * 0.6],
                   fill=(int(120 * a), int(20 * a), int(18 * a)))
    canvas = Image.blend(canvas, glow, 0.55)
    d = ImageDraw.Draw(canvas)

    # 右侧：立绘贴底
    pet = Image.open(f"{ASSETS}/mcn-base.png").convert("RGBA")
    ph = 470
    ps = ph / pet.height
    pet = pet.resize((int(round(pet.width * ps)), ph), Image.LANCZOS)
    px = W - pet.width - 60
    canvas.paste(pet, (px, H - ph + 40), pet)

    # 左侧：文案
    d.text((64, 78), "麦娘桌面", font=font(30, bold=True), fill=(214, 48, 42))
    d.text((64, 118), "McDesk", font=font(62, bold=True), fill=(244, 245, 250))
    d.text((66, 200), "住在你桌面上的二次元麦当劳店员", font=font(24, bold=True), fill=(206, 210, 222))

    tags = ["真实 MCP 驱动", "35 个 Tool", "会跳舞", "不挡你干活"]
    x = 66
    for t in tags:
        tw = d.textlength(t, font=font(13))
        d.rounded_rectangle([x, 248, x + tw + 22, 278], radius=15,
                            fill=(38, 40, 54), outline=(72, 62, 66))
        d.text((x + 11, 256), t, font=font(13), fill=(232, 168, 150))
        x += tw + 32

    d.text((66, 306), "券要过期了，她会比你先急。", font=font(15), fill=(150, 156, 172))

    out = f"{DOCS}/banner.png"
    os.makedirs(DOCS, exist_ok=True)
    canvas.save(out)
    print("saved", out, canvas.size)
    return out


def build_dance_frames():
    """六张姿态帧序列图。

    这张图要一次性说明「舞蹈为什么必须换素材」：七张图的取景、站位、
    地面线完全一致，只有姿态在变 —— 分层 transform 做不到的正是这一点。
    """
    items = []
    for fid, cap in DANCE_SEQ:
        p = f"{ASSETS}/mcn-{fid}.png"
        if not os.path.exists(p):
            print("skip dance-frames: 缺少", p)
            return None
        items.append((Image.open(p).convert("RGBA"), fid, cap))

    cell_h = 300
    ratio = items[0][0].width / items[0][0].height
    cell_w = int(round(cell_h * ratio))
    gap, pad = 10, 18
    head_h, label_h = 40, 32

    W = pad * 2 + cell_w * len(items) + gap * (len(items) - 1)
    H = pad * 2 + head_h + cell_h + label_h
    canvas = Image.new("RGB", (W, H), (22, 24, 30))
    d = ImageDraw.Draw(canvas)

    d.text((pad, pad - 2), "六张姿态帧 + 一个节拍器", font=font(17, bold=True), fill=(238, 240, 246))
    d.text((pad + 232, pad + 4), f"每 430ms 换一帧（约 140 BPM），8 拍一循环", font=font(12), fill=(140, 146, 160))

    for k, (im, fid, cap) in enumerate(items):
        x = pad + k * (cell_w + gap)
        y = pad + head_h
        cell = Image.new("RGB", (cell_w, cell_h), (246, 247, 250))
        cell.paste(im.resize((cell_w, cell_h), Image.LANCZOS), (0, 0), im.resize((cell_w, cell_h), Image.LANCZOS))
        canvas.paste(cell, (x, y))
        d.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=(70, 74, 88))
        if fid != "base":
            d.rectangle([x, y, x + cell_w - 1, y + 2], fill=(214, 48, 42))
        d.text((x + 2, y + cell_h + 6), f"{fid}  {cap}", font=font(13), fill=(168, 174, 188))

    out = f"{DOCS}/dance-frames.png"
    os.makedirs(DOCS, exist_ok=True)
    canvas.save(out)
    print("saved", out, canvas.size)
    return out


def build_layers():
    """分层原理图：一张立绘被切成三层，各自独立变换。

    左边是完整立绘叠上两条真实的 clip-path 分界线；
    右边三层被拆开单放，每层标注它在注视跟随里承担的幅度。
    比例取自 style.css，不另画一套。
    """
    src = Image.open(f"{ASSETS}/mcn-base.png").convert("RGBA")
    body_h = 460
    s = body_h / src.height
    img_w, img_h = int(round(src.width * s)), body_h
    img = src.resize((img_w, img_h), Image.LANCZOS)

    LAYERS = [
        (0.00, 0.30, "头", "承担主要转向", "inset(0 0 70% 0)"),
        (0.27, 0.64, "上身", "跟随一点点", "inset(27% 0 36% 0)"),
        (0.62, 1.00, "下身", "几乎不动", "inset(62% 0 0 0)"),
    ]

    pad, gap = 22, 16
    cell_pad = 8
    col_w = img_w + cell_pad * 2
    head_h, label_h = 62, 46
    W = pad * 2 + col_w + gap + (col_w + gap) * 3
    H = pad * 2 + head_h + img_h + label_h
    canvas = Image.new("RGB", (W, H), (22, 24, 30))
    d = ImageDraw.Draw(canvas)

    d.text((pad, pad - 4), "一张立绘，三层独立变换",
           font=font(19, bold=True), fill=(238, 240, 246))
    d.text((pad, pad + 26), "没有骨骼、没有额外素材，只用 CSS clip-path + 各自的 transform——"
                           "幅度差拉开了，看起来才像脖子在转，而不是整块板子在晃。",
           font=font(12), fill=(140, 146, 160))

    y0 = pad + head_h
    x0 = pad
    bg = Image.new("RGB", (col_w, img_h), (246, 247, 250))
    bg.paste(img, (cell_pad, 0), img)
    canvas.paste(bg, (x0, y0))
    d.rectangle([x0, y0, x0 + col_w - 1, y0 + img_h - 1], outline=(70, 74, 88))

    # 两条真实的分界虚线 + 区间括号
    for top, bottom, name, _, _ in LAYERS:
        for frac, color in ((top, (214, 48, 42)), (bottom, (214, 48, 42))):
            yy = y0 + int(img_h * frac)
            for xx in range(x0, x0 + col_w, 8):
                d.line([(xx, yy), (xx + 4, yy)], fill=color, width=2)
        ty = y0 + int(img_h * (top + bottom) / 2) - 9
        d.text((x0 + cell_pad + 6, ty), name, font=font(15, bold=True), fill=(214, 48, 42))
    d.text((x0 + 2, y0 + img_h + 10), "完整立绘 · 虚线是真实的分界位置",
           font=font(12), fill=(168, 174, 188))

    # 三层拆开单放
    for k, (top, bottom, name, role, clip) in enumerate(LAYERS):
        x = x0 + col_w + gap + k * (col_w + gap)
        piece = src.crop((0, int(src.height * top), src.width, int(src.height * bottom)))
        piece = piece.resize((img_w, int(round(img_h * (bottom - top)))), Image.LANCZOS)

        cell = Image.new("RGB", (col_w, img_h), (246, 247, 250))
        cell.paste(piece, (cell_pad, int(round(img_h * top))), piece)
        canvas.paste(cell, (x, y0))
        d.rectangle([x, y0, x + col_w - 1, y0 + img_h - 1], outline=(70, 74, 88))

        # 只保留该层，其余压暗 —— 让「这一层是这块」一目了然
        dark = Image.new("RGB", (col_w, img_h), (246, 247, 250))
        dim = Image.new("RGB", img.size, (232, 233, 238))
        dark.paste(dim, (cell_pad, 0))
        dark.paste(piece, (cell_pad, int(round(img_h * top))), piece)
        canvas.paste(dark, (x, y0))

        d.rectangle([x, y0, x + col_w - 1, y0 + 2], fill=(214, 48, 42))
        d.text((x + 2, y0 + img_h + 6), f"{name} · {role}", font=font(14, bold=True), fill=(238, 240, 246))
        d.text((x + 2, y0 + img_h + 26), clip, font=font(12), fill=(140, 146, 160))

    out = f"{DOCS}/layers.png"
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
    build_dance_frames()
    build_layers()
    build_play()
    build_desktop()
