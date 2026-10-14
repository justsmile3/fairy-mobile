# 推送到 GitHub

仓库已经在本地准备好了：77 个文件、1 个提交、工作区干净。
只差在 GitHub 上创建远程仓库并推送。

---

## 第一步：在 GitHub 上创建空仓库

1. 打开 <https://github.com/new>
2. **Repository name** 填 `fairy-mobile`
3. 选择 **Public**（公开）
4. **不要**勾选「Add a README file」「Add .gitignore」「Choose a license」
   —— 本地已经有这些文件，勾了会产生冲突
5. 点 **Create repository**

---

## 第二步：推送

打开终端（PowerShell 或 Git Bash），执行：

```powershell
cd C:\Users\AA\Documents\deepseek-harness\default-workspace\fairy-mobile

# 把 YOURNAME 换成你的 GitHub 用户名
git remote add origin https://github.com/YOURNAME/fairy-mobile.git

git push -u origin main
```

第一次推送会弹出浏览器让你登录 GitHub，授权即可。

> 如果你的 GitHub 默认分支是 `master` 而不是 `main`，
> 上面命令已用 `main`（本地就是这么初始化的），无需改动。

---

## 如果推送被拒绝（rejected）

说明远程仓库不是空的（可能你勾选了 README）。两种处理：

**推荐：先拉取再推送**

```powershell
git pull --rebase origin main
git push -u origin main
```

**或者：强制覆盖远程**（远程那些内容不要了）

```powershell
git push -u origin main --force
```

---

## 第三步：确认

推送成功后访问 `https://github.com/YOURNAME/fairy-mobile`，
应该能看到 README 渲染出来。

建议顺手做两件事：

1. 在仓库 **About** 里填一句简介，例如：
   > 手机端 Fairy 对话应用 · 立绘吉祥物 · 云端语音克隆 · 1.2MB APK
2. 加上 **Topics**：`deepseek` `android` `pwa` `tts` `voice-clone`

---

## 关于 APK

`dist/` 被 `.gitignore` 排除了，所以 **APK 不会上传**（每次构建产物都不同，
放进版本库只会产生噪音）。

如果你想发布可下载的 APK：

1. 先构建：`node tools/build-apk.mjs`
2. 产物在 `dist/Fairy.apk`
3. 到仓库的 **Releases** → **Draft a new release**
4. 打一个 tag（如 `v0.4.0`），把 `Fairy.apk` 拖进去
5. 发布

这样别人能在 Releases 页面直接下载安装包。

---

## 之后更新代码

```powershell
cd C:\Users\AA\Documents\deepseek-harness\default-workspace\fairy-mobile

git add -A
git commit -m "说明这次改了什么"
git push
```

---

## 上传前已经处理好的事

- **无敏感信息**：扫描过全部源码，没有硬编码的 API Key / token
- **无本机路径**：工具脚本都改成了相对路径，别人 clone 下来能直接用
- **构建产物已排除**：`dist/`、`android/app/build/`、`android/.gradle/`
- **资源副本已排除**：`android/app/src/main/assets/www/` 由
  `tools/bundle.mjs` 构建时自动生成，源文件才是唯一真相
- **删除了废弃脚本**：`check-crash.py` / `check-dex.py` 属于早期本地语音克隆
  时代，现在用不上
- **补上了 LICENSE** 与 `.gitignore` 的缓存规则

## 别人 clone 下来怎么构建

```powershell
git clone https://github.com/YOURNAME/fairy-mobile.git
cd fairy-mobile

# 打包前端（会把资源同步到 android assets）
node tools/bundle.mjs

# 编译 APK（需要 JDK 17 + Android SDK + Gradle）
node tools/build-apk.mjs
```

跑测试：

```powershell
node test/run.mjs              # 契约测试
node test/native-bridge.mjs    # 原生语音桥
node tools/verify-apk.mjs --with-bridge   # APK 资源验收
```
