/**
 * 跟弹判定 —— 学琴最核心的反馈回路。
 *
 * 设计取舍：
 *
 * 1) **只判音高顺序，不判时间**。初学者最需要的是「我按对了吗」，
 *    而不是「你晚了 120 毫秒」。加时间窗会让新手在第一课就被劝退，
 *    而且没有 MIDI 键盘时（点屏幕琴键）时间判定本来就不公平。
 *
 * 2) **允许一次找音**。和弦要三个键同时按下，鼠标只能一个个点，
 *    所以判定单位是「这一步的期望音集合」，按全了才前进。
 *
 * 3) **纯函数**。press() 不改传入的 session，返回新的 ——
 *    这样才能断言、才能回放一次练习过程、才不会被 React 的渲染顺序坑。
 */

import { chordGroups } from "./abc.ts";
import { degreeOf } from "./jianpu.ts";
import type { KeySig, Score } from "./model.ts";

/** 一步 = 谱上同一个起点上要按下的所有音（单音或和弦） */
export interface Step {
  index: number;
  /** 起始拍（绝对拍） */
  beat: number;
  /** 时值（拍） */
  dur: number;
  /** 要按的音（升序）；和弦就是多个 */
  pitches: number[];
  /** 所在小节（0 起），界面用来显示「第几小节」 */
  bar: number;
}

export interface Session {
  steps: Step[];
  /** 当前在第几步 */
  cursor: number;
  /** 当前这一步还没按的音 */
  pending: number[];
  /** 按对的音数（逐音计，和弦算多个） */
  hits: number;
  /** 按错次数 */
  wrong: number;
  /** 是否弹完了 */
  done: boolean;
}

export type Verdict = "hit" | "wrong" | "done" | "idle";

/** 把乐谱切成跟弹步骤。休止符不是步骤（不用按），跳过。 */
export function buildSteps(score: Score, trackIndex = 0): Step[] {
  const track = score.tracks[trackIndex] ?? score.tracks[0];
  if (!track) return [];
  const bpm = (score.time[0] * 4) / score.time[1];
  const sounding = track.notes.filter((n) => n.pitch >= 0 && n.dur > 0);
  const groups = chordGroups(sounding);
  return groups.map((g, i) => ({
    index: i,
    beat: g[0].start,
    dur: Math.max(...g.map((n) => n.dur)),
    pitches: [...new Set(g.map((n) => n.pitch))].sort((a, b) => a - b),
    bar: Math.floor((g[0].start + 1e-9) / bpm),
  }));
}

export function createSession(steps: Step[]): Session {
  const first = steps[0];
  return {
    steps,
    cursor: 0,
    pending: first ? [...first.pitches] : [],
    hits: 0,
    wrong: 0,
    done: steps.length === 0,
  };
}

/** 当前该按哪些键（界面据此在琴键上打高亮） */
export function expectPitches(s: Session): number[] {
  return s.done ? [] : s.pending;
}

/**
 * 按下一个键。返回新 session 与判定结果。
 *
 * "hit"      —— 按的是期望音之一（和弦还没按全也回 hit）
 * "done"     —— 最后一音按完，整条练习通过
 * "wrong"    —— 不是期望音（包括重复按同一个已按过的音）
 * "idle"     —— 已经弹完，再按不再计分
 */
export function press(s: Session, pitch: number): { session: Session; verdict: Verdict } {
  if (s.done) return { session: s, verdict: "idle" };
  const at = s.pending.indexOf(pitch);
  if (at < 0) {
    const session: Session = { ...s, wrong: s.wrong + 1 };
    return { session, verdict: "wrong" };
  }
  const pending = [...s.pending.slice(0, at), ...s.pending.slice(at + 1)];
  const hits = s.hits + 1;
  if (pending.length > 0) {
    return { session: { ...s, pending, hits }, verdict: "hit" };
  }
  const cursor = s.cursor + 1;
  const next = s.steps[cursor];
  if (!next) {
    return { session: { ...s, cursor, pending: [], hits, done: true }, verdict: "done" };
  }
  return { session: { ...s, cursor, pending: [...next.pitches], hits }, verdict: "hit" };
}

