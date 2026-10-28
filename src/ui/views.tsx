/**
 * 四个视图：五线谱 / 简谱 / 钢琴卷帘 / 混音台。
 *
 * 它们读的是同一份 Score，所以"改一个音四处同步"不是靠事件广播，
 * 而是靠 state 里只有一个 score。任何一个视图的编辑都走 store.commit()。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Select, Slider, Space, Switch, Tag, Tooltip } from "antd";
import { DeleteOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined } from "@ant-design/icons";
import {
  beatsPerMeasure,
  measureCount,
  pitchName,
  scoreEnd,
  type InstrumentId,
  type Score,
  type Track,
} from "../core/model.ts";
import { buildJianpu, chordWidth, type JianpuChord, type JianpuMeasure } from "../core/jianpu.ts";
import { toAbc } from "../core/abc.ts";
import { INSTRUMENTS, instrumentSpec } from "../core/theory.ts";

/* ============================================================== 五线谱 */

type Abcjs = {
  renderAbc: (
    target: HTMLElement,
    abc: string,
    params?: Record<string, unknown>,
  ) => unknown;
};

let abcjsPromise: Promise<Abcjs> | null = null;
function loadAbcjs(): Promise<Abcjs> {
  if (!abcjsPromise) {
    abcjsPromise = import("abcjs").then((mod) => {
      const m = mod as unknown as { default?: Abcjs } & Abcjs;
      return (m.default ?? m) as Abcjs;
    });
  }
  return abcjsPromise;
}

