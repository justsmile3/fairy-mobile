#!/usr/bin/env python3
"""生成 Fairy 的应用图标 —— 严格还原 App 内立绘（js/mascot.js）。

【原则】不改比例、不改配色、不改结构。
所有几何值与颜色都直接取自 mascot.js 的 buildEyeSvg()，
确保图标与 App 内看到的形象完全一致。

立绘的图层顺序（viewBox 0 0 160 160，从底到顶）：

    1. 外盘光环         r=79    径向渐变（青色光晕）
    2. 外盘             r=68    线性渐变 #4053f0 → #3045dc → #3d50c8
                                描边 #f2fbff 宽 1.2
    3. 四角睫毛         #2b3388
                        · 圆   cx=80 cy=80 r=51.75
                        · 方块 x=37 y=37 w=86 h=86 rx=2，rotate(3)
                        两者合并后按外盘(r=67)裁切 —— 形成"眼角"的形状
    4. 眼白             r=48    #eef0f5
       + 巩膜光晕       r=56    白色径向渐变
       + 巩膜接触环     r=48    stroke #ffffff 宽 0.8，透明度 .16
    5. 眼球三层
       · layer-three    r=33    #9daee0
       · layer-two      r=24.15 #eef0f5
       · layer-two      r=23.5  #317bcf
       · layer-one      r=16.6  stroke #f5f8fd 宽 .1
    6. 瞳孔（视线层）   r=16    #3b3d8a
       + 高光光环       (98,100.5) r=18   #f5f8fd 径向渐变
       + 高光实心       (98,100.5) r=11   #f5f8fd
    7. 扫描线           #c9f8ff 透明度 .055，4×4 图案，整体 opacity .42

用法: python tools/make-icons.py
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ── 立绘几何（原样取自 mascot.js 的 G）────────────────────────
BOX = 160.0
OUTER_HALO_R = 79.0
OUTER_DISC_R = 68.0
OUTER_STROKE_W = 1.2
SCLERA_R = 48.0
SCLERA_HALO_R = 56.0
SCLERA_CONTACT_W = 0.8
CORNERS_CIRCLE_R = 51.75
CORNERS_RECT = (37.0, 37.0, 86.0, 86.0, 2.0, 3.0)   # x, y, w, h, rx, rotate
LAYER_THREE_R = 33.0
LAYER_TWO_A_R = 24.15
LAYER_TWO_B_R = 23.5
LAYER_ONE_R = 16.6
PUPIL_R = 16.0
HL_X, HL_Y = 98.0, 100.5
HL_HALO_R = 18.0
HL_R = 11.0
DISC_CLIP_R = OUTER_DISC_R - 1.0      # 67，用于裁切睫毛与扫描线

# ── 立绘配色（原样取自 mascot.js）────────────────────────────
OUTER_STOPS = [(0.0, (0x40, 0x53, 0xF0)), (0.54, (0x30, 0x45, 0xDC)),
               (1.0, (0x3D, 0x50, 0xC8))]
OUTER_STROKE = (0xF2, 0xFB, 0xFF)
CORNERS_COLOR = (0x2B, 0x33, 0x88)
SCLERA_COLOR = (0xEE, 0xF0, 0xF5)
LAYER_THREE_COLOR = (0x9D, 0xAE, 0xE0)
LAYER_TWO_COLOR = (0xEE, 0xF0, 0xF5)
LAYER_TWO_B_COLOR = (0x31, 0x7B, 0xCF)
LAYER_ONE_STROKE = (0xF5, 0xF8, 0xFD)
PUPIL_COLOR = (0x3B, 0x3D, 0x8A)
HL_COLOR = (0xF5, 0xF8, 0xFD)
SCANLINE_COLOR = (0xC9, 0xF8, 0xFF)
SCANLINE_OPACITY = 0.055
SCANLINE_GROUP_OPACITY = 0.42

# 立绘里外盘光环用的是 CSS 变量（主题色），这里取其默认值
OUTER_HALO_COLOR = (0x8A, 0xB4, 0xFF)

# ── 背景（立绘本身没有背景，但图标需要）──────────────────────
# 用 App 的深色底，与界面一致
BG_TOP = (24, 31, 48)
BG_BOTTOM = (12, 16, 26)

BASE = 1024        # 工作分辨率，最后降采样


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def hex_of(c):
    return tuple(int(round(v)) for v in c)


class Canvas:
    """把 160 单位的设计坐标映射到像素，并做超采样。"""

    def __init__(self, size):
        self.size = size
        self.k = size / BOX          # 单位 → 像素
        self.img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    def px(self, v):
        return v * self.k

    def pt(self, x, y):
        return (x * self.k, y * self.k)

    def circle_box(self, cx, cy, r):
        return [self.px(cx - r), self.px(cy - r), self.px(cx + r), self.px(cy + r)]

    def layer(self):
        return Image.new("RGBA", (self.size, self.size), (0, 0, 0, 0))

    def merge(self, layer):
        self.img = Image.alpha_composite(self.img, layer)


def radial_layer(size, center, radius_px, stops):
    """径向渐变。

    stops: [(t0, rgb, alpha0), (t1, rgb, alpha1), ...]，t 为 0–1 的比例。
    逐像素计算，保证是正圆且过渡精确。
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    cx, cy = center
    r = float(radius_px)
    if r <= 0:
        return img
    # 只扫描渐变覆盖的包围盒，避免整图遍历
    x0 = max(0, int(cx - r) - 1)
    x1 = min(size - 1, int(cx + r) + 1)
    y0 = max(0, int(cy - r) - 1)
    y1 = min(size - 1, int(cy + r) + 1)
    for y in range(y0, y1 + 1):
        dy = y - cy
        for x in range(x0, x1 + 1):
            dx = x - cx
            d = ((dx * dx + dy * dy) ** 0.5) / r
            if d > 1.0:
                continue
            col = None
            for i in range(len(stops) - 1):
                t0, c0, a0 = stops[i]
                t1, c1, a1 = stops[i + 1]
                if t0 <= d <= t1:
                    k = 0.0 if t1 == t0 else (d - t0) / (t1 - t0)
                    c = lerp(c0, c1, k)
                    col = (int(round(c[0])), int(round(c[1])), int(round(c[2])),
                           int(round(a0 + (a1 - a0) * k)))
                    break
            if col is not None and col[3] > 0:
                px[x, y] = col
    return img


