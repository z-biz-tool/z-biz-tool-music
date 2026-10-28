/**
 * 内核自检（`npm run verify`）。
 *
 * 跟 tests/ 的分工：单测盯"某个函数对不对"，这里盯"整条链路串起来还对不对"——
 * 24 个调 × 5 种风格各生成一首 → ABC 往返 → MusicXML 往返 → MIDI 往返 → 简谱排版，
 * 任何一环悄悄丢掉音高或拍子都会在这里炸出来。
 *
 * 全绿才允许发版（lead 的收口口径：typecheck + test + build + verify）。
 */

import { MusicError, beatsPerMeasure, measureCount, parseScore, scoreEnd, serializeScore, type Score } from "../src/core/model.ts";
import { parseAbc, roundTripCheck, splitAtBarlines, toAbc } from "../src/core/abc.ts";
import { fromMusicXml, toMusicXml } from "../src/core/musicxml.ts";
import { fromMidiBytes, toMidiBytes } from "../src/core/midi.ts";
import { buildJianpu } from "../src/core/jianpu.ts";
import { identifyChord, keyLabel } from "../src/core/theory.ts";
import { STYLES, compose, chordTimeline } from "../src/core/compose.ts";
import { demoScore } from "../src/core/demo.ts";
import { abcBarCheck, extractAbc } from "../src/core/ai.ts";

let checks = 0;
let failures = 0;
const failed: string[] = [];

function ok(cond: boolean, what: string): void {
  checks++;
  if (!cond) {
    failures++;
    failed.push(what);
    console.error(`  ✗ ${what}`);
  }
}

function eq<T>(actual: T, expected: T, what: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, `${what}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function pitchMultiset(s: Score): string {
  return s.tracks
    .map((t) =>
      t.notes
        .filter((n) => n.pitch >= 0)
        .map((n) => n.pitch)
        .sort((a, b) => a - b)
        .join(","),
    )
    .join("|");
}

function timingMultiset(s: Score): string {
  return s.tracks
    .map((t) =>
      t.notes
        // 休止只在谱面上需要（ABC 里小节必须填满），IR 里"没有音"就是静音。
        // 所以往返比较只看真音符，否则每一处空隙都会被记成"多出来的休止"。
        .filter((n) => n.pitch >= 0)
        .map((n) => `${n.start.toFixed(2)}:${n.dur.toFixed(2)}:${n.pitch}`)
        .sort()
        .join(","),
    )
    .join("|");
}

console.log("MuseLab 内核自检");
console.log("=".repeat(48));

/* ---------------------------------------------------------------- 示例工程 */
console.log("\n[1] 示例工程");
const demo = demoScore();
ok(demo.tracks.length === 3, "示例应有 3 条轨道");
ok(measureCount(demo) === 8, `示例应为 8 小节（实际 ${measureCount(demo)}）`);
ok(scoreEnd(demo) === 32, `示例总长应为 32 拍（实际 ${scoreEnd(demo)}）`);
ok(demo.tempo === 72, "示例速度 72");
ok(abcBarCheck(demo).length === 0, "示例不应有小节不齐的告警");
const demoRound = roundTripCheck(demo);
ok(demoRound.ok, `示例 ABC 往返一致（${demoRound.error ?? "ok"}）`);

/* ------------------------------------------------------- 24 个调 × 5 种风格 */
console.log("\n[2] 24 个调 × 5 种风格：作曲 → ABC 往返");
for (let tonic = 0; tonic < 12; tonic++) {
  for (const mode of ["major", "minor"] as const) {
    for (const style of STYLES) {
      const s = compose({
        brief: "自检",
        style: style.id,
        key: { tonic, mode },
        bars: 4,
        tempo: 90,
        seed: tonic * 31 + (mode === "major" ? 7 : 13),
        withBand: true,
      });
      const label = `${keyLabel({ tonic, mode })} / ${style.label}`;
      ok(scoreEnd(s) === 16, `${label}：总长 16 拍（实际 ${scoreEnd(s)}）`);
      const t = timingMultiset(s);
      const abc = toAbc(s);
      let back: Score;
      try {
        back = parseAbc(abc, s.title).score;
      } catch (e) {
        ok(false, `${label}：ABC 回读失败 ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      eq(pitchMultiset(back), pitchMultiset(s), `${label}：ABC 往返音高一致`);
      eq(timingMultiset(back), t, `${label}：ABC 往返时值一致`);
    }
  }
}

/* ------------------------------------------------------------- MusicXML */
console.log("\n[3] MusicXML 往返（8 个代表调）");
const xmlKeys: { tonic: number; mode: "major" | "minor" }[] = [
  { tonic: 0, mode: "major" },
  { tonic: 7, mode: "major" },
  { tonic: 5, mode: "major" },
  { tonic: 2, mode: "major" },
  { tonic: 9, mode: "minor" },
  { tonic: 4, mode: "minor" },
  { tonic: 11, mode: "major" },
  { tonic: 6, mode: "major" },
];
for (const k of xmlKeys) {
  const s = compose({ brief: "自检", style: "ballad", key: k, bars: 4, tempo: 80, seed: 99, withBand: true });
  const xml = toMusicXml(s);
  ok(xml.includes("<score-partwise"), `${keyLabel(k)}：MusicXML 头正确`);
  const { score: back } = fromMusicXml(xml);
  eq(pitchMultiset(back), pitchMultiset(s), `${keyLabel(k)}：MusicXML 往返音高一致`);
  eq(timingMultiset(back), timingMultiset(s), `${keyLabel(k)}：MusicXML 往返时值一致`);
  eq(back.key, s.key, `${keyLabel(k)}：调号带回`);
}

