package com.fairy.mobile;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 云语音识别（STT）——不依赖系统 SpeechRecognizer 服务。
 *
 * 适用场景：设备没有可用的语音识别服务（SpeechRecognizer.isRecognitionAvailable 为 false）。
 * 做法：在原生层用 AudioRecord 录音，生成 WAV，再上传到第三方识别接口。
 *
 * 当前使用的提供者：百度短语音识别（需在设置里填 API Key / Secret Key 换取 token）。
 * 若未配置凭据，会明确回调错误，由界面提示用户去配置。
 */
public class CloudStt {

    public interface Listener {
        void onResult(String text, boolean isFinal);
        void onError(String message);
        void onEnd();
    }

    private static final int SAMPLE_RATE = 16000;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;

    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final File cacheDir;

    private AudioRecord recorder;
    private volatile boolean recording = false;
    private volatile boolean aborted = false;
    private Listener listener;

    private String apiKey = "";
    private String secretKey = "";

    public CloudStt(File cacheDir) {
        this.cacheDir = cacheDir;
        if (!cacheDir.exists()) cacheDir.mkdirs();
    }

    public void setListener(Listener l) { this.listener = l; }

    public void setCredentials(String apiKey, String secretKey) {
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.secretKey = secretKey == null ? "" : secretKey.trim();
    }

    public boolean hasCredentials() {
        return !apiKey.isEmpty() && !secretKey.isEmpty();
    }

    /* ── 录音 ─────────────────────────────────────────── */

