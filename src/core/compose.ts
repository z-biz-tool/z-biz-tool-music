/**
 * 规则作曲器（本地算法，不需要任何 AI Key）。
 *
 * 它的存在有两层意义：
 *   1) 产品在没配 Key、没网、断网的机器上也真的能"从头到尾造出一首曲子"；
 *   2) AI 失败时有一个诚实的降级路径——用户看到的标注是「本地算法」而不是假装 AI。
 *
 * 做法是老老实实的动机发展：定和弦进行 → 定节奏型 → 按强拍靠和弦音、弱拍走音阶的方式
 * 生成旋律 → 加低音与伴奏织体。确定性随机（seed），同一个 seed 出同一首曲子，
 * 这样用户点"再来一版"才有意义（换 seed 才是新曲子）。
 */

import {
  beatsPerMeasure,
  newNote,
  newTrack,
  sortNotes,
  trackColor,
  uid,
  type KeySig,
  type Note,
  type Score,
  type Track,
} from "./model.ts";
import { PROGRESSIONS, chordPitches, chordLabel, progressionChords, scalePitchClasses, type Chord } from "./theory.ts";

export type StyleId = "ballad" | "pop" | "children" | "cinematic" | "jazz";

export interface StyleSpec {
  id: StyleId;
  label: string;
  hint: string;
  /** 旋律音色 */
  lead: Track["instrument"];
  /** 伴奏音色 */
  comp: Track["instrument"];
  tempo: [number, number];
  progression: string;
  /** 旋律节奏型（单位：拍，总和 = 一小节拍数）；用 [d1,d2,…] 表示 */
  rhythms: number[][];
  /** 旋律的中心音（MIDI），不同风格音区不同 */
  center: number;
}

export const STYLES: StyleSpec[] = [
  {
    id: "ballad",
    label: "钢琴小品",
    hint: "缓慢、抒情、琶音伴奏",
    lead: "pipe",
    comp: "piano",
    tempo: [66, 84],
    progression: "流行四和弦",
    rhythms: [
      [2, 2],
      [1.5, 0.5, 2],
      [2, 1, 1],
      [1, 1, 1, 1],
      [3, 1],
    ],
    center: 74,
  },
  {
    id: "pop",
    label: "流行歌",
    hint: "方整、好记、适合配唱",
    lead: "synth",
    comp: "epiano",
    tempo: [92, 116],
    progression: "五十年代",
    rhythms: [
      [1, 1, 1, 1],
      [1.5, 0.5, 1, 1],
      [0.5, 0.5, 1, 1, 1],
      [2, 1, 1],
    ],
    center: 72,
  },
  {
    id: "children",
    label: "儿歌",
    hint: "跳进少、重复多、音域窄",
    lead: "pipe",
    comp: "piano",
    tempo: [96, 120],
    progression: "流行四和弦",
    rhythms: [
      [1, 1, 2],
      [1, 1, 1, 1],
      [2, 1, 1],
      [1, 1, 1, 1],
    ],
    center: 72,
  },
  {
    id: "cinematic",
    label: "电影配乐",
    hint: "长音铺陈、弦乐与低音",
    lead: "strings",
    comp: "pad",
    tempo: [56, 72],
    progression: "小调悲歌",
    rhythms: [
      [4],
      [2, 2],
      [3, 1],
      [1.5, 0.5, 2],
    ],
    center: 69,
  },
  {
    id: "jazz",
    label: "爵士",
    hint: "七和弦、走动低音",
    lead: "reed",
    comp: "piano",
    tempo: [100, 132],
    progression: "爵士 251",
    rhythms: [
      [1.5, 0.5, 1, 1],
      [0.5, 0.5, 0.5, 0.5, 1, 1],
      [1, 0.5, 0.5, 2],
      [2, 0.5, 0.5, 1],
    ],
    center: 70,
  },
];

