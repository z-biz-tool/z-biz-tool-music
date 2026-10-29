/**
 * 播放引擎（Tone.js）。
 *
 * 设计取舍：
 *   - 不做采样音源：随包带 SoundFont 是 100MB 级 + 授权风险，v0.1 用合成音色族
 *     （钢琴/电钢/风琴/吉他/贝斯/弦乐/铜管/簧片/管乐/合成/铺底/打击）先把"能听、能调、能导"做扎实。
 *   - 混音走 Tone.Channel（音量 + 声像），与界面上的推子一一对应；
 *   - 导出用 Tone.Offline 离线渲染，比实时录音稳（不受 CPU 抖动影响）。
 *
 * 时序约定：score 里的拍 → 秒 = 拍 * 60 / tempo。v0.1 一曲一个速度，不做速度变化。
 */

import * as Tone from "tone";
import { audibleTracks, type InstrumentId, type Score, type Track } from "../core/model.ts";

export interface TransportState {
  playing: boolean;
  /** 当前拍位置（小数） */
  beat: number;
  tempo: number;
}

type SynthLike = Tone.PolySynth<Tone.Synth>;

interface TrackNode {
  trackId: string;
  synth: SynthLike | null;
  kit: DrumKit | null;
  channel: Tone.Channel;
  instrument: InstrumentId;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface VoicePreset {
  oscillator: { type: string };
  envelope: { attack: number; decay: number; sustain: number; release: number };
}

const PRESETS: Record<InstrumentId, VoicePreset> = {
  piano: { oscillator: { type: "triangle" }, envelope: { attack: 0.004, decay: 1.2, sustain: 0.12, release: 1.4 } },
  epiano: { oscillator: { type: "sine" }, envelope: { attack: 0.006, decay: 0.9, sustain: 0.2, release: 1.0 } },
  organ: { oscillator: { type: "square" }, envelope: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.4 } },
  guitar: { oscillator: { type: "sawtooth" }, envelope: { attack: 0.005, decay: 0.6, sustain: 0.08, release: 0.5 } },
  bass: { oscillator: { type: "sawtooth" }, envelope: { attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.25 } },
  strings: { oscillator: { type: "sawtooth" }, envelope: { attack: 0.18, decay: 0.4, sustain: 0.7, release: 0.9 } },
  brass: { oscillator: { type: "square" }, envelope: { attack: 0.08, decay: 0.3, sustain: 0.6, release: 0.4 } },
  reed: { oscillator: { type: "square" }, envelope: { attack: 0.05, decay: 0.25, sustain: 0.7, release: 0.3 } },
  pipe: { oscillator: { type: "sine" }, envelope: { attack: 0.04, decay: 0.2, sustain: 0.8, release: 0.35 } },
  synth: { oscillator: { type: "sawtooth" }, envelope: { attack: 0.02, decay: 0.4, sustain: 0.3, release: 0.5 } },
  pad: { oscillator: { type: "sine" }, envelope: { attack: 0.6, decay: 0.8, sustain: 0.8, release: 1.8 } },
  drums: { oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 } },
};

/** 简易鼓组：底鼓/军鼓/踩镲，按 GM 打击乐的常用音高分配 */
class DrumKit {
  private kick: Tone.MembraneSynth;
  private snare: Tone.NoiseSynth;
  private hat: Tone.MetalSynth;
  constructor(output: Tone.InputNode) {
    this.kick = new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 6 }).connect(output);
    this.snare = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.14, sustain: 0 } }).connect(output);
    this.hat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.05, release: 0.02 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5,
    }).connect(output);
  }
  trigger(time: number, pitch: number, dur: number, vel: number): void {
    const v = Math.max(0.05, Math.min(1, vel / 127));
    if (pitch <= 37) this.kick.triggerAttackRelease(38 + (pitch - 36) * 4, dur, time, v);
    else if (pitch >= 42 && pitch <= 44) this.hat.triggerAttackRelease(dur, time, v * 0.7);
    else if (pitch >= 49 && pitch <= 54) this.hat.triggerAttackRelease(dur * 2, time, v * 0.5);
    else this.snare.triggerAttackRelease(dur, time, v);
  }
  dispose(): void {
    this.kick.dispose();
    this.snare.dispose();
    this.hat.dispose();
  }
}

function makeNode(track: Track): TrackNode {
  const channel = new Tone.Channel({ volume: gainToDb(track.volume), pan: track.pan, mute: track.mute }).toDestination();
  if (track.instrument === "drums") {
    return { trackId: track.id, synth: null, kit: new DrumKit(channel), channel, instrument: track.instrument };
  }
  const preset = PRESETS[track.instrument] ?? PRESETS.piano;
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: preset.oscillator as Tone.SynthOptions["oscillator"],
    envelope: preset.envelope,
    volume: -6,
  }).connect(channel);
  return { trackId: track.id, synth, kit: null, channel, instrument: track.instrument };
}

