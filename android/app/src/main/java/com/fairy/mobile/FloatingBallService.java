package com.fairy.mobile;

import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;

/**
 * 悬浮球服务：常驻的语音唤醒入口。
 *
 * 为什么用悬浮窗替代后台监听唤醒词：
 *   后台常驻监听需要一直占用麦克风与一个前台服务，耗电、且各家 ROM 会限制；
 *   悬浮窗只是「一个可点的小球」，代价低得多，用户点一下即开始说话，
 *   交互也更明确（不用猜唤醒词有没有被听到）。
 *
 * 交互设计：
 *   - 常驻一个小球，可拖动
 *   - 拖到屏幕左/右边缘松手 → 自动收起成「半个」（滑出屏外一半）
 *   - 收起状态下点一下 → 展开回完整大小
 *   - 点一下（完整状态）→ 开始录音，识别结果送回 Fairy 主界面
 *
 * 尺寸取舍（用户要求「小但又不能看不见」）：
 *   完整直径 52dp，收起后露出 26dp（正好一半）。
 *   52dp 在 2x 屏上约 104px，比系统返回手势条更醒目，但不会挡住内容。
 */
public class FloatingBallService extends Service {

    private static final String TAG = "FairyFloat";
    private static final String CHANNEL_ID = "fairy_floating_ball";
    private static final int NOTIFICATION_ID = 4201;

    /**
     * 完整直径（dp）。
     *
     * 从 52dp 提到 64dp：悬浮球现在绘制的是立绘（外盘 + 睫毛 + 眼球三层 + 瞳孔 + 高光），
     * 52dp 下瞳孔直径只有约 5dp、睫毛层次会糊成一团，既看不清也不好看。
     * 64dp 能让立绘的层次分辨出来，同时仍小于系统默认图标（72dp），不至于挡视野。
     */
    private static final int BALL_DP = 64;
    /**
     * 收起后**仍露出**的宽度（dp）——正好一半。
     *
     * 这是「隐藏成半个大小」与「不能看不见」两条要求的交点：
     * 露出 32dp 足以看清是 Fairy 的眼睛，也够手指点中。
     */
    private static final int PEEK_DP = 32;
    /** 判定为「贴边」的距离（dp）：拖到离边缘这么近就吸附 */
    private static final int EDGE_SNAP_DP = 24;
    /** 移动超过这个距离（px）就不算点击，避免拖动误触 */
    private static final int TOUCH_SLOP_PX = 12;

    private WindowManager windowManager;
    private WindowManager.LayoutParams params;
    private BallView ball;

    private int screenWidth;
    private int screenHeight;
    private int ballSizePx;
    private int peekPx;

    /** 当前是否已贴边收起 */
    private boolean collapsed = false;
    /** 停在左边缘还是右边缘 */
    private boolean dockedLeft = false;

    private final Handler handler = new Handler(Looper.getMainLooper());

    /** 供主界面查询与联动（同进程静态字段） */
    static volatile boolean running = false;
    static volatile String statusText = "";
    /** 最近一次失败的详细信息，便于在设置界面直接看到原因 */
    static volatile String lastError = "";

