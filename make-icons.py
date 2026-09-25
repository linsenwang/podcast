#!/usr/bin/env python3
"""生成 PWA 图标（波形图案）。改了样式重跑一次即可：
    python3 podcast/make-icons.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'www', 'icons')

BG = (15, 17, 21, 255)
ACCENT = (79, 140, 255, 255)
BARS = [0.30, 0.55, 0.86, 0.55, 0.30]   # 相对高度，中间最高


def render(size, radius_ratio, scale):
    """scale 控制波形整体大小；radius_ratio=0 表示满幅直角底（maskable / apple-touch 用）"""
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if radius_ratio > 0:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * radius_ratio), fill=BG)
    else:
        d.rectangle([0, 0, s - 1, s - 1], fill=BG)

    n = len(BARS)
    bw = s * 0.095
    gap = bw * 0.62
    total = n * bw + (n - 1) * gap
    x = (s - total) / 2
    cy = s / 2
    for h in BARS:
        hh = s * scale * h
        d.rounded_rectangle([x, cy - hh / 2, x + bw, cy + hh / 2], radius=bw / 2, fill=ACCENT)
        x += bw + gap

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, 'PNG', optimize=True)
    print('写出', path, os.path.getsize(path), 'bytes')


os.makedirs(OUT, exist_ok=True)
save(render(192, 0.22, 0.60), 'icon-192.png')
save(render(512, 0.22, 0.60), 'icon-512.png')
save(render(512, 0.0, 0.50), 'icon-maskable-512.png')   # 内容留在中间安全区
save(render(180, 0.0, 0.60), 'apple-touch-icon.png')    # iOS 不认透明和圆角
