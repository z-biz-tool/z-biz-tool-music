/**
 * 屏幕钢琴 —— 课程里学生唯一的"乐器"。
 *
 * 三条设计约束：
 *
 * 1) **形状必须像真钢琴**。白键等宽、黑键骑在两白键的交界上，且宽度只有白键的
 *    六成。学生在这上面学会的「两个黑键左边是 C」，换到真琴上要能直接对上；
 *    为了凑格子把黑键画成独立方块，就等于教错了。
 *
 * 2) **状态只给三种**：该按（青色呼吸）、刚按对（绿色）、按错（红色一闪）。
 *    多了会变成音游，学生会盯着颜色而不是盯着谱。
 *
 * 3) 不用 Canvas。每个键是 DOM 元素，才能有 hover、focus、aria —— 键盘也能操作，
 *    这对没接 MIDI 键盘的人很重要（本产品不假设你有硬件）。
 */

import { useMemo } from "react";
import { isWhiteKey, keyName, solfegeOf } from "../core/practice.ts";
import type { KeySig } from "../core/model.ts";

export interface KeyboardProps {
  /** 最低音（应是白键，即 C） */
  from: number;
  /** 最高音（应是 B 或 C） */
  to: number;
  /** 当前该按的音 */
  target: number[];
  /** 刚按对的音（短暂高亮） */
  hot: number[];
  /** 刚按错的音（短暂闪红），null 表示没有 */
  wrong: number | null;
  /** 弹奏回调；没给就是只展示不可点 */
  onPress?: (pitch: number) => void;
  /** 是否在每个白键上标简谱数字 */
  showSolfege: boolean;
  keySig: KeySig;
  height?: number;
}

interface KeyBox {
  pitch: number;
  white: boolean;
  /** 白键：第几个白键（0 起）；黑键：骑在第几个白键的右边界上 */
  slot: number;
}

/** 算出这一段琴键的键位盒子；纯计算，便于单测与 theme 无关 */
export function layoutKeys(from: number, to: number): KeyBox[] {
  const box: KeyBox[] = [];
  let whites = 0;
  for (let p = from; p <= to; p++) {
    if (isWhiteKey(p)) {
      box.push({ pitch: p, white: true, slot: whites });
      whites++;
    } else {
      box.push({ pitch: p, white: false, slot: whites });
    }
  }
  return box;
}

const BLACK_LABELS: Record<number, string> = { 1: "C♯", 3: "D♯", 6: "F♯", 8: "G♯", 10: "A♯" };

export default function Keyboard({
  from,
  to,
  target,
  hot,
  wrong,
  onPress,
  showSolfege,
  keySig,
  height = 150,
}: KeyboardProps) {
  const boxes = useMemo(() => layoutKeys(from, to), [from, to]);
  const whiteCount = boxes.filter((b) => b.white).length;
  const w = 100 / Math.max(1, whiteCount);
  const blackW = w * 0.62;
  const targets = new Set(target);
  const hots = new Set(hot);

  const stateOf = (p: number): string => {
    if (wrong === p) return "wrong";
    if (hots.has(p)) return "hit";
    if (targets.has(p)) return "target";
    return "idle";
  };

  return (
    <div className="mu-kbd" style={{ height }} role="group" aria-label="屏幕钢琴：点击或按电脑键盘弹奏">
      {boxes
        .filter((b) => b.white)
        .map((b) => {
          const st = stateOf(b.pitch);
          const sol = showSolfege ? solfegeOf(b.pitch, keySig) : "";
          return (
            <button
              key={b.pitch}
              type="button"
              className="mu-kbd-key"
              data-state={st}
              style={{ left: `${b.slot * w}%`, width: `${w}%` }}
              onPointerDown={() => onPress?.(b.pitch)}
              aria-label={`${keyName(b.pitch)}${sol ? ` 简谱 ${sol}` : ""}`}
              title={`${keyName(b.pitch)}${sol ? ` · 简谱 ${sol}` : ""}`}
            >
              <span className="mu-kbd-sol">{sol}</span>
              <span className="mu-kbd-name">{keyName(b.pitch)}</span>
            </button>
          );
        })}
      {boxes
        .filter((b) => !b.white)
        .map((b) => {
          const st = stateOf(b.pitch);
          const pc = ((b.pitch % 12) + 12) % 12;
          return (
            <button
              key={b.pitch}
              type="button"
              className="mu-kbd-key"
              data-black="true"
              data-state={st}
              style={{ left: `calc(${b.slot * w}% - ${blackW / 2}%)`, width: `${blackW}%` }}
              onPointerDown={() => onPress?.(b.pitch)}
              aria-label={keyName(b.pitch)}
              title={keyName(b.pitch)}
            >
              <span className="mu-kbd-name">{BLACK_LABELS[pc] ?? ""}</span>
            </button>
          );
        })}
    </div>
  );
}

/* ------------------------------------------------------- 电脑键盘键位映射 */

/**
 * 用电脑键盘弹：A S D F G H J K = 白键，W E T Y U = 黑键（业界通用键位）。
 *
 * 映射到「基准八度」而不是固定 C4：学生练左手低音时，按 A 应该出 C3 而不是 C4。
 * 基准由调用方按当前练习曲的最低音决定。
 */
const WHITE_OFFSETS: Record<string, number> = { a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11, k: 12 };
const BLACK_OFFSETS: Record<string, number> = { w: 1, e: 3, t: 6, y: 8, u: 10 };

export function keyToPitch(k: string, baseC: number): number | null {
  const key = k.toLowerCase();
  const wOff = WHITE_OFFSETS[key];
  if (wOff !== undefined) return baseC + wOff;
  const bOff = BLACK_OFFSETS[key];
  if (bOff !== undefined) return baseC + bOff;
  return null;
}

export const KEYBOARD_HINT = "电脑键盘也能弹：A S D F G H J K = 白键，W E T Y U = 黑键";
