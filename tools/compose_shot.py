"""把 KMS 视频平面帧合成回 UI 截图，生成 README 截图。

背景：X6 Pro 上视频不是画在 framebuffer 里的，而是走 KMS overlay 平面
（Esmart1-win0, plane-id=76）。所以 `miniapp_cli capture` 抓到的整页截图里
视频区是全黑的 —— README 里放那种图会误导读者（像"播不出来"）。

做法：
  1) `miniapp_cli capture` 抓 UI（960x266 逻辑画布）
  2) `gst-launch-1.0 kmssrc plane-id=76 num-buffers=1 ! pngenc` 抓平面帧
     （540x960，面板坐标系、竖屏）
  3) 按 /sys/kernel/debug/dri/0/summary 里平面的 dst 矩形，把平面帧反变换
     回逻辑坐标贴进截图

坐标变换（与 src/services/screen.js 的 logicalRectToPhysicalRect 互为逆）：
    panel_x = PANEL_X_OFFSET + logical_y        (PANEL_X_OFFSET = 107)
    panel_y = 960 - logical_x
逆：
    logical_x = 960 - panel_y
    logical_y = panel_x - 107
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

PANEL_X_OFFSET = 107
PANEL_HEIGHT = 960
REPO = Path(__file__).resolve().parent.parent   # PenDouyu 仓库根
WORKSPACE = REPO.parent                           # 工作区根（env/ 在这层）
ADB = WORKSPACE / 'env' / 'adb' / 'adb.exe'


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def adb(*args):
    return sh([str(ADB), *args], env={**__import__('os').environ, 'MSYS_NO_PATHCONV': '1'})


def plane_dst():
    """从 DRM summary 读 Esmart1-win0 的 dst 矩形。"""
    out = adb('shell', "grep -a 'Esmart1-win0' -A9 /sys/kernel/debug/dri/0/summary").stdout
    for line in out.splitlines():
        if line.strip().startswith('dst:'):
            num = line.split('pos[')[1]
            px, rest = num.split(',')
            py = rest.split(']')[0]
            wh = line.split('rect[')[1].rstrip('] \r')
            pw, ph = wh.split(' x ')
            return int(px), int(py), int(pw), int(ph)
    raise SystemExit('没读到平面 dst 矩形（视频没在播？）')


def composite(ui_png, plane_png, out_png):
    ui = Image.open(ui_png).convert('RGB')
    plane = Image.open(plane_png).convert('RGB')
    if ui.size != (960, 266):
        raise SystemExit(f'UI 截图尺寸异常: {ui.size}')
    px, py, pw, ph = plane_dst()
    # 逻辑矩形 = 面板矩形的逆变换（见文件头公式）
    lx, ly = PANEL_HEIGHT - (py + ph), px - PANEL_X_OFFSET
    lw, lh = ph, pw
    print(f'plane dst 面板=({px},{py},{pw},{ph}) → 逻辑=({lx},{ly},{lw},{lh})')

    P = np.asarray(plane)                # (960, 540, 3)：row=panel_y, col=panel_x
    print(f'plane png {plane.size} → array {P.shape}')
    # 平面对逻辑坐标：logical_x = 960-1-panel_y，logical_y = panel_x-107
    Pr = P[::-1, :]                      # Pr[i][j] = P[959-i][j] → Pr[logical_x][panel_x]
    ly0 = max(ly, 0)
    lh_eff = min(lh, 266 - ly0)
    # 取 [logical_x][panel_x 区间] → (lw, lh_eff, 3)
    reg = Pr[lx:lx + lw, PANEL_X_OFFSET + ly0:PANEL_X_OFFSET + ly0 + lh_eff]
    if reg.size == 0:
        raise SystemExit('平面区域为空，检查 dst 矩形')
    # 目标图是 [y][x]，而 reg 是 [x][y] → 交换前两轴
    patch = Image.fromarray(np.ascontiguousarray(np.swapaxes(reg, 0, 1)))
    ui.paste(patch, (lx, ly0))
    ui.save(out_png)
    print(f'合成完成: {out_png}')


def main():
    shots = REPO / 'docs' / 'screenshots'
    shots.mkdir(parents=True, exist_ok=True)
    ev = REPO / 'profiles' / 'evidence'
    ev.mkdir(parents=True, exist_ok=True)
    name = sys.argv[1] if len(sys.argv) > 1 else 'play'
    remote_ui = '/tmp/shot_ui.png'
    remote_pl = '/tmp/shot_plane.png'
    adb('shell', f'miniapp_cli capture {remote_ui}')
    adb('shell', "timeout 20 gst-launch-1.0 kmssrc plane-id=76 num-buffers=1 "
                 f"! videoconvert ! pngenc ! filesink location={remote_pl} > /dev/null 2>&1")
    adb('pull', remote_ui, str(ev / f'{name}_ui.png'))
    adb('pull', remote_pl, str(ev / f'{name}_plane.png'))
    composite(ev / f'{name}_ui.png', ev / f'{name}_plane.png', shots / f'x6-{name}.png')


if __name__ == '__main__':
    main()
