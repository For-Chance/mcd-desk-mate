"""生成中文社交平台用的竖版图文（小红书 / 微博 / 知乎封面）。

为什么不用 README 里的图
------------------------
小红书和微博的信息流是「图先于人」——用户先看图决定要不要停下。
README 里那些图是为「已经在看仓库的人」做的，字太小、信息太密。
这套图反过来：一张图只说一件事，字号按手机屏幕重新定。

尺寸取 1080x1440（3:4），这是小红书图文流里占屏比例最高的比例。

用法：
    python scripts/make_promo.py
输出到 mcd-project/promo/
"""

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(os.path.dirname(ROOT), "promo")

W, H = 1080, 1440
BG = (24, 19, 28)
BG2 = (36, 28, 42)
GOLD = (255, 188, 13)
RED = (255, 74, 66)
TXT = (246, 244, 250)
SUB = (172, 164, 186)
CARD = (44, 34, 50)

FONT_DIRS = [r"C:/Windows/Fonts", r"C:/Windows/Fonts/zh-cn"]


def font(size, bold=False):
    for name in (["msyhbd.ttc", "msyh.ttc"] if bold else ["msyh.ttc", "simhei.ttf"]):
        for d in FONT_DIRS:
            p = os.path.join(d, name)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    pass
    return ImageFont.load_default()


EMOJI_TTF = r"C:/Windows/Fonts/seguiemj.ttf"


def emoji(size):
    """彩色 emoji 必须单独用 Segoe UI Emoji + embedded_color。

    微软雅黑不含 emoji 字形，直接用它画 emoji 会得到一排「豆腐块」方框。
    """
    if os.path.exists(EMOJI_TTF):
        try:
            return ImageFont.truetype(EMOJI_TTF, size)
        except Exception:
            pass
    return font(size)


def draw_emoji(d, xy, ch, size):
    try:
        d.text(xy, ch, font=emoji(size), embedded_color=True)
    except Exception:
        d.text(xy, ch, font=emoji(size))


def base_canvas(top=BG, bottom=BG2):
    c = Image.new("RGB", (W, H), top)
    d = ImageDraw.Draw(c)
    for y in range(H):
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=(
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        ))
    return c


def glow(c, cx, cy, r, color, alpha):
    mask = Image.new("L", (r * 2, r * 2), 0)
    md = ImageDraw.Draw(mask)
    for i in range(48, 0, -1):
        rr = int(r * i / 48)
        md.ellipse((r - rr, r - rr, r + rr, r + rr),
                   fill=int(alpha * (1 - i / 48) ** 1.6))
    c.paste(Image.new("RGB", (r * 2, r * 2), color), (cx - r, cy - r), mask)


