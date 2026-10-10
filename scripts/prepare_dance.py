#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
舞蹈帧素材管线：抠图 → 统一缩放 → 帽锚水平对齐 + 鞋底贴地 → 合成统一画布。

两条对齐规则（都是踩过坑才定下来的）
--------------------------------------------------
**水平用红帽质心。** 一开始想当然地用包围盒居中，实测是错的：

  * 她的双马尾会垂到画面底部，包围盒底往往是**头发**而不是脚；
  * 挥手 / 展臂帧的手臂把包围盒横向拉宽，居中后整个角色被推走；
  * 早期版本里还有帧根本没画到脚（半身构图），「脚底」其实是画幅边界。

每帧都稳定存在的特征只有一个：**那顶红色鸭舌帽**。头在中间，手臂腿怎么
摆横向都不会漂。而且不能用「最上面的红像素」——d1 在 y=40 有孤立噪点，
单靠它会把锚点算到 x=307（正确值约 510），整张图就歪了。所以改成逐行统计
红色像素数，取顶部第一段高密度行区间当帽子本体。

**垂直用鞋底贴地。** 所有帧的脚踩同一条地面线，这样切帧时人是钉在地上的，
只有姿态在变。跳跃帧原本悬空，贴地后会把「离地」吃掉 —— 所以脚本把每帧
原始的离地高度写进 assets/dance.json，交给编排层用 translateY 还原。
跳跃是**动作**，不该用取景差异来表达，否则素材一换就没了。

画布与缩放
--------------------------------------------------
八帧（base/blink/happy + d1..d6）共用同一画布 600x900 与同一 scale，
这样表情切换、舞蹈切帧时角色纹丝不动。scale 同时受高度和宽度约束：
取「人物形象最高」与「手臂伸得最开」两个条件里更严的那个，宁可人小一点，
也不能把挥出去的手裁掉。

用法：
    python scripts/prepare_dance.py            # 生成全部帧 + dance.json
    python scripts/prepare_dance.py --measure  # 只打印锚点分布，不写文件
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cutout as ct  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "assets", "raw")
ASSETS = os.path.join(ROOT, "assets")

# 与既有 mcn-base.png 完全一致，这样 style.css 的 clip-path 分层不用动
CANVAS_W = 600
CANVAS_H = 900
CROP_PAD = 8
EDGE_MARGIN = 6

BASE = "base"

# 全部帧：d1..d6 是六个舞蹈关键姿态，base/blink/happy 是待机表情。
# 八帧走同一条管线，坐标系统一后才不会切帧抖动。
#
# 早期版本的 base/blink/happy 是「头到裙摆」的半身特写（画面里根本没有脚），
# 而 d1..d6 是全身 —— 两者的取景根本对不上，没法共用一条地面线。所以这三个
# 待机帧已按 d1 的全身取景重新生成（见 BG_MODE 说明）。
FRAMES = {
    "base": "mcn-idle-raw.png",        # 全身站立（基准）
    "blink": "mcn-idle-blink-raw.png",  # 同姿态，闭眼
    "happy": "mcn-idle-happy-raw.png",  # 同姿态，大笑
    "d1": "mcn-d1-raw.png",            # 举手挥手
    "d2": "mcn-d2-raw.png",            # 跳跃 V 字（悬空）
    "d3": "mcn-d3-raw.png",            # 胸前比心
    "d4": "mcn-d4b-raw.png",           # 扭腰指天
    "d5": "mcn-d5-raw.png",            # 展臂摆胯
    "d6": "mcn-d6-raw.png",            # 屈膝低拍
}

# 背景形态决定键控策略，不能一刀切：
#   checker —— 模型把「透明背景」画成了棋盘格，浅格 ≈(249,246,243)、
#              深格 ≈(229,225,222)。用「足够亮 + 近乎中性」捞出候选。
#   flat    —— 新生成的三帧是**一块均匀底色**，实测 (216,211,201)，
#              最暗通道 199 落在亮色键下限 200 之下，用亮度阈值会漏一大片。
#              改用「与取样底色的最大通道差」判据。
BG_MODE = {
    "base": ("flat", 12),
    "blink": ("flat", 12),
    "happy": ("flat", 12),
    # d4 是唯一重新生成过的舞蹈帧（原图把脚裁断了），与待机帧同一套取景
    "d4": ("flat", 12),
}
DEFAULT_BG = ("checker", None)

