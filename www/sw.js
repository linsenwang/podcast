/* 极简播客客户端 service worker：网络优先 + 离线回退缓存 */
'use strict';

const VERSION = 'podcast-v1';
const SYNC_PATH = new URL('sync/', self.registration.scope).pathname;

const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/play_arrow.svg',
  './icons/pause.svg',
  './icons/refresh.svg',
  './icons/close.svg',
  './icons/check.svg',
  './icons/replay_10.svg',
  './icons/forward_30.svg',
  './icons/add.svg',
  './icons/brightness_auto.svg',
  './icons/light_mode.svg',
  './icons/dark_mode.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 一律网络优先：这个 app 没有构建步骤，缓存优先会让改动要等下一次加载才生效；
// 离线时回退到安装时预缓存的外壳 + 上次抓到的 feed（单集数据另有 IndexedDB 兜底）
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 封面图等第三方资源不拦

  // 音频不拦截：Range 请求交给浏览器原生处理，SW 插一脚会打断拖动跳转
  if (req.destination === 'audio' || /\.mp3$/i.test(url.pathname)) return;

  // 同步接口完全不碰：一是不能进缓存（否则可能拿到旧进度），
  // 二是不必让 SW 挡在中间转一手 —— 它只是即时的一来一回读写。
  if (url.pathname.startsWith(SYNC_PATH)) return;

  e.respondWith(networkFirst(req));
});
