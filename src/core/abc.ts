/**
 * ABC 记谱法的「严格子集」读写。
 *
 * 为什么用 ABC 而不是 MusicXML 当 AI 的中间语言：
 *   - 一首 32 小节的小品，ABC 约 400 token，MusicXML 要 6000+；
 *   - LLM 对 ABC 的语法准确率明显高于对嵌套 XML 的准确率；
 *   - 人能读，出错时能直接指着说"第 3 小节那个记号不对"。
 *
 * 所以这个解析器只认一个明确定义的子集，**不认识的记号一律报错并指出小节**。
 * 静默忽略是最坏的选择：AI 的错会变成用户看到的错，而且没人知道是哪一步丢的。
 *
 * 支持的子集：
 *   头: X T C M L Q K V   （`%%score` / `w:` / `W:` 等其余头行忽略）
 *   音: `_ ^ =` 升降 + A-Ga-g + `, '` 八度 + 时值数字/斜杠
 *   和弦: `[CEG]` + 共享时值
 *   休止: `z` / `x`
 *   连音线: 音后 `-`
 *   小节线: `|` `||` `|]` `[|` `|:` `:|` `::`（反复记号不解释，只当小节线）
 * 不支持（会报错而不是忽略）：装饰音 `{}`、破碎节奏 `>` `<`、多声部 `&`。
 */

import {
  MusicError,
  beatsPerMeasure,
  measureCount,
  newNote,
  newTrack,
  sortNotes,
  trackColor,
  type Note,
  type Score,
  type Track,
} from "./model.ts";
import { abcKeyName, accidentalCount, keyAlterOf, spellPitch } from "./theory.ts";

const LETTERS = "CDEFGAB";
const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

/* ================================================================ 写 ABC */

/** 音高 → ABC 记号（拼法统一由 theory.spellPitch 决定，避免两个模块各拼一套） */
export function abcPitchOf(pitch: number, keyTonic: number, mode: "major" | "minor"): string {
  if (pitch < 0) return "z";
  return accidentalPrefix(pitch, keyTonic, mode, undefined) + pitchBody(pitch, keyTonic, mode);
}

function pitchBody(pitch: number, keyTonic: number, mode: "major" | "minor"): string {
  const sp = spellPitch(pitch, { tonic: keyTonic, mode });
  return sp.octave >= 5
    ? sp.step.toLowerCase() + "'".repeat(sp.octave - 5)
    : sp.step.toUpperCase() + ",".repeat(Math.max(0, 4 - sp.octave));
}

/**
 * 升降号前缀。
 *
 * 这里必须记住「本小节这个字母已经出现过什么升降」，因为 ABC（和所有五线谱）
 * 的临时升降号在同小节内是会沿用的：如果第 1 拍写了 ^D，第 3 拍的 D 还原音
 * 就不能只写 "D"，必须写 "=D" 把它取消掉，否则回读会被理解成 D#。
 * 这个 bug 不会报错，只会静默改掉音高——所以由 roundTripCheck + verify 看住。
 */
function accidentalPrefix(
  pitch: number,
  keyTonic: number,
  mode: "major" | "minor",
  state: Map<string, number> | undefined,
): string {
  const sp = spellPitch(pitch, { tonic: keyTonic, mode });
  const implied = keyAlterOf(sp.step, { tonic: keyTonic, mode });
  const current = state?.has(sp.step) ? (state.get(sp.step) as number) : implied;
  state?.set(sp.step, sp.alter);
  if (sp.alter === current) return "";
  if (sp.alter === 0) return "=";
  return sp.alter > 0 ? "^".repeat(sp.alter) : "_".repeat(-sp.alter);
}

/** 时值（拍） → ABC 时值后缀；以 1/4 拍（16 分音符）为最小单位 */
export function abcLengthOf(dur: number): string {
  const n = Math.max(1, Math.round(dur * 4));
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(n, 4);
  const p = n / g;
  const den = 4 / g;
  if (den === 1) return p === 1 ? "" : String(p);
  return p === 1 ? `/${den}` : `${p}/${den}`;
}

