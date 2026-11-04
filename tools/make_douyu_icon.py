#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把斗鱼官方图标 PNG 放大成 256x256 的 app_icon.png（纯标准库，无第三方依赖）。

为什么自己写：工作区 env/node_modules 里没有 @resvg/resvg-js（PenBili 的
tools/make_icon_v2.js 依赖它），本机 python 也没有 Pillow。图标是位图不是矢量，
只需要一次高质量重采样，用 zlib 手工解 PNG + 可分离双线性放大即可。

输入：.tmp_douyu_icon.png（74x74 RGBA，斗鱼官网 pcclient-desc 图）
输出：app_icon.png（256x256 RGBA，应用图标）
      src/assets/icons/logo.png（60x60 RGBA，浏览态左栏 30x30 显示的软件 logo）

两处都从同一张源图生成，保证「桌面图标」与「界面 logo」是同一个斗鱼鲨鱼。

可分离双线性 = 先横向放大再纵向放大，两趟一维插值。74→256 是 3.46 倍，
纯双线性会略糊；所以采用 **双线性 + 轻度 unsharp**（3x3 反锐化掩模），
让图标边缘在笔的 480x960 屏上不发灰。
"""
import os
import struct
import sys
import zlib

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.tmp_douyu_icon.png')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app_icon.png')
LOGO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'icons', 'logo.png')
SIZE = 256
LOGO_SIZE = 60


def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos = 8
    w = h = depth = ctype = None
    idat = b''
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, depth, ctype, comp, filt, inter = struct.unpack('>IIBBBBB', body)
            assert depth == 8, 'only 8-bit supported'
            assert ctype == 6, 'only RGBA supported, got colortype %d' % ctype
            assert inter == 0, 'interlaced not supported'
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
    raw = zlib.decompress(idat)
    bpp = 4
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 0:
            pass
        elif f == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:  # Average
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:  # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa = abs(b - c)
                pb = abs(a - c)
                pc = abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        else:
            raise ValueError('bad filter %d' % f)
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def resize_bilinear(w, h, px, nw, nh):
    """可分离双线性。alpha 用非预乘通道独立插值，图标边缘有半透明像素也不会发黑。"""
    # 横向
    tmp = bytearray(nw * h * 4)
    xscale = (w - 1) / float(nw - 1) if nw > 1 else 0.0
    for y in range(h):
        row = y * w * 4
        trow = y * nw * 4
        for x in range(nw):
            fx = x * xscale
            x0 = int(fx)
            x1 = min(x0 + 1, w - 1)
            dx = fx - x0
            for c in range(4):
                a = px[row + x0 * 4 + c]
                b = px[row + x1 * 4 + c]
                tmp[trow + x * 4 + c] = int(a + (b - a) * dx + 0.5) & 0xFF
    # 纵向
    out = bytearray(nw * nh * 4)
    yscale = (h - 1) / float(nh - 1) if nh > 1 else 0.0
    for yy in range(nh):
        fy = yy * yscale
        y0 = int(fy)
        y1 = min(y0 + 1, h - 1)
        dy = fy - y0
        r0 = y0 * nw * 4
        r1 = y1 * nw * 4
        orow = yy * nw * 4
        for i in range(nw * 4):
            a = tmp[r0 + i]
            b = tmp[r1 + i]
            out[orow + i] = int(a + (b - a) * dy + 0.5) & 0xFF
    return out


def unsharp(w, h, px, amount=0.35):
    """3x3 反锐化掩模（只处理 RGB，alpha 不动），补偿双线性放大的边缘软化。"""
    src = bytes(px)
    out = bytearray(src)
    for y in range(1, h - 1):
        base = y * w * 4
        for x in range(1, w - 1):
            i = base + x * 4
            if src[i + 3] < 16:
                continue
            for c in range(3):
                acc = 0
                acc += src[i - w * 4 - 4 + c]
                acc += src[i - w * 4 + c]
                acc += src[i - w * 4 + 4 + c]
                acc += src[i - 4 + c]
                acc += src[i + c]
                acc += src[i + 4 + c]
                acc += src[i + w * 4 - 4 + c]
                acc += src[i + w * 4 + c]
                acc += src[i + w * 4 + 4 + c]
                blur = acc / 9.0
                v = src[i + c] + amount * (src[i + c] - blur)
                out[i + c] = 0 if v < 0 else (255 if v > 255 else int(v + 0.5))
    return out


def write_png(path, w, h, px):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter none
        raw += px[y * stride:(y + 1) * stride]

    def chunk(typ, body):
        return (struct.pack('>I', len(body)) + typ + body +
                struct.pack('>I', zlib.crc32(typ + body) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    open(path, 'wb').write(data)
    return len(data)


def main():
    if not os.path.exists(SRC):
        print('ERROR: source not found: %s' % SRC)
        return 1
    w, h, px = read_png(SRC)
    print('src %dx%d' % (w, h))
    big = resize_bilinear(w, h, px, SIZE, SIZE)
    big = unsharp(SIZE, SIZE, big)
    n = write_png(OUT, SIZE, SIZE, big)
    # 自检：不透明像素占比、橙色像素占比（斗鱼橙 #FF5D23 附近）
    opaque = 0
    orange = 0
    total = SIZE * SIZE
    for i in range(0, len(big), 4):
        r, g, b, a = big[i], big[i + 1], big[i + 2], big[i + 3]
        if a > 200:
            opaque += 1
            if r > 200 and 60 < g < 140 and b < 80:
                orange += 1
    print('out %dx%d bytes=%d opaque=%.1f%% orange=%.1f%%' %
          (SIZE, SIZE, n, 100.0 * opaque / total, 100.0 * orange / total))

    # 界面 logo：同一源图缩到 60x60（界面按 30x30 显示，2x 出图防锯齿）
    small = resize_bilinear(w, h, px, LOGO_SIZE, LOGO_SIZE)
    small = unsharp(LOGO_SIZE, LOGO_SIZE, small)
    ln = write_png(LOGO, LOGO_SIZE, LOGO_SIZE, small)
    print('logo %dx%d bytes=%d -> %s' % (LOGO_SIZE, LOGO_SIZE, ln, LOGO))
    return 0


if __name__ == '__main__':
    sys.exit(main())
