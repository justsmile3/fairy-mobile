# Fairy Mobile

一个手机上跑的 AI 助手应用：**立绘吉祥物 + 直连 DeepSeek API**，
可以打包成 Android APK（约 1.2 MB，零原生依赖）。

不需要电脑上的服务，也不需要中转服务器：手机直接把请求发往
`api.deepseek.com`，API Key 只保存在手机本机。

<img src="icons/icon-192.png" width="96" alt="Fairy 图标">

---

> ## ⚠️ 免责声明（请先阅读）
>
> - 本项目为**非官方个人项目**，与米哈游 /《绝区零》**无任何官方关联**，
>   不包含该游戏的任何立绘、语音、语料或商标素材。
> - **本项目不提供、不分发任何音频素材。** 音色克隆功能只是一种工具能力，
>   参考录音需由使用者自行准备。
> - 克隆他人声音可能涉及**人格权**与**著作权**。请确保你拥有录音的合法使用权，
>   仅用于个人学习研究，**勿用于冒充他人或任何商业、违法用途**。
> - 使用者需自行承担因使用本项目（含音色克隆）产生的全部责任。
>
> 完整声明见 **[NOTICE.md](NOTICE.md)**。

---

## 想直接用？先看这里

**方式一：自己构建 APK**（推荐，两分钟）

```sh
git clone https://github.com/justsmile3/fairy-mobile.git
cd fairy-mobile
node tools/bundle.mjs      # 打包前端
node tools/build-apk.mjs   # 编译 APK → dist/Fairy.apk
```

需要：Node.js、JDK 17、Android SDK、Gradle 8.7。
签名密钥会在首次构建时自动生成，无需额外准备。

**方式二：直接用浏览器打开**（无需构建）

```sh
node tools/serve.mjs
```

然后用手机浏览器访问终端里显示的地址即可。

**方式三：等 Releases**

