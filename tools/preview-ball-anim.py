#!/usr/bin/env python3
"""逐帧预览悬浮球的动画，验证动效是否符合预期。

为什么需要：Java Canvas 的动画逻辑（相位、缩放、眨眼状态机）很容易写错，
编译通过完全不代表画出来是对的。这里用**与 BallView 完全相同的公式**
逐帧渲染，导出一张时间轴图，肉眼确认后再装到手机上。

参数必须与 FloatingBallService.BallView 保持一致；那边改了这里也要同步。
"""
import math
import os
import sys

from PIL import Image, ImageDraw

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))

# ── 与 BallView 一致的几何 ──
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

# ── 与 BallView 一致的动效参数 ──
BLINK_DURATION = 150.0
BLINK_MIN = 2200.0
BLINK_MAX = 6400.0
BREATH_PERIOD = 3400.0
GAZE_PERIOD = 7000.0
FLOAT_PERIOD = 7000.0
FRAME_MS = 33.0


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def ping_pong(t):
    return t * 2.0 if t <= 0.5 else (1.0 - t) * 2.0


def phase(base, lead):
    v = base + lead
    if v > 1.0:
        v -= 1.0
    return ping_pong(v)


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
                    col = (int(c[0]), int(c[1]), int(c[2]), int(a0 + (a1 - a0) * k))
                    break
            if col and col[3] > 0:
                px[x, y] = col
    return img


