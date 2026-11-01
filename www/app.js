/* 极简播客客户端
 * 数据源：podsync 的 podsync.opml（经同源反代 /feeds/ 读取）
 * 缓存：订阅列表存 localStorage，单集存 IndexedDB
 * 进度：localStorage + 跨设备同步（每台设备一个文件，按条目时间戳合并）
 * 完播 = 播到 98% 以上或手动标记
 */
'use strict';

/* ================= 常量 ================= */
const FEED_BASE = new URL('feeds/', document.baseURI).href; // 同源反代前缀
const INDEX_URL = FEED_BASE + 'podsync.opml';
const SYNC_BASE = new URL('sync/', document.baseURI).href;  // nginx WebDAV 目录
const THUMB_BASE = new URL('thumb', document.baseURI).href;  // 服务端缩略图接口
const COVER_FALLBACK = new URL('icons/icon-192.png', document.baseURI).href; // 没封面时的占位图（PWA 图标）
const STALE_MS = 15 * 60 * 1000;   // 超过这个时间就重取单个 feed
const PAGE_SIZE = 60;              // 列表分批渲染，避免一次塞几千个节点
const DONE_RATIO = 0.98;           // 播到这里就算完播
const SPEEDS_REV = 2;               // 倍速预设表改版号：rev 2 起固定为 1.25/1.5/2/3
const DEFAULT_SPEEDS = [1.25, 1.5, 2, 3];
const DEFAULT_SPEED = 2;            // 默认播放倍速
const THEMES = ['auto', 'light', 'dark'];
const BACK_SEC = 10;                // 后退秒数，与 icons/replay_10.svg 上的数字一致
const FWD_SEC = 30;                 // 前进秒数，与 icons/forward_30.svg 上的数字一致
const PUSH_EVERY = 20 * 1000;       // 播放中最多这么久推进一次云端
const PULL_EVERY = 60 * 1000;       // 回到前台时，距上次拉取超过这么久才再拉
const LS_INDEX = 'podcast.index';
const LS_SETTINGS = 'podcast.settings';
const LS_PROGRESS = 'podcast.progress';
const LS_CURRENT = 'podcast.current'; // 上次播放的单集（iOS 后台被回收后用来把播放器摆回来）
const LS_DEVICE = 'podcast.device';
const LS_SETTINGS_AT = 'podcast.settingsAt';
const LS_SETTINGS_V = 'podcast.settingsV';
const LS_LAMPORT = 'podcast.lamport';

const $ = (id) => document.getElementById(id);
const sentinel = $('sentinel');

/* ================= 本地存储 ================= */
function readLS(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? def : JSON.parse(v);
  } catch (_) { return def; }
}
function writeLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
}

let settings = Object.assign(
  { hideFinished: true, sortDesc: true, feed: '', speed: DEFAULT_SPEED, speeds: null, speedsRev: 1, theme: 'auto', doneView: false },
  readLS(LS_SETTINGS, {})
);
// 兜住历史数据 / 手改坏的值
if (!Array.isArray(settings.speeds) || !settings.speeds.length) settings.speeds = DEFAULT_SPEEDS.slice();
settings.speedsRev = Number(settings.speedsRev) || 1;
if (THEMES.indexOf(settings.theme) < 0) settings.theme = 'auto';
if (!(settings.speed > 0)) settings.speed = DEFAULT_SPEED;

let progress = readLS(LS_PROGRESS, {}) || {};
// 倍速预设的版本/时间：优先用逻辑版本（和进度用同一个时钟），时间只作老数据的兜底
let settingsAt = Number(readLS(LS_SETTINGS_AT, 0)) || 0;
let settingsV = Number(readLS(LS_SETTINGS_V, 0)) || 0;

let lastSave = 0;
// 播放中 timeupdate 很密，进度最多 5 秒落一次盘；落盘顺带把同步推送排上
function saveProgress(force) {
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  writeLS(LS_PROGRESS, progress);
  writeLS(LS_LAMPORT, lamport);      // 逻辑时钟跟着进度一起落盘
  schedulePush(force ? 1500 : PUSH_EVERY);
}
function saveSettings() { writeLS(LS_SETTINGS, settings); }

/* ================= 跨设备同步 =================
 * 存储端是 nginx 的 WebDAV 目录 /sync/（见 podcast/nginx.conf）。
 * 每台设备只写自己那个文件（dev-xxxx.json），读的时候把别人的全拉下来合并，
 * 所以没有"谁把谁覆盖了"的问题。合并规则：
 *   · 单集进度：逐条比逻辑版本 v，大的赢 —— 不按墙上时钟算
 *   · 倍速预设：整块比逻辑版本 settingsV，同样按动作先后，老数据才退回比时间
 *
 * 为什么进度不能用时间：设备间时钟可能差十几分钟，而"动作的先后"才是真语义。
 * 典型翻车：手机播完了一集（动作 5），但那次上传卡住没上去；电脑上那条更早的
 * "未播"记录（动作 2）却因为电脑时钟快而被判成"更新"，完播就这么丢了。
 * 改用 Lamport 逻辑时钟：本地每改一次进度 v+1；合并时把本地时钟推到见过的
 * 最大版本之后，于是"后发生的动作"一定拿到更大的 v，跟时钟准不准无关。
 * v 相同时（两台设备并发改同一条）再用设备标签 dv 定序，保证各设备算出同一个结果。
 */
let deviceId = readLS(LS_DEVICE, null);
if (typeof deviceId !== 'string' || !/^dev-[a-z0-9]+$/.test(deviceId)) {
  deviceId = 'dev-' + Math.random().toString(36).slice(2, 10);
  writeLS(LS_DEVICE, deviceId);
}
const DEVICE_FILE = deviceId + '.json';
const DEV_TAG = deviceId.slice(-3);          // 版本相同时的确定性裁决依据

let lamport = Number(readLS(LS_LAMPORT, 0)) || 0;

function nextVersion() { return ++lamport; }

// 合并时调用：把本地时钟推到所有见过的版本之后
function bumpLamport(v) {
  const n = Number(v) || 0;
  if (n > lamport) lamport = n;
}

// 候选 remote 能不能盖掉 local：版本大的赢；版本相同用设备标签定序
function versionWins(remote, local) {
  if (!local) return true;
  const rv = Number(remote.v) || 0, lv = Number(local.v) || 0;
  if (rv !== lv) return rv > lv;
  return String(remote.dv || '') > String(local.dv || '');
}

// 唯一的进度写入口：打上逻辑版本 + 设备标签，再更新墙上时钟（后者只用于展示）
function touchProgress(id, patch) {
  const pr = progress[id] || { p: 0, d: 0 };
  if (patch) Object.assign(pr, patch);
  pr.v = nextVersion();
  pr.dv = DEV_TAG;
  pr.u = Date.now();
  progress[id] = pr;
  return pr;
}

// 标记/取消完播。c 是"完播时间"，只在 0->1 那一次记下来，
// 「最近完播」按它排序；取消完播时清掉，撤回后就不该再出现在那个列表里。
function setFinished(id, on) {
  // 必须写回 progress：条目还不存在时（手动点勾就是这条路径）只改局部对象会直接丢掉
  const pr = progress[id] || (progress[id] = { p: 0, d: 0 });
  if (on) {
    if (pr.f !== 1) pr.c = Date.now();
    pr.f = 1;
  } else {
    pr.f = 0;
    pr.c = 0;
    pr.p = 0;
  }
  return pr;
}

let pushing = false;
let pulling = false;
let pushTimer = 0;
let pushDueAt = 0;
let lastPull = 0;
let syncBroken = false;

function syncPayload() {
  return {
    v: 2,
    device: deviceId,
    at: Date.now(),
    settingsAt: settingsAt,
    settingsV: settingsV,
    settings: { speed: settings.speed, speeds: settings.speeds, speedsRev: settings.speedsRev },
    progress: progress,
  };
}

// 定时器只保留"最早那个到期时间"：播放中每 5 秒落一次盘，
// 如果每次都 clearTimeout 重排，20 秒的推送会被无限推迟。
function schedulePush(delay) {
  const due = Date.now() + delay;
  if (pushTimer && pushDueAt <= due) return;
  clearTimeout(pushTimer);
  pushDueAt = due;
  pushTimer = setTimeout(() => { pushTimer = 0; pushDueAt = 0; syncPush(); }, delay);
}

async function syncPush() {
  if (pushing) return;
  pushing = true;
  try {
    const res = await fetch(SYNC_BASE + DEVICE_FILE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncPayload()),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // 把 body 读完。不读（或 cancel 掉）的话，浏览器会把这条其实已经 201 成功的
    // PUT 在网络面板里标成 net::ERR_ABORTED，排查问题时很误导。
    await res.text();
    syncBroken = false;
  } catch (err) {
    markSyncBroken(err);
  } finally {
    pushing = false;
  }
}

function markSyncBroken(err) {
  if (syncBroken) return;
  syncBroken = true;
  setStatus('同步不可用：' + ((err && err.message) || err));
}