# 与 base 同一取景的帧：直接复用 base 的对齐量。
# 眨眼只该动眼睛，让三帧各自检测锚点反而会引入几像素的漂移。
REUSE_BASE_ALIGN = {"blink", "happy"}

# 目视标定的尺度系数（1.0 = 与 base 同尺度）
# ---------------------------------------------------------------
# 六张舞蹈帧取景远近不统一，必须逐帧归一化。自动测量做不到可信精度：
# 红色阈值在不同渲染下抓到的范围不一致（原 d4 偏差 25%），alpha 轮廓则被发型
# 干扰（d5 判成 0.85，实际约 1.00）。所以最终系数 = 自动测量与「按帽质心
# 对齐的等尺寸裁剪图」人工读数的平均，并以此为准。
# 运行 --measure 会打印自动测量值，方便随时复核这张表。
#
# 注意 d4：它的原图把脚裁断了（画面底部切在脚踝上），「鞋底」其实测到的是
# 画幅边界，无论按头还是按脚对齐都不对 —— 按脚对会变矮人，按头对会浮空。
# 与其在错误的素材上反复凑，不如重画一张，所以 d4 单独重生成过（见 BG_MODE），
# 它与待机帧同取景，系数因此是 1.0，不在下表内。
HEAD_FIX = {
    "d1": 1.03,
    "d2": 0.89,
    "d3": 0.94,
    "d4": 1.00,
    "d5": 1.08,
    "d6": 0.71,
}

# 腾空帧：垂直位置不按「鞋底贴地」定，而是按「头顶对齐站立高度」定。
# 详见 build() 里的说明。
AIRBORNE = {"d2"}

# 生成模型在每张图的右下角打了水印。它落在纯背景上，颜色和底色只差一点点，
# 抠图既键不掉又不像角色，最后会在深色桌面上留下几个若隐若现的灰字。
# 实测这±块矩形内没有任何角色像素（九帧全部为 0），所以直接填回背景色。
WATERMARK_BOX = (820, 1410, 1024, 1536)


def alpha_bbox(rgba, thresh=24):
    solid = rgba.getchannel("A").point(lambda v: 255 if v > thresh else 0)
    return solid.getbbox()


def _is_hat_red(p):
    r, g, b, a = p
    return a > 140 and r > 110 and (r - g) > 55 and (r - b) > 55


def hat_anchor(rgba, region=0.34, step=2, min_ratio=0.25, gap_tol=2):
    """红色鸭舌帽的质心。

    只扫画面顶部 region 比例的高度，避开同样是红色的 polo 衫。

    这里刻意**不**用「最上方的红色像素」——实测 d1 在 y=40 处有一个孤立噪点，
    单靠它会把锚点算到 x=307（正确值约 515），整张图就被推歪了。
    改为逐行统计红色像素数，从顶部往下找第一段连续的高密度行区间：
    帽子永远在画面最上方，这段区间就是帽子本体。
    """
    w, h = rgba.size
    px = rgba.load()
    ymax = int(h * region)

    rows = {}
    for y in range(0, ymax, step):
        xs = [x for x in range(0, w, step) if _is_hat_red(px[x, y])]
        if xs:
            rows[y] = xs

    if not rows:
        return None

    counts = {y: len(v) for y, v in rows.items()}
    thr = max(counts.values()) * min_ratio

    ys = sorted(rows)
    start = next((y for y in ys if counts[y] >= thr), None)
    if start is None:
        return None

    selected = []
    miss = 0
    for y in ys:
        if y < start:
            continue
        if counts[y] >= thr:
            selected.append(y)
            miss = 0
        else:
            miss += 1
            if miss > gap_tol:
                break

    pts = [(x, y) for y in selected for x in rows[y]]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    return cx, cy, len(pts)


def _is_hat_red_strict(p):
    r, g, b, a = p
    return a > 140 and r > 150 and (r - g) > 85 and (r - b) > 95 and g < 140