export function styleSpec(id: StyleId): StyleSpec {
  return STYLES.find((s) => s.id === id) ?? STYLES[0];
}

export interface ComposeOptions {
  /** 一句话要求，只写进工程元信息，不参与算法（算法不看语义，别骗用户） */
  brief: string;
  style: StyleId;
  key: KeySig;
  bars: number;
  tempo: number;
  seed: number;
  title?: string;
  /** 是否生成伴奏与低音 */
  withBand: boolean;
}

/** mulberry32：小而稳的确定性随机 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nearest(pool: number[], target: number): number {
  let best = pool[0];
  let bestD = Math.abs(best - target);
  for (const p of pool) {
    const d = Math.abs(p - target);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** 在 [lo,hi] 内按音级铺满某音级集合 */
function poolIn(pcs: number[], lo: number, hi: number, prefer: number): number[] {
  const out: number[] = [];
  const start = Math.floor(lo / 12) * 12;
  for (let m = start; m <= hi + 12; m++) {
    if (pcs.includes(((m % 12) + 12) % 12) && m >= lo && m <= hi) out.push(m);
  }
  if (out.length === 0) return [prefer];
  return out;
}

interface MelodyCell {
  bar: number;
  rhythm: number[];
  /** 相对音高轮廓（半音偏移），0 = 停留 */
  contour: number[];
}

