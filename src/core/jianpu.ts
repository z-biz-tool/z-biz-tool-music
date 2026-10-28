/**
 * 简谱（数字谱）排版模型。
 *
 * 为什么自研：npm 上没有可用的简谱库（唯一几个都是私人生成器），
 * 而简谱正是这门生意最硬的刚需——音乐老师、琴童家长、合唱团要的都是简谱。
 *
 * 规则（按国内通行写法，参数化在下方常量里）：
 *   - 首调唱名：1 = 调式主音（C 大调时 1=C，G 大调时 1=G）
 *   - 八度：高八度在数字上方加点，低八度在下方加点，几个八度就几个点
 *   - 时值：四分音符 = 光数字；八分 = 一条减时线；十六分 = 两条；
 *           二分 = 数字 + 一条增时线「—」；全音符 = 三条增时线
 *   - 附点：数字右侧小圆点
 *   - 休止：0
 *   - 变化音：# / b 写在数字左上
 * 这些常量一旦改动，所有历史截图都会对不上，改动前先问一句"教材里怎么写"。
 */

import { MusicError, beatsPerMeasure, measureCount, type Note, type Score } from "./model.ts";
import { splitAtBarlines } from "./abc.ts";

const DEGREE_STEPS = [0, 2, 4, 5, 7, 9, 11];

export interface JianpuToken {
  /** 1-7；0 = 休止 */
  digit: number;
  /** 变化音：1=#，-1=b，0=还原 */
  accidental: 0 | 1 | -1;
  /** 八度点数：正=上方，负=下方 */
  octaveDots: number;
  /** 减时线条数 0-2（三十二分音符用 3，v0.1 不支持） */
  underlines: number;
  /** 增时线条数 */
  dashes: number;
  /** 附点个数 */
  dots: number;
  /** 与下一枚相连 */
  tie: boolean;
}

export interface JianpuChord {
  /** 纵向叠起来的音（和弦），第一个是最低音 */
  tokens: JianpuToken[];
  start: number;
  dur: number;
}

export interface JianpuMeasure {
  index: number;
  chords: JianpuChord[];
}

export interface JianpuLayout {
  measures: JianpuMeasure[];
  /** 每小节拍数，界面用来算宽度 */
  beatsPerMeasure: number;
  key: { tonic: number; mode: "major" | "minor" };
  tempo: number;
  title: string;
}

/** 该调「1」所在的 MIDI 音（固定落在 C4..B4 之间，保证中音区不带点） */
function tonicBase(tonic: number): number {
  return 60 + ((tonic % 12) + 12) % 12;
}

/**
 * 每条轨各自选中音区：把「1」放到离该轨音域中位数最近的八度。
 *
 * 不这么做的话，低音谱轨（C2 一带）在 G 大调里会写成「下方三个八度点」——
 * 技术上没错，但简谱惯例最多画两个点，三个点等于告诉读者"这行别用简谱"。
 * 让每条轨自己找音区，主旋律和低音就都落在 0~2 个点以内。
 */
function chooseBase(pitches: number[], tonic: number): number {
  const nominal = tonicBase(tonic);
  if (pitches.length === 0) return nominal;
  const sorted = [...pitches].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return nominal + Math.round((median - nominal) / 12) * 12;
}

/** 音高 → 级数 + 变化音；调外音取最近的级数并标 #/b */
export function degreeOf(pitch: number, tonic: number, mode: "major" | "minor"): { digit: number; accidental: 0 | 1 | -1 } {
  const steps = mode === "major" ? DEGREE_STEPS : [0, 2, 3, 5, 7, 8, 10];
  const pc = (((pitch % 12) + 12) % 12 - tonic + 24) % 12;
  const exact = steps.indexOf(pc);
  if (exact >= 0) return { digit: exact + 1, accidental: 0 };
  // 调外音：向下找最近的级数并升号，向上找最近的级数并降号，取半音距离小的
  for (let d = 0; d < 7; d++) {
    const lower = steps[d];
    const upper = steps[(d + 1) % 7] + (d === 6 ? 12 : 0);
    if (pc > lower && pc < upper) {
      const upDist = upper - pc;
      const downDist = pc - lower;
      if (downDist <= upDist) return { digit: d + 1, accidental: 1 };
      return { digit: ((d + 1) % 7) + 1, accidental: -1 };
    }
  }
  return { digit: 1, accidental: 0 };
}

