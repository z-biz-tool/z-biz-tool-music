/**
 * 播放引擎（Tone.js）。
 *
 * 音色分两层：
 *   - **采样**（`samples.ts`）：钢琴/管乐/吉他/铜管/簧片/风琴，随包带真实录音，
 *     离线可用。换来的是合成器给不了的瞬态细节 —— 击弦噪声、琴槌硬度、共鸣箱。
 *   - **合成**：电钢、弦乐合奏、合成主音、铺底、打击乐。这些本来就该是电子的，
 *     或者由多件乐器叠加而成，单件采样反而更假（一把独奏小提琴不像弦乐组）。
 * 采样没加载成功（文件缺失/解码失败）时自动退回合成，播放链路不能因此中断。
 *
 * 其余取舍：
 *   - 混音走 Tone.Channel（音量 + 声像），与界面上的推子一一对应；
 *   - 导出用 Tone.Offline 离线渲染，比实时录音稳（不受 CPU 抖动影响）。
 *
 * 时序约定：score 里的拍 → 秒 = 拍 * 60 / tempo。v0.1 一曲一个速度，不做速度变化。
 */

import * as Tone from "tone";
import { audibleTracks, type InstrumentId, type Score, type Track } from "../core/model.ts";
import { makeSampler, preload, preloadFor } from "./samples.ts";

export interface TransportState {
  playing: boolean;
  /** 当前拍位置（小数） */
  beat: number;
  tempo: number;
}

/**
 * 一个能发声的乐器。
 *
 * Tone.Sampler 与 Tone.PolySynth 的 triggerAttackRelease 重载签名不同（后者还收
 * Frequency[]），联合类型直接调用 TS 会拒绝。但实际用到的形式完全一致，所以在
 * 这里窄化一次，换来所有调用处干净。
 */
interface Voice {
  triggerAttackRelease(
    note: number | string,
    duration: number,
    time?: number,
    velocity?: number,
  ): unknown;
  dispose(): unknown;
}

function asVoice(v: Tone.Sampler | Tone.PolySynth<Tone.MonoSynth>): Voice {
  return v as unknown as Voice;
}