/** 同一起点的音并成和弦组；时值不同的拆成不同组（谱面上一根符干只挂同时值的音） */
export function chordGroups(notes: Note[]): Note[][] {
  const sorted = sortNotes(notes);
  const groups: Note[][] = [];
  let i = 0;
  while (i < sorted.length) {
    const head = sorted[i];
    const same: Note[] = [head];
    let j = i + 1;
    while (j < sorted.length && Math.abs(sorted[j].start - head.start) < 1e-6) {
      same.push(sorted[j]);
      j++;
    }
    const byDur = new Map<string, Note[]>();
    for (const n of same) {
      const k = n.dur.toFixed(4);
      const arr = byDur.get(k);
      if (arr) arr.push(n);
      else byDur.set(k, [n]);
    }
    for (const arr of byDur.values()) groups.push(arr);
    i = j;
  }
  return groups.sort((a, b) => a[0].start - b[0].start);
}

export interface Segment {
  start: number;
  dur: number;
  notes: Note[];
}

/**
 * 把音符切成不跨小节线的段（跨了就切两段并标连音线）。
 * 排版必须这么做：五线谱不能画一根跨小节的符干，简谱也不能。
 */
export function splitAtBarlines(notes: Note[], bpm: number): Segment[] {
  const out: Segment[] = [];
  for (const group of chordGroups(notes)) {
    const head = group[0];
    let start = head.start;
    let remaining = head.dur;
    let first = true;
    let guard = 0;
    while (remaining > 1e-6 && guard++ < 64) {
      const barIdx = Math.floor((start + 1e-9) / bpm);
      const barEnd = (barIdx + 1) * bpm;
      const conn = Math.min(remaining, barEnd - start);
      out.push({
        start,
        dur: conn,
        notes: group.map((n) => ({ ...n, start, dur: conn, ...(first ? {} : { tie: true }) })),
      });
      start += conn;
      remaining -= conn;
      first = false;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function renderVoice(notes: Note[], score: Score, bpm: number, bars: number): string {
  const segs = splitAtBarlines(notes, bpm);
  const lines: string[] = [];
  let cursor = 0;
  for (let bar = 0; bar < bars; bar++) {
    const barEnd = (bar + 1) * bpm;
    // 临时升降号按小节记忆（见 accidentalPrefix）
    const barAcc = new Map<string, number>();
    const at = (pitch: number) =>
      accidentalPrefix(pitch, score.key.tonic, score.key.mode, barAcc) +
      pitchBody(pitch, score.key.tonic, score.key.mode);
    const inBar = segs.filter((s) => s.start >= bar * bpm - 1e-6 && s.start < barEnd - 1e-6);
    let line = "";
    for (const seg of inBar) {
      if (seg.start > cursor + 1e-6) {
        line += `z${abcLengthOf(seg.start - cursor)}`;
        cursor = seg.start;
      }
      const pitches = seg.notes.filter((n) => n.pitch >= 0);
      const durStr = abcLengthOf(seg.dur);
      const tieStr = pitches.some((n) => n.tie) ? "-" : "";
      if (pitches.length === 0) {
        line += `z${durStr}`;
      } else if (pitches.length === 1) {
        line += at(pitches[0].pitch) + durStr + tieStr;
      } else {
        const inner = pitches.map((n) => at(n.pitch)).join("");
        line += `[${inner}]${durStr}${tieStr}`;
      }
      cursor = seg.start + seg.dur;
    }
    if (cursor < barEnd - 1e-6) {
      line += `z${abcLengthOf(barEnd - cursor)}`;
      cursor = barEnd;
    }
    lines.push(`${line} |`);
  }
  return lines.join("\n");
}

export interface AbcOptions {
  /** 是否附带和弦标记；v0.1 不生成，留参数位给 v0.2 的和弦轨 */
  chordSymbols?: boolean;
}

/** Score → ABC 文本。单轨不写 V:，多轨每轨一段（abcjs 按 %%score 并成大谱表） */
export function toAbc(score: Score, _opts: AbcOptions = {}): string {
  const bpm = beatsPerMeasure(score);
  const bars = measureCount(score);
  const [num, den] = score.time;
  const head: string[] = ["X:1", `T:${(score.title || "未命名").replace(/\n/g, " ")}`];
  if (score.composer) head.push(`C:${score.composer.replace(/\n/g, " ")}`);
  head.push(`M:${num}/${den}`, `L:1/${den}`, `Q:1/4=${Math.round(score.tempo)}`);
  // 花括号 = 大谱表连写：多轨竖着并成一个系统，左侧画一条括号（abcjs 的语法）
  if (score.tracks.length > 1) head.push(`%%score {${score.tracks.map((_, i) => i + 1).join(" ")}}`);
  head.push(`K:${abcKeyName(score.key)}`);
  if (score.tracks.length === 1) {
    return `${head.join("\n")}\n${renderVoice(score.tracks[0].notes, score, bpm, bars)}\n`;
  }
  const parts: string[] = [];
  score.tracks.forEach((t, i) => {
    parts.push(`V:${i + 1} name="${t.name.replace(/"/g, "'")}" clef=${t.clef === "bass" ? "bass" : "treble"}`);
    parts.push(renderVoice(t.notes, score, bpm, bars));
  });
  return `${head.join("\n")}\n${parts.join("\n")}\n`;
}

/* ============================================================== 读 ABC */

interface VoiceBuf {
  id: string;
  name: string;
  clef: "treble" | "bass";
  notes: Note[];
}

interface Head {
  title: string;
  composer: string;
  time: [number, number];
  defaultLen: number;
  tempo: number;
  key: { tonic: number; mode: "major" | "minor" };
}

function keySignatureAccidental(letter: string, key: Head["key"]): number {
  const n = accidentalCount(key);
  if (n > 0 && SHARP_ORDER.slice(0, n).includes(letter)) return 1;
  if (n < 0 && FLAT_ORDER.slice(0, -n).includes(letter)) return -1;
  return 0;
}

function parseKeyField(v: string): { tonic: number; mode: "major" | "minor" } {
  const s = v.trim();
  const m = /^([A-Ga-g])([#b]{0,2})\s*(m|min|minor|maj|major)?/.exec(s);
  if (!m) throw new MusicError(`调号 K:${v} 读不出来（本版只支持大调/小调）`);
  const base = NATURAL_PC[m[1].toUpperCase()];
  let acc = 0;
  for (const ch of m[2] ?? "") acc += ch === "#" ? 1 : -1;
  const isMinor = /^(m|min|minor)$/i.test(m[3] ?? "");
  return { tonic: (((base + acc) % 12) + 12) % 12, mode: isMinor ? "minor" : "major" };
}

function parseMeter(v: string): [number, number] {
  const s = v.trim();
  if (s === "C") return [4, 4];
  if (s === "C|") return [2, 2];
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (!m) throw new MusicError(`拍号 M:${v} 读不出来`);
  return [Number(m[1]), Number(m[2])];
}

/** 解析时值后缀（"2" / "/2" / "3/2" / "/" / "//"），返回相对默认时值的倍数 */
function lengthMultiplier(mod: string): number {
  if (!mod) return 1;
  if (mod === "/") return 0.5;
  if (mod === "//") return 0.25;
  const m = /^(\d*)\/(\d*)$/.exec(mod);
  if (m) {
    const num = m[1] === "" ? 1 : Number(m[1]);
    const den = m[2] === "" ? 2 : Number(m[2]);
    return den === 0 ? num : num / den;
  }
  const digits = /^(\d+)$/.exec(mod);
  return digits ? Number(digits[1]) : 1;
}

function readLengthMod(s: string, i: number): { mod: string; next: number } {
  let j = i;
  let mod = "";
  while (j < s.length && /\d/.test(s[j])) mod += s[j++];
  if (s[j] === "/") {
    mod += "/";
    j++;
    while (j < s.length && /\d/.test(s[j])) mod += s[j++];
  }
  return { mod, next: j };
}

/** 读一个音（含升降号与八度记号）；读不出返回 null */
function readPitch(
  s: string,
  i: number,
  ctx: { key: Head["key"]; barAcc: Map<string, number> },
): { midi: number; next: number } | null {
  let j = i;
  let acc = 0;
  let explicit = false;
  while (j < s.length && (s[j] === "^" || s[j] === "_" || s[j] === "=")) {
    if (s[j] === "^") acc += 1;
    else if (s[j] === "_") acc -= 1;
    else acc = 0;
    explicit = true;
    j++;
  }
  if (j >= s.length) return null;
  const raw = s[j];
  const letter = raw.toUpperCase();
  if (!LETTERS.includes(letter)) return null;
  const isLower = raw === raw.toLowerCase();
  j++;
  let octave = isLower ? 5 : 4;
  while (j < s.length && (s[j] === "," || s[j] === "'")) {
    octave += s[j] === "," ? -1 : 1;
    j++;
  }
  let semis: number;
  if (explicit) {
    semis = acc;
    // 同小节内临时升降号沿用（ABC 规范）
    ctx.barAcc.set(letter, acc);
  } else if (ctx.barAcc.has(letter)) {
    semis = ctx.barAcc.get(letter) ?? 0;
  } else {
    semis = keySignatureAccidental(letter, ctx.key);
  }
  const midi = (octave + 1) * 12 + NATURAL_PC[letter] + semis;
  if (midi < 0 || midi > 127) return null;
  return { midi, next: j };
}

/**
 * ABC → Score。
 * 报错带小节号；warnings 是"能读但按我们的规矩改了"的地方，界面会显示出来，
 * 不让用户以为一切都照原样。
 */
export function parseAbc(text: string, fallbackTitle = "导入的 ABC"): { score: Score; warnings: string[] } {
  const warnings: string[] = [];
  const head: Head = {
    title: fallbackTitle,
    composer: "",
    time: [4, 4],
    defaultLen: 1,
    tempo: 88,
    key: { tonic: 0, mode: "major" },
  };
  const voices = new Map<string, VoiceBuf>();
  let curVoice = "1";
  let sawK = false;

  const ensureVoice = (id: string): VoiceBuf => {
    let v = voices.get(id);
    if (!v) {
      v = { id, name: voices.size === 0 ? "主旋律" : `声部 ${id}`, clef: "treble", notes: [] };
      voices.set(id, v);
    }
    return v;
  };
  ensureVoice(curVoice);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("%")) continue; // %%score / %%MIDI 等排版指令
    const headMatch = /^([A-Za-z]):\s*(.*)$/.exec(line);
    if (headMatch) {
      const f = headMatch[1];
      const v = headMatch[2];
      if (f === "X") continue;
      if (f === "T") {
        if (head.title === fallbackTitle && v.trim()) head.title = v.trim();
        continue;
      }
      if (f === "C") {
        head.composer = v.trim();
        continue;
      }
      if (f === "M") {
        head.time = parseMeter(v);
        continue;
      }
      if (f === "L") {
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v.trim());
        if (!m) throw new MusicError(`默认时值 L:${v} 读不出来`);
        head.defaultLen = (4 * Number(m[1])) / Number(m[2]);
        continue;
      }
      if (f === "Q") {
        const m = /(?:1\/\d+=)?(\d+)/.exec(v);
        if (m) head.tempo = Number(m[1]);
        continue;
      }
      if (f === "K") {
        head.key = parseKeyField(v);
        sawK = true;
        continue;
      }
      if (f === "V") {
        const idm = /^(\S+)/.exec(v);
        const id = idm ? idm[1].split(";")[0] : "1";
        const nameM = /name\s*=\s*"([^"]*)"/.exec(v);
        const clefM = /clef\s*=\s*(\w+)/.exec(v);
        const nv = ensureVoice(id);
        if (nameM) nv.name = nameM[1];
        if (clefM) nv.clef = clefM[1].toLowerCase() === "bass" ? "bass" : "treble";
        curVoice = id;
        continue;
      }
      continue; // w: / W: / R: / Z: / S: 等非乐谱字段
    }
    if (!sawK) {
      warnings.push("ABC 缺少 K: 调号字段，已按 C 大调处理");
      sawK = true;
    }
    parseBodyLine(line, ensureVoice(curVoice), head, warnings);
  }

  const tracks: Track[] = [];
  let ti = 0;
  for (const v of voices.values()) {
    const notes = v.notes.filter((n) => n.dur > 0);
    if (notes.length === 0) continue;
    tracks.push(
      newTrack({
        name: v.name,
        instrument: tracks.length === 0 ? "piano" : "strings",
        clef: v.clef === "bass" ? "bass" : tracks.length === 0 ? "grand" : "treble",
        color: trackColor(ti++),
        notes,
      }),
    );
  }
  if (tracks.length === 0) throw new MusicError("ABC 解析完成但没有产生任何音符");

  return {
    score: {
      v: 1,
      title: head.title || fallbackTitle,
      ...(head.composer ? { composer: head.composer } : {}),
      key: head.key,
      time: head.time,
      tempo: Math.min(300, Math.max(20, Math.round(head.tempo))),
      tracks,
      meta: { origin: "import" },
    },
    warnings,
  };
}

