# 采样来源与授权

`public/samples/` 下的音色采样不是本项目自制，全部来自公开的音源库，按各自的授权随包分发。
拉取与更新用 `scripts/fetch-samples.sh`（含每个乐器的音名清单，可复跑）。

## Salamander Grand Piano — `samples/piano/`

- 演奏 / 录制：**Alexander Holm**
- 授权：**CC-BY 3.0**（https://creativecommons.org/licenses/by/3.0/）
- 分发：Tone.js 官方采样仓 <https://github.com/Tonejs/audio>
- 说明：Yamaha C5 三角钢琴，每小三度一个采样点，共 23 个（A0–C8）。这是目前
  免费音源里公认最适合网页播放的一套：体积 1.7MB，音色仍然是真钢。

## VSCO2（Versilian Studios Chamber Orchestra 2）— `samples/pipe|guitar|brass|reed|organ/`

- 制作：**Versilian Studios**
- 授权：**CC0 / 公有领域**（VSCO2 Community Edition）
- 分发：经 <https://github.com/nbrosowsky/tonejs-instruments> 整理分发，
  该仓库声明其采样为 CC-BY 3.0
- 具体乐器：
  - `pipe`（管乐）→ flute
  - `brass`（铜管）→ trumpet
  - `reed`（簧片）→ clarinet
  - `organ`（风琴）→ organ
  - `guitar`（吉他）→ guitar-nylon，其中尼龙弦吉他来自 Freesound
    《classicalguitar-multisampled》by **quartertone**（CC-BY 3.0）

## 处理说明

随包文件是原始 mp3，未做重编码（避免二次压缩损失）。运行时只做两件事：

1. **截断**：Salamander 的采样是整段自然衰减，平均 14 秒、最长 25 秒。谱面播放的
   音符通常一两拍就松键，后面十几秒永远播不到，但解码后的 buffer 要常驻内存。
   统一截到 6 秒（末端 50ms 淡出），内存从 231MB 降到 123MB（六套全加载时）。
2. **切头**：mp3 编码器会在文件开头塞 0.3–15.7ms 数字静音，切掉后每个音才和
   播放头严格对齐。乐器的起音坡度（簧片 70ms、风琴 51ms 那种"吹起来"的过程）
   一律保留——那是音色本身，不是延迟。

响度按实测配平：每个音色弹一个 mf 单音，在总线上统一落在 -22 dBFS RMS。
