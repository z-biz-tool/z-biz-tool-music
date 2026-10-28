/**
 * 全局状态（zustand）。
 *
 * 一条规矩：score 是唯一真源，任何编辑都走 commit()（不可变替换），
 * 于是撤销/重做、脏标记、自动落盘三件事都只写一遍。
 * 界面组件不许直接改 score 里的字段。
 */

import { create } from "zustand";
import {
  MusicError,
  beatsPerMeasure,
  cloneScore,
  emptyScore,
  measureCount,
  newNote,
  newTrack,
  parseScore,
  serializeScore,
  sortNotes,
  trackColor,
  uid,
  type Clef,
  type InstrumentId,
  type KeySig,
  type Note,
  type Score,
  type Track,
} from "./core/model.ts";
import { DEFAULT_PROVIDER, type AiProvider } from "./core/ai.ts";
import { instrumentSpec } from "./core/theory.ts";
import { demoScore } from "./core/demo.ts";

export type ViewMode = "staff" | "jianpu" | "roll" | "mixer";

export interface Settings {
  dark: boolean;
  metronome: boolean;
  /** 吸附粒度（拍）：0.25 = 十六分音符 */
  snap: number;
  /** 循环区间（拍），null = 全曲 */
  loop: { from: number; to: number } | null;
  /** 卷帘显示的音域偏移 */
  rollOctaves: number;
}

interface HistoryEntry {
  score: Score;
  label: string;
}

interface Store {
  score: Score;
  projectName: string;
  dirty: boolean;
  view: ViewMode;
  trackId: string;
  selected: string[];
  playing: boolean;
  beat: number;
  settings: Settings;
  provider: AiProvider;
  past: HistoryEntry[];
  future: HistoryEntry[];
  hint: { kind: "ok" | "err" | "info"; text: string } | null;

  commit: (next: Score, label: string) => void;
  loadScore: (score: Score, label: string, projectName?: string) => void;
  newProject: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  say: (text: string, kind?: "ok" | "err" | "info") => void;
  clearHint: () => void;

  setView: (v: ViewMode) => void;
  setTrack: (id: string) => void;
  select: (ids: string[]) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setProvider: (patch: Partial<AiProvider>) => void;
  setPlaying: (playing: boolean) => void;
  setBeat: (beat: number) => void;

  setTitle: (title: string) => void;
  setTempo: (bpm: number) => void;
  setKey: (key: KeySig) => void;
  setTime: (time: [number, number]) => void;

  addTrack: (instrument: InstrumentId) => string;
  removeTrack: (id: string) => void;
  updateTrack: (id: string, patch: Partial<Omit<Track, "notes" | "id">>) => void;

  addNote: (trackId: string, start: number, pitch: number, dur: number) => string;
  updateNote: (trackId: string, noteId: string, patch: Partial<Note>) => void;
  deleteSelected: () => void;
  transpose: (semis: number) => void;
  quantize: (grid: number) => void;
  clearTrack: () => void;
}

const SESSION_KEY = "z-biz-tool-music-session";
const SETTINGS_KEY = "z-biz-tool-music-settings";
const AI_KEY = "z-biz-tool-music-ai";

const DEFAULT_SETTINGS: Settings = { dark: true, metronome: false, snap: 0.25, loop: null, rollOctaves: 0 };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const o = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...o };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadProvider(): AiProvider {
  try {
    const raw = localStorage.getItem(AI_KEY);
    if (!raw) return DEFAULT_PROVIDER;
    const o = JSON.parse(raw) as Partial<AiProvider>;
    return { ...DEFAULT_PROVIDER, ...o };
  } catch {
    return DEFAULT_PROVIDER;
  }
}

interface Session {
  score: Score;
  projectName: string;
  dirty: boolean;
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { score?: unknown; projectName?: string; dirty?: boolean };
    return { score: parseScore(o.score), projectName: o.projectName ?? "未命名工程", dirty: o.dirty === true };
  } catch {
    // 上一次会话坏了就当没有：这只是"上次没关完"的便利，不是数据来源
    return null;
  }
}

function persist(score: Score, projectName: string, dirty: boolean): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ score, projectName, dirty }));
  } catch {
    /* 存不下（配额满）不影响当前编辑，只是下次打开回不到这里 */
  }
}

const initial = loadSession();
const initialScore = initial?.score ?? demoScore();

/** ?view=jianpu 这类深链：方便截图核对，也方便把某个视图发给别人 */
function initialView(): ViewMode {
  try {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v === "staff" || v === "jianpu" || v === "roll" || v === "mixer") return v;
  } catch {
    /* 非浏览器环境（自检脚本）直接走默认 */
  }
  return "staff";
}