def linear_layer(size, p1, p2, stops):
    """线性渐变（外盘用的是 linearGradient x1=.2 y1=0 x2=.8 y2=1）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    x1, y1 = p1
    x2, y2 = p2
    vx, vy = x2 - x1, y2 - y1
    denom = vx * vx + vy * vy
    for y in range(size):
        for x in range(size):
            t = ((x - x1) * vx + (y - y1) * vy) / denom if denom else 0.0
            t = max(0.0, min(1.0, t))
            col = None
            for i in range(len(stops) - 1):
                t0, c0 = stops[i]
                t1, c1 = stops[i + 1]
                if t0 <= t <= t1:
                    k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
                    c = lerp(c0, c1, k)
                    col = (int(round(c[0])), int(round(c[1])), int(round(c[2])), 255)
                    break
            if col:
                px[x, y] = col
    return img


def build_design(size, with_bg=True, rounded=True, padding=0.02):
    """按立绘的 160×160 设计稿绘制。

    padding 只影响「外盘在画布中的占比」，不改变任何内部比例。
    立绘的外盘 r=68 在 160 画布里本就留了 12 单位的边距，
    这里保持一致（不再额外加留白），保证与 App 内观感相同。
    """
    c = Canvas(size)

    # 背景
    if with_bg:
        bg = Image.new("RGB", (size, size))
        bpx = bg.load()
        for y in range(size):
            t = y / max(1, size - 1)
            col = hex_of(lerp(BG_TOP, BG_BOTTOM, t))
            for x in range(size):
                bpx[x, y] = col
        bg = bg.convert("RGBA")
        if rounded:
            mask = Image.new("L", (size, size), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                [0, 0, size - 1, size - 1], radius=int(size * 0.235), fill=255)
            base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            base.paste(bg, (0, 0), mask)
            c.img = base
        else:
            c.img = bg

    ccx, ccy = c.pt(80, 80)

    # ── 1. 外盘光环（r=79）──
    halo = radial_layer(size, (ccx, ccy), c.px(OUTER_HALO_R), [
        (0.00, OUTER_HALO_COLOR, 0),
        (0.80, OUTER_HALO_COLOR, 0),
        (0.84, OUTER_HALO_COLOR, int(255 * 0.10)),
        (0.861, OUTER_HALO_COLOR, int(255 * 0.28)),
        (0.90, OUTER_HALO_COLOR, int(255 * 0.18)),
        (0.95, OUTER_HALO_COLOR, int(255 * 0.06)),
        (1.00, OUTER_HALO_COLOR, 0),
    ])
    c.merge(halo)

    # ── 2. 外盘（r=68，线性渐变 + 白描边）──
    # SVG 的 linearGradient x1=.2 y1=0 x2=.8 y2=1 是相对外盘包围盒的比例
    disc_p1 = (ccx - c.px(OUTER_DISC_R) + c.px(OUTER_DISC_R * 2 * 0.2),
               ccy - c.px(OUTER_DISC_R))
    disc_p2 = (ccx - c.px(OUTER_DISC_R) + c.px(OUTER_DISC_R * 2 * 0.8),
               ccy + c.px(OUTER_DISC_R))
    disc_grad = linear_layer(size, disc_p1, disc_p2,
                             [(t, hex_of(col)) for t, col in OUTER_STOPS])
    disc_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(disc_mask).ellipse(c.circle_box(80, 80, OUTER_DISC_R), fill=255)
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    disc.paste(disc_grad, (0, 0), disc_mask)
    c.merge(disc)

    # 白描边
    stroke = c.layer()
    ImageDraw.Draw(stroke).ellipse(
        c.circle_box(80, 80, OUTER_DISC_R),
        outline=hex_of(OUTER_STROKE) + (255,),
        width=max(1, int(round(c.px(OUTER_STROKE_W)))))
    c.merge(stroke)

    # ── 3. 四角睫毛（圆 r=51.75 与旋转方块合并，按 r=67 裁切）──
    corners = c.layer()
    cd = ImageDraw.Draw(corners)
    corners_col = hex_of(CORNERS_COLOR) + (255,)
    cd.ellipse(c.circle_box(80, 80, CORNERS_CIRCLE_R), fill=corners_col)
    # 旋转方块：在独立图层上画好再旋转，避免坐标换算误差
    rx, ry, rw, rh, rrad, rang = CORNERS_RECT
    rect_layer = c.layer()
    ImageDraw.Draw(rect_layer).rounded_rectangle(
        [c.px(rx), c.px(ry), c.px(rx + rw), c.px(ry + rh)],
        radius=c.px(rrad), fill=corners_col)
    rect_layer = rect_layer.rotate(-rang, resample=Image.BICUBIC, center=(ccx, ccy))
    corners = Image.alpha_composite(corners, rect_layer)
    # 按外盘内径裁切
    clip = Image.new("L", (size, size), 0)
    ImageDraw.Draw(clip).ellipse(c.circle_box(80, 80, DISC_CLIP_R), fill=255)
    corners = Image.composite(corners, Image.new("RGBA", (size, size), (0, 0, 0, 0)), clip)
    c.merge(corners)

    # ── 4. 眼白（r=48）+ 巩膜光晕 + 接触环 ──
    sclera = c.layer()
    ImageDraw.Draw(sclera).ellipse(c.circle_box(80, 80, SCLERA_R),
                                   fill=hex_of(SCLERA_COLOR) + (255,))
    c.merge(sclera)

    sclera_halo = radial_layer(size, (ccx, ccy), c.px(SCLERA_HALO_R), [
        (0.00, (255, 255, 255), 0),
        (0.82, (255, 255, 255), 0),
        (0.857, (255, 255, 255), int(255 * 0.22)),
        (0.875, (255, 255, 255), int(255 * 0.28)),
        (0.89, (255, 255, 255), int(255 * 0.19)),
        (0.94, (255, 255, 255), int(255 * 0.07)),
        (1.00, (255, 255, 255), 0),
    ])
    c.merge(sclera_halo)

    contact = c.layer()
    ImageDraw.Draw(contact).ellipse(
        c.circle_box(80, 80, SCLERA_R),
        outline=(255, 255, 255, int(255 * 0.16)),
        width=max(1, int(round(c.px(SCLERA_CONTACT_W)))))
    c.merge(contact)

    # ── 5. 眼球三层 ──
    layers = c.layer()
    ld = ImageDraw.Draw(layers)
    ld.ellipse(c.circle_box(80, 80, LAYER_THREE_R), fill=hex_of(LAYER_THREE_COLOR) + (255,))
    c.merge(layers)

    l2 = c.layer()
    ImageDraw.Draw(l2).ellipse(c.circle_box(80, 80, LAYER_TWO_A_R),
                               fill=hex_of(LAYER_TWO_COLOR) + (255,))
    c.merge(l2)

    l2b = c.layer()
    ImageDraw.Draw(l2b).ellipse(c.circle_box(80, 80, LAYER_TWO_B_R),
                                fill=hex_of(LAYER_TWO_B_COLOR) + (255,))
    c.merge(l2b)

    l1 = c.layer()
    ImageDraw.Draw(l1).ellipse(
        c.circle_box(80, 80, LAYER_ONE_R), outline=hex_of(LAYER_ONE_STROKE) + (255,),
        width=max(1, int(round(c.px(0.1)))))
    c.merge(l1)

    # ── 6. 瞳孔 + 高光 ──
    pupil = c.layer()
    ImageDraw.Draw(pupil).ellipse(c.circle_box(80, 80, PUPIL_R),
                                  fill=hex_of(PUPIL_COLOR) + (255,))
    c.merge(pupil)

    hx_px, hy_px = c.pt(HL_X, HL_Y)
    hl_halo = radial_layer(size, (hx_px, hy_px), c.px(HL_HALO_R), [
        (0.00, HL_COLOR, 0),
        (0.53, HL_COLOR, 0),
        (0.56, HL_COLOR, int(255 * 0.16)),
        (0.611, HL_COLOR, int(255 * 0.43)),
        (0.72, HL_COLOR, int(255 * 0.19)),
        (0.83, HL_COLOR, int(255 * 0.055)),
        (1.00, HL_COLOR, 0),
    ])
    c.merge(hl_halo)

    hl = c.layer()
    ImageDraw.Draw(hl).ellipse(c.circle_box(HL_X, HL_Y, HL_R),
                               fill=hex_of(HL_COLOR) + (255,))
    c.merge(hl)

    # ── 7. 扫描线（4×4 图案，1 像素高，透明度 .055，整体 .42）──
    scan = c.layer()
    sd = ImageDraw.Draw(scan)
    step = max(1, int(round(c.px(4))))
    line_h = max(1, int(round(c.px(1))))
    alpha = int(round(255 * SCANLINE_OPACITY * SCANLINE_GROUP_OPACITY))
    scan_col = hex_of(SCANLINE_COLOR) + (alpha,)
    x0, y0 = c.pt(12, 10)
    x1, y1 = c.pt(12 + 136, 10 + 146)
    yy = int(y0)
    while yy < int(y1):
        sd.rectangle([int(x0), yy, int(x1), yy + line_h - 1], fill=scan_col)
        yy += step
    clip = Image.new("L", (size, size), 0)
    ImageDraw.Draw(clip).ellipse(c.circle_box(80, 80, DISC_CLIP_R), fill=255)
    scan = Image.composite(scan, Image.new("RGBA", (size, size), (0, 0, 0, 0)), clip)
    c.merge(scan)

    return c.img


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)


def main():
    print("按立绘原参数生成图标（160×160 设计稿，不改比例/配色）…")
    design = build_design(BASE, with_bg=True, rounded=True)

    # 1) PWA 图标
    for s in [48, 72, 96, 128, 144, 152, 192, 256, 384, 512]:
        save(design.resize((s, s), Image.LANCZOS),
             os.path.join(ROOT, "icons", f"icon-{s}.png"))
    print("  PWA 图标：10 个尺寸")

    # 2) Android 各密度
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    # 自适应图标前景需要更大的安全区（系统会裁掉约 33%）
    fg_design = build_design(BASE, with_bg=False, rounded=False)
    for name, px in densities.items():
        save(design.resize((px, px), Image.LANCZOS),
             os.path.join(ROOT, "android/app/src/main/res",
                          f"mipmap-{name}", "ic_launcher.png"))
        # 前景层：把立绘缩小到 66% 并居中，避开系统裁切区
        inner = int(px * 2 * 0.66)
        fg = Image.new("RGBA", (px * 2, px * 2), (0, 0, 0, 0))
        small = fg_design.resize((inner, inner), Image.LANCZOS)
        off = (px * 2 - inner) // 2
        fg.paste(small, (off, off), small)
        save(fg, os.path.join(ROOT, "android/app/src/main/res",
                              f"mipmap-{name}", "ic_launcher_foreground.png"))
    print(f"  Android 图标：{len(densities)} 个密度 × 2 种")

    # 3) 自适应图标背景色
    bg_xml = os.path.join(ROOT, "android/app/src/main/res/values",
                          "ic_launcher_background.xml")
    os.makedirs(os.path.dirname(bg_xml), exist_ok=True)
    with open(bg_xml, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                '    <!-- 自适应图标背景：与图标底色一致 -->\n'
                f'    <color name="ic_launcher_background">#{"%02X%02X%02X" % BG_TOP}</color>\n'
                '</resources>\n')

    # 4) 自适应图标描述
    adaptive = os.path.join(ROOT, "android/app/src/main/res/mipmap-anydpi-v26",
                            "ic_launcher.xml")
    os.makedirs(os.path.dirname(adaptive), exist_ok=True)
    with open(adaptive, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@color/ic_launcher_background" />\n'
                '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
                '</adaptive-icon>\n')
    print("  自适应图标资源：已写入")
    print("\n完成。几何与配色均取自 mascot.js，未做任何改动。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