export function compose(opts: ComposeOptions): Score {
  const spec = styleSpec(opts.style);
  const rand = rng(opts.seed);
  const key = opts.key;
  const bars = Math.max(2, Math.round(opts.bars));
  const time: [number, number] = [4, 4];
  const beats = beatsPerMeasure({ time });
  const tempo = Math.min(300, Math.max(20, Math.round(opts.tempo || (spec.tempo[0] + spec.tempo[1]) / 2)));
  const progName = PROGRESSIONS.find((p) => p.name === spec.progression) ?? PROGRESSIONS[0];
  const chords = progressionChords(progName, key, bars);

  /* ---- 1. 节奏与动机：两小节一个动机，第 3-4 小节变化重复 ---- */
  const rhythms = spec.rhythms.filter((r) => Math.abs(r.reduce((a, b) => a + b, 0) - beats) < 1e-6);
  const usable = rhythms.length > 0 ? rhythms : [[1, 1, 1, 1]];
  const cells: MelodyCell[] = [];
  const motifLen = 2;
  const motif: MelodyCell[] = [];
  for (let i = 0; i < motifLen; i++) {
    const rhythm = usable[Math.floor(rand() * usable.length)];
    const contour = rhythm.map((_, k) => {
      const arc = i === 0 ? 1 : -1;
      if (k === 0) return arc * (1 + Math.floor(rand() * 2));
      const r = rand();
      if (r < 0.45) return arc;
      if (r < 0.75) return -arc;
      if (r < 0.9) return 2 * arc;
      return 0;
    });
    motif.push({ bar: i, rhythm, contour });
  }
  for (let bar = 0; bar < bars; bar++) {
    const m = motif[bar % motifLen];
    // 每 4 小节收尾一次：把最后两拍并成一个长音，让乐句有呼吸
    if ((bar + 1) % 4 === 0 && m.rhythm.length > 1) {
      const rhythm = [...m.rhythm.slice(0, -2), m.rhythm[m.rhythm.length - 1] + m.rhythm[m.rhythm.length - 2]];
      cells.push({ bar, rhythm, contour: [...m.contour.slice(0, -2), 0] });
    } else {
      cells.push({ bar, rhythm: m.rhythm, contour: m.contour });
    }
  }

  /* ---- 2. 旋律落地：强拍靠和弦音，弱拍走音阶 ---- */
  const scale = scalePitchClasses(key);
  const melodyNotes: Note[] = [];
  const lo = spec.center - 7;
  const hi = spec.center + 12;
  let prev = spec.center;
  for (const cell of cells) {
    const chord = chords[cell.bar] ?? chords[0];
    let beat = cell.bar * beats;
    cell.rhythm.forEach((dur, k) => {
      const strong = Math.abs(beat % beats) < 1e-6 || Math.abs((beat % beats) - 2) < 1e-6;
      const tones = chordPitches(chord, Math.floor(spec.center / 12) - 1);
      const target = prev + (cell.contour[k] ?? 0);
      const pool = strong ? poolIn(tones.map((p) => ((p % 12) + 12) % 12), lo, hi, prev) : poolIn(scale, lo, hi, prev);
      let pitch = nearest(pool, target);
      // 避免长时间在同音上打转：同音连续超过两次就换一个邻近音
      const lastTwo = melodyNotes.slice(-2);
      if (lastTwo.length === 2 && lastTwo[0].pitch === pitch && lastTwo[1].pitch === pitch) {
        pitch = nearest(pool.filter((p) => p !== pitch), pitch + (rand() < 0.5 ? 2 : -2));
      }
      melodyNotes.push(
        newNote({
          start: beat,
          dur,
          pitch,
          vel: strong ? 96 : 80,
          ...(k === 0 ? { dyn: "mf" as const } : {}),
        }),
      );
      prev = pitch;
      beat += dur;
    });
  }

  /* ---- 3. 伴奏与低音 ---- */
  const compNotes: Note[] = [];
  const bassNotes: Note[] = [];
  const compCenter = Math.floor(spec.center / 12) * 12 - 12; // 中音区
  chords.forEach((chord, bar) => {
    const base = bar * beats;
    const tones = chordPitches(chord, 0).map((p) => ((p % 12) + 12) % 12);
    if (opts.style === "cinematic") {
      // 铺底：整小节和弦
      for (const pc of tones) {
        compNotes.push(newNote({ start: base, dur: beats, pitch: compCenter + pc, vel: 52 }));
      }
    } else if (opts.style === "jazz") {
      // 切分和弦：2、4 拍反拍
      for (const off of [0.5, 1.5, 2.5, 3.5]) {
        for (const pc of tones.slice(0, 4)) {
          compNotes.push(newNote({ start: base + off, dur: 0.5, pitch: compCenter + 12 + pc, vel: 60 }));
        }
      }
    } else {
      // 琶音（ballad / pop / children）：八分音符分解和弦
      const order = [tones[0], tones[2] ?? tones[1], tones[1], tones[2] ?? tones[1]];
      for (let i = 0; i < beats * 2; i++) {
        const pc = order[i % order.length];
        compNotes.push(
          newNote({ start: base + i * 0.5, dur: 0.5, pitch: compCenter + pc + (i % 4 === 0 ? 0 : 12), vel: i === 0 ? 64 : 48 }),
        );
      }
    }
    // 低音：根音 + 五音（爵士走四拍）
    const root = 36 + chord.root;
    if (opts.style === "jazz") {
      const walk = [0, 7, 12, 7];
      for (let i = 0; i < 4; i++) {
        bassNotes.push(newNote({ start: base + i, dur: 1, pitch: root + (i === 2 ? 5 : walk[i]), vel: 72 }));
      }
    } else {
      bassNotes.push(newNote({ start: base, dur: beats / 2, pitch: root, vel: 76 }));
      bassNotes.push(newNote({ start: base + beats / 2, dur: beats / 2, pitch: root + 7, vel: 64 }));
    }
  });

  const tracks: Track[] = [
    newTrack({
      name: "主旋律",
      instrument: spec.lead,
      program: 73,
      clef: spec.lead === "strings" ? "treble" : "treble",
      color: trackColor(0),
      volume: 0.85,
      notes: sortNotes(melodyNotes),
    }),
  ];
  if (opts.withBand) {
    tracks.push(
      newTrack({
        name: "伴奏",
        instrument: spec.comp,
        program: 0,
        clef: "grand",
        color: trackColor(1),
        volume: 0.55,
        pan: -0.15,
        notes: sortNotes(compNotes),
      }),
      newTrack({
        name: "低音",
        instrument: "bass",
        program: 33,
        clef: "bass",
        color: trackColor(2),
        volume: 0.7,
        pan: 0.1,
        notes: sortNotes(bassNotes),
      }),
    );
  }

  const chordLine = [...new Set(chords.map((c) => chordLabel(c, key.tonic === 5 || key.tonic === 10)))].join(" - ");
  return {
    v: 1,
    title: opts.title ?? `${spec.label} · ${chordLine}`,
    subtitle: `${progName.name}｜${bars} 小节`,
    composer: "MuseLab 本地算法",
    key,
    time,
    tempo,
    tracks,
    meta: { origin: "local", brief: opts.brief, created: new Date().toISOString() },
  };
}

