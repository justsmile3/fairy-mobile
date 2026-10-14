package com.fairy.mobile;

import android.media.AudioAttributes;
import android.media.MediaPlayer;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 云端语音合成（TTS）。
 *
 * 为什么在原生层发请求：
 *   多数语音服务不返回 CORS 头，WebView 里 fetch 会被浏览器拦截。
 *   原生 HTTP 无此限制，因此所有合成请求都由本类发出。
 *
 * 支持的提供商：
 *   - siliconflow : OpenAI 兼容 /audio/speech，支持克隆音色（推荐）
 *   - baidu       : 免注册的百度翻译 TTS，音色固定
 *   - custom      : 任意 OpenAI 兼容端点
 *
 * 另提供 uploadVoice()：把参考音频上传为可复用音色（SiliconFlow），
 * 用于把用户的 Fairy 录音变成专属音色。
 */
public class CloudTts {

    public interface Listener {
        void onStart();
        void onEnd();
        void onError(String message);
    }

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

    private final File cacheDir;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    private MediaPlayer player;
    private Listener listener;
    private volatile int token = 0;
    private volatile boolean destroyed = false;

    /** 最近一次请求用的参数（供重试） */
    private volatile String lastProvider = "baidu";
    private volatile float speed = 1.0f;

    /** 简单 LRU：相同文本不重复请求 */
    private final Map<String, File> cache = new HashMap<>();
    private final ArrayDeque<String> cacheOrder = new ArrayDeque<>();
    private static final int CACHE_MAX = 64;

    public CloudTts(File cacheDir) {
        this.cacheDir = cacheDir;
        if (!cacheDir.exists()) cacheDir.mkdirs();
    }

    public void setListener(Listener l) {
        this.listener = l;
    }

    public void setSpeed(float s) {
        if (s > 0.1f && s < 5f) speed = s;
    }

    /* ── 合成与播放 ───────────────────────────────────── */

    /**
     * 合成并播放。
     *
     * @param text 待朗读文本
     * @param paramsJson 由 JS 组装好的参数（见 cloudtts.js buildSynthesisParams）
     */
    public void speak(final String text, final String paramsJson) {
        if (destroyed || text == null || text.trim().isEmpty()) return;
        final int myToken = ++token;

        pool.execute(() -> {
            try {
                JSONObject p = paramsJson == null || paramsJson.isEmpty()
                        ? new JSONObject() : new JSONObject(paramsJson);
                String provider = p.optString("provider", "baidu");
                lastProvider = provider;

                File audio = fetchAudio(text, p, provider, myToken);
                if (audio == null || destroyed || myToken != token) return;
                playFile(audio, myToken);
            } catch (Throwable e) {
                if (myToken == token && listener != null) {
                    listener.onError("语音合成失败：" + describe(e));
                }
            }
        });
    }