def pill(d, x, y, text, f, fill, txt_fill, padx=30, pady=14):
    tw = d.textlength(text, font=f)
    d.rounded_rectangle([x, y, x + tw + padx * 2, y + f.size + pady * 2],
                        radius=(f.size + pady * 2) // 2, fill=fill)
    d.text((x + padx, y + pady - 2), text, font=f, fill=txt_fill)
    return x + tw + padx * 2


def pet(name, height):
    im = Image.open(os.path.join(ASSETS, name)).convert("RGBA")
    w = round(im.width * height / im.height)
    return im.resize((w, height), Image.LANCZOS)


# ---------------------------------------------------------------- 图 1 封面
def sheet_cover():
    c = base_canvas((32, 20, 30), (56, 26, 40))
    glow(c, 880, 300, 460, (118, 70, 42), 104)
    glow(c, 180, 1240, 400, (104, 30, 44), 66)
    d = ImageDraw.Draw(c)

    pill(d, 74, 88, "麦当劳官方 MCP 驱动", font(30), GOLD, (42, 28, 6))

    f1 = font(96, bold=True)
    d.text((74, 196), "我把麦当劳店员", font=f1, fill=TXT)
    d.text((74, 318), "养在了电脑里", font=f1, fill=TXT)

    d.text((78, 452), "而她是真的会跳舞", font=font(48), fill=GOLD)

    d.text((80, 560), "你的券、积分、奖品", font=font(32), fill=SUB)
    d.text((80, 606), "她全都真的知道", font=font(32), fill=SUB)

    p = pet("mcn-happy.png", 900)
    c.paste(p, (W - p.width + 60, H - p.height - 150), p)

    ff = font(28)
    d.text((78, H - 92), "开源 · MIT · 完全免费", font=font(30, bold=True), fill=(200, 190, 214))
    tag = "github.com/For-Chance/mcd-desk-mate"
    d.text((W - 74 - d.textlength(tag, font=ff), H - 88), tag, font=ff, fill=(150, 132, 118))

    p_out = os.path.join(OUT, "zh-1-cover.png")
    c.save(p_out)
    print("[promo]", p_out)


# ------------------------------------------------------------ 图 2 她会做什么
def sheet_ability():
    c = base_canvas((26, 20, 30), (40, 26, 42))
    glow(c, 900, 180, 340, (110, 66, 40), 82)
    d = ImageDraw.Draw(c)

    d.text((74, 104), "她能做什么", font=font(64, bold=True), fill=TXT)
    d.text((76, 194), "数据全部来自真实账号，不是写死的假数据", font=font(28), fill=SUB)

    rows = [
        ("🐣", "转头看你", "鼠标移到哪，她的头就转到哪，身体还会跟着一点点"),
        ("💤", "打瞌睡", "75 秒不理她，她会睡着飘 z；鼠标一动就惊醒"),
        ("💃", "跳舞", "双击触发，六张姿态帧 + 节拍器，跳三轮"),
        ("🎫", "券过期提醒", "你的券快到期时，她飘一个红色感叹号"),
        ("🎰", "积分扭蛋", "用真实积分抽奖，调用前必须你点头确认"),
        ("🎯", "猜热量", "从 160 条官方营养数据里出题，差值卡在 20~220 千卡"),
    ]

    y = 268
    for ico, title, desc in rows:
        d.rounded_rectangle([74, y, W - 74, y + 158], radius=22, fill=CARD)
        draw_emoji(d, (104, y + 30), ico, 52)
        d.text((188, y + 28), title, font=font(38, bold=True), fill=GOLD)
        d.text((188, y + 84), desc, font=font(26), fill=SUB)
        y += 178

    p_out = os.path.join(OUT, "zh-2-ability.png")
    c.save(p_out)
    print("[promo]", p_out)


# ---------------------------------------------------- 图 3 为什么她会跳舞
def sheet_dance():
    c = base_canvas((26, 20, 30), (42, 26, 40))
    d = ImageDraw.Draw(c)

    d.text((74, 104), "为什么她「会跳舞」", font=font(62, bold=True), fill=TXT)
    d.text((76, 190), "分层变形做不到抬手扭腰，只能换一整套关键帧", font=font(28), fill=SUB)

    ids = [("base", "待机"), ("d1", "挥手"), ("d2", "跳跃"), ("d3", "比心"),
           ("d4", "指天"), ("d5", "展臂"), ("d6", "屈膝")]

    gap = 16
    per_row = 4
    avail = W - 74 * 2
    cell_w = (avail - gap * (per_row - 1)) // per_row
    cell_h = int(cell_w / (600 / 900))
    x0, y0 = 74, 262
    row_h = cell_h + 74

    for k, (fid, cap) in enumerate(ids):
        r, cidx = divmod(k, per_row)
        n_in_row = per_row if r == 0 else len(ids) - per_row
        row_w = n_in_row * cell_w + (n_in_row - 1) * gap
        rx = (W - row_w) // 2 if r else x0
        x = rx + cidx * (cell_w + gap)
        y = y0 + r * row_h
        cell = Image.new("RGB", (cell_w, cell_h), (246, 247, 250))
        im = Image.open(os.path.join(ASSETS, f"mcn-{fid}.png")).convert("RGBA")
        im = im.resize((cell_w, cell_h), Image.LANCZOS)
        cell.paste(im, (0, 0), im)
        c.paste(cell, (x, y))
        d.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=(80, 84, 98))
        if fid != "base":
            d.rectangle([x, y, x + cell_w - 1, y + 5], fill=RED)
        d.text((x + 4, y + cell_h + 12), cap, font=font(27, bold=True), fill=TXT)

    yy = y0 + 2 * row_h + 8
    d.rounded_rectangle([74, yy, W - 74, yy + 244], radius=22, fill=CARD)
    d.text((104, yy + 30), "六帧共用同一套坐标系", font=font(34, bold=True), fill=GOLD)
    d.text((104, yy + 92), "水平 → 红帽质心（包围盒会被挥手的手臂撑歪）",
           font=font(26), fill=(214, 206, 226))
    d.text((104, yy + 140), "垂直 → 鞋底共线（人才是钉在地上的）",
           font=font(26), fill=(214, 206, 226))
    d.text((104, yy + 188), "尺度 → alpha 轮廓归一（红色阈值会误判）",
           font=font(26), fill=(214, 206, 226))

    p_out = os.path.join(OUT, "zh-3-dance.png")
    c.save(p_out)
    print("[promo]", p_out)


