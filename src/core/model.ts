/**
 * 乐谱 IR —— 全产品唯一真源。
 *
 * 两条硬约定，改动前先读：
 * 1) 时间是「绝对拍」，四分音符 = 1。start 与 dur 都用这个单位，不做小节内相对坐标。
 *    理由：移调、量化、增删小节、AI 拼接都是对整条时间轴做变换，一旦引入"相对小节"，
 *    每个变换都要跨小节搬运。扁平表让这些操作退化成一次 map。
 * 2) 音符表用 pitch = -1 表示休止。休止也要占位（start/dur 有值），
 *    否则排版要反推空隙、导入会丢拍。
 */

export type Mode = "major" | "minor";
export type Clef = "treble" | "bass" | "grand" | "alto";

/** 音色族：混音台与合成器都按这个分，program 只是给 MIDI 导出用的 GM 号 */
export type InstrumentId =
  | "piano"
  | "epiano"
  | "organ"
  | "guitar"
  | "bass"
  | "strings"
  | "brass"
  | "reed"
  | "pipe"
  | "synth"
  | "pad"
  | "drums";

export type Articulation = "staccato" | "accent" | "tenuto" | "fermata";
export type Dynamic = "pp" | "p" | "mp" | "mf" | "f" | "ff";

export interface KeySig {
  /** 主音，0=C 1=C#/Db … 11=B */
  tonic: number;
  mode: Mode;
}

export interface Note {
  id: string;
  /** 起始拍（绝对，四分音符=1） */
  start: number;
  /** 时值（拍） */
  dur: number;
  /** MIDI 音高；-1 = 休止 */
  pitch: number;
  /** 力度 1-127 */
  vel: number;
  /** 与下一枚同音高音符相连（画连音线、播放不重触发） */
  tie?: boolean;
  /** 附点个数，只影响记谱，不改 dur */
  dot?: 1 | 2;
  art?: Articulation;
  dyn?: Dynamic;
  lyric?: string;
}

export interface Track {
  id: string;
  name: string;
  instrument: InstrumentId;
  /** GM program 0-127，仅导出 MIDI 时使用 */
  program: number;
  /** 0-1 */
  volume: number;
  /** -1 左 .. 1 右 */
  pan: number;
  mute: boolean;
  solo: boolean;
  clef: Clef;
  color: string;
  notes: Note[];
}

export interface ScoreMeta {
  /** 来源标记：ai / local / manual / import */
  origin?: "ai" | "local" | "manual" | "import";
  /** AI 生成时用的模型名，便于复现 */
  model?: string;
  /** 生成时说的一句话，留在工程里作为"来路" */
  brief?: string;
  created?: string;
  updated?: string;
}

export interface Score {
  /** 工程格式版本，不是应用版本 */
  v: 1;
  title: string;
  subtitle?: string;
  composer?: string;
  key: KeySig;
  /** [分子, 分母]，如 [4, 4]；v0.1 一曲一换（变拍号在 v0.2 支持） */
  time: [number, number];
  /** 每分钟四分音符数 */
  tempo: number;
  tracks: Track[];
  meta?: ScoreMeta;
}

/** 解析/校验失败一律抛这个，界面只展示 message，不打栈 */
export class MusicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicError";
  }
}

const TRACK_COLORS = [
  "#FF6B6B",
  "#34E8D2",
  "#FFC94D",
  "#7B9BFF",
  "#B388FF",
  "#5AD67D",
  "#FF8FD0",
  "#63C7FF",
];

