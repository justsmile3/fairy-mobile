#!/usr/bin/env node
/**
 * build-apk.mjs —— 构建 Fairy 手机版 APK
 *
 * 步骤：
 *   1. 打包前端（esbuild → 单个经典 IIFE，见 bundle.mjs）
 *   2. 同步 www 到 android/app/src/main/assets/www
 *   3. 调 Gradle 编译出 APK
 *   4. 校验签名，产出到 dist/
 *
 * 说明：本应用**零原生依赖**。语音朗读走网络 API（见 js/cloudtts.js），
 * 因此不需要打包任何模型或原生库，APK 只有约 0.4MB。
 *
 * 用法：node tools/build-apk.mjs
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const ASSETS_WWW = path.join(ANDROID_DIR, 'app', 'src', 'main', 'assets', 'www');
const DIST_DIR = path.join(ROOT, 'dist');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function firstExisting(...paths) {
  for (const p of paths) if (p && exists(p)) return p;
  return null;
}
function log(msg) { console.log(`[build-apk] ${msg}`); }
function fail(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

function findJavaHome() {
  return firstExisting(process.env.JAVA_HOME, path.resolve(ROOT, '../.build-tools/jdk17'));
}

function findGradle() {
  return firstExisting(
    process.env.GRADLE_BIN,
    path.resolve(ROOT, '../_env/gradle-8.7/bin/gradle.bat'),
    path.resolve(ROOT, '../_env/gradle-8.7/bin/gradle'),
  );
}

function findSdkDir() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ];
  for (const c of candidates) {
    if (c && exists(path.join(c, 'platform-tools'))) return c;
  }
  return null;
}

async function main() {
  const javaHome = findJavaHome();
  if (!javaHome) fail('找不到 JDK 17');
  const gradle = findGradle();
  if (!gradle) fail('找不到 Gradle');
  const sdkDir = findSdkDir();
  if (!sdkDir) fail('找不到 Android SDK');

  // 1. 打包前端（bundle.mjs 内部会把 www 同步到 assets）
  log('打包前端…');
  const bundleScript = path.join(ROOT, 'tools', 'bundle.mjs');
  const bundle = spawnSync(process.execPath, [bundleScript], {
    stdio: 'inherit', cwd: ROOT,
  });
  if (bundle.status !== 0) fail('前端打包失败');

  if (!exists(path.join(ASSETS_WWW, 'index.html'))) {
    fail(`assets 中缺少 index.html：${ASSETS_WWW}`);
  }

  // 2. local.properties（Gradle 需要知道 SDK 位置）
  await fsp.writeFile(
    path.join(ANDROID_DIR, 'local.properties'),
    `sdk.dir=${sdkDir.replace(/\\/g, '/')}\n`, 'utf8');

  // 3. 编译
  const env = {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: sdkDir,
    ANDROID_SDK_ROOT: sdkDir,
  };
  const gradleHome = path.resolve(ROOT, '../.gradle-home');
  if (exists(gradleHome)) env.GRADLE_USER_HOME = gradleHome;
  const tmpDir = path.join(ANDROID_DIR, '.gradle-tmp');
  await fsp.mkdir(tmpDir, { recursive: true });
  env.TEMP = tmpDir;
  env.TMP = tmpDir;

  log('开始 gradle assembleDebug …');
  const result = spawnSync(gradle, ['-p', ANDROID_DIR, 'assembleDebug', '--console=plain'], {
    env, cwd: ANDROID_DIR, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail(`Gradle 构建失败（退出码 ${result.status}）`);

  // 4. 产出
  const apkPath = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!exists(apkPath)) fail('未找到 APK 产物');
  await fsp.mkdir(DIST_DIR, { recursive: true });
  const out = path.join(DIST_DIR, 'Fairy.apk');
  await fsp.copyFile(apkPath, out);
  const size = (await fsp.stat(out)).size;
  log(`已产出：${path.relative(process.cwd(), out)}（${(size / 1048576).toFixed(2)} MB）`);

  // 5. 校验签名
  const apksigner = firstExisting(
    path.join(sdkDir, 'build-tools', '34.0.0', 'apksigner.bat'),
    path.join(sdkDir, 'build-tools', '33.0.0', 'apksigner.bat'),
  );
  if (apksigner) {
    const verify = spawnSync(apksigner, ['verify', out], {
      stdio: 'ignore', shell: process.platform === 'win32', env,
    });
    log(verify.status === 0 ? '签名校验通过（debug keystore）' : '⚠ 签名校验未通过');
  }

  // 6. 声明零原生依赖（这是本应用的关键特性，值得显式确认）
  const aapt2 = firstExisting(
    path.join(sdkDir, 'build-tools', '34.0.0', 'aapt2.exe'),
    path.join(sdkDir, 'build-tools', '33.0.0', 'aapt2.exe'),
  );
  if (aapt2) {
    const dump = spawnSync(aapt2, ['dump', 'badging', out], {
      encoding: 'utf8', shell: process.platform === 'win32', env,
    });
    const txt = dump.stdout || '';
    const hasNative = /native-code:/.test(txt);
    log(hasNative
      ? '⚠ 包含原生库（预期不应有）'
      : '已确认：不含任何原生库（零原生依赖）');
  }
}

main().catch((err) => fail(err.stack || err.message));
