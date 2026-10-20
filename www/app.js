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
const DEFAULT_SPEEDS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const THEMES = ['auto', 'light', 'dark'];
const BACK_SEC = 10;                // 后退秒数，与 icons/replay_10.svg 上的数字一致
const FWD_SEC = 30;                 // 前进秒数，与 icons/forward_30.svg 上的数字一致
const PUSH_EVERY = 20 * 1000;       // 播放中最多这么久推进一次云端
const PULL_EVERY = 60 * 1000;       // 回到前台时，距上次拉取超过这么久才再拉
const LS_INDEX = 'podcast.index';
const LS_SETTINGS = 'podcast.settings';
const LS_PROGRESS = 'podcast.progress';
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
  { hideFinished: true, sortDesc: true, feed: '', speed: 1, speeds: null, theme: 'auto', doneView: false },
  readLS(LS_SETTINGS, {})
);
// 兜住历史数据 / 手改坏的值
if (!Array.isArray(settings.speeds) || !settings.speeds.length) settings.speeds = DEFAULT_SPEEDS.slice();
if (THEMES.indexOf(settings.theme) < 0) settings.theme = 'auto';
if (!(settings.speed > 0)) settings.speed = 1;

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
    settings: { speed: settings.speed, speeds: settings.speeds },
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
    if (Array.isArray(best.settings.speeds) && best.settings.speeds.length) {
      settings.speeds = best.settings.speeds;
    }
    saveSettings();
    applySpeed(settings.speed);
    renderSpeedRow();
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
function setStatus(s) { $('status').textContent = s || ''; }

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
          f.episodes = parseFeed(await res.text());
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
    });

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
  meta.textContent = it.f.title + ' · '
    + (settings.doneView ? '完播于 ' + fmtDate(it.c) : fmtDate(it.e.p))
    + (it.e.d ? ' · ' + fmtDur(it.e.d) : '');

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
const audio = new Audio();
audio.preload = 'metadata';
audio.preservesPitch = true;
if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;

let pendingSeek = null;
let seeking = false;
let stallTimer = 0;
let stallRetry = 0;
let stallFrom = 0;

const STALL_RETRY_MAX = 3;
const STALL_WAIT_MS = 5000;          // 第 n 次重试等 n*5 秒

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

// 断流不跳集，改成从断点重试拉流（退避重试，最多 3 次）
function scheduleResume(reason) {
  if (!current || stallTimer) return;
  const id = current.id;
  if (stallRetry >= STALL_RETRY_MAX) {
    setStatus(reason + '，重试 ' + STALL_RETRY_MAX + ' 次仍未恢复，点播放可继续');
    return;
  }
  stallRetry++;
  const wait = STALL_WAIT_MS * stallRetry;
  setStatus(reason + '，' + Math.round(wait / 1000) + ' 秒后从断点重试（'
            + stallRetry + '/' + STALL_RETRY_MAX + '）');
  stallTimer = setTimeout(() => {
    stallTimer = 0;
    if (!current || current.id !== id) return;   // 已经换集或关掉了
    // 判断"是不是已经自己在放了"不能用 !audio.paused：加载失败的媒体元素会停在
    // paused=false（play() 请求过、但资源选择就失败了），拿它当判据会把重试永远挡掉。
    // 真正在放的特征是 readyState >= HAVE_CURRENT_DATA 且没有 error。
    if (!audio.paused && !audio.error && audio.readyState >= 2) return;
    stallFrom = (progress[id] && progress[id].p) || 0;
    pendingSeek = stallFrom;
    audio.src = toLocal(current.e.u);            // 重新走一遍资源选择，错误状态会被清掉
    audio.load();
    audio.playbackRate = settings.speed;
    audio.play().catch(onPlayError);
  }, wait);
}

audio.addEventListener('loadedmetadata', () => {
  audio.playbackRate = settings.speed;
  if (pendingSeek != null) {
    try { audio.currentTime = pendingSeek; } catch (_) {}
    pendingSeek = null;
  }
  if (current) {
    const d = displayDuration();
    if (d > 0) {
      touchProgress(current.id, { d: d });
      saveProgress(true);
    }
  }
  updateTimes();
});

