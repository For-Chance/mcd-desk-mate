"""为在线试玩页生成 web 版素材帧。

为什么不直接引用 assets/
------------------------
GitHub Pages 只发布 docs/ 目录，页面够不到仓库根下的 assets/。
而复制原图（每帧 300~370KB，共 9 帧）会让 docs/ 体积翻倍。
这里把帧缩到 400x600 再存，单帧降到约 1/3，页面加载快，肉眼无差别
（试玩页上她最多也就显示到 400px 宽）。

用法：
    python scripts/make_webdemo.py
输出到 docs/web/
"""

import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "docs", "web")

FRAMES = ["base", "blink", "happy", "d1", "d2", "d3", "d4", "d5", "d6"]
W, H = 400, 600


def main():
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for fid in FRAMES:
        src = os.path.join(ASSETS, f"mcn-{fid}.png")
        if not os.path.exists(src):
            print("[web] 跳过（不存在）", src)
            continue
        im = Image.open(src).convert("RGBA").resize((W, H), Image.LANCZOS)
        dst = os.path.join(OUT, f"mcn-{fid}.png")
        im.save(dst, optimize=True)
        kb = os.path.getsize(dst) // 1024
        total += kb
        print(f"[web] {fid:<6} {kb:>5} KB  {os.path.relpath(dst, ROOT)}")
    print(f"[web] 合计 {total} KB → {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
