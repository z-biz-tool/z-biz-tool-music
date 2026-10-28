# z-biz-tool-music · MuseLab 音乐工坊

一句话到一首曲：**从零生成**一段完整的曲子，然后**五线谱 / 简谱 / 钢琴卷帘 / 混音台**四视图同步编辑它，最后导出成 MIDI、MusicXML、ABC 或一段 WAV。

无后端、无账号、可离线；AI 是可选的加速器，不是必需品——不填 Key 也能用本地算法作曲、手动写谱、听回放、导出专业格式。

## 四条主路径

| 起点 | 怎么走 | 产出 |
| --- | --- | --- |
| **一句话** | 在右侧「AI 作曲」写一句需求（"写给雨天的钢琴小品，慢一点"），选风格/调性/小节数 | 五线谱、简谱、卷帘同时出现成品；不满意就"再变一版" |
| **一条旋律** | 「续写」拿当前最后一小节往后接；「变奏」在当前动机上发展；「润色」只改和声与伴奏不动主旋律 | 在同一工程上迭代，每次改动都可撤销 |
| **一个和弦** | 选调性与和弦进行，本地算法按风格铺旋律 + 伴奏 + 低音 | 离线可用的完整编曲，不消耗任何 token |
| **一张谱** | 打开 `.abc` / `.musicxml` / `.mid`，或在「粘贴乐谱」里贴一段 ABC | 直接变成可编辑工程 |

## 四视图同源

同一份乐谱数据（`src/core/model.ts` 的 IR），四个视图只是四种看法：

| 视图 | 做什么 |
| --- | --- |
| **五线谱** | abcjs 排版，多轨并成大谱表（`%%score {}`）；宽度跟着容器自适应，缩放 1.2 保证符头可读 |
| **简谱** | 自研排版模型。首调唱名、八度点、减时线 / 增时线 / 附点、休止 `0`、变化音 #/b 全部按国内通行写法；**每条轨自己选中音区**，低音轨不会写成三个八度点 |
| **钢琴卷帘** | Canvas 2D 手绘。拖动改音高与位置、点空白加音、按曲长自适应缩放；改完立刻反映到另外三个视图 |
| **混音台** | 每轨音量 / 声像 / 静音 / 独奏 / 删除（删除要二次确认），12 个音色族随时换 |

## 十二个音色族，五条播放链

`piano` `epiano` `organ` `guitar` `bass` `strings` `brass` `reed` `pipe` `synth` `pad` `drums`

Tone.js 实时播放（走带条支持上/下一小节、循环、节拍器、BPM 微调），也能 `Tone.Offline` 离线渲染成 WAV——渲染用的是同一条信号链，不是另一套近似实现。

## AI 只做一件事：把话变成谱

中间语言选 **ABC 记谱法**，不选 MusicXML：一首 32 小节的小品 ABC 约 400 token，MusicXML 要 6000+，而且 LLM 写 ABC 的语法准确率明显更高、出错时人能指着第 3 小节说"这个记号不对"。

所以链路是：**一句话 → LLM 出 ABC → 本地严格解析器校验 → 变成 IR → 四个视图**。解析器只认一个明确定义的子集，**不认识的记号一律抛错并指出小节号**，绝不静默忽略——AI 的错必须变成看得见的报错，而不是用户谱面上莫名其妙少掉的一个音。

- 预置 5 个 OpenAI 兼容提供方：DeepSeek / OpenAI / Kimi / 智谱 / 本地 Ollama
- API Key 只存本机 `localStorage`，工程文件里永远不含 Key（自检里有一条断言盯着这件事）
- 提供方报错会带原文重试一次；彻底失败时自动降级到本地算法作曲，不给你一个空谱

## 读写格式

