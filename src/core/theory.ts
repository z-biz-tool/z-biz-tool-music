/**
 * 乐理：调号、音阶、和弦、移调。
 *
 * 全部是纯函数，不碰 DOM，也不依赖任何乐理库——
 * 需求很窄（调号几个升降、某音在不在调内、罗马数字和弦怎么落地），
 * 引一个通用库反而要迁就它的命名体系。
 */

import type { InstrumentId, KeySig } from "./model.ts";

/* --------------------------------------------------------------- 音色族 */

export interface InstrumentSpec {
  id: InstrumentId;
  label: string;
  /** GM program（导出 MIDI 用） */
  program: number;
  /** 默认谱号 */
  clef: "treble" | "bass" | "grand";
  /** 建议音域，用于 AI 提示与越界提醒 */
  range: [number, number];
}

export const INSTRUMENTS: InstrumentSpec[] = [
  { id: "piano", label: "钢琴", program: 0, clef: "grand", range: [36, 96] },
  { id: "epiano", label: "电钢琴", program: 4, clef: "grand", range: [36, 96] },
  { id: "organ", label: "风琴", program: 19, clef: "grand", range: [36, 96] },
  { id: "guitar", label: "吉他", program: 25, clef: "treble", range: [40, 88] },
  { id: "bass", label: "贝斯", program: 33, clef: "bass", range: [28, 60] },
  { id: "strings", label: "弦乐", program: 48, clef: "treble", range: [36, 96] },
  { id: "brass", label: "铜管", program: 61, clef: "treble", range: [40, 88] },
  { id: "reed", label: "簧片", program: 71, clef: "treble", range: [48, 91] },
  { id: "pipe", label: "管乐", program: 73, clef: "treble", range: [60, 96] },
  { id: "synth", label: "合成主音", program: 80, clef: "treble", range: [36, 96] },
  { id: "pad", label: "铺底", program: 89, clef: "treble", range: [36, 96] },
  { id: "drums", label: "打击乐", program: 0, clef: "bass", range: [35, 81] },
];

export function instrumentSpec(id: InstrumentId): InstrumentSpec {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];
}

/* ----------------------------------------------------------------- 调号 */

const MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES = ["c", "c#", "d", "eb", "e", "f", "f#", "g", "g#", "a", "bb", "b"];

/** 大调各主音的升降号数（正=升，负=降）；小调按关系大调算 */
const MAJOR_FIFTHS: Record<number, number> = {
  0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 5: -1, 10: -2, 3: -3, 8: -4,
};

export function keyLabel(key: KeySig): string {
  return key.mode === "major" ? `${MAJOR_NAMES[key.tonic % 12]} 大调` : `${MINOR_NAMES[key.tonic % 12]} 小调`;
}

/** 调号升降数：正=升号数，负=降号数 */
export function accidentalCount(key: KeySig): number {
  const majorTonic = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  return MAJOR_FIFTHS[majorTonic] ?? 0;
}

/** ABC 头里的 K: 字段 */
export function abcKeyName(key: KeySig): string {
  const majorTonic = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  const name =
    accidentalCount(key) < 0
      ? ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"][majorTonic]
      : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][majorTonic];
  return key.mode === "major" ? name : `${name}m`;
}

/** MusicXML 的 fifths 值 = 升降号数 */
export function musicXmlFifths(key: KeySig): number {
  return accidentalCount(key);
}

/** 大调/小调音阶的 7 个音级（半音偏移，相对主音） */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]; // 和声小调的升七级留给和弦处理，音阶用自然小调

export function scalePitchClasses(key: KeySig): number[] {
  const steps = key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS;
  return steps.map((s) => (key.tonic + s) % 12);
}

export function inKey(pitch: number, key: KeySig): boolean {
  if (pitch < 0) return true;
  return scalePitchClasses(key).includes(((pitch % 12) + 12) % 12);
}

/** 把任意音拉回调内：优先向下找最近的音阶音（旋律下行更自然） */
export function snapToKey(pitch: number, key: KeySig): number {
  if (pitch < 0 || inKey(pitch, key)) return pitch;
  for (let d = 1; d <= 6; d++) {
    if (inKey(pitch - d, key)) return pitch - d;
    if (inKey(pitch + d, key)) return pitch + d;
  }
  return pitch;
}