function parseBodyLine(line: string, voice: VoiceBuf, head: Head, warnings: string[]): void {
  const bpm = (head.time[0] * 4) / head.time[1];
  let cursor = voice.notes.reduce((acc, n) => Math.max(acc, n.start + n.dur), 0);
  let bar = Math.floor((cursor + 1e-9) / bpm);
  const barAcc = new Map<string, number>();
  let i = 0;

  const where = () => `第 ${bar + 1} 小节`;
  const pushRest = (dur: number) => {
    if (dur <= 0) return;
    voice.notes.push(newNote({ start: cursor, dur, pitch: -1, vel: 1 }));
    cursor += dur;
  };

  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "|" || ch === ":") {
      i++;
      while (i < line.length && /[|\]:]/.test(line[i])) i++;
      const barEnd = (bar + 1) * bpm;
      if (cursor < barEnd - 1e-6) pushRest(barEnd - cursor);
      cursor = barEnd;
      bar += 1;
      barAcc.clear();
      continue;
    }
    if (ch === '"') {
      const close = line.indexOf('"', i + 1);
      if (close < 0) throw new MusicError(`${where()} 的和弦标记缺少收尾引号`);
      i = close + 1;
      continue;
    }
    if (ch === "!") {
      const close = line.indexOf("!", i + 1);
      if (close < 0) throw new MusicError(`${where()} 的装饰记号缺少收尾 !`);
      i = close + 1;
      continue;
    }
    if (ch === "{") throw new MusicError(`${where()} 用了装饰音 {}，本版不支持（请改写成普通音符）`);
    if (ch === "&") throw new MusicError(`${where()} 用了多声部连接符 &，本版不支持（请用 V: 分声部）`);
    if (ch === ">" || ch === "<") throw new MusicError(`${where()} 用了破碎节奏 ${ch}，本版不支持`);
    if (ch === "-") {
      const last = voice.notes[voice.notes.length - 1];
      if (last && last.pitch >= 0) last.tie = true;
      i++;
      continue;
    }
    if (ch === "]") {
      i++;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      const pitches: number[] = [];
      while (j < line.length && line[j] !== "]") {
        const res = readPitch(line, j, { key: head.key, barAcc });
        if (!res) throw new MusicError(`${where()} 的和弦里有读不出的音（位置 ${j + 1}）`);
        pitches.push(res.midi);
        j = res.next;
      }
      if (line[j] !== "]") throw new MusicError(`${where()} 的和弦缺少收尾 ]`);
      const lenRes = readLengthMod(line, j + 1);
      const dur = head.defaultLen * lengthMultiplier(lenRes.mod);
      for (const p of pitches) voice.notes.push(newNote({ start: cursor, dur, pitch: p }));
      cursor += dur;
      i = lenRes.next;
      continue;
    }
    if (ch === "z" || ch === "x") {
      const lenRes = readLengthMod(line, i + 1);
      pushRest(head.defaultLen * lengthMultiplier(lenRes.mod));
      i = lenRes.next;
      continue;
    }
    if (ch === ".") {
      const last = voice.notes[voice.notes.length - 1];
      if (last) last.art = "staccato";
      i++;
      continue;
    }
    const res = readPitch(line, i, { key: head.key, barAcc });
    if (res) {
      const lenRes = readLengthMod(line, res.next);
      const dur = head.defaultLen * lengthMultiplier(lenRes.mod);
      if (dur <= 0) throw new MusicError(`${where()} 的音符时值为 0`);
      voice.notes.push(newNote({ start: cursor, dur, pitch: res.midi }));
      cursor += dur;
      i = lenRes.next;
      continue;
    }
    throw new MusicError(`${where()} 出现了不认识的记号 "${ch}"（位置 ${i + 1}）`);
  }
  const barEnd = (bar + 1) * bpm;
  if (cursor > barEnd + 1e-6) {
    warnings.push(`${where()} 时值超出拍号（多 ${(cursor - barEnd).toFixed(2)} 拍），已按原样保留`);
  }
}

/** 便捷：ABC 文本 → Score */
export function abcToScore(text: string, title?: string): Score {
  return parseAbc(text, title).score;
}

/** 导出前自检：Score → ABC → 回读，音符数与音高序列一致才允许导出 */
export function roundTripCheck(score: Score): { ok: boolean; error?: string } {
  try {
    const abc = toAbc(score);
    const back = parseAbc(abc, score.title).score;
    const flat = (s: Score) =>
      s.tracks
        .map((t) => sortNotes(t.notes.filter((n) => n.pitch >= 0)).map((n) => n.pitch).join(","))
        .join("|");
    const a = flat(score);
    const b = flat(back);
    if (a !== b) {
      const an = a.split(/[|,]/).filter(Boolean).length;
      const bn = b.split(/[|,]/).filter(Boolean).length;
      return { ok: false, error: `回读音高序列不一致（${an} 音 → ${bn} 音）` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