def hat_top(rgba):
    """帽子最上面一行。只用来给「头部带宽」划定扫描起点。"""
    w, h = rgba.size
    px = rgba.load()
    for y in range(0, int(h * 0.35)):
        n = 0
        for x in range(0, w, 2):
            if _is_hat_red_strict(px[x, y]):
                n += 1
                if n >= 4:
                    return y
    return None


def head_band(rgba, shoe_y, frac=0.10):
    """头顶往下 2*frac 比例高度内，不透明像素的最长连续横向跨度。

    这是整套管线里最关键的基准，值得解释为什么非它不可：

    六张舞蹈帧是**同一次生成里各画各的**，取景远近并不统一（有的像特写，
    有的像远景）。要做出一段能看的舞蹈，必须先把它mens归一化到同一尺度。

      * 包围盒不行 —— 挥手帧的手臂、垂下来的马尾都会把包围盒撑歪。
      * 「帽→鞋高」不行 —— 它是**姿态相关**的：下蹲、跳跃、单腿扭腰都会把
        这个高度压低，看上去像是缩放差异，其实只是姿势差异。
      * 红色像素宽度不行 —— 各帧渲染的饱和度/明暗不同，同一个阈值在不同帧
        上抓到的红色范围不一样，比值会失真（实测 d4 偏差 25%）。

    只剩下 alpha 轮廓可用：它只描述「哪里有像素」，与配色、明暗完全无关，
    而头顶那一小段的轮廓就是帽檐加两侧头发，恰好是一个刚性、稳定的尺度信号。
    """
    w, h = rgba.size
    px = rgba.load()
    top = hat_top(rgba)
    if top is None:
        return None
    span = max(1, shoe_y - top)
    ymax = min(h, top + max(40, int(span * frac * 2)))
    best = 0
    for y in range(top, ymax):
        run = 0
        for x in range(w):
            if px[x, y][3] > 128:
                run += 1
                if run > best:
                    best = run
            else:
                run = 0
    return best


def load_cutout(src_path, bg_mode="checker", flat_tol=None):
    """抠成透明 RGBA，保持原始尺寸（不裁切、不缩放）。"""
    img = Image.open(src_path).convert("RGB")

    bg_rgb = ct.sample_background(img)
    if WATERMARK_BOX:
        img = ct.erase_rect(img, WATERMARK_BOX, bg_rgb)

    if bg_mode == "flat":
        cand = ct.build_background_mask_flat(img, bg_rgb, flat_tol)
        holes_kw = {"bg_rgb": bg_rgb, "flat_tol": flat_tol + 8}
    else:
        cand = ct.build_background_mask(img, 200, 32)
        holes_kw = {}

    filled, _hits = ct.keep_edge_connected(cand)

    # 补上被马尾围住的封闭背景口袋（详见 cutout.fill_holes 的说明）
    # 注意它返回的就是 0/255 的背景掩码，不要再套一层 FILLED 判断
    bg = ct.fill_holes(img, cand, filled, log=lambda *a, **k: None, **holes_kw)

    alpha = bg.point(lambda v: 255 - v)
    alpha = alpha.filter(ImageFilter.MinFilter(3))   # 收缩 1px，切掉贴边抗锯齿
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))

    working = ct.remove_background_spill(img, alpha, bg_rgb)

    out = working.convert("RGBA")
    out.putalpha(alpha)
    return out


def shoe_bottom(rgba, region=0.55, step=2, min_count=4, max_luma=90):
    """黑色玛丽珍鞋的鞋底 y。

    从画面底部往上扫，遇到的第一个「深色行」就是鞋底。
    头发（金色）的暗部 max 通道远高于 90，围裙虽然在扫描范围内但位于鞋之上，
    自下而上第一个命中的深色一定是最底下的那只鞋。

    这是垂直方向的锚点：所有帧的脚都踩在同一条地面线上。
    跳跃帧的「离地」不用素材表达，而是交给编排层 —— 那是动作，不是取景差异。
    """
    w, h = rgba.size
    px = rgba.load()
    ystart = int(h * region)

    for y in range(h - 1, ystart, -1):
        cnt = 0
        for x in range(0, w, step):
            r, g, b, a = px[x, y]
            if a > 140 and max(r, g, b) < max_luma:
                cnt += 1
                if cnt >= min_count:
                    return y
    return None


