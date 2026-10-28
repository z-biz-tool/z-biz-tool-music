/**
 * MusicXML 4.0（partwise）导出与导入。
 *
 * MusicXML 是这一行的通用语：导出去 MuseScore / Sibelius / Dorico 都能开，
 * 所以「能在别处接着改」这件事不用自己实现，交给格式互操作。
 *
 * divisions = 12（四分音符 = 12）：16 分音符是 3、三连音是 4，两个都能整除，
 * 用 4 或 480 也能过，但 12 是能同时表示这两类的最小数。
 */

import {
  MusicError,
  beatsPerMeasure,
  measureCount,
  newNote,
  newTrack,
  trackColor,
  type KeySig,
  type Note,
  type Score,
  type Track,
} from "./model.ts";
import { splitAtBarlines, type Segment } from "./abc.ts";
import { instrumentSpec, spellPitch } from "./theory.ts";
import { child, children, escapeXml, find, numOf, parseXml, textOf } from "./xml.ts";

const DIVISIONS = 12;
const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11];

/** 时值 → MusicXML 的 type 与附点 */
export function musicXmlType(dur: number): { type: string; dots: number } {
  const bases: [number, string][] = [
    [4, "whole"],
    [2, "half"],
    [1, "quarter"],
    [0.5, "eighth"],
    [0.25, "16th"],
    [0.125, "32nd"],
  ];
  for (const [base, type] of bases) {
    for (const dots of [0, 1, 2]) {
      const value = base * (2 - Math.pow(0.5, dots));
      if (Math.abs(value - dur) < 1e-6) return { type, dots };
    }
  }
  let best = { type: "quarter", diff: Infinity };
  for (const [base, type] of bases) {
    const diff = Math.abs(base - dur);
    if (diff < best.diff) best = { type, diff };
  }
  return { type: best.type, dots: 0 };
}

function clefXml(clef: Track["clef"], staffNumber?: number): string {
  const inner =
    clef === "bass"
      ? "<sign>F</sign><line>4</line>"
      : clef === "alto"
        ? "<sign>C</sign><line>3</line>"
        : "<sign>G</sign><line>2</line>";
  return `<clef${staffNumber ? ` number="${staffNumber}"` : ""}>${inner}</clef>`;
}

function noteXml(
  notes: Note[],
  opts: { staff?: number; voice: number; isChordHead: boolean; key: KeySig },
): string {
  const head = notes[0];
  const { type, dots } = musicXmlType(head.dur);
  const durs = Math.max(1, Math.round(head.dur * DIVISIONS));
  const body: string[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const parts: string[] = [];
    if (i > 0) parts.push("<chord/>");
    const sp = spellPitch(n.pitch, opts.key);
    parts.push(
      `<pitch><step>${sp.step}</step>${sp.alter !== 0 ? `<alter>${sp.alter}</alter>` : ""}<octave>${sp.octave}</octave></pitch>`,
    );
    parts.push(`<duration>${durs}</duration>`);
    if (n.tie) {
      parts.push('<tie type="start"/>');
    }
    parts.push(`<voice>${opts.voice}</voice>`);
    parts.push(`<type>${type}</type>`);
    for (let d = 0; d < dots; d++) parts.push("<dot/>");
    if (n.art) {
      const artMap: Record<string, string> = {
        staccato: "staccato",
        accent: "accent",
        tenuto: "tenuto",
        fermata: "fermata",
      };
      const a = artMap[n.art];
      if (a) parts.push(`<notations><articulations><${a}/></articulations></notations>`);
    }
    if (n.lyric) parts.push(`<lyric><syllabic>single</syllabic><text>${escapeXml(n.lyric)}</text></lyric>`);
    if (opts.staff) parts.push(`<staff>${opts.staff}</staff>`);
    body.push(`<note>${parts.join("")}</note>`);
  }
  void opts.isChordHead;
  return body.join("");
}

