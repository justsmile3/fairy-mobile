package com.fairy.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * ToolHost —— Fairy 工具集的原生实现
 *
 * 这里集中实现「模型能真正调用的能力」。之所以单独一个类而不是塞进
 * MainActivity：
 *   1. 权限边界集中在一处，便于审查与收紧；
 *   2. 与界面逻辑解耦，可以单独推理；
 *   3. MainActivity 已经很长了。
 *
 * ⚠️ 权限边界（重要）
 *
 * 文件操作**只作用于应用自己的私有目录**：
 *   getExternalFilesDir(null)/documents
 * 这个目录随应用卸载一起清除，其他应用无法访问，也不需要任何运行时权限。
 *
 * 所有路径都经过 resolveInside() 校验，确保解析后的真实路径
 * 仍在文档区之内 —— 拒绝 ".." 穿越与符号链接逃逸。
 *
 * 设备信息只读取公开的、无需权限的状态（电量、网络类型、存储、系统版本）。
 * 不读取通讯录、短信、位置、IMEI 等敏感信息，也不申请任何新权限。
 */
public final class ToolHost {

    private ToolHost() { }

    /** 文档区目录名（位于应用私有外部存储下） */
    private static final String DOC_DIR = "documents";
    /** 单文件读取上限：避免把巨大文件塞进上下文 */
    private static final long MAX_READ_BYTES = 256 * 1024;
    /** 键值存储文件名 */
    private static final String KV_FILE = "fairy-kv.json";

    /* ── 统一入口 ─────────────────────────────────────── */

    /**
     * 执行一个工具调用。
     *
     * @param ctx  上下文（Activity 或 Service）
     * @param name 工具名
     * @param argsJson 参数 JSON 字符串
     * @return 结果 JSON 字符串。**永远不会返回 null，也不抛异常** ——
     *         失败会以 {"ok":false,"error":"..."} 的形式返回，
     *         让模型看到失败原因并自行调整，而不是中断整轮对话。
     */
    public static String call(Context ctx, String name, String argsJson) {
        JSONObject args = new JSONObject();
        try {
            if (argsJson != null && argsJson.trim().length() > 0) {
                args = new JSONObject(argsJson);
            }
        } catch (Throwable e) {
            return err("参数不是合法 JSON：" + e.getMessage());
        }

        try {
            switch (name == null ? "" : name) {
                case "device_info":  return deviceInfo(ctx, args);
                case "list_files":   return listFiles(ctx, args);
                case "read_file":    return readFile(ctx, args);
                case "write_file":   return writeFile(ctx, args);
                case "delete_file":  return deleteFile(ctx, args);
                default:
                    return err("未知工具：" + name);
            }
        } catch (Throwable e) {
            // 兜底：任何未预期异常都转成结构化错误
            return err("执行失败：" + e.getClass().getSimpleName()
                    + (e.getMessage() == null ? "" : " - " + e.getMessage()));
        }
    }

    /* ── 设备信息 ─────────────────────────────────────── */

    private static String deviceInfo(Context ctx, JSONObject args) {
        List<String> wanted = new ArrayList<>();
        JSONArray fields = args.optJSONArray("fields");
        if (fields != null) {
            for (int i = 0; i < fields.length(); i++) {
                wanted.add(fields.optString(i, ""));
            }
        }
        boolean all = wanted.isEmpty();
        JSONObject out = new JSONObject();

        try {
            if (all || wanted.contains("battery")) out.put("battery", battery(ctx));
            if (all || wanted.contains("network")) out.put("network", network(ctx));
            if (all || wanted.contains("storage")) out.put("storage", storage(ctx));
            if (all || wanted.contains("system"))  out.put("system", system(ctx));
            if (all || wanted.contains("time"))    out.put("time", time());
        } catch (Throwable e) {
            return err("读取设备信息失败：" + e.getMessage());
        }

        JSONObject res = new JSONObject();
        try {
            res.put("ok", true);
            res.put("data", out);
        } catch (Throwable ignored) { }
        return res.toString();
    }