async function syncPull() {
  if (pulling) return;                 // 启动和回到前台可能同时触发，别拉两遍
  pulling = true;
  lastPull = Date.now();
  try {
    let list;
    try {
      const res = await fetch(SYNC_BASE, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      list = await res.json();
      syncBroken = false;
    } catch (err) {
      markSyncBroken(err);
      return;
    }

    const names = (Array.isArray(list) ? list : [])
      .filter((f) => f && f.type === 'file' && /^dev-[a-z0-9]+\.json$/.test(f.name))
      .map((f) => f.name)
      .filter((n) => n !== DEVICE_FILE);
    if (!names.length) return;

    const docs = [];
    await pool(names, 4, async (n) => {
      try {
        const r = await fetch(SYNC_BASE + n, { cache: 'no-store' });
        if (r.ok) docs.push(await r.json());
      } catch (_) { /* 单个设备文件坏了不影响其它 */ }
    });
    mergeDocs(docs);
  } finally {
    pulling = false;
  }
}

function mergeDocs(docs) {
  let merged = 0;

  for (const d of docs) {
    if (!d || !d.progress) continue;
    for (const id in d.progress) {
      const remote = d.progress[id];
      if (!remote || typeof remote !== 'object') continue;
      bumpLamport(remote.v);                       // 见过就推进本地时钟
      const local = progress[id];
      if (versionWins(remote, local)) { progress[id] = remote; merged++; }
    }
  }

  // 设置块也按"动作"比：先比逻辑版本，两边都没有（老数据）才退回比时间
  const rankOf = (v, at) => [Number(v) || 0, Number(at) || 0];
  const rankGt = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]);
  const mineRank = rankOf(settingsV, settingsAt);

  let best = null;
  for (const d of docs) {
    if (!d || !d.settings) continue;
    if (!rankGt(rankOf(d.settingsV, d.settingsAt), mineRank)) continue;
    if (!best || rankGt(rankOf(d.settingsV, d.settingsAt), rankOf(best.settingsV, best.settingsAt))) {
      best = d;
    }
  }
  if (best) {
    settingsAt = best.settingsAt || 0;
    settingsV = best.settingsV || 0;
    bumpLamport(settingsV);          // 本地时钟跟上去，本地下次改一定"更晚"
    writeLS(LS_SETTINGS_AT, settingsAt);
    writeLS(LS_SETTINGS_V, settingsV);
    if (best.settings.speed > 0) settings.speed = best.settings.speed;
    // 预设表只接受不比本地旧的版本（rev 2 起不能被老客户端推回来的表覆盖）
    const remoteRev = Number(best.settings.speedsRev) || 1;
    if (Array.isArray(best.settings.speeds) && best.settings.speeds.length
        && remoteRev >= (Number(settings.speedsRev) || 1)) {
      settings.speeds = best.settings.speeds;
      settings.speedsRev = remoteRev;
    }
    saveSettings();
    applySpeed(settings.speed);
    renderSpeedMenu();
    merged++;
  }

  if (!merged) return;
  saveProgress(true);
  render();
  setStatus('已从其它设备同步');
  schedulePush(2000);   // 合并结果回写，别的设备下次也能拿到
}

