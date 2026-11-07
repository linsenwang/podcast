#!/usr/bin/env python3
"""服务端把 40+ 个 RSS 解析成一份精简的条目包，客户端刷新时一次拿完。

为什么要这个服务（而不是继续让前端逐个拉 XML）：
  1. 现在 42 个 podsync 源加本地 TTS，原始 XML 一共 10.6 MiB、2200 多集，
     手机上走 Tailscale 经常要十几秒；条目只保留客户端真正用到的字段
     （g/t/p/u/d/i），gzip 后约 220 KiB，小了将近 10 倍。
  2. 43 个请求变成 1 个，省掉几十次往返；网络差时往返本身就占大头。
  3. podsync 每次重写 XML 都会改 lastBuildDate/mtime，客户端用
     If-Modified-Since 判断不出"其实没有新单集"，只好整包重下。
     这里按真正下发的字段算 ETag，没变化时直接回 304。

只监听宿主回环 127.0.0.1:8102，由 podcast(nginx) 的 /api/feeds.json 反代进来。
所有 RSS 都经 nginx 取（/feeds/、/ext/、/tts/），这样外部源和 TTS 的地址
改写规则与原来前端看到的完全一致，不用在这里重复实现一遍。

接口：
  GET /api/feeds.json[?refresh=1]
      200 application/json（客户端支持 gzip 时带 Content-Encoding: gzip）
          {"v":1,"feeds":[{"id","title","episodes":[{"g","t","p","u","d","i"}]}]}
      304  If-None-Match 与当前包一致
      503  还没有任何可用的包（第一次启动就连不上 nginx/podsync）
  GET /healthz -> 200 纯文本
"""

import gzip
import hashlib
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 监听地址、回源地址、缓存目录都可以用环境变量覆盖，默认值对应 docker-compose.yml。
LISTEN = os.environ.get('LISTEN', '127.0.0.1:8102')
ORIGIN = os.environ.get('ORIGIN', 'http://127.0.0.1:8100').rstrip('/')
CACHE_DIR = os.environ.get('CACHE_DIR', '/app/cache')
CACHE_FILE = os.path.join(CACHE_DIR, 'bundle.json')

TTL = float(os.environ.get('TTL', '300'))       # 包最多缓存这么久，过期再回源
FETCH_TIMEOUT = float(os.environ.get('FETCH_TIMEOUT', '8'))
FETCH_POOL = int(os.environ.get('FETCH_POOL', '8'))
UA = 'podcast-feeds/1.0'

LOG = logging.getLogger('feeds')


# ================= XML 小工具 =================

def _local(tag):
    """去掉 ElementTree 的 {namespace} 前缀，只看标签名。"""
    return tag.rsplit('}', 1)[-1]


def _child(elem, name):
    for c in elem:
        if _local(c.tag) == name:
            return c
    return None


def _child_text(elem, name):
    c = _child(elem, name)
    return (c.text or '').strip() if c is not None else ''


def _parse_dur(s):
    """纯数字按秒，冒号格式按 时:分:秒（沿用旧前端的解析规则）。"""
    if not s:
        return 0
    s = s.strip()
    if re.fullmatch(r'\d+(\.\d+)?', s):
        return round(float(s))
    total = 0.0
    for part in s.split(':'):
        try:
            total = total * 60 + float(part)
        except ValueError:
            return 0
    return round(total)


def _parse_date(s):
    """RSS 的 RFC 2822 为主，顺手兼容 Atom 的 ISO 8601；失败按 0 处理。"""
    if not s:
        return 0
    s = s.strip()
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError, OverflowError):
        try:
            dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
        except ValueError:
            return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        return int(dt.timestamp() * 1000)
    except (OverflowError, OSError, ValueError):
        return 0


# ================= 拉取与解析 =================

