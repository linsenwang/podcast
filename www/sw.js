/* 极简播客客户端 service worker：网络优先 + 离线回退缓存 */
'use strict';

// 换版本号会让 SW 重新 install（重新预缓存外壳）并让 activate 清掉旧缓存。
// 现在静态资源都带 no-cache 会自己回源确认，正常不用手动提，
// 但客户端已经装成 PWA、卡在旧代码上时，提一次版本号是最直接的踢醒手段。
const VERSION = 'podcast-v2';
const SYNC_PATH = new URL('sync/', self.registration.scope).pathname;
const ICONS_PATH = new URL('icons/', self.registration.scope).pathname;

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

// 图标是纯静态资源（预缓存里已有），缓存优先：省掉每次打开都要重拉的十来个请求。
// 代价是换图标不会立刻生效 —— 改图标时把 VERSION 一起改掉即可。
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
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

  if (url.pathname.startsWith(ICONS_PATH)) {
    e.respondWith(cacheFirst(req));
    return;
  }

  e.respondWith(networkFirst(req));
});