如果作者发布了 Release，可以直接在
[Releases](https://github.com/justsmile3/fairy-mobile/releases) 页面下载 APK。

---

## 功能

- 💬 **流式对话**：SSE 实时输出，支持中途停止、重新生成、复制、删除
- 🌐 **联网搜索**：涉及实时信息的问题会自动联网检索再回答，并标注来源。
  **免 API Key**（见 [docs/联网搜索.md](docs/联网搜索.md)）
- 🧚 **立绘吉祥物**：矢量绘制的 Fairy 之眼，眨眼、视线跟随、思考/说话/聆听/警戒/休眠等状态动效，可拖动、可调大小与速度。
  **位于文字下层**（嵌在背景里的形象，消息文字从它上方经过），
  顶栏标题左侧有一个**眼睛形状的开关**，一键收起/展开
- 🔊 **语音朗读**：云端 TTS，**支持用一段参考录音克隆出 Fairy 的音色**
  （见 [docs/用上Fairy的音色.md](docs/用上Fairy的音色.md)）
- 📖 **朗读前总结**：长回复朗读时总结成 1–3 句（本地去 Markdown + 可选 API 总结）。
  **屏幕上的原文与存库内容不变**
- 🔔 **语音提示音**：朗读前响一声，6 种音色可选，全部程序化合成
- 🎙️ **语音输入**：系统识别，设备不支持时可切换云识别
- 🫧 **悬浮球唤醒**：常驻小圆球（按立绘绘制），点一下就能说话，
  拖到屏幕边缘自动收起成半个（见 [docs/悬浮球语音唤醒.md](docs/悬浮球语音唤醒.md)）
- 🗂️ **会话管理**：多会话、自动起标题、搜索、删除，全部存本机
- ⚙️ **设置**：API Key、模型切换、温度、最大输出、推理过程展示、主题（暗/亮/跟随系统）
- 💰 **余额与用量**：直读 `/user/balance`，流式返回 `usage` 时统计 token
- 📦 **离线可用**：Service Worker 缓存应用外壳；对话仍需联网

## 快速开始

### 方式一：局域网安装到手机（最快）

前提：电脑与手机连**同一个 Wi-Fi**。

```sh
# 在项目目录下
node tools/serve.mjs
```

终端会打印一个形如 `http://192.168.x.x:8788/` 的局域网地址。用手机浏览器打开它，然后：

- **Android Chrome**：菜单 →「安装应用」或「添加到主屏幕」
- **iOS Safari**：分享按钮 →「添加到主屏幕」

首次加载后应用外壳会被缓存，之后**无需再开电脑**也能从主屏幕打开。

### 方式二：部署到公网（真·随时随地）

本应用是纯静态站点，可部署到任意静态托管：

- **GitHub Pages / Netlify / Vercel / Cloudflare Pages**：把整个目录作为站点根上传即可。
- 也可用你自己的服务器：`python -m http.server` / nginx / 任何静态文件服务。

> ⚠️ 建议用 **HTTPS** 访问。虽然 DeepSeek API 允许跨域，但：
> 1. `navigator.clipboard`、Service Worker 离线、PWA「安装」提示等能力需要安全上下文；
> 2. HTTP 明文下，局域网内其他设备可能嗅探到你的 API Key。
> 局域网测试可以接受 `http://`，长期使用请走 HTTPS。

## 打包成 Android APK

```sh
node tools/build-apk.mjs
```

产物：`dist/Fairy.apk`（约 **0.4 MB**，包名 `com.fairy.mobile`，应用名 **Fairy**）。

### 零原生依赖

本应用**不含任何原生库、模型或第三方 SDK**，原因：

1. Android 规定原生库必须在 APK 内（targetSdk ≥ 24 时无法从包外 `dlopen`，
   见[官方行为变更](https://developer.android.google.cn/about/versions/nougat/android-7.0-changes#ndk)）
2. 而把原生库打进包会在部分设备上于**类加载阶段**崩溃 —— 早于 `onCreate`，
   `try/catch` 拦不住

因此语音朗读改为走**网络 API**，从根上规避这两个问题。
构建脚本会自动校验产物中确实没有原生库。

### 语音：支持用上 Fairy 的音色

朗读有四种后端，在「设置 → 语音」里切换：

| 方式 | 音色 | 需要配置 | 说明 |
| --- | --- | --- | --- |
| **SiliconFlow** | **可克隆成 Fairy 的音色** | API Key（需实名） | 推荐 |
| 自定义 | 取决于服务 | Base URL 等 | 任意 OpenAI 兼容端点 |
| 百度翻译语音 | 固定 | 无 | 免注册，开箱即用 |
| 系统引擎 | 取决于设备 | 无 | 设备自带引擎 |

默认的「自动选择」规则：填了 SiliconFlow Key 就用它，否则用百度 —— 
**不配置也能出声，配置后自动升级**。

👉 **详细步骤见 [docs/用上Fairy的音色.md](docs/用上Fairy的音色.md)**

### 为什么在原生层发请求

多数语音服务不返回 CORS 头，WebView 里直接 `fetch` 会被浏览器拦截。
因此所有合成请求都由原生层（`CloudTts.java`）发出，页面只负责传参数。

### 崩溃兜底

若发生启动崩溃，会自动拉起 `CrashActivity`（独立进程），
显示日志**并自动复制到剪贴板**，直接粘贴即可反馈。
设置 → 语音 里另有「复制诊断信息」与「清除崩溃记录」。

**手动构建**（等价于脚本内部步骤）：

```sh
set JAVA_HOME=..\.build-tools\jdk17
set GRADLE_USER_HOME=..\.gradle-home
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
..\_env\gradle-8.7\bin\gradle.bat -p android assembleDebug
```

> 签名使用项目内置的 `debug.keystore`（alias `androiddebugkey`，密码 `android`）。
> 发布到应用商店前请替换为正式签名并提高 `versionCode`。

## 配置 API Key

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/) 创建 API Key。
2. App 内：左上角菜单 →「设置」→「接入」→ 填入 Key →「测试连接」。

### Key 存在哪里？

只存在**当前手机浏览器**的 `localStorage` 里，随「数据」导出/清除。请求直接发往
`api.deepseek.com`，**不经过任何第三方服务器**（本应用没有自己的后端）。

## 模型说明

依据官方文档（[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)），
当前提供两个模型：

| 模型 | 版本 | 特点 | 相对价格 |
| --- | --- | --- | --- |
| **`deepseek-flash`** | DeepSeek-V4.1-Flash | 默认。快、便宜，**支持视觉输入** | 1× |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 能力更强 | 约 4–5× |

同时保留了 `deepseek-chat` / `deepseek-reasoner` 两个旧名选项 ——
它们已从官方文档移除，但服务端可能仍接受（旧名常被映射到新模型）。
留着是为了兼容既有配置；若某天彻底不可用，切回 `deepseek-flash` 即可。

可在设置里点「刷新模型列表」从接口拉取当前可用模型。

## 朗读文本处理

屏幕上的回复是 Markdown（标题、列表、代码块、表格、链接），
直接念出来会听到 `#`、`**`、`|---|`，代码还会被逐字符读；
长回复更是要念很久。

开启「朗读前处理长回复」后，朗读时改用处理后的稿子，分两级：

1. **本地清洗**（始终执行，零延迟零成本）
   去 Markdown 标记、表格转叙述、代码块转说明、链接只留文字
2. **API 总结**（可选，调用 `deepseek-flash`）
   把长回复压缩成 **1–3 句话**，只讲结论与关键动作

> **屏幕上的回复不会被改动。** 处理结果只传给 TTS，
> 显示、存库、发给模型上下文的一律是原文 —— 否则会污染对话历史。

几个设计细节：

- **总结有触发阈值**（默认 120 字）：短回复（如"好的"）直接念，总结反而奇怪
- **句数硬性截断**：提示词只能"请求"模型简短，不能保证。
  代码里会按句末标点切分并截到 3 句，确保"只念一两句"这个体验可靠
- **总结失败不回退念全文**：那会把 800 字完整念完，正是要避免的。
  此时改为念一句提示，建议看屏幕
- **总结固定用 flash**：这是简单任务，用 v4-pro 做性价比很低

设置里有「预览处理效果」按钮，能同时看到原文、本地清洗结果与 API 总结结果、
以及各自的字数，便于判断是否合意。

## 语音说明（平台差异）

| 能力 | APK / Android | 浏览器（Chrome、Edge） | iOS Safari |
| --- | --- | --- | --- |
| 朗读（TTS） | ✅ 云端 API（支持 Fairy 克隆音色） | ✅ 系统音色 | ✅ 系统音色（首次需在点击中触发一次） |
| 语音输入（STT） | ✅ 系统识别，可切换云识别 | ✅ | ✅（部分旧版 iOS 仅 Safari 支持） |

- **APK 内**朗读走云端 TTS，音色可在设置里选择与克隆（见
  [docs/用上Fairy的音色.md](docs/用上Fairy的音色.md)）。
- **浏览器里**朗读走系统语音合成，音色由设备决定。
- 语音输入识别结果会回填到输入框，可编辑后再发送。
- 任一能力不可用时，App 会自动隐藏对应按钮并给出说明，不影响文字对话。

### 悬浮球语音唤醒

设置 → **悬浮球（语音唤醒）** 可开启一个常驻小圆球：

- **点一下就能说话**，不用先打开 Fairy
- 拖到屏幕左/右边缘松手 → **自动收起成半个**，不挡视野
- 收起状态点一下即可展开

相比「后台常驻监听唤醒词」，它不占麦克风、不耗电、也不受 ROM 后台限制。
详见 [docs/悬浮球语音唤醒.md](docs/悬浮球语音唤醒.md)。

## 隐私与数据

- 对话内容、会话、设置**全部保存在手机本机**（IndexedDB / localStorage），不上传。
- 外发的请求只有两类：
  1. 发给 `api.deepseek.com` 的聊天请求（含你的 API Key 与对话上下文）
  2. 使用云语音朗读时，**待朗读的文本**会发给你选择的服务商
     （SiliconFlow / 百度 / 自建）；API Key 与音色 ID 只留在本机
- 「设置 → 数据」可**导出全部会话**为 JSON 备份，或**清空全部数据**（含 Key）。

## 已知边界

手机版没有桌面 DSH 的**工具面**（文件、命令行、联网检索、MCP 等）。Fairy 人设中已内置
「移动端能力边界」条款，让她不会谎称执行了这些操作。若需要能真正干活的 Agent 能力，
请回到桌面 DSH + Fairy 插件套件。

## 项目结构

```
fairy-mobile/
├── index.html            # 应用外壳（加载 js/bundle.js 经典脚本）
├── manifest.webmanifest  # PWA 清单
├── sw.js                 # Service Worker（离线缓存）
├── css/
│   ├── app.css           # 应用样式（暗/亮主题）
│   └── mascot.css        # 立绘样式
├── js/
│   ├── main.js           # 应用主逻辑（入口）
│   ├── api.js            # DeepSeek API 客户端（SSE / 余额 / 模型）
│   ├── store.js          # IndexedDB + localStorage 持久化
│   ├── persona.js        # Fairy 人设与移动端能力边界
│   ├── markdown.js       # 安全 Markdown 渲染
│   ├── speech.js         # TTS + STT（浏览器原生 / APK 原生桥）
│   ├── cloudtts.js       # 云端 TTS 客户端（多服务商 / 音色克隆）
│   ├── cloudtts-ui.js    # 云端语音的设置界面
│   ├── search.js         # 联网搜索（免密钥，多引擎）
│   ├── search-ui.js      # 联网搜索的设置界面
│   ├── floating-ball.js  # 悬浮球（语音唤醒入口）的前端控制
│   ├── mascot.js         # 立绘渲染与动效
│   ├── ui.js             # DOM 工具
│   └── bundle.js         # ← 构建产物（esbuild 打包，勿手改）
├── icons/                # PWA 图标
├── docs/                 # 使用文档（音色克隆、悬浮球、推送指引）
├── android/              # 原生 WebView 壳工程
│   └── app/src/main/java/com/fairy/mobile/
│       ├── MainActivity.java        # WebView 宿主 + 原生桥
│       ├── FloatingBallService.java # 悬浮球（按立绘绘制）
│       ├── CloudTts.java            # 云端 TTS（原生发请求，规避 CORS）
│       ├── CloudStt.java            # 云端语音识别
│       └── CrashActivity.java       # 崩溃兜底页（自动复制日志）
├── tools/
│   ├── bundle.mjs        # 打包 JS 为单文件经典脚本
│   ├── build-apk.mjs     # 一键打包 APK
│   ├── make-icons.py     # 图标生成（按立绘参数）
│   ├── preview-floating-ball.py  # 悬浮球外观预览
│   ├── check-floating-ball.py    # 悬浮球尺寸/吸附/健壮性校验
│   ├── check-dom-refs.py # DOM 引用完整性检查
│   ├── verify-apk.mjs    # APK 资源验收（真实浏览器 + 桥桩）
│   ├── verify-voice.mjs  # 语音状态文案场景测试
│   ├── serve.mjs         # 局域网静态服务器
│   └── verify.mjs        # 浏览器端到端验收
└── test/
    ├── run.mjs           # 不依赖浏览器的契约测试
    └── native-bridge.mjs # APK 原生语音桥契约测试
```

> ⚠️ **为什么必须打包**：Android WebView 用 `file://` 加载本地资源时，**ES 模块会被 CORS 拦截**
> （模块脚本走 fetch、origin 为 `null`），入口脚本根本不会执行 —— 表现为「页面能渲染，
> 但所有按钮都没反应」。因此 `index.html` 只加载 `js/bundle.js`（普通 `<script>`），
> 源码模块仅供 Node 测试与阅读。改动 `js/*.js` 后必须重新打包。

## 开发与验收

```sh
node tools/bundle.mjs             # 打包 js/main.js → js/bundle.js（改完源码必跑）
node test/run.mjs                 # 契约测试（Markdown / 人设 / API / SSE / 静态资源）
node test/native-bridge.mjs       # APK 原生语音桥契约测试（含异步就绪回归）
node tools/serve.mjs              # 起本地服务
node tools/verify.mjs             # 浏览器端到端验收 + 截图（需先起 serve）
node tools/verify-apk.mjs         # APK 资源验收（file:// 严格策略，贴近真机）
node tools/verify-apk.mjs --with-bridge   # 同上，另注入原生桥桩验证语音
node tools/build-apk.mjs          # 打包 + 编译 APK（会自动先打包 JS）
```

`verify.mjs` 会以手机视口（390×844 · DPR2 · 触摸）打开 App，注入假的 SSE 后端，
走通「输入 → 流式接收 → Markdown 渲染 → 落库」完整链路，并在 `.verify/` 下输出截图。

> 注意：无头浏览器需要创建命名管道，在受限沙箱中无法启动；报 `platform_channel` 相关错误时
> 请在允许的沙箱模式下运行 `verify.mjs`。

## 许可

- 代码按 [MIT License](LICENSE) 发布。
- 版权与第三方服务的边界说明见 [NOTICE.md](NOTICE.md)。
- 本项目不包含也不主张《绝区零》相关版权、商标或官方关联权利。
