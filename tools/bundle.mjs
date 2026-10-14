#!/usr/bin/env node
/**
 * bundle.mjs —— 把 PWA 的 ES 模块打包成单文件经典脚本
 *
 * 为什么必须打包：
 *   Android WebView 用 file:// 加载本地资源时，**ES 模块会被 CORS 拦截**
 *   （模块脚本走 fetch，origin 是 null），于是入口脚本根本不执行 ——
 *   表现就是「页面能渲染，但所有按钮都没反应」。
 *   打成普通 <script> 的经典脚本后，file:// 下可以正常执行。
 *
 * 产物：js/bundle.js（IIFE、target=es2017、压缩）
 * 用法：node tools/bundle.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'js', 'bundle.js');
const ENTRY = 'js/main.js';

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** 在构建工具目录里递归找 esbuild.exe */
function findEsbuild() {
  const explicit = [
    process.env.ESBUILD_BIN,
    path.resolve(ROOT, '../.build-tools/esbuild/node_modules/.bin/esbuild.exe'),
  ].filter(Boolean);
  for (const p of explicit) if (exists(p)) return p;

  const roots = [
    path.resolve(ROOT, '../.build-tools/esbuild/node_modules'),
    path.resolve(ROOT, 'node_modules'),
  ];
  for (const root of roots) {
    if (!exists(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name === 'esbuild.exe') return full;
        if (e.isDirectory()) stack.push(full);
      }
    }
  }
  return null;
}

export function bundleJs({ quiet = false } = {}) {
  const esbuild = findEsbuild();
  if (!esbuild) {
    throw new Error('找不到 esbuild.exe。请安装：\n'
      + '  node <pnpm> add esbuild    （在工作区的 .build-tools/esbuild 目录下）');
  }
  const log = quiet ? () => {} : (m) => console.log(`[bundle] ${m}`);

  const result = spawnSync(esbuild, [
    ENTRY,
    '--bundle',
    '--format=iife',
    '--target=es2017',
    '--charset=utf8',
    '--minify',
    '--legal-comments=none',
    `--outfile=${path.relative(ROOT, OUT)}`,
  ], { cwd: ROOT, stdio: quiet ? 'ignore' : 'inherit' });

  if (result.status !== 0) throw new Error(`esbuild 打包失败（退出码 ${result.status}）`);
  if (!exists(OUT)) throw new Error('esbuild 未产出 js/bundle.js');

  // 自检：产物必须是经典脚本，不含模块语法
  const code = fs.readFileSync(OUT, 'utf8');
  if (/^\s*(import|export)\s/m.test(code)) {
    throw new Error('打包产物仍含 ES 模块语法，file:// 下会失效');
  }
  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  log(`已产出 js/bundle.js（${size} KB，IIFE / es2017 / 经典脚本）`);

  // 顺手同步到 APK 的 assets —— 否则验收脚本读到的是旧 bundle，
  // 会得出与实际不符的结论（这个坑踩过）。
  syncToAssets(log);
  return OUT;
}

/** 把 Web 资源同步到 android assets/www（与 build-apk 保持一致） */
function syncToAssets(log) {
  const assetWww = path.resolve(ROOT, 'android/app/src/main/assets/www');
  if (!exists(assetWww)) return;

  // 注意：**不**同步 voice/。
  // 本项目不内置任何音频素材（参考录音常涉及第三方版权），
  // 音色克隆由使用者自行提供录音。
  const dirs = ['css', 'icons'];
  const files = ['index.html', 'manifest.webmanifest', 'sw.js', 'js/bundle.js'];

  const copy = (rel) => {
    const src = path.join(ROOT, rel);
    const dst = path.join(assetWww, rel);
    if (!exists(src)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  };

  for (const d of dirs) copy(d);
  for (const f of files) copy(f);

  // 只在真正变化时提示，避免噪音
  try {
    const a = fs.readFileSync(path.join(ROOT, 'js/bundle.js'));
    const b = fs.readFileSync(path.join(assetWww, 'js/bundle.js'));
    if (!a.equals(b)) log('警告：assets 同步后内容仍不一致');
  } catch { /* 忽略 */ }
  log('已同步 Web 资源到 android assets');
}

// 直接运行时执行打包
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    bundleJs();
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
}