export function StaffView({ score, beat }: { score: Score; beat: number }) {
  const paperRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const abc = useMemo(() => toAbc(score), [score]);
  const total = Math.max(1, scoreEnd(score));

  // 谱面宽度跟着容器走：固定 staffwidth 会让 abcjs 把整份谱缩到容器里，符头小到看不清
  useEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!width) return;
    const host = hostRef.current;
    if (!host) return;
    void (async () => {
      try {
        const abcjs = await loadAbcjs();
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = "";
        abcjs.renderAbc(hostRef.current, abc, {
          add_classes: true,
          staffwidth: Math.max(320, width - 40),
          scale: 1.2,
          paddingtop: 4,
          paddingbottom: 4,
          paddingleft: 0,
          paddingright: 0,
          wrap: { preferredMeasuresPerLine: 4, minSpacing: 1.7, maxSpacing: 2.6 },
          foregroundColor: "currentColor",
        });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [abc, width]);

  return (
    <div className="mu-paper" ref={paperRef}>
      <div className="mu-paper-head">
        <span className="mu-score-title">{score.title}</span>
        <span>
          {score.composer ? `${score.composer} · ` : ""}
          {measureCount(score)} 小节 · {score.tempo} BPM
        </span>
      </div>
      {error ? (
        <div className="mu-empty">
          五线谱渲染失败：{error}
          <br />
          这份乐谱可能是从 ABC 导入的，里面有排版引擎不认识的写法；简谱与卷帘不受影响。
        </div>
      ) : (
        <div className="mu-staff" ref={hostRef} />
      )}
      <div className="mu-playhead" style={{ left: `${Math.min(100, (beat / total) * 100)}%` }} />
    </div>
  );
}

/* ================================================================ 简谱 */

const JP_FONT = 20;
const JP_ROW_H = 78;
/** 每行最少留多宽给一小节，用来决定一行放几小节 */
const JP_MIN_MEASURE = 96;

function measureWidth(m: JianpuMeasure): number {
  const content = m.chords.reduce((a, c) => a + chordWidth(c, JP_FONT) + 6, 0);
  return Math.max(JP_MIN_MEASURE, content + 18);
}

export function JianpuView({ score, trackIndex, beat }: { score: Score; trackIndex: number; beat: number }) {
  const track = score.tracks[trackIndex];
  const paperRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(0);
  const [availH, setAvailH] = useState(0);
  const layout = useMemo(() => {
    try {
      return buildJianpu(score, trackIndex);
    } catch {
      return null;
    }
  }, [score, trackIndex]);

  // 一行放几小节按容器宽度定：写死 4 小节会让窄窗口挤、宽窗口空
  useEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    // 高度取父容器的：纸本身会被撑到父高，量自己就成了循环依赖
    const parent = el.parentElement;
    const ro = new ResizeObserver(() => {
      // clientWidth 含 padding/border，而排版要的是净宽：减掉纸的 16×2 + 边框 1×2
      setAvail(Math.max(0, Math.floor((el.clientWidth || 0) - 34)));
      // 减掉 .mu-stage 的上下 padding（18 + 28）
      setAvailH(Math.max(0, Math.floor((parent?.clientHeight ?? 0) - 46)));
    });
    ro.observe(el);
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  if (!layout || !track) {
    return <div className="mu-empty">当前没有可显示的轨道，请先在左侧选择一条轨道。</div>;
  }

  const usable = Math.max(320, avail - 36);
  // 先按宽度算上限，再把行数摊匀：8 小节在宽窗口下不该排成 7+1
  const cap = Math.max(1, Math.min(8, Math.floor(usable / JP_MIN_MEASURE)));
  const rowCount = Math.max(1, Math.ceil(layout.measures.length / cap));
  const perRow = Math.max(1, Math.ceil(layout.measures.length / rowCount));
  const rows: JianpuMeasure[][] = [];
  for (let i = 0; i < layout.measures.length; i += perRow) {
    rows.push(layout.measures.slice(i, i + perRow));
  }
  const width = usable;
  const height = rows.length * JP_ROW_H + 16;

  return (
    <div
      className="mu-paper"
      ref={paperRef}
      // 8 小节只排两行时纸会空出大半屏：把谱面放到纸张视觉中心，
      // 而不是顶着上沿、下面一片黑——谱子看起来才像"一页"。
      style={{ minHeight: availH > 0 ? availH : undefined, display: "flex", flexDirection: "column" }}
    >
      <div className="mu-paper-head">
        <span className="mu-score-title">
          {score.title} <Tag color="blue">{track.name}</Tag>
        </span>
        <span>1 = {keyDigitLabel(score)} · {score.time[0]}/{score.time[1]} · {score.tempo} BPM</span>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", minHeight: 0 }}>
        <svg className="mu-jianpu" width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
          {rows.map((row, ri) => {
            const y0 = ri * JP_ROW_H + 16;
            const baseline = y0 + 32;
            // 把剩余的横向空间平均摊给本行各小节，整行正好铺满，字距不变形
            const natural = row.reduce((a, m) => a + measureWidth(m), 0);
            const pad = Math.max(0, (width - natural) / Math.max(1, row.length));
            let x = 0;
            return (
              <g key={ri}>
                {row.map((measure) => {
                  const mw = measureWidth(measure) + pad;
                  const startX = x;
                  x += mw;
                  let cx = startX + 8;
                  return (
                    <g key={measure.index}>
                      <text x={startX + 4} y={y0 - 4} fontSize={9} opacity={0.45}>
                        {measure.index + 1}
                      </text>
                      {measure.chords.length === 0 && (
                        <text x={cx} y={baseline} fontSize={JP_FONT} opacity={0.35}>
                          0
                        </text>
                      )}
                      {measure.chords.map((chord, ci) => {
                        const w = chordWidth(chord, JP_FONT);
                        const active = beat >= chord.start - 1e-6 && beat < chord.start + chord.dur - 1e-6;
                        const el = (
                          <JianpuChordGlyph
                            key={ci}
                            chord={chord}
                            x={cx}
                            baseline={baseline}
                            width={w}
                            active={active}
                          />
                        );
                        cx += w + 6;
                        return el;
                      })}
                      <line
                        className="mu-jp-bar"
                        x1={startX + mw - 4}
                        y1={y0 + 8}
                        x2={startX + mw - 4}
                        y2={baseline + 14}
                        strokeWidth={1.2}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mu-hint" style={{ marginTop: 8 }}>
        简谱按首调唱名排（1 = 调式主音）；八度点上加下减，时值用减时线/增时线表示。
        {layout.beatsPerMeasure > 0 ? ` 每小节 ${layout.beatsPerMeasure} 拍。` : ""}
      </div>
    </div>
  );
}

function keyDigitLabel(score: Score): string {
  const names = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  return names[((score.key.tonic % 12) + 12) % 12];
}

function JianpuChordGlyph({
  chord,
  x,
  baseline,
  width,
  active,
}: {
  chord: JianpuChord;
  x: number;
  baseline: number;
  width: number;
  active: boolean;
}) {
  const tokens = chord.tokens;
  const lowest = tokens[0];
  const highest = tokens[tokens.length - 1];
  const maxDashes = Math.max(...tokens.map((t) => t.dashes));
  const baseY = baseline;

  return (
    <g>
      {tokens.map((tok, i) => {
        const y = baseY - i * (JP_FONT * 0.82);
        const digit = tok.digit === 0 ? "0" : String(tok.digit);
        const acc = tok.accidental === 1 ? "♯" : tok.accidental === -1 ? "♭" : "";
        return (
          <g key={i}>
            {acc && (
              <text
                className={active ? "mu-jp-active" : undefined}
                x={x - 1}
                y={y - JP_FONT * 0.42}
                fontSize={JP_FONT * 0.62}
                textAnchor="middle"
              >
                {acc}
              </text>
            )}
            <text
              className={`mu-jp-num${active ? " mu-jp-active" : ""}`}
              x={x + JP_FONT * 0.31}
              y={y}
              fontSize={JP_FONT}
              textAnchor="middle"
            >
              {digit}
            </text>
            {/* 八度点：上方为正，下方为负 */}
            {Array.from({ length: Math.max(0, tok.octaveDots) }).map((_, k) => (
              <circle
                key={`ua${k}`}
                cx={x + JP_FONT * 0.31}
                cy={y - JP_FONT * 0.92 - k * 4.5}
                r={1.7}
                fill="currentColor"
              />
            ))}
            {Array.from({ length: Math.max(0, -tok.octaveDots) }).map((_, k) => (
              <circle
                key={`da${k}`}
                cx={x + JP_FONT * 0.31}
                cy={y + 6 + k * 4.5}
                r={1.7}
                fill="currentColor"
              />
            ))}
          </g>
        );
      })}

      {/* 减时线：画在整叠数字下方 */}
      {Array.from({ length: lowest.underlines }).map((_, k) => {
        const y = baseY + 5 + k * 4;
        const w = Math.max(JP_FONT * 0.7, width - 2);
        return (
          <line
            key={`u${k}`}
            x1={x - 1}
            y1={y}
            x2={x - 1 + w}
            y2={y}
            strokeWidth={1.4}
            className={active ? "mu-jp-active" : undefined}
          />
        );
      })}

      {/* 增时线 */}
      {Array.from({ length: maxDashes }).map((_, k) => (
        <text
          key={`d${k}`}
          className={active ? "mu-jp-active" : undefined}
          x={x + JP_FONT * 0.72 + k * JP_FONT * 0.72}
          y={baseY}
          fontSize={JP_FONT}
          textAnchor="middle"
          opacity={0.85}
        >
          —
        </text>
      ))}

      {/* 附点 */}
      <circle
        cx={x + JP_FONT * 0.72 + maxDashes * JP_FONT * 0.72 + 4}
        cy={baseY - JP_FONT * 0.22}
        r={2.1}
        fill="currentColor"
        opacity={lowest.dots > 0 ? 1 : 0}
      />
      {highest.tie && (
        <path
          d={`M ${x + 2} ${baseY + 9} Q ${x + JP_FONT * 0.5} ${baseY + 15} ${x + JP_FONT} ${baseY + 9}`}
          fill="none"
          strokeWidth={1}
          opacity={0.7}
        />
      )}
    </g>
  );
}

/* ============================================================ 钢琴卷帘 */

const ROLL_ROW = 13;
const KEY_GUTTER = 52;
const RULER_H = 22;

interface RollProps {
  score: Score;
  trackId: string;
  selected: string[];
  beat: number;
  snap: number;
  onSelect: (ids: string[]) => void;
  onAddNote: (start: number, pitch: number) => void;
  onMoveNote: (noteId: string, start: number, pitch: number) => void;
}

export function PianoRoll({ score, trackId, selected, beat, snap, onSelect, onAddNote, onMoveNote }: RollProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fittedRef = useRef(0);
  const [zoom, setZoom] = useState(48);
  const [draft, setDraft] = useState<{ id: string; start: number; pitch: number } | null>(null);
  const dragRef = useRef<{ id: string; grabBeat: number; originStart: number; originPitch: number; moved: boolean } | null>(
    null,
  );

  const bars = measureCount(score);
  const bpmBeats = beatsPerMeasure(score);
  const totalBeats = Math.max(bars * bpmBeats, 4);

  const { lo, hi } = useMemo(() => {
    let l = 127;
    let h = 0;
    for (const t of score.tracks) {
      for (const n of t.notes) {
        if (n.pitch < 0) continue;
        l = Math.min(l, n.pitch);
        h = Math.max(h, n.pitch);
      }
    }
    if (l > h) return { lo: 48, hi: 84 };
    // 留出上下各 3 个半音，方便往上往下加音
    return { lo: Math.max(21, l - 3), hi: Math.min(108, h + 3) };
  }, [score]);

  const rows = hi - lo + 1;
  const width = KEY_GUTTER + totalBeats * zoom;
  const height = RULER_H + rows * ROLL_ROW;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // 打开就把整曲塞进可视宽度；曲长变了才重新贴合（用户手动缩放过就不动）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (fittedRef.current === totalBeats) return;
    const w = el.clientWidth - KEY_GUTTER - 16;
    if (w <= 0) return;
    setZoom(Math.max(14, Math.min(160, Math.floor(w / totalBeats))));
    fittedRef.current = totalBeats;
  }, [totalBeats]);

  const beatAt = useCallback((px: number) => Math.max(0, (px - KEY_GUTTER) / zoom), [zoom]);
  const pitchAt = useCallback((py: number) => hi - Math.floor((py - RULER_H) / ROLL_ROW), [hi]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const dark = document.querySelector(".mu-root")?.getAttribute("data-dark") !== "false";
    const bg = dark ? "#12152a" : "#ffffff";
    const gridFine = dark ? "rgba(102,126,234,0.10)" : "rgba(102,126,234,0.14)";
    const gridBeat = dark ? "rgba(102,126,234,0.20)" : "rgba(102,126,234,0.26)";
    const gridBar = dark ? "rgba(102,126,234,0.45)" : "rgba(102,126,234,0.5)";
    const blackKey = dark ? "rgba(0,0,0,0.28)" : "rgba(15,25,60,0.06)";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // 黑键行底色
    for (let p = lo; p <= hi; p++) {
      const pc = ((p % 12) + 12) % 12;
      if ([1, 3, 6, 8, 10].includes(pc)) {
        const y = RULER_H + (hi - p) * ROLL_ROW;
        ctx.fillStyle = blackKey;
        ctx.fillRect(KEY_GUTTER, y, width - KEY_GUTTER, ROLL_ROW);
      }
    }

    // 纵向网格
    for (let b = 0; b <= totalBeats; b += 0.25) {
      const x = KEY_GUTTER + b * zoom;
      const isBar = Math.abs(b % bpmBeats) < 1e-6;
      const isBeat = Math.abs(b % 1) < 1e-6;
      ctx.strokeStyle = isBar ? gridBar : isBeat ? gridBeat : gridFine;
      ctx.lineWidth = isBar ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // 小节号
    ctx.fillStyle = dark ? "#8f97c0" : "#5d6486";
    ctx.font = "10px system-ui";
    for (let bar = 0; bar < bars; bar++) {
      ctx.fillText(String(bar + 1), KEY_GUTTER + bar * bpmBeats * zoom + 3, 14);
    }

    // 键盘侧栏
    ctx.fillStyle = dark ? "#191d33" : "#f1f2f8";
    ctx.fillRect(0, 0, KEY_GUTTER, height);
    ctx.font = "9px system-ui";
    for (let p = lo; p <= hi; p++) {
      const y = RULER_H + (hi - p) * ROLL_ROW;
      const pc = ((p % 12) + 12) % 12;
      if (pc === 0) {
        ctx.fillStyle = dark ? "#c9cff0" : "#3b4160";
        ctx.fillText(pitchName(p), 3, y + ROLL_ROW - 3);
      }
    }

    // 音符
    score.tracks.forEach((track) => {
      const isActive = track.id === trackId;
      for (const n of track.notes) {
        if (n.pitch < 0) continue;
        if (n.pitch < lo || n.pitch > hi) continue;
        const d = draft && draft.id === n.id ? { ...n, start: draft.start, pitch: draft.pitch } : n;
        const x = KEY_GUTTER + d.start * zoom;
        const y = RULER_H + (hi - d.pitch) * ROLL_ROW;
        const w = Math.max(3, d.dur * zoom - 1);
        ctx.globalAlpha = isActive ? 1 : 0.32;
        ctx.fillStyle = track.color;
        ctx.beginPath();
        const r = 2.5;
        ctx.roundRect(x, y + 1, w, ROLL_ROW - 2, r);
        ctx.fill();
        if (selectedSet.has(n.id)) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    });
    ctx.globalAlpha = 1;

    // 播放头
    const px = KEY_GUTTER + beat * zoom;
    ctx.strokeStyle = "#34e8d2";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(px, RULER_H);
    ctx.lineTo(px, height);
    ctx.stroke();
  }, [score, trackId, selectedSet, beat, zoom, lo, hi, width, height, rows, totalBeats, bpmBeats, bars, draft]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (py < RULER_H || px < KEY_GUTTER) return;
    const b = beatAt(px);
    const p = pitchAt(py);
    // 先做命中测试（倒序 = 后画的在上层）
    const track = score.tracks.find((t) => t.id === trackId);
    let hit: { id: string; start: number; pitch: number } | null = null;
    for (const n of track?.notes ?? []) {
      if (n.pitch < 0) continue;
      const x = KEY_GUTTER + n.start * zoom;
      const y = RULER_H + (hi - n.pitch) * ROLL_ROW;
      if (px >= x && px <= x + Math.max(3, n.dur * zoom - 1) && py >= y && py <= y + ROLL_ROW) {
        hit = { id: n.id, start: n.start, pitch: n.pitch };
      }
    }
    if (hit) {
      onSelect([hit.id]);
      dragRef.current = { id: hit.id, grabBeat: b, originStart: hit.start, originPitch: hit.pitch, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      const snapped = Math.round(b / snap) * snap;
      onAddNote(snapped, p);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const b = beatAt(e.clientX - rect.left);
    const p = pitchAt(e.clientY - rect.top);
    const deltaBeats = b - drag.grabBeat;
    const newStart = Math.max(0, Math.round((drag.originStart + deltaBeats) / snap) * snap);
    if (Math.abs(newStart - drag.originStart) > 1e-6 || p !== drag.originPitch) drag.moved = true;
    setDraft({ id: drag.id, start: newStart, pitch: Math.max(lo, Math.min(hi, p)) });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    const d = draft;
    setDraft(null);
    if (!drag || !d || !drag.moved) return;
    onMoveNote(drag.id, d.start, d.pitch);
  };

  const track = score.tracks.find((t) => t.id === trackId);

  return (
    <div>
      <div className="mu-paper-head" style={{ marginBottom: 8 }}>
        <Space size={8}>
          <Tag color="geekblue">{track?.name ?? "未选轨道"}</Tag>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            在空白处点击加音，拖动音符改音高/位置（吸附 {snap === 0.25 ? "1/16" : `1/${Math.round(4 / snap)}`} 音符）
          </span>
        </Space>
        <Space size={6}>
          <span style={{ fontSize: 11, opacity: 0.6 }}>缩放</span>
          <Slider
            style={{ width: 120 }}
            min={28}
            max={160}
            value={zoom}
            onChange={setZoom}
            tooltip={{ formatter: (v) => `${v}px/拍` }}
          />
        </Space>
      </div>
      <div className="mu-roll-scroll" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ display: "block", cursor: "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="钢琴卷帘编辑器"
        />
      </div>
    </div>
  );
}

/* ============================================================== 混音台 */

export function MixerView({
  score,
  activeTrackId,
  onSelect,
  onUpdateTrack,
  onAddTrack,
  onRemoveTrack,
  playing,
  onTogglePlay,
}: {
  score: Score;
  activeTrackId: string;
  onSelect: (id: string) => void;
  onUpdateTrack: (id: string, patch: Partial<Omit<Track, "notes" | "id">>) => void;
  onAddTrack: (i: InstrumentId) => void;
  onRemoveTrack: (id: string) => void;
  playing: boolean;
  onTogglePlay: () => void;
}) {
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  return (
    <div className="mu-paper">
      <div className="mu-paper-head">
        <span className="mu-score-title">混音台</span>
        <Space>
          <Select
            size="small"
            placeholder="添加轨道"
            style={{ width: 140 }}
            value={null}
            onChange={(v) => onAddTrack(String(v) as InstrumentId)}
            options={INSTRUMENTS.map((i) => ({ value: i.id, label: i.label }))}
          />
          <Button
            size="small"
            type={playing ? "default" : "primary"}
            icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            onClick={onTogglePlay}
          >
            {playing ? "暂停" : "试听"}
          </Button>
        </Space>
      </div>
      {score.tracks.length === 0 ? (
        <Empty description="还没有轨道" />
      ) : (
        score.tracks.map((t) => {
          const spec = instrumentSpec(t.instrument);
          const confirming = pendingRemove === t.id;
          return (
            <div
              key={t.id}
              className="mu-track"
              data-active={t.id === activeTrackId}
              style={{ cursor: "default", padding: "10px 12px" }}
              onClick={() => onSelect(t.id)}
            >
              <div className="mu-track-row" style={{ marginBottom: 6 }}>
                <span className="mu-dot" style={{ background: t.color }} />
                <span className="mu-track-name">{t.name}</span>
                <Tag style={{ marginInlineEnd: 0 }} color={t.mute ? "default" : "blue"}>
                  {spec.label}
                </Tag>
                <Tooltip title={t.solo ? "取消独奏" : "独奏"}>
                  <Button
                    size="small"
                    type={t.solo ? "primary" : "text"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateTrack(t.id, { solo: !t.solo });
                    }}
                    aria-label={`独奏 ${t.name}`}
                  >
                    S
                  </Button>
                </Tooltip>
                <Tooltip title={t.mute ? "取消静音" : "静音"}>
                  <Button
                    size="small"
                    type={t.mute ? "primary" : "text"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateTrack(t.id, { mute: !t.mute });
                    }}
                    aria-label={`静音 ${t.name}`}
                  >
                    M
                  </Button>
                </Tooltip>
                <Tooltip title={confirming ? "再点一次确认删除" : "删除轨道"}>
                  <Button
                    size="small"
                    danger
                    type={confirming ? "primary" : "text"}
                    icon={<DeleteOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirming) {
                        onRemoveTrack(t.id);
                        setPendingRemove(null);
                      } else {
                        setPendingRemove(t.id);
                      }
                    }}
                    aria-label={`删除轨道 ${t.name}`}
                  />
                </Tooltip>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--mu-muted)", width: 34 }}>音量</span>
                <Slider
                  style={{ flex: 1, margin: 0 }}
                  min={0}
                  max={100}
                  value={Math.round(t.volume * 100)}
                  onChange={(v) => onUpdateTrack(t.id, { volume: v / 100 })}
                  tooltip={{ formatter: (v) => `${v}%` }}
                />
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--mu-muted)", width: 34 }}>声像</span>
                <Slider
                  style={{ flex: 1, margin: 0 }}
                  min={-100}
                  max={100}
                  value={Math.round(t.pan * 100)}
                  onChange={(v) => onUpdateTrack(t.id, { pan: v / 100 })}
                  tooltip={{ formatter: (v) => { const x = v ?? 0; return x === 0 ? "居中" : x < 0 ? `左 ${-x}%` : `右 ${x}%`; } }}
                />
              </div>
              {confirming && (
                <div style={{ fontSize: 11, color: "var(--mu-warm)", marginTop: 4 }}>
                  删除「{t.name}」会连同它的 {t.notes.length} 个音符一起消失，不能恢复（可撤销）。
                </div>
              )}
            </div>
          );
        })
      )}
      <div className="mu-hint" style={{ marginTop: 10 }}>
        有轨道独奏时其余轨道自动静音；删除是可撤销的，但推子与静音状态不进撤销栈。
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 轨道列表 */

export function TrackList({
  score,
  activeTrackId,
  onSelect,
  onAdd,
}: {
  score: Score;
  activeTrackId: string;
  onSelect: (id: string) => void;
  onAdd: (i: InstrumentId) => void;
}) {
  return (
    <>
      <div className="mu-pane-head">
        <span>轨道</span>
        <Select
          size="small"
          suffixIcon={<PlusOutlined />}
          placeholder="添加"
          style={{ width: 92 }}
          value={null}
          onChange={(v) => onAdd(String(v) as InstrumentId)}
          options={INSTRUMENTS.map((i) => ({ value: i.id, label: i.label }))}
        />
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {score.tracks.map((t) => (
          <div
            key={t.id}
            className="mu-track"
            data-active={t.id === activeTrackId}
            onClick={() => onSelect(t.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(t.id);
            }}
          >
            <div className="mu-track-row">
              <span className="mu-dot" style={{ background: t.color }} />
              <span className="mu-track-name">{t.name}</span>
              {t.mute && <Tag color="default">静音</Tag>}
              {t.solo && <Tag color="blue">独奏</Tag>}
            </div>
            <div className="mu-track-meta">
              {instrumentSpec(t.instrument).label} · {t.notes.filter((n) => n.pitch >= 0).length} 音
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** 轨道混音小控件（左栏用） */
export function TrackMiniMix({ track, onChange }: { track: Track; onChange: (p: Partial<Track>) => void }) {
  return (
    <Space size={4} style={{ marginTop: 4 }}>
      <Switch size="small" checked={!track.mute} onChange={(v) => onChange({ mute: !v })} checkedChildren="响" unCheckedChildren="静" />
      <span style={{ fontSize: 11, color: "var(--mu-muted)" }}>{Math.round(track.volume * 100)}%</span>
    </Space>
  );
}