def render_frame(size, t_ms, blink_state, start_at=0.0, phase_offset=0.0):
    """按 BallView.onDraw 的顺序渲染某一时刻。t_ms 是相对开始的时间。"""
    unit = size / (OUTER_HALO_R * 2.0 + 6.0)
    cx = cy = size / 2.0

    def u(v):
        return v * unit

    def circle_layer(radius, color, scale=1.0, dx=0.0, dy=0.0):
        lay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        r = u(radius) * scale
        px_c, py_c = cx + dx, cy + dy
        ImageDraw.Draw(lay).ellipse([px_c - r, py_c - r, px_c + r, py_c + r],
                                    fill=color + (255,))
        return lay

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 0. 浮动
    ft = ((t_ms + phase_offset) % FLOAT_PERIOD) / FLOAT_PERIOD
    float_y = math.sin(ft * 2 * math.pi) * u(OUTER_DISC_R * 0.032)

    base_cy = cy
    cy = cy + float_y

    # 1. 光环
    img = Image.alpha_composite(img, radial(size, (cx, cy), u(OUTER_HALO_R), [
        (0.00, (0x8A, 0xB4, 0xFF), 0), (0.80, (0x8A, 0xB4, 0xFF), 0),
        (0.861, (0x8A, 0xB4, 0xFF), 0x28), (0.90, (0x8A, 0xB4, 0xFF), 0x1E),
        (1.00, (0x8A, 0xB4, 0xFF), 0),
    ]))

    # 2. 外盘
    disc_r = u(OUTER_DISC_R)
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gp = grad.load()
    left, top, s = cx - disc_r, cy - disc_r, disc_r * 2
    p1 = (left + s * 0.2, top)
    p2 = (left + s * 0.8, top + s)
    vx, vy = p2[0] - p1[0], p2[1] - p1[1]
    den = vx * vx + vy * vy
    for y in range(size):
        for x in range(size):
            tt = (((x - p1[0]) * vx + (y - p1[1]) * vy) / den) if den else 0
            tt = max(0.0, min(1.0, tt))
            c = lerp(C_DISC_A, C_DISC_B, tt / 0.54) if tt < 0.54 \
                else lerp(C_DISC_B, C_DISC_C, (tt - 0.54) / 0.46)
            gp[x, y] = (int(c[0]), int(c[1]), int(c[2]), 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r], fill=255)
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    disc.paste(grad, (0, 0), mask)
    img = Image.alpha_composite(img, disc)

    st = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(st).ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r],
                               outline=C_OUTER_STROKE + (255,),
                               width=max(1, int(round(u(OUTER_STROKE_W)))))
    img = Image.alpha_composite(img, st)

    # 3. 睫毛（带摆动）
    lt = ((t_ms + phase_offset) % (GAZE_PERIOD * 2)) / (GAZE_PERIOD * 2)
    lash_angle = math.sin(lt * 2 * math.pi) * 1.2

    corners = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cr = u(CORNERS_CIRCLE_R)
    ImageDraw.Draw(corners).ellipse([cx - cr, cy - cr, cx + cr, cy + cr],
                                    fill=C_CORNERS + (255,))
    half = u(CORNERS_RECT_WH) / 2
    rl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(rl).rounded_rectangle(
        [cx - half, cy - half, cx + half, cy + half],
        radius=u(CORNERS_RECT_RX), fill=C_CORNERS + (255,))
    rl = rl.rotate(-(CORNERS_RECT_ANGLE + lash_angle), resample=Image.BICUBIC, center=(cx, cy))
    corners = Image.alpha_composite(corners, rl)
    clip = Image.new("L", (size, size), 0)
    ImageDraw.Draw(clip).ellipse([cx - u(DISC_CLIP_R), cy - u(DISC_CLIP_R),
                                  cx + u(DISC_CLIP_R), cy + u(DISC_CLIP_R)], fill=255)
    corners = Image.composite(corners, Image.new("RGBA", (size, size), (0, 0, 0, 0)), clip)
    img = Image.alpha_composite(img, corners)

    # 4. 眼白 + 光晕 + 接触环
    img = Image.alpha_composite(img, circle_layer(SCLERA_R, C_SCLERA))
    img = Image.alpha_composite(img, radial(size, (cx, cy), u(SCLERA_HALO_R), [
        (0.00, (255, 255, 255), 0), (0.82, (255, 255, 255), 0),
        (0.857, (255, 255, 255), 0x38), (0.875, (255, 255, 255), 0x47),
        (0.89, (255, 255, 255), 0x30), (0.94, (255, 255, 255), 0x12),
        (1.00, (255, 255, 255), 0),
    ]))
    ct = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sr = u(SCLERA_R)
    ImageDraw.Draw(ct).ellipse([cx - sr, cy - sr, cx + sr, cy + sr],
                               outline=(255, 255, 255, 0x29),
                               width=max(1, int(round(u(SCLERA_CONTACT_W)))))
    img = Image.alpha_composite(img, ct)

    # 5. 眼球三层（呼吸）
    bp = ((t_ms) % BREATH_PERIOD) / BREATH_PERIOD
    breath = ping_pong(bp)
    sclera_scale = 0.985 + (0.91 - 0.985) * breath
    three_scale = 1.0 + (0.90 - 1.0) * phase(breath, 0.25)
    two_scale = 1.0 + (0.87 - 1.0) * phase(breath, 0.40)
    one_scale = 1.0 + (0.85 - 1.0) * phase(breath, 0.55)

    img = Image.alpha_composite(img, circle_layer(SCLERA_R, C_SCLERA, sclera_scale))
    img = Image.alpha_composite(img, circle_layer(LAYER_THREE_R, C_LAYER_THREE, three_scale))
    img = Image.alpha_composite(img, circle_layer(LAYER_TWO_A_R, C_LAYER_TWO_A, two_scale))
    img = Image.alpha_composite(img, circle_layer(LAYER_TWO_B_R, C_LAYER_TWO_B, two_scale))

    # 6. 瞳孔 + 高光（视线漂移）
    gt = ((t_ms + phase_offset) % GAZE_PERIOD) / GAZE_PERIOD
    a = gt * 2 * math.pi
    gx = math.sin(a) * 0.62 + math.sin(a * 2.3) * 0.38
    gy = math.cos(a * 0.8) * 0.55 * 0.62
    # 与 BallView 一致：45% 行程，避免瞳孔跑到眼白边缘像"翻白眼"
    travel = u(SCLERA_R - PUPIL_R - 1.0) * 0.45
    px_, py_ = cx + gx * travel, cy + gy * travel

    img = Image.alpha_composite(img, circle_layer(PUPIL_R, C_PUPIL,
                                                  1.0, px_ - cx, py_ - cy))
    hx = px_ + u(HL_X - VB / 2)
    hy = py_ + u(HL_Y - VB / 2)
    img = Image.alpha_composite(img, radial(size, (hx, hy), u(HL_HALO_R), [
        (0.00, C_HIGHLIGHT, 0), (0.53, C_HIGHLIGHT, 0),
        (0.56, C_HIGHLIGHT, 0x29), (0.611, C_HIGHLIGHT, 0x6E),
        (0.72, C_HIGHLIGHT, 0x30), (0.83, C_HIGHLIGHT, 0x0E),
        (1.00, C_HIGHLIGHT, 0),
    ]))
    hr = u(HL_R)
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse([hx - hr, hy - hr, hx + hr, hy + hr],
                               fill=C_HIGHLIGHT + (255,))
    img = Image.alpha_composite(img, hl)

    # 7. 眨眼眼睑（弧形：一个更大的深色圆下移，只有下缘进入眼白）
    if blink_state is not None and 0.0 <= blink_state <= 1.0:
        closed = ping_pong(blink_state)
        closed = closed * closed * (3 - 2 * closed)
        if closed > 0.001:
            lid_r = u(SCLERA_R) * 1.55
            lid_cy = cy - lid_r + closed * (lid_r + u(SCLERA_R) * 1.02)
            lid = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            ImageDraw.Draw(lid).ellipse(
                [cx - lid_r, lid_cy - lid_r, cx + lid_r, lid_cy + lid_r],
                fill=C_CORNERS + (255,))
            lid = Image.composite(lid, Image.new("RGBA", (size, size), (0, 0, 0, 0)), clip)
            img = Image.alpha_composite(img, lid)

    return img