    @Override
    public void onCreate() {
        super.onCreate();

        // 这里**不做**任何耗时操作，也不调用 startForeground()。
        //
        // 历史教训（真机崩溃 ForegroundServiceDidNotStartInTimeException，
        // Xiaomi / Android 15）：
        //   Context.startForegroundService() 要求 5 秒内调用 startForeground()，
        //   否则直接崩溃。悬浮球要向 WindowManager 注册窗口，这一步在部分 ROM 上
        //   可能慢或失败，一旦超过 5 秒就触发该异常。
        //
        // 因此改为**完全不使用前台服务**：
        //   悬浮球只是一个窗口 + 一个普通 Service，用一条常驻通知提升存活率。
        //   它不需要麦克风、定位等受限的前台服务类型，也就没有 5 秒限制与
        //   类型校验的问题。
        running = true;
        try {
            windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (windowManager == null) {
                throw new IllegalStateException("WindowManager 不可用");
            }
            updateScreenMetrics();
            if (screenWidth <= 0 || screenHeight <= 0) {
                throw new IllegalStateException(
                        "屏幕尺寸异常：" + screenWidth + "x" + screenHeight);
            }
            createBall();
            showPersistentNotification();
            lastError = "";
            statusText = "悬浮球已启动";
            Log.i(TAG, "悬浮球已启动，" + screenWidth + "x" + screenHeight
                    + " 球径 " + ballSizePx + "px");
        } catch (Throwable e) {
            Log.e(TAG, "悬浮球创建失败", e);
            // 把原因写清楚：最常见的两种是权限没真正生效、以及窗口类型不被 ROM 接受
            String reason = describe(e);
            if (!canDrawOverlay(this)) {
                reason = "未获得悬浮窗权限（" + reason + "）";
            } else if (e instanceof WindowManager.BadTokenException) {
                reason = "系统拒绝了悬浮窗（请确认已允许「显示在其他应用上层」）：" + reason;
            }
            lastError = reason;
            statusText = "启动失败：" + reason;
            running = false;
            try { stopSelf(); } catch (Throwable ignored) { }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 常驻：被系统杀掉后尽量恢复
        return START_STICKY;
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 转屏后重新计算边界，并把球拉回可见区域
        try {
            updateScreenMetrics();
            if (ball != null && params != null) {
                clampIntoView();
                if (collapsed) applyCollapsedPosition(false);
                windowManager.updateViewLayout(ball, params);
            }
        } catch (Throwable ignored) { }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        try {
            if (ball != null && windowManager != null) {
                windowManager.removeView(ball);
            }
        } catch (Throwable ignored) { }
        ball = null;
        // 移除常驻通知，避免用户关掉后还留着一条
        try {
            NotificationManager nm = (NotificationManager)
                    getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
        } catch (Throwable ignored) { }
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    /* ── 初始化 ───────────────────────────────────────── */

    /**
     * 取屏幕尺寸。
     *
     * ⚠ 这里曾因 `getDisplay()` 崩溃（真机日志）：
     *   UnsupportedOperationException: Tried to obtain display from a Context
     *   not associated with one.
     *
     * 原因：Service 属于「后台实体」，不是 visual Context，
     * 没有关联的 Display，因此在 Service 里调用 Context#getDisplay() 会抛异常。
     *
     * 正确做法按优先级：
     *   1. API 30+：WindowManager#getCurrentWindowMetrics（官方推荐）
     *   2. WindowManager#getDefaultDisplay（各版本可用，但 API 30+ 已废弃）
     *   3. 兜底：Resources#getDisplayMetrics（拿不到真实分辨率，但不会崩）
     *
     * 任何一层失败都继续往下降级，保证绝不抛异常。
     */
    private void updateScreenMetrics() {
        int w = 0, h = 0;

        // 1) API 30+ 的官方方式
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                android.graphics.Rect b = windowManager.getCurrentWindowMetrics().getBounds();
                w = b.width();
                h = b.height();
            } catch (Throwable e) {
                Log.w(TAG, "getCurrentWindowMetrics 失败，降级", e);
            }
        }

        // 2) 传统的 getDefaultDisplay
        if (w <= 0 || h <= 0) {
            try {
                DisplayMetrics dm = new DisplayMetrics();
                windowManager.getDefaultDisplay().getRealMetrics(dm);
                w = dm.widthPixels;
                h = dm.heightPixels;
            } catch (Throwable e) {
                Log.w(TAG, "getDefaultDisplay 失败，降级", e);
            }
        }

        // 3) 兜底：资源里的尺寸（在部分设备上是可用区域，但足以让球落在屏幕内）
        if (w <= 0 || h <= 0) {
            try {
                DisplayMetrics dm = getResources().getDisplayMetrics();
                w = dm.widthPixels;
                h = dm.heightPixels;
            } catch (Throwable e) {
                Log.e(TAG, "无法获取屏幕尺寸", e);
            }
        }

        screenWidth = w > 0 ? w : 1080;
        screenHeight = h > 0 ? h : 1920;
        ballSizePx = dp(BALL_DP);
        peekPx = dp(PEEK_DP);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void createBall() {
        ball = new BallView(this);
        ball.setOnTouchListener(new BallTouchListener());

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        params = new WindowManager.LayoutParams(
                ballSizePx, ballSizePx,
                type,
                // 不可聚焦：这样不会抢走输入法焦点；FLAG_LAYOUT_NO_LIMITS 允许滑出屏幕外
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        // 初始位置：右侧中部偏下（拇指容易够到，又不挡常用区域）
        params.x = screenWidth - ballSizePx - dp(6);
        params.y = (int) (screenHeight * 0.62f);
        // 允许窗口延伸到状态栏/刘海区域之外
        if (Build.VERSION.SDK_INT >= 28) {
            params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        windowManager.addView(ball, params);
        statusText = "悬浮球已启动";
    }

    /**
     * 显示一条常驻通知。
     *
     * 注意：这里**不用** startForeground() —— 见 onCreate 的说明。
     * 普通通知同样能提升服务存活率，但没有 5 秒限制与前台服务类型校验。
     */
    private void showPersistentNotification() {
        try {
            createChannel();
            Intent open = new Intent(this, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(
                    this, 0, open,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setContentTitle("Fairy 悬浮球已开启")
             .setContentText("点小球即可说话")
             .setSmallIcon(android.R.drawable.ic_btn_speak_now)
             .setContentIntent(pi)
             .setOngoing(true);
            if (Build.VERSION.SDK_INT >= 21) {
                b.setColor(0xFF7C5CFF);
            }

            NotificationManager nm = (NotificationManager)
                    getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIFICATION_ID, b.build());
            }
        } catch (Throwable e) {
            // 通知失败完全不影响悬浮球本身（例如用户禁用了通知权限）
            Log.w(TAG, "常驻通知显示失败（悬浮球仍可用）", e);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Fairy 悬浮球", NotificationManager.IMPORTANCE_MIN);
        ch.setDescription("保持悬浮球常驻，便于随时语音输入");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    /* ── 位置与吸附 ───────────────────────────────────── */

    /** 把球限制在屏幕内（完整显示） */
    private void clampIntoView() {
        int maxX = Math.max(0, screenWidth - ballSizePx);
        int maxY = Math.max(0, screenHeight - ballSizePx);
        params.x = Math.max(0, Math.min(params.x, maxX));
        params.y = Math.max(0, Math.min(params.y, maxY));
    }

    private int edgeThresholdPx() {
        return dp(EDGE_SNAP_DP);
    }

    /**
     * 松手后决定是否贴边。
     * 判定：球中心落在距离左/右边缘 threshold 之内 → 贴该边并收起一半。
     */
    private void settleAfterDrag() {
        int centerX = params.x + ballSizePx / 2;
        int threshold = edgeThresholdPx();

        boolean nearLeft = centerX <= threshold;
        boolean nearRight = centerX >= screenWidth - threshold;

        if (nearLeft || nearRight) {
            dockedLeft = nearLeft;
            setCollapsed(true, true);
        } else {
            // 不在边缘：保持完整大小，但不要把半个球留在屏幕外
            if (collapsed) setCollapsed(false, true);
            clampIntoView();
            safeUpdate();
        }
    }

    /**
     * 收起 / 展开。
     *
     * 收起时球有一半滑出屏幕外，但**始终露出 peekPx**，
     * 这样既满足「隐藏成半个大小」，又不会真的看不见。
     */
    private void setCollapsed(boolean wantCollapsed, boolean animate) {
        collapsed = wantCollapsed;
        applyCollapsedPosition(animate);
    }

    private void applyCollapsedPosition(boolean animate) {
        int targetX;
        if (collapsed) {
            // 露出 peekPx：左侧贴边时 x 为负（左半滑出），右侧贴边时 x 超出右边界
            targetX = dockedLeft
                    ? -(ballSizePx - peekPx)
                    : screenWidth - peekPx;
        } else {
            targetX = dockedLeft ? 0 : Math.max(0, screenWidth - ballSizePx);
        }

        if (!animate) {
            params.x = targetX;
            ball.setAlpha(collapsed ? 0.92f : 1f);
            safeUpdate();
            return;
        }

        final int fromX = params.x;
        ValueAnimator anim = ValueAnimator.ofInt(fromX, targetX);
        anim.setDuration(collapsed ? 220 : 180);
        anim.setInterpolator(new DecelerateInterpolator());
        anim.addUpdateListener(a -> {
            try {
                params.x = (int) a.getAnimatedValue();
                safeUpdate();
            } catch (Throwable ignored) { }
        });
        anim.start();

        // 收起后略微降低不透明度，减少对内容的干扰；展开时恢复
        ball.animate()
                .alpha(collapsed ? 0.92f : 1f)
                .setDuration(collapsed ? 220 : 180)
                .start();
    }

    private void safeUpdate() {
        try {
            if (ball != null && ball.isAttachedToWindow()) {
                windowManager.updateViewLayout(ball, params);
            }
        } catch (Throwable ignored) { }
    }

    /* ── 触摸交互 ─────────────────────────────────────── */

    private class BallTouchListener implements View.OnTouchListener {
        private int startX, startY;       // 触摸点（原始坐标）
        private int startParamX, startParamY;
        private boolean dragging = false;
        private long downTime = 0;

        @Override
        public boolean onTouch(View v, MotionEvent event) {
            try {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = (int) event.getRawX();
                        startY = (int) event.getRawY();
                        startParamX = params.x;
                        startParamY = params.y;
                        dragging = false;
                        downTime = System.currentTimeMillis();
                        return true;

                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) event.getRawX() - startX;
                        int dy = (int) event.getRawY() - startY;
                        if (!dragging && Math.hypot(dx, dy) > TOUCH_SLOP_PX) {
                            dragging = true;
                            // 开始拖动就恢复完整大小，便于看清位置
                            if (collapsed) {
                                collapsed = false;
                                int w = ballSizePx;
                                params.width = w;
                                ball.requestLayout();
                            }
                        }
                        if (dragging) {
                            int newX = startParamX + dx;
                            int newY = startParamY + dy;
                            // 拖动过程中允许超出边缘一点，松手再吸附
                            int limit = ballSizePx / 2;
                            params.x = Math.max(-limit, Math.min(newX, screenWidth - ballSizePx + limit));
                            params.y = Math.max(0, Math.min(newY, screenHeight - ballSizePx));
                            safeUpdate();
                        }
                        return true;
                    }

                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL: {
                        long elapsed = System.currentTimeMillis() - downTime;
                        if (dragging) {
                            settleAfterDrag();
                        } else if (elapsed < 600) {
                            // 视为点击
                            onBallTapped();
                        }
                        dragging = false;
                        return true;
                    }
                    default:
                        return false;
                }
            } catch (Throwable e) {
                Log.w(TAG, "触摸处理异常", e);
                return false;
            }
        }
    }

    /** 点击球：收起状态下先展开；完整状态下开始语音输入 */
    private void onBallTapped() {
        if (collapsed) {
            setCollapsed(false, true);
            return;
        }
        startVoiceInput();
    }

    /**
     * 开始一次语音输入。
     * 做法：把主界面拉到前台，并置一个「请求语音输入」标志，
     * 由 MainActivity 在 onResume 时读取并触发语音面板。
     *
     * 为什么不由悬浮窗自己录音：录音需要主界面里的权限与识别逻辑，
     * 集中在一处维护更可靠，也避免两份识别代码产生分歧。
     */
    private void startVoiceInput() {
        try {
            VoiceRequest.pending = true;
            ball.pulse();

            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            intent.putExtra(MainActivity.EXTRA_FROM_FLOATING_BALL, true);
            startActivity(intent);
            statusText = "已唤起语音输入";
        } catch (Throwable e) {
            Log.e(TAG, "唤起主界面失败", e);
            statusText = "唤起失败：" + describe(e);
        }
    }

    private static String describe(Throwable e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null ? "" : "：" + m);
    }

    /* ── 静态控制入口（供设置界面调用）───────────────── */

    /** 是否已获得悬浮窗权限 */
    public static boolean canDrawOverlay(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                return Settings.canDrawOverlays(ctx);
            }
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 启动悬浮球服务。
     *
     * 用普通 startService 而非 startForegroundService：
     * 调用方始终是前台的 Activity（用户在设置里点开关），
     * 满足 Android 8+ 对后台启动服务的限制，同时避开前台服务的
     * 5 秒限制与类型校验（后者曾导致真机崩溃）。
     */
    public static void start(Context ctx) {
        try {
            Intent i = new Intent(ctx, FloatingBallService.class);
            ctx.startService(i);
        } catch (Throwable e) {
            Log.e(TAG, "启动悬浮球服务失败", e);
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, FloatingBallService.class));
        } catch (Throwable ignored) { }
    }

    /* ── 悬浮球视图 ───────────────────────────────────── */

    /**
     * 悬浮球：按 App 内立绘（js/mascot.js）原样绘制。
     *
     * 立绘是一枚「圆形眼睛」，图层顺序（从底到顶）：
     *   1. 外盘光环      r=79    柔光
     *   2. 外盘          r=68    线性渐变 #4053f0 → #3045dc → #3d50c8，白描边 1.2
     *   3. 四角睫毛      #2b3388 圆(r=51.75) + 旋转 3° 的方块(rx=2)，按 r=67 裁切
     *   4. 眼白          r=48    #eef0f5 + 巩膜光晕 + 接触环
     *   5. 眼球三层      #9daee0(33) → #eef0f5(24.15) → #317bcf(23.5)
     *   6. 瞳孔 + 高光   #3b3d8a(16)，高光在 (98,100.5) r=11
     *
     * 用代码绘制而非图片资源：体积为零，且能精确还原矢量立绘。
     * 所有几何值都以 160 为基准按比例缩放，改球径不会破坏比例。
     */
    private static class BallView extends View {

        /* 立绘的几何（viewBox 160，原样取自 mascot.js 的 G） */
        private static final float VB = 160f;
        private static final float OUTER_HALO_R = 79f;
        private static final float OUTER_DISC_R = 68f;
        private static final float OUTER_STROKE_W = 1.2f;
        private static final float SCLERA_R = 48f;
        private static final float SCLERA_HALO_R = 56f;
        private static final float SCLERA_CONTACT_W = 0.8f;
        private static final float CORNERS_CIRCLE_R = 51.75f;
        private static final float CORNERS_RECT_XY = 37f;
        private static final float CORNERS_RECT_WH = 86f;
        private static final float CORNERS_RECT_RX = 2f;
        private static final float CORNERS_RECT_ANGLE = 3f;
        private static final float DISC_CLIP_R = 67f;
        private static final float LAYER_THREE_R = 33f;
        private static final float LAYER_TWO_A_R = 24.15f;
        private static final float LAYER_TWO_B_R = 23.5f;
        private static final float LAYER_ONE_R = 16.6f;
        private static final float PUPIL_R = 16f;
        private static final float HL_X = 98f;
        private static final float HL_Y = 100.5f;
        private static final float HL_R = 11f;
        private static final float HL_HALO_R = 18f;

        /* 立绘的配色 */
        private static final int C_DISC_A = 0xFF4053F0;
        private static final int C_DISC_B = 0xFF3045DC;
        private static final int C_DISC_C = 0xFF3D50C8;
        private static final int C_OUTER_STROKE = 0xFFF2FBFF;
        private static final int C_CORNERS = 0xFF2B3388;
        private static final int C_SCLERA = 0xFFEEF0F5;
        private static final int C_LAYER_THREE = 0xFF9DAEE0;
        private static final int C_LAYER_TWO_A = 0xFFEEF0F5;
        private static final int C_LAYER_TWO_B = 0xFF317BCF;
        private static final int C_LAYER_ONE = 0xFFF5F8FD;
        private static final int C_PUPIL = 0xFF3B3D8A;
        private static final int C_HIGHLIGHT = 0xFFF5F8FD;

        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float pulseScale = 1f;
        /** 单位换算：1 个 viewBox 单位等于多少像素 */
        private float unit;
        private float cx, cy;

        BallView(Context ctx) {
            super(ctx);
            fill.setStyle(Paint.Style.FILL);
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeCap(Paint.Cap.ROUND);
            halo.setStyle(Paint.Style.FILL);
            setLayerType(LAYER_TYPE_SOFTWARE, null);
        }

        private float dpLocal(float v) {
            return v * getResources().getDisplayMetrics().density;
        }

        /** viewBox 单位 → 像素 */
        private float u(float v) {
            return v * unit;
        }

        @Override
        protected void onSizeChanged(int w, int h, int oldw, int oldh) {
            super.onSizeChanged(w, h, oldw, oldh);
            cx = w / 2f;
            cy = h / 2f;
            // 留一点边距给外盘光环（79 是最大半径），保证不被裁掉
            unit = Math.min(w, h) / (OUTER_HALO_R * 2f);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (unit <= 0) return;
            final float discR = u(OUTER_DISC_R);

            // ── 1. 外盘光环 ──
            halo.setShader(new android.graphics.RadialGradient(cx, cy, u(OUTER_HALO_R),
                    new int[]{0x00000000, 0x00000000, 0x288AB4FF, 0x1E8AB4FF, 0x00000000},
                    new float[]{0f, 0.80f, 0.861f, 0.90f, 1f},
                    Shader.TileMode.CLAMP));
            canvas.drawCircle(cx, cy, u(OUTER_HALO_R), halo);
            halo.setShader(null);

            // ── 2. 外盘（线性渐变 + 白描边）──
            // 立绘的 linearGradient x1=.2 y1=0 x2=.8 y2=1 是相对外盘包围盒的
            float left = cx - discR, top = cy - discR, size = discR * 2f;
            fill.setShader(new android.graphics.LinearGradient(
                    left + size * 0.2f, top,
                    left + size * 0.8f, top + size,
                    new int[]{C_DISC_A, C_DISC_B, C_DISC_C},
                    new float[]{0f, 0.54f, 1f},
                    Shader.TileMode.CLAMP));
            canvas.drawCircle(cx, cy, discR, fill);
            fill.setShader(null);

            stroke.setColor(C_OUTER_STROKE);
            stroke.setStrokeWidth(Math.max(1f, u(OUTER_STROKE_W)));
            canvas.drawCircle(cx, cy, discR - u(OUTER_STROKE_W) / 2f, stroke);

            // ── 3. 四角睫毛（圆 + 旋转方块，按 r=67 裁切）──
            //    这是立绘「眼角」的形状来源，不能省。
            canvas.save();
            canvas.clipRect(cx - u(DISC_CLIP_R), cy - u(DISC_CLIP_R),
                    cx + u(DISC_CLIP_R), cy + u(DISC_CLIP_R));
            // 用圆形路径做精确裁切
            android.graphics.Path clipPath = new android.graphics.Path();
            clipPath.addCircle(cx, cy, u(DISC_CLIP_R), android.graphics.Path.Direction.CW);
            canvas.clipPath(clipPath);

            fill.setColor(C_CORNERS);
            canvas.drawCircle(cx, cy, u(CORNERS_CIRCLE_R), fill);

            canvas.save();
            canvas.rotate(CORNERS_RECT_ANGLE, cx, cy);
            float half = u(CORNERS_RECT_WH) / 2f;
            android.graphics.RectF rect = new android.graphics.RectF(
                    cx - half, cy - half, cx + half, cy + half);
            canvas.drawRoundRect(rect, u(CORNERS_RECT_RX), u(CORNERS_RECT_RX), fill);
            canvas.restore();
            canvas.restore();

            // ── 4. 眼白 ──
            fill.setColor(C_SCLERA);
            canvas.drawCircle(cx, cy, u(SCLERA_R), fill);

            // 巩膜光晕
            halo.setShader(new android.graphics.RadialGradient(cx, cy, u(SCLERA_HALO_R),
                    new int[]{0x00FFFFFF, 0x00FFFFFF, 0x38FFFFFF, 0x47FFFFFF,
                            0x30FFFFFF, 0x12FFFFFF, 0x00FFFFFF},
                    new float[]{0f, 0.82f, 0.857f, 0.875f, 0.89f, 0.94f, 1f},
                    Shader.TileMode.CLAMP));
            canvas.drawCircle(cx, cy, u(SCLERA_HALO_R), halo);
            halo.setShader(null);

            // 巩膜接触环（很淡的白圈）
            stroke.setColor(0x29FFFFFF);
            stroke.setStrokeWidth(Math.max(1f, u(SCLERA_CONTACT_W)));
            canvas.drawCircle(cx, cy, u(SCLERA_R), stroke);

            // ── 5. 眼球三层 ──
            fill.setColor(C_LAYER_THREE);
            canvas.drawCircle(cx, cy, u(LAYER_THREE_R), fill);
            fill.setColor(C_LAYER_TWO_A);
            canvas.drawCircle(cx, cy, u(LAYER_TWO_A_R), fill);
            fill.setColor(C_LAYER_TWO_B);
            canvas.drawCircle(cx, cy, u(LAYER_TWO_B_R), fill);
            stroke.setColor(C_LAYER_ONE);
            stroke.setStrokeWidth(Math.max(1f, u(0.1f)));
            canvas.drawCircle(cx, cy, u(LAYER_ONE_R), stroke);

            // ── 6. 瞳孔 + 高光 ──
            fill.setColor(C_PUPIL);
            canvas.drawCircle(cx, cy, u(PUPIL_R), fill);

            // 高光位置：立绘里是绝对坐标 (98, 100.5)，相对中心偏移 (18, 20.5)
            float hx = cx + u(HL_X - VB / 2f);
            float hy = cy + u(HL_Y - VB / 2f);

            halo.setShader(new android.graphics.RadialGradient(hx, hy, u(HL_HALO_R),
                    new int[]{0x00F5F8FD, 0x00F5F8FD, 0x29F5F8FD, 0x6EF5F8FD,
                            0x30F5F8FD, 0x0EF5F8FD, 0x00F5F8FD},
                    new float[]{0f, 0.53f, 0.56f, 0.611f, 0.72f, 0.83f, 1f},
                    Shader.TileMode.CLAMP));
            canvas.drawCircle(hx, hy, u(HL_HALO_R), halo);
            halo.setShader(null);

            fill.setColor(C_HIGHLIGHT);
            canvas.drawCircle(hx, hy, u(HL_R), fill);

            // ── 点击脉冲（额外的交互反馈，立绘本身没有）──
            if (pulseScale > 1.001f) {
                stroke.setColor(0x55FFFFFF);
                stroke.setStrokeWidth(Math.max(1f, dpLocal(2f)));
                canvas.drawCircle(cx, cy, discR * pulseScale, stroke);
            }
        }

        /** 点击反馈：短促的扩散动画 */
        void pulse() {
            ValueAnimator a = ValueAnimator.ofFloat(1f, 1.35f);
            a.setDuration(320);
            a.addUpdateListener(anim -> {
                pulseScale = (float) anim.getAnimatedValue();
                invalidate();
            });
            a.addListener(new android.animation.AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(android.animation.Animator animation) {
                    pulseScale = 1f;
                    invalidate();
                }
            });
            a.start();
        }
    }

    /** 一次性标记：悬浮球请求了语音输入，由主界面消费 */
    public static final class VoiceRequest {
        public static volatile boolean pending = false;

        public static boolean consume() {
            if (!pending) return false;
            pending = false;
            return true;
        }
    }
}
