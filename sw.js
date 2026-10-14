/**
 * sw.js —— Service Worker
 *
 * 策略：
 *  - 应用外壳（HTML/CSS/JS/图标）：缓存优先 + 后台更新，保证离线可打开。
 *  - DeepSeek API 请求：完全不拦截，永远走网络（对话内容绝不进缓存）。
 *
 * 更新方式：改动 CACHE_VERSION 后，新 SW 会在下次进入时接管并清理旧缓存。
 */

const CACHE_VERSION = 'fairy-mobile-v1';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/mascot.css',
  './js/bundle.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // 逐个添加：个别文件缺失（例如未启用立绘）不该让整个安装失败
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[fairy sw] 跳过缓存', url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 永远不缓存 API 与跨域请求
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/chat/completions') || url.pathname.includes('/user/balance')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request, { ignoreSearch: true });

    const network = fetch(request).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) return cached;

    const fresh = await network;
    if (fresh) return fresh;

    // 导航请求离线兜底
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('离线且无缓存内容。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