let seq = 0;
/** 只在单进程内唯一即可：工程文件里 id 的作用是选中与 diff，不承担跨设备标识 */
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${seq.toString(36)}`;
}

/** 供 verify/测试复盘 id 生成（跨用例只比结构，不比 id） */
export function resetUid(): void {
  seq = 0;
}

export const DEFAULT_SAMPLE_RATE = 48000;

export function beatsPerMeasure(score: Pick<Score, "time">): number {
  const [num, den] = score.time;
  if (num <= 0 || den <= 0) return 4;
  return (num * 4) / den;
}

/** 一小节多少拍（给排版与卷帘共用） */
export function measureCount(score: Score): number {
  const bpm = beatsPerMeasure(score);
  const end = scoreEnd(score);
  return Math.max(1, Math.ceil(end / bpm - 1e-9));
}

/** 最后一个音符的结束拍；空谱返回 0 */
export function scoreEnd(score: Score): number {
  let end = 0;
  for (const t of score.tracks) {
    for (const n of t.notes) {
      const e = n.start + Math.max(n.dur, 0);
      if (e > end) end = e;
    }
  }
  return end;
}

/** 拍到小节序号（0 基） */
export function measureOfBeat(score: Pick<Score, "time">, beat: number): number {
  const bpm = beatsPerMeasure(score);
  return Math.floor((beat + 1e-9) / bpm);
}

/** 拍 → "小节.拍" 人类可读位置（1 基，方便对着谱面说位置） */
export function beatToBarBeat(score: Pick<Score, "time">, beat: number): { bar: number; beat: number } {
  const bpm = beatsPerMeasure(score);
  const bar = Math.floor((beat + 1e-9) / bpm) + 1;
  const within = beat - (bar - 1) * bpm;
  return { bar, beat: Math.round(within * 1000) / 1000 + 1 };
}

export function newNote(p: Partial<Note> & { start: number; dur: number; pitch: number }): Note {
  return {
    id: p.id ?? uid("n"),
    start: p.start,
    dur: p.dur,
    pitch: p.pitch,
    vel: p.vel ?? 88,
    ...(p.tie === undefined ? {} : { tie: p.tie }),
    ...(p.dot === undefined ? {} : { dot: p.dot }),
    ...(p.art === undefined ? {} : { art: p.art }),
    ...(p.dyn === undefined ? {} : { dyn: p.dyn }),
    ...(p.lyric === undefined ? {} : { lyric: p.lyric }),
  };
}

export function newTrack(p: Partial<Track> = {}): Track {
  return {
    id: p.id ?? uid("t"),
    name: p.name ?? "新轨道",
    instrument: p.instrument ?? "piano",
    program: p.program ?? 0,
    volume: p.volume ?? 0.8,
    pan: p.pan ?? 0,
    mute: p.mute ?? false,
    solo: p.solo ?? false,
    clef: p.clef ?? "treble",
    color: p.color ?? TRACK_COLORS[0],
    notes: p.notes ?? [],
  };
}

export function trackColor(i: number): string {
  return TRACK_COLORS[i % TRACK_COLORS.length];
}

export function emptyScore(title = "未命名工程"): Score {
  return {
    v: 1,
    title,
    composer: "",
    key: { tonic: 0, mode: "major" },
    time: [4, 4],
    tempo: 88,
    tracks: [newTrack({ name: "钢琴", instrument: "piano", clef: "grand", color: TRACK_COLORS[0] })],
  };
}

export function cloneScore(s: Score): Score {
  return {
    ...s,
    key: { ...s.key },
    time: [s.time[0], s.time[1]],
    tracks: s.tracks.map((t) => ({ ...t, notes: t.notes.map((n) => ({ ...n })) })),
    ...(s.meta ? { meta: { ...s.meta } } : {}),
  };
}

/** 同轨按时间排序；同起始按音高升序（和弦内稳定） */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

export function sortScore(s: Score): Score {
  return { ...s, tracks: s.tracks.map((t) => ({ ...t, notes: sortNotes(t.notes) })) };
}

/** 把一条轨按小节切开，长度固定为 measureCount，空小节给空数组 */
export function splitByMeasure(score: Score, track: Track): Note[][] {
  const bpm = beatsPerMeasure(score);
  const n = measureCount(score);
  const out: Note[][] = Array.from({ length: n }, () => []);
  for (const note of track.notes) {
    const idx = Math.floor((note.start + 1e-9) / bpm);
    if (idx < 0) continue;
    if (idx >= n) out[n - 1].push(note);
    else out[idx].push(note);
  }
  return out;
}

/* ------------------------------------------------------------------ 音高 */

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export function pitchName(midi: number, flats = false): string {
  if (midi < 0) return "休止";
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${(flats ? FLAT_NAMES : SHARP_NAMES)[pc]}${oct}`;
}

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