def survey():
    """把八帧的原始锚点、包围盒都量一遍（未缩放的原始画幅坐标）。"""
    out = {}
    for fid, name in FRAMES.items():
        mode, tol = BG_MODE.get(fid, DEFAULT_BG)
        img = load_cutout(os.path.join(RAW, name), mode, tol)
        hat = hat_anchor(img)
        shoe = shoe_bottom(img)
        if hat is None or shoe is None:
            raise SystemExit(f"[dance] {fid} 锚点检测失败（帽 {hat} 鞋 {shoe}）")
        out[fid] = {"img": img, "hat": hat, "shoe": shoe, "bbox": alpha_bbox(img),
                    "band": head_band(img, shoe)}
    return out


def head_fix(info):
    """各帧相对 base 的尺度修正系数：把头部归一到同一大小。

    采用 HEAD_FIX 里目视标定的值（理由见该常量上方的说明）。同时把自动测量
    结果一并返回，供 --measure 复核，避免标定表悄悄过期。
    """
    ref = info[BASE]["band"]
    if not ref:
        raise SystemExit("[dance] 基准帧头部带宽检测失败")
    fix, auto = {}, {}
    for fid, it in info.items():
        b = it["band"]
        auto[fid] = round(ref / b, 3) if b else None
        if fid in REUSE_BASE_ALIGN or fid == BASE:
            fix[fid] = 1.0
        else:
            fix[fid] = HEAD_FIX.get(fid, auto[fid] or 1.0)
    return fix, auto


def normalized(info, fix):
    """把每一帧按 fix 归一化后，得到可用于统一排版的几何量。"""
    out = {}
    for fid, it in info.items():
        k = fix[fid]
        bbox = it["bbox"]
        out[fid] = {
            "fid": fid,
            "fix": k,
            "hat": (it["hat"][0] * k, it["hat"][1] * k),
            "shoe": it["shoe"] * k,
            "bbox": (bbox[0] * k, bbox[1] * k, bbox[2] * k, bbox[3] * k),
            "size": (round(it["img"].size[0] * k), round(it["img"].size[1] * k)),
        }
    return out


def pick_scale(norm):
    """同时满足高度与宽度约束的最大统一缩放。

    两条约束都是「全帧最严者胜」：

      * 宽度 —— 挥手 / 展臂帧的手臂横向跨度远大于站立帧，只看基准帧会把
        挥出去的手顶出画布。
      * 高度 —— 同理，只看基准帧会把抬高帧的头顶裁掉。
    """
    base = norm[BASE]
    body_h = base["shoe"] - base["hat"][1]
    ground = CANVAS_H - CROP_PAD

    s_h = float("inf")
    tallest = None
    for fid, it in norm.items():
        hgt = it["shoe"] - it["bbox"][1]
        if hgt <= 0:
            continue
        s = (ground - CROP_PAD) / hgt
        if s < s_h:
            s_h, tallest = s, (fid, hgt)

    room = CANVAS_W / 2 - EDGE_MARGIN
    s_w = float("inf")
    widest = None
    for fid, it in norm.items():
        if fid in REUSE_BASE_ALIGN:
            continue
        for side, span in (("左", it["hat"][0] - it["bbox"][0]),
                           ("右", it["bbox"][2] - it["hat"][0])):
            if span <= 0:
                continue
            s = room / span
            if s < s_w:
                s_w, widest = s, (fid, side, span)

    return min(s_h, s_w), s_h, s_w, widest, tallest, body_h


def measure():
    info = survey()
    fix, auto = head_fix(info)
    print(f'{"帧":<7}{"帽质心x":<10}{"鞋底y":<9}{"帽→鞋高":<10}{"头带宽":<9}'
          f'{"自动":<9}{"采用":<9}')
    print("-" * 68)
    for fid, it in info.items():
        print(
            f"{fid:<7}{it['hat'][0]:<10.1f}{it['shoe']:<9}"
            f"{it['shoe'] - it['hat'][1]:<10.0f}{str(it['band']):<9}"
            f"{str(auto[fid]):<9}{fix[fid]:<9.3f}"
        )

    norm = normalized(info, fix)
    scale, s_h, s_w, widest, tallest, body_h = pick_scale(norm)
    print()
    print(f"画幅: {info[BASE]['img'].size}   归一化后基准人体高: {body_h:.0f}px")
    print(f"高度约束 scale <= {s_h:.4f} （最紧的是 {tallest[0]}，身高 {tallest[1]:.0f}px）")
    print(f"宽度约束 scale <= {s_w:.4f} （最紧的是 {widest[0]} 的{widest[1]}侧，"
          f"跨度 {widest[2]:.0f}px）")
    print(f"采用 scale = {scale:.4f}")