function gainToDb(gain: number): number {
  const g = Math.max(0.0001, Math.min(1, gain));
  return 20 * Math.log10(g);
}

/** 一段可播放的音符事件（拍 → 秒） */
interface Event {
  beat: number;
  durBeats: number;
  pitch: number;
  vel: number;
}

function eventsOf(track: Track): Event[] {
  return track.notes
    .filter((n) => n.pitch >= 0 && n.dur > 0)
    .map((n) => ({ beat: n.start, durBeats: n.dur, pitch: n.pitch, vel: n.vel }))
    .sort((a, b) => a.beat - b.beat);
}

export class PlaybackEngine {
  private nodes = new Map<string, TrackNode>();
  private score: Score | null = null;
  private scheduled: number[] = [];
  private metronomeId: number | null = null;
  private clickSynth: Tone.MembraneSynth | null = null;
  private metronomeOn = false;
  private loop: { from: number; to: number } | null = null;
  private ticker: number | null = null;
  /**
   * 课程用的「教具琴」：一个常驻的钢琴音色，按一下就响。
   *
   * 为什么不用 load() 里那套按轨建的节点：课程练习时学生自己决定什么时候弹，
   * 不经过 Transport 的时钟，而且换课时不该重建音色（会有明显延迟）。
   */
  private tutor: Tone.PolySynth<Tone.Synth> | null = null;
  /** 走带状态回调（播放头位置等），由 UI 订阅 */
  onTick: ((state: TransportState) => void) | null = null;

  constructor() {
    Tone.getTransport().on("stop", () => this.emit());
  }

  private secPerBeat(score: Score | null = this.score): number {
    return 60 / (score?.tempo ?? 100);
  }

  private emit(): void {
    const t = Tone.getTransport();
    this.onTick?.({
      playing: t.state === "started",
      beat: t.seconds / this.secPerBeat(),
      tempo: this.score?.tempo ?? 100,
    });
  }

  /** 载入乐谱：重建音色节点与事件表。重复调用是安全的。 */
  load(score: Score): void {
    this.stop();
    this.score = score;
    for (const n of this.nodes.values()) {
      n.synth?.dispose();
      n.kit?.dispose();
      n.channel.dispose();
    }
    this.nodes.clear();
    for (const t of score.tracks) this.nodes.set(t.id, makeNode(t));
    this.scheduleAll();
    Tone.getTransport().loop = this.loop !== null;
    this.emit();
  }

  /** 只改混音参数时不重建音色（拖动推子不该断音） */
  syncMix(score: Score): void {
    this.score = score;
    const solos = score.tracks.filter((t) => t.solo);
    const soloActive = solos.length > 0;
    for (const t of score.tracks) {
      const node = this.nodes.get(t.id);
      if (!node) continue;
      const audible = soloActive ? t.solo && !t.mute : !t.mute;
      // 静音用 -60dB 而不是 -Infinity：rampTo 到 -Infinity 在 Tone 里会算出 NaN 增益
      node.channel.volume.rampTo(audible ? gainToDb(t.volume) : -60, 0.05);
      node.channel.pan.rampTo(t.pan, 0.05);
    }
  }

  private scheduleAll(): void {
    const transport = Tone.getTransport();
    for (const id of this.scheduled) transport.clear(id);
    this.scheduled = [];
    if (this.metronomeId !== null) {
      transport.clear(this.metronomeId);
      this.metronomeId = null;
    }
    const score = this.score;
    if (!score) return;
    const spb = this.secPerBeat(score);
    // 让 transport 的 bpm 与乐谱对齐。事件是按秒排的，理论上 bpm 不参与也能对，
    // 但 transport.ticks / position / loopStart 都靠 bpm 换算，两边不一致时
    // 读数是歪的（比如 72 BPM 的曲子 transport.bpm 显示 120）。对齐后 tick 与拍
    // 一一对应，排查问题看 tick 数就等于看拍数。
    transport.bpm.value = score.tempo;
    const audible = new Set(audibleTracks(score).map((t) => t.id));
    for (const track of score.tracks) {
      const node = this.nodes.get(track.id);
      if (!node) continue;
      // 不可闻的轨整轨跳过。这里必须在事件循环【外】判断：
      // 之前写成循环内的 break，第一个事件就把整轨的调度打断了 —— 后果是
      // 该轨一个音都不响，而且现象是"少了一层"，比全静音更难查。
      if (!audible.has(track.id)) continue;
      for (const ev of eventsOf(track)) {
        const id = transport.schedule((time) => {
          const dur = Math.max(0.05, ev.durBeats * spb);
          if (node.kit) node.kit.trigger(time, ev.pitch, dur, ev.vel);
          else node.synth?.triggerAttackRelease(midiToFreq(ev.pitch), dur, time, Math.max(0.05, ev.vel / 127));
        }, ev.beat * spb);
        this.scheduled.push(id);
      }
    }
    if (this.metronomeOn) this.installMetronome();
    if (this.loop) {
      transport.loop = true;
      transport.loopStart = this.loop.from * spb;
      transport.loopEnd = this.loop.to * spb;
    }
  }

