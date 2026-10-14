package com.fairy.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * Fairy 的 WebView 壳。
 *
 * 设计要点：
 *   1. 将打包在 assets/www 下的 PWA 以 file:// 方式加载，零原生依赖。
 *   2. 语音朗读有两条路径：
 *      - 系统 TTS（设备自带的语音引擎）
 *      - 云端 TTS（SiliconFlow / 百度 / 自定义），由原生层发 HTTP，规避 CORS
 *      页面可自由切换；两者都不可用时降级为提示。
 *   3. 语音输入：优先系统识别，不可用时走云识别（需配置凭据）。
 *   4. 崩溃守卫：主线程未处理异常会写入文件，下次启动可见，便于排障。
 *
 * 本类不做任何可能失败的重活；所有网络请求都在后台线程（见 CloudTts）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "Fairy";

    private static final int REQ_RECORD_AUDIO = 1001;
    private static final int REQ_SPEECH_DIALOG = 1002;
    private static final int REQ_FILE_CHOOSER = 1003;

    /** 悬浮球点击后带过来的标记：要求直接进入语音输入 */
    public static final String EXTRA_FROM_FLOATING_BALL = "fairy.from_floating_ball";
    /** 启动模式为 singleTop，重复点击走 onNewIntent，这里记录待处理的请求 */
    private volatile boolean pendingVoiceFromBall = false;

    private WebView webView;
    /** 页面发起的文件选择回调（WebChromeClient 要求） */
    private ValueCallback<Uri[]> pendingFileCallback;

    // ── 系统 TTS ──────────────────────────────────────────
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String lastTtsError = "";
    private String ttsEnginePackage = "";
    private java.util.List<String> cachedEngines = new java.util.ArrayList<>();
    private final java.util.Set<String> triedEngines = new java.util.HashSet<>();

    /** Fairy 语音引擎包名（若用户单独安装过则可优先使用） */
    private static final String FAIRY_ENGINE_PKG = "com.fairy.ttsengine";

    // ── 云端 TTS ──────────────────────────────────────────
    private CloudTts cloudTts;
    /** 是否优先使用云 TTS（由页面设置决定） */
    private volatile boolean preferCloud = false;

    // ── 云识别 ────────────────────────────────────────────
    private CloudStt cloudStt;
    private boolean useCloudStt = true;

    // ── 联网搜索 ──────────────────────────────────────────
    private SearchClient searchClient;

    // ── 系统识别 ──────────────────────────────────────────
    private SpeechRecognizer recognizer;
    private boolean sttListening = false;
    private boolean sttAborted = false;
    private boolean sttStartPending = false;
    private String sttPendingLang = "zh-CN";

    // ── 诊断 ──────────────────────────────────────────────
    private static volatile String crashInfo = "";
    private String lastCrash = "";
    private String cloudError = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        installCrashGuard();
        // 冷启动时也可能由悬浮球拉起
        try {
            Intent it = getIntent();
            if (it != null && it.getBooleanExtra(EXTRA_FROM_FLOATING_BALL, false)) {
                pendingVoiceFromBall = true;
            }
        } catch (Throwable ignored) { }
        try {
            buildUi();
        } catch (Throwable e) {
            crashInfo = describe(e);
            try {
                android.widget.TextView tv = new android.widget.TextView(this);
                tv.setText("Fairy 启动失败\n\n" + crashInfo + "\n\n请把这段话截图反馈。");
                tv.setPadding(48, 96, 48, 48);
                tv.setTextSize(14f);
                setContentView(tv);
            } catch (Throwable ignored) { }
        }
    }

    private static String describe(Throwable e) {
        String msg = e.getMessage();
        return e.getClass().getSimpleName() + (msg == null ? "" : "：" + msg);
    }

    private void installCrashGuard() {
        try {
            File f = new File(getFilesDir(), "last-crash.txt");
            if (f.exists()) {
                byte[] buf = new byte[(int) Math.min(f.length(), 4096)];
                try (FileInputStream in = new FileInputStream(f)) {
                    int n = in.read(buf);
                    if (n > 0) lastCrash = new String(buf, 0, n, "UTF-8");
                }
            }
        } catch (Throwable ignored) { }

        try {
            final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
                try {
                    crashInfo = describe(e);
                    Log.e("FairyCrash", "未捕获异常", e);
                    CrashActivity.saveCrash(getApplicationContext(), e);
                    Intent ci = new Intent(MainActivity.this, CrashActivity.class);
                    ci.putExtra(CrashActivity.EXTRA_LOG, describe(e));
                    ci.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    startActivity(ci);
                } catch (Throwable ignored) { }
                if (prev != null) prev.uncaughtException(thread, e);
            });
        } catch (Throwable ignored) { }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildUi() {
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // Android 10+ 起 file:// 页面默认禁访问同源资源与注入接口
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);

        webView.addJavascriptInterface(new FairyBridge(), "AndroidBridge");

        // 必须设置 WebChromeClient 并实现 onShowFileChooser，
        // 否则页面里的 <input type="file"> 点击**毫无反应** ——
        // 这是 Android WebView 的硬性要求，不是可选项。
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                // 前一次未完成的选择要取消，否则后续点击不再触发
                if (pendingFileCallback != null) {
                    try { pendingFileCallback.onReceiveValue(null); } catch (Throwable ignored) { }
                    pendingFileCallback = null;
                }
                pendingFileCallback = filePathCallback;
                try {
                    Intent intent = fileChooserParams.createIntent();
                    // 明确只允许选择音频，减少误选
                    intent.setType("audio/*");
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (Throwable e) {
                    // 退化到通用文件选择
                    try {
                        Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
                        fallback.addCategory(Intent.CATEGORY_OPENABLE);
                        fallback.setType("*/*");
                        startActivityForResult(
                                Intent.createChooser(fallback, "选择 Fairy 的录音"), REQ_FILE_CHOOSER);
                        return true;
                    } catch (Throwable e2) {
                        pendingFileCallback = null;
                        notifyJs("window.__fairyCloud && window.__fairyCloud.onUploadResult && "
                                + "window.__fairyCloud.onUploadResult(false, '无法打开文件选择器')");
                        return false;
                    }
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file:///android_asset/") || url.startsWith("about:")) {
                    return false;
                }
                openExternal(url);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pushVoiceStatus();
            }
        });

        safeInit("系统语音引擎", this::initTts);
        safeInit("云语音", this::initCloudTts);
        safeInit("云识别", this::initCloudStt);
        safeInit("联网搜索", this::initSearch);

        webView.loadUrl("file:///android_asset/www/index.html");
        setContentView(webView);
    }

    /** 逐个安全初始化：任何一环失败都不影响其余功能 */
    private void safeInit(String name, Runnable step) {
        try {
            step.run();
        } catch (Throwable e) {
            cloudError = (cloudError.isEmpty() ? "" : cloudError + "；")
                    + name + " 初始化失败：" + describe(e);
        }
    }

    /* ── 云语音 ────────────────────────────────────────── */

    private void initCloudTts() {
        try {
            cloudTts = new CloudTts(new File(getCacheDir(), "cloudtts"));
            cloudTts.setListener(new CloudTts.Listener() {
                @Override
                public void onStart() {
                    notifyJs("window.__fairyVoice && __fairyVoice.onTtsStart && __fairyVoice.onTtsStart()");
                }

                @Override
                public void onEnd() {
                    notifyJs("window.__fairyVoice && __fairyVoice.onTtsEnd && __fairyVoice.onTtsEnd()");
                }

                @Override
                public void onError(String message) {
                    notifyJs("window.__fairyVoice && window.__fairyVoice.onTtsError && "
                            + "window.__fairyVoice.onTtsError(" + jsString(message) + ")");
                }
            });
        } catch (Throwable e) {
            cloudTts = null;
            cloudError = "云语音初始化失败：" + describe(e);
        }
    }

    private void initCloudStt() {
        try {
            cloudStt = new CloudStt(new File(getCacheDir(), "cloudstt"));
            cloudStt.setListener(new CloudStt.Listener() {
                @Override
                public void onResult(String text, boolean isFinal) {
                    notifyJs("window.__fairyVoice && window.__fairyVoice.onSttResult && "
                            + "window.__fairyVoice.onSttResult(" + jsString(text) + ", "
                            + (isFinal ? "true" : "false") + ")");
                }

                @Override
                public void onError(String message) {
                    notifyJs("window.__fairyVoice && window.__fairyVoice.onSttError && "
                            + "window.__fairyVoice.onSttError(" + jsString(message) + ")");
                }

                @Override
                public void onEnd() {
                    notifyJs("window.__fairyVoice && window.__fairyVoice.onSttEnd && "
                            + "window.__fairyVoice.onSttEnd()");
                }
            });
        } catch (Throwable e) {
            cloudStt = null;
        }
    }

    /* ── 联网搜索 ──────────────────────────────────────── */

    private void initSearch() {
        try {
            searchClient = new SearchClient();
        } catch (Throwable e) {
            searchClient = null;
        }
    }

    /* ── 系统 TTS ──────────────────────────────────────── */

    private void initTts() {
        cachedEngines = listTtsEngines();
        triedEngines.clear();
        // 若装了 Fairy 语音引擎则优先用它
        if (cachedEngines.contains(FAIRY_ENGINE_PKG)) {
            triedEngines.add(FAIRY_ENGINE_PKG);
            initTtsWith(FAIRY_ENGINE_PKG);
            return;
        }
        initTtsWith(null);
    }

    private void initTtsWith(String enginePackage) {
        try {
            if (tts != null) {
                try { tts.shutdown(); } catch (Exception ignored) { }
                tts = null;
            }
        } catch (Exception ignored) { }

        TextToSpeech.OnInitListener listener = (status) -> {
            if (status != TextToSpeech.SUCCESS) {
                ttsReady = false;
                lastTtsError = "onInit 返回 " + status;
                tryNextEngine();
                return;
            }
            try {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String id) {
                        notifyJs("window.__fairyVoice && __fairyVoice.onTtsStart && __fairyVoice.onTtsStart()");
                    }

                    @Override
                    public void onDone(String id) {
                        notifyJs("window.__fairyVoice && __fairyVoice.onTtsEnd && __fairyVoice.onTtsEnd()");
                    }

                    @Override
                    @SuppressWarnings("deprecation")
                    public void onError(String id) {
                        notifyJs("window.__fairyVoice && __fairyVoice.onTtsError && __fairyVoice.onTtsError('朗读失败')");
                    }
                });
            } catch (Exception ignored) { }

            boolean langOk = false;
            try {
                int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                langOk = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                if (!langOk) {
                    r = tts.setLanguage(Locale.getDefault());
                    langOk = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                }
            } catch (Exception e) {
                lastTtsError = "setLanguage 异常：" + e.getMessage();
            }
            ttsReady = true;
            lastTtsError = langOk ? "" : "引擎已就绪但没有中文语音包";
            pushVoiceStatus();
        };

        try {
            ttsEnginePackage = enginePackage == null ? "" : enginePackage;
            tts = enginePackage == null
                    ? new TextToSpeech(getApplicationContext(), listener)
                    : new TextToSpeech(getApplicationContext(), listener, enginePackage);
        } catch (Exception e) {
            ttsReady = false;
            lastTtsError = "构造异常：" + e.getMessage();
            tryNextEngine();
        }
    }

    /** 列出系统已装 TTS 引擎（反射，失败返回空表） */
    private java.util.List<String> listTtsEngines() {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            Class<?> cls = Class.forName("android.speech.tts.TtsEngines");
            Object helper = cls.getConstructor(android.content.Context.class).newInstance(this);
            Object res = cls.getMethod("getEngines").invoke(helper);
            if (res instanceof java.util.List) {
                for (Object item : (java.util.List<?>) res) {
                    Object name = item.getClass().getField("name").get(item);
                    if (name != null) out.add(String.valueOf(name));
                }
            }
        } catch (Throwable ignored) { }
        return out;
    }

    private void tryNextEngine() {
        try {
            java.util.List<String> list = cachedEngines.isEmpty() ? listTtsEngines() : cachedEngines;
            for (String pkg : list) {
                if (triedEngines.contains(pkg)) continue;
                triedEngines.add(pkg);
                initTtsWith(pkg);
                return;
            }
            ttsReady = false;
            if (lastTtsError.isEmpty()) {
                lastTtsError = list.isEmpty() ? "系统未安装任何语音引擎" : "已尝试全部引擎但均未就绪";
            }
            pushVoiceStatus();
        } catch (Throwable e) {
            ttsReady = false;
            if (lastTtsError.isEmpty()) lastTtsError = "枚举引擎失败：" + e.getMessage();
            pushVoiceStatus();
        }
    }

    private void openTtsSettings() {
        try {
            Intent intent = new Intent("com.android.settings.TTS_SETTINGS");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(android.provider.Settings.ACTION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(fallback);
            } catch (Exception ignored) { }
        }
    }

    /* ── 系统识别 ──────────────────────────────────────── */

    private boolean hasRecognizerActivity() {
        try {
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            return intent.resolveActivity(getPackageManager()) != null;
        } catch (Exception e) {
            return false;
        }
    }

    private void startSystemRecognizer(String lang) {
        try {
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang != null && !lang.isEmpty() ? lang : "zh-CN");
            intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "请说话…");
            startActivityForResult(intent, REQ_SPEECH_DIALOG);
        } catch (Exception e) {
            notifyJs("window.__fairyVoice && __fairyVoice.onSttError && __fairyVoice.onSttError('无法启动系统语音识别')");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        // 页面里 <input type=file> 的选择结果必须回传给 WebView，否则前端拿不到文件
        if (requestCode == REQ_FILE_CHOOSER) {
            ValueCallback<Uri[]> cb = pendingFileCallback;
            pendingFileCallback = null;
            if (cb == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    result = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        result[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            try { cb.onReceiveValue(result); } catch (Throwable ignored) { }
            return;
        }

        if (requestCode != REQ_SPEECH_DIALOG) return;
        if (resultCode == RESULT_OK && data != null) {
            java.util.ArrayList<String> list = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (list != null && !list.isEmpty()) {
                notifyJs("window.__fairyVoice && window.__fairyVoice.onSttResult && "
                        + "window.__fairyVoice.onSttResult(" + jsString(list.get(0)) + ", true)");
                return;
            }
        }
        notifyJs("window.__fairyVoice && window.__fairyVoice.onSttEnd && window.__fairyVoice.onSttEnd()");
    }

    private void doSttStart(String lang) {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            if (useCloudStt && cloudStt != null) { cloudStt.start(); return; }
            if (hasRecognizerActivity()) startSystemRecognizer(lang);
            else notifyJs("window.__fairyVoice && __fairyVoice.onSttError && "
                    + "__fairyVoice.onSttError('此设备没有可用的语音识别服务')");
            return;
        }
        if (recognizer == null) {
            try {
                recognizer = SpeechRecognizer.createSpeechRecognizer(this);
                recognizer.setRecognitionListener(sttListener);
            } catch (Exception e) {
                if (hasRecognizerActivity()) startSystemRecognizer(lang);
                else notifyJs("window.__fairyVoice && __fairyVoice.onSttError && "
                        + "__fairyVoice.onSttError('无法创建语音识别器')");
                return;
            }
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang != null && !lang.isEmpty() ? lang : "zh-CN");
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        sttListening = true;
        sttAborted = false;
        try {
            recognizer.startListening(intent);
        } catch (Exception e) {
            sttListening = false;
            notifyJs("window.__fairyVoice && __fairyVoice.onSttError && __fairyVoice.onSttError('无法启动语音识别')");
        }
    }

    private final RecognitionListener sttListener = new RecognitionListener() {
        @Override public void onReadyForSpeech(Bundle params) { }
        @Override public void onBeginningOfSpeech() { }
        @Override public void onRmsChanged(float rmsdB) { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = firstSpeechResult(partialResults);
            if (text == null) return;
            notifyJs("window.__fairyVoice && window.__fairyVoice.onSttResult && "
                    + "window.__fairyVoice.onSttResult(" + jsString(text) + ", false)");
        }

        @Override
        public void onResults(Bundle results) {
            sttListening = false;
            String text = firstSpeechResult(results);
            if (text != null) {
                notifyJs("window.__fairyVoice && window.__fairyVoice.onSttResult && "
                        + "window.__fairyVoice.onSttResult(" + jsString(text) + ", true)");
            }
        }

        @Override
        public void onError(int error) {
            sttListening = false;
            if (sttAborted) return;
            notifyJs("window.__fairyVoice && window.__fairyVoice.onSttError && "
                    + "window.__fairyVoice.onSttError(" + jsString(sttErrorMessage(error)) + ")");
        }

        @Override public void onEvent(int eventType, Bundle params) { }
    };

    private String firstSpeechResult(Bundle bundle) {
        if (bundle == null) return null;
        try {
            java.util.ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty()) return list.get(0);
        } catch (Exception ignored) { }
        return null;
    }

    private String sttErrorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO: return "麦克风不可用，请检查是否被占用";
            case SpeechRecognizer.ERROR_CLIENT: return "语音识别被中断";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "缺少录音权限";
            case SpeechRecognizer.ERROR_NETWORK: return "网络错误，语音识别不可用";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "网络超时，请重试";
            case SpeechRecognizer.ERROR_NO_MATCH: return "没有识别到语音";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "识别服务正忙，请稍后";
            case SpeechRecognizer.ERROR_SERVER: return "语音识别服务错误";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "没有听到声音";
            default: return "语音识别失败";
        }
    }

    /* ── 权限与生命周期 ────────────────────────────────── */

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_RECORD_AUDIO) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                if (sttStartPending) {
                    sttStartPending = false;
                    doSttStart(sttPendingLang);
                }
            } else {
                sttStartPending = false;
                notifyJs("window.__fairyVoice && __fairyVoice.onSttError && "
                        + "__fairyVoice.onSttError('麦克风权限被拒绝，无法使用语音输入')");
            }
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra(EXTRA_FROM_FLOATING_BALL, false)) {
            pendingVoiceFromBall = true;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 悬浮球可能在我们不在前台时被点击，这里补处理
        if (FloatingBallService.VoiceRequest.consume()) {
            pendingVoiceFromBall = true;
        }
        if (pendingVoiceFromBall) {
            pendingVoiceFromBall = false;
            triggerVoiceInputFromBall();
        }
    }

    /**
     * 悬浮球请求的语音输入：通知页面进入语音面板并开始说话。
     *
     * 页面可能尚未加载完成（冷启动），因此带重试——
     * 直接调用会在页面就绪前丢失。
     */
    private void triggerVoiceInputFromBall() {
        final int[] attempts = {0};
        final android.os.Handler h = new android.os.Handler(getMainLooper());
        Runnable r = new Runnable() {
            @Override
            public void run() {
                attempts[0]++;
                boolean delivered = false;
                if (webView != null) {
                    try {
                        // 页面通过 window.__fairyVoice.onFloatingBallTap 接收
                        webView.evaluateJavascript(
                                "window.__fairyVoice && window.__fairyVoice.onFloatingBallTap"
                                        + " && window.__fairyVoice.onFloatingBallTap()",
                                value -> { });
                        delivered = true;
                    } catch (Throwable ignored) { }
                }
                // 页面还没就绪就继续重试，最多约 8 秒
                if (!delivered && attempts[0] < 20) {
                    h.postDelayed(this, 400);
                }
            }
        };
        h.postDelayed(r, 300);
    }

    @Override
    protected void onDestroy() {
        if (tts != null) {
            try { tts.stop(); tts.shutdown(); } catch (Exception ignored) { }
            tts = null;
        }
        if (cloudTts != null) {
            try { cloudTts.destroy(); } catch (Exception ignored) { }
            cloudTts = null;
        }
        if (cloudStt != null) {
            try { cloudStt.destroy(); } catch (Exception ignored) { }
            cloudStt = null;
        }
        if (recognizer != null) {
            try { recognizer.destroy(); } catch (Exception ignored) { }
            recognizer = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        if (pendingFileCallback != null) {
            try { pendingFileCallback.onReceiveValue(null); } catch (Throwable ignored) { }
            pendingFileCallback = null;
        }
        super.onDestroy();
    }

    /* ── 工具 ──────────────────────────────────────────── */

    /** 读取 assets 中的文件（失败返回 null） */
    private byte[] readAsset(String path) {
        try (InputStream in = getAssets().open(path)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } catch (Throwable e) {
            Log.w(TAG, "读取 assets 失败：" + path, e);
            return null;
        }
    }

    private void openExternal(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception ignored) { }
    }

    private void notifyJs(String code) {
        if (webView == null) return;
        runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(code, null);
            } catch (Exception ignored) { }
        });
    }

    private void pushVoiceStatus() {
        boolean usable = ttsReady || (cloudTts != null);
        notifyJs("window.__fairyVoice && window.__fairyVoice.onTtsReady && "
                + "window.__fairyVoice.onTtsReady(" + (usable ? "'1'" : "'0'") + ")");
    }

    private static String jsString(String s) {
        return JSONObject.quote(s == null ? "" : s);
    }

    /* ── JS 桥 ─────────────────────────────────────────── */

    /**
     * 暴露给 JS 的桥。
     * 所有返回值都用 String（@JavascriptInterface 对装箱类型支持不可靠）。
     */
    public class FairyBridge {

        @JavascriptInterface
        public void openExternal(String url) {
            MainActivity.this.openExternal(url);
        }

        @JavascriptInterface
        public String isNative() {
            return "1";
        }

        /* ── 合成方式切换 ── */

        /** 'cloud' 优先云 TTS，'system' 优先系统引擎 */
        @JavascriptInterface
        public void setTtsBackend(String backend) {
            preferCloud = "cloud".equals(backend);
            pushVoiceStatus();
        }

        @JavascriptInterface
        public String ttsBackend() {
            if (preferCloud && cloudTts != null) return "cloud";
            if (ttsReady) return "system";
            if (cloudTts != null) return "cloud";
            return "none";
        }

        @JavascriptInterface
        public String ttsSupported() {
            return (ttsReady || cloudTts != null) ? "1" : "0";
        }

        /* ── 朗读 ── */

        /**
         * 朗读。paramsJson 由 JS 组装（provider/baseUrl/apiKey/model/voice/speed）。
         * 云 TTS 请求在原生层发出，规避浏览器 CORS。
         */
        @JavascriptInterface
        public void ttsSpeakCloud(String text, String paramsJson) {
            if (text == null) return;
            if (cloudTts == null) {
                notifyJs("window.__fairyVoice && __fairyVoice.onTtsError && "
                        + "__fairyVoice.onTtsError('云语音不可用')");
                return;
            }
            // 记住参数，便于系统引擎不可用时回退
            lastCloudParams = paramsJson == null ? "{}" : paramsJson;
            try {
                JSONObject p = new JSONObject(lastCloudParams);
                cloudTts.setSpeed((float) p.optDouble("speed", 1.0));
            } catch (Throwable ignored) { }
            cloudTts.speak(text, lastCloudParams);
        }

        /** 用系统 TTS 朗读 */
        @JavascriptInterface
        public void ttsSpeak(String text) {
            if (text == null) return;
            if (preferCloud && cloudTts != null) {
                // 页面上选择了云语音但走了系统入口：交给页面处理
                notifyJs("window.__fairyVoice && __fairyVoice.onTtsError && "
                        + "__fairyVoice.onTtsError('当前设为云语音，请通过云接口朗读')");
                return;
            }
            if (ttsReady && tts != null) {
                try {
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "fairy-tts");
                    return;
                } catch (Exception ignored) { }
            }
            if (cloudTts != null) {
                // 系统引擎不可用时自动退回云语音（使用页面最后一次给的参数）
                cloudTts.speak(text, lastCloudParams);
                return;
            }
            notifyJs("window.__fairyVoice && __fairyVoice.onTtsError && "
                    + "__fairyVoice.onTtsError('没有可用的语音引擎')");
        }

        @JavascriptInterface
        public void ttsStop() {
            try { if (tts != null) tts.stop(); } catch (Exception ignored) { }
            try { if (cloudTts != null) cloudTts.cancel(); } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void ttsSetRate(String rate) {
            try {
                float r = Float.parseFloat(rate);
                if (tts != null) tts.setSpeechRate(r);
                if (cloudTts != null) cloudTts.setSpeed(r);
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void ttsSetPitch(String pitch) {
            try {
                if (tts != null) tts.setPitch(Float.parseFloat(pitch));
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public String ttsIsSpeaking() {
            try {
                if (tts != null && tts.isSpeaking()) return "1";
                if (cloudTts != null && cloudTts.isSpeaking()) return "1";
            } catch (Exception ignored) { }
            return "0";
        }

        @JavascriptInterface
        public String ttsListVoices() {
            JSONArray arr = new JSONArray();
            try {
                if (ttsReady && tts != null) {
                    for (Voice v : tts.getVoices()) {
                        JSONObject o = new JSONObject();
                        o.put("uri", v.getName());
                        o.put("name", v.getName());
                        o.put("lang", v.getLocale() != null ? v.getLocale().toLanguageTag() : "");
                        o.put("local", !v.isNetworkConnectionRequired());
                        arr.put(o);
                    }
                }
            } catch (Exception ignored) { }
            return arr.toString();
        }

        @JavascriptInterface
        public void ttsSetVoice(String name) {
            if (tts == null || !ttsReady || name == null) return;
            try {
                for (Voice v : tts.getVoices()) {
                    if (name.equals(v.getName())) { tts.setVoice(v); return; }
                }
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void openTtsSettings() {
            MainActivity.this.openTtsSettings();
        }

        @JavascriptInterface
        public void ttsReinit() {
            runOnUiThread(MainActivity.this::initTts);
        }

        /* ── 音色克隆上传 ── */

        /**
         * 上传参考音频以克隆音色。
         * 音频以 base64 传入（由 JS 从设置里的路径读取），原生负责上传。
         * 完成后回调 window.__fairyCloud.onUploadResult(ok, uriOrError)。
         */
        @JavascriptInterface
        public void uploadVoice(String apiKey, String baseUrl, String model,
                                String name, String audioBase64, String mimeType,
                                String refText) {
            if (cloudTts == null) {
                notifyJs("window.__fairyCloud && window.__fairyCloud.onUploadResult && "
                        + "window.__fairyCloud.onUploadResult(false, '云语音不可用')");
                return;
            }
            cloudTts.uploadVoice(apiKey, baseUrl, model, name, audioBase64, mimeType, refText);
            startUploadCallbackPump();
        }

        /* ── 语音输入 ── */

        @JavascriptInterface
        public String sttSupported() {
            try {
                if (SpeechRecognizer.isRecognitionAvailable(MainActivity.this)) return "1";
                if (useCloudStt && cloudStt != null && cloudStt.hasCredentials()) return "1";
                if (hasRecognizerActivity()) return "1";
                return "0";
            } catch (Exception e) {
                return "0";
            }
        }

        @JavascriptInterface
        public void sttStart(String lang) {
            final String l = lang;
            runOnUiThread(() -> {
                sttPendingLang = l != null && !l.isEmpty() ? l : "zh-CN";
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    sttStartPending = true;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
                } else {
                    sttStartPending = false;
                    doSttStart(sttPendingLang);
                }
            });
        }

        @JavascriptInterface
        public void sttSetCredentials(String apiKey, String secretKey) {
            if (cloudStt != null) cloudStt.setCredentials(apiKey, secretKey);
        }

        @JavascriptInterface
        public String sttCloudReady() {
            return (cloudStt != null && cloudStt.hasCredentials()) ? "1" : "0";
        }

        @JavascriptInterface
        public String sttBackend() {
            if (SpeechRecognizer.isRecognitionAvailable(MainActivity.this)) return "system";
            if (useCloudStt && cloudStt != null && cloudStt.hasCredentials()) return "cloud";
            if (useCloudStt && cloudStt != null) return "cloud-nocred";
            return "none";
        }

        @JavascriptInterface
        public void sttStop() {
            sttListening = false;
            try { if (cloudStt != null) cloudStt.stop(); } catch (Exception ignored) { }
            if (recognizer != null) {
                try { recognizer.stopListening(); } catch (Exception ignored) { }
            }
        }

        @JavascriptInterface
        public void sttCancel() {
            sttListening = false;
            sttAborted = true;
            try { if (cloudStt != null) cloudStt.abort(); } catch (Exception ignored) { }
            if (recognizer != null) {
                try { recognizer.cancel(); } catch (Exception ignored) { }
            }
        }

        /* ── 悬浮球（语音唤醒入口）── */

        /**
         * 查询悬浮球状态。
         * 返回 JSON：{"supported":"1","permission":"1","running":"1","status":"..."}
         *   supported  —— 系统是否支持（API 23+ 才有悬浮窗概念）
         *   permission —— 是否已获得悬浮窗权限
         *   running    —— 悬浮球当前是否在显示
         */
        @JavascriptInterface
        public String floatingBallStatus() {
            JSONObject o = new JSONObject();
            try {
                boolean supported = android.os.Build.VERSION.SDK_INT >= 23;
                o.put("supported", supported ? "1" : "0");
                o.put("permission", FloatingBallService.canDrawOverlay(MainActivity.this) ? "1" : "0");
                o.put("running", FloatingBallService.running ? "1" : "0");
                o.put("status", FloatingBallService.statusText);
                o.put("error", FloatingBallService.lastError);
                o.put("sdk", android.os.Build.VERSION.SDK_INT);
                // 是否已安装但被系统禁用（部分 ROM 会这样）
                o.put("pkg", getPackageName());
            } catch (Throwable e) {
                try { o.put("fatal", describe(e)); } catch (Throwable ignored) { }
            }
            return o.toString();
        }

        /**
         * 开启悬浮球。
         *
         * 返回状态字符串，便于页面立即判断：
         *   "1"                 已开启且服务确认存活
         *   "noperm"            缺悬浮窗权限
         *   "failed:<原因>"     服务启动后未能创建窗口
         *   "error:<原因>"      调用异常
         *
         * 注意：startService 是异步的，返回成功不代表服务真的起来了。
         * 因此这里**等待最多约 1.2 秒**确认 running 变为 true，
         * 否则把服务的失败原因回传给页面 —— 避免页面因为读不到状态
         * 而把用户刚勾选的开关又取消掉（曾出现的现象）。
         */
        @JavascriptInterface
        public String floatingBallStart() {
            try {
                if (!FloatingBallService.canDrawOverlay(MainActivity.this)) return "noperm";

                FloatingBallService.lastError = "";
                FloatingBallService.start(MainActivity.this);

                // 轮询确认（服务在后台线程创建窗口）
                for (int i = 0; i < 24; i++) {
                    if (FloatingBallService.running) return "1";
                    String err = FloatingBallService.lastError;
                    if (err != null && !err.isEmpty()) return "failed:" + err;
                    try { Thread.sleep(50); } catch (InterruptedException ignored) { }
                }
                String err = FloatingBallService.lastError;
                return "failed:" + (err == null || err.isEmpty() ? "服务未能在预期时间内启动" : err);
            } catch (Throwable e) {
                return "error:" + describe(e);
            }
        }

        /** 关闭悬浮球 */
        @JavascriptInterface
        public String floatingBallStop() {
            try {
                FloatingBallService.stop(MainActivity.this);
                return "1";
            } catch (Throwable e) {
                return "error:" + describe(e);
            }
        }

        /**
         * 跳转到系统的「显示在其他应用上层」授权页。
         * 悬浮窗权限无法用 requestPermissions 申请，只能这样引导。
         */
        @JavascriptInterface
        public void floatingBallRequestPermission() {
            runOnUiThread(() -> {
                try {
                    if (android.os.Build.VERSION.SDK_INT >= 23) {
                        Intent i = new Intent(
                                android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                Uri.parse("package:" + getPackageName()));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    }
                } catch (Throwable e) {
                    // 某些 ROM 没有该页面，退回应用详情页
                    try {
                        Intent i = new Intent(
                                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:" + getPackageName()));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    } catch (Throwable ignored) { }
                }
            });
        }

        /* ── 内置参考录音 ── */

        /**
         * 读取用户放入的参考录音，返回 base64（不含 data URI 前缀）。
         *
         * 为什么不内置录音：参考录音通常是某作品角色的语音片段，随仓库/APK
         * 分发会涉及第三方版权。因此本项目**不分发任何音频素材**，
         * 只提供克隆能力，由使用者自行准备录音。
         *
         * 查找顺序：
         *   1. 外部私有目录（用户可直接用文件管理器放入）
         *      /sdcard/Android/data/com.fairy.mobile/files/
         *   2. APK 内置 assets（仅在开发者自行放入时才存在）
         *
         * 为什么要走原生：WebView 在 file:// 下无法可靠读取 assets 中的二进制，
         * 也读不到外部私有目录；原生侧可以直接读。
         *
         * 返回 JSON：{"ok":"1","base64":"...","mime":"...","text":"..."}
         * 失败时 ok 为 "0"，error 说明原因与放置路径。
         */
        @JavascriptInterface
        public String readBuiltinVoice() {
            JSONObject out = new JSONObject();
            try {
                byte[] data = null;
                String mime = "audio/wav";
                String from = "";

                // 1) 外部私有目录：支持常见音频格式
                File dir = getExternalFilesDir(null);
                if (dir != null && dir.isDirectory()) {
                    String[][] cands = {
                            {"fairy-ref.wav", "audio/wav"},
                            {"fairy-ref.mp3", "audio/mpeg"},
                            {"fairy-ref.m4a", "audio/mp4"},
                            {"fairy.wav", "audio/wav"},
                            {"fairy.mp3", "audio/mpeg"},
                            {"fairy.m4a", "audio/mp4"},
                    };
                    for (String[] c : cands) {
                        File f = new File(dir, c[0]);
                        if (f.isFile() && f.length() > 0) {
                            data = readFileBytes(f);
                            mime = c[1];
                            from = "外部目录：" + c[0];
                            break;
                        }
                    }
                }

                // 2) 内置 assets（仅当开发者自行放入）
                if (data == null) {
                    byte[] wav = readAsset("www/voice/fairy-ref.wav");
                    if (wav != null && wav.length > 0) {
                        data = wav;
                        from = "内置资源";
                    }
                }

                if (data == null || data.length == 0) {
                    out.put("ok", "0");
                    out.put("error", "未找到参考录音");
                    out.put("hint", "请用「上传录音」按钮选择文件，"
                            + "或把录音放到：" + (dir != null ? dir.getAbsolutePath() : "(无外部目录)"));
                    return out.toString();
                }

                out.put("ok", "1");
                out.put("base64", Base64.encodeToString(data, Base64.NO_WRAP));
                out.put("mime", mime);
                out.put("bytes", String.valueOf(data.length));
                out.put("from", from);

                // 参考文本（克隆接口要求必填，由使用者在界面填写）
                String text = "";
                byte[] meta = readAsset("www/voice/fairy-voice.json");
                if (meta != null) {
                    try {
                        JSONObject o = new JSONObject(new String(meta, "UTF-8"));
                        text = o.optString("text", "");
                    } catch (Throwable ignored) { }
                }
                out.put("text", text);
                return out.toString();
            } catch (Throwable e) {
                try {
                    out.put("ok", "0");
                    out.put("error", describe(e));
                } catch (Throwable ignored) { }
                return out.toString();
            }
        }

        /** 读取任意文件的字节（失败返回 null） */
        private byte[] readFileBytes(File f) {
            try (InputStream in = new java.io.FileInputStream(f)) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                return bos.toByteArray();
            } catch (Throwable e) {
                Log.w(TAG, "读取录音失败：" + f, e);
                return null;
            }
        }

        /* ── 联网搜索 ── */

        /**
         * 发起一次联网搜索。paramsJson 见 js/search.js 的 search()。
         * 结果异步回传：window.__fairySearch.onResult(ok, payloadJson)
         *
         * 注意：这里**不能**直接等待结果再返回 —— @JavascriptInterface 的方法
         * 运行在 WebView 的 JS 线程上，阻塞它会导致页面卡死。
         * 因此立即返回，结果通过回调轮询送回。
         */
        @JavascriptInterface
        public void searchWeb(String paramsJson) {
            if (searchClient == null) {
                notifyJs("window.__fairySearch && window.__fairySearch.onResult && "
                        + "window.__fairySearch.onResult(false, '搜索模块不可用')");
                return;
            }
            searchClient.search(paramsJson);
            startSearchCallbackPump();
        }

        @JavascriptInterface
        public String searchAvailable() {
            return searchClient != null ? "1" : "0";
        }

        /* ── 诊断 ── */

        @JavascriptInterface
        public String diag() {
            JSONObject o = new JSONObject();
            try {
                o.put("ttsReady", ttsReady ? "1" : "0");
                o.put("cloudTts", cloudTts != null ? "1" : "0");
                o.put("backend", ttsBackend());
                o.put("preferCloud", preferCloud ? "1" : "0");
                o.put("engine", ttsEnginePackage.isEmpty() ? "系统默认" : ttsEnginePackage);
                o.put("voiceCount", ttsReady && tts != null && tts.getVoices() != null
                        ? tts.getVoices().size() : 0);
                o.put("error", lastTtsError);
                if (!cloudError.isEmpty()) o.put("cloudError", cloudError);
                o.put("sttAvailable", SpeechRecognizer.isRecognitionAvailable(MainActivity.this) ? "1" : "0");
                o.put("sdk", android.os.Build.VERSION.SDK_INT);
                if (!lastCrash.isEmpty()) {
                    o.put("lastCrash", lastCrash.length() > 600 ? lastCrash.substring(0, 600) : lastCrash);
                }
                if (!crashInfo.isEmpty()) o.put("crashInfo", crashInfo);
                JSONArray engines = new JSONArray();
                for (String name : listTtsEngines()) engines.put(name);
                o.put("engines", engines);
            } catch (Exception e) {
                try { o.put("fatal", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
            }
            return o.toString();
        }

        @JavascriptInterface
        public void clearCrash() {
            try {
                File f = new File(getFilesDir(), "last-crash.txt");
                if (f.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
                lastCrash = "";
                crashInfo = "";
            } catch (Throwable ignored) { }
        }
    }

    /** 页面最后一次传给云 TTS 的参数，供系统引擎不可用时回退使用 */
    private volatile String lastCloudParams = "{}";

    /**
     * 通用回调轮询。
     *
     * 为什么用轮询：这些回调由后台线程产生（上传音色、搜索），
     * 在后台线程直接操作 WebView 会崩；持有 WebView 引用又不安全。
     * 折中做法是把结果放进静态字段，主线程定期取走并转成 JS 调用。
     */
    private void startCallbackPump(java.util.function.Supplier<String> source, long timeoutMs) {
        final android.os.Handler h = new android.os.Handler(getMainLooper());
        final long deadline = System.currentTimeMillis() + timeoutMs;
        Runnable r = new Runnable() {
            @Override
            public void run() {
                String js = null;
                try { js = source.get(); } catch (Throwable ignored) { }
                if (js != null && !js.isEmpty()) {
                    notifyJs(js);
                    return;
                }
                if (System.currentTimeMillis() < deadline) h.postDelayed(this, 300);
            }
        };
        h.postDelayed(r, 300);
    }

    /** 轮询取用上传回调（CloudTts 在后台线程写，这里转成 JS 调用） */
    private void startUploadCallbackPump() {
        startCallbackPump(CloudTts::takeUploadCallback, 120_000);
    }

    /** 轮询取用搜索回调 */
    private void startSearchCallbackPump() {
        startCallbackPump(SearchClient::takeCallback, 40_000);
    }
}