audio.addEventListener('timeupdate', () => {
  if (!current || !audio.duration) return;
  const d = displayDuration();
  if (!d) return;
  if (!seeking) $('plSeek').value = String(Math.round((audio.currentTime / d) * 1000));
  updateTimes();

  touchProgress(current.id, { p: audio.currentTime, d: d });
  // 时长可信时才判断完播：断流造成的假 ended 不能落成完播记录。
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

  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(audio.currentTime, d),
        playbackRate: audio.playbackRate,
      });
    } catch (_) {}
  }
});

function syncPlaybackState() {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}
function setPlayIcon(playing) {
  $('plIcon').className = 'ico ' + (playing ? 'ico-pause' : 'ico-play');
  $('plPlay').setAttribute('aria-label', playing ? '暂停' : '播放');
}
audio.addEventListener('play', () => {
  setPlayIcon(true);
  syncPlaybackState();
});
audio.addEventListener('playing', () => {
  cancelResume();                  // 自己缓冲好了，不用再重试
  const st = $('status').textContent;
  if (st.slice(0, 4) === '播放失败' || st.indexOf('重试') >= 0) setStatus('');
});
audio.addEventListener('pause', () => {
  setPlayIcon(false);
  saveProgress(true);
  syncPlaybackState();
});
audio.addEventListener('ended', () => {
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
  const next = nextEpisode();
  if (next) play(next);
  else setStatus('列表里没有可接着播的单集了');
});
audio.addEventListener('error', () => {
  if (!current || !audio.getAttribute('src')) return;
  // 加载失败同样不跳集，交给重试
  scheduleResume('音频加载失败（code ' + (audio.error ? audio.error.code : '?') + '）');
});

function updateTimes() {
  // 用 displayDuration()：媒体时长被截断/读不出来时退回 feed 声明的时长，
  // 免得时间轴显示成 "0:12 / 0:12" 这种假的总长
  $('plTime').textContent = fmtDur(audio.currentTime || 0) + ' / ' + fmtDur(displayDuration());
}

function updateMediaSession(it) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const art = [];
  // 用缩略图：MediaMetadata 的图走 CORS 拉取，同源的缩略图一定能过，
  // 而且不用为了锁屏去拉一张上百 KB 的原图
  const img = thumbUrl(it.e.i);
  if (img) art.push({ src: img, sizes: '200x200' });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: it.e.t, artist: it.f.title, album: '播客', artwork: art,
  });
  if (navigator.mediaSession.setActionHandler) {
    const seekBy = (s) => { try { audio.currentTime = Math.max(0, audio.currentTime + s); } catch (_) {} };
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-BACK_SEC));
    navigator.mediaSession.setActionHandler('seekforward', () => seekBy(FWD_SEC));
  }
}

function play(it) {
  const same = !!(current && current.id === it.id);
  if (same && !audio.paused) { audio.pause(); return; }

  cancelResume();                          // 用户自己操作了，撤掉待执行的自动重试
  if (same) {
    pendingSeek = null;                    // 同一个单集，接着播，别跳
  } else {
    stallRetry = 0;                        // 换集：重试计数从头算
    stallFrom = 0;
    const pr = progress[it.id];
    pendingSeek = pr && !isFinished(pr) && pr.p > 5 ? pr.p : 0; // 断点续播
    audio.src = toLocal(it.e.u);
    audio.load();
  }
  current = it;
  audio.playbackRate = settings.speed;

  $('player').hidden = false;
  $('plTitle').textContent = it.e.t;
  $('plSub').textContent = it.f.title + ' · ' + fmtDate(it.e.p);
  $('plImg').src = thumbUrl(it.e.i);
  $('plSeek').value = '0';
  updateTimes();
  updateMediaSession(it);
  render();

  audio.play().catch(onPlayError);
}