    private File fetchAudio(String text, JSONObject p, String provider, int myToken) throws Exception {
        String key = provider + "|" + p.optString("voice", "") + "|"
                + Math.round(speed * 10) + "|" + text;
        synchronized (cache) {
            File hit = cache.get(key);
            if (hit != null && hit.exists() && hit.length() > 0) return hit;
        }

        byte[] data;
        if ("baidu".equals(provider)) {
            data = fetchBaidu(text, p, myToken);
        } else {
            // siliconflow / custom 都是 OpenAI 兼容的 /audio/speech
            data = fetchOpenAiCompat(text, p, myToken);
        }
        if (data == null || data.length < 256) {
            throw new Exception("返回数据过短（" + (data == null ? 0 : data.length) + " 字节）");
        }
        // 简单校验：mp3 以 ID3 或帧同步开头；wav 以 RIFF 开头
        boolean looksAudio = (data[0] == 'I' && data[1] == 'D' && data[2] == '3')
                || (data[0] == 'R' && data[1] == 'I' && data[2] == 'F')
                || ((data[0] & 0xFF) == 0xFF && (data[1] & 0xE0) == 0xE0);
        if (!looksAudio) {
            String head = new String(data, 0, Math.min(300, data.length), "UTF-8");
            throw new Exception("返回的不是音频：" + head);
        }

        File out = new File(cacheDir, "tts_" + Math.abs(key.hashCode()) + ".audio");
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(data);
        }
        synchronized (cache) {
            cache.put(key, out);
            cacheOrder.addLast(key);
            while (cacheOrder.size() > CACHE_MAX) {
                String old = cacheOrder.pollFirst();
                if (old != null && !old.equals(key)) cache.remove(old);
            }
        }
        return out;
    }

    /** 百度翻译 TTS：免注册，返回 MP3 */
    private byte[] fetchBaidu(String text, JSONObject p, int myToken) throws Exception {
        String lang = "en".equals(p.optString("voice", "zh")) ? "en" : "zh";
        int spd = Math.max(1, Math.min(9, Math.round(5 * (speed <= 0 ? 1 : speed))));
        String url = "https://fanyi.baidu.com/gettts?lan=" + lang
                + "&text=" + URLEncoder.encode(text, "UTF-8")
                + "&spd=" + spd + "&source=web";
        return httpGet(url, null, myToken);
    }

    /** OpenAI 兼容的 /audio/speech（SiliconFlow、自建服务等） */
    private byte[] fetchOpenAiCompat(String text, JSONObject p, int myToken) throws Exception {
        String baseUrl = p.optString("baseUrl", "").replaceAll("/+$", "");
        String apiKey = p.optString("apiKey", "").trim();
        String model = p.optString("model", "").trim();
        String voice = p.optString("voice", "").trim();
        String format = p.optString("format", "mp3");

        if (baseUrl.isEmpty()) throw new Exception("未配置服务地址");
        if (model.isEmpty()) throw new Exception("未配置模型名");

        JSONObject body = new JSONObject();
        body.put("model", model);
        body.put("input", text);
        if (!voice.isEmpty()) body.put("voice", voice);
        body.put("response_format", format);
        body.put("speed", speed);

        String url = baseUrl + "/audio/speech";
        return httpPostJson(url, body.toString(), apiKey, myToken);
    }

    /* ── 音色上传（克隆）──────────────────────────────── */

    /**
     * 把参考音频上传为可复用音色（SiliconFlow 的 /uploads/audio/voice）。
     * 成功后回调 window.__fairyCloud.onUploadResult(ok, uriOrError)。
     */
    public void uploadVoice(String apiKey, String baseUrl, String model,
                            String name, String audioBase64, String mimeType,
                            String refText) {
        pool.execute(() -> {
            String result;
            boolean ok = false;
            try {
                String base = baseUrl == null || baseUrl.isEmpty()
                        ? "https://api.siliconflow.cn/v1" : baseUrl.replaceAll("/+$", "");
                if (apiKey == null || apiKey.trim().isEmpty()) {
                    throw new Exception("缺少 API Key");
                }
                if (audioBase64 == null || audioBase64.isEmpty()) {
                    throw new Exception("缺少参考音频数据");
                }
                if (model == null || model.trim().isEmpty()) {
                    throw new Exception("缺少模型名");
                }

                String trimmedModel = model.trim();
                String voiceName = name == null || name.isEmpty() ? "fairy" : name;

                // text 是**必填**：必须是参考音频里逐字对应的文本。
                // 官方接口若缺少该字段会返回 400。
                if (refText == null || refText.trim().isEmpty()) {
                    throw new Exception("缺少参考音频的文本（需填写录音里说的那句话）");
                }

                JSONObject body = new JSONObject();
                body.put("model", trimmedModel);
                body.put("customName", voiceName);
                body.put("text", refText.trim());
                // SiliconFlow 接受 data URI 形式的 base64
                String mime = mimeType == null || mimeType.isEmpty() ? "audio/wav" : mimeType;
                body.put("audio", "data:" + mime + ";base64," + audioBase64);

                String resp = httpPostJsonString(base + "/uploads/audio/voice",
                        body.toString(), apiKey.trim(), 0);
                JSONObject o = new JSONObject(resp);
                String uri = o.optString("uri", "");
                if (uri.isEmpty()) {
                    throw new Exception("服务未返回音色 ID：" + resp);
                }
                ok = true;
                result = uri;
            } catch (Throwable e) {
                result = describe(e);
            }
            notifyUploadResult(ok, result);
        });
    }

    private void notifyUploadResult(boolean ok, String payload) {
        // 通过 JS 回调把结果送回页面
        try {
            String js = "window.__fairyCloud && window.__fairyCloud.onUploadResult && "
                    + "window.__fairyCloud.onUploadResult(" + ok + ", "
                    + JSONObject.quote(payload == null ? "" : payload) + ")";
            uploadCallbackJs = js;
        } catch (Throwable ignored) { }
    }

    /** SetupActivity/MainActivity 轮询取用（避免直接持有 WebView 引用） */
    private static volatile String uploadCallbackJs = "";

    public static String takeUploadCallback() {
        String s = uploadCallbackJs;
        uploadCallbackJs = "";
        return s;
    }

    /* ── HTTP 工具 ────────────────────────────────────── */

    private byte[] httpGet(String urlStr, String apiKey, int myToken) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", UA);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            if (apiKey != null && !apiKey.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }
            return readBody(conn, myToken);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private byte[] httpPostJson(String urlStr, String json, String apiKey, int myToken) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "*/*");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            if (apiKey != null && !apiKey.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }
            try (OutputStream os = conn.getOutputStream()) {
                os.write(json.getBytes("UTF-8"));
            }
            return readBody(conn, myToken);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String httpPostJsonString(String urlStr, String json, String apiKey, int myToken)
            throws Exception {
        byte[] b = httpPostJson(urlStr, json, apiKey, myToken);
        return new String(b, "UTF-8");
    }

    private byte[] readBody(HttpURLConnection conn, int myToken) throws Exception {
        int code = conn.getResponseCode();
        InputStream is = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        if (is != null) {
            try (InputStream in = new BufferedInputStream(is)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (destroyed || (myToken != 0 && myToken != token)) return null;
                    bos.write(buf, 0, n);
                }
            }
        }
        byte[] data = bos.toByteArray();
        if (code < 200 || code >= 300) {
            String msg = new String(data, 0, Math.min(400, data.length), "UTF-8");
            throw new Exception("HTTP " + code + "：" + translateHttpError(code, msg));
        }
        return data;
    }

    private static String translateHttpError(int code, String body) {
        String base;
        switch (code) {
            case 400: base = "请求参数有误"; break;
            case 401: base = "API Key 无效或未填写"; break;
            case 402: base = "账户余额不足"; break;
            case 403: base = "无权限（SiliconFlow 的克隆音色需实名认证）"; break;
            case 404: base = "接口地址不存在"; break;
            case 429: base = "请求过于频繁，请稍后再试"; break;
            case 503: base = "服务暂时不可用"; break;
            case 504: base = "服务响应超时"; break;
            default: base = "请求失败（HTTP " + code + "）";
        }
        // 尽量提取服务端返回的 message
        try {
            JSONObject o = new JSONObject(body);
            String m = o.optString("message", "");
            if (m.isEmpty()) m = o.optString("error", "");
            if (m.isEmpty()) m = o.optString("detail", "");
            if (!m.isEmpty()) return base + "：" + m;
        } catch (Throwable ignored) { }
        String trimmed = body == null ? "" : body.trim();
        return trimmed.isEmpty() ? base : base + "：" + trimmed.substring(0, Math.min(200, trimmed.length()));
    }

    private static String describe(Throwable e) {
        String msg = e.getMessage();
        return e.getClass().getSimpleName() + (msg == null ? "" : "：" + msg);
    }

    /* ── 播放 ─────────────────────────────────────────── */

    private void playFile(File audio, final int myToken) {
        if (destroyed || myToken != token) return;
        try {
            releasePlayer();
            MediaPlayer mp = new MediaPlayer();
            player = mp;
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            mp.setDataSource(audio.getAbsolutePath());
            mp.setOnPreparedListener(p -> {
                if (destroyed || myToken != token) {
                    try { p.release(); } catch (Exception ignored) { }
                    return;
                }
                try {
                    p.start();
                    if (listener != null) listener.onStart();
                } catch (Exception e) {
                    if (listener != null) listener.onError("播放失败：" + e.getMessage());
                }
            });
            mp.setOnCompletionListener(p -> {
                try { p.release(); } catch (Exception ignored) { }
                if (player == p) player = null;
                if (myToken == token && listener != null) listener.onEnd();
            });
            mp.setOnErrorListener((p, what, extra) -> {
                try { p.release(); } catch (Exception ignored) { }
                if (player == p) player = null;
                if (myToken == token && listener != null) {
                    listener.onError("播放出错（" + what + "/" + extra + "）");
                }
                return true;
            });
            mp.prepareAsync();
        } catch (Exception e) {
            if (myToken == token && listener != null) {
                listener.onError("无法播放音频：" + e.getMessage());
            }
        }
    }

    private void releasePlayer() {
        MediaPlayer p = player;
        player = null;
        if (p != null) {
            try { if (p.isPlaying()) p.stop(); } catch (Exception ignored) { }
            try { p.release(); } catch (Exception ignored) { }
        }
    }

    public void cancel() {
        token++;
        releasePlayer();
    }

    public boolean isSpeaking() {
        try { return player != null && player.isPlaying(); } catch (Exception e) { return false; }
    }

    /** 清空合成缓存（更换音色/服务后调用） */
    public void clearCache() {
        synchronized (cache) {
            for (File f : cache.values()) {
                try { f.delete(); } catch (Throwable ignored) { }
            }
            cache.clear();
            cacheOrder.clear();
        }
    }

    public void destroy() {
        destroyed = true;
        token++;
        releasePlayer();
        pool.shutdownNow();
    }
}
