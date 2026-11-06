/* 极简播客客户端 service worker：网络优先 + 离线回退缓存 */
'use strict';

// 图标被 SW 缓存优先接管了（见下面 cacheFirst），所以换图标必须提版本号，
// 否则已经装过 PWA 的客户端会一直用缓存里那套旧图。
const VERSION = 'podcast-v7';
const SYNC_PATH = new URL('sync/', self.registration.scope).pathname;
const ICONS_PATH = new URL('icons/', self.registration.scope).pathname;
const FONTS_PATH = new URL('fonts/', self.registration.scope).pathname;
const THUMB_PATH = new URL('thumb', self.registration.scope).pathname;

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
  './icons/arrow_drop_down.svg',
  './icons/filter_list.svg',
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

// 单个网络请求最多占这么久：长尾 feed 卡住时，页面会先 abort（见 app.js 的
// holdFeedsForPlayback），这里再兜一层，免得 SW 里的 fetch 还占着连接。
// 比 app.js 的 FEED_TIMEOUT_MS（30s）再长一点，让页面自己的超时先做判断。
const NET_TIMEOUT_MS = 35000;

// 一律网络优先：这个 app 没有构建步骤，缓存优先会让改动要等下一次加载才生效；
// 离线时回退到安装时预缓存的外壳 + 上次抓到的 feed（单集数据另有 IndexedDB 兜底）
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, NET_TIMEOUT_MS);
  // 页面主动取消（比如给播放让路）时，把取消传到 SW 自己的 fetch 上。
  // 某些 WebKit 版本不会自动传播 fetch event 的 abort，这里显式接一下。
  const onAbort = () => { try { ctrl.abort(); } catch (_) {} };
  if (req.signal) req.signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(req, { signal: ctrl.signal });
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return new Response('', { status: 504, statusText: 'offline' });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener('abort', onAbort);
  }
}

// 图标和字体是纯静态资源，缓存优先：省掉每次打开都要重拉的十来个请求，
// 也免得 8MB 的字体每次加载都回源确认。代价是换了文件不会立刻生效 ——
// 换图标/字体时把 VERSION 一起改掉即可。
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

  // 音频不拦截：Range 请求交给浏览器原生处理，SW 插一脚会打断拖动跳转。
  // WebKit 上 request.destination 不一定拿得到，再按扩展名和 Range 头兜一层 ——
  // 只要放行了 .wav（本地 TTS）这类没有 .mp3 后缀的音频，后台播放和拖动才不会断。
  if (req.destination === 'audio'
      || req.headers.has('range')
      || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|mp4)$/i.test(url.pathname)) return;

  // 同步接口完全不碰：一是不能进缓存（否则可能拿到旧进度），
  // 二是不必让 SW 挡在中间转一手 —— 它只是即时的一来一回读写。
  if (url.pathname.startsWith(SYNC_PATH)) return;

  // 封面缩略图也不拦：服务端已经给了 immutable 的长缓存，交给浏览器 HTTP 缓存
  // 就行，不必再往 SW 缓存里塞几百张小图
  if (url.pathname.startsWith(THUMB_PATH)) return;

  if (url.pathname.startsWith(ICONS_PATH) || url.pathname.startsWith(FONTS_PATH)) {
    e.respondWith(cacheFirst(req));
    return;
  }

  e.respondWith(networkFirst(req));
});