/* ================= IndexedDB：单集缓存 ================= */
let dbPromise = null;
function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const req = indexedDB.open('podcast', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('feeds')) d.createObjectStore('feeds', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  return dbPromise;
}
async function dbGetAll() {
  try {
    const d = await getDB();
    return await new Promise((res, rej) => {
      const r = d.transaction('feeds', 'readonly').objectStore('feeds').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  } catch (_) { return []; }
}
async function dbPut(rec) {
  try {
    const d = await getDB();
    await new Promise((res, rej) => {
      const r = d.transaction('feeds', 'readwrite').objectStore('feeds').put(rec);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  } catch (_) { /* 缓存写失败不影响播放 */ }
}

/* ================= 状态 ================= */
let feeds = [];          // [{id,title,xmlUrl,url,fetchedAt,episodes,error}]
let backendOrigin = null;
let view = [];           // 当前可见条目（已排序）
let rendered = 0;
let current = null;      // 正在播放的条目
let refreshing = false;
let progressRenderTimer = 0; // 刷新过程中按 feed 逐个重绘的节流句柄
const bars = new Map();  // 单集 id -> 进度条 <i>

/* ================= 小工具 ================= */
function tagText(root, name) {
  const n = root.getElementsByTagName(name);
  return n.length ? (n[0].textContent || '').trim() : '';
}
function firstTag(root, name) {
  const n = root.getElementsByTagName(name);
  return n.length ? n[0] : null;
}
function parseDur(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
  const p = s.split(':').map(Number);
  if (p.some((x) => !isFinite(x))) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const days = (now - d) / 86400000;
  if (days < 1 && d.getDate() === now.getDate()) return '今天 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  if (days < 2) return '昨天 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  if (days >= 0 && days < 7) return Math.floor(days) + ' 天前';
  const md = p(d.getMonth() + 1) + '-' + p(d.getDate());
  return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md;
}
// 把后端绝对地址换成同源反代地址
function toLocal(u) {
  if (!u) return '';
  let abs;
  try { abs = new URL(u, document.baseURI); } catch (_) { return u; }
  if (backendOrigin && abs.origin === backendOrigin) {
    return FEED_BASE + abs.pathname.replace(/^\//, '') + abs.search;
  }
  return abs.href;
}
// 封面图：远端的 http 图在 HTTPS 页面会被当混合内容拦掉，统一升到 https
// （hdslb 的 https 是通的，只认 Referer；referrer 策略见 index.html）
function imgUrl(u) {
  const s = toLocal(u);
  if (location.protocol === 'https:' && s.slice(0, 5) === 'http:') return 'https:' + s.slice(5);
  return s;
}
// 封面一律走服务端的缩略图接口（见 podcast/thumbs/）：原站大图动不动上百 KB，
// 让客户端每打开一次列表就去拉一批，既慢又跟音频抢带宽。
// 服务端抓一次、缩到长边 200px 落盘，之后所有设备都拿这张小图。
function thumbUrl(u) {
  const abs = imgUrl(u);
  if (!abs) return '';
  // 本来就在本站的（已经缩过的 / podsync 自己出的图）不必再绕一圈
  if (abs.indexOf(location.origin + '/') === 0) return abs;
  return THUMB_BASE + '?u=' + encodeURIComponent(abs);
}
function epId(feedId, ep) { return feedId + '/' + (ep.g || ep.u); }
function isFinished(pr) {
  return !!pr && (pr.f === 1 || (pr.d > 0 && pr.p / pr.d >= DONE_RATIO));
}
// 顶栏消息只短暂停留：每来一条新消息就重新计时，5 秒后淡出并收起状态行。
// STATUS_FADE 与 style.css 里 .status 的 transition 时长一致，收起完再清空文字。
const STATUS_TTL = 5000;
const STATUS_FADE = 300;
let statusTimer = 0;
function setStatus(s) {
  const el = $('status');
  clearTimeout(statusTimer);
  if (!s) {
    el.textContent = '';
    el.classList.add('hide');
    return;
  }
  el.classList.remove('hide');
  el.textContent = s;
  statusTimer = setTimeout(() => {
    el.classList.add('hide');
    statusTimer = setTimeout(() => { el.textContent = ''; }, STATUS_FADE);
  }, STATUS_TTL);
}

/* ================= 解析 ================= */
function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const channel = firstTag(doc, 'channel') || doc.documentElement;
  const imgEl = firstTag(channel, 'image');
  const itunesImg = firstTag(channel, 'itunes:image');
  const feedImg = imgEl ? tagText(imgEl, 'url') : (itunesImg ? itunesImg.getAttribute('href') : '');

  const items = doc.getElementsByTagName('item');
  const out = [];
  const seen = new Set();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const enc = firstTag(it, 'enclosure');
    const url = enc ? enc.getAttribute('url') : '';
    if (!url) continue;

    const guid = tagText(it, 'guid') || url;
    if (seen.has(guid)) continue;
    seen.add(guid);

    const dateStr = tagText(it, 'pubDate') || tagText(it, 'date');
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    const img = firstTag(it, 'itunes:image');

    out.push({
      g: guid,
      t: tagText(it, 'title') || '(无标题)',
      p: isFinite(ts) ? ts : 0,
      u: url,
      d: parseDur(tagText(it, 'itunes:duration')),
      i: (img && img.getAttribute('href')) || feedImg,
    });
  }
  out.sort((a, b) => b.p - a.p); // 单集按时间倒序，"播完接下一集"依赖这个
  return out;
}

async function loadIndex() {
  const res = await fetch(INDEX_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('OPML HTTP ' + res.status);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
  const nodes = doc.getElementsByTagName('outline');
  const list = [];
  for (let i = 0; i < nodes.length; i++) {
    const xmlUrl = nodes[i].getAttribute('xmlUrl');
    if (!xmlUrl) continue;
    let abs;
    try { abs = new URL(xmlUrl, document.baseURI); } catch (_) { continue; }
    if (!backendOrigin) backendOrigin = abs.origin;
    list.push({
      id: abs.pathname.split('/').pop().replace(/\.xml$/i, ''),
      title: nodes[i].getAttribute('title') || nodes[i].getAttribute('text') || '',
      xmlUrl: xmlUrl,
      url: toLocal(xmlUrl),
    });
  }
  // 本地 TTS 音频（index-tts 生成）：不在 podsync 的 opml 里，这里补一条。
  // feed 和音频都由 podcast 的 nginx 同源提供（见 nginx.conf 的 /tts/），
  // 服务没起来时只是这一项刷新失败，不影响其他订阅。
  const ttsFeed = new URL('tts/feed.xml', document.baseURI).href;
  list.push({ id: 'tts', title: '本地 TTS', xmlUrl: ttsFeed, url: ttsFeed });

  // 外部订阅：列表只在 external-feeds.tsv 里维护，nginx 启动时按它生成反代
  // （见 gen-external-feeds.sh），客户端也读同一份文件。源站不带 CORS 头，
  // 所以 feed 走同源反代 /ext/<id>/rss；单集音频是 https 直链，播放不需要 CORS。
  // 文件拿不到时只是少几个外部源，不能影响 podsync 的订阅。
  try {
    const res = await fetch(new URL('external-feeds.tsv', document.baseURI), { cache: 'no-store' });
    if (res.ok) {
      for (const raw of (await res.text()).split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const cols = line.split('\t');
        const id = (cols[0] || '').trim();
        if (!/^[a-z0-9_-]+$/.test(id)) continue;
        const title = (cols[1] || id).trim();
        const u = new URL('ext/' + id + '/rss', document.baseURI).href;
        list.push({ id: id, title: title, xmlUrl: u, url: u });
      }
    }
  } catch (_) { /* 外部列表不可用不影响主流程 */ }
  return list;
}

/* ================= 拉取与刷新 ================= */
async function pool(items, limit, fn) {
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) await fn(items[idx++]);
  });
  await Promise.all(workers);
}

async function refresh(force) {
  if (refreshing) return;
  refreshing = true;
  $('refresh').disabled = true;
  try {
    setStatus('读取订阅列表…');
    const index = await loadIndex();

    // 缓存里的单集先留着，切换后立刻能显示
    const cached = new Map((await dbGetAll()).map((r) => [r.id, r]));
    feeds = index.map((f) => {
      const c = cached.get(f.id);
      return Object.assign({}, f, {
        fetchedAt: c ? c.fetchedAt : 0,
        lastModified: c && c.lastModified ? c.lastModified : '',
        episodes: c && c.episodes ? c.episodes : [],
      });
    });
    writeLS(LS_INDEX, { backendOrigin: backendOrigin, feeds: index });
    syncFeedSelect();
    render();

    const stale = feeds.filter((f) => force || Date.now() - f.fetchedAt > STALE_MS);
    let done = 0, failed = 0, unchanged = 0;
    // 并发 8：链路是 HTTP/2（tailscale serve 协商出来的），多路复用，
    // 所以不受浏览器"单域名 6 连接"的限制，开高一点能明显缩短等待。
    await pool(stale, 8, async (f) => {
      let updated = false;   // 只有这个 feed 真的多了新单集才重绘
      try {
        // feed 大部分时候没变，带上 If-Modified-Since 就能只收一个 304 ——
        // 不但省掉整个体的下载，连 DOMParser 和重建对象都省了
        const headers = {};
        if (f.lastModified && f.episodes.length) headers['If-Modified-Since'] = f.lastModified;

        const res = await fetch(f.url, { cache: 'no-store', headers: headers });
        if (res.status === 304) {
          f.fetchedAt = Date.now();
          f.error = '';
          unchanged++;
        } else {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          // 上游经常回 200 但内容没变，逐个比较 guid 才知道到底有没有新单集
          const seen = new Set(f.episodes.map((e) => e.g || e.u));
          const episodes = parseFeed(await res.text());
          updated = episodes.some((e) => !seen.has(e.g || e.u));
          f.episodes = episodes;
          f.fetchedAt = Date.now();
          f.lastModified = res.headers.get('Last-Modified') || f.lastModified || '';
          f.error = '';
        }
        await dbPut({
          id: f.id, fetchedAt: f.fetchedAt, lastModified: f.lastModified, episodes: f.episodes,
        });
      } catch (err) {
        f.error = String((err && err.message) || err);
        failed++;
      }
      setStatus('更新 ' + (++done) + '/' + stale.length);
      if (updated) renderSoon();   // 有更新就立刻让它冒出来，不等其它源
    });

    clearTimeout(progressRenderTimer);
    progressRenderTimer = 0;
    pruneProgress();
    render();
    const stamp = new Date().toTimeString().slice(0, 5);
    if (failed) setStatus(stamp + ' 更新完成，' + failed + ' 个失败');
    else if (unchanged) setStatus(stamp + ' 已更新（' + unchanged + ' 个未变化）');
    else setStatus(stamp + ' 已更新');
  } catch (err) {
    setStatus('离线：' + String((err && err.message) || err));
  } finally {
    refreshing = false;
    $('refresh').disabled = false;
  }
}

// 清理进度表。注意不能"源里没有就删"：完播/取消完播是靠条目时间戳在设备间分胜负的，
// 本地删掉的条目会被别的设备同步回来，两边来回拉锯。所以只清 90 天以上没人动的陈年数据。
function pruneProgress() {
  if (!feeds.some((f) => f.episodes.length)) return;   // feed 还没拉到，别动
  const alive = new Set();
  for (const f of feeds) for (const e of f.episodes) alive.add(epId(f.id, e));
  const cutoff = Date.now() - 90 * 86400000;
  const keep = {};
  for (const id in progress) {
    if (alive.has(id) || (progress[id].u || 0) > cutoff) keep[id] = progress[id];
  }
  progress = keep;
}

/* ================= 列表渲染 ================= */
function visibleEpisodes() {
  const out = [];
  const doneView = !!settings.doneView;
  for (const f of feeds) {
    if (settings.feed && settings.feed !== f.id) continue;
    for (const e of f.episodes) {
      const id = epId(f.id, e);
      const pr = progress[id] || null;
      const fin = isFinished(pr);
      if (doneView) {
        if (!fin) continue;                  // 「最近完播」只看完播过的
      } else if (settings.hideFinished && fin) {
        continue;
      }
      out.push({
        id: id, e: e, f: f, pr: pr, fin: fin,
        c: (pr && pr.c) || 0,
        pct: pr && pr.d > 0 ? Math.min(100, (pr.p / pr.d) * 100) : 0,
      });
    }
  }
  if (doneView) {
    // 按"完播时间"倒序 —— 这个视图的用途就是点错了能立刻翻到、撤回
    out.sort((a, b) => (b.c - a.c) || (b.e.p - a.e.p));
  } else {
    out.sort((a, b) => (settings.sortDesc ? b.e.p - a.e.p : a.e.p - b.e.p));
  }
  return out;
}

function rowEl(it) {
  const playing = !!(current && current.id === it.id);
  const row = document.createElement('article');
  row.className = 'ep' + (it.fin ? ' done' : '') + (playing ? ' playing' : '');
  row.dataset.id = it.id;

  // 封面走服务端缩略图（见 podcast/thumbs/）：原站大图一次都不该由客户端去拉 ——
  // 又慢又跟音频抢带宽。referrerpolicy 保留作兜底：将来若直接回退原图，
  // bilibili 图床对"非 bilibili 的 Referer"会 403，不带 Referer 才给图。
  const cover = document.createElement('img');
  cover.className = 'ep-img';
  cover.alt = '';
  cover.loading = 'lazy';
  cover.decoding = 'async';
  cover.referrerPolicy = 'no-referrer';
  cover.fetchPriority = 'low';        // 永远别跟音频抢带宽
  const coverSrc = thumbUrl(it.e.i);
  // 没封面（feed 里没有 image，或缩略图抓取失败）就用 PWA 图标占位，
  // 比留个空白格好认；once 是防止占位图自己也失败时反复触发。
  cover.src = coverSrc || COVER_FALLBACK;
  cover.addEventListener('error', () => { cover.src = COVER_FALLBACK; }, { once: true });

  const main = document.createElement('div');
  main.className = 'ep-main';

  const meta = document.createElement('div');
  meta.className = 'ep-meta';
  // 「最近完播」视图里显示完播时间 —— 列表就是按它排的
  // meta.textContent = it.f.title + ' · '
  //   + (settings.doneView ? '完播于 ' + fmtDate(it.c) : fmtDate(it.e.p))
  //   + (it.e.d ? ' · ' + fmtDur(it.e.d) : '');

  meta.textContent = it.f.title + '  '
    + (settings.doneView ? '完播于 ' + fmtDate(it.c) : fmtDate(it.e.p))
    + (it.e.d ? '  ' + fmtDur(it.e.d) : '');

  const title = document.createElement('div');
  title.className = 'ep-title';
  title.textContent = it.e.t;

  main.appendChild(meta);
  main.appendChild(title);

  if (it.pct > 0 || playing) {
    const bar = document.createElement('div');
    bar.className = 'ep-bar';
    const fill = document.createElement('i');
    fill.style.width = it.pct.toFixed(1) + '%';
    bar.appendChild(fill);
    main.appendChild(bar);
    bars.set(it.id, fill);
  }

  const done = document.createElement('button');
  done.className = 'ep-done';
  done.type = 'button';
  const doneIco = document.createElement('span');
  doneIco.className = 'ico ico-check';
  done.appendChild(doneIco);
  done.setAttribute('aria-pressed', String(!!it.fin));
  done.title = it.fin ? '取消已完播' : '标记为已完播';

  row.appendChild(cover);
  row.appendChild(main);
  row.appendChild(done);
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('.ep-done')) { toggleDone(it); return; }
    play(it);
  });
  return row;
}

function render() {
  view = visibleEpisodes();
  rendered = 0;
  bars.clear();
  const list = $('list');
  list.innerHTML = '';
  list.appendChild(sentinel);   // 哨兵始终留在列表末尾
  renderMore();
  fill();

  $('empty').hidden = view.length > 0;
  if (!view.length) {
    if (!feeds.length) {
      $('empty').textContent = '正在加载订阅…';
    } else if (settings.doneView) {
      $('empty').textContent = '还没有完播记录。';
    } else {
      $('empty').textContent = settings.hideFinished
        ? '没有未播放的单集了。关掉「隐藏已完播」可以看历史。'
        : '这里没有单集。';
    }
  }
}

// 刷新过程中每完成一个 feed 就重绘一次：30+ 个源是并发拉的，等全部结束再
// 一次性出结果要空转十几秒。节流到 300ms，既不会每个 feed 都重建整张列表，
// 又能看到单集陆续冒出来。重绘会重建 DOM，先把滚动位置记下来再放回去。
function renderSoon() {
  if (progressRenderTimer) return;
  progressRenderTimer = setTimeout(() => {
    progressRenderTimer = 0;
    renderKeepScroll();
  }, 300);
}