interface TrackNode {
  trackId: string;
  voice: Voice | null;
  /** 这个节点是不是采样音色 —— 预热只对合成器的 PolySynth 有意义 */
  sampled: boolean;
  kit: DrumKit | null;
  channel: Tone.Channel;
  instrument: InstrumentId;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * 一个音色 = 振荡器 + 音量包络 + 低通滤波器 + 滤波包络。
 *
 * 为什么要「滤波包络」而不只是音量包络：真实乐器的起音那一刻最亮（击弦/吹气的
 * 瞬态全是高频），随后能量往低频塌。只做音量包络的话，声音从第一个采样就带着
 * 满血的高频，然后整体一起变轻 —— 听感就是"电子琴按到底、一坨音头砸过来"。
 * 让滤波截止频率跟着包络走，才有"音头发亮、余音变暖"的层次。
 *
 * 为什么用 `partials` 加法合成而不是单一波形：triangle 只有奇次谐波、sine 没有
 * 谐波、sawtooth 满谐波但全频段等能量（刺耳且混叠）。钢琴的真实泛音是
 * 1 : 0.48 : 0.26 : 0.14 …这种快速收敛的分布，直接写出来比调波形准得多。
 *
 * `level` 是感知响度补偿：锯齿类音色能量集中在高频、听感上比正弦响得多，
 * 不逐音色配平的话，换个音色整首曲子的平衡就变了。
 */
/** Tone 主入口没导出 RecursivePartial，这里抄一份等价定义 */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

interface VoicePreset extends DeepPartial<Tone.MonoSynthOptions> {
  /** 该音色的基础增益（dB），用于跨音色的响度配平 */
  level: number;
}

const PRESETS: Record<InstrumentId, VoicePreset> = {
  // 钢琴：泛音要一直铺到 4kHz 以上，否则只听得到基频 —— 实测 6 个 partial 时
  // C4 的中频占比只有 12%，听感就是"圆滚滚没有细节"。加到 14 个之后中频有内容、
  // 高音区才有"铃"的光泽。PeriodicWave 是查表，加 partial 不增加播放时 CPU。
  piano: {
    oscillator: {
      type: "custom",
      partials: [1, 0.52, 0.32, 0.21, 0.15, 0.11, 0.08, 0.06, 0.045, 0.034, 0.026, 0.02, 0.015, 0.011],
    },
    // sustain 0.12 而不是 0.035：0.035 意味着一个四分音符在 0.8 秒内就衰减到听不见，
    // 那种"点一下就没了"是拨弦，不是钢琴。按住键时音应该还在，只是慢慢退。
    envelope: { attack: 0.002, decay: 2.4, sustain: 0.12, release: 0.6 },
    filter: { type: "lowpass", rolloff: -24, Q: 0.6, frequency: 6500 },
    filterEnvelope: { attack: 0.001, decay: 1.1, sustain: 0.08, release: 0.6, octaves: 1.2, exponent: 2 },
    level: -6,
  },
  // 电钢：比钢琴少一半泛音、更圆，尾巴带一点"铃"感
  epiano: {
    oscillator: { type: "custom", partials: [1, 0.3, 0.15, 0.08, 0.045, 0.025, 0.014, 0.008] },
    envelope: { attack: 0.003, decay: 1.6, sustain: 0.14, release: 0.8 },
    filter: { type: "lowpass", rolloff: -24, Q: 0.5, frequency: 4200 },
    filterEnvelope: { attack: 0.001, decay: 0.8, sustain: 0.12, release: 0.8, octaves: 1.2 },
    level: -6,
  },
  // 风琴：拉杆式（drawbar）整数组谐波，几乎没有起音过程，一按就是稳态
  organ: {
    oscillator: { type: "custom", partials: [1, 0.62, 0.4, 0.3, 0.2, 0.14, 0.1, 0.07, 0.05] },
    envelope: { attack: 0.012, decay: 0.06, sustain: 0.92, release: 0.22 },
    filter: { type: "lowpass", rolloff: -12, Q: 0.4, frequency: 6500 },
    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3, octaves: 0.5 },
    level: -9,
  },
  // 吉他：拨弦泛音比钢琴更亮、衰减更慢（指甲/拨片的那层"沙"就在 2-5kHz）
  guitar: {
    oscillator: {
      type: "custom",
      partials: [1, 0.7, 0.55, 0.42, 0.32, 0.24, 0.18, 0.13, 0.095, 0.07, 0.05, 0.036, 0.026, 0.018],
    },
    envelope: { attack: 0.003, decay: 1.2, sustain: 0.05, release: 0.45 },
    filter: { type: "lowpass", rolloff: -24, Q: 0.7, frequency: 6000 },
    filterEnvelope: { attack: 0.001, decay: 0.6, sustain: 0.03, release: 0.45, octaves: 1.6, exponent: 2 },
    level: -7,
  },
  // 贝斯：只留前五次谐波，低通压到 1.2k —— 贝斯一旦有高频就会盖住旋律
  bass: {
    oscillator: { type: "custom", partials: [1, 0.38, 0.16, 0.07, 0.03] },
    envelope: { attack: 0.008, decay: 0.6, sustain: 0.32, release: 0.18 },
    filter: { type: "lowpass", rolloff: -24, Q: 0.8, frequency: 1200 },
    filterEnvelope: { attack: 0.004, decay: 0.3, sustain: 0.16, release: 0.2, octaves: 1.4, exponent: 2 },
    level: -6,
  },
  // 弦乐：多振荡器微失谐（spread）才有"一群人在拉"的厚度，单一锯齿永远像合成器
  strings: {
    oscillator: { type: "fatsawtooth", count: 4, spread: 26 },
    envelope: { attack: 0.16, decay: 0.5, sustain: 0.72, release: 0.8 },
    filter: { type: "lowpass", rolloff: -24, Q: 0.9, frequency: 3000 },
    filterEnvelope: { attack: 0.3, decay: 0.8, sustain: 0.5, release: 1.0, octaves: 1.0 },
    level: -12,
  },
  // 铜管：方波族 + 明显的"吹起来"亮度上扬（滤波包络 octaves 大）
  brass: {
    oscillator: { type: "fatsquare", count: 3, spread: 14 },
    envelope: { attack: 0.06, decay: 0.32, sustain: 0.62, release: 0.35 },
    filter: { type: "lowpass", rolloff: -24, Q: 1.1, frequency: 2800 },
    filterEnvelope: { attack: 0.05, decay: 0.35, sustain: 0.35, release: 0.4, octaves: 1.6 },
    level: -12,
  },
  // 簧片：比铜管更窄更暗，用来区分单簧管/双簧管那一类
  reed: {
    oscillator: { type: "fatsquare", count: 3, spread: 10 },
    envelope: { attack: 0.04, decay: 0.24, sustain: 0.68, release: 0.28 },
    filter: { type: "lowpass", rolloff: -24, Q: 0.9, frequency: 2200 },
    filterEnvelope: { attack: 0.03, decay: 0.2, sustain: 0.4, release: 0.3, octaves: 1.2 },
    level: -11,
  },
  // 管乐（长笛）：几乎只有基频 + 一点高次泛音，这才是长笛"空"的原因
  pipe: {
    oscillator: { type: "custom", partials: [1, 0.2, 0.1, 0.05, 0.025, 0.012] },
    envelope: { attack: 0.05, decay: 0.2, sustain: 0.84, release: 0.3 },
    filter: { type: "lowpass", rolloff: -12, Q: 0.5, frequency: 4200 },
    filterEnvelope: { attack: 0.06, decay: 0.3, sustain: 0.6, release: 0.35, octaves: 0.6 },
    level: -7,
  },
  // 合成：宽失谐锯齿 + 高 Q 低通，带一点合成器特有的"哇"味
  synth: {
    oscillator: { type: "fatsawtooth", count: 5, spread: 34 },
    envelope: { attack: 0.015, decay: 0.42, sustain: 0.28, release: 0.5 },
    filter: { type: "lowpass", rolloff: -24, Q: 6, frequency: 2000 },
    filterEnvelope: { attack: 0.01, decay: 0.4, sustain: 0.15, release: 0.45, octaves: 2.2 },
    level: -12,
  },
  // 铺底：起音极慢、失谐最大，低通压到 1.5k —— 它只负责垫空气，不该抢任何东西
  pad: {
    oscillator: { type: "fatsawtooth", count: 6, spread: 44 },
    envelope: { attack: 0.8, decay: 1.6, sustain: 0.82, release: 2.4 },
    filter: { type: "lowpass", rolloff: -24, Q: 0.6, frequency: 1500 },
    filterEnvelope: { attack: 1.4, decay: 2, sustain: 0.7, release: 2.4, octaves: 0.6 },
    level: -15,
  },
  // 打击乐走 DrumKit，这组参数只用于兜底
  drums: {
    oscillator: { type: "sine" },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
    filter: { type: "lowpass", rolloff: -12, Q: 0.5, frequency: 6000 },
    filterEnvelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1, octaves: 0.5 },
    level: -6,
  },
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