// 快速切集 / 暂停会把上一次 play() 的 promise 以 AbortError 打断，这是正常现象，
// 报了反而像出错。真正的失败（格式不支持、源 404）才提示。
function onPlayError(err) {
  if (err && err.name === 'AbortError') return;
  // 已经排了重试就别覆盖 —— error 事件给出的提示（还能重试几次）比这句有用
  if (stallTimer) return;
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
  for (const b of $('speedRow').children) b.classList.toggle('on', Number(b.dataset.v) === v);
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

function renderSpeedRow() {
  const row = $('speedRow');
  row.innerHTML = '';
  for (const v of settings.speeds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = String(v);
    b.textContent = v + '×';
    b.classList.toggle('on', v === settings.speed);
    b.addEventListener('click', () => setSpeed(v));
    row.appendChild(b);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'speed-add';
  add.title = '编辑倍速预设';
  add.setAttribute('aria-label', '编辑倍速预设');
  const ico = document.createElement('span');
  ico.className = 'ico ico-add';
  add.appendChild(ico);
  add.addEventListener('click', () => {
    if ($('speedEdit').hidden) openSpeedEdit();
    else closeSpeedEdit();
  });
  row.appendChild(add);
}

function openSpeedEdit() {
  $('speedInput').value = settings.speeds.join(', ');
  $('speedErr').textContent = '';
  $('speedEdit').hidden = false;
  $('speedInput').focus();
}
function closeSpeedEdit() {
  $('speedEdit').hidden = true;
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
  renderSpeedRow();
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
  // 浏览器/系统状态栏颜色跟着走
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#0f1115');
}

/* ================= 交互绑定 ================= */
$('refresh').addEventListener('click', () => refresh(true));

$('plPlay').addEventListener('click', () => {
  cancelResume();
  if (audio.paused) audio.play().catch(onPlayError);
  else audio.pause();
});
$('plBack').addEventListener('click', () => {
  try { audio.currentTime = Math.max(0, audio.currentTime - BACK_SEC); } catch (_) {}
});
$('plFwd').addEventListener('click', () => {
  try { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + FWD_SEC); } catch (_) {}
});
$('plClose').addEventListener('click', () => {
  saveProgress(true);
  audio.pause();
  try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
  current = null;
  $('player').hidden = true;
  render();
});

const seek = $('plSeek');
seek.addEventListener('input', () => { seeking = true; });
seek.addEventListener('change', () => {
  const d = displayDuration();
  if (d > 0) {
    try { audio.currentTime = (Number(seek.value) / 1000) * d; } catch (_) {}
  }
  seeking = false;
  cancelResume();                  // 用户自己定位了，撤掉待执行的自动重试
  saveProgress(true);
});

$('plSpeed').addEventListener('click', () => {
  const row = $('speedRow');
  row.hidden = !row.hidden;
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

$('feedSel').addEventListener('change', (e) => {
  settings.feed = e.target.value;
  saveSettings();
  render();
});

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

// 切后台/关页面：落盘 + 推一次云端；回到前台顺手拉一次别的设备的新数据
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveProgress(true);
  } else if (Date.now() - lastPull > PULL_EVERY) {
    syncPull();
  }
});
window.addEventListener('pagehide', () => saveProgress(true));

function syncToolbar() {
  $('sortBtn').textContent = settings.sortDesc ? '↓ 最新在前' : '↑ 最早在前';
  $('hideBtn').classList.toggle('on', settings.hideFinished);
  $('hideBtn').setAttribute('aria-checked', String(settings.hideFinished));
  $('doneBtn').classList.toggle('on', !!settings.doneView);
  $('doneBtn').setAttribute('aria-checked', String(!!settings.doneView));
  // 完播视图自带固定排序、且本来就只看已完播的那两个开关在这个视图里没意义，先收起来
  $('sortBtn').hidden = !!settings.doneView;
  $('hideBtn').hidden = !!settings.doneView;
}

function syncFeedSelect() {
  const sel = $('feedSel');
  if (settings.feed && !feeds.some((f) => f.id === settings.feed)) settings.feed = '';
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部订阅（' + feeds.length + '）';
  sel.appendChild(all);
  for (const f of feeds) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.title;
    sel.appendChild(o);
  }
  sel.value = settings.feed;
}

/* ================= 启动 ================= */
async function boot() {
  applyTheme();
  renderSpeedRow();
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

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMore();
  }, { root: $('list'), rootMargin: '600px' }).observe(sentinel);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