function renderKeepScroll() {
  const list = $('list');
  const top = list.scrollTop;
  render();
  list.scrollTop = top;
}

function renderMore() {
  if (rendered >= view.length) return;
  const end = Math.min(rendered + PAGE_SIZE, view.length);
  const frag = document.createDocumentFragment();
  for (let i = rendered; i < end; i++) frag.appendChild(rowEl(view[i]));
  $('list').insertBefore(frag, sentinel);
  rendered = end;
}

// 首屏把可视区填满，剩下的交给滚动
function fill() {
  const list = $('list');
  let guard = 0;
  while (rendered < view.length && guard++ < 100) {
    if (sentinel.getBoundingClientRect().top > list.getBoundingClientRect().bottom + 600) break;
    renderMore();
  }
}

// 点播放器顶部回到列表里正在播的那一集。列表是分批渲染的，目标还没铺到就
// 继续往下铺到它出现，再把它滚到屏幕中间。
function jumpToPlaying() {
  if (!current) return;
  const idx = view.findIndex((it) => it.id === current.id);
  if (idx < 0) {
    setStatus('正在播放的单集不在当前列表里');
    return;
  }
  while (rendered <= idx && rendered < view.length) renderMore();
  const row = $('list').querySelector('.ep.playing');
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function toggleDone(it) {
  const wasDone = isFinished(progress[it.id]);
  const base = progress[it.id] || {};
  // 取消完播写成"墓碑"（f=0、位置归零）而不是删掉 —— 删掉的条目会被别的设备的
  // 旧记录同步回来，那就永远取消不掉了。
  const pr = setFinished(it.id, !wasDone);
  pr.d = base.d || it.e.d || 0;
  pr.p = wasDone ? 0 : (base.p || 0);
  touchProgress(it.id, null);        // 记一个新版本，撤回也会正确传播到其它设备
  saveProgress(true);
  setStatus(wasDone ? '已撤回完播：' + it.e.t : '已标记完播：' + it.e.t);
  render();
}

/* ================= 播放器 ================= */
// 用文档里的 <audio>（见 index.html），不要 new Audio()：iOS 装到桌面的 PWA
// 切后台时会把脱离文档的媒体元素挂起，后台播放/锁屏控制/暂停后恢复全都失效。
// 兜底兼容旧缓存里的 index.html（没有这个节点时自己建一个并挂到 body）。
const audio = $('player-audio') || (() => {
  const el = document.createElement('audio');
  el.id = 'player-audio';
  document.body.appendChild(el);
  return el;
})();
audio.preload = 'metadata';
audio.preservesPitch = true;
if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;

let pendingSeek = null;
let seeking = false;
let seekRaf = 0;           // 播放中推进进度条的 rAF 句柄（见 startSeekTicker）
let stallTimer = 0;
let stallRetry = 0;
let stallFrom = 0;
// 用户的播放意图。不能拿 audio.paused 当"是不是该在播"：
// 切后台/来电/加载失败都可能让元素停在 paused=false 却没声音的状态，
// 之后点播放反而执行 pause，于是"暂停了再也回不来"。
let wantPlay = false;

// iOS 的 <audio> 一旦自然播完（ended），WebKit 会关掉本页的 audio session：
// 前台还能重新 play()，后台会被直接拒绝，锁屏/控制中心的按钮随之全部失灵。
// 让元素永远 loop，在它回卷到 0 的那一刻同步切下一集 —— 没有 ended，
// session 就不会被关掉（WebKit bug 261858 / 243258）。
audio.loop = true;
let lastTime = 0;          // 上一次 timeupdate 的位置，用来识别"回卷"
let manualSeekAt = 0;      // 本页主动定位的时间，别把拖动误判成自然播完
let seekNearEnd = false;   // 用户主动拖到了结尾附近，这次的"回卷"算播完
let wrapping = false;      // 正在切下一集，防止 seeking/timeupdate 重复触发
let needReload = false;    // 断流后元素停在截断的结尾，下次播放必须先 load()
let playedThisPage = false; // 本页是否真的出过声（见 requestPlay 里的 iOS 26 兜底）
let sourceFresh = false;    // src 是不是刚在同一个手势里设过，别再重设一次
let lastAudioMoveAt = 0;    // currentTime 最近一次推进的时间
let playWatchdog = 0;       // play() resolve 了却一直没声音时的兜底定时器
let playAttempt = 0;        // 每次播放尝试的编号，防止旧定时器误伤新尝试
let hiddenAt = 0;           // 切到后台的时间，回来时判断离开了多久

const STALL_RETRY_MAX = 3;
const STALL_WAIT_MS = 5000;          // 第 n 次重试等 n*5 秒
const PLAY_ALIVE_MS = 5000;          // 前台超过这么久没推进就当作没在响
const PLAY_WATCHDOG_MS = 4000;       // play() 之后多久还没声音就强制换源重试

// 网络断流时浏览器会把"已经缓冲到哪"当成整个音频资源的结尾：duration 会变成一个
// 明显偏小的值（也可能直接是 NaN / Infinity），播到那儿就触发 ended。
// 这和"真播完了"完全不是一回事，绝不能拿它当完播、更不能自动跳下一集。
// 判据：媒体时长必须有限、大于 0，且不能明显短于 feed 里声明的时长。
function mediaDurationOk() {
  const dur = audio.duration;
  if (!isFinite(dur) || dur <= 0) return false;
  const declared = current && current.e.d ? current.e.d : 0;
  return !(declared > 0 && dur < declared * 0.9);
}
// 显示/算百分比用的时长：媒体时长不可信就退回 feed 声明的，免得按错误总长算
function displayDuration() {
  if (mediaDurationOk()) return audio.duration;
  return (current && current.e.d) || 0;
}
// 这次是不是真的播到结尾了
function playbackCompleted() {
  if (!current || audio.error || !mediaDurationOk()) return false;
  return audio.currentTime >= audio.duration - 2;
}

function cancelResume() {
  if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; }
}

// 元素现在是不是真的能出声：paused 不可信（见前面 wantPlay 的注释），
// 有数据、没错误才算数。
function isMediaAlive() {
  return !audio.error && audio.readyState >= 2;
}

// iOS 16.4+ 的 Audio Session API：显式声明"这是媒体播放"，系统才按播放类
// 应用处理音频路由和后台生命周期。必须在用户手势的同步路径里设置，
// 不支持这个 API 的浏览器直接跳过。
function armAudioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (_) {}
}

// play() 在旧 WebKit 上可能不返回 Promise，统一走这里，别让同步异常
// 把后面的逻辑打断。
function callPlay() {
  let p;
  try { p = audio.play(); } catch (err) { onPlayError(err); return; }
  if (p && typeof p.catch === 'function') p.catch(onPlayError);
}

function clearPlayWatchdog() {
  if (playWatchdog) { clearTimeout(playWatchdog); playWatchdog = 0; }
  playAttempt++;
}

// 播放位置：源还没加载时（比如 PWA 被回收后重开、播放器只是摆回来）
// 用 pendingSeek / 已保存的进度，别让界面显示成 0:00。
function currentPosition() {
  if (pendingSeek != null && audio.readyState < 2) return pendingSeek;
  return isFinite(audio.currentTime) ? Math.max(audio.currentTime || 0, 0) : 0;
}

function savedPosition(it) {
  const pr = it && progress[it.id];
  return pr && !isFinished(pr) && pr.p > 0 ? pr.p : 0;
}

// 元素此刻是不是真的在响。三件事都要成立：
//  1. 用户意图是播放；2. 元素没被暂停、没播完、没报错；
//  3. 前台时 currentTime 最近还在推进。
// 不能只看 wantPlay（iOS 26 的 PWA 里 play() 可能 resolve 却完全没声音），
// 也不能只看 audio.paused（切后台/中断后可能停了却仍报 paused=false）。
function isActuallyPlaying() {
  if (!wantPlay || audio.ended || audio.error || audio.paused) return false;
  if (audio.readyState < 2) return false;
  // 后台拿不到 timeupdate，不能拿"多久没动"判死，否则回前台会把还在
  // 正常播放的音频当成停了、重新拉流，反而把后台播放掐断。
  if (document.hidden) return true;
  return !lastAudioMoveAt || Date.now() - lastAudioMoveAt < PLAY_ALIVE_MS;
}

// play() 之后如果 4 秒还没有任何声音（currentTime 不动、也没进过 playing），
// 就强制换一次源再试。iOS 26 的 PWA 在重开后会让 <audio> 卡住：
// play() 正常 resolve、没有 error，但完全不出声（WebKit bug 295518）。
// 这个兜底只在看得见页面时跑 —— 后台的定时器本来就会被冻住。
function armPlayWatchdog(at, retried) {
  clearPlayWatchdog();
  const token = playAttempt;
  const armedAt = Date.now();
  playWatchdog = setTimeout(() => {
    playWatchdog = 0;
    if (token !== playAttempt || !wantPlay || !current) return;
    if (document.hidden) return;                 // 回前台由 onForeground 再补
    // 还没拿到可用数据、网络仍在加载：这多半是慢，不是卡死。别在这里
    // 重置，否则慢网下刚拉起的请求会被一遍遍掐掉。真正的网络问题由
    // stalled / error 事件管。
    if (audio.readyState < 2 && audio.networkState === 2) return;
    const moved = isFinite(at) && audio.currentTime > at + 0.2;
    // 已经真的放过（playing 过）又被暂停，是被系统/用户停的，不是"没起来"
    if (audio.paused && lastAudioMoveAt >= armedAt) return;
    if (!audio.paused && isMediaAlive()
        && (moved || lastAudioMoveAt >= armedAt)) return;
    if (retried) {
      wantPlay = false;
      setStatus('播放没起来，点播放继续');
      return;
    }
    const pos = audio.currentTime > 0 ? audio.currentTime : at;
    reloadAt(pos, true);
  }, PLAY_WATCHDOG_MS);
}