/**
 * 混音总线：压缩 → 空间 → 限幅。
 *
 * 这三件东西解决的都是"干声直出"的毛病，缺一件听感就不对：
 *   - 压缩：多个轨同时响时把峰值按下去、把小音量抬起来，音量层次才稳。
 *     没有它，一轨独奏和六轨齐奏的响度能差一倍以上。
 *   - 空间：纯干声听起来像"贴着耳朵吹"，每个音都没有房间。给一点点混响
 *     （wet 0.13）就足以让声音退到墙里面去，而不至于变成教堂。
 *   - 限幅：兜住前面压缩没按住的瞬态。没有它，密集和弦会直接把采样顶到
 *     0dBFS 以上，也就是数字削波 —— 那种"撕裂"的失真不是音色差，是过载。
 *
 * 用 Freeverb 而不是 Tone.Reverb：后者要靠异步生成脉冲响应，实时可能还没就绪，
 * 而 Tone.Offline 离线渲染时几乎肯定还没就绪 —— 那会导致导出的音频没有混响、
 * 和实时听的对不上。Freeverb 是纯算法延迟网络，同步可用，两条路径一致。
 */
class MixBus {
  readonly input: Tone.Gain;
  private hp: Tone.Filter;
  private comp: Tone.Compressor;
  private verb: Tone.Freeverb;
  private limiter: Tone.Limiter;