    public boolean start() {
        if (recording) return true;
        aborted = false;
        try {
            int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING);
            if (minBuf <= 0) minBuf = SAMPLE_RATE * 2;
            int bufSize = Math.max(minBuf * 2, SAMPLE_RATE);

            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE, CHANNEL, ENCODING, bufSize);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new Exception("录音设备初始化失败");
            }
            recording = true;
            recorder.startRecording();

            final int chunk = 1024;
            final short[] buf = new short[chunk];
            final ByteArrayOutputStream pcm = new ByteArrayOutputStream();

            pool.execute(() -> {
                try {
                    while (recording) {
                        int n = recorder.read(buf, 0, chunk);
                        if (n > 0) {
                            ByteBuffer bb = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN);
                            for (int i = 0; i < n; i++) bb.putShort(buf[i]);
                            pcm.write(bb.array());
                        }
                    }
                } catch (Exception e) {
                    if (!aborted && listener != null) listener.onError("录音失败：" + e.getMessage());
                } finally {
                    // 录音结束后走识别
                    if (!aborted) {
                        byte[] data = pcm.toByteArray();
                        if (data.length < SAMPLE_RATE) { // 少于 0.5 秒视为没说话
                            if (listener != null) {
                                listener.onError("没有听到声音，请靠近麦克风重试");
                                listener.onEnd();
                            }
                        } else {
                            recognize(data);
                        }
                    }
                }
            });
            return true;
        } catch (Exception e) {
            recording = false;
            releaseRecorder();
            if (listener != null) listener.onError("无法开始录音：" + e.getMessage());
            return false;
        }
    }

    /** 结束录音并开始识别 */
    public void stop() {
        if (!recording) return;
        recording = false;
        releaseRecorder();
    }

    /** 中止：丢弃本次录音且不做识别 */
    public void abort() {
        aborted = true;
        recording = false;
        releaseRecorder();
    }

    private void releaseRecorder() {
        AudioRecord r = recorder;
        recorder = null;
        if (r != null) {
            try { if (r.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) r.stop(); } catch (Exception ignored) { }
            try { r.release(); } catch (Exception ignored) { }
        }
    }

    /* ── 识别 ─────────────────────────────────────────── */

    private void recognize(byte[] pcm) {
        if (!hasCredentials()) {
            if (listener != null) {
                listener.onError("未配置云识别密钥。请在「设置 → 语音」里填写，或改用系统识别。");
                listener.onEnd();
            }
            return;
        }
        try {
            File wav = new File(cacheDir, "stt_" + System.currentTimeMillis() + ".wav");
            writeWav(wav, pcm, SAMPLE_RATE, 1, 16);

            String token = fetchBaiduToken();
            if (token == null) throw new Exception("获取识别 token 失败");

            String text = baiduRecognize(wav, token);
            if (listener != null) {
                if (text != null && !text.isEmpty()) listener.onResult(text, true);
                else listener.onError("没有识别到内容");
                listener.onEnd();
            }
            //noinspection ResultOfMethodCallIgnored
            wav.delete();
        } catch (Exception e) {
            if (listener != null) {
                listener.onError("云识别失败：" + e.getMessage());
                listener.onEnd();
            }
        }
    }

    private static void writeWav(File out, byte[] pcm, int sampleRate, int channels, int bits) throws Exception {
        int byteRate = sampleRate * channels * bits / 8;
        try (DataOutputStream dos = new DataOutputStream(new FileOutputStream(out))) {
            dos.writeBytes("RIFF");
            dos.writeInt(Integer.reverseBytes(36 + pcm.length));
            dos.writeBytes("WAVE");
            dos.writeBytes("fmt ");
            dos.writeInt(Integer.reverseBytes(16));
            dos.writeShort(Short.reverseBytes((short) 1));
            dos.writeShort(Short.reverseBytes((short) channels));
            dos.writeInt(Integer.reverseBytes(sampleRate));
            dos.writeInt(Integer.reverseBytes(byteRate));
            dos.writeShort(Short.reverseBytes((short) (channels * bits / 8)));
            dos.writeShort(Short.reverseBytes((short) bits));
            dos.writeBytes("data");
            dos.writeInt(Integer.reverseBytes(pcm.length));
            dos.write(pcm);
        }
    }

    /** 用 API Key / Secret Key 换取 access_token */
    private String fetchBaiduToken() throws Exception {
        String url = "https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials"
                + "&client_id=" + java.net.URLEncoder.encode(apiKey, "UTF-8")
                + "&client_secret=" + java.net.URLEncoder.encode(secretKey, "UTF-8");
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
            String body = readAll(conn.getInputStream());
            org.json.JSONObject o = new org.json.JSONObject(body);
            if (o.has("access_token")) return o.getString("access_token");
            throw new Exception(o.optString("error_description", "未知错误"));
        } finally {
            conn.disconnect();
        }
    }

    private String baiduRecognize(File wav, String token) throws Exception {
        String boundary = "----fairy" + System.currentTimeMillis();
        String url = "https://vop.baidu.com/server_api";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Content-Type", "audio/wav; rate=16000");

            byte[] audio = java.nio.file.Files.readAllBytes(wav.toPath());
            org.json.JSONObject payload = new org.json.JSONObject();
            payload.put("format", "wav");
            payload.put("rate", SAMPLE_RATE);
            payload.put("channel", 1);
            payload.put("cuid", "fairy-mobile");
            payload.put("token", token);
            payload.put("speech", android.util.Base64.encodeToString(audio, android.util.Base64.NO_WRAP));
            payload.put("len", audio.length);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload.toString().getBytes("UTF-8"));
            }

            int code = conn.getResponseCode();
            InputStream is = code == 200 ? conn.getInputStream() : conn.getErrorStream();
            String body = is == null ? "" : readAll(is);
            if (code != 200) throw new Exception("HTTP " + code + " " + body);

            org.json.JSONObject o = new org.json.JSONObject(body);
            if (o.optInt("err_no", -1) != 0) {
                throw new Exception(o.optString("err_msg", "识别服务返回错误"));
            }
            org.json.JSONArray arr = o.optJSONArray("result");
            if (arr != null && arr.length() > 0) return arr.getString(0);
            return null;
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "UTF-8");
    }

    public void destroy() {
        abort();
        pool.shutdownNow();
    }
}
