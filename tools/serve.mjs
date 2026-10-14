#!/usr/bin/env node
/**
 * serve.mjs —— 极简静态服务器
 *
 * 用途：把 fairy-mobile 目录发布到局域网，方便手机「添加主屏幕」完成首次安装。
 * 首次加载后 Service Worker 会把应用外壳缓存到手机上，之后即使电脑关机，
 * PWA 依然能独立打开（对话本身需要手机能访问 DeepSeek API）。
 *
 * 用法：
 *   node tools/serve.mjs                # 监听 0.0.0.0:8788，打印可用的局域网地址
 *   node tools/serve.mjs --port 9000
 *   node tools/serve.mjs --host 127.0.0.1   # 只监听本机
 *
 * 注意：只读地提供当前项目目录，不做任何上传/写入。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT || 8788));
const HOST = arg('host', '0.0.0.0');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function safeJoin(root, target) {
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + target));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = safeJoin(ROOT, pathname);
    if (!filePath) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let stat = await fsp.stat(filePath).catch(() => null);
    if (stat && stat.isDirectory()) {
      const index = path.join(filePath, 'index.html');
      stat = await fsp.stat(index).catch(() => null);
      if (stat) return send(index, res);
    }
    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    return send(filePath, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`500 ${err.message}`);
  }
});

function send(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    // 开发期不缓存，避免改完看不到效果；Service Worker 自己管离线缓存
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
  });
  fs.createReadStream(filePath).pipe(res);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`\n  DeepSeek Fairy Mobile 已启动\n`);
  console.log(`  本机:   http://127.0.0.1:${PORT}/`);
  if (HOST === '0.0.0.0') {
    const addrs = lanAddresses();
    if (addrs.length) {
      console.log('  手机（需同一 Wi-Fi）:');
      for (const ip of addrs) console.log(`          http://${ip}:${PORT}/`);
    } else {
      console.log('  未检测到局域网地址，请确认已连接 Wi-Fi。');
    }
  }
  console.log('\n  首次在手机上打开后，用浏览器菜单「添加到主屏幕」即可离线使用。');
  console.log('  按 Ctrl+C 停止。\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换一个：node tools/serve.mjs --port 9000`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