  constructor() {
    this.input = new Tone.Gain(1);
    // 70Hz 以下人耳基本听不出音高，只会让功放白费力气、让低频糊成一片。
    // 钢琴左手的低音和贝斯原本就挤在这段里打架，切掉之后低频立刻干净一档。
    this.hp = new Tone.Filter({ type: "highpass", frequency: 70, rolloff: -12, Q: 0.5 });
    this.comp = new Tone.Compressor({
      threshold: -20,
      ratio: 3,
      attack: 0.008,
      release: 0.18,
      knee: 12,
    });
    // roomSize 太大（>0.85）会拖出一层金属残响，dampening 太低（<2000Hz）会让
    // 高频毛发变多。0.72 + 2400Hz 是这两头之间的甜点。
    this.verb = new Tone.Freeverb({ roomSize: 0.72, dampening: 2400 });
    this.verb.wet.value = 0.13;
    this.limiter = new Tone.Limiter(-1);
    this.input.chain(this.hp, this.comp, this.verb, this.limiter, Tone.getDestination());
  }

  dispose(): void {
    this.input.dispose();
    this.hp.dispose();
    this.comp.dispose();
    this.verb.dispose();
    this.limiter.dispose();
  }
}

/**
 * 把 preset 摊成 Tone.MonoSynth 的构造参数。
 *
 * **必须**把 filter.frequency 显式同步给 filterEnvelope.baseFrequency。
 *
 * Tone 的 FrequencyEnvelope 默认 baseFrequency 是 200Hz，而 MonoSynth 内部做的是
 * `filterEnvelope.connect(filter.frequency)` —— 也就是说滤波截止频率被包络整个
 * 接管了，你在 filter 里写的值根本不会被读。症状极其隐蔽：代码看着设了 6.5kHz
 * 低通，实际稳态截止只有 200Hz 出头，声音被闷成一个没有泛音的点，而频谱图上
 * 一切"正常"（就是低频多）。这是音色发闷、像玩具琴的核心原因。
 */
function voiceOptions(p: VoicePreset): DeepPartial<Tone.MonoSynthOptions> {
  const cutoff = (p.filter as { frequency?: number } | undefined)?.frequency;
  return {
    oscillator: p.oscillator,
    envelope: p.envelope,
    filter: p.filter,
    filterEnvelope: cutoff === undefined ? p.filterEnvelope : { ...p.filterEnvelope, baseFrequency: cutoff },
    volume: p.level,
  };
}

/**
 * 音色选择：有采样就用采样。
 *
 * 采样是"更好"，不是"必须" —— makeSampler 在 buffer 没就绪（或该音色本来就
 * 只有合成）时返回 null，这里退回合成。整条链路上不允许因为采样缺失而没声音。
 */