// 当前位置是不是"从结尾回卷到了开头"。用户自己拖进度条不算：
// seekTo() 会先记 manualSeekAt，由 seeking/seeked 两个事件兜住。
function maybeWrapped(from, to) {
  if (wrapping || !current) return false;
  if (Date.now() - manualSeekAt < 1500 && !seekNearEnd) return false;
  return isFinite(from) && isFinite(to)
    && from > 3 && to < 1.5 && from - to > 2;
}

// 重新走一遍资源选择，再定位回断点播放。
// 后台被系统挂起/中断之后，元素可能停在"请求过播放但没有任何数据"甚至 error 的状态，
// 这时光调 play() 不会重新拉流，必须 load()。
// 先清空 src 再设回同一个地址：iOS 26 的 PWA 重开后，元素会卡在"有 src 但不出声"
// 的状态，直接再赋一次同样的 URL 不一定能重新走加载流程（WebKit bug 295518）。
function reloadAt(pos, fromWatchdog) {
  if (!current) return;
  clearPlayWatchdog();
  cancelResume();
  pendingSeek = pos > 0 ? pos : null;
  audio.loop = true;
  needReload = false;
  lastTime = 0;
  seekNearEnd = false;
  sourceFresh = false;
  armAudioSession();
  try { audio.pause(); } catch (_) {}
  try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
  audio.src = toLocal(current.e.u);
  audio.load();
  audio.playbackRate = settings.speed;
  wantPlay = true;
  armPlayWatchdog(pendingSeek || 0, !!fromWatchdog);
  callPlay();
}

// 想继续播（锁屏播放键、回来点播放、从后台恢复）都走这里
function requestPlay() {
  if (!current) return;
  armAudioSession();                   // 必须在手势里、play() 之前
  cancelResume();                      // 用户/系统主动操作了，撤掉待执行的自动重试
  wantPlay = true;
  audio.playbackRate = settings.speed;
  const at = currentPosition() || savedPosition(current);
  // 上次加载失败、系统把 src 清掉了、断流停在截断的结尾，或这是本页第一次播放：
  // 直接 play() 救不回来。iOS 26 的 PWA 重开后尤其明显，必须在 play() 前
  // 重新设一遍 src（WebKit bug 295518）。
  const needReset = !audio.getAttribute('src') || audio.error || needReload
    || (!playedThisPage && !sourceFresh);
  sourceFresh = false;
  if (needReset) {
    reloadAt(at, false);
    return;
  }
  armPlayWatchdog(at, false);
  callPlay();
}

// 用户主动暂停：清掉播放意图，回到前台时不会被自动恢复
function userPause() {
  wantPlay = false;
  clearPlayWatchdog();
  cancelResume();
  audio.pause();
  saveProgress(true);
}

// 从后台回到前台 / bfcache 恢复：意图是播放、元素却没了声音，就补一下。
// 系统在后台把 WebContent 挂起时，定时器也会一起冻住，自动重试用不上，
// 只能等回到前台补这一下。
function resumeIfNeeded(awayMs) {
  if (!current || !wantPlay) return;
  // 后台排下的重试定时器会被冻住。离开很久回来时直接接手续播，
  // 不再干等那个已经过期的定时器；短时间离开还是让它自己跑完。
  if (stallTimer) {
    if (awayMs > 60000) cancelResume();
    else return;
  }
  // 正在正常播放，别打扰。后台可能没有 timeupdate，所以这里不更新
  // lastAudioMoveAt：回到前台后由真实的 timeupdate 证明它还在响。
  // 但也挂一个 watchdog：如果元素只是"报 paused=false"却没声音，
  // 4 秒后会自动换源；真在播的话 timeupdate 会把它清掉。
  if (!audio.paused && isMediaAlive()) {
    armPlayWatchdog(audio.currentTime, false);
    return;
  }
  const at = currentPosition() || savedPosition(current);
  // 元素没源 / 报错 / 断流 / 在后台待了太久：重新走一遍资源选择。
  // 离开超过一分钟，WebKit 很可能已经把元素挂起（iOS 26 上还会卡成静音），
  // 这时 play() 不一定能救回来。只是短时间被系统暂停的，先原地 play() ——
  // 不要重设 src，免得把现有的 audio session 和缓冲一起丢掉。
  if (!audio.getAttribute('src') || audio.error || needReload || awayMs > 60000) {
    reloadAt(at, false);
    return;
  }
  armAudioSession();
  armPlayWatchdog(at, false);
  callPlay();
}

// loop 回卷到 0：这不是用户拖动，可能是真的播完了，也可能是网络断流时
// 浏览器把"已缓冲的末尾"当成整个音频的结尾。必须在这个事件里同步处理，
// 不能丢给 setTimeout —— 后台的定时器会被冻住。
function onTrackWrapped() {
  if (!current || wrapping) return;
  wrapping = true;
  try {
    const id = current.id;
    // 时长明显短于 feed 声明 → 断流，不是完播：停下来等网络恢复后从断点重试。
    if (!mediaDurationOk()) {
      try { audio.pause(); } catch (_) {}
      audio.loop = false;            // 别让 seek 回断点时又触发一次回卷
      needReload = true;             // 下次 play() 必须重新 load，回到断点
      const at = Math.max((progress[id] && progress[id].p) || 0, lastTime || 0);
      try { manualSeekAt = Date.now(); audio.currentTime = at; } catch (_) {}
      scheduleResume('音频被网络中断');
      return;
    }
    const d = audio.duration;
    touchProgress(id, { p: d, d: d });
    setFinished(id, true);
    saveProgress(true);
    const next = nextEpisode();
    if (next) {
      play(next);                   // play() 里先 pause 再换源，session 不会被关
      return;
    }
    wantPlay = false;
    try { audio.pause(); } catch (_) {}
    if (d > 0) {
      // 停在结尾附近，别让 loop 把界面又拽回 0:00
      try { manualSeekAt = Date.now(); audio.currentTime = Math.max(0, d - 0.5); } catch (_) {}
    }
    setStatus('列表里没有可接着播的单集了');
    render();
  } finally {
    wrapping = false;
    seekNearEnd = false;
  }
}

// 断流不跳集，改成从断点重试拉流（退避重试，最多 3 次）
function scheduleResume(reason) {
  if (!current || stallTimer) return;
  const id = current.id;
  if (stallRetry >= STALL_RETRY_MAX) {
    setStatus(reason + '，重试 ' + STALL_RETRY_MAX + ' 次仍未恢复，点播放可继续');
    wantPlay = false;                // 别让按钮卡在"播放中"，等用户明确点一次
    clearPlayWatchdog();
    return;
  }
  stallRetry++;
  const wait = STALL_WAIT_MS * stallRetry;
  setStatus(reason + '，' + Math.round(wait / 1000) + ' 秒后从断点重试（'
            + stallRetry + '/' + STALL_RETRY_MAX + '）');
  stallTimer = setTimeout(() => {
    stallTimer = 0;
    if (!current || current.id !== id) return;   // 已经换集或关掉了
    if (!audio.paused && isMediaAlive()) return; // 已经自己在放了
    stallFrom = (progress[id] && progress[id].p) || 0;
    reloadAt(stallFrom);
  }, wait);
}

audio.addEventListener('loadedmetadata', () => {
  audio.playbackRate = settings.speed;
  if (pendingSeek != null) {
    manualSeekAt = Date.now();       // 这是本页恢复断点，不是自然播完
    try { audio.currentTime = pendingSeek; } catch (_) {}
    pendingSeek = null;
  }
  lastTime = audio.currentTime;
  if (current) {
    const d = displayDuration();
    if (d > 0) {
      touchProgress(current.id, { d: d });
      saveProgress(true);
    }
  }
  updateTimes();
  updateSeekBar();
  updatePositionState();
});

// loop 回卷时先改 currentTime 再发事件，seeking / timeupdate 哪个先到都接住。
// 两处都只认 maybeWrapped()，用户拖动由 manualSeekAt 排除。
audio.addEventListener('seeking', () => {
  if (maybeWrapped(lastTime, audio.currentTime)) onTrackWrapped();
});
audio.addEventListener('seeked', () => {
  lastTime = audio.currentTime;      // 手动定位后同步基准，避免下次误判
});

audio.addEventListener('timeupdate', () => {
  // currentTime 在推进 = 元素真的在出声。放在最前面，别被后面的早退挡掉。
  if (!audio.paused) lastAudioMoveAt = Date.now();
  if (!current || !audio.duration) return;
  if (maybeWrapped(lastTime, audio.currentTime)) { onTrackWrapped(); return; }
  lastTime = audio.currentTime;
  const d = displayDuration();
  if (!d) return;
  if (!seeking) updateSeekBar();
  updateTimes();

  touchProgress(current.id, { p: audio.currentTime, d: d });
  // 时长可信时才判断完播：断流造成的假结尾不能落成完播记录。
  // setFinished 只在 0->1 那一次记完播时间 c，所以重复调用不会把 c 冲成"最后一次写入时间"。
  if (mediaDurationOk() && audio.currentTime / audio.duration >= DONE_RATIO) setFinished(current.id, true);
  saveProgress(false);

  // 断流重试后又真播了一分钟才算恢复，把重试计数清零
  if (stallRetry && stallFrom && audio.currentTime - stallFrom > 60) {
    stallRetry = 0;
    stallFrom = 0;
  }

  const fillEl = bars.get(current.id);
  if (fillEl) fillEl.style.width = ((audio.currentTime / d) * 100).toFixed(1) + '%';

  updatePositionState();
});

