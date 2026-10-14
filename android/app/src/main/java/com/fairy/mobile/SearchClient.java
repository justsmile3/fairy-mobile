package com.fairy.mobile;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 联网搜索。
 *
 * 为什么在原生层做：
 *   1. 搜索站点不返回 CORS 头，WebView 里 fetch 会被浏览器拦截。
 *   2. 原生层能设置完整请求头（UA / Accept-Language），部分站点会校验。
 *   3. HTML 解析放在这里，避免把整页 HTML（上百 KB）传进 WebView。
 *
 * 免密钥：直接抓取公开结果页并解析，使用者无需申请任何 API Key。
 * 代价是解析依赖页面结构，站点改版可能失效 —— 因此内置多个搜索引擎，
 * 且解析失败时返回明确的错误而不是空结果。
 *
 * 设计原则：**搜索失败绝不阻塞对话**。任何异常都转成 ok=false 回传。
 */
public class SearchClient {

    private static final String TAG = "FairySearch";

    /** 用桌面 UA：移动版结果页结构不同，且部分站点对移动 UA 返回简化页 */
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    /** 结果通过轮询交给 WebView（避免在后台线程持有 WebView 引用） */
    private static volatile String callbackJs = "";

    public static String takeCallback() {
        String s = callbackJs;
        callbackJs = "";
        return s;
    }

    /**
     * 发起搜索。paramsJson：{engine, url, query, count}
     */
    public void search(final String paramsJson) {
        pool.execute(() -> {
            boolean ok = false;
            String payload;
            try {
                JSONObject p = new JSONObject(paramsJson == null ? "{}" : paramsJson);
                String engine = p.optString("engine", "bing");
                String url = p.optString("url", "");
                String query = p.optString("query", "");
                int count = Math.max(1, Math.min(10, p.optInt("count", 5)));

                if (url.isEmpty()) throw new Exception("搜索地址为空");

                String html = httpGet(url);
                if (html == null || html.isEmpty()) {
                    throw new Exception("搜索返回内容为空");
                }

                List<JSONObject> items = parse(engine, html, count);
                if (items.isEmpty()) {
                    throw new Exception("未能从搜索结果页提取到条目（页面结构可能已变化）");
                }

                JSONObject out = new JSONObject();
                out.put("engine", engine);
                out.put("query", query);
                JSONArray arr = new JSONArray();
                for (JSONObject it : items) arr.put(it);
                out.put("results", arr);
                payload = out.toString();
                ok = true;
            } catch (Throwable e) {
                ok = false;
                payload = describe(e);
                Log.w(TAG, "搜索失败：" + payload);
            }
            notifyResult(ok, payload);
        });
    }

    /* ── HTTP ─────────────────────────────────────────── */

