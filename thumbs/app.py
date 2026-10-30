#!/usr/bin/env python3
"""服务端封面缩略图：抓一次上游封面 → 缩到长边 200px → 落盘缓存，只把这张小图给客户端。

为什么要有这个服务（而不是让前端直接 <img src="原图">）：
  1. bilibili 图床的封面是 1920x1080 的 jpg，单张 100KB+，手机上会和音频抢带宽；
  2. YouTube 系的 i.ytimg.com / yt3.ggpht.com 在客户端网络里不可达，
     只有服务端经 HTTP_PROXY 才拉得到（见 docker-compose.yml 的 podcast-thumbs）；
  3. 列表里同一个封面会被反复请求，抓一次落盘就够了。

只监听宿主回环 127.0.0.1:8101，由 podcast(nginx) 的 /thumb 反代进来，
和 podcast 那个服务的套路一致：对外只有 tailscale serve 的 HTTPS 入口。

接口：
  GET /thumb?u=<URL-encoded 绝对 http/https 图片地址>
      200 image/jpeg，长边 <=200px，quality 80，immutable 缓存头
      400 参数缺失/不是 http(s)   403 主机不在白名单   404 其它路径
  GET /healthz  -> 200 纯文本
上游抓失败时回一张 1x1 的 JPEG（见 PLACEHOLDER 那段注释），不给 5xx。
"""

import hashlib
import io
import logging
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

# 监听地址和缓存目录都可以用环境变量覆盖，默认值对应 docker-compose.yml 里的挂载。
LISTEN = os.environ.get('LISTEN', '127.0.0.1:8101')
CACHE_DIR = os.environ.get('CACHE_DIR', '/app/cache')

MAX_EDGE = 200          # 缩略图长边上限，列表里的封面用不着更大
JPEG_QUALITY = 80
FETCH_TIMEOUT = 10      # 上游超时，超了就发占位图 —— 客户端不能被上游挂住
FETCH_SLOTS = 4         # 同时在跑的上游抓取数上限，免得一屏封面同时打上游
MAX_FETCH_BYTES = 12 * 1024 * 1024   # 上游异常大图直接放弃，别把内存吃满

# SSRF 白名单：只放行这几家图床。用"域名后缀"而不是完整主机名，
# 因为同一家图床的 CNAME 会变（i0/i1/i2.hdslb.com、i.ytimg.com / img.youtube.com 等）。
ALLOWED_DOMAINS = ('hdslb.com', 'ytimg.com', 'ggpht.com', 'fireside.fm')

# 缩略图内容由 URL 唯一决定，所以就按 URL 做 immutable；前端也因此可以直接长缓存。
CACHE_CONTROL_HIT = 'public, max-age=31536000, immutable'

UA = 'podcast-thumbs/1.0'

LOG = logging.getLogger('thumbs')


def _make_placeholder():
    """抓不到上游时回的那张 1x1 图。

    JPEG 本身没有 alpha 通道，所谓"透明"只能退化成白色 —— 这里要的效果是
    "一张能正常解码的极小图"：<img> 不会触发 error，客户端也不会拿到 5xx 卡住。
    """
    buf = io.BytesIO()
    Image.new('RGB', (1, 1), (255, 255, 255)).save(buf, 'JPEG', quality=JPEG_QUALITY)
    return buf.getvalue()


PLACEHOLDER = _make_placeholder()

# 抓取闸门：抓住上游之前先拿它，保证同时在飞的上游请求不超过 FETCH_SLOTS 个。
FETCH_SEM = threading.Semaphore(FETCH_SLOTS)


def parse_target(raw):
    """把 query 里的 u 解析成 (url, 错误码)；错误码非 0 表示直接拒绝这个请求。"""
    if not raw:
        return None, 400
    try:
        parts = urllib.parse.urlsplit(raw)
    except ValueError:
        # 畸形 URL（例如方括号没闭合的 IPv6）当参数错误，不要漏到后面的兜底里去
        return None, 400
    if parts.scheme not in ('http', 'https'):
        return None, 400
    host = (parts.hostname or '').lower().rstrip('.')
    if not host:
        return None, 400
    # 用 == 或 ".域名 结尾" 判断，避免 "evilhdslb.com" 这种后缀伪装混进来
    if not any(host == d or host.endswith('.' + d) for d in ALLOWED_DOMAINS):
        return None, 403
    return raw, 0


def cache_path(url):
    """缓存文件名就是 sha1(url)：URL 里带 ?x-oss-process=... 之类的字符，
    直接用 URL 当文件名不安全也不好查，哈希后落成固定长度的 .jpg。"""
    return os.path.join(CACHE_DIR, hashlib.sha1(url.encode('utf-8')).hexdigest() + '.jpg')


def fetch_upstream(url):
    """经 HTTP_PROXY/HTTPS_PROXY（urllib 默认读这几个环境变量）把原图拉下来。

    NO_PROXY 也是 urllib 自动处理的，回环地址不会绕代理。
    """
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'image/*'})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        # 多读 1 字节用来判断是否超限，避免无上限地把响应读进内存
        data = resp.read(MAX_FETCH_BYTES + 1)
    if len(data) > MAX_FETCH_BYTES:
        raise ValueError('上游图片超过 %d 字节' % MAX_FETCH_BYTES)
    return data