// 浏览器自己认定"拿不到数据"了。先别急着重载，走原来的退避重试：
// 5 秒后如果还没恢复，才从断点重新拉流。正常缓冲不会触发 stalled。
audio.addEventListener('stalled', () => {
  if (current && wantPlay && !document.hidden) scheduleResume('音频缓冲中断');
});

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!current) return;
  const d = displayDuration();
  if (!(d > 0)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      position: Math.min(currentPosition(), d),
      playbackRate: audio.playbackRate,
    });
  } catch (_) {}
}

// 定位的唯一入口：锁屏拖动、±10/30 秒、页内进度条都走它。
// 元数据还没到时先记进 pendingSeek（loadedmetadata 会应用），
// 否则 currentTime 赋值会被元素直接丢掉。
function seekTo(t) {
  if (!current || !isFinite(t)) return;
  t = Math.max(0, t);
  const d = displayDuration();
  // 不要正好拖到 duration：loop 下会被当成回卷，自动跳到下一集。
  if (d > 0) t = Math.min(t, Math.max(0, d - 0.5));
  seekNearEnd = d > 0 && t >= d - 1;  // 拖到结尾附近：这次的"回卷"按播完处理
  manualSeekAt = Date.now();          // 标记成本页主动定位，别被识别成自然播完
  if (audio.readyState >= 1) {
    try { audio.currentTime = t; } catch (_) {}
  } else {
    pendingSeek = t;
  }
  cancelResume();                 // 用户自己定位了，撤掉待执行的自动重试
  touchProgress(current.id, { p: t });
  saveProgress(true);
  updateTimes();
  updatePositionState();
}

function seekBy(delta) {
  if (!current) return;
  seekTo(currentPosition() + delta);
}

function syncPlaybackState() {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}
function setPlayIcon(playing) {
  $('plIcon').className = 'ico ' + (playing ? 'ico-pause' : 'ico-play');
  $('plPlay').setAttribute('aria-label', playing ? '暂停' : '播放');
}
audio.addEventListener('play', () => {
  if (current) wantPlay = true;    // 系统默认控件直接 play() 时也把意图接回来
  setPlayIcon(true);
  syncPlaybackState();
  startSeekTicker();
});
audio.addEventListener('playing', () => {
  playedThisPage = true;           // iOS 26 的"重开后静默失败"兜底可以收工了
  lastAudioMoveAt = Date.now();
  clearPlayWatchdog();
  cancelResume();                  // 自己缓冲好了，不用再重试
  armAudioSession();
  // iOS 会忽略"媒体真正开始播放之前"注册的 MediaSession handler。
  // 先把 metadata / playbackState 摆好，再注册 handler，顺序稳一点。
  if (current) updateMediaSession(current);
  syncPlaybackState();
  setupMediaSession();
  const st = $('status').textContent;
  if (st.slice(0, 4) === '播放失败' || st.indexOf('重试') >= 0) setStatus('');
});
audio.addEventListener('pause', () => {
  stopSeekTicker();
  updateSeekBar();           // 停在准确位置，别留最后一帧
  setPlayIcon(false);
  saveProgress(true);
  syncPlaybackState();
  updatePositionState();     // 暂停后锁屏面板要停在这个位置，否则滑条会回跳到旧值
  // 暂停状态下锁屏面板还要能再点播放：iOS 可能在后台把 handler 丢掉，
  // 这里再补注册一次，播放键才不会没反应。
  setupMediaSession();
});
audio.addEventListener('ended', () => {
  stopSeekTicker();
  if (current && !playbackCompleted()) {
    // 网络断流被当成"播完"了：记下位置，不标完播、不跳集，改成等网络恢复续播
    touchProgress(current.id, {
      p: Math.max((progress[current.id] && progress[current.id].p) || 0, audio.currentTime || 0),
    });
    saveProgress(true);
    scheduleResume('音频被网络中断');
    return;
  }
  if (current) {
    const pr = setFinished(current.id, true);
    if (pr.d) pr.p = pr.d;
    touchProgress(current.id, {});
    saveProgress(true);
    render();
  }
  wantPlay = false;          // 这一集确实播完了，别再被前台恢复逻辑拉起来
  clearPlayWatchdog();
  const next = nextEpisode();
  if (next) play(next);
  else setStatus('列表里没有可接着播的单集了');
});
audio.addEventListener('error', () => {
  if (!current || !audio.getAttribute('src')) return;
  // 只是启动时摆回来的播放器、用户还没点播放：不重试，也别弹错误
  if (!wantPlay) return;
  // 加载失败同样不跳集，交给重试
  scheduleResume('音频加载失败（code ' + (audio.error ? audio.error.code : '?') + '）');
});

function updateTimes() {
  // 用 displayDuration()：媒体时长被截断/读不出来时退回 feed 声明的时长，
  // 免得时间轴显示成 "0:12 / 0:12" 这种假的总长。
  // 位置用 currentPosition()：PWA 被回收后重开、播放器只是摆回来时，
  // 元素还没有 src，不能显示成 0:00。
  $('plTime').textContent = fmtDur(currentPosition()) + ' / ' + fmtDur(displayDuration());
}

function updateSeekBar() {
  paintSeek(currentPosition(), displayDuration());
}

// 值没变就不碰 DOM：长音频里 1000 级刻度每帧只走一小格，没必要重绘轨道
function paintSeek(pos, d) {
  const v = d > 0 ? String(Math.round((pos / d) * 1000)) : '0';
  const seek = $('plSeek');
  if (seek.value === v) return;
  seek.value = v;
  setSeekFill(Number(v) / 10);
}

// 自绘进度条靠 --pct 涂出已播部分（见 style.css 的 .pl-seek）
function setSeekFill(pct) {
  $('plSeek').style.setProperty('--pct', Math.min(100, Math.max(0, pct)) + '%');
}

/* 播放中进度条按屏幕刷新率推进：timeupdate 只有 ~4Hz，只靠它拖柄是一跳一跳的
   （短音频尤其明显，一次就是好几格）。暂停、拖动、切集时停掉，
   位置由 timeupdate / seeked 兜底。 */
function tickSeek() {
  seekRaf = 0;
  if (audio.paused || audio.ended || seeking || !current) return;
  updateSeekBar();
  seekRaf = requestAnimationFrame(tickSeek);
}
function startSeekTicker() {
  if (!seekRaf) seekRaf = requestAnimationFrame(tickSeek);
}
function stopSeekTicker() {
  if (!seekRaf) return;
  cancelAnimationFrame(seekRaf);
  seekRaf = 0;
}

function updateMediaSession(it) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const art = [];
  // 用缩略图：MediaMetadata 的图走 CORS 拉取，同源的缩略图一定能过，
  // 而且不用为了锁屏去拉一张上百 KB 的原图
  const img = thumbUrl(it.e.i) || COVER_FALLBACK;
  if (img) art.push({ src: img, sizes: '200x200' });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: it.e.t, artist: it.f.title, album: '播客', artwork: art,
  });
}

// 锁屏/控制中心的按钮。启动时先注册一次，之后每次 playing 再注册一遍：
// iOS 只认媒体进入 Now Playing 之后注册的 handler，只在启动时注册等于没注册。
// 重复 setActionHandler 是幂等的，代价可以忽略。
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const on = (action, fn) => {
    // 不支持的 action 会抛 NotSupportedError，别让一个失败拖垮后面的注册
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {}
  };
  on('play', () => requestPlay());
  on('pause', () => userPause());
  on('seekbackward', (d) => seekBy(-((d && d.seekOffset) || BACK_SEC)));
  on('seekforward', (d) => seekBy((d && d.seekOffset) || FWD_SEC));
  // iOS 的锁屏进度条只认 seekto；没有它，拖动进度条完全没反应
  on('seekto', (d) => {
    if (d && isFinite(d.seekTime)) seekTo(d.seekTime);
  });
}

// 播放器用 absolute 压在列表上（见 style.css 的 .player），列表底部要留出它的高度，
// 否则最后一条会被盖住。倍速编辑面板展开/收起会改高度，用 ResizeObserver 跟着量。
function syncPlayerInset() {
  const p = $('player');
  document.documentElement.style.setProperty('--player-h', (p.hidden ? 0 : p.offsetHeight) + 'px');
}
if (window.ResizeObserver) new ResizeObserver(syncPlayerInset).observe($('player'));

// 顶栏 + 工具栏合并成的 .bars 还是 fixed 浮层，列表顶部同样要让出它的高度。
// 这里只量顶栏自身的高度：状态栏安全区那截由 .list 用 env() 自己补（见 style.css），
// 因为 iOS 启动瞬间 env(safe-area-inset-top) 可能还没生效，跟着一起量会少一截，
// 第一行就会钻到顶栏底下。
function syncBarsInset() {
  const b = $('bars');
  const pad = b ? parseFloat(getComputedStyle(b).paddingTop) || 0 : 0;
  document.documentElement.style.setProperty('--top-h', (b ? b.offsetHeight - pad : 0) + 'px');
}
if (window.ResizeObserver) new ResizeObserver(syncBarsInset).observe($('bars'));
syncBarsInset();   // 首次量一遍，别等 ResizeObserver 的异步回调

// 播放器封面是常驻元素，换集会反复改 src，所以错误回退得一直挂着。
// feed 里给的封面地址可能根本不存在（本地 TTS 的 /tts/cover.jpg 就是），
// 加载失败就退回 PWA 图标，别让播放器左上角空一块。
const plImg = $('plImg');
plImg.addEventListener('error', () => {
  if (plImg.src !== COVER_FALLBACK) plImg.src = COVER_FALLBACK;
});

