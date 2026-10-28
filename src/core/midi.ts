/**
 * MIDI 读写。
 *
 * 导入用 @tonejs/midi（成熟、MIT），导出也用它——不自己手写 SMF 是因为
 * 变长量、running status、tempo map 这些小坑自己实现一遍没有收益，
 * 而导出结果要能被 Logic / MuseScore / Cubase 打开，用经过验证的实现更稳。
 */

import * as MidiPkg from "@tonejs/midi";
import { MusicError, newNote, newTrack, trackColor, type Score, type Track } from "./model.ts";
import { instrumentSpec } from "./theory.ts";

/**
 * @tonejs/midi 的入口是 CJS（main = build/Midi.js，module = dist/Midi.js），
 * 不同打包器/运行时给的形态不一样：
 *   - Vite（浏览器）：具名导出可用
 *   - Node ESM 直接跑 TS：只有 default，具名导出不存在
 * 所以这里两种形态都取一遍，取不到才报错——而不是让 `new Midi()` 变成
 * "Midi is not a constructor" 这种看不懂的堆栈。
 */
type MidiInstance = {
  header: {
    ppq: number;
    tempos: { bpm: number }[];
    timeSignatures: { timeSignature: number[]; ticks: number; measures: number }[];
    keySignatures: { key: string }[];
    setTempo: (bpm: number) => void;
    update: () => void;
  };
  name: string;
  tracks: MidiTrack[];
  addTrack: () => MidiTrack;
  toArray: () => Uint8Array;
};
type MidiTrack = {
  name: string;
  channel: number;
  instrument: { number: number; percussion?: boolean };
  notes: { midi: number; ticks: number; durationTicks: number; velocity: number }[];
  addNote: (n: { midi: number; ticks: number; durationTicks: number; velocity: number }) => void;
};
type MidiCtor = new (bytes?: Uint8Array) => MidiInstance;

const pkg = MidiPkg as unknown as { Midi?: MidiCtor; default?: { Midi?: MidiCtor } };
const MidiClass: MidiCtor | undefined = pkg.Midi ?? pkg.default?.Midi;
function MidiCtorOrThrow(): MidiCtor {
  if (!MidiClass) throw new MusicError("找不到 @tonejs/midi 的 Midi 导出，可能是依赖版本变了");
  return MidiClass;
}

/** Score → MIDI 字节 */
export function toMidiBytes(score: Score): Uint8Array {
  const Midi = MidiCtorOrThrow();
  const midi = new Midi();
  midi.header.setTempo(score.tempo);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: [score.time[0], score.time[1]], measures: 0 }];
  midi.header.update();
  const ppq = midi.header.ppq;
  score.tracks.forEach((track, ti) => {
    const t = midi.addTrack();
    t.name = track.name;
    // GM 第 10 通道（0 基的 9）固定是打击乐
    t.channel = track.instrument === "drums" ? 9 : ti % 15;
    t.instrument.number = instrumentSpec(track.instrument).program;
    for (const note of track.notes) {
      if (note.pitch < 0 || note.dur <= 0) continue;
      t.addNote({
        midi: Math.max(0, Math.min(127, note.pitch)),
        ticks: Math.round(note.start * ppq),
        durationTicks: Math.max(1, Math.round(note.dur * ppq)),
        velocity: Math.max(0.05, Math.min(1, note.vel / 127)),
      });
    }
  });
  return midi.toArray();
}

/** MIDI 字节 → Score */
export function fromMidiBytes(bytes: Uint8Array): { score: Score; warnings: string[] } {
  const Midi = MidiCtorOrThrow();
  let midi: MidiInstance;
  try {
    midi = new Midi(bytes);
  } catch (e) {
    throw new MusicError(`MIDI 读取失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const warnings: string[] = [];
  const ppq = midi.header.ppq || 480;
  const tempo = Math.round(midi.header.tempos[0]?.bpm ?? 100);
  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const keyName = midi.header.keySignatures[0]?.key;
  const key = keyFromName(keyName);
  const tracks: Track[] = [];
  midi.tracks.forEach((t, ti) => {
    if (t.notes.length === 0) return;
    const notes = t.notes.map((n) =>
      newNote({
        start: Math.round((n.ticks / ppq) * 1000) / 1000,
        dur: Math.max(1 / 16, Math.round((n.durationTicks / ppq) * 1000) / 1000),
        pitch: n.midi,
        vel: Math.max(1, Math.min(127, Math.round(n.velocity * 127))),
      }),
    );
    tracks.push(
      newTrack({
        name: t.name || `轨道 ${ti + 1}`,
        instrument: t.instrument.percussion ? "drums" : guessInstrument(t.instrument.number),
        program: t.instrument.number,
        clef: ti === 0 ? "grand" : "treble",
        color: trackColor(tracks.length),
        notes,
      }),
    );
  });
  if (tracks.length === 0) throw new MusicError("MIDI 里没有音符");
  if (tracks.length > 1) warnings.push(`MIDI 含 ${tracks.length} 条轨道，已全部导入`);
  return {
    score: {
      v: 1,
      title: midi.name || "导入的 MIDI",
      key,
      time: [ts[0], ts[1]],
      tempo: Math.min(300, Math.max(20, tempo)),
      tracks,
      meta: { origin: "import" },
    },
    warnings,
  };
}

function keyFromName(name: string | undefined): { tonic: number; mode: "major" | "minor" } {
  if (!name) return { tonic: 0, mode: "major" };
  const m = /^([A-G])([#b]?)(m?)$/.exec(name);
  if (!m) return { tonic: 0, mode: "major" };
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return { tonic: (((base[m[1]] + acc) % 12) + 12) % 12, mode: m[3] ? "minor" : "major" };
}

function guessInstrument(program: number): Track["instrument"] {
  if (program <= 3) return "piano";
  if (program <= 7) return "epiano";
  if (program <= 15) return "epiano";
  if (program <= 23) return "organ";
  if (program <= 31) return "guitar";
  if (program <= 39) return "bass";
  if (program <= 47) return "strings";
  if (program <= 55) return "strings";
  if (program <= 63) return "brass";
  if (program <= 79) return "reed";
  if (program <= 87) return "synth";
  return "pad";
}