  get durationBeats(): number {
    if (!this.score) return 0;
    let end = 0;
    for (const t of this.score.tracks) for (const n of t.notes) end = Math.max(end, n.start + n.dur);
    return end;
  }

  /** 是否已经为某份乐谱建好音色节点（决定 play 前要不要 load） */
  get isLoaded(): boolean {
    return this.score !== null && this.nodes.size > 0;
  }

  get currentScore(): Score | null {
    return this.score;
  }

  /**
   * 唤醒音频上下文。
   *
   * 直接 `await Tone.start()` 在 WebKit（Tauri 的 WKWebView 就是它）上不可靠：
   * Safari 系的 AudioContext 有个 `interrupted` 中间态，resume() 的 promise 会
   * 一直悬着不 resolve —— 实测能挂 3 秒以上，用户体感就是"点了播放没反应"。
   *
   * 所以这里不信任 Tone.start() 的 promise：
   *   1. 先不等它，直接把 resume 的 promise 挂在后台；
   *   2. 用带超时的等待去卡状态；
   *   3. 超时或状态不是 running 时，改用裸 AudioContext.resume() 兜底。
   * 只要最后状态是 running 就够了 —— 音频图能不能出声由它决定，不由 promise 决定。
   */
  private async ensureContextRunning(): Promise<void> {
    const ctx = Tone.getContext();
    /**
     * 每次都重新读一遍状态，而不是直接比较 `ctx.state`。
     *
     * 两个理由：一是它是 getter，值会随 resume 变化，TS 却会因为前面的一次
     * 提前返回把类型收窄成「非 running」，后面再比较就报 TS2367；二是这里本来
     * 就需要在多个时间点分别取快照，而不是拿一个旧值判断。
     */
    const stateOf = (): string => ctx.state;
    if (stateOf() === "running") return;

    // 不 await Tone.start()：它在 WebKit 上可能永不 settle。
    const startPromise = Tone.start().then(
      () => undefined,
      () => undefined,
    );
    const settled = await Promise.race([
      startPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1200)),
    ]);

    if (!settled || stateOf() !== "running") {
      // 兜底：直接对底层 AudioContext 调 resume，Safari 上更可能立刻进 running。
      const raw = ctx.rawContext as AudioContext & { state: string };
      try {
        await Promise.race([
          raw.resume(),
          new Promise<void>((r) => setTimeout(r, 1200)),
        ]);
      } catch {
        /* resume 失败时下面的状态检查会兜住 */
      }
    }

    // 最后再确认一次；不是 running 就明确抛错，让 UI 提示"系统未允许声音"，
    // 而不是让用户对着一个无声的播放头发呆。
    if (stateOf() !== "running") {
      throw new Error(
        `音频未能启动（当前状态 ${stateOf()}）。请检查系统是否允许本应用输出声音。`,
      );
    }
  }

  async play(fromBeat?: number): Promise<void> {
    await this.ensureContextRunning();
    const transport = Tone.getTransport();
    if (fromBeat !== undefined) transport.seconds = fromBeat * this.secPerBeat();
    this.startTicker();
    transport.start();
    this.emit();
  }

  pause(): void {
    Tone.getTransport().pause();
    this.stopTicker();
    this.emit();
  }

  stop(): void {
    const transport = Tone.getTransport();
    transport.stop();
    transport.seconds = 0;
    this.stopTicker();
    this.emit();
  }

  seek(beat: number): void {
    const transport = Tone.getTransport();
    transport.seconds = Math.max(0, beat * this.secPerBeat());
    this.emit();
  }

  setTempo(bpm: number): void {
    if (this.score) this.score = { ...this.score, tempo: bpm };
    const transport = Tone.getTransport();
    // tempo 变了要重排：事件是按秒算的
    const wasPlaying = transport.state === "started";
    const at = transport.seconds;
    this.scheduleAll();
    transport.seconds = at;
    if (wasPlaying) transport.start();
  }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
    if (this.metronomeId !== null) {
      Tone.getTransport().clear(this.metronomeId);
      this.metronomeId = null;
    }
    if (on) this.installMetronome();
  }

  private installMetronome(): void {
    const score = this.score;
    if (!score) return;
    const spb = this.secPerBeat(score);
    if (!this.clickSynth) {
      this.clickSynth = new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 2, volume: -18 }).toDestination();
    }
    const click = this.clickSynth;
    const beatsPerBar = (score.time[0] * 4) / score.time[1];
    const id = Tone.getTransport().scheduleRepeat((time) => {
      const beat = Math.round(Tone.getTransport().seconds / spb);
      const isDownbeat = Math.abs(beat % beatsPerBar) < 1e-6;
      click.triggerAttackRelease(isDownbeat ? 1600 : 1200, 0.02, time, isDownbeat ? 0.5 : 0.28);
    }, spb);
    this.metronomeId = id;
  }

  setLoop(from: number, to: number | null): void {
    const transport = Tone.getTransport();
    if (to === null || to <= from) {
      this.loop = null;
      transport.loop = false;
      return;
    }
    this.loop = { from, to };
    transport.loop = true;
    transport.loopStart = from * this.secPerBeat();
    transport.loopEnd = to * this.secPerBeat();
  }

  /**
   * 按一下琴键就响（课程/练习用），不经过 Transport。
   *
   * 走 triggerAttackRelease 的 time 参数留空 = 立即触发，学生按下去听到的就是
   * 按下去的那一刻 —— 学琴时这点即时性很重要，晚 30ms 就会觉得"琴不跟手"。
   */
  async pluck(pitch: number, durSec = 0.9, vel = 0.7): Promise<void> {
    if (pitch < 0) return;
    await this.ensureContextRunning();
    if (!this.tutor) {
      this.tutor = new Tone.PolySynth(Tone.Synth, {
        oscillator: PRESETS.piano.oscillator as Tone.SynthOptions["oscillator"],
        envelope: PRESETS.piano.envelope,
        volume: -4,
      }).toDestination();
    }
    this.tutor.triggerAttackRelease(midiToFreq(pitch), Math.max(0.08, durSec), undefined, Math.max(0.05, Math.min(1, vel)));
  }

  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = window.setInterval(() => this.emit(), 60);
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    window.clearInterval(this.ticker);
    this.ticker = null;
  }

  dispose(): void {
    this.stop();
    for (const n of this.nodes.values()) {
      n.synth?.dispose();
      n.kit?.dispose();
      n.channel.dispose();
    }
    this.nodes.clear();
    this.tutor?.dispose();
    this.tutor = null;
  }
}

