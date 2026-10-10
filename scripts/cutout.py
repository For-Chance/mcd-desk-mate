#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
麦娘素材预处理：把 AI 生成的立绘转为可用作桌面宠物的透明 PNG。

背景说明：模型输出的「透明背景」实际是把棋盘格纹理画进了像素里，
浅色格约 (249,246,243)，深色格约 (229,225,222)。因此不能靠单一种子色做
flood fill。本脚本采用两步策略：

  1. 全局亮色键：把所有「足够亮且近乎中性灰」的像素标为背景候选。
  2. 边缘连通性：只有与画面外沿连通的候选像素才算真背景。

这样角色内部的白色（眼白、制服白边、帽檐高光）会被完整保留。

用法：
    python scripts/cutout.py <输入图> <输出图> [--max-height N] [--trim]
"""

import argparse
import sys
from collections import deque

from PIL import Image, ImageDraw, ImageFilter

CAND = 255
FILLED = 128


def build_background_mask(img, bg_min, bg_sat):
    """全局亮色键 → 候选背景掩码。

    适用于「棋盘格假透明」背景：浅格与深格都很亮、都很中性，用亮度+饱和度
    就能一把捞出来；而角色内部的白色只占一小块，靠后面的边缘连通剔不掉。
    """
    w, h = img.size
    pixels = list(img.getdata())

    cand = Image.new("L", (w, h))
    cand.putdata(
        [
            CAND if (min(p) >= bg_min and (max(p) - min(p)) <= bg_sat) else 0
            for p in pixels
        ]
    )
    return cand


def build_background_mask_flat(img, bg_rgb, tol):
    """纯色背景键 → 候选背景掩码。

    适用于「一整块均匀底色」背景。这类背景的暗通道可能低于亮色键的下限
    （实测新素材背景是 (216,211,201)，最暗通道 199 < 200），用亮度阈值会漏，
    但对「与取样底色的最大通道差」做阈值就非常稳。
    """
    w, h = img.size
    br, bg, bb = bg_rgb
    cand = Image.new("L", (w, h))
    cand.putdata(
        [
            CAND if max(abs(p[0] - br), abs(p[1] - bg), abs(p[2] - bb)) <= tol else 0
            for p in img.getdata()
        ]
    )
    return cand


def keep_edge_connected(cand, step=8):
    """只保留与画面外沿连通的候选背景。"""
    w, h = cand.size
    work = cand.copy()

    seeds = []
    for x in range(0, w, step):
        seeds.append((x, 0))
        seeds.append((x, h - 1))
    for y in range(0, h, step):
        seeds.append((0, y))
        seeds.append((w - 1, y))

    hits = 0
    for seed in seeds:
        if work.getpixel(seed) == CAND:
            ImageDraw.floodfill(work, seed, FILLED, thresh=0)
            hits += 1
    return work, hits


def fill_holes(img, cand, filled, min_size=120, dark_lo=200, dark_hi=235,
               need_dark=6, bg_rgb=None, flat_tol=None, log=print):
    """把被角色包住的背景口袋也补成背景。

    为什么需要这一步
    -----------------
    「边缘连通」只能从画面外沿往里灌，遇到被围住的口袋就进不去。垂下来的
    双马尾常与身体围出一个封闭的透镜形缝隙 —— 那里明明是背景，却因为够不到
    外沿而留了下来，在深色桌面上就是一块刺眼的棋盘格。

    怎么区分「背景口袋」和「角色内部的白色」
    ----------------------------------------
    两种背景形态各有判据，命中任一即可：

      * 棋盘格背景：浅格 min≈243、深格 min≈216。待判区域只要**同时含有深格
        像素**，就一定属于棋盘格。
      * 纯色背景：待判区域的**平均色非常接近取样底色**（默认 16 以内）。

    两条判据同时保护了角色：眼白、制服白边都是单一浅色，既不含深格，平均色
    也离背景底色有明显距离。再叠加面积阈值，滤掉边缘抗锯齿产生的小碎片。
    """
    w, h = img.size
    cpx = list(cand.getdata())
    fpx = list(filled.getdata())
    ipx = list(img.getdata())

    todo = bytearray(w * h)
    for i in range(w * h):
        if cpx[i] == CAND and fpx[i] != FILLED:
            todo[i] = 1

    seen = bytearray(w * h)
    pockets = 0
    for start in range(w * h):
        if not todo[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        comp = []
        while stack:
            i = stack.pop()
            comp.append(i)
            y, x = divmod(i, w)
            if x and todo[i - 1] and not seen[i - 1]:
                seen[i - 1] = 1
                stack.append(i - 1)
            if x + 1 < w and todo[i + 1] and not seen[i + 1]:
                seen[i + 1] = 1
                stack.append(i + 1)
            if y and todo[i - w] and not seen[i - w]:
                seen[i - w] = 1
                stack.append(i - w)
            if y + 1 < h and todo[i + w] and not seen[i + w]:
                seen[i + w] = 1
                stack.append(i + w)

        if len(comp) < min_size:
            continue

        ok = sum(1 for i in comp if dark_lo <= min(ipx[i]) < dark_hi) >= need_dark
        if not ok and bg_rgb is not None and flat_tol is not None:
            n = len(comp)
            mr = sum(ipx[i][0] for i in comp) / n
            mg = sum(ipx[i][1] for i in comp) / n
            mb = sum(ipx[i][2] for i in comp) / n
            ok = max(abs(mr - bg_rgb[0]), abs(mg - bg_rgb[1]),
                     abs(mb - bg_rgb[2])) <= flat_tol

        if ok:
            for i in comp:
                fpx[i] = FILLED
            pockets += 1

    out = Image.new("L", (w, h))
    out.putdata([255 if v == FILLED else 0 for v in fpx])
    log(f"[cutout] 封闭口袋补洞 {pockets} 处")
    return out


def erase_rect(img, box, color):
    """把一块纯背景矩形直接涂回背景色 —— 用来抹掉生成模型打的水印。

    水印是压在角落背景上的半透明灰字（浅色底上尤其难缠）：它的颜色和底色
    只差一点点，抠图时既不像背景那样被键掉，又不像角色那样实心，最后在深色
    桌面上就剩下几个若隐若现的灰字。

    直接填平最干净。前提是这块矩形里没有角色像素 —— 调用前务必确认。
    """
    out = img.copy()
    ImageDraw.Draw(out).rectangle(box, fill=tuple(color))
    return out


def clamp8(v):
    return 0 if v < 0 else (255 if v > 255 else int(v))


def remove_background_spill(img, alpha, bg_rgb):
    """边缘颜色去污。

    半透明过渡像素的观测色是「前景 × α + 背景 × (1-α)」的混合结果，
    若直接保留，把角色放到深色桌面上就会显出一圈发白的光晕。
    这里按已知背景色反解出前景真实颜色：
        F = (C - (1-α) · B) / α
    """
    br, bg_g, bb = bg_rgb
    cols = list(img.getdata())
    alps = list(alpha.getdata())

    out = []
    for c, a in zip(cols, alps):
        if a == 0 or a >= 250:
            out.append(c)
            continue
        f = a / 255.0
        k = 1.0 - f
        out.append((
            clamp8((c[0] - k * br) / f),
            clamp8((c[1] - k * bg_g) / f),
            clamp8((c[2] - k * bb) / f),
        ))

    cleaned = Image.new("RGB", img.size)
    cleaned.putdata(out)
    return cleaned


def sample_background(img):
    """从四角取样，估算背景底色，供去污使用。"""
    w, h = img.size
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    vals = [img.getpixel(p) for p in pts]
    return tuple(sum(v[i] for v in vals) // len(vals) for i in range(3))


def cutout(src_path, dst_path, bg_min=200, bg_sat=32, max_height=None,
           trim=False, feather=0.6, erode=True, decontaminate=True,
           holes=True, flat_tol=None, verbose=True):
    img = Image.open(src_path).convert("RGB")
    w, h = img.size
    log = print if verbose else (lambda *a, **k: None)
    log(f"[cutout] 载入 {w}x{h}")

    bg_rgb = sample_background(img)
    log(f"[cutout] 背景底色估算为 {bg_rgb}")

    if flat_tol is None:
        cand = build_background_mask(img, bg_min, bg_sat)
        holes_kw = {}
    else:
        cand = build_background_mask_flat(img, bg_rgb, flat_tol)
        holes_kw = {"bg_rgb": bg_rgb, "flat_tol": flat_tol + 6}
        log(f"[cutout] 纯色背景键控，容差 {flat_tol}")

    filled, hits = keep_edge_connected(cand)
    log(f"[cutout] 边缘连通填充触发 {hits} 次")

    bg = filled.point(lambda v: 255 if v == FILLED else 0)

    if holes:
        bg = fill_holes(img, cand, filled, log=log, **holes_kw)

    alpha = bg.point(lambda v: 255 - v)

    # 收缩 1px：切掉紧贴角色的背景抗锯齿像素
    if erode:
        alpha = alpha.filter(ImageFilter.MinFilter(3))

    if feather > 0:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))

    working = img
    if decontaminate:
        working = remove_background_spill(img, alpha, bg_rgb)
        log("[cutout] 已完成边缘颜色去污")

    out = working.convert("RGBA")
    out.putalpha(alpha)

    if trim:
        solid = alpha.point(lambda v: 255 if v > 24 else 0)
        bbox = solid.getbbox()
        if bbox:
            pad = 8
            bbox = (
                max(0, bbox[0] - pad),
                max(0, bbox[1] - pad),
                min(w, bbox[2] + pad),
                min(h, bbox[3] + pad),
            )
            out = out.crop(bbox)
            log(f"[cutout] 裁切至 {out.size}")

    if max_height and out.height > max_height:
        ratio = max_height / out.height
        out = out.resize((round(out.width * ratio), max_height), Image.LANCZOS)
        log(f"[cutout] 缩放至 {out.size}")

    out.save(dst_path)
    log(f"[cutout] 已保存 {dst_path}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--max-height", type=int, default=None)
    ap.add_argument("--trim", action="store_true")
    ap.add_argument("--bg-min", type=int, default=200)
    ap.add_argument("--bg-sat", type=int, default=32)
    ap.add_argument("--feather", type=float, default=0.6)
    ap.add_argument("--no-erode", action="store_true", help="不收缩边缘")
    ap.add_argument("--no-decontaminate", action="store_true", help="不做边缘颜色去污")
    ap.add_argument("--no-fill-holes", action="store_true", help="不补封闭背景口袋")
    ap.add_argument("--flat-tol", type=int, default=None,
                    help="纯色背景键控的通道容差（棋盘格背景不要传）")
    args = ap.parse_args()

    cutout(
        args.src,
        args.dst,
        bg_min=args.bg_min,
        bg_sat=args.bg_sat,
        max_height=args.max_height,
        trim=args.trim,
        feather=args.feather,
        erode=not args.no_erode,
        decontaminate=not args.no_decontaminate,
        holes=not args.no_fill_holes,
        flat_tol=args.flat_tol,
    )


if __name__ == "__main__":
    sys.exit(main())