/** 时值 → 减时线/增时线/附点。对不上的时值（三连音等）按最接近的记法并标记 exact=false */
export function jianpuDuration(dur: number): { underlines: number; dashes: number; dots: number; exact: boolean } {
  const bases = [0.25, 0.5, 1, 2, 4];
  let best: { underlines: number; dashes: number; dots: number; diff: number } | null = null;
  for (const base of bases) {
    for (const dots of [0, 1, 2]) {
      const value = base * (2 - Math.pow(0.5, dots));
      const diff = Math.abs(value - dur);
      if (!best || diff < best.diff) {
        const underlines = base >= 1 ? 0 : base === 0.5 ? 1 : 2;
        const dashes = base <= 1 ? 0 : Math.round(base) - 1;
        best = { underlines, dashes, dots, diff };
      }
    }
  }
  const b = best ?? { underlines: 0, dashes: 0, dots: 0, diff: 0 };
  return { underlines: b.underlines, dashes: b.dashes, dots: b.dots, exact: b.diff < 1e-6 };
}

function noteToToken(note: Note, key: Score["key"], base: number): JianpuToken {
  if (note.pitch < 0) {
    const d = jianpuDuration(note.dur);
    return { digit: 0, accidental: 0, octaveDots: 0, underlines: d.underlines, dashes: d.dashes, dots: d.dots, tie: false };
  }
  const { digit, accidental } = degreeOf(note.pitch, key.tonic, key.mode);
  const steps = key.mode === "major" ? DEGREE_STEPS : [0, 2, 3, 5, 7, 8, 10];
  const natural = base + steps[digit - 1] + accidental;
  const octaveDots = Math.round((note.pitch - natural) / 12);
  const d = jianpuDuration(note.dur);
  return {
    digit,
    accidental,
    octaveDots,
    underlines: d.underlines,
    dashes: d.dashes,
    dots: d.dots,
    tie: note.tie === true,
  };
}

/**
 * 取某条轨的简谱排版模型。
 * 跨小节的音会被切开（简谱不能画跨小节的增时线），切口处打连音弧。
 */
export function buildJianpu(score: Score, trackIndex: number, title = score.title): JianpuLayout {
  const track = score.tracks[trackIndex];
  if (!track) throw new MusicError(`没有第 ${trackIndex + 1} 条轨道`);
  const bpm = beatsPerMeasure(score);
  const bars = measureCount(score);
  const base = chooseBase(
    track.notes.filter((n) => n.pitch >= 0).map((n) => n.pitch),
    score.key.tonic,
  );
  const measures: JianpuMeasure[] = Array.from({ length: bars }, (_, i) => ({ index: i, chords: [] }));
  for (const seg of splitAtBarlines(track.notes, bpm)) {
    const bar = Math.min(bars - 1, Math.floor((seg.start + 1e-9) / bpm));
    const tokens = seg.notes
      .filter((n) => n.pitch >= 0)
      .sort((a, b) => a.pitch - b.pitch)
      .map((n) => noteToToken(n, score.key, base));
    if (tokens.length === 0) {
      const rest = noteToToken({ ...seg.notes[0], pitch: -1 }, score.key, base);
      measures[bar].chords.push({ tokens: [rest], start: seg.start, dur: seg.dur });
      continue;
    }
    // 连音线只标在最后一个音上（简谱的连音弧画在音与音之间）
    const last = tokens[tokens.length - 1];
    tokens[tokens.length - 1] = { ...last, tie: seg.notes.some((n) => n.tie) || last.tie };
    measures[bar].chords.push({ tokens, start: seg.start, dur: seg.dur });
  }
  return { measures, beatsPerMeasure: bpm, key: score.key, tempo: score.tempo, title };
}

/** 单个 token 的估算宽度（px），排版换行用；比真实渲染略宽，宁可提前换行 */
export function tokenWidth(tok: JianpuToken, fontSize = 20): number {
  const digitW = fontSize * 0.62;
  const dashW = fontSize * 0.72;
  return digitW + dashW * tok.dashes + fontSize * 0.18 * tok.dots + 4;
}

export function chordWidth(chord: JianpuChord, fontSize = 20): number {
  const maxDashes = Math.max(...chord.tokens.map((t) => t.dashes));
  return Math.max(...chord.tokens.map((t) => tokenWidth({ ...t, dashes: 0 }, fontSize))) + maxDashes * fontSize * 0.72 + 4;
}

export const JIANPU_SYMBOLS = { rest: "0", dash: "—", dot: "·" } as const;