function restXml(dur: number, voice: number, staff?: number): string {
  const { type, dots } = musicXmlType(dur);
  const durs = Math.max(1, Math.round(dur * DIVISIONS));
  const parts = [
    "<rest/>",
    `<duration>${durs}</duration>`,
    `<voice>${voice}</voice>`,
    `<type>${type}</type>`,
    ...Array.from({ length: dots }, () => "<dot/>"),
    ...(staff ? [`<staff>${staff}</staff>`] : []),
  ];
  return `<note>${parts.join("")}</note>`;
}

/** 单条「时间线」的小节内容：按自己的音符走，空隙补休止 */
function staffMeasureXml(
  segs: Segment[],
  barStart: number,
  barEnd: number,
  voice: number,
  staff: number | undefined,
  key: KeySig,
): string {
  const out: string[] = [];
  let cursor = barStart;
  for (const seg of segs) {
    if (seg.start > cursor + 1e-6) {
      out.push(restXml(seg.start - cursor, voice, staff));
      cursor = seg.start;
    }
    const sounding = seg.notes.filter((n) => n.pitch >= 0);
    if (sounding.length === 0) {
      out.push(restXml(seg.dur, voice, staff));
    } else {
      out.push(noteXml(sounding, { staff, voice, isChordHead: true, key }));
    }
    cursor = seg.start + seg.dur;
  }
  if (cursor < barEnd - 1e-6) out.push(restXml(barEnd - cursor, voice, staff));
  return out.join("");
}

function partXml(score: Score, track: Track, index: number): string {
  const bpm = beatsPerMeasure(score);
  const bars = measureCount(score);
  const grand = track.clef === "grand";
  const segs = splitAtBarlines(track.notes, bpm);
  const measures: string[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * bpm;
    const end = start + bpm;
    const inBar = segs.filter((s) => s.start >= start - 1e-6 && s.start < end - 1e-6);
    const pieces: string[] = [];
    if (bar === 0) {
      pieces.push(
        [
          "<attributes>",
          `<divisions>${DIVISIONS}</divisions>`,
          `<key><fifths>${fifthsOf(score.key)}</fifths><mode>${score.key.mode}</mode></key>`,
          `<time><beats>${score.time[0]}</beats><beat-type>${score.time[1]}</beat-type></time>`,
          grand ? "<staves>2</staves>" : "",
          grand ? clefXml("treble", 1) + clefXml("bass", 2) : clefXml(track.clef),
          "</attributes>",
          `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(
            score.tempo,
          )}</per-minute></metronome></direction-type><sound tempo="${Math.round(score.tempo)}"/></direction>`,
        ].join(""),
      );
    }
    if (grand) {
      const upper = inBar.filter((s) => avgPitch(s) >= 60);
      const lower = inBar.filter((s) => avgPitch(s) < 60);
      pieces.push(staffMeasureXml(upper, start, end, 1, 1, score.key));
      pieces.push(`<backup><duration>${Math.round(bpm * DIVISIONS)}</duration></backup>`);
      pieces.push(staffMeasureXml(lower, start, end, 2, 2, score.key));
    } else {
      pieces.push(staffMeasureXml(inBar, start, end, 1, undefined, score.key));
    }
    measures.push(`<measure number="${bar + 1}">${pieces.join("")}</measure>`);
  }
  return [`<part id="P${index + 1}">`, measures.join(""), "</part>"].join("");
}

function avgPitch(seg: Segment): number {
  const p = seg.notes.filter((n) => n.pitch >= 0);
  if (p.length === 0) return 60;
  return p.reduce((a, n) => a + n.pitch, 0) / p.length;
}

const FIFTHS_BY_TONIC_MAJOR: Record<number, number> = {
  0: 0,
  7: 1,
  2: 2,
  9: 3,
  4: 4,
  11: 5,
  6: 6,
  1: -5,
  5: -1,
  10: -2,
  3: -3,
  8: -4,
};