def make_thumb(data):
    """缩放并编码成 JPEG。thumbnail() 只管缩小不放大，所以小图会原样保留。"""
    with Image.open(io.BytesIO(data)) as im:
        # 上游有 P 模式 / 带 alpha 的 png，JPEG 存不了，统一转 RGB
        im = im.convert('RGB')
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, 'JPEG', quality=JPEG_QUALITY, optimize=True)
    return out.getvalue()


def store(path, blob):
    """先写临时文件再 rename：并发请求同一个 URL 时，谁都读不到写了一半的文件。

    临时名带上线程 id，否则同进程两个线程会抢同一个临时文件。
    """
    tmp = '%s.%d.tmp' % (path, threading.get_ident())
    try:
        with open(tmp, 'wb') as f:
            f.write(blob)
        os.replace(tmp, path)
    except OSError as exc:
        # 缓存写不进去不属于致命错误，图已经算出来了，先给客户端
        LOG.warning('缓存写入失败 %s: %s', path, exc)
        if os.path.exists(tmp):
            os.remove(tmp)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'   # 前端一屏会并发拉十几个封面，复用连接省掉握手
    server_version = 'podcast-thumbs'
    sys_version = ''

    def log_message(self, fmt, *args):
        pass    # 每个请求的 HIT/MISS 在 _route 里自己打，不要 http.server 那套两行格式

    def do_GET(self):
        self._sent = False
        try:
            self._route()
        except Exception:
            # 兜底：预期外的异常也只回占位图，绝不把 5xx 抛给客户端
            LOG.exception('处理请求出错: %s', self.path)
            self._send(200, PLACEHOLDER, 'image/jpeg', 'no-store')

    def _route(self):
        path, _, query = self.path.partition('?')

        if path == '/healthz':
            return self._send(200, b'ok\n', 'text/plain; charset=utf-8', 'no-store')
        if path != '/thumb':
            return self._send(404, b'not found\n', 'text/plain; charset=utf-8', 'no-store')

        raw = urllib.parse.parse_qs(query).get('u', [''])[0]
        url, err = parse_target(raw)
        if err == 400:
            LOG.warning('400 缺少 u 或不是 http(s) 地址: %r', raw)
            return self._send(400, b'bad request\n', 'text/plain; charset=utf-8', 'no-store')
        if err == 403:
            LOG.warning('403 主机不在白名单: %s', urllib.parse.urlsplit(raw).hostname)
            return self._send(403, b'forbidden host\n', 'text/plain; charset=utf-8', 'no-store')

        cp = cache_path(url)
        try:
            with open(cp, 'rb') as f:
                blob = f.read()
            LOG.info('HIT  %d bytes  %s', len(blob), url)
            return self._send(200, blob, 'image/jpeg', CACHE_CONTROL_HIT)
        except FileNotFoundError:
            pass

        # 排队等闸门也有上限：等不到就直接给占位图，别让客户端压在队里干等。
        if not FETCH_SEM.acquire(timeout=FETCH_TIMEOUT):
            LOG.warning('抓取队列已满，跳过 %s', url)
            return self._send(200, PLACEHOLDER, 'image/jpeg', 'no-store')
        try:
            try:
                raw_bytes = fetch_upstream(url)
                blob = make_thumb(raw_bytes)
            except (urllib.error.URLError, OSError, ValueError) as exc:
                # 上游挂了/超时/不是图片（Pillow 解不开时抛的 UnidentifiedImageError 也是 OSError）。
                # 给占位图并且 no-store —— 失败是暂时的，不能被客户端当 immutable 缓存一年。
                LOG.warning('上游抓取失败 %s: %s', url, exc)
                return self._send(200, PLACEHOLDER, 'image/jpeg', 'no-store')
            store(cp, blob)
            LOG.info('MISS %d -> %d bytes  %s', len(raw_bytes), len(blob), url)
            return self._send(200, blob, 'image/jpeg', CACHE_CONTROL_HIT)
        finally:
            FETCH_SEM.release()

    def _send(self, status, body, ctype, cache_control):
        if self._sent:
            return
        self._sent = True
        try:
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', cache_control)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 客户端提前断开（切页面 / 拖到底又划走），不用当故障
            pass


def main():
    logging.basicConfig(
        stream=sys.stdout,
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
    )
    os.makedirs(CACHE_DIR, exist_ok=True)
    host, _, port = LISTEN.rpartition(':')
    srv = ThreadingHTTPServer((host, int(port)), Handler)
    srv.daemon_threads = True
    # http.server 的 listen backlog 默认只有 5，而客户端一屏十几张封面是同时发出来的，
    # 排队稍慢内核就把连接丢掉（浏览器看到的就是封面随机加载失败）。
    srv.socket.listen(128)
    LOG.info('监听 http://%s，缓存目录 %s，白名单 %s，抓取并发 %d，上游超时 %ds',
             LISTEN, CACHE_DIR, ','.join(ALLOWED_DOMAINS), FETCH_SLOTS, FETCH_TIMEOUT)
    srv.serve_forever()


if __name__ == '__main__':
    main()