def build():
    info = survey()
    fix, auto = head_fix(info)
    norm = normalized(info, fix)
    scale, s_h, s_w, widest, tallest, body_h = pick_scale(norm)

    print("[dance] 尺度系数 " + "  ".join(
        f"{k}={fix[k]:.2f}(自动{auto[k]})" for k in FRAMES))
    print(f"[dance] 归一化后基准人体高 {body_h:.0f}px，统一 scale={scale:.4f} "
          f"(高 {s_h:.4f}/{tallest[0]} 宽 {s_w:.4f}/{widest[0]} 取严)")

    ground = CANVAS_H - CROP_PAD          # 地面线：所有帧的鞋底都落在这里
    meta = {"canvas": [CANVAS_W, CANVAS_H], "ground": ground,
            "base_body_h": round(body_h, 1), "scale": round(scale, 5),
            "fix": {k: round(v, 4) for k, v in fix.items()}, "frames": {}}

    base_dx = CANVAS_W / 2 - norm[BASE]["hat"][0] * scale
    base_dy = ground - norm[BASE]["shoe"] * scale

    # d2 是跳跃帧：原图里腿是向后折起的，若把「鞋底」直接压到地面线，读起来
    # 是跪着而不是跳起来。所以让它改按「头顶对齐站立高度」来定垂直位置 ——
    # 折起的腿把脚自然抬高，正是腾空该有的样子。
    def head_true_h(it):
        return it["shoe"] - it["bbox"][1]

    base_head_h = head_true_h(norm[BASE])

    items = []
    for fid, it in info.items():
        n = norm[fid]
        if fid in REUSE_BASE_ALIGN:
            # 与 base 同一张图，只有表情不同：直接沿用 base 的对齐量，
            # 免得眨眼时整张脸跳一下。
            dx, dy, air = base_dx, base_dy, 0.0
        else:
            dx = CANVAS_W / 2 - n["hat"][0] * scale
            if fid in AIRBORNE:
                air = (base_head_h - head_true_h(n)) * scale
                if air < 0:
                    air = 0.0
            else:
                air = 0.0
            dy = ground - n["shoe"] * scale - air

        dst_size = (round(it["img"].size[0] * fix[fid] * scale),
                    round(it["img"].size[1] * fix[fid] * scale))
        items.append({"fid": fid, "img": it["img"], "dst": dst_size,
                      "dx": dx, "dy": dy, "air": air, "n": n})

    for it in items:
        scaled = it["img"].resize(it["dst"], Image.LANCZOS)
        canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
        canvas.alpha_composite(scaled, (round(it["dx"]), round(it["dy"])))

        dst = os.path.join(ASSETS, f"mcn-{it['fid']}.png")
        canvas.save(dst)

        cbb = alpha_bbox(canvas)
        meta["frames"][it["fid"]] = {"air": round(it["air"], 1), "bbox": list(cbb),
                                     "fix": round(fix[it["fid"]], 4)}
        print(
            f"[dance] {it['fid']:<6} → {os.path.basename(dst):<15}"
            f" 帽x={it['dx'] + it['n']['hat'][0] * scale:.0f}"
            f" 鞋底y={ground:.0f} 头顶y={cbb[1]:<4}"
            f" 离地={it['air']:>5.1f} 包围盒={tuple(cbb)}"
        )

        if cbb[0] < 0 or cbb[2] > CANVAS_W or cbb[3] > CANVAS_H:
            print(f"[dance] 警告: {it['fid']} 触边，可能被裁 "
                  f"({cbb} / {CANVAS_W}x{CANVAS_H})")

    meta_path = os.path.join(ASSETS, "dance.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"[dance] 元数据 → {os.path.relpath(meta_path, ROOT)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--measure", action="store_true", help="只测量不写文件")
    args = ap.parse_args()

    (measure if args.measure else build)()


if __name__ == "__main__":
    sys.exit(main())