/* ----------------------------------------------------------------- MIDI */
console.log("\n[4] MIDI 往返");
{
  const s = compose({ brief: "自检", style: "pop", key: { tonic: 0, mode: "major" }, bars: 4, tempo: 104, seed: 5, withBand: true });
  const bytes = toMidiBytes(s);
  ok(bytes.length > 100, `MIDI 字节数合理（${bytes.length}）`);
  ok(bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64, "MIDI 以 MThd 开头");
  const { score: back } = fromMidiBytes(bytes);
  eq(back.tracks.length, s.tracks.length, "MIDI 轨道数保持");
  eq(pitchMultiset(back), pitchMultiset(s), "MIDI 往返音高一致");
  eq(back.time, s.time, "MIDI 拍号保持");
  ok(Math.abs(back.tempo - s.tempo) < 1, `MIDI 速度保持（${back.tempo} vs ${s.tempo}）`);
}

/* ---------------------------------------------------------------- 简谱 */
console.log("\n[5] 简谱排版模型");
{
  for (const style of STYLES) {
    const s = compose({ brief: "自检", style: style.id, key: { tonic: 7, mode: "major" }, bars: 4, tempo: 80, seed: 3, withBand: true });
    for (let ti = 0; ti < s.tracks.length; ti++) {
      const layout = buildJianpu(s, ti);
      const segs = splitAtBarlines(s.tracks[ti].notes, beatsPerMeasure(s));
      // 一个"段"就是谱面上一个纵列（和弦算一段），所以比段数而不是比记号数
      const chords = layout.measures.flatMap((m) => m.chords);
      const tokens = chords.flatMap((c) => c.tokens);
      eq(chords.length, segs.length, `${style.label} 轨 ${ti + 1}：每段都有简谱记号`);
      ok(tokens.length >= chords.length, `${style.label} 轨 ${ti + 1}：每段至少一枚记号`);
      ok(
        tokens.every((t) => (t.digit >= 0 && t.digit <= 7) && t.underlines <= 2 && t.dashes <= 7),
        `${style.label} 轨 ${ti + 1}：记号取值在合法范围`,
      );
      ok(
        tokens.every((t) => Math.abs(t.octaveDots) <= 2),
        `${style.label} 轨 ${ti + 1}：八度点不超过两个`,
      );
    }
  }
}

/* --------------------------------------------------------------- 乐理 */
console.log("\n[6] 和弦识别");
{
  eq(identifyChord([60, 64, 67])?.label, "C", "C-E-G 认成 C");
  eq(identifyChord([60, 63, 67])?.label, "Cm", "C-Eb-G 认成 Cm");
  eq(identifyChord([62, 65, 69])?.label, "Dm", "D-F-A 认成 Dm");
  const timeline = chordTimeline(compose({ brief: "", style: "pop", key: { tonic: 0, mode: "major" }, bars: 4, tempo: 100, seed: 1, withBand: true }));
  ok(timeline.length >= 3, `和弦时间线至少识别出 3 个小节（实际 ${timeline.length}）`);
}

/* -------------------------------------------------------------- 错误信息 */
console.log("\n[7] 错误信息能不能指到位置");
{
  let msg = "";
  try {
    parseAbc("X:1\nM:4/4\nL:1/4\nK:C\nC D E | Q4 |", "t");
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.includes("第 2 小节"), `ABC 报错带小节号（"${msg}"）`);
  ok(msg.includes("Q"), "ABC 报错指出具体记号");
  try {
    parseScore({ v: 1, time: [4, 4], tempo: 88, tracks: [{ notes: [{ start: 0, dur: 0, pitch: 60 }] }] });
    ok(false, "dur=0 应被拒绝");
  } catch (e) {
    ok(e instanceof MusicError && e.message.includes("dur"), "dur=0 被拒绝且说明字段");
  }
}

/* --------------------------------------------------------- AI 输出清洗 */
console.log("\n[8] AI 回复清洗");
{
  const raw = "这是你要的曲子：\n```abc\nX:1\nT:测试\nM:4/4\nL:1/4\nK:C\nC4 |\n```\n希望你喜欢！";
  const cleaned = extractAbc(raw);
  ok(cleaned.startsWith("X:1"), "从 Markdown 代码块里抠出 ABC");
  ok(!cleaned.includes("希望"), "去掉前后废话");
  const { score, warnings } = parseAbc(cleaned, "t");
  ok(score.tracks[0].notes.filter((n) => n.pitch >= 0).length === 1, "清洗后的 ABC 能解析");
  eq(warnings.length, 0, "不该有告警");
}

/* ------------------------------------------------------------ 序列化 */
console.log("\n[9] 工程序列化");
{
  const s = demoScore();
  const text = serializeScore(s);
  const back = parseScore(JSON.parse(text));
  eq(timingMultiset(back), timingMultiset(s), "工程 JSON 往返一致");
  ok(text.includes('"v": 1'), "工程文件带格式版本号");
  ok(!text.includes("apiKey"), "工程文件里不含任何 API Key 字段");
}

console.log("\n" + "=".repeat(48));
if (failures === 0) {
  console.log(`✓ 全部通过：${checks} 项断言`);
} else {
  console.error(`✗ ${failures} / ${checks} 项失败：`);
  for (const f of failed.slice(0, 20)) console.error(`  - ${f}`);
  process.exitCode = 1;
}