| 方向 | 格式 | 说明 |
| --- | --- | --- |
| 读 | `.abc` `.musicxml` `.mid` `.zmusic` | 走原生命令行对话框（Tauri），浏览器里降级成 `<input type=file>` |
| 写 | `.zmusic`（工程 JSON）`.abc` `.musicxml` `.mid` `.wav` | 工程 JSON 带 `v: 1` 版本号，可进版本库 |

`MusicXML` 导出的 `divisions = 12`，钢琴轨用 `<backup>` 写成大谱表，Logic / MuseScore / Dorico 都能直接打开。

## 工程结构

```
src/core/model.ts      乐谱 IR（绝对拍、扁平音符表、pitch:-1 表休止）、校验、序列化
src/core/theory.ts     调号、音阶、音高拼写（spellPitch）、和弦识别、12 个音色族的音域与 GM program
src/core/abc.ts        ABC 严格子集读写（含临时升降号的小节记忆）
src/core/musicxml.ts   MusicXML 4.0 partwise 读写 + xml.ts 里的手写扫描器（不依赖 DOMParser，Node 可跑）
src/core/jianpu.ts     简谱排版模型
src/core/midi.ts       MIDI 读写（@tonejs/midi，CJS/ESM 双入口兼容）
src/core/compose.ts    规则作曲器：5 风格 × 和弦进行 × 动机发展 + 伴奏/低音，确定性随机（同 seed 同结果）
src/core/ai.ts         OpenAI 兼容链路、ABC 提示词、回复清洗、小节校验
src/audio/engine.ts    Tone.js 播放引擎 + 离线渲染 WAV
src/ui/views.tsx       五线谱 / 简谱 / 卷帘 / 混音台
src/ui/panels.tsx      AI 面板、乐理面板、检视器
src/state.ts           zustand 唯一真源：撤销栈、脏标记、落盘
scripts/verify.ts      内核自检：24 个调 × 5 风格 ABC 往返 + MusicXML/MIDI 往返 + 简谱 + 错误定位
```

## 命令

需要 Node 22.18 以上（见 `.nvmrc`）：`npm run verify` / `npm test` 直接跑 TypeScript，靠的是 Node 原生的类型剥离。

```bash
npm install
npm run dev        # http://localhost:5200
npm run typecheck  # tsc --noEmit（strict + noUnusedLocals）
npm test           # 25 条内核单测（node --test，零依赖）
npm run verify     # 478 项链路断言
npm run build
npm run tauri dev  # 桌面壳（单实例、原生对话框、自动更新）
```

桌面安装包：打 tag（`v*`）触发 `.github/workflows/build.yml`，四平台矩阵出包并推送 `latest.json`。发版只需打 tag。

## 交互速查

- `Space` 播放/暂停，`←` `→` 前后一小节，`Delete` 删当前轨，`⌘/Ctrl+Z` 撤销，`⌘/Ctrl+S` 保存
- 卷帘里拖动音符改音高与位置，点空白加音；选中轨道后在混音台调音量/声像
- 窗口窄于 1180px 时右面板默认收起（`?view=jianpu` 之类的深链仍能直达简谱视图）
- 有未保存改动时关窗会先问一次，不会默默丢掉

## 诚实边界（v0.1.0）

- 谱面是**只读排版 + 卷帘编辑**：还不能在五线谱上直接拖音符，也不能输入歌词、装饰音、连音记号之外的记号
- 复调/多声部在同一轨内按和弦处理，没有独立的声部层
- 只支持大调 / 小调，没有中古调式、移调乐器、反复与跳房子
- AI 需要你自己填 Key（产品版会内置额度）；本地算法作曲是"能听、结构完整"的水平，不是作曲家

## 许可

MIT。第三方：abcjs（MIT）、Tone.js（MIT）、@tonejs/midi（MIT）、Ant Design（MIT）、React（MIT）。

刻意不用 OpenSheetMusicDisplay（AGPL-3.0）、MuseScore（GPL-3.0）、LilyPond（GPL-3.0）：这三个都会把整个产品拖进传染性许可，做生意不能踩。