# ---------------------------------------------------------------- 图 4 怎么用
def sheet_start():
    c = base_canvas((26, 20, 30), (44, 26, 40))
    glow(c, 540, 900, 420, (110, 66, 40), 74)
    d = ImageDraw.Draw(c)

    d.text((74, 104), "怎么用", font=font(64, bold=True), fill=TXT)
    d.text((76, 194), "需要 Node.js 和一个麦当劳 MCP Token（免费申请）", font=font(28), fill=SUB)

    steps = [
        ("1", "克隆仓库", "git clone github.com/For-Chance/mcd-desk-mate"),
        ("2", "装依赖", "npm install"),
        ("3", "填 Token", "去 open.mcd.cn 免费申请，写进环境变量"),
        ("4", "让她上岗", "npm start"),
    ]
    y = 268
    for n, title, cmd in steps:
        d.rounded_rectangle([74, y, W - 74, y + 132], radius=20, fill=CARD)
        d.ellipse([106, y + 40, 158, y + 92], fill=GOLD)
        d.text((124, y + 48), n, font=font(32, bold=True), fill=(42, 28, 6))
        d.text((186, y + 26), title, font=font(36, bold=True), fill=TXT)
        d.text((186, y + 78), cmd, font=font(23), fill=SUB)
        y += 150

    # 二维码
    qr_path = os.path.join(OUT, "_qr.png")
    if os.path.exists(qr_path):
        qr = Image.open(qr_path).convert("RGB").resize((248, 248), Image.NEAREST)
        card = Image.new("RGB", (300, 360), (246, 247, 250))
        card.paste(qr, (26, 26))
        d2 = ImageDraw.Draw(card)
        d2.text((30, 292), "扫码去 GitHub", font=font(30, bold=True), fill=(30, 26, 36))
        c.paste(card, (74, y + 26))
        tx = 420
    else:
        tx = 74

    d.text((tx, y + 56), "github.com/", font=font(32, bold=True), fill=TXT)
    d.text((tx, y + 104), "For-Chance/mcd-desk-mate", font=font(32, bold=True), fill=GOLD)
    d.text((tx, y + 168), "MIT 开源 · 欢迎 Star ★", font=font(30), fill=SUB)
    d.text((tx, y + 216), "角色为原创设计，未使用麦当劳商标", font=font(22), fill=(140, 132, 156))

    p_out = os.path.join(OUT, "zh-4-start.png")
    c.save(p_out)
    print("[promo]", p_out)


def main():
    os.makedirs(OUT, exist_ok=True)
    sheet_cover()
    sheet_ability()
    sheet_dance()
    sheet_start()


if __name__ == "__main__":
    main()
