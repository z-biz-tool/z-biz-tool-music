/**
 * 内核单测（node --test，零依赖）。
 *
 * 只测纯函数：乐谱 IR、ABC 读写、MusicXML 读写、简谱排版模型、乐理、规则作曲。
 * 渲染与音频不在这里测（拿不到像素和耳朵），它们的验收放在 scripts/verify.ts 的
 * 结构断言和人工走查里。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MusicError,
  beatsPerMeasure,
  emptyScore,
  measureCount,
  midiOf,
  newNote,
  newTrack,
  parseScore,
  pitchName,
  scoreEnd,
  serializeScore,
  splitByMeasure,
  type Score,
} from "../src/core/model.ts";
import { abcLengthOf, abcPitchOf, chordGroups, parseAbc, roundTripCheck, splitAtBarlines, toAbc } from "../src/core/abc.ts";
import { buildJianpu, degreeOf, jianpuDuration } from "../src/core/jianpu.ts";
import { fromMusicXml, toMusicXml } from "../src/core/musicxml.ts";
import { accidentalCount, chordPitches, keyLabel, romanChord, scalePitchClasses, snapToKey, spellPitch } from "../src/core/theory.ts";
import { compose, styleSpec } from "../src/core/compose.ts";
import { demoScore } from "../src/core/demo.ts";

test("IR：拍号换算与小节数", () => {
  const s: Score = { ...emptyScore(), time: [6, 8] };
  assert.equal(beatsPerMeasure(s), 3);
  const s2: Score = { ...emptyScore(), time: [3, 4] };
  assert.equal(beatsPerMeasure(s2), 3);
  const notes = [newNote({ start: 0, dur: 1, pitch: 60 }), newNote({ start: 9, dur: 1, pitch: 62 })];
  const withNotes: Score = { ...s2, tracks: [newTrack({ notes })] };
  assert.equal(scoreEnd(withNotes), 10);
  assert.equal(measureCount(withNotes), 4); // 10 拍 / 每小节 3 拍
});

test("IR：音名与 MIDI 互转", () => {
  assert.equal(midiOf("C4"), 60);
  assert.equal(midiOf("A4"), 69);
  assert.equal(midiOf("F#3"), 54);
  assert.equal(midiOf("Bb5"), 82);
  assert.equal(midiOf("H4"), null);
  assert.equal(pitchName(60), "C4");
  assert.equal(pitchName(-1), "休止");
});

test("IR：parseScore 拒绝坏数据并给出可读原因", () => {
  assert.throws(() => parseScore(null), MusicError);
  assert.throws(() => parseScore({ v: 2 }), /版本不支持/);
  assert.throws(() => parseScore({ v: 1, time: [0, 4], tracks: [] }), /拍号/);
  assert.throws(
    () => parseScore({ v: 1, time: [4, 4], tempo: 88, tracks: [{ notes: [{ start: -1, dur: 1, pitch: 60 }] }] }),
    /start 非法/,
  );
});

test("IR：序列化后可原样读回", () => {
  const s = demoScore();
  const back = parseScore(JSON.parse(serializeScore(s)));
  assert.equal(back.tracks.length, s.tracks.length);
  assert.equal(back.tempo, s.tempo);
  assert.equal(back.time.join("/"), s.time.join("/"));
  for (let i = 0; i < s.tracks.length; i++) {
    assert.equal(back.tracks[i].notes.length, s.tracks[i].notes.length);
    assert.deepEqual(
      back.tracks[i].notes.map((n) => [n.start, n.dur, n.pitch]),
      s.tracks[i].notes.map((n) => [n.start, n.dur, n.pitch]),
    );
  }
});

test("IR：splitByMeasure 把小节切齐", () => {
  const s = demoScore();
  const parts = splitByMeasure(s, s.tracks[0]);
  assert.equal(parts.length, measureCount(s));
  const melody = s.tracks[0].notes.filter((n) => n.pitch >= 0).length;
  assert.equal(parts.reduce((a, p) => a + p.filter((n) => n.pitch >= 0).length, 0), melody);
});

test("ABC：音高拼写跟着调号走", () => {
  // C 大调：62 = D4 → D；F# 在调外要显式写升号
  assert.equal(abcPitchOf(62, 0, "major"), "D");
  assert.equal(abcPitchOf(66, 0, "major"), "^F");
  // G 大调里 F# 是调内音，不该再带升号
  assert.equal(abcPitchOf(66, 7, "major"), "F");
  assert.equal(abcPitchOf(60, 0, "major"), "C");
  assert.equal(abcPitchOf(72, 0, "major"), "c");
  assert.equal(abcPitchOf(48, 0, "major"), "C,");
});

test("ABC：时值后缀", () => {
  assert.equal(abcLengthOf(1), "");
  assert.equal(abcLengthOf(2), "2");
  assert.equal(abcLengthOf(4), "4");
  assert.equal(abcLengthOf(0.5), "/2");
  assert.equal(abcLengthOf(0.25), "/4");
  assert.equal(abcLengthOf(1.5), "3/2");
  assert.equal(abcLengthOf(0.75), "3/4");
});

test("ABC：和弦分组只合并同时值的音", () => {
  const notes = [
    newNote({ start: 0, dur: 1, pitch: 60 }),
    newNote({ start: 0, dur: 1, pitch: 64 }),
    newNote({ start: 0, dur: 2, pitch: 67 }),
    newNote({ start: 2, dur: 1, pitch: 72 }),
  ];
  const groups = chordGroups(notes);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].length, 2);
});

test("ABC：跨小节的音会被切开并连起来", () => {
  const notes = [newNote({ start: 3, dur: 2, pitch: 60 })];
  const segs = splitAtBarlines(notes, 4);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].dur, 1);
  assert.equal(segs[1].start, 4);
  assert.equal(segs[1].notes[0].tie, true);
});

test("ABC：示例工程往返一致", () => {
  const s = demoScore();
  const r = roundTripCheck(s);
  assert.equal(r.ok, true, r.error);
  const abc = toAbc(s);
  assert.match(abc, /^X:1/m);
  assert.match(abc, /%%score \{1 2 3\}/);
  const back = parseAbc(abc, s.title);
  assert.equal(back.warnings.length, 0);
  assert.equal(back.score.tracks.length, 3);
});

test("ABC：调号作用于没写升降号的音", () => {
  const { score } = parseAbc("X:1\nT:t\nM:4/4\nL:1/4\nK:G\nF E D C |", "t");
  const pitches = score.tracks[0].notes.filter((n) => n.pitch >= 0).map((n) => n.pitch);
  assert.deepEqual(pitches, [66, 64, 62, 60]);
});

test("ABC：同小节临时升降号沿用，过小节线清零", () => {
  const { score } = parseAbc("X:1\nT:t\nM:4/4\nL:1/4\nK:C\n^F F F F | F4 |", "t");
  const pitches = score.tracks[0].notes.filter((n) => n.pitch >= 0).map((n) => n.pitch);
  assert.deepEqual(pitches, [66, 66, 66, 66, 65]);
});

test("ABC：语法错误指到具体小节", () => {
  assert.throws(() => parseAbc("X:1\nM:4/4\nL:1/4\nK:C\nC D E | H |", "t"), /第 2 小节/);
  assert.throws(() => parseAbc("X:1\nM:4/4\nL:1/4\nK:C\n{AB}c4 |", "t"), /装饰音/);
});

test("ABC：休止与和弦能读", () => {
  const { score } = parseAbc("X:1\nT:t\nM:4/4\nL:1/4\nK:C\nz [CEG] z2 z |", "t");
  const notes = score.tracks[0].notes;
  assert.equal(notes.filter((n) => n.pitch >= 0).length, 3);
  assert.equal(notes.filter((n) => n.pitch < 0).length, 3);
});

test("MusicXML：导出结构完整", () => {
  const s = demoScore();
  const xml = toMusicXml(s);
  assert.match(xml, /<score-partwise version="4.0">/);
  assert.match(xml, /<divisions>12<\/divisions>/);
  assert.match(xml, /<work-title>/);
  assert.equal((xml.match(/<part id=/g) ?? []).length, s.tracks.length);
  assert.equal((xml.match(/<measure number=/g) ?? []).length, s.tracks.length * measureCount(s));
  // 钢琴轨是大谱表：要有 backup 把游标退回去再写低音谱表
  assert.match(xml, /<backup>/);
});

test("MusicXML：导出再导入，音高与音符数保持", () => {
  const s = demoScore();
  const { score } = fromMusicXml(toMusicXml(s));
  assert.equal(score.tracks.length, s.tracks.length);
  const flat = (x: Score) =>
    x.tracks.map((t) => t.notes.filter((n) => n.pitch >= 0).map((n) => n.pitch).sort((a, b) => a - b).join(",")).join("|");
  assert.equal(flat(score), flat(s));
  assert.equal(score.tempo, s.tempo);
  assert.deepEqual(score.time, s.time);
});

test("MusicXML：拼法在调内优先用调号字母", () => {
  const sp = spellPitch(66, { tonic: 7, mode: "major" } as const); // G 大调里的 F#
  assert.equal(sp.step, "F");
  assert.equal(sp.alter, 1);
  assert.equal(sp.octave, 4);
});

test("简谱：级数与八度点", () => {
  assert.deepEqual(degreeOf(60, 0, "major"), { digit: 1, accidental: 0 }); // C4
  assert.deepEqual(degreeOf(72, 0, "major"), { digit: 1, accidental: 0 }); // C5
  assert.deepEqual(degreeOf(62, 0, "major"), { digit: 2, accidental: 0 });
  assert.deepEqual(degreeOf(66, 0, "major"), { digit: 4, accidental: 1 }); // F#
});

test("简谱：时值记法", () => {
  assert.deepEqual(jianpuDuration(1), { underlines: 0, dashes: 0, dots: 0, exact: true });
  assert.deepEqual(jianpuDuration(0.5), { underlines: 1, dashes: 0, dots: 0, exact: true });
  assert.deepEqual(jianpuDuration(0.25), { underlines: 2, dashes: 0, dots: 0, exact: true });
  assert.deepEqual(jianpuDuration(2), { underlines: 0, dashes: 1, dots: 0, exact: true });
  assert.deepEqual(jianpuDuration(4), { underlines: 0, dashes: 3, dots: 0, exact: true });
  assert.equal(jianpuDuration(1.5).dots, 1);
  assert.equal(jianpuDuration(1 / 3).exact, false);
});

test("简谱：示例工程每小节都有内容，音数与五线谱一致", () => {
  const s = demoScore();
  const layout = buildJianpu(s, 0);
  assert.equal(layout.measures.length, measureCount(s));
  const tokens = layout.measures.flatMap((m) => m.chords.flatMap((c) => c.tokens));
  assert.equal(tokens.length, splitAtBarlines(s.tracks[0].notes, beatsPerMeasure(s)).length);
  assert.ok(tokens.every((t) => Math.abs(t.octaveDots) <= 2), "示例的音域不该出现三个八度点");
});

test("简谱：八度点跟着音高走，且按轨自己选中音区", () => {
  // 同一条轨上放 C3 C4 C5 C6：八度点必须逐个加一，不能跳号也不能整体跑偏
  const notes = [48, 60, 72, 84].map((p, i) => newNote({ start: i, dur: 1, pitch: p }));
  const s: Score = { ...emptyScore(), time: [4, 4], tracks: [newTrack({ notes })] };
  const tokens = buildJianpu(s, 0).measures.flatMap((m) => m.chords.flatMap((c) => c.tokens));
  assert.deepEqual(
    tokens.map((t) => t.digit),
    [1, 1, 1, 1],
  );
  const dots = tokens.map((t) => t.octaveDots);
  assert.deepEqual(
    dots.slice(1).map((d, i) => d - dots[i]),
    [1, 1, 1],
  );
  // 低音谱那一路：C2 一带仍然只用一个下方的点，不是三个
  const bassNotes = [36, 43, 48].map((p, i) => newNote({ start: i, dur: 1, pitch: p }));
  const bass: Score = { ...emptyScore(), time: [4, 4], tracks: [newTrack({ notes: bassNotes })] };
  const bassTokens = buildJianpu(bass, 0).measures.flatMap((m) => m.chords.flatMap((c) => c.tokens));
  assert.ok(bassTokens.every((t) => Math.abs(t.octaveDots) <= 2), "低音轨的八度点也要在 ±2 以内");
});

test("乐理：调号、音阶、和弦", () => {
  assert.equal(accidentalCount({ tonic: 0, mode: "major" } as const), 0);
  assert.equal(accidentalCount({ tonic: 7, mode: "major" } as const), 1);
  assert.equal(accidentalCount({ tonic: 5, mode: "major" } as const), -1);
  assert.equal(accidentalCount({ tonic: 9, mode: "minor" } as const), 0); // a 小调
  assert.deepEqual(scalePitchClasses({ tonic: 0, mode: "major" } as const), [0, 2, 4, 5, 7, 9, 11]);
  assert.equal(keyLabel({ tonic: 0, mode: "major" } as const), "C 大调");
  const iv = romanChord("IV", { tonic: 0, mode: "major" } as const);
  assert.deepEqual(iv, { root: 5, quality: "maj" });
  const vi = romanChord("vi", { tonic: 0, mode: "major" } as const);
  assert.deepEqual(vi, { root: 9, quality: "min" });
  assert.deepEqual(chordPitches({ root: 0, quality: "maj" }, 4), [60, 64, 67]);
});

test("乐理：不在调内的音被拉回来", () => {
  const key = { tonic: 0, mode: "major" } as const;
  assert.equal(snapToKey(61, key), 60); // C# → C
  assert.equal(snapToKey(60, key), 60);
  assert.equal(snapToKey(66, key), 65); // F# → F
});

test("作曲：长度、音域、确定性", () => {
  const spec = styleSpec("ballad");
  const opts = {
    brief: "测试",
    style: "ballad" as const,
    key: { tonic: 0, mode: "major" as const },
    bars: 8,
    tempo: 72,
    seed: 42,
    withBand: true,
  };
  const a = compose(opts);
  const b = compose(opts);
  assert.equal(a.tracks.length, 3);
  assert.deepEqual(
    a.tracks.map((t) => t.notes.map((n) => [n.start, n.dur, n.pitch])),
    b.tracks.map((t) => t.notes.map((n) => [n.start, n.dur, n.pitch])),
    "同一 seed 必须给出同一首曲子",
  );
  assert.equal(scoreEnd(a), 32); // 8 小节 × 4 拍
  for (const n of a.tracks[0].notes) {
    assert.ok(n.pitch >= spec.center - 7 && n.pitch <= spec.center + 12, `旋律越界：${n.pitch}`);
    assert.ok(n.pitch >= 0);
  }
  const c = compose({ ...opts, seed: 43 });
  assert.notDeepEqual(
    c.tracks[0].notes.map((n) => n.pitch),
    a.tracks[0].notes.map((n) => n.pitch),
  );
});

test("作曲：所有音的时值都落在 1/16 网格上", () => {
  const s = compose({
    brief: "",
    style: "pop",
    key: { tonic: 2, mode: "minor" },
    bars: 4,
    tempo: 100,
    seed: 7,
    withBand: true,
  });
  for (const t of s.tracks) {
    for (const n of t.notes) {
      assert.ok(Math.abs(n.start * 4 - Math.round(n.start * 4)) < 1e-9, `start 不在网格上：${n.start}`);
      assert.ok(Math.abs(n.dur * 4 - Math.round(n.dur * 4)) < 1e-9, `dur 不在网格上：${n.dur}`);
    }
  }
});