    private static JSONObject battery(Context ctx) throws Exception {
        JSONObject o = new JSONObject();
        IntentFilter f = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent it = ctx.registerReceiver(null, f);
        if (it == null) { o.put("available", false); return o; }

        int level = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        int status = it.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        int plugged = it.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1);
        int temp = it.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);

        o.put("available", level >= 0 && scale > 0);
        // 若取不到 level/scale，退回 BatteryManager 的属性查询
        if (level >= 0 && scale > 0) {
            o.put("percent", Math.round(level * 100f / scale));
        } else {
            BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
            if (bm != null) {
                o.put("percent", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
            }
        }
        switch (status) {
            case BatteryManager.BATTERY_STATUS_CHARGING: o.put("status", "充电中"); break;
            case BatteryManager.BATTERY_STATUS_FULL:     o.put("status", "已充满"); break;
            case BatteryManager.BATTERY_STATUS_DISCHARGING: o.put("status", "放电中"); break;
            case BatteryManager.BATTERY_STATUS_NOT_CHARGING: o.put("status", "未充电"); break;
            default: o.put("status", "未知");
        }
        o.put("plugged", plugged > 0);
        if (temp > 0) o.put("temperatureC", Math.round(temp / 10f));
        return o;
    }

    private static JSONObject network(Context ctx) throws Exception {
        JSONObject o = new JSONObject();
        ConnectivityManager cm = (ConnectivityManager)
                ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) { o.put("connected", false); return o; }

        if (Build.VERSION.SDK_INT >= 23) {
            NetworkCapabilities cap = cm.getNetworkCapabilities(cm.getActiveNetwork());
            boolean connected = cap != null;
            o.put("connected", connected);
            if (connected) {
                // 类型判断：WiFi / 蜂窝 / 以太网 / 其他
                if (cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) o.put("type", "WiFi");
                else if (cap.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) o.put("type", "移动数据");
                else if (cap.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) o.put("type", "以太网");
                else o.put("type", "其他");
                o.put("metered", !cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
            }
        } else {
            NetworkInfo ni = cm.getActiveNetworkInfo();
            boolean connected = ni != null && ni.isConnected();
            o.put("connected", connected);
            if (connected) {
                int t = ni.getType();
                o.put("type", t == ConnectivityManager.TYPE_WIFI ? "WiFi"
                        : t == ConnectivityManager.TYPE_MOBILE ? "移动数据" : "其他");
            }
        }
        return o;
    }

    private static JSONObject storage(Context ctx) throws Exception {
        JSONObject o = new JSONObject();
        try {
            File dataDir = Environment.getDataDirectory();
            StatFs stat = new StatFs(dataDir.getPath());
            long total, free;
            if (Build.VERSION.SDK_INT >= 18) {
                total = stat.getTotalBytes();
                free = stat.getAvailableBytes();
            } else {
                total = (long) stat.getBlockCount() * stat.getBlockSize();
                free = (long) stat.getAvailableBlocks() * stat.getBlockSize();
            }
            o.put("totalBytes", total);
            o.put("freeBytes", free);
            o.put("totalMB", Math.round(total / 1048576.0));
            o.put("freeMB", Math.round(free / 1048576.0));
        } catch (Throwable e) {
            o.put("available", false);
        }
        return o;
    }

    private static JSONObject system(Context ctx) throws Exception {
        JSONObject o = new JSONObject();
        o.put("androidVersion", Build.VERSION.RELEASE);
        o.put("sdkInt", Build.VERSION.SDK_INT);
        o.put("manufacturer", Build.MANUFACTURER);
        o.put("model", Build.MODEL);
        o.put("appPackage", ctx.getPackageName());
        try {
            DisplayMetrics dm = new DisplayMetrics();
            WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.view.WindowMetrics metrics = wm.getCurrentWindowMetrics();
                    android.graphics.Rect b = metrics.getBounds();
                    o.put("screenWidthDp", Math.round(b.width() / dm.density));
                    o.put("screenHeightDp", Math.round(b.height() / dm.density));
                } else {
                    // 旧版本走默认显示，取逻辑尺寸
                    android.util.DisplayMetrics real = ctx.getResources().getDisplayMetrics();
                    o.put("screenWidthDp", Math.round(real.widthPixels / real.density));
                    o.put("screenHeightDp", Math.round(real.heightPixels / real.density));
                }
            }
        } catch (Throwable ignored) { }
        return o;
    }

    private static JSONObject time() throws Exception {
        JSONObject o = new JSONObject();
        long now = System.currentTimeMillis();
        SimpleDateFormat full = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);
        SimpleDateFormat week = new SimpleDateFormat("EEEE", Locale.CHINA);
        o.put("timestamp", now);
        o.put("formatted", full.format(new Date(now)));
        o.put("weekday", week.format(new Date(now)));
        o.put("timezone", java.util.TimeZone.getDefault().getID());
        return o;
    }

    /* ── 文件操作（仅限应用私有文档区）─────────────────── */

    /** 文档区根目录，必要时创建 */
    private static File docRoot(Context ctx) throws IOException {
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();     // 极少数无外部存储的情况
        File dir = new File(base, DOC_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建文档区目录");
        }
        return dir;
    }

    /**
     * 把相对路径解析为文档区内的真实文件。
     *
     * 这是**安全边界**：JS 侧也做了校验，但两侧各查一遍才稳妥 ——
     * 路径穿越一旦漏过，模型就能读写应用私有目录之外的内容。
     *
     * @return 解析成功返回 File；越界返回 null
     */
    private static File resolveInside(Context ctx, String relPath) {
        try {
            File root = docRoot(ctx);
            String rel = relPath == null ? "" : relPath.trim();
            if (rel.isEmpty()) return root;

            // 统一分隔符，去掉开头的斜杠
            rel = rel.replace('\\', '/');
            while (rel.startsWith("/")) rel = rel.substring(1);

            File target = new File(root, rel);

            // 关键校验：用 getCanonicalPath 展开 ".." 与符号链接后再比较前缀
            String rootCanon = root.getCanonicalPath();
            String targetCanon = target.getCanonicalPath();
            if (!targetCanon.equals(rootCanon)
                    && !targetCanon.startsWith(rootCanon + File.separator)) {
                return null;
            }
            return target;
        } catch (Throwable e) {
            return null;
        }
    }

    private static String listFiles(Context ctx, JSONObject args) {
        String rel = args.optString("path", "");
        File dir = resolveInside(ctx, rel);
        if (dir == null) return err("路径越界：只能访问应用自己的文档区");
        if (!dir.exists()) return err("目录不存在：" + (rel.isEmpty() ? "/" : rel));
        if (!dir.isDirectory()) return err("不是目录：" + rel);

        File[] children = dir.listFiles();
        if (children == null) children = new File[0];
        // 目录在前，同类按名称排序，便于阅读
        Arrays.sort(children, new Comparator<File>() {
            @Override public int compare(File a, File b) {
                if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.getName().compareToIgnoreCase(b.getName());
            }
        });

        try {
            JSONArray arr = new JSONArray();
            for (File f : children) {
                JSONObject o = new JSONObject();
                o.put("name", f.getName());
                o.put("type", f.isDirectory() ? "dir" : "file");
                if (f.isFile()) {
                    o.put("sizeBytes", f.length());
                }
                arr.put(o);
            }
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("path", rel.isEmpty() ? "/" : rel);
            res.put("entries", arr);
            if (arr.length() == 0) res.put("text", "（空目录）");
            return res.toString();
        } catch (Throwable e) {
            return err("列举失败：" + e.getMessage());
        }
    }

    private static String readFile(Context ctx, JSONObject args) {
        String rel = args.optString("path", "").trim();
        if (rel.isEmpty()) return err("必须指定文件路径");

        File f = resolveInside(ctx, rel);
        if (f == null) return err("路径越界：只能访问应用自己的文档区");
        if (!f.exists()) return err("文件不存在：" + rel);
        if (f.isDirectory()) return err("这是一个目录，不是文件：" + rel);
        if (f.length() > MAX_READ_BYTES) {
            return err("文件过大（" + (f.length() / 1024) + " KB），读取上限 "
                    + (MAX_READ_BYTES / 1024) + " KB");
        }

        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] buf = new byte[(int) f.length()];
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            String text = new String(buf, 0, off, "UTF-8");

            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("path", rel);
            res.put("sizeBytes", off);
            res.put("text", text);
            return res.toString();
        } catch (Throwable e) {
            return err("读取失败：" + e.getMessage());
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) { }
        }
    }

    private static String writeFile(Context ctx, JSONObject args) {
        String rel = args.optString("path", "").trim();
        if (rel.isEmpty()) return err("必须指定文件路径");
        String content = args.optString("content", "");

        File f = resolveInside(ctx, rel);
        if (f == null) return err("路径越界：只能访问应用自己的文档区");
        if (f.isDirectory()) return err("这是一个目录，不能写入：" + rel);

        // 自动创建父目录，省去模型额外调用一次
        File parent = f.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            return err("无法创建目录：" + parent.getName());
        }

        FileOutputStream out = null;
        try {
            out = new FileOutputStream(f);
            out.write(content.getBytes("UTF-8"));
            out.flush();

            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("path", rel);
            res.put("sizeBytes", f.length());
            res.put("text", "已写入 " + rel + "（" + f.length() + " 字节）");
            return res.toString();
        } catch (Throwable e) {
            return err("写入失败：" + e.getMessage());
        } finally {
            if (out != null) try { out.close(); } catch (Throwable ignored) { }
        }
    }

    private static String deleteFile(Context ctx, JSONObject args) {
        String rel = args.optString("path", "").trim();
        if (rel.isEmpty()) return err("必须指定文件路径");

        File f = resolveInside(ctx, rel);
        if (f == null) return err("路径越界：只能访问应用自己的文档区");
        if (!f.exists()) return err("文件不存在：" + rel);

        // 只允许删文件，不允许删目录 —— 避免一次调用清空整个文档区
        if (f.isDirectory()) {
            return err("只能删除文件，不能删除目录（如需清空请逐个删除文件）");
        }

        try {
            if (!f.delete()) return err("删除失败：" + rel);
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("text", "已删除 " + rel);
            return res.toString();
        } catch (Throwable e) {
            return err("删除失败：" + e.getMessage());
        }
    }

    /* ── 键值存储（长期记忆用）─────────────────────────── */

    /**
     * 读取一个键。
     * 存储位置：应用私有目录下的 JSON 文件，不经过任何网络。
     */
    public static synchronized String readStore(Context ctx, String key) {
        try {
            File f = kvFile(ctx);
            if (!f.exists()) return "";
            JSONObject all = new JSONObject(readAll(f));
            return all.optString(key, "");
        } catch (Throwable e) {
            return "";
        }
    }

    /**
     * 写入一个键。
     * @return "1" 表示成功，其他为失败原因
     */
    public static synchronized String writeStore(Context ctx, String key, String value) {
        try {
            File f = kvFile(ctx);
            JSONObject all = new JSONObject();
            if (f.exists()) {
                try { all = new JSONObject(readAll(f)); } catch (Throwable ignored) { }
            }
            all.put(key, value == null ? "" : value);

            FileOutputStream out = new FileOutputStream(f);
            try {
                out.write(all.toString().getBytes("UTF-8"));
                out.flush();
            } finally {
                out.close();
            }
            return "1";
        } catch (Throwable e) {
            return "写入失败：" + e.getMessage();
        }
    }

    private static File kvFile(Context ctx) throws IOException {
        File base = ctx.getFilesDir();
        if (base == null) throw new IOException("无法访问应用目录");
        if (!base.exists() && !base.mkdirs()) throw new IOException("无法创建应用目录");
        return new File(base, KV_FILE);
    }

    private static String readAll(File f) throws IOException {
        FileInputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[(int) f.length()];
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            return new String(buf, 0, off, "UTF-8");
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
    }

    /* ── 辅助 ─────────────────────────────────────────── */

    private static String err(String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", message == null ? "未知错误" : message);
            return o.toString();
        } catch (Throwable e) {
            // 极端情况：连 JSON 都构造不出来，返回手写 JSON
            return "{\"ok\":false,\"error\":\"内部错误\"}";
        }
    }

    /** 供界面展示：文档区的绝对路径（方便用户去文件管理器查看） */
    public static String docPath(Context ctx) {
        try {
            return docRoot(ctx).getAbsolutePath();
        } catch (Throwable e) {
            return "";
        }
    }
}