def http_get(path):
    req = urllib.request.Request(ORIGIN + path, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        return resp.read()


def _source_url(src):
    if src['kind'] == 'podsync':
        path = src['path']
        # OPML 里的 xmlUrl 一般指 podsync 根路径；万一以后改成同源 /feeds/ 前缀，
        # 别拼成 /feeds/feeds/...
        if not path.startswith('/'):
            path = '/' + path
        return path if path.startswith('/feeds/') else '/feeds' + path
    if src['kind'] == 'tts':
        return '/tts/feed.xml'
    return '/ext/' + src['id'] + '/rss'


def discover_sources():
    """列出所有订阅源。podsync 的 OPML 拿不到就直接失败，保留上一次的包。"""
    sources = []
    seen = set()

    try:
        root = ET.fromstring(http_get('/feeds/podsync.opml'))
    except Exception as exc:
        raise RuntimeError('读取 podsync.opml 失败: %s' % exc)
    for node in root.iter():
        if _local(node.tag) != 'outline':
            continue
        xml_url = (node.get('xmlUrl') or '').strip()
        if not xml_url:
            continue
        path = urllib.parse.urlsplit(xml_url).path
        if not path:
            continue
        fid = path.rsplit('/', 1)[-1]
        if fid.lower().endswith('.xml'):
            fid = fid[:-4]
        if not fid or fid in seen:
            continue
        seen.add(fid)
        title = (node.get('title') or node.get('text') or fid).strip()
        sources.append({'id': fid, 'title': title, 'kind': 'podsync', 'path': path})

    if not any(src['kind'] == 'podsync' for src in sources):
        # 空 OPML 通常说明 podsync 刚重启/还没准备好，别把整包订阅清空
        raise RuntimeError('podsync.opml 里没有订阅')

    # 本地 TTS：不在 podsync 的 OPML 里，固定补一条（和原前端一致）。
    if 'tts' not in seen:
        seen.add('tts')
        sources.append({'id': 'tts', 'title': '本地 TTS', 'kind': 'tts'})

    # 外部订阅补充列表：podsync 处理不了的源才在这里，路径由 nginx 的 /ext/ 反代。
    try:
        text = http_get('/external-feeds.tsv').decode('utf-8', 'replace')
        for raw in text.splitlines():
            line = raw.rstrip('\r')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            cols = line.split('\t')
            fid = (cols[0] or '').strip()
            if not re.fullmatch(r'[a-z0-9_-]+', fid) or fid in seen:
                continue
            title = (cols[1] or '').strip() if len(cols) > 1 else ''
            seen.add(fid)
            sources.append({'id': fid, 'title': title or fid, 'kind': 'ext'})
    except Exception as exc:
        LOG.warning('读取 external-feeds.tsv 失败，外部源本次跳过: %s', exc)

    return sources


def _rewrite_url(url, fid, kind):
    """把 podsync 的绝对地址换成同源相对路径，播放时才能避开混合内容。

    enclosure 是写死的 http://100.97.117.78:8000/<id>/x.mp3，HTTPS 页面直接
    拿来播放会被浏览器拦掉；变成 feeds/<id>/x.mp3 后由 nginx 的 /feeds/ 反代。
    只认 /<id>/ 这个路径前缀，不依赖 podsync 具体监听在哪个 IP。
    """
    if not url or kind != 'podsync':
        return url
    parts = urllib.parse.urlsplit(url)
    if not parts.path.startswith('/' + fid + '/'):
        return url
    out = 'feeds' + parts.path
    return out + ('?' + parts.query if parts.query else '')


def parse_feed(data, fid, kind):
    root = ET.fromstring(data)
    channel = None
    for c in root:
        if _local(c.tag) == 'channel':
            channel = c
            break
    if channel is None:
        channel = root

    feed_img = ''
    for c in channel:
        if _local(c.tag) != 'image':
            continue
        href = (c.get('href') or '').strip()
        if href:
            feed_img = href
            break
        feed_img = _child_text(c, 'url') or feed_img
    feed_img = _rewrite_url(feed_img, fid, kind)

    out = []
    seen = set()
    for it in root.iter():
        if _local(it.tag) != 'item':
            continue
        enc = _child(it, 'enclosure')
        raw_url = (enc.get('url') or '').strip() if enc is not None else ''
        if not raw_url:
            continue

        # 没有 guid 的源用原始 enclosure 地址当身份，和旧前端保持一致，
        # 这样历史播放进度的 epId 不会因为地址被改写而失配。
        guid = _child_text(it, 'guid') or raw_url
        if guid in seen:
            continue
        seen.add(guid)

        ep_img = ''
        for c in it:
            if _local(c.tag) == 'image':
                href = (c.get('href') or '').strip()
                if href:
                    ep_img = href
                    break

        out.append({
            'g': guid,
            't': _child_text(it, 'title') or '(无标题)',
            'p': _parse_date(_child_text(it, 'pubDate') or _child_text(it, 'date')),
            'u': _rewrite_url(raw_url, fid, kind),
            'd': _parse_dur(_child_text(it, 'duration')),
            'i': _rewrite_url(ep_img, fid, kind) if ep_img else feed_img,
        })

    out.sort(key=lambda e: -e['p'])   # 单集按时间倒序，"播完接下一集"依赖这个
    return out


def fetch_source(src):
    """在线程池里跑：成功写 episodes，失败只记 err，由 refresh 决定是否用旧数据。"""
    try:
        data = http_get(_source_url(src))
        src['episodes'] = parse_feed(data, src['id'], src['kind'])
        src['err'] = ''
    except Exception as exc:
        src['episodes'] = None
        src['err'] = str((getattr(exc, 'reason', None) or exc))


# ================= 包的缓存与刷新 =================

class Store:
    def __init__(self):
        self.lock = threading.Lock()     # 刷新串行化；同时只有一个线程回源
        self.payload = None              # 未压缩 JSON
        self.gz = None
        self.etag = '"0"'
        self.at = 0                      # 包的生成时间（毫秒）
        self.last_good = {}              # feed id -> episodes，单源失败时兜底
        self._load_disk()

    def _load_disk(self):
        try:
            with open(CACHE_FILE, 'rb') as f:
                raw = f.read()
            data = json.loads(raw.decode('utf-8'))
            # 时间戳不放进下发的包（否则每次刷新 ETag 都会变，304 就失效了），
            # 启动时用文件 mtime 当 TTL 起点。
            self.at = int(os.path.getmtime(CACHE_FILE) * 1000)
            self.last_good = {
                f['id']: f.get('episodes') or [] for f in data.get('feeds') or []
                if isinstance(f, dict) and f.get('id')
            }
            self.payload = raw
            self.gz = gzip.compress(raw, 5)
            self.etag = '"%s"' % hashlib.sha1(raw).hexdigest()
            LOG.info('载入磁盘缓存 %s（%d 字节，%d 个源）',
                     CACHE_FILE, len(raw), len(self.last_good))
        except FileNotFoundError:
            pass
        except Exception as exc:
            LOG.warning('磁盘缓存不可用（%s），等首次回源: %s', CACHE_FILE, exc)

    def ensure(self, force):
        """返回 (payload, gz, etag) 或 None。调用方拿到的是一致的一组快照。"""
        with self.lock:
            fresh = self.payload is not None and time.time() * 1000 - self.at < TTL * 1000
            if force or not fresh:
                self._refresh()
            if self.payload is None:
                return None
            return self.payload, self.gz, self.etag

    def _refresh(self):
        try:
            sources = discover_sources()
        except Exception as exc:
            # 源列表都拿不到（nginx/podsync 没起来）时，继续发上一次的包
            LOG.warning('刷新失败，保留上一份包: %s', exc)
            return

        with ThreadPoolExecutor(max_workers=FETCH_POOL) as pool:
            list(pool.map(fetch_source, sources))

        feeds = []
        good = {}
        failed = 0
        total = 0
        for src in sources:
            episodes = src.get('episodes')
            err = src.get('err') or ''
            if episodes is None:
                failed += 1
                episodes = self.last_good.get(src['id'])
                if episodes is None:
                    episodes = []
                else:
                    LOG.info('保留 %s 上次的 %d 集', src['id'], len(episodes))
            if episodes:
                good[src['id']] = episodes
            entry = {'id': src['id'], 'title': src['title'], 'episodes': episodes}
            if err:
                entry['err'] = err
            feeds.append(entry)
            total += len(episodes)
        self.last_good = good

        at = int(time.time() * 1000)
        # 注意包里不放 at：客户端不需要，而且放进去会让每次刷新的 ETag 都变，
        # "没有新单集就回 304" 的优化就白做了。
        payload = json.dumps(
            {'v': 1, 'feeds': feeds},
            ensure_ascii=False, separators=(',', ':'),
        ).encode('utf-8')
        self.payload = payload
        self.gz = gzip.compress(payload, 5)
        self.etag = '"%s"' % hashlib.sha1(payload).hexdigest()
        self.at = at
        self._save_disk(payload)
        LOG.info('刷新完成：%d 个源 / %d 集 / %d 字节（gzip %d），失败 %d',
                 len(feeds), total, len(payload), len(self.gz), failed)

    def _save_disk(self, payload):
        tmp = '%s.%d.tmp' % (CACHE_FILE, threading.get_ident())
        try:
            with open(tmp, 'wb') as f:
                f.write(payload)
            os.replace(tmp, CACHE_FILE)
        except OSError as exc:
            LOG.warning('磁盘缓存写入失败 %s: %s', CACHE_FILE, exc)
            try:
                os.remove(tmp)
            except OSError:
                pass


STORE = None   # 在 main() 里配置好日志之后再加载磁盘缓存，否则载入日志会被吞掉


# ================= HTTP =================

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'   # 客户端只发一个请求，复用连接意义不大，但没坏处
    server_version = 'podcast-feeds'
    sys_version = ''

    def log_message(self, fmt, *args):
        pass    # 刷新结果在 Store 里打，不要 http.server 那套逐请求日志

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path == '/healthz':
            return self._send(200, b'ok\n', 'text/plain; charset=utf-8', 'no-store')
        if path not in ('/api/feeds.json', '/feeds.json'):
            return self._send(404, b'not found\n', 'text/plain; charset=utf-8', 'no-store')

        force = urllib.parse.parse_qs(query).get('refresh', ['0'])[0] not in ('', '0', 'false')
        snap = STORE.ensure(force)
        if snap is None:
            # 还没有任何可用的包：让前端保留 IndexedDB 里的旧数据，不要 200 空包
            return self._send(503, b'{"err":"feed source unavailable"}',
                              'application/json', 'no-store')

        raw, gz, etag = snap
        inm = [x.strip() for x in self.headers.get('If-None-Match', '').split(',') if x.strip()]
        if etag in inm:
            return self._send(304, b'', None, 'no-cache', etag=etag)

        if 'gzip' in self.headers.get('Accept-Encoding', '').lower():
            return self._send(200, gz, 'application/json', 'no-cache',
                              etag=etag, encoding='gzip')
        return self._send(200, raw, 'application/json', 'no-cache', etag=etag)

    def _send(self, status, body, ctype, cache_control, etag=None, encoding=None):
        try:
            self.send_response(status)
            if ctype:
                self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', cache_control)
            if etag:
                self.send_header('ETag', etag)
                # 同一份数据会按 Accept-Encoding 发 gzip 或原文，缓存要分开放
                self.send_header('Vary', 'Accept-Encoding')
            if encoding:
                self.send_header('Content-Encoding', encoding)
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 客户端提前断开（比如播放抢带宽时前端主动 abort），不算故障
            pass


def main():
    global STORE
    logging.basicConfig(
        stream=sys.stdout,
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
    )
    os.makedirs(CACHE_DIR, exist_ok=True)
    STORE = Store()
    host, _, port = LISTEN.rpartition(':')
    srv = ThreadingHTTPServer((host, int(port)), Handler)
    srv.daemon_threads = True
    srv.socket.listen(128)
    LOG.info('监听 http://%s，回源 %s，缓存 %s，TTL %ds，并发 %d',
             LISTEN, ORIGIN, CACHE_FILE, TTL, FETCH_POOL)
    srv.serve_forever()


if __name__ == '__main__':
    main()
