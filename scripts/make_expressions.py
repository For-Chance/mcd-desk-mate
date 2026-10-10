"""生成 docs/expressions.png —— 三套表情的对比图。

裁的是「头 + 肩」而不是整张立绘：表情的差别只在脸上，全身图缩到 README
宽度之后根本看不清。三张图取自同一坐标系下的素材，所以这里直接按同一
像素框裁切即可，不需要再做对齐。
"""

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
DOCS = os.path.join(ROOT, "docs")

# 画布是 600x900，头部大致落在这一带
BOX = (150, 60, 460, 430)

ITEMS = [
    ("mcn-base.png", "日常"),
    ("mcn-happy.png", "开心"),
    ("mcn-blink.png", "眨眼"),
]


def font(size):
    for name in ("msyh.ttc", "simhei.ttf"):
        path = os.path.join("C:/Windows/Fonts", name)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def main():
    crops = []
    for name, cap in ITEMS:
        im = Image.open(os.path.join(ASSETS, name)).convert("RGBA")
        crops.append((im.crop(BOX), cap))

    w, h = crops[0][0].size
    pad, lab = 14, 26
    sheet = Image.new("RGB", (w * len(crops) + pad * (len(crops) + 1), h + lab + pad * 2),
                      (24, 26, 32))
    draw = ImageDraw.Draw(sheet)
    f = font(15)

    for k, (crop, cap) in enumerate(crops):
        x = pad + k * (w + pad)
        sheet.paste(crop, (x, pad), crop)
        draw.rectangle([x, pad, x + w - 1, pad + h - 1], outline=(60, 64, 76))
        draw.text((x + 2, pad + h + 6), cap, font=f, fill=(180, 184, 196))

    out = os.path.join(DOCS, "expressions.png")
    os.makedirs(DOCS, exist_ok=True)
    sheet.save(out)
    print("saved", out, sheet.size)


if __name__ == "__main__":
    main()
