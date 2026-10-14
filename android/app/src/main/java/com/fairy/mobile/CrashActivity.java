package com.fairy.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.TypedValue;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;

/**
 * 崩溃展示页。
 *
 * 存在的意义：主界面在启动阶段崩溃时，用户只会看到「闪退」，拿不到任何信息。
 * 这个 Activity 被声明为**独立进程**（见 AndroidManifest 的 android:process），
 * 因此即使主进程已经崩溃，它依然能被拉起，把崩溃日志显示出来并**自动复制到剪贴板**。
 */
public class CrashActivity extends Activity {

    public static final String EXTRA_LOG = "log";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String log = "";
        try {
            Intent intent = getIntent();
            if (intent != null && intent.getStringExtra(EXTRA_LOG) != null) {
                log = intent.getStringExtra(EXTRA_LOG);
            }
        } catch (Throwable ignored) { }

        if (log == null || log.isEmpty()) {
            log = readSavedCrash();
        }
        if (log == null || log.isEmpty()) {
            log = "（没有捕获到日志）";
        }
        final String report = buildReport(log);

        // 显示
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Fairy 启动失败");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f);
        title.setPadding(0, 0, 0, dp(12));
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("日志已自动复制到剪贴板，直接粘贴发送即可。");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        hint.setPadding(0, 0, 0, dp(12));
        root.addView(hint);

        TextView body = new TextView(this);
        body.setText(report);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        body.setTextIsSelectable(true);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(body);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        scroll.setLayoutParams(lp);
        root.addView(scroll);

        Button copyBtn = new Button(this);
        copyBtn.setText("再次复制日志");
        copyBtn.setOnClickListener(v -> {
            copyToClipboard(report);
            Toast.makeText(this, "已复制到剪贴板", Toast.LENGTH_SHORT).show();
        });
        root.addView(copyBtn);

        Button closeBtn = new Button(this);
        closeBtn.setText("关闭");
        closeBtn.setOnClickListener(v -> finish());
        root.addView(closeBtn);

        setContentView(root);

        // 自动复制到剪贴板（用户最省事）
        copyToClipboard(report);
        Toast.makeText(this, "崩溃日志已复制到剪贴板", Toast.LENGTH_LONG).show();
    }

    private String buildReport(String log) {
        StringBuilder sb = new StringBuilder();
        sb.append("=== Fairy 崩溃报告 ===\n");
        try {
            sb.append("Android SDK: ").append(android.os.Build.VERSION.SDK_INT).append('\n');
            sb.append("机型: ").append(android.os.Build.MANUFACTURER)
              .append(' ').append(android.os.Build.MODEL).append('\n');
            sb.append("ABI: ").append(android.os.Build.SUPPORTED_ABIS.length > 0
                    ? android.os.Build.SUPPORTED_ABIS[0] : "?").append('\n');
            sb.append("版本: ").append(getPackageManager()
                    .getPackageInfo(getPackageName(), 0).versionName).append('\n');
        } catch (Throwable ignored) { }
        sb.append("\n--- 异常 ---\n");
        sb.append(log);
        return sb.toString();
    }

    private void copyToClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("FairyCrash", text));
            }
        } catch (Throwable ignored) { }
    }

    private String readSavedCrash() {
        try {
            File f = new File(getFilesDir(), "last-crash.txt");
            if (!f.exists()) return "";
            byte[] buf = new byte[(int) Math.min(f.length(), 16384)];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int n = in.read(buf);
                if (n > 0) return new String(buf, 0, n, "UTF-8");
            }
        } catch (Throwable ignored) { }
        return "";
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    /** 把崩溃信息落盘（供下次启动读取） */
    public static void saveCrash(Context ctx, Throwable e) {
        try {
            File f = new File(ctx.getFilesDir(), "last-crash.txt");
            try (FileOutputStream out = new FileOutputStream(f)) {
                PrintWriter pw = new PrintWriter(new java.io.OutputStreamWriter(out, "UTF-8"));
                pw.println(e.getClass().getName() + ": " + e.getMessage());
                e.printStackTrace(pw);
                pw.flush();
            }
        } catch (Throwable ignored) { }
    }
}