// 把播放器界面摆到某一集（音源由调用方负责）
function showPlayer(it) {
  $('player').hidden = false;
  syncPlayerInset();
  $('plTitle').textContent = it.e.t;
  $('plSub').textContent = it.f.title + '  ' + fmtDate(it.e.p);
  plImg.src = thumbUrl(it.e.i) || COVER_FALLBACK;
  updateTimes();
  updateSeekBar();
  updateMediaSession(it);
  render();
}

function play(it) {
  const same = !!(current && current.id === it.id);
  // 点当前正在播的这一条不当作暂停：列表点两下很容易误触，
  // 暂停请用播放器上的按钮。
  if (same && wantPlay) { requestPlay(); return; }

  cancelResume();                          // 用户自己操作了，撤掉待执行的自动重试
  clearPlayWatchdog();                     // 上一次尝试的兜底定时器作废
  audio.pause();                           // 换源前先 pause：iOS 只有自然 ended 才关 session
  audio.loop = true;
  needReload = false;
  lastTime = 0;
  manualSeekAt = 0;
  seekNearEnd = false;
  wrapping = false;
  // 这里设了 src 就标记一下：requestPlay() 在同一个手势里会直接 play()，
  // 不再重复走一遍"清空 src 再重设"的冷启动兜底。
  sourceFresh = false;
  if (same) {
    // 同一个单集接着播，不重载、不跳位置（恢复出来的断点还在 pendingSeek 里）。
    // 元素被系统清过 src / 停在错误状态时，先把源接回去。
    if (!audio.getAttribute('src') || audio.error) {
      audio.src = toLocal(it.e.u);
      audio.load();
      sourceFresh = true;
    }
  } else {
    stallRetry = 0;                        // 换集：重试计数从头算
    stallFrom = 0;
    const pr = progress[it.id];
    pendingSeek = pr && !isFinished(pr) && pr.p > 5 ? pr.p : 0; // 断点续播
    audio.src = toLocal(it.e.u);
    audio.load();
    sourceFresh = true;
  }
  current = it;
  audio.playbackRate = settings.speed;
  writeLS(LS_CURRENT, { id: it.id });       // iOS 后台被回收后靠它把播放器摆回来

  showPlayer(it);
  requestPlay();
}

// 快速切集 / 暂停会把上一次 play() 的 promise 以 AbortError 打断，这是正常现象，
// 报了反而像出错。真正的失败（格式不支持、源 404）才提示。
function onPlayError(err) {
  if (err && err.name === 'AbortError') return;
  clearPlayWatchdog();
  // 没真正开始播，就把意图清掉，否则按钮会卡在"暂停"、下一次点击又被当成暂停
  wantPlay = false;
  // 已经排了重试就别覆盖 —— error 事件给出的提示（还能重试几次）比这句有用
  if (stallTimer) return;
  if (err && err.name === 'NotAllowedError') {
    setStatus('点播放继续');
    return;
  }
  setStatus('播放失败：' + ((err && err.message) || err));
}

// 播完自动接当前列表里的下一条：全订阅视图按时间继续往下，筛了单个源就是同节目接续
function nextEpisode() {
  if (!current) return null;
  const desc = settings.sortDesc;
  const curP = current.e.p;
  let best = null;
  for (const f of feeds) {
    if (settings.feed && settings.feed !== f.id) continue;
    for (const e of f.episodes) {
      // “下一条”＝列表顺序上排在当前这条之后的（按 pubDate 判定，不依赖数组下标，
      // 这样当前这条因为完播被隐藏了也照样能定位）
      if (desc ? e.p >= curP : e.p <= curP) continue;
      const id = epId(f.id, e);
      if (isFinished(progress[id])) continue;
      if (!best || (desc ? e.p > best.e.p : e.p < best.e.p)) {
        const pr = progress[id] || null;
        best = {
          id: id, e: e, f: f, pr: pr, fin: false,
          pct: pr && pr.d > 0 ? Math.min(100, (pr.p / pr.d) * 100) : 0,
        };
      }
    }
  }
  return best;
}

// 只改播放速率和界面（同步合并回来时用，不刷新 settingsAt）
function applySpeed(v) {
  settings.speed = v;
  audio.playbackRate = v;
  $('plSpeed').textContent = v + '×';
  for (const b of $('speedMenu').children) {
    if (b.dataset.v == null) continue;       // 「编辑…」没有倍速值
    const on = Number(b.dataset.v) === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

// 倍速属于同步设置：改一次就记一个逻辑版本，别的设备按"动作先后"跟进，
// 不看墙上时钟（设备时钟差得多也不会误判谁更新）
function bumpSettings() {
  settingsAt = Date.now();
  settingsV = nextVersion();
  writeLS(LS_SETTINGS_AT, settingsAt);
  writeLS(LS_SETTINGS_V, settingsV);
}

function setSpeed(v) {
  applySpeed(v);
  saveSettings();
  bumpSettings();
  schedulePush(1200);
}

// 预设表改版：老数据（包括历史上手改过的列表）一次性换成新默认表，
// 并记一次设置变更让别的设备也跟随；之后再编辑就尊重用户自己的列表。
function applySpeedPresetRev() {
  if ((Number(settings.speedsRev) || 1) >= SPEEDS_REV) return;
  settings.speedsRev = SPEEDS_REV;
  settings.speeds = DEFAULT_SPEEDS.slice();
  if (settings.speeds.indexOf(settings.speed) < 0) settings.speed = DEFAULT_SPEED;
  saveSettings();
  bumpSettings();
  applySpeed(settings.speed);
  renderSpeedMenu();
  schedulePush(1500);
}

// 点倍速数字弹出的预设菜单（在按钮上方），末尾一项进入预设编辑
function renderSpeedMenu() {
  const menu = $('speedMenu');
  menu.innerHTML = '';
  for (const v of settings.speeds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.dataset.v = String(v);
    b.setAttribute('role', 'menuitemradio');
    b.textContent = v + '×';
    const on = v === settings.speed;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.addEventListener('click', () => {
      setSpeed(v);
      closeSpeedMenu();
    });
    menu.appendChild(b);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'menu-item speed-add';
  add.setAttribute('role', 'menuitem');
  add.textContent = '编辑…';
  add.addEventListener('click', () => {
    closeSpeedMenu();
    openSpeedEdit();
  });
  menu.appendChild(add);
}

function closeSpeedMenu() {
  const menu = $('speedMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('plSpeed').setAttribute('aria-expanded', 'false');
}

function toggleSpeedMenu() {
  const menu = $('speedMenu');
  if (!menu.hidden) { closeSpeedMenu(); return; }
  closeFilterMenu();
  closeFeedMenu();                 // 三个浮层别同时开着
  menu.hidden = false;
  $('plSpeed').setAttribute('aria-expanded', 'true');
}

function closeFilterMenu() {
  const menu = $('filterMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('filterBtn').setAttribute('aria-expanded', 'false');
}

function toggleFilterMenu() {
  const menu = $('filterMenu');
  if (!menu.hidden) { closeFilterMenu(); return; }
  closeSpeedMenu();
  closeFeedMenu();
  menu.hidden = false;
  $('filterBtn').setAttribute('aria-expanded', 'true');
}

// 订阅源下拉：菜单内容由 syncFeedSelect() 按 feeds 生成
function closeFeedMenu() {
  const menu = $('feedMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('feedBtn').setAttribute('aria-expanded', 'false');
}

function toggleFeedMenu() {
  const menu = $('feedMenu');
  if (!menu.hidden) { closeFeedMenu(); return; }
  closeFilterMenu();
  closeSpeedMenu();
  menu.hidden = false;
  $('feedBtn').setAttribute('aria-expanded', 'true');
  // 订阅多到要滚时，把当前选中项带到可见处
  const on = menu.querySelector('.menu-item.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

function openSpeedEdit() {
  $('speedInput').value = settings.speeds.join(', ');
  $('speedErr').textContent = '';
  $('speedEdit').hidden = false;
  syncPlayerInset();
  $('speedInput').focus();
}
function closeSpeedEdit() {
  $('speedEdit').hidden = true;
  syncPlayerInset();
}

function parseSpeeds(text) {
  const parts = String(text).split(/[,，、;；\s]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const v = Number(p.replace(/[x×]/gi, ''));
    if (!isFinite(v) || v < 0.5 || v > 4) return { err: '「' + p + '」不在 0.5–4 范围内' };
    if (out.indexOf(v) < 0) out.push(v);
  }
  if (!out.length) return { err: '至少填一个倍速' };
  if (out.length > 12) return { err: '最多 12 个' };
  out.sort((a, b) => a - b);
  return { speeds: out };
}

function saveSpeedEdit() {
  const r = parseSpeeds($('speedInput').value);
  if (r.err) { $('speedErr').textContent = r.err; return; }
  settings.speeds = r.speeds;
  settings.speed = r.speeds.indexOf(settings.speed) >= 0 ? settings.speed : r.speeds[0];
  saveSettings();
  bumpSettings();
  applySpeed(settings.speed);
  renderSpeedMenu();
  closeSpeedEdit();
  schedulePush(1200);
}

/* ================= 主题（跟随系统 / 浅色 / 深色） ================= */
const mqLight = window.matchMedia('(prefers-color-scheme: light)');
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };

function applyTheme() {
  const t = settings.theme === 'auto' ? (mqLight.matches ? 'light' : 'dark') : settings.theme;
  document.documentElement.dataset.theme = t;
  $('themeIco').className = 'ico ico-' + settings.theme;
  const btn = $('theme');
  btn.title = '主题：' + THEME_LABEL[settings.theme] + '（点击切换）';
  btn.setAttribute('aria-label', btn.title);
  // 浏览器/系统状态栏颜色跟着走：用顶栏的 --panel 色（不是页面底色），
  // iOS 15+ / 安卓都靠 theme-color 给状态栏上色
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#171a21');
}

/* ================= 交互绑定 ================= */
$('refresh').addEventListener('click', () => refresh(true));

$('plPlay').addEventListener('click', () => {
  // 用"是否真的在响"而不是 wantPlay：iOS 上元素可能 play() 过却静音停住，
  // 这时点按钮应该重新拉起来，而不是再执行一次暂停。
  if (isActuallyPlaying()) userPause();
  else requestPlay();
});
$('plBack').addEventListener('click', () => seekBy(-BACK_SEC));
$('plFwd').addEventListener('click', () => seekBy(FWD_SEC));
$('plClose').addEventListener('click', () => {
  wantPlay = false;
  clearPlayWatchdog();
  cancelResume();
  closeSpeedMenu();
  closeSpeedEdit();
  saveProgress(true);
  audio.pause();
  pendingSeek = null;
  playedThisPage = false;          // 下次再播还是按冷启动处理
  sourceFresh = false;
  try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
  writeLS(LS_CURRENT, null);       // 主动关掉播放器：下次启动不用再摆回来
  current = null;
  $('player').hidden = true;
  syncPlayerInset();
  render();
});

// 点播放器顶部（封面/标题）回到列表里正在播的那一集；关闭按钮有自己的行为
document.querySelector('.pl-top').addEventListener('click', (ev) => {
  if (ev.target.closest('button')) return;
  jumpToPlaying();
});

const seek = $('plSeek');
seek.addEventListener('input', () => {
  seeking = true;
  // 拖动时 value 先动、timeupdate 还没到：涂色跟着手指走，别等音频
  setSeekFill(Number(seek.value) / 10);
});
seek.addEventListener('change', () => {
  const d = displayDuration();
  if (d > 0) seekTo((Number(seek.value) / 1000) * d);
  seeking = false;
  startSeekTicker();          // 拖动期间 rAF 停了，松手后接着平滑推进
});

// 点速度数字弹出预设菜单；点页面别处收起
$('plSpeed').addEventListener('click', toggleSpeedMenu);
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.speed-wrap')) closeSpeedMenu();
  if (!ev.target.closest('.filter-wrap')) closeFilterMenu();
  if (!ev.target.closest('.feed-wrap')) closeFeedMenu();
});

$('theme').addEventListener('click', () => {
  settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
  saveSettings();          // 主题是各设备自己的偏好，不进同步
  applyTheme();
});
mqLight.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });

$('speedSave').addEventListener('click', saveSpeedEdit);
$('speedCancel').addEventListener('click', closeSpeedEdit);
$('speedInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); saveSpeedEdit(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeSpeedEdit(); }
});

$('feedBtn').addEventListener('click', toggleFeedMenu);

// 筛选下拉：里面还是原来那三个按钮，点「筛选」才展开
$('filterBtn').addEventListener('click', toggleFilterMenu);

$('sortBtn').addEventListener('click', () => {
  settings.sortDesc = !settings.sortDesc;
  saveSettings();
  syncToolbar();
  render();
});

$('hideBtn').addEventListener('click', () => {
  settings.hideFinished = !settings.hideFinished;
  saveSettings();
  syncToolbar();
  render();
});

$('doneBtn').addEventListener('click', () => {
  settings.doneView = !settings.doneView;
  saveSettings();
  syncToolbar();
  render();
});

// 切后台/关页面：落盘 + 推一次云端；回到前台先补一下播放（系统可能在后台
// 掐掉或中断过），再顺手拉一次别的设备的新数据。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    saveProgress(true);
    updatePositionState();
  } else {
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    onForeground(away);
    if (Date.now() - lastPull > PULL_EVERY) syncPull();
  }
});
// iOS 的 PWA 从后台回来不一定触发 visibilitychange（页面可能整个被还原/进 bfcache），
// 这两条一起兜住。系统也可能在后台丢掉 MediaSession 的 handler，一并补注册。
function onForeground(awayMs) {
  if (wantPlay) armAudioSession();
  if (current) updateMediaSession(current);  // 后台可能把锁屏信息也丢了
  syncPlaybackState();
  setupMediaSession();
  resumeIfNeeded(awayMs);
  // 从后台回来时状态栏安全区可能变过（通话、热点），顺手重量一下
  syncBarsInset();
}
window.addEventListener('pageshow', (ev) => {
  // bfcache 恢复出来的页面，媒体元素状态和冷启动一样不可信，按第一次播放处理
  if (ev.persisted) { playedThisPage = false; hiddenAt = 0; }
  onForeground(0);
});
window.addEventListener('focus', () => onForeground(0));
window.addEventListener('pagehide', () => saveProgress(true));

