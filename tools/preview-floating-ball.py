#!/usr/bin/env python3
"""预览：按 FloatingBallService.BallView 的绘制顺序还原悬浮球外观。

目的：Java Canvas 的绘制逻辑容易写错（图层顺序、裁切、坐标），
编译通过不代表画出来是对的。这里用与 BallView 完全相同的参数与顺序
在 Python 里重绘一遍，先肉眼确认，再装到手机上。

参数与顺序必须与 BallView.onDraw 保持一致；若那边改了，这里也要同步。
"""
import os
import sys

from PIL import Image, ImageDraw

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))

# ── 与 BallView 一致的几何（viewBox 160）──
VB = 160.0
OUTER_HALO_R = 79.0
OUTER_DISC_R = 68.0
OUTER_STROKE_W = 1.2
SCLERA_R = 48.0
SCLERA_HALO_R = 56.0
SCLERA_CONTACT_W = 0.8
CORNERS_CIRCLE_R = 51.75
CORNERS_RECT_WH = 86.0
CORNERS_RECT_RX = 2.0
CORNERS_RECT_ANGLE = 3.0
DISC_CLIP_R = 67.0
LAYER_THREE_R = 33.0
LAYER_TWO_A_R = 24.15
LAYER_TWO_B_R = 23.5
LAYER_ONE_R = 16.6
PUPIL_R = 16.0
HL_X, HL_Y = 98.0, 100.5
HL_R = 11.0
HL_HALO_R = 18.0