function makeVoice(id: InstrumentId, output: Tone.InputNode): { voice: Voice; sampled: boolean } {
  const sampled = makeSampler(id, output);
  if (sampled) return { voice: asVoice(sampled), sampled: true };
  const preset = PRESETS[id] ?? PRESETS.piano;
  return {
    voice: asVoice(new Tone.PolySynth(Tone.MonoSynth, voiceOptions(preset)).connect(output)),
    sampled: false,
  };
}

function makeNode(track: Track, bus: Tone.InputNode): TrackNode {
  const channel = new Tone.Channel({ volume: gainToDb(track.volume), pan: track.pan, mute: track.mute }).connect(bus);
  if (track.instrument === "drums") {
    return {
      trackId: track.id,
      voice: null,
      sampled: false,
      kit: new DrumKit(channel),
      channel,
      instrument: track.instrument,
    };
  }
  const { voice, sampled } = makeVoice(track.instrument, channel);
  return { trackId: track.id, voice, sampled, kit: null, channel, instrument: track.instrument };
}

function gainToDb(gain: number): number {
  const g = Math.max(0.0001, Math.min(1, gain));
  return 20 * Math.log10(g);
}

/**
 * MIDI 力度 → 增益。
 *
 * 直接用 vel/127 当振幅，听感上「轻按」和「重按」几乎一样响 —— 因为人耳对响度
 * 是对数感知的，线性振幅的差别会被压扁。开 1.35 次方之后动态才拉开：弱音真的
 * 退到后面，重音真的顶上来，一首曲子的起伏才听得出来。
 */