    private String httpGet(String urlStr) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);

            int code = conn.getResponseCode();
            InputStream is = code >= 200 && code < 300
                    ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (is != null) {
                try (InputStream in = new BufferedInputStream(is)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                }
            }
            if (code < 200 || code >= 300) {
                throw new Exception("搜索服务返回 HTTP " + code);
            }
            return decode(bos.toByteArray(), conn.getContentType());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 按 Content-Type 或页面 meta 声明选择编码，默认 UTF-8 */
    private String decode(byte[] data, String contentType) {
        String charset = "UTF-8";
        if (contentType != null) {
            Matcher m = Pattern.compile("charset=([\\w-]+)", Pattern.CASE_INSENSITIVE)
                    .matcher(contentType);
            if (m.find()) charset = m.group(1);
        }
        if ("UTF-8".equalsIgnoreCase(charset)) {
            // 从头部嗅探 meta charset（有些站点 Content-Type 不带 charset）
            String head = new String(data, 0, Math.min(2048, data.length),
                    java.nio.charset.StandardCharsets.ISO_8859_1).toLowerCase();
            if (head.contains("charset=gbk") || head.contains("charset=gb2312")) {
                charset = "GBK";
            }
        }
        try {
            return new String(data, charset);
        } catch (Throwable e) {
            return new String(data, java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    /* ── 解析 ─────────────────────────────────────────── */

    private List<JSONObject> parse(String engine, String html, int count) {
        switch (engine) {
            case "sogou": return parseSogou(html, count);
            case "so360": return parseSo360(html, count);
            case "mojeek": return parseMojeek(html, count);
            case "bing":
            default: return parseBing(html, count);
        }
    }

    /**
     * Bing 结果页：每条结果在 <li class="b_algo"> 里，
     * 标题与链接在 <h2><a href="...">，摘要在 <p>。
     */
    private List<JSONObject> parseBing(String html, int count) {
        List<JSONObject> out = new ArrayList<>();
        String[] blocks = html.split("<li class=\"b_algo\"");
        Pattern link = Pattern.compile(
                "<h2[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>",
                Pattern.CASE_INSENSITIVE);
        Pattern para = Pattern.compile("<p[^>]*>([\\s\\S]*?)</p>", Pattern.CASE_INSENSITIVE);

        for (int i = 1; i < blocks.length && out.size() < count; i++) {
            String b = blocks[i];
            Matcher lm = link.matcher(b);
            if (!lm.find()) continue;
            String url = lm.group(1);
            String title = stripTags(lm.group(2));
            String snippet = "";
            Matcher pm = para.matcher(b);
            if (pm.find()) snippet = stripTags(pm.group(1));
            if (title.isEmpty()) continue;
            out.add(makeItem(title, url, snippet));
        }
        return out;
    }

    /** 搜狗：结果标题在 <h3 class="vr-title"><a href="..."> */
    private List<JSONObject> parseSogou(String html, int count) {
        List<JSONObject> out = new ArrayList<>();
        Pattern item = Pattern.compile(
                "<h3[^>]*class=\"[^\"]*vr-title[^\"]*\"[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>",
                Pattern.CASE_INSENSITIVE);
        Pattern para = Pattern.compile(
                "<div[^>]*class=\"[^\"]*(?:text-layout|fz-mid|str_info)[^\"]*\"[^>]*>([\\s\\S]*?)</div>",
                Pattern.CASE_INSENSITIVE);
        Matcher m = item.matcher(html);
        while (m.find() && out.size() < count) {
            String url = m.group(1);
            String title = stripTags(m.group(2));
            int from = m.end();
            String tail = html.substring(from, Math.min(html.length(), from + 4000));
            Matcher pm = para.matcher(tail);
            String snippet = pm.find() ? stripTags(pm.group(1)) : "";
            if (title.isEmpty()) continue;
            out.add(makeItem(title, url, snippet));
        }
        return out;
    }

    /** 360：结果标题在 <h3 class="res-title"><a href="..."> */
    private List<JSONObject> parseSo360(String html, int count) {
        List<JSONObject> out = new ArrayList<>();
        Pattern item = Pattern.compile(
                "<h3[^>]*class=\"[^\"]*res-title[^\"]*\"[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>",
                Pattern.CASE_INSENSITIVE);
        Pattern para = Pattern.compile(
                "<p[^>]*class=\"[^\"]*res-desc[^\"]*\"[^>]*>([\\s\\S]*?)</p>",
                Pattern.CASE_INSENSITIVE);
        Matcher m = item.matcher(html);
        while (m.find() && out.size() < count) {
            String url = m.group(1);
            String title = stripTags(m.group(2));
            int from = m.end();
            String tail = html.substring(from, Math.min(html.length(), from + 5000));
            Matcher pm = para.matcher(tail);
            String snippet = pm.find() ? stripTags(pm.group(1)) : "";
            if (title.isEmpty()) continue;
            out.add(makeItem(title, url, snippet));
        }
        return out;
    }

    /** Mojeek：结果在 <a class="title" href="..."> */
    private List<JSONObject> parseMojeek(String html, int count) {
        List<JSONObject> out = new ArrayList<>();
        Pattern item = Pattern.compile(
                "<a[^>]*class=\"title\"[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>",
                Pattern.CASE_INSENSITIVE);
        Pattern para = Pattern.compile(
                "<p[^>]*class=\"s\"[^>]*>([\\s\\S]*?)</p>", Pattern.CASE_INSENSITIVE);
        Matcher m = item.matcher(html);
        while (m.find() && out.size() < count) {
            String url = m.group(1);
            String title = stripTags(m.group(2));
            int from = m.end();
            String tail = html.substring(from, Math.min(html.length(), from + 4000));
            Matcher pm = para.matcher(tail);
            String snippet = pm.find() ? stripTags(pm.group(1)) : "";
            if (title.isEmpty()) continue;
            out.add(makeItem(title, url, snippet));
        }
        return out;
    }

    private JSONObject makeItem(String title, String url, String snippet) {
        JSONObject o = new JSONObject();
        try {
            o.put("title", limit(title, 200));
            o.put("url", normalizeUrl(url));
            o.put("snippet", limit(snippet, 500));
        } catch (Throwable ignored) { }
        return o;
    }

    /* ── 工具 ─────────────────────────────────────────── */

    /** 去掉标签、解码实体、压缩空白 */
    private static String stripTags(String s) {
        if (s == null) return "";
        String t = s.replaceAll("(?s)<script[^>]*>.*?</script>", "")
                .replaceAll("(?s)<style[^>]*>.*?</style>", "")
                .replaceAll("<[^>]+>", "");
        t = t.replace("&amp;", "&").replace("&quot;", "\"")
                .replace("&#39;", "'").replace("&apos;", "'")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&nbsp;", " ").replace("&ensp;", " ")
                .replace("&emsp;", " ").replace("&hellip;", "…")
                .replace("&mdash;", "—").replace("&ndash;", "–");
        Matcher m = Pattern.compile("&#(\\d+);").matcher(t);
        // 注意：appendReplacement 在 Android 上要求 StringBuffer（不是 StringBuilder）
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            try {
                m.appendReplacement(sb, Matcher.quoteReplacement(
                        String.valueOf((char) Integer.parseInt(m.group(1)))));
            } catch (Throwable ignored) { }
        }
        m.appendTail(sb);
        return sb.toString().replaceAll("\\s+", " ").trim();
    }

    /** 补全协议相对链接 */
    private static String normalizeUrl(String url) {
        if (url == null) return "";
        String u = url.trim();
        if (u.startsWith("//")) u = "https:" + u;
        return u;
    }

    private static String limit(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    private static String describe(Throwable e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null ? "" : "：" + m);
    }

    private void notifyResult(boolean ok, String payload) {
        try {
            callbackJs = "window.__fairySearch && window.__fairySearch.onResult && "
                    + "window.__fairySearch.onResult(" + ok + ", "
                    + JSONObject.quote(payload == null ? "" : payload) + ")";
        } catch (Throwable ignored) { }
    }

    public void destroy() {
        pool.shutdownNow();
    }
}
