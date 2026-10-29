#!/usr/bin/env bash
# 拉取真实乐器采样到 public/samples/。
#
# 为什么要有这个脚本：采样是二进制，体积大、来源要可追溯。把「从哪儿来、
# 什么授权、文件名怎么对应」写成可复跑的东西，比在 README 里写一段话可靠。
# 产物直接进仓（应用必须离线可用），所以正常情况下不需要再跑。
#
# 授权：
#   piano  —— Salamander Grand Piano（Alexander Holm 录制，CC-BY 3.0）
#             由 Tone.js 官方采样仓 Tonejs/audio 分发
#   others —— VSCO2（Versilian Studios Chamber Orchestra 2，CC0）
#             经 nbrosowsky/tonejs-instruments 整理分发，仓库声明采样为 CC-BY 3.0
#             guitar 另注：Freesound «classicalguitar-multisampled» by quartertone
#
# 用法：bash scripts/fetch-samples.sh [--proxy http://127.0.0.1:7897]

set -euo pipefail
cd "$(dirname "$0")/.."

PROXY=""
if [[ "${1:-}" == "--proxy" ]]; then PROXY="$2"; fi
CURL=(curl -sL --max-time 90 --retry 2 --retry-delay 1)
if [[ -n "$PROXY" ]]; then CURL+=(-x "$PROXY"); fi

OUT="public/samples"
mkdir -p "$OUT"

# 采样文件名保留 rs 记法里的 s（Ds1 = D#1），Tone 只认 #，所以映射在代码里做，
# 免得磁盘上出现需要 URL 编码的 # 号。
fetch() { # fetch <目标目录> <基础URL> <音名...>
  local dir="$1" base="$2"; shift 2
  mkdir -p "$OUT/$dir"
  for n in "$@"; do
    if [[ -s "$OUT/$dir/$n.mp3" ]]; then continue; fi
    "${CURL[@]}" -o "$OUT/$dir/$n.mp3" "$base/$n.mp3" || true
    if [[ ! -s "$OUT/$dir/$n.mp3" ]]; then echo "  FAIL $dir/$n.mp3" >&2; rm -f "$OUT/$dir/$n.mp3"; fi
  done
  echo "  $dir: $(ls "$OUT/$dir"/*.mp3 2>/dev/null | wc -l | tr -d ' ') files"
}

echo "piano (Salamander)"
fetch piano "https://tonejs.github.io/audio/salamander" \
  A0 C1 Ds1 A1 C2 Ds2 A2 C3 Ds3 A3 C4 Ds4 A4 C5 Ds5 A5 C6 Ds6 A6 C7 Ds7 A7 C8

echo "pipe (flute)"
fetch pipe "https://nbrosowsky.github.io/tonejs-instruments/samples/flute" \
  C4 E4 A4 C5 E5 A5 C6 E6 A6 C7

echo "guitar (nylon)"
fetch guitar "https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-nylon" \
  B1 E2 A2 D2 G3 B2 Fs2 Gs2 E3 A3 D3 G3 B3 Fs3 Cs3 Ds4 E4 A4 D5 Fs4 Gs4 Cs4 E5 A5 B4 G5 Gs5 As5 Fs5 Cs5

echo "brass (trumpet)"
fetch brass "https://nbrosowsky.github.io/tonejs-instruments/samples/trumpet" \
  F3 A3 C4 Ds4 F4 G4 As4 D5 F5 A5 C6

echo "reed (clarinet)"
fetch reed "https://nbrosowsky.github.io/tonejs-instruments/samples/clarinet" \
  D3 F3 As3 D4 F4 As4 D5 F5 As5 D6 Fs6

echo "organ"
fetch organ "https://nbrosowsky.github.io/tonejs-instruments/samples/organ" \
  C1 Ds1 Fs1 A1 C2 Ds2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Fs4 A4 C5 Ds5 Fs5 A5 C6

du -sh "$OUT"