def main():
    # 采样时间点：覆盖一个完整的视线周期 + 一次眨眼
    SAMPLE = 160
    moments = [
        (0, "起始"),
        (400, "呼吸/视线变化"),
        (900, "视线偏移"),
        (1700, "呼吸内收"),
        (2400, "眨眼开始"),
        (2475, "眨眼闭合"),
        (2550, "眨眼回开"),
        (3500, "呼吸外扩"),
        (4900, "视线反向"),
        (6000, "接近周期末"),
    ]

    frames = []
    for t_ms, label in moments:
        blink = None
        # 模拟眨眼状态机：在 2400ms 触发一次眨眼
        if 2400 <= t_ms <= 2400 + BLINK_DURATION:
            blink = (t_ms - 2400) / BLINK_DURATION
        f = render_frame(192, float(t_ms), blink)
        frames.append((f, label, t_ms))

    # 拼成 2 行 5 列的时间轴
    cols = 5
    rows = (len(frames) + cols - 1) // cols
    pad = 14
    label_h = 22
    W = cols * 192 + pad * (cols + 1)
    H = rows * (192 + label_h) + pad * (rows + 1)
    sheet = Image.new("RGBA", (W, H), (240, 240, 246, 255))
    draw = ImageDraw.Draw(sheet)

    for idx, (img, label, t_ms) in enumerate(frames):
        r, c = divmod(idx, cols)
        x = pad + c * (192 + pad)
        y = pad + r * (192 + label_h + pad)
        sheet.paste(img, (x, y), img)
        draw.text((x + 4, y + 192 + 4), f"{label} ({t_ms}ms)", fill=(60, 60, 70))

    out = os.path.join(ROOT, "dist", "ball-animation.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sheet.convert("RGB").save(out)
    print(f"动画预览已生成：{out}")
    print(f"  {len(frames)} 帧，覆盖眨眼与呼吸/视线周期")
    return 0


if __name__ == "__main__":
    sys.exit(main())