function velocityGain(vel: number): number {
  const v = Math.max(1, Math.min(127, vel)) / 127;
  return Math.max(0.06, Math.pow(v, 1.35));
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
  /** 全局总线：所有轨、教具琴、节拍器都汇到这里 */
  private bus: MixBus | null = null;
  private score: Score | null = null;
  /** load 的世代号：切歌时用它丢弃"迟到的上一次加载" */
  private loadToken = 0;
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
  private tutor: Voice | null = null;
  /** 教具琴的响度微调（采样/合成两条路径都要，所以单独挂一个 Volume） */
  private tutorTrim: Tone.Volume | null = null;
  /** 走带状态回调（播放头位置等），由 UI 订阅 */
  onTick: ((state: TransportState) => void) | null = null;

  constructor() {
    Tone.getTransport().on("stop", () => this.emit());
  }

  /**
   * 拿总线，没有就造一条。
   *
   * 懒建的原因：Tone 的节点必须在音频上下文可用之后创建才有意义，而这个类
   * 在模块加载时就被 new 出来了。放在第一次 load / pluck 时建，那时上下文
   * 一定已经存在。
   */
  private ensureBus(): MixBus {
    if (!this.bus) this.bus = new MixBus();
    return this.bus;
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

  /**
   * 载入乐谱：重建音色节点与事件表。重复调用是安全的。
   *
   * 必须是异步的：采样得先解码完再建节点，否则 Sampler 拿到的是空 buffer，
   * 表现就是"谱面在走、一点声音没有"——和之前 CSP 拦 Worker 的症状一模一样，
   * 极难区分。宁可在加载上多等一两百毫秒。
   *
   * 用 loadToken 处理并发：切歌时上一次 load 可能还卡在采样加载里，等它回来
   * 不能再去动已经属于新乐谱的节点。
   */
  async load(score: Score): Promise<void> {
    const token = ++this.loadToken;
    this.stop();
    this.score = score;
    for (const n of this.nodes.values()) {
      n.voice?.dispose();
      n.kit?.dispose();
      n.channel.dispose();
    }
    this.nodes.clear();

    await preloadFor(score.tracks.map((t) => t.instrument));
    if (token !== this.loadToken) return;

    const bus = this.ensureBus();
    for (const t of score.tracks) this.nodes.set(t.id, makeNode(t, bus.input));
    this.scheduleAll();
    this.warmup();
    Tone.getTransport().loop = this.loop !== null;
    this.emit();
  }

  /**
   * 预热 voice。
   *
   * Tone.PolySynth 的 voice 是懒创建的 —— 第一次触发某个音才 new 一个 MonoSynth，
   * 里面要现建振荡器、两个包络和一个 biquad。一个八度的和弦同时响起时，这些构造
   * 全挤进同一帧，表现就是**第一个和弦比后面的慢半拍，偶尔还带一声咔哒**。
   * 这里用 -80dB 的极短音先把常用音区的 voice 建出来，代价是听不见。
   *
   * 采样音色跳过：Player 直接读现成的 buffer，没有 voice 构造这回事。真去预热
   * 反而会让第一下播放多出几声听不见但占 CPU 的调度。
   */
  private warmup(): void {
    const now = Tone.now() + 0.05;
    const probes = ["A2", "A3", "A4", "A5"];
    for (const node of this.nodes.values()) {
      if (!node.voice || node.sampled) continue;
      try {
        probes.forEach((note, i) => {
          node.voice?.triggerAttackRelease(note, 0.02, now + i * 0.01, 0.0001);
        });
      } catch {
        /* 预热失败不影响正常播放，忽略 */
      }
    }
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
          else node.voice?.triggerAttackRelease(midiToFreq(ev.pitch), dur, time, velocityGain(ev.vel));
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
      // 节拍器走同一条总线，跟着限幅一起兜底；音量压得比原来低一档，
      // 因为总线的压缩会把它抬起来。
      this.clickSynth = new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 2, volume: -22 }).connect(this.ensureBus().input);
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
      // 采样得先到位：pluck 是"按下就要响"，不能等第二次才出声
      await preload("piano");
      // 接总线而不是直出：教具琴和伴奏必须在同一个空间里，否则弹一句就听得出
      // "琴在外面、伴奏在里面"——这种割裂感比音色本身更影响练习体验。
      // +2dB 让教具琴比乐谱里的钢琴轨稍突出一点：学生在弹，伴奏在下面垫着。
      this.tutorTrim = new Tone.Volume(2).connect(this.ensureBus().input);
      this.tutor = makeVoice("piano", this.tutorTrim).voice;
    }
    this.tutor.triggerAttackRelease(
      midiToFreq(pitch),
      Math.max(0.08, durSec),
      undefined,
      Math.max(0.05, Math.min(1, vel)),
    );
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
      n.voice?.dispose();
      n.kit?.dispose();
      n.channel.dispose();
    }
    this.nodes.clear();
    this.tutor?.dispose();
    this.tutor = null;
    this.tutorTrim?.dispose();
    this.tutorTrim = null;
    this.clickSynth?.dispose();
    this.clickSynth = null;
    this.bus?.dispose();
    this.bus = null;
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
  // 采样必须在进 Tone.Offline 之前解码完：离线上下文里没有机会等网络，
  // 拿不到 buffer 的 Sampler 会整轨静音，导出的 WAV 就少了几层。
  await preloadFor(score.tracks.map((t) => t.instrument));
  const buffer = await Tone.Offline(() => {
    const transport = Tone.getTransport();
    // 离线渲染也要过同一条总线：不加的话导出的 WAV 是没压缩、没混响、可能
    // 削波的干声，和用户在应用里听到的完全不是一个东西。
    const bus = new MixBus();
    const nodes: TrackNode[] = score.tracks.map((t) => makeNode(t, bus.input));
    const audible = new Set(audibleTracks(score).map((t) => t.id));
    score.tracks.forEach((track) => {
      const node = nodes.find((n) => n.trackId === track.id);
      if (!node || !audible.has(track.id)) return;
      for (const ev of eventsOf(track)) {
        transport.schedule((time) => {
          const dur = Math.max(0.05, ev.durBeats * spb);
          if (node.kit) node.kit.trigger(time, ev.pitch, dur, ev.vel);
          else node.voice?.triggerAttackRelease(midiToFreq(ev.pitch), dur, time, velocityGain(ev.vel));
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