/* ------------------------------------------------------------- 导出 WAV */

function writeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + len * numCh * 2);
  const view = new DataView(bytes.buffer);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + len * numCh * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  wstr(36, "data");
  view.setUint32(40, len * numCh * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return bytes;
}

/** 离线渲染成 WAV。返回 16bit 立体声 PCM。 */
export async function renderWav(score: Score): Promise<Uint8Array> {
  const spb = 60 / score.tempo;
  let endBeat = 0;
  for (const t of score.tracks) for (const n of t.notes) endBeat = Math.max(endBeat, n.start + n.dur);
  const tail = 2.2; // 留出释音尾巴
  const duration = Math.max(2, endBeat * spb + tail);
  const buffer = await Tone.Offline(() => {
    const transport = Tone.getTransport();
    const nodes: TrackNode[] = score.tracks.map((t) => makeNode(t));
    const audible = new Set(audibleTracks(score).map((t) => t.id));
    score.tracks.forEach((track) => {
      const node = nodes.find((n) => n.trackId === track.id);
      if (!node || !audible.has(track.id)) return;
      for (const ev of eventsOf(track)) {
        transport.schedule((time) => {
          const dur = Math.max(0.05, ev.durBeats * spb);
          if (node.kit) node.kit.trigger(time, ev.pitch, dur, ev.vel);
          else node.synth?.triggerAttackRelease(midiToFreq(ev.pitch), dur, time, Math.max(0.05, ev.vel / 127));
        }, ev.beat * spb);
      }
    });
    transport.start(0);
  }, duration);

  const raw = buffer.get();
  if (!raw) throw new Error("离线渲染失败：没有拿到音频数据");
  const chans: Float32Array[] = raw.numberOfChannels === 1 ? [raw.getChannelData(0)] : [raw.getChannelData(0), raw.getChannelData(1)];
  return writeWav(chans, raw.sampleRate);
}