function fifthsOf(key: KeySig): number {
  const majorTonic = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  return FIFTHS_BY_TONIC_MAJOR[majorTonic] ?? 0;
}

/** Score → MusicXML 文本 */
export function toMusicXml(score: Score): string {
  const partList = score.tracks
    .map((t, i) => {
      const spec = instrumentSpec(t.instrument);
      return [
        `<score-part id="P${i + 1}">`,
        `<part-name>${escapeXml(t.name)}</part-name>`,
        `<score-instrument id="P${i + 1}-I1"><instrument-name>${escapeXml(spec.label)}</instrument-name></score-instrument>`,
        `<midi-instrument id="P${i + 1}-I1"><midi-channel>${(i % 15) + 1}</midi-channel><midi-program>${
          spec.program + 1
        }</midi-program><volume>${Math.round(t.volume * 100)}</volume><pan>${
          Math.round(t.pan * 90)
        }</pan></midi-instrument>`,
        "</score-part>",
      ].join("");
    })
    .join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(score.title)}</work-title></work>`,
    `<identification><creator type="composer">${escapeXml(score.composer ?? "")}</creator><encoding><software>MuseLab</software><encoding-date>${new Date().toISOString().slice(
      0,
      10,
    )}</encoding-date></encoding></identification>`,
    `<part-list>${partList}</part-list>`,
    ...score.tracks.map((t, i) => partXml(score, t, i)),
    "</score-partwise>",
    "",
  ].join("\n");
}

/* ================================================================ 导入 */

const TONIC_BY_FIFTHS: Record<number, number> = {
  0: 0,
  1: 7,
  2: 2,
  3: 9,
  4: 4,
  5: 11,
  6: 6,
  7: 1,
  [-1]: 5,
  [-2]: 10,
  [-3]: 3,
  [-4]: 8,
  [-5]: 1,
  [-6]: 6,
  [-7]: 11,
};

interface ImportCtx {
  divisions: number;
  key: KeySig;
  time: [number, number];
  tempo: number;
}

/** MusicXML → Score（基础子集：音高/时值/和弦/休止/backup/forward） */
export function fromMusicXml(text: string): { score: Score; warnings: string[] } {
  const warnings: string[] = [];
  const root = parseXml(text);
  const scoreEl = find(root, "score-partwise") ?? find(root, "score-timewise");
  if (!scoreEl) throw new MusicError("这不是 MusicXML 文件（找不到 score-partwise）");
  if (scoreEl.tag === "score-timewise") throw new MusicError("本版不支持 score-timewise，请另存为 partwise");

  const ctx: ImportCtx = { divisions: 1, key: { tonic: 0, mode: "major" }, time: [4, 4], tempo: 88 };
  const title =
    textOf(find(scoreEl, "work"), "work-title") ??
    textOf(scoreEl, "movement-title") ??
    "导入的 MusicXML";
  const composer = (() => {
    const id = find(scoreEl, "identification");
    const creators = children(id, "creator");
    const c = creators.find((x) => x.attrs.type === "composer") ?? creators[0];
    return c?.text.trim() ?? "";
  })();

  const partEls = children(scoreEl, "part");
  if (partEls.length === 0) throw new MusicError("MusicXML 里没有 part");
  const partNames = new Map<string, string>();
  const partList = find(scoreEl, "part-list");
  for (const sp of children(partList, "score-part")) {
    const id = sp.attrs.id;
    const name = textOf(sp, "part-name") ?? id;
    if (id) partNames.set(id, name);
  }

  const tracks: Track[] = [];
  partEls.forEach((partEl, pi) => {
    const notes: Note[] = [];
    let cursor = 0;
    let lastStart = 0;
    let maxEnd = 0;
    for (const measureEl of children(partEl, "measure")) {
      for (const el of measureEl.children) {
        if (el.tag === "attributes") {
          const div = numOf(el, "divisions");
          if (div && div > 0) ctx.divisions = div;
          const keyEl = child(el, "key");
          const fifths = numOf(keyEl, "fifths");
          if (fifths !== undefined) {
            const mode = textOf(keyEl, "mode") === "minor" ? "minor" : "major";
            const tonic = TONIC_BY_FIFTHS[fifths] ?? 0;
            ctx.key = { tonic: mode === "minor" ? (tonic + 9) % 12 : tonic, mode };
          }
          const timeEl = child(el, "time");
          const beats = numOf(timeEl, "beats");
          const beatType = numOf(timeEl, "beat-type");
          if (beats && beatType) ctx.time = [beats, beatType];
          continue;
        }
        if (el.tag === "direction") {
          const sound = el.children.find((c) => c.tag === "sound") ?? find(el, "sound");
          const t = sound ? Number(sound.attrs.tempo) : NaN;
          if (Number.isFinite(t) && t > 0) ctx.tempo = t;
          const perMinute = numOf(el, "per-minute");
          if (perMinute && perMinute > 0) ctx.tempo = perMinute;
          continue;
        }
        if (el.tag === "backup") {
          const d = numOf(el, "duration") ?? 0;
          cursor = Math.max(0, cursor - d / ctx.divisions);
          continue;
        }
        if (el.tag === "forward") {
          const d = numOf(el, "duration") ?? 0;
          cursor += d / ctx.divisions;
          continue;
        }
        if (el.tag !== "note") continue;
        if (child(el, "grace")) {
          warnings.push("跳过了装饰音（grace note），本版不记谱");
          continue;
        }
        const durDiv = numOf(el, "duration") ?? 0;
        const dur = durDiv / ctx.divisions;
        const isChord = child(el, "chord") !== undefined;
        const start = isChord ? lastStart : cursor;
        if (!isChord) lastStart = start;
        const rest = child(el, "rest") !== undefined;
        const pitchEl = child(el, "pitch");
        if (rest || !pitchEl) {
          if (!isChord) {
            notes.push(newNote({ start, dur: Math.max(dur, 1 / 16), pitch: -1, vel: 1 }));
            cursor = start + dur;
          }
          continue;
        }
        const step = textOf(pitchEl, "step") ?? "C";
        const alter = numOf(pitchEl, "alter") ?? 0;
        const octave = numOf(pitchEl, "octave") ?? 4;
        const base = NATURAL_PC[Math.max(0, STEPS.indexOf(step))] ?? 0;
        const pitch = (octave + 1) * 12 + base + alter;
        const vel = numOf(el, "velocity") ?? 88;
        const note = newNote({
          start,
          dur: Math.max(dur, 1 / 16),
          pitch: Math.max(0, Math.min(127, pitch)),
          vel: Math.max(1, Math.min(127, Math.round(vel))),
        });
        if (el.children.some((c) => c.tag === "tie" && c.attrs.type === "start")) note.tie = true;
        const lyricText = find(el, "text")?.text.trim();
        if (lyricText) note.lyric = lyricText;
        notes.push(note);
        if (!isChord) cursor = start + dur;
        maxEnd = Math.max(maxEnd, start + dur);
      }
    }
    const id = partEl.attrs.id ?? `P${pi + 1}`;
    tracks.push(
      newTrack({
        name: partNames.get(id) ?? `声部 ${pi + 1}`,
        instrument: pi === 0 ? "piano" : "strings",
        clef: pi === 0 ? "grand" : "treble",
        color: trackColor(pi),
        notes,
      }),
    );
    void maxEnd;
  });

  const nonEmpty = tracks.filter((t) => t.notes.some((n) => n.pitch >= 0));
  if (nonEmpty.length === 0) throw new MusicError("MusicXML 里没有可读的音符");

  return {
    score: {
      v: 1,
      title,
      ...(composer ? { composer } : {}),
      key: ctx.key,
      time: ctx.time,
      tempo: Math.min(300, Math.max(20, Math.round(ctx.tempo))),
      tracks: nonEmpty,
      meta: { origin: "import" },
    },
    warnings,
  };
}