/** 变奏：保持和声骨架，换节奏与音区（AI 不可用时的"再来一版"） */
export function vary(score: Score, seed: number): Score {
  const rand = rng(seed);
  return {
    ...score,
    tracks: score.tracks.map((t, ti) => {
      if (ti > 0) return t;
      const notes = t.notes.map((n) => {
        if (n.pitch < 0) return n;
        const shift = rand() < 0.3 ? (rand() < 0.5 ? 12 : -12) : 0;
        return { ...n, pitch: Math.max(24, Math.min(100, n.pitch + shift)) };
      });
      // 随机把相邻两个短音并成一个长音，制造节奏变化
      const merged: Note[] = [];
      for (let i = 0; i < notes.length; i++) {
        const cur = notes[i];
        const next = notes[i + 1];
        if (next && rand() < 0.18 && Math.abs(cur.start + cur.dur - next.start) < 1e-6) {
          merged.push({ ...cur, id: uid("n"), dur: cur.dur + next.dur });
          i++;
          continue;
        }
        merged.push(cur);
      }
      return { ...t, notes: sortNotes(merged) };
    }),
    meta: { ...(score.meta ?? {}), origin: "local", created: new Date().toISOString() },
  };
}

/** 供 UI 展示的和弦标签序列（按小节） */
export function chordTimeline(score: Score): { bar: number; label: string }[] {
  const beats = beatsPerMeasure(score);
  const bars = Math.max(1, Math.ceil(maxEnd(score) / beats));
  const found: { bar: number; label: string }[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const from = bar * beats;
    const to = from + beats;
    const pitches: number[] = [];
    for (const t of score.tracks) {
      for (const n of t.notes) {
        if (n.pitch >= 0 && n.start >= from - 1e-6 && n.start < to - 1e-6) pitches.push(n.pitch);
      }
    }
    if (pitches.length === 0) continue;
    // 只用强拍上的音，答案更稳
    const strong = pitches.slice(0, 8);
    const guess = guessChord(strong);
    if (guess) found.push({ bar: bar + 1, label: guess });
  }
  return found;
}

function maxEnd(score: Score): number {
  let end = 1;
  for (const t of score.tracks) for (const n of t.notes) end = Math.max(end, n.start + n.dur);
  return end;
}

function guessChord(pitches: number[]): string | null {
  const pcs = [...new Set(pitches.map((p) => ((p % 12) + 12) % 12))];
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const shapes: [string, number[]][] = [
    ["", [0, 4, 7]],
    ["m", [0, 3, 7]],
    ["7", [0, 4, 7, 10]],
    ["m7", [0, 3, 7, 10]],
    ["maj7", [0, 4, 7, 11]],
    ["dim", [0, 3, 6]],
  ];
  for (const root of pcs) {
    for (const [suffix, ivs] of shapes) {
      const set = ivs.map((i) => (root + i) % 12);
      if (set.every((pc) => pcs.includes(pc))) return `${names[root]}${suffix}`;
    }
  }
  return null;
}

export type { Chord };
