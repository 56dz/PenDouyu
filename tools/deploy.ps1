# PenDouyu 真机部署与验证（有道 X6 Pro）
#
# 流程与 PenBili 时期同构，差别在 appid / 包名 / 日志标签 / 残留指纹。
#
# 流程：
#   1) 设备与产物检查（AMR + native ELF）
#   2) 安装（要求 ret: 0）+ 核对安装 slot 的 .so 落位
#   3) 切桌面 → 冷启动到 index（先切走再启动，保证重建页面实例）
#   4) 取证：capture（整页）+ [douyu] / [player] 日志 + /tmp/pb2.log
#   5) 进出循环：退出后 curl / ffmpeg / FIFO 残留必须为 0
#   6) 汇总
#   7) 证据落 profiles/evidence/
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/deploy.ps1
param(
  [string]$StartPage = 'index'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# adb 定位：$env:DOUYU_ADB → PATH 中的 adb → 本机开发布局（../env/adb）
$adb = $env:DOUYU_ADB
if (-not $adb) { $c = Get-Command adb -ErrorAction SilentlyContinue; if ($c) { $adb = $c.Source } }
if (-not $adb) { $cand = Join-Path $root '..\env\adb\adb.exe'; if (Test-Path $cand) { $adb = (Resolve-Path $cand).Path } }
if (-not $adb) { throw '找不到 adb：请设置 DOUYU_ADB 指向 adb.exe，或将 adb 加入 PATH' }
$appid = '8002026110200002'
$desktop = '8080222437664451'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ev = Join-Path $root 'profiles\evidence'
$wait = 15

New-Item -ItemType Directory -Force -Path $ev | Out-Null

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

function Pull-Capture([string]$remote, [string]$local) {
  & $adb pull $remote $local | Out-Null
  if (Test-Path $local) { Write-Host "evidence: $local" } else { Write-Host "MISSING: $local" -ForegroundColor Yellow }
}

# 直播拉流走 curl 子进程写 FIFO，所以残留检查看 curl / FIFO，而不是 ffmpeg / aplay。
# FIFO 必须用 find -type p 数：/tmp/pb2/err-<name>.fifo 是**普通文件**（curl stderr 重定向），
# 用 `ls *.fifo | wc -l` 会把它们算进去，永远报 8 个假残留（真机踩过）。
function Residue() {
  $c = & $adb shell "ps | grep -c '[c]url -s'"
  $f = & $adb shell "ps | grep -c '[f]fmpeg'"
  $fifo = & $adb shell "find /tmp/pb2 -maxdepth 1 -type p 2>/dev/null | wc -l"
  Write-Host "残留: curl=$c ffmpeg=$f fifo=$fifo (期望 0/0/0)"
}

Step '1/6 设备'
& $adb devices -l

Step '2/6 产物与 native 检查'
# 交付包为 PenDouyu.amr；回退 appid.*.amr（aiot-vue-cli 按 appid 命名时会走到这里）
$amr = Get-ChildItem -Path $root -Filter 'PenDouyu*.amr' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $amr) { $amr = Get-ChildItem -Path $root -Filter "$appid.*.amr" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
if (-not $amr) { throw '找不到 AMR 包，请先 npm run build' }
Write-Host "AMR: $($amr.Name) ($([math]::Round($amr.Length/1KB,1)) KB)"
foreach ($so in @('libjsapi_player.so', 'libjsapi_player2.so')) {
  $p = Join-Path $root "libs\$so"
  if (Test-Path $p) { python (Join-Path $root 'tools\inspect_elf.py') $p --target aarch64 | Select-Object -Last 3 }
}

Step '3/6 安装（ret:0 校验）'
& $adb push $amr.FullName /tmp/douyu_app.amr
$ins = & $adb shell "miniapp_cli install /tmp/douyu_app.amr"
$ins
if ("$ins" -notmatch '"ret":\s*0') { throw 'install 未返回 ret:0' }
& $adb shell "find /userdisk/miniapp/data/mini_app/pkg/$appid -maxdepth 3 -name '*.so'"

Step '4/6 冷启动（index）'
& $adb shell "miniapp_cli start $desktop" | Out-Null
Start-Sleep -Seconds 2
$st = & $adb shell "miniapp_cli start $appid $StartPage"
$st
Start-Sleep -Seconds $wait
$cap1 = "/tmp/dy_${stamp}_app1.png"
& $adb shell "miniapp_cli capture $cap1"
Pull-Capture $cap1 (Join-Path $ev "app1_${stamp}.png")

# 三层日志：QuickJS console.warn / native player2 / curl stderr
$log1 = & $adb shell "grep -hE '\[douyu\]|\[player\]' /userdata/applog/DictPen_*.log | tail -n 60"
$log1
$log1 | Out-File -FilePath (Join-Path $ev "app1_${stamp}_log.txt") -Encoding utf8
$p2 = & $adb shell "tail -n 80 /tmp/pb2.log 2>/dev/null"
$p2 | Out-File -FilePath (Join-Path $ev "app1_${stamp}_pb2.txt") -Encoding utf8
$p2

Step '5/6 进出循环：退出 → 残留检查 → 再进入'
& $adb shell "miniapp_cli start $desktop" | Out-Null
Start-Sleep -Seconds 4
Residue
& $adb shell "miniapp_cli start $appid $StartPage" | Out-Null
Start-Sleep -Seconds $wait
$cap2 = "/tmp/dy_${stamp}_app2.png"
& $adb shell "miniapp_cli capture $cap2"
Pull-Capture $cap2 (Join-Path $ev "app2_${stamp}.png")

Step '6/6 汇总'
& $adb shell "miniapp_cli memoryApp" | Select-Object -First 6
Write-Host "证据目录: $ev"
Write-Host "检查点：install ret:0 / app1 截图非黑且是斗鱼橙界面 / 残留 0/0/0 / 无 souphttpsrc Range 错"