const NAME_TO_PC: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** "C4" / "F#3" / "Bb5" → MIDI；无法解析返回 null（调用方决定报错还是跳过） */
export function midiOf(name: string): number | null {
  const m = /^([A-Ga-g])([#b]{0,2})(-?\d)$/.exec(name.trim());
  if (!m) return null;
  const base = NAME_TO_PC[m[1].toUpperCase()];
  if (base === undefined) return null;
  let acc = 0;
  for (const ch of m[2]) acc += ch === "#" ? 1 : -1;
  const oct = Number(m[3]);
  const midi = (oct + 1) * 12 + base + acc;
  if (midi < 0 || midi > 127) return null;
  return midi;
}

/* ------------------------------------------------------------- 结构校验 */

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 从任意 JSON 还原成 Score。工程文件、AI 返回、导入结果都必须过这里。
 * 报错要能指到具体位置：只说"格式错误"等于让用户自己猜。
 */
export function parseScore(raw: unknown): Score {
  if (!raw || typeof raw !== "object") throw new MusicError("工程内容不是一个对象");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) throw new MusicError(`工程格式版本不支持：${String(o.v)}（本版只认 v:1）`);
  const time = Array.isArray(o.time) ? o.time : null;
  if (!time || time.length !== 2 || !isNum(time[0]) || !isNum(time[1]) || time[0] <= 0 || time[1] <= 0) {
    throw new MusicError("拍号 time 必须形如 [4, 4]");
  }
  const keyRaw = (o.key ?? {}) as Record<string, unknown>;
  const tonic = isNum(keyRaw.tonic) ? keyRaw.tonic : 0;
  if (tonic < 0 || tonic > 11) throw new MusicError(`调号主音 tonic 越界：${tonic}`);
  const mode = keyRaw.mode === "minor" ? "minor" : "major";
  const tempo = isNum(o.tempo) ? o.tempo : 88;
  if (tempo < 20 || tempo > 300) throw new MusicError(`速度 tempo 越界：${tempo}（允许 20-300）`);
  const tracksRaw = o.tracks;
  if (!Array.isArray(tracksRaw) || tracksRaw.length === 0) throw new MusicError("工程至少需要一条轨道");
  const tracks: Track[] = tracksRaw.map((tr, ti) => {
    if (!tr || typeof tr !== "object") throw new MusicError(`第 ${ti + 1} 条轨道格式不对`);
    const t = tr as Record<string, unknown>;
    const notesRaw = Array.isArray(t.notes) ? t.notes : [];
    const notes: Note[] = notesRaw.map((nr, ni) => {
      if (!nr || typeof nr !== "object") throw new MusicError(`第 ${ti + 1} 轨第 ${ni + 1} 个音符格式不对`);
      const n = nr as Record<string, unknown>;
      const start = isNum(n.start) ? n.start : NaN;
      const dur = isNum(n.dur) ? n.dur : NaN;
      const pitch = isNum(n.pitch) ? n.pitch : NaN;
      if (!Number.isFinite(start) || start < 0) throw new MusicError(`第 ${ti + 1} 轨第 ${ni + 1} 个音符 start 非法`);
      if (!Number.isFinite(dur) || dur <= 0) throw new MusicError(`第 ${ti + 1} 轨第 ${ni + 1} 个音符 dur 非法`);
      if (!Number.isFinite(pitch) || pitch < -1 || pitch > 127) {
        throw new MusicError(`第 ${ti + 1} 轨第 ${ni + 1} 个音符 pitch 非法（-1 或 0-127）`);
      }
      const note: Note = {
        id: typeof n.id === "string" && n.id ? n.id : uid("n"),
        start,
        dur,
        pitch,
        vel: isNum(n.vel) ? Math.min(127, Math.max(1, Math.round(n.vel))) : 88,
      };
      if (n.tie === true) note.tie = true;
      if (n.dot === 1 || n.dot === 2) note.dot = n.dot;
      if (typeof n.art === "string") note.art = n.art as Articulation;
      if (typeof n.dyn === "string") note.dyn = n.dyn as Dynamic;
      if (typeof n.lyric === "string") note.lyric = n.lyric;
      return note;
    });
    return newTrack({
      id: typeof t.id === "string" && t.id ? t.id : uid("t"),
      name: typeof t.name === "string" ? t.name : `轨道 ${ti + 1}`,
      instrument: (typeof t.instrument === "string" ? t.instrument : "piano") as InstrumentId,
      program: isNum(t.program) ? Math.min(127, Math.max(0, Math.round(t.program))) : 0,
      volume: isNum(t.volume) ? Math.min(1, Math.max(0, t.volume)) : 0.8,
      pan: isNum(t.pan) ? Math.min(1, Math.max(-1, t.pan)) : 0,
      mute: t.mute === true,
      solo: t.solo === true,
      clef: (typeof t.clef === "string" ? t.clef : "treble") as Clef,
      color: typeof t.color === "string" ? t.color : trackColor(ti),
      notes,
    });
  });
  const metaRaw = (o.meta ?? {}) as Record<string, unknown>;
  return {
    v: 1,
    title: typeof o.title === "string" && o.title.trim() ? o.title : "未命名工程",
    ...(typeof o.subtitle === "string" ? { subtitle: o.subtitle } : {}),
    ...(typeof o.composer === "string" ? { composer: o.composer } : {}),
    key: { tonic, mode },
    time: [Math.round(time[0]), Math.round(time[1])],
    tempo: Math.round(tempo),
    tracks,
    ...(o.meta && typeof o.meta === "object"
      ? {
          meta: {
            ...(typeof metaRaw.origin === "string" ? { origin: metaRaw.origin as ScoreMeta["origin"] } : {}),
            ...(typeof metaRaw.model === "string" ? { model: metaRaw.model } : {}),
            ...(typeof metaRaw.brief === "string" ? { brief: metaRaw.brief } : {}),
            ...(typeof metaRaw.created === "string" ? { created: metaRaw.created } : {}),
            ...(typeof metaRaw.updated === "string" ? { updated: metaRaw.updated } : {}),
          },
        }
      : {}),
  };
}

/** 序列化成工程文件（稳定字段顺序，便于 git diff 与肉眼比对） */
export function serializeScore(s: Score): string {
  return JSON.stringify(
    {
      v: 1,
      title: s.title,
      ...(s.subtitle ? { subtitle: s.subtitle } : {}),
      ...(s.composer ? { composer: s.composer } : {}),
      key: { tonic: s.key.tonic, mode: s.key.mode },
      time: [s.time[0], s.time[1]],
      tempo: s.tempo,
      tracks: s.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        instrument: t.instrument,
        program: t.program,
        volume: t.volume,
        pan: t.pan,
        mute: t.mute,
        solo: t.solo,
        clef: t.clef,
        color: t.color,
        notes: sortNotes(t.notes).map((n) => ({
          id: n.id,
          start: round3(n.start),
          dur: round3(n.dur),
          pitch: n.pitch,
          vel: n.vel,
          ...(n.tie ? { tie: true } : {}),
          ...(n.dot ? { dot: n.dot } : {}),
          ...(n.art ? { art: n.art } : {}),
          ...(n.dyn ? { dyn: n.dyn } : {}),
          ...(n.lyric ? { lyric: n.lyric } : {}),
        })),
      })),
      ...(s.meta ? { meta: s.meta } : {}),
    },
    null,
    2,
  );
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** 该轨是否真的会发声（考虑 solo 语义：有 solo 时只有 solo 轨响） */
export function audibleTracks(score: Score): Track[] {
  const solos = score.tracks.filter((t) => t.solo);
  const pool = solos.length > 0 ? solos : score.tracks;
  return pool.filter((t) => !t.mute);
}

/** 轨内可用音域，给卷帘定纵轴范围 */
export function pitchRange(score: Score): { lo: number; hi: number } {
  let lo = 127;
  let hi = 0;
  for (const t of score.tracks) {
    for (const n of t.notes) {
      if (n.pitch < 0) continue;
      if (n.pitch < lo) lo = n.pitch;
      if (n.pitch > hi) hi = n.pitch;
    }
  }
  if (lo > hi) return { lo: 48, hi: 84 };
  return { lo: Math.max(0, lo - 2), hi: Math.min(127, hi + 2) };
}