# ── 与 BallView 一致的配色 ──
C_DISC_A = (0x40, 0x53, 0xF0)
C_DISC_B = (0x30, 0x45, 0xDC)
C_DISC_C = (0x3D, 0x50, 0xC8)
C_OUTER_STROKE = (0xF2, 0xFB, 0xFF)
C_CORNERS = (0x2B, 0x33, 0x88)
C_SCLERA = (0xEE, 0xF0, 0xF5)
C_LAYER_THREE = (0x9D, 0xAE, 0xE0)
C_LAYER_TWO_A = (0xEE, 0xF0, 0xF5)
C_LAYER_TWO_B = (0x31, 0x7B, 0xCF)
C_LAYER_ONE = (0xF5, 0xF8, 0xFD)
C_PUPIL = (0x3B, 0x3D, 0x8A)
C_HIGHLIGHT = (0xF5, 0xF8, 0xFD)


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def radial(size, center, radius, stops):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    cx, cy = center
    r = float(radius)
    if r <= 0:
        return img
    for y in range(max(0, int(cy - r) - 1), min(size, int(cy + r) + 2)):
        for x in range(max(0, int(cx - r) - 1), min(size, int(cx + r) + 2)):
            d = (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / r
            if d > 1.0:
                continue
            col = None
            for i in range(len(stops) - 1):
                t0, c0, a0 = stops[i]
                t1, c1, a1 = stops[i + 1]
                if t0 <= d <= t1:
                    k = 0.0 if t1 == t0 else (d - t0) / (t1 - t0)
                    c = lerp(c0, c1, k)
                    col = (int(c[0]), int(c[1]), int(c[2]),
                           int(a0 + (a1 - a0) * k))
                    break
            if col and col[3] > 0:
                px[x, y] = col
    return img


def render(size, bg=(18, 22, 34, 255)):
    """按 BallView.onDraw 的顺序绘制。"""
    unit = size / (OUTER_HALO_R * 2.0)
    cx = cy = size / 2.0

    def u(v):
        return v * unit

    img = Image.new("RGBA", (size, size), bg)

    # 1. 外盘光环
    img = Image.alpha_composite(img, radial(size, (cx, cy), u(OUTER_HALO_R), [
        (0.00, (0x8A, 0xB4, 0xFF), 0),
        (0.80, (0x8A, 0xB4, 0xFF), 0),
        (0.861, (0x8A, 0xB4, 0xFF), 0x28),
        (0.90, (0x8A, 0xB4, 0xFF), 0x1E),
        (1.00, (0x8A, 0xB4, 0xFF), 0),
    ]))

    # 2. 外盘（线性渐变 + 白描边）
    disc_r = u(OUTER_DISC_R)
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gp = grad.load()
    left, top = cx - disc_r, cy - disc_r
    s = disc_r * 2
    p1 = (left + s * 0.2, top)
    p2 = (left + s * 0.8, top + s)
    vx, vy = p2[0] - p1[0], p2[1] - p1[1]
    den = vx * vx + vy * vy
    for y in range(size):
        for x in range(size):
            t = (((x - p1[0]) * vx + (y - p1[1]) * vy) / den) if den else 0
            t = max(0.0, min(1.0, t))
            if t < 0.54:
                c = lerp(C_DISC_A, C_DISC_B, t / 0.54)
            else:
                c = lerp(C_DISC_B, C_DISC_C, (t - 0.54) / 0.46)
            gp[x, y] = (int(c[0]), int(c[1]), int(c[2]), 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r],
                                 fill=255)
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    disc.paste(grad, (0, 0), mask)
    img = Image.alpha_composite(img, disc)

    stroke = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(stroke).ellipse(
        [cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r],
        outline=C_OUTER_STROKE + (255,),
        width=max(1, int(round(u(OUTER_STROKE_W)))))
    img = Image.alpha_composite(img, stroke)

    # 3. 四角睫毛（圆 + 旋转方块，按 r=67 裁切）
    corners = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(corners)
    cr = u(CORNERS_CIRCLE_R)
    cd.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=C_CORNERS + (255,))
    half = u(CORNERS_RECT_WH) / 2
    rl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(rl).rounded_rectangle(
        [cx - half, cy - half, cx + half, cy + half],
        radius=u(CORNERS_RECT_RX), fill=C_CORNERS + (255,))
    rl = rl.rotate(-CORNERS_RECT_ANGLE, resample=Image.BICUBIC, center=(cx, cy))
    corners = Image.alpha_composite(corners, rl)
    clip = Image.new("L", (size, size), 0)
    ImageDraw.Draw(clip).ellipse(
        [cx - u(DISC_CLIP_R), cy - u(DISC_CLIP_R),
         cx + u(DISC_CLIP_R), cy + u(DISC_CLIP_R)], fill=255)
    corners = Image.composite(corners, Image.new("RGBA", (size, size), (0, 0, 0, 0)), clip)
    img = Image.alpha_composite(img, corners)

    # 4. 眼白 + 光晕 + 接触环
    sc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sr = u(SCLERA_R)
    ImageDraw.Draw(sc).ellipse([cx - sr, cy - sr, cx + sr, cy + sr],
                               fill=C_SCLERA + (255,))
    img = Image.alpha_composite(img, sc)

    img = Image.alpha_composite(img, radial(size, (cx, cy), u(SCLERA_HALO_R), [
        (0.00, (255, 255, 255), 0), (0.82, (255, 255, 255), 0),
        (0.857, (255, 255, 255), 0x38), (0.875, (255, 255, 255), 0x47),
        (0.89, (255, 255, 255), 0x30), (0.94, (255, 255, 255), 0x12),
        (1.00, (255, 255, 255), 0),
    ]))

    ct = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(ct).ellipse([cx - sr, cy - sr, cx + sr, cy + sr],
                               outline=(255, 255, 255, 0x29),
                               width=max(1, int(round(u(SCLERA_CONTACT_W)))))
    img = Image.alpha_composite(img, ct)

    # 5. 眼球三层
    for r, col in [(LAYER_THREE_R, C_LAYER_THREE),
                   (LAYER_TWO_A_R, C_LAYER_TWO_A),
                   (LAYER_TWO_B_R, C_LAYER_TWO_B)]:
        lay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        rr = u(r)
        ImageDraw.Draw(lay).ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                                    fill=col + (255,))
        img = Image.alpha_composite(img, lay)

    l1 = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    lr = u(LAYER_ONE_R)
    ImageDraw.Draw(l1).ellipse([cx - lr, cy - lr, cx + lr, cy + lr],
                               outline=C_LAYER_ONE + (255,),
                               width=max(1, int(round(u(0.1)))))
    img = Image.alpha_composite(img, l1)

    # 6. 瞳孔 + 高光
    pu = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pr = u(PUPIL_R)
    ImageDraw.Draw(pu).ellipse([cx - pr, cy - pr, cx + pr, cy + pr],
                               fill=C_PUPIL + (255,))
    img = Image.alpha_composite(img, pu)

    hx = cx + u(HL_X - VB / 2)
    hy = cy + u(HL_Y - VB / 2)
    img = Image.alpha_composite(img, radial(size, (hx, hy), u(HL_HALO_R), [
        (0.00, C_HIGHLIGHT, 0), (0.53, C_HIGHLIGHT, 0),
        (0.56, C_HIGHLIGHT, 0x29), (0.611, C_HIGHLIGHT, 0x6E),
        (0.72, C_HIGHLIGHT, 0x30), (0.83, C_HIGHLIGHT, 0x0E),
        (1.00, C_HIGHLIGHT, 0),
    ]))
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hr = u(HL_R)
    ImageDraw.Draw(hl).ellipse([hx - hr, hy - hr, hx + hr, hy + hr],
                               fill=C_HIGHLIGHT + (255,))
    img = Image.alpha_composite(img, hl)
    return img


def main():
    # 模拟：64dp 球在 3x 屏上约 192px；收起后露出 32dp（一半）
    full = render(192)
    out = os.path.join(ROOT, "dist", "ball-preview.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    # 并排展示：完整球 / 收起状态（右侧被裁掉一半）
    sheet = Image.new("RGBA", (192 + 20 + 192 + 20, 192 + 40), (245, 245, 248, 255))
    sheet.paste(full, (20, 20), full)
    collapsed = full.copy()
    # 模拟贴右边缘：只保留左半（露出的部分）
    left_half = collapsed.crop((0, 0, 96, 192))
    sheet.paste(left_half, (232, 20), left_half)
    sheet.convert("RGB").save(out)
    print(f"预览已生成：{out}")
    print("  左 = 完整悬浮球（64dp @3x ≈ 192px）")
    print("  右 = 贴边收起后露出的部分（约一半）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