/** 相对主音的音级序号（0-6）；不在调内返回 -1 */
export function scaleDegree(pitch: number, key: KeySig): number {
  if (pitch < 0) return -1;
  const pc = ((pitch % 12) + 12) % 12;
  const idx = scalePitchClasses(key).indexOf(pc);
  return idx < 0 ? -1 : idx + 1;
}

/* --------------------------------------------------------------- 拼写 */

const LETTERS = "CDEFGAB";
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_SPELL = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_SPELL = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export interface Spelling {
  /** 字母 C D E F G A B */
  step: string;
  /** 升降：-2..2 */
  alter: number;
  /** 科学音高八度（C4 = 60 所在八度 = 4） */
  octave: number;
}

/**
 * 音高 → 五线谱拼法。
 *
 * 关键点：**字母要按「主音字母 + 音级序号」推**，不能按绝对音级查表。
 * 踩过这个坑：G 大调的第七级是 F#，早期实现按 `(tonic+11)%12` 查字母表得到 B，
 * 于是导出的 MusicXML 里 F# 写成 B♭（音高对、谱面错，肉眼一看就是错的）。
 */
export function spellPitch(pitch: number, key: KeySig): Spelling {
  const pc = ((pitch % 12) + 12) % 12;
  const steps = key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS;
  const fifths = accidentalCount(key);
  const majorTonic = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  const tonicName = (fifths >= 0 ? SHARP_SPELL : FLAT_SPELL)[majorTonic];
  const tonicLetterIdx = Math.max(0, LETTERS.indexOf(tonicName[0]));

  for (let i = 0; i < 7; i++) {
    if ((key.tonic + steps[i]) % 12 !== pc) continue;
    const step = LETTERS[(tonicLetterIdx + i) % 7];
    let alter = pc - LETTER_PC[step];
    if (alter > 6) alter -= 12;
    if (alter < -6) alter += 12;
    const natural = pitch - alter;
    return { step, alter, octave: Math.floor(natural / 12) - 1 };
  }

  // 调外音：取自然音级里离它最近的字母，优先用升号（降号调里优先降号）
  let best: Spelling | null = null;
  for (const step of LETTERS) {
    const nat = LETTER_PC[step];
    let alter = pc - nat;
    if (alter > 6) alter -= 12;
    if (alter < -6) alter += 12;
    const preferSharp = fifths >= 0;
    const ok = preferSharp ? alter >= 0 : alter <= 0;
    const natural = pitch - alter;
    const cand = { step, alter, octave: Math.floor(natural / 12) - 1 };
    if (!best || (ok && Math.abs(alter) <= Math.abs(best.alter))) best = cand;
  }
  return best ?? { step: "C", alter: 0, octave: Math.floor(pitch / 12) - 1 };
}

/** 某字母在该调号里自带的升降（ABC/简谱判断"要不要写显式升降号"时用） */
export function keyAlterOf(step: string, key: KeySig): number {
  const n = accidentalCount(key);
  const sharps = ["F", "C", "G", "D", "A", "E", "B"];
  const flats = ["B", "E", "A", "D", "G", "C", "F"];
  if (n > 0 && sharps.slice(0, n).includes(step)) return 1;
  if (n < 0 && flats.slice(0, -n).includes(step)) return -1;
  return 0;
}

/* ----------------------------------------------------------------- 和弦 */

export type ChordQuality =
  | "maj"
  | "min"
  | "dim"
  | "aug"
  | "sus2"
  | "sus4"
  | "7"
  | "maj7"
  | "min7"
  | "m7b5"
  | "dim7"
  | "6"
  | "m6"
  | "add9"
  | "9";

export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  add9: [0, 2, 4, 7],
  "9": [0, 4, 7, 10, 14],
};

const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: "",
  min: "m",
  dim: "dim",
  aug: "aug",
  sus2: "sus2",
  sus4: "sus4",
  "7": "7",
  maj7: "maj7",
  min7: "m7",
  m7b5: "m7b5",
  dim7: "dim7",
  "6": "6",
  m6: "m6",
  add9: "add9",
  "9": "9",
};