/** 准确率 = 按对 / (按对 + 按错)。还没按过时算 1（不给下马威） */
export function accuracy(s: Session): number {
  const total = s.hits + s.wrong;
  return total === 0 ? 1 : s.hits / total;
}

/** 进度比例 0-1（按步数算，和弦算一步） */
export function progressRatio(s: Session): number {
  if (s.steps.length === 0) return 1;
  return s.done ? 1 : s.cursor / s.steps.length;
}

export function stepCount(s: Session): number {
  return s.steps.length;
}

/* ------------------------------------------------------------ 显示辅助 */

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** MIDI 音高 → 科学音高记号（C4 = 中央 C） */
export function keyName(pitch: number): string {
  if (pitch < 0) return "休止";
  const pc = ((pitch % 12) + 12) % 12;
  return `${NAMES[pc]}${Math.floor(pitch / 12) - 1}`;
}

/** 该调「1」所在的八度基准，与 jianpu.buildJianpu 保持同一套算法 */
function tonicBase(tonic: number): number {
  return 60 + ((tonic % 12) + 12) % 12;
}

/**
 * MIDI 音高 → 简谱读法（如 "1"、"5̇"）。
 * 用上/下加点表示八度，跟简谱视图里的画法一致，方便学生把琴键和谱子对上号。
 */
export function solfegeOf(pitch: number, key: KeySig): string {
  if (pitch < 0) return "0";
  const { digit, accidental } = degreeOf(pitch, key.tonic, key.mode);
  if (digit === 0) return "0";
  const base = tonicBase(key.tonic);
  const oct = Math.round((pitch - base) / 12);
  const acc = accidental > 0 ? "#" : accidental < 0 ? "b" : "";
  if (oct === 0) return `${acc}${digit}`;
  return `${acc}${digit}${"·".repeat(Math.min(2, Math.abs(oct)))}${oct > 0 ? "↑" : "↓"}`;
}

/** 一步的按键提示，如 "C4 + E4 + G4" */
export function stepLabel(step: Step): string {
  return step.pitches.map(keyName).join(" + ");
}

/* ------------------------------------------------------------ 琴键范围 */

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];

export function isWhiteKey(pitch: number): boolean {
  return WHITE_PCS.includes(((pitch % 12) + 12) % 12);
}

/**
 * 算出该显示哪一段琴键。
 *
 * 两条硬约束：
 *  - 必须**对齐到八度边界**（C 起、B 止）。从黑键开始画的话，那一组白键的
 *    相对位置就错了，学生看到的键盘形状不像真钢琴，指法提示也会误导。
 *  - 至少要一整组八度，不然 5 个键孤零零摆在那里，看不出「两个黑键三个黑键」
 *    的排列规律 —— 而那正是第 1 章要教的东西。
 */
export function keyRangeFor(steps: Step[], minSpan = 12, maxSpan = 36): { from: number; to: number } {
  const all = steps.flatMap((s) => s.pitches);
  if (all.length === 0) return { from: 60, to: 71 };
  const lowest = Math.min(...all);
  const highest = Math.max(...all);
  // 落到 C、抬到 B
  let lo = lowest - (((lowest % 12) + 12) % 12);
  let hi = highest + (11 - (((highest % 12) + 12) % 12));
  while (hi - lo + 1 < minSpan) {
    // 优先往低音侧补：真钢琴上学生的手大多落在中音区偏左
    if (lo - 12 >= 24) lo -= 12;
    else hi += 12;
  }
  // 超宽就从离音符远的那侧收
  while (hi - lo + 1 > maxSpan && hi - 12 >= highest) hi -= 12;
  while (hi - lo + 1 > maxSpan && lo + 12 <= lowest) lo += 12;
  return { from: lo, to: hi };
}