setupMediaSession();

// iOS 不认 viewport 里的 user-scalable=no / maximum-scale=1，双指缩放只能自己拦。
// 本页面没有需要缩放的内容，直接掐掉 WebKit 的 gesture 事件。
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

function syncToolbar() {
  $('sortBtn').textContent = settings.sortDesc ? '↓ 最新在前' : '↑ 最早在前';
  $('hideBtn').classList.toggle('on', settings.hideFinished);
  $('hideBtn').setAttribute('aria-checked', String(settings.hideFinished));
  $('doneBtn').classList.toggle('on', !!settings.doneView);
  $('doneBtn').setAttribute('aria-checked', String(!!settings.doneView));
  // 完播视图自带固定排序、也只看完播过的，那两个开关在这个视图里没意义，先收起来
  $('sortBtn').hidden = !!settings.doneView;
  $('hideBtn').hidden = !!settings.doneView;
  // 有非默认状态时给「筛选」加个高亮，收起后也能看出列表被筛过
  const custom = !!settings.doneView || !settings.sortDesc || !settings.hideFinished;
  $('filterBtn').classList.toggle('on', custom);
}

function syncFeedSelect() {
  if (settings.feed && !feeds.some((f) => f.id === settings.feed)) settings.feed = '';
  const menu = $('feedMenu');
  menu.innerHTML = '';

  const addItem = (id, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.dataset.feed = id;
    b.setAttribute('role', 'menuitemradio');
    const on = id === settings.feed;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.textContent = title;
    b.addEventListener('click', () => {
      settings.feed = id;
      saveSettings();
      closeFeedMenu();
      syncFeedSelect();      // 刷新按钮上的当前项和菜单里的选中态
      render();
    });
    menu.appendChild(b);
  };

  addItem('', '全部订阅');
  for (const f of feeds) addItem(f.id, f.title);

  // 按钮上显示当前订阅源，名字长了靠 .feed-label 省略
  const cur = feeds.find((f) => f.id === settings.feed);
  const label = cur ? cur.title : '全部订阅';
  $('feedLabel').textContent = label;
  $('feedBtn').setAttribute('aria-label', '选择订阅源，当前：' + label);
}

// iOS 后台常把整个 PWA 回收掉，重开时内存里的 current 已经没了。
// 按上次记住的单集把播放器摆回来（不自动播放，位置从进度里带出），
// 用户点一下就能接着听。
function restorePlayer() {
  const saved = readLS(LS_CURRENT, null);
  if (!saved || !saved.id || current) return;
  let hit = null;
  for (const f of feeds) {
    for (const e of f.episodes) {
      if (epId(f.id, e) === saved.id) { hit = { id: saved.id, e: e, f: f }; break; }
    }
    if (hit) break;
  }
  if (!hit) return;
  current = hit;
  const pr = progress[hit.id];
  pendingSeek = pr && !isFinished(pr) && pr.p > 0 ? pr.p : null;
  // 这里不要设置 src / load()。iOS 26 的 PWA 重开后，先给 <audio> 装源、
  // 之后再 play() 会卡成"play() resolve 但完全没声音"（WebKit bug 295518）；
  // 音源留到用户点播放、在同一个手势里再设（见 requestPlay / play）。
  // 界面上的进度用 pendingSeek 显示，不需要元数据也能摆对。
  wantPlay = false;
  playedThisPage = false;
  sourceFresh = false;
  showPlayer(hit);
}

/* ================= 启动 ================= */
async function boot() {
  applySpeedPresetRev();   // 预设表改版要赶在第一次渲染/同步之前
  applyTheme();
  renderSpeedMenu();
  applySpeed(settings.speed);
  syncToolbar();

  // 先用缓存渲染，秒开；再去后台对账
  const cachedIndex = readLS(LS_INDEX, null);
  if (cachedIndex && cachedIndex.feeds && cachedIndex.feeds.length) {
    backendOrigin = cachedIndex.backendOrigin || null;
    feeds = cachedIndex.feeds.map((f) => Object.assign({}, f, { episodes: [], fetchedAt: 0 }));
    const cached = new Map((await dbGetAll()).map((r) => [r.id, r]));
    for (const f of feeds) {
      const c = cached.get(f.id);
      if (c) {
        f.episodes = c.episodes || [];
        f.fetchedAt = c.fetchedAt || 0;
        f.lastModified = c.lastModified || '';
      }
    }
    syncFeedSelect();
    render();
    syncPull();               // 与刷新 feed 并行；拉到新数据会自己重绘
    await refresh(false);
  } else {
    await refresh(true);
    syncPull();
  }
  syncFeedSelect();
  restorePlayer();

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMore();
  }, { root: $('list'), rootMargin: '600px' }).observe(sentinel);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