export interface Chord {
  /** 根音音级 0-11 */
  root: number;
  quality: ChordQuality;
}

export function chordLabel(c: Chord, flats = false): string {
  const names = flats
    ? ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
    : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[c.root % 12]}${QUALITY_SUFFIX[c.quality]}`;
}

/** 和弦音（MIDI），octave 指根音所在八度（C4 = 60 → octave 4） */
export function chordPitches(c: Chord, octave = 4): number[] {
  const base = (octave + 1) * 12 + (c.root % 12);
  return CHORD_INTERVALS[c.quality].map((i) => base + i);
}

/** 从一叠音里认出和弦；认不出返回 null（不猜） */
export function identifyChord(pitches: number[]): { chord: Chord; label: string } | null {
  const pcs = [...new Set(pitches.filter((p) => p >= 0).map((p) => ((p % 12) + 12) % 12))];
  if (pcs.length < 2) return null;
  const qualities = Object.keys(CHORD_INTERVALS) as ChordQuality[];
  // 根音优先取最低音，其次取"能被完整覆盖"的那个
  const candidates: { chord: Chord; score: number }[] = [];
  for (const root of pcs) {
    for (const q of qualities) {
      const ivs = CHORD_INTERVALS[q].map((i) => (root + i) % 12);
      const covered = ivs.every((pc) => pcs.includes(pc));
      if (!covered) continue;
      const extra = pcs.filter((pc) => !ivs.includes(pc)).length;
      const sizePenalty = Math.abs(ivs.length - pcs.length);
      candidates.push({ chord: { root, quality: q }, score: extra * 3 + sizePenalty });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score || a.chord.root - b.chord.root);
  const pick = candidates[0];
  return { chord: pick.chord, label: chordLabel(pick.chord) };
}

/** 罗马数字 → 和弦。大写=大三和弦，小写=小三和弦，^dim/°=减，7=七和弦 */
export function romanChord(roman: string, key: KeySig): Chord {
  const clean = roman.replace(/[°ø]/g, "").replace(/\s/g, "");
  const isSeventh = /7$/.test(clean);
  const body = isSeventh ? clean.slice(0, -1) : clean;
  const isMinorCase = /^[iv]/.test(body);
  const degreeMap: Record<string, number> = { I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6 };
  const degree = degreeMap[body.toUpperCase()];
  const steps = key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS;
  const idx = degree ?? 0;
  const root = (key.tonic + steps[idx]) % 12;
  // 调内自然和弦性质：大三和弦给 maj/min 由大小写决定，七和弦按大小写各取 maj7/min7
  let quality: ChordQuality;
  if (isMinorCase) quality = isSeventh ? "min7" : "min";
  else quality = isSeventh ? "7" : "maj";
  if (/°/.test(roman)) quality = isSeventh ? "m7b5" : "dim";
  return { root, quality };
}

/* ----------------------------------------------------------------- 移调 */

export function transposeKey(key: KeySig, semis: number): KeySig {
  return { tonic: (((key.tonic + semis) % 12) + 12) % 12, mode: key.mode };
}

/** 该调最常用的一组和弦进行（度数 + 性质），给规则作曲器与 AI 提示共用 */
export interface Progression {
  name: string;
  /** 罗马数字序列，如 ["I", "V", "vi", "IV"] */
  romans: string[];
}

export const PROGRESSIONS: Progression[] = [
  { name: "流行四和弦", romans: ["I", "V", "vi", "IV"] },
  { name: "卡农进行", romans: ["I", "V", "vi", "iii", "IV", "I", "IV", "V"] },
  { name: "五十年代", romans: ["I", "vi", "IV", "V"] },
  { name: "小调悲歌", romans: ["i", "VI", "III", "VII"] },
  { name: "爵士 251", romans: ["ii", "V", "I", "vi"] },
  { name: "副歌推进", romans: ["vi", "IV", "I", "V"] },
  { name: "循环四度", romans: ["I", "IV", "vii", "iii", "vi", "ii", "V", "I"] },
];

export function progressionChords(p: Progression, key: KeySig, bars: number): Chord[] {
  const out: Chord[] = [];
  for (let i = 0; i < bars; i++) {
    out.push(romanChord(p.romans[i % p.romans.length], key));
  }
  return out;
}
