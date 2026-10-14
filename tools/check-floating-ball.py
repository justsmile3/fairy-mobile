#!/usr/bin/env python3
"""校验悬浮球的尺寸与吸附逻辑（静态检查 Java 源码）。

为什么需要：悬浮球的核心诉求是「小但看得见」和「贴边收起一半」，
这两点都由常量决定，一旦被误改就会破坏体验（比如收起后完全看不见）。
这里把关键约束固化成断言。

用法：python tools/check-floating-ball.py
"""
import os
import re
import sys

SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "android", "app", "src", "main", "java", "com", "fairy", "mobile",
    "FloatingBallService.java",
)
MANIFEST = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "android", "app", "src", "main", "AndroidManifest.xml",
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def const(src, name):
    """取出 `static final int NAME = 12;` 的数值"""
    m = re.search(r"static\s+final\s+int\s+" + re.escape(name) + r"\s*=\s*(\d+)", src)
    return int(m.group(1)) if m else None


def main():
    if not os.path.exists(SRC):
        print(f"✗ 找不到 {SRC}")
        return 1
    src = open(SRC, encoding="utf-8").read()
    manifest = open(MANIFEST, encoding="utf-8").read()

    checks = []

    ball = const(src, "BALL_DP")
    peek = const(src, "PEEK_DP")
    snap = const(src, "EDGE_SNAP_DP")

    # 1. 尺寸：不能太小（看不清/点不中），也不能太大（挡视野）
    #    悬浮球绘制的是立绘（睫毛、眼球三层、瞳孔），细节需要足够尺寸才认得出，
    #    但也要小于系统图标（72dp）以免挡内容。区间取 48–72。
    checks.append((
        "完整直径在合理区间",
        ball is not None and 48 <= ball <= 72,
        f"BALL_DP={ball}（期望 48–72）",
    ))

    # 2. 收起后必须仍然可见 —— 这是用户明确要求的「不能看不见」
    #    立绘细节（瞳孔）约 10dp 才认得出，所以露出的宽度不能太小。
    checks.append((
        "收起后仍露出一部分（不会完全消失）",
        peek is not None and peek >= 24,
        f"PEEK_DP={peek}（期望 ≥24，否则看不清立绘）",
    ))

    # 3. 「收起成半个大小」：露出宽度应约为直径的一半
    half_ok = (ball is not None and peek is not None
               and abs(peek / ball - 0.5) <= 0.12)
    checks.append((
        "收起宽度约为完整的一半",
        half_ok,
        f"{peek}/{ball} = {peek / ball:.2f}（期望 ≈0.5）",
    ))

    # 4. peek 必须小于 ball，否则谈不上「收起」
    checks.append((
        "收起后确实变窄了",
        ball is not None and peek is not None and peek < ball,
        f"PEEK_DP({peek}) < BALL_DP({ball})",
    ))

    # 5. 吸附阈值要够大，否则用户很难精准拖到边缘
    checks.append((
        "贴边吸附阈值合理",
        snap is not None and 16 <= snap <= 48,
        f"EDGE_SNAP_DP={snap}（期望 16–48）",
    ))

    # 6. 收起时左边缘的 x 必须为负（滑出屏外），右边缘必须超出右边界
    has_left = "-(ballSizePx - peekPx)" in src
    has_right = "screenWidth - peekPx" in src
    checks.append((
        "左右边缘的收起位置计算正确",
        has_left and has_right,
        f"左侧负偏移={has_left} 右侧超出={has_right}",
    ))

    # 7. 展开时应收回到完全可见的位置
    checks.append((
        "展开时回到完全可见位置",
        "screenWidth - ballSizePx" in src and "dockedLeft ? 0 :" in src,
        "展开位置计算",
    ))

    # 8. 拖动阈值：避免手抖被当成拖动、或拖动被当成点击
    slop = const(src, "TOUCH_SLOP_PX")
    checks.append((
        "拖动判定阈值合理",
        slop is not None and 4 <= slop <= 32,
        f"TOUCH_SLOP_PX={slop}",
    ))

    # 9. 必须带 FLAG_NOT_FOCUSABLE，否则悬浮窗会抢走输入法焦点
    checks.append((
        "悬浮窗不抢焦点（否则会打断输入法）",
        "FLAG_NOT_FOCUSABLE" in src,
        "FLAG_NOT_FOCUSABLE",
    ))

    # 10. 必须能滑出屏幕外，否则「收起一半」无法实现
    checks.append((
        "允许窗口延伸到屏幕外",
        "FLAG_LAYOUT_NO_LIMITS" in src,
        "FLAG_LAYOUT_NO_LIMITS",
    ))

    # 11. Android 8+ 必须用 TYPE_APPLICATION_OVERLAY
    checks.append((
        "使用正确的悬浮窗类型",
        "TYPE_APPLICATION_OVERLAY" in src and "TYPE_PHONE" in src,
        "O+ 用 APPLICATION_OVERLAY，以下用 PHONE",
    ))

    # 12. 转屏后要重新计算并拉回可见区域，否则球会跑到屏幕外
    checks.append((
        "转屏后重新吸附，避免球跑出屏幕",
        "onConfigurationChanged" in src and "clampIntoView" in src,
        "onConfigurationChanged + clampIntoView",
    ))

    # 13. manifest 声明
    checks.append((
        "已声明 SYSTEM_ALERT_WINDOW 权限",
        "SYSTEM_ALERT_WINDOW" in manifest,
        "manifest",
    ))
    checks.append((
        "已注册悬浮球服务",
        "FloatingBallService" in manifest and "foregroundServiceType" in manifest,
        "manifest service",
    ))
    checks.append((
        "服务不被任务栈关闭带走",
        'android:stopWithTask="false"' in manifest,
        "stopWithTask=false",
    ))

    # 14. 所有触摸分支都要有异常保护（悬浮窗里抛异常会直接崩服务）
    checks.append((
        "触摸处理有异常保护",
        "catch (Throwable e)" in src and "触摸处理异常" in src,
        "onTouch try/catch",
    ))

    # 15. ★ 关键防回归：绝不能再用前台服务。
    #
    # 真机崩溃记录（Xiaomi / Android 15）：
    #   ForegroundServiceDidNotStartInTimeException
    #   Context.startForegroundService() did not then call Service.startForeground()
    #
    # 悬浮球要向 WindowManager 注册窗口，这一步在部分 ROM 上可能慢，
    # 一旦超过 5 秒就触发该异常直接崩溃。因此改为普通服务 + 常驻通知。
    #
    # 判断时先剥掉注释，避免把说明文字里的 API 名当成真实调用。
    code_only = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    code_only = re.sub(r"//[^\n]*", "", code_only)
    # 去掉字符串字面量，避免日志文本触发误判
    code_only = re.sub(r'"(?:[^"\\]|\\.)*"', '""', code_only)

    uses_fgs = "startForegroundService" in code_only
    uses_start_fg = re.search(r"\.startForeground\s*\(", code_only) is not None
    checks.append((
        "不使用前台服务（避免 5 秒超时崩溃）",
        not uses_fgs and not uses_start_fg,
        f"startForegroundService={uses_fgs} startForeground={uses_start_fg}",
    ))

    # 16. manifest 里也不能声明前台服务类型（否则会要求走前台流程）
    #     先剥掉 XML 注释，避免说明文字里的属性名造成误判。
    manifest_code = re.sub(r"<!--.*?-->", "", manifest, flags=re.S)
    checks.append((
        "manifest 未声明 foregroundServiceType",
        "foregroundServiceType" not in manifest_code,
        "foregroundServiceType",
    ))

    # 17. 服务被停止时要撤销通知，否则用户关掉后残留一条
    checks.append((
        "服务销毁时移除常驻通知",
        "nm.cancel(NOTIFICATION_ID)" in src,
        "onDestroy -> cancel",
    ))

    # 18. 通知本身必须容错（用户禁用通知权限时不能崩）
    checks.append((
        "通知失败不影响悬浮球",
        "通知显示失败" in src or "常驻通知显示失败" in src,
        "showPersistentNotification try/catch",
    ))

    # 19. onCreate 里不能有耗时操作排在任何关键调用之前
    create_start = src.find("public void onCreate()")
    if create_start >= 0:
        create_body = src[create_start:create_start + 1400]
        # createBall 与 addView 都应在 try 块内
        in_try = "try {" in create_body and "createBall();" in create_body
        checks.append((
            "onCreate 的窗口注册有异常保护",
            in_try,
            "createBall 在 try 块内",
        ))
    else:
        checks.append(("onCreate 的窗口注册有异常保护", False, "未找到 onCreate"))

    # 20. ★ 关键防回归：Service 里绝不能调用 Context#getDisplay()。
    #
    # 真机崩溃记录（Xiaomi / Android 15）：
    #   UnsupportedOperationException: Tried to obtain display from a Context
    #   not associated with one.
    #
    # Service 属于后台实体，不是 visual Context，没有关联的 Display。
    # 必须改用 WindowManager#getCurrentWindowMetrics（API 30+）。
    #
    # 注意：不能用简单的 "getDisplay()" not in code 判断 ——
    # getResources().getDisplayMetrics() 是安全的，但子串匹配会误伤它。
    # 这里用正则精确匹配方法调用，排除 getDisplayMetrics。
    bad_display_call = re.search(r"getDisplay\s*\(\s*\)", code_only) is not None
    checks.append((
        "未在 Service 中调用 getDisplay()（会抛 UnsupportedOperationException）",
        not bad_display_call,
        "应使用 WindowManager#getCurrentWindowMetrics",
    ))

    # 21. 取屏幕尺寸必须有多层降级，任何一层失败都不能崩
    has_metrics = "getCurrentWindowMetrics" in code_only
    has_default = "getDefaultDisplay" in code_only
    has_fallback = "getResources().getDisplayMetrics" in code_only
    checks.append((
        "屏幕尺寸获取有多层降级",
        has_metrics and has_default and has_fallback,
        f"WindowMetrics={has_metrics} DefaultDisplay={has_default} Resources={has_fallback}",
    ))

    # 22. 尺寸必须有兜底值，避免 0 导致窗口无法创建
    checks.append((
        "屏幕尺寸有兜底值",
        "screenWidth = w > 0 ? w :" in src and "screenHeight = h > 0 ? h :" in src,
        "w/h <= 0 时使用默认分辨率",
    ))

    # 23. ★ 悬浮球必须绘制 Fairy 的立绘，而不是随便一个图形。
    #
    # 立绘的关键图层：外盘渐变、四角睫毛、眼球三层、瞳孔、高光。
    # 少任何一层都不再是 Fairy 的形象。
    design_layers = [
        ("外盘渐变色", "C_DISC_A" in src and "C_DISC_B" in src and "C_DISC_C" in src),
        ("四角睫毛", "C_CORNERS" in src and "CORNERS_CIRCLE_R" in src),
        ("眼白", "C_SCLERA" in src),
        ("眼球三层", "C_LAYER_THREE" in src and "C_LAYER_TWO_A" in src
                     and "C_LAYER_TWO_B" in src),
        ("瞳孔", "C_PUPIL" in src),
        ("高光", "C_HIGHLIGHT" in src),
    ]
    missing_layers = [n for n, ok in design_layers if not ok]
    checks.append((
        "悬浮球绘制 Fairy 立绘（含全部图层）",
        not missing_layers,
        "齐全" if not missing_layers else f"缺少：{', '.join(missing_layers)}",
    ))

    # 24. 立绘的配色必须与 mascot.js 一致（防止被改成别的颜色）
    palette = {
        "外盘主色 #4053f0": "0xFF4053F0" in src,
        "外盘次色 #3045dc": "0xFF3045DC" in src,
        "睫毛   #2b3388": "0xFF2B3388" in src,
        "眼白   #eef0f5": "0xFFEEF0F5" in src,
        "瞳孔   #3b3d8a": "0xFF3B3D8A" in src,
    }
    wrong = [n for n, ok in palette.items() if not ok]
    checks.append((
        "悬浮球配色与立绘一致",
        not wrong,
        "一致" if not wrong else f"不符：{', '.join(wrong)}",
    ))

    # 输出
    print("")
    print("悬浮球逻辑校验（尺寸 / 吸附 / 健壮性）")
    print("─" * 58)
    failed = 0
    for name, ok, detail in checks:
        if not ok:
            failed += 1
        print(f"  {'✓' if ok else '✗'} {name}")
        if detail:
            print(f"      {detail}")
    print("─" * 58)
    print(f"通过 {len(checks) - failed} / {len(checks)}")
    print("")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
