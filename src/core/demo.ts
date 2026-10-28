/**
 * 开场示例工程「初雪」。
 *
 * 直接写成 ABC 再走自己的解析器：一份示例同时是**解析器的活样本**，
 * 万一哪天解析器改坏了，打开应用第一眼就能看出来，不用等测试跑。
 * 解析失败时退到空工程而不是抛错——启动路径不能因为示例而白屏。
 */

import { parseAbc } from "./abc.ts";
import { emptyScore, type Score } from "./model.ts";

const DEMO_ABC = `X:1
T:初雪
C:MuseLab
M:4/4
L:1/4
Q:1/4=72
%%score 1 2 3
K:C
V:1 name="主旋律" clef=treble
E G c B | A2 G2 |
F A c A | G4 |
E G c B | A2 c2 |
B A G F | E4 |
V:2 name="钢琴" clef=treble
[CEG]2 [CEG]2 | [CEA]2 [CEA]2 |
[CFA]2 [CFA]2 | [GBd]2 [GBd]2 |
[CEG]2 [CEG]2 | [CEA]2 [CEA]2 |
[GBd]2 [GBd]2 | [CEG]2 [CEG]2 |
V:3 name="低音" clef=bass
C,2 G,2 | A,2 E,2 |
F,2 C2 | G,2 D2 |
C,2 G,2 | A,2 E,2 |
G,2 D2 | C,2 C,2 |
`;

export function demoScore(): Score {
  try {
    const { score, warnings } = parseAbc(DEMO_ABC, "初雪");
    if (warnings.length > 0) console.warn("示例工程有解析告警：", warnings);
    return {
      ...score,
      tracks: score.tracks.map((t, i) => ({
        ...t,
        instrument: i === 0 ? "pipe" : i === 1 ? "piano" : "bass",
        volume: i === 0 ? 0.85 : i === 1 ? 0.6 : 0.75,
        pan: i === 0 ? 0 : i === 1 ? -0.2 : 0.15,
      })),
      meta: { origin: "local", brief: "开场示例：8 小节，C 大调，四和弦进行" },
    };
  } catch (e) {
    console.error("示例工程解析失败，退回空工程", e);
    return emptyScore("示例工程");
  }
}
