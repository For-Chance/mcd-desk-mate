"""生成社交分享卡片图（GitHub Social Preview / Open Graph）。

为什么单独做这张图
--------------------
仓库 README 是「点进来之后」才看到的，而这个项目的 Star 绝大部分要靠
**分享出去**——微信、微博、X、Slack、Discord、掘金、V2EX。那些地方显示的
不是 README，是一张 1280x640 的卡片图。这张图决定了别人在信息流里是划走
还是点进去，所以它的信息密度和对比度必须比 README 首屏更高。

设计约束：它会在微信里被缩到很小（约 200x100），所以
  * 只保留一个视觉主体（角色）和一句标题，其他一律砍掉；
  * 文字必须够大够粗，缩略后还能读出「麦娘」两个字；
  * 用高对比配色，避免浅灰底浅字在信息流里糊成一片。

中英两版都要出：中文版给 GitHub 的 Social Preview 和国内渠道，英文版给
X / Reddit / Hacker News —— 英文渠道配一张中文卡片，点进来的人会走掉。

用法：
    python scripts/make_social.py
"""

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
ASSETS = os.path.join(ROOT, "assets")

W, H = 1280, 640

BG_TOP = (28, 22, 30)        # 深紫黑，让角色和黄色都跳出来
BG_BOT = (48, 30, 44)
ACCENT = (255, 188, 13)      # 麦当劳金
TXT = (255, 255, 255)
SUB = (196, 190, 208)

LANG = {
    "zh": {
        "out": "social.png",
        "badge": "麦当劳 MCP 真实驱动",
        "title": "麦娘桌面",
        "sub": "住在你桌面上的",
        "sub2": "二次元麦当劳店员",
        "tags": ["会呼吸 · 会眨眼 · 会转头看你", "双击就跳舞", "券快过期了她先急"],
        "foot": "Real McDonald's MCP · 35 tools · Electron",
        "title_size": 96,
    },
    "en": {
        "out": "social-en.png",
        "badge": "Driven by McDonald's real MCP",
        "title": "McDesk",
        "sub": "An anime McDonald's crew member",
        "sub2": "who lives on your desktop",
        "tags": ["Breathes · blinks · follows your cursor",
                 "Dances on double-click",
                 "Warns you before coupons expire"],
        "foot": "35 MCP tools · MIT · Electron",
        "title_size": 104,
    },
}


def font(size, bold=False):
    names = ["msyhbd.ttc", "msyh.ttc"] if bold else ["msyh.ttc", "simhei.ttf"]
    for n in names:
        p = os.path.join("C:/Windows/Fonts", n)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def vgrad(w, h, top, bot):
    g = Image.new("RGB", (w, h), top)
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line(
            [(0, y), (w, y)],
            fill=(
                round(top[0] + (bot[0] - top[0]) * t),
                round(top[1] + (bot[1] - top[1]) * t),
                round(top[2] + (bot[2] - top[2]) * t),
            ),
        )
    return g


def glow(card, cx, cy, r, color, alpha):
    """径向渐变光斑。

    不能用「一张纯色矩形 + 一个 L 掩码」直接 paste——那样掩码外的矩形边界
    在深色背景上会显出一条硬边。必须逐圈画同心圆做出真正的径向衰减。
    """
    mask = Image.new("L", (r * 2, r * 2), 0)
    md = ImageDraw.Draw(mask)
    steps = 48
    for i in range(steps, 0, -1):
        rr = int(r * i / steps)
        a = int(alpha * (1 - i / steps) ** 1.6)
        md.ellipse((r - rr, r - rr, r + rr, r + rr), fill=a)
    layer = Image.new("RGB", (r * 2, r * 2), color)
    card.paste(layer, (cx - r, cy - r), mask)


def build(lang):
    cfg = LANG[lang]
    card = vgrad(W, H, BG_TOP, BG_BOT)
    d = ImageDraw.Draw(card)

    # 背景光斑：右上角一团暖光，把视线往角色和标题之间带
    glow(card, W - 300, 120, 340, (96, 62, 40), 78)
    glow(card, W - 380, 90, 200, (140, 90, 50), 52)

    x = 72
    f_brand = font(34)
    f_title = font(cfg["title_size"], bold=True)
    f_sub = font(38)
    f_hook = font(30)

    bw = int(d.textlength(cfg["badge"], font=f_brand)) + 52
    d.rounded_rectangle([x, 92, x + bw, 146], radius=27, fill=ACCENT)
    d.text((x + 26, 100), cfg["badge"], font=f_brand, fill=(38, 26, 10))

    d.text((x, 176), cfg["title"], font=f_title, fill=TXT)
    tw = d.textlength(cfg["title"], font=f_title)
    if lang == "zh":
        d.text((x + tw + 18, 210), "McDesk", font=font(52, bold=True), fill=ACCENT)

    d.text((x, 300), cfg["sub"], font=f_sub, fill=SUB)
    d.text((x, 348), cfg["sub2"], font=f_sub, fill=TXT)

    # 底部标签——缩略图里看不清没关系，点开前放大时会读到。
    # 必须做换行：英文标签比中文长得多，一行铺过去会被右侧立绘压住。
    ty = 420
    tx = x
    ft = font(26)
    limit = 860                    # 立绘从 x≈934 起，标签留出安全距离
    for t in cfg["tags"]:
        w = int(d.textlength(t, font=ft)) + 32
        if tx > x and tx + w > x + limit:
            tx = x
            ty += 58
        d.rounded_rectangle([tx, ty, tx + w, ty + 48], radius=24, fill=(70, 52, 66))
        d.text((tx + 16, ty + 10), t, font=ft, fill=(232, 226, 240))
        tx += w + 14

    d.text((x, 548), cfg["foot"], font=f_hook, fill=(150, 142, 164))

    # 右侧：角色（贴底站立，略出血制造「从画面外走进来」的感觉）
    pet = Image.open(os.path.join(ASSETS, "mcn-happy.png")).convert("RGBA")
    ph = 600
    pw = round(pet.width * ph / pet.height)
    pet = pet.resize((pw, ph), Image.LANCZOS)
    card.paste(pet, (W - pw + 54, H - ph + 34), pet)

    out = os.path.join(DOCS, cfg["out"])
    card.save(out)
    print(f"[social] {out}  {card.size}")


def main():
    build("zh")
    build("en")


if __name__ == "__main__":
    main()