export const useStore = create<Store>()((set, get) => ({
  score: initialScore,
  projectName: initial?.projectName ?? initialScore.title,
  dirty: initial?.dirty ?? false,
  view: initialView(),
  trackId: initialScore.tracks[0]?.id ?? "",
  selected: [],
  playing: false,
  beat: 0,
  settings: loadSettings(),
  provider: loadProvider(),
  past: [],
  future: [],
  hint: null,

  commit: (next, label) => {
    const cur = get().score;
    const past = [...get().past, { score: cur, label }].slice(-60);
    set({ score: next, past, future: [], dirty: true, hint: { kind: "ok", text: label } });
    persist(next, get().projectName, true);
  },

  loadScore: (score, label, projectName) => {
    const name = projectName ?? score.title;
    set({
      score,
      projectName: name,
      trackId: score.tracks[0]?.id ?? "",
      selected: [],
      beat: 0,
      past: [],
      future: [],
      dirty: false,
      hint: { kind: "ok", text: label },
    });
    persist(score, name, false);
  },

  newProject: () => {
    get().loadScore(emptyScore("未命名工程"), "已新建空白工程", "未命名工程");
  },

  undo: () => {
    const past = get().past;
    if (past.length === 0) {
      set({ hint: { kind: "info", text: "没有可撤销的操作" } });
      return;
    }
    const last = past[past.length - 1];
    set({
      score: last.score,
      past: past.slice(0, -1),
      future: [{ score: get().score, label: last.label }, ...get().future].slice(0, 60),
      dirty: true,
      selected: [],
      hint: { kind: "info", text: `已撤销：${last.label}` },
    });
    persist(last.score, get().projectName, true);
  },

  redo: () => {
    const future = get().future;
    if (future.length === 0) {
      set({ hint: { kind: "info", text: "没有可重做的操作" } });
      return;
    }
    const next = future[0];
    set({
      score: next.score,
      future: future.slice(1),
      past: [...get().past, { score: get().score, label: next.label }],
      dirty: true,
      selected: [],
      hint: { kind: "info", text: `已重做：${next.label}` },
    });
    persist(next.score, get().projectName, true);
  },

  markSaved: () => {
    set({ dirty: false });
    persist(get().score, get().projectName, false);
  },

  say: (text, kind = "ok") => set({ hint: { kind, text } }),
  clearHint: () => set({ hint: null }),

  setView: (view) => set({ view }),
  setTrack: (trackId) => set({ trackId, selected: [] }),
  select: (selected) => set({ selected }),
  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* 偏好存不下不影响使用 */
    }
  },
  setProvider: (patch) => {
    const provider = { ...get().provider, ...patch };
    set({ provider });
    try {
      localStorage.setItem(AI_KEY, JSON.stringify(provider));
    } catch {
      /* 同上 */
    }
  },
  setPlaying: (playing) => set({ playing }),
  setBeat: (beat) => set({ beat }),

  setTitle: (title) => get().commit({ ...get().score, title }, `重命名为「${title}」`),
  setTempo: (bpm) => {
    const tempo = Math.min(300, Math.max(20, Math.round(bpm)));
    get().commit({ ...get().score, tempo }, `速度改为 ${tempo} BPM`);
  },
  setKey: (key) => get().commit({ ...get().score, key }, "已改变调号"),
  setTime: (time) => get().commit({ ...get().score, time }, `拍号改为 ${time[0]}/${time[1]}`),

  addTrack: (instrument) => {
    const score = get().score;
    const spec = instrumentSpec(instrument);
    const track = newTrack({
      name: spec.label,
      instrument,
      program: spec.program,
      clef: spec.clef,
      color: trackColor(score.tracks.length),
      notes: [],
    });
    get().commit({ ...score, tracks: [...score.tracks, track] }, `已添加轨道「${spec.label}」`);
    set({ trackId: track.id });
    return track.id;
  },

  removeTrack: (id) => {
    const score = get().score;
    if (score.tracks.length <= 1) {
      set({ hint: { kind: "err", text: "至少要保留一条轨道" } });
      return;
    }
    const t = score.tracks.find((x) => x.id === id);
    const tracks = score.tracks.filter((x) => x.id !== id);
    get().commit({ ...score, tracks }, `已删除轨道「${t?.name ?? id}」及其 ${t?.notes.length ?? 0} 个音符`);
    set({ trackId: tracks[0].id, selected: [] });
  },

  updateTrack: (id, patch) => {
    const score = get().score;
    const tracks = score.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t));
    // 混音参数变化非常频繁（拖推子），不写历史，否则撤销栈会被推子塞满
    set({ score: { ...score, tracks }, dirty: true });
    persist({ ...score, tracks }, get().projectName, true);
  },

  addNote: (trackId, start, pitch, dur) => {
    const score = get().score;
    const note = newNote({ start: Math.max(0, start), dur: Math.max(0.0625, dur), pitch, vel: 88 });
    const tracks = score.tracks.map((t) =>
      t.id === trackId ? { ...t, notes: sortNotes([...t.notes.filter((n) => !(Math.abs(n.start - note.start) < 1e-6 && n.pitch === note.pitch)), note]) } : t,
    );
    get().commit({ ...score, tracks }, `在 ${(start + 1).toFixed(2)} 拍加了 ${pitch}`);
    return note.id;
  },

  updateNote: (trackId, noteId, patch) => {
    const score = get().score;
    const tracks = score.tracks.map((t) =>
      t.id === trackId
        ? {
            ...t,
            notes: sortNotes(
              t.notes.map((n) =>
                n.id === noteId
                  ? {
                      ...n,
                      ...patch,
                      start: patch.start === undefined ? n.start : Math.max(0, patch.start),
                      dur: patch.dur === undefined ? n.dur : Math.max(0.0625, patch.dur),
                      pitch: patch.pitch === undefined ? n.pitch : Math.max(-1, Math.min(127, patch.pitch)),
                    }
                  : n,
              ),
            ),
          }
        : t,
    );
    get().commit({ ...score, tracks }, "已修改音符");
  },

  deleteSelected: () => {
    const score = get().score;
    const ids = new Set(get().selected);
    if (ids.size === 0) {
      set({ hint: { kind: "info", text: "没有选中任何音符" } });
      return;
    }
    const tracks = score.tracks.map((t) => ({ ...t, notes: t.notes.filter((n) => !ids.has(n.id)) }));
    get().commit({ ...score, tracks }, `已删除 ${ids.size} 个音符`);
    set({ selected: [] });
  },

  transpose: (semis) => {
    const score = get().score;
    const ids = get().selected.length > 0 ? new Set(get().selected) : null;
    const tracks = score.tracks.map((t) => ({
      ...t,
      notes: t.notes.map((n) =>
        n.pitch >= 0 && (!ids || ids.has(n.id)) ? { ...n, pitch: Math.max(0, Math.min(127, n.pitch + semis)) } : n,
      ),
    }));
    get().commit({ ...score, tracks }, `已移调 ${semis > 0 ? "+" : ""}${semis} 个半音`);
    // 移调只动音高，调号跟着走一遍更符合直觉（C 大调写的东西整体上移就成了 D 大调）
    if (!ids) get().setKey({ tonic: (score.key.tonic + semis + 120) % 12, mode: score.key.mode });
  },

  quantize: (grid) => {
    const score = get().score;
    const g = Math.max(0.0625, grid);
    const tracks = score.tracks.map((t) => ({
      ...t,
      notes: sortNotes(
        t.notes.map((n) => ({ ...n, start: Math.round(n.start / g) * g, dur: Math.max(g, Math.round(n.dur / g) * g) })),
      ),
    }));
    get().commit({ ...score, tracks }, `已按 1/${Math.round(4 / g)} 音符量化`);
  },

  clearTrack: () => {
    const score = get().score;
    const id = get().trackId;
    const t = score.tracks.find((x) => x.id === id);
    if (!t) return;
    const tracks = score.tracks.map((x) => (x.id === id ? { ...x, notes: [] } : x));
    get().commit({ ...score, tracks }, `已清空轨道「${t.name}」`);
    set({ selected: [] });
  },
}));

/* ------------------------------------------------------------ 选择器工具 */

export function currentTrack(s: Store): Track | undefined {
  return s.score.tracks.find((t) => t.id === s.trackId) ?? s.score.tracks[0];
}

export function scoreFacts(score: Score): { bars: number; beats: number; notes: number; duration: string } {
  const beats = beatsPerMeasure(score);
  const bars = measureCount(score);
  const notes = score.tracks.reduce((a, t) => a + t.notes.filter((n) => n.pitch >= 0).length, 0);
  const sec = (bars * beats * 60) / score.tempo;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return { bars, beats, notes, duration: m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒` };
}

/** 导出工程文件（.zmusic） */
export function projectJson(score: Score): string {
  return serializeScore(score);
}

/** 从工程文件恢复；失败抛 MusicError，界面负责显示原因 */
export function projectFromJson(text: string): Score {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MusicError("不是有效的 JSON 文件");
  }
  return cloneScore(parseScore(raw));
}

export function nextMeasureStart(score: Score, beat: number): number {
  const b = beatsPerMeasure(score);
  return (Math.floor(beat / b) + 1) * b;
}

export { uid };
export type { Clef };
