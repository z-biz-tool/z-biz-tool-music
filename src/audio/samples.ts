/**
 * 真实乐器采样（随包分发，离线可用）。
 *
 * 为什么从合成器换成采样：合成器能把**稳态频谱**调到很像某个乐器，但真实乐器
 * 里最像"它自己"的部分不在频谱里 —— 击弦的噪声、琴槌毛毡的硬度、琴弦之间的
 * 耦合、琴体与踏板共鸣带来的非谐分音，全是随机的瞬态细节。加法合成能做出
 * "听起来像钢琴的正确泛音列"，却做不出那层"每次都不完全一样"的颗粒。
 * 对钢琴这种有明确原声参照的音色，这一步跨不过去，只能上采样。
 *
 * 采样来源与授权见 `scripts/fetch-samples.sh`：
 *   - 钢琴：Salamander Grand Piano（Alexander Holm 录制，CC-BY 3.0）
 *   - 其余：VSCO2（Versilian Studios，CC0）
 *
 * 只覆盖"有明确原声参照"的音色（钢琴/管乐/吉他/铜管/簧片/风琴）。电钢、弦乐
 * 合奏、合成主音、铺底仍然走合成 —— 它们本来就是电子的或由多件乐器叠加而成，
 * 单件采样反而更假（一把独奏小提琴不像弦乐组，一台合成器也不需要采样）。
 */

import * as Tone from "tone";
import type { InstrumentId } from "../core/model.ts";

export interface SampleSet {
  /** 采样目录：public/samples/<dir> */
  dir: string;
  /**
   * 采样音名，使用 rs 记法（`Ds1` = D#1），与磁盘文件名一致。
   * 之所以不直接在磁盘上写 `D#1`：`#` 在 URL 里是片段标识符，必须编码成 %23，
   * 徒增一层出错的机会。映射到 Tone 的音名在 urlsOf() 里做。
   */
  notes: readonly string[];
  /** 松键后的淡出时长（秒）—— 对应真乐器"制音器落下"，不是立刻静音 */
  release: number;
  /** 按下时的淡入（秒），用来吃掉 mp3 起始处的编码毛刺 */
  attack: number;
  /** 相对总线的基础增益补偿（dB）。采样本身的响度不一致，必须逐套配平 */
  volume: number;
}

/**
 * 采样点之间的最大音程：Salamander 是每小三度一个采样（变调最多 ±1 个半音），
 * 探针乐器大多是小三度到纯四度。变调越多，共鸣箱的形态就越假，所以这个间隔
 * 不能再放稀。
 */
export const SAMPLE_SETS: Partial<Record<InstrumentId, SampleSet>> = {
  piano: {
    dir: "piano",
    notes: [
      "A0", "C1", "Ds1", "A1", "C2", "Ds2", "A2", "C3", "Ds3", "A3", "C4", "Ds4",
      "A4", "C5", "Ds5", "A5", "C6", "Ds6", "A6", "C7", "Ds7", "A7", "C8",
    ],
    release: 0.35,
    attack: 0.002,
    volume: 7.7,
  },
  pipe: {
    dir: "pipe",
    notes: ["C4", "E4", "A4", "C5", "E5", "A5", "C6", "E6", "A6", "C7"],
    release: 0.12,
    attack: 0.008,
    volume: -7.4,
  },
  guitar: {
    dir: "guitar",
    notes: [
      "B1", "E2", "A2", "D2", "G3", "B2", "Fs2", "Gs2", "E3", "A3", "D3", "G3",
      "B3", "Fs3", "Cs3", "Ds4", "E4", "A4", "D5", "Fs4", "Gs4", "Cs4", "E5",
      "A5", "B4", "G5", "Gs5", "As5", "Fs5", "Cs5",
    ],
    release: 0.22,
    attack: 0.002,
    volume: -0.7,
  },
  brass: {
    dir: "brass",
    notes: ["F3", "A3", "C4", "Ds4", "F4", "G4", "As4", "D5", "F5", "A5", "C6"],
    release: 0.14,
    attack: 0.006,
    volume: -4.2,
  },
  reed: {
    dir: "reed",
    notes: ["D3", "F3", "As3", "D4", "F4", "As4", "D5", "F5", "As5", "D6", "Fs6"],
    release: 0.11,
    attack: 0.005,
    volume: -12.6,
  },
  organ: {
    dir: "organ",
    notes: [
      "C1", "Ds1", "Fs1", "A1", "C2", "Ds2", "Fs2", "A2", "C3", "Ds3", "Fs3",
      "A3", "C4", "Ds4", "Fs4", "A4", "C5", "Ds5", "Fs5", "A5", "C6",
    ],
    release: 0.08,
    attack: 0.01,
    volume: -5.5,
  },
};

const BASE = "/samples/";

/**
 * 单个采样最多保留多长（秒）。
 *
 * Salamander 的钢琴采样是整段自然衰减，平均 14 秒、低音区到 25 秒 —— 那是
 * 演奏厅里的真实余音，但对我们没用：谱面播放的音符通常一两拍就松键了，
 * Sampler 到点就淡出，后面十几秒永远播不到。可是**解码出来的 buffer 是要
 * 常驻内存的**：23 个采样 × 14 秒 × 48kHz × 立体声 × 4 字节 ≈ 125MB，
 * 六套乐器全加载能到 230MB 以上。
 *
 * 截到 6 秒：足够覆盖任何"真的按住 6 秒"的长音，内存降到原来的 40%。
 * 截断处做 50ms 淡出，否则波形被从中间切开会留下一个咔哒声。
 */
const MAX_SAMPLE_SECONDS = 6;

/**
 * 把一个解码好的采样截断到 sec 秒，并切掉文件头尾的冗余（不超长就只做头部处理）。
 *
 * 头部：mp3 编码器会在文件开头塞一小段数字静音（实测 0.3–15.7ms）。不切掉的话，
 * 每个音都比播放头晚那么一点点 —— 单个音听不出来，但整轨累积起来就会觉得
 * "伴奏在拖"。只切 -80dB 以下的真静音，乐器的起音坡度（簧片 80ms、风琴 66ms
 * 那种"吹起来"的过程）一律保留，那是音色本身。
 *
 * 尾部：见 MAX_SAMPLE_SECONDS。
 *
 * 用 `new AudioBuffer({...})` 而不是 Tone 的包装：这里只需要一个纯数据容器，
 * 走 Tone 会多一层 dispose 生命周期要管。
 */
function trimBuffer(src: AudioBuffer, sec: number): AudioBuffer {
  const rate = src.sampleRate;
  const head = src.getChannelData(0);

  // 最多前移 40ms：再长就不是编码器延迟，而是乐器真的在慢慢起音
  let start = 0;
  const maxStart = Math.min(Math.round(0.04 * rate), Math.floor(src.length / 4));
  while (start < maxStart && Math.abs(head[start]) < 1e-4) start++;

  const available = src.length - start;
  const len = Math.min(available, Math.round(sec * rate));
  if (start === 0 && len >= src.length) return src;

  const out = new AudioBuffer({
    length: len,
    sampleRate: rate,
    numberOfChannels: src.numberOfChannels,
  });
  // 50ms 淡出：截断点落在波形中间，不淡出就是一声咔哒
  const fade = Math.min(Math.round(0.05 * rate), Math.floor(len / 4));

  for (let c = 0; c < src.numberOfChannels; c++) {
    const data = new Float32Array(len);
    src.copyFromChannel(data, c, start);
    for (let i = 0; i < fade; i++) {
      data[len - 1 - i] *= i / fade;
    }
    out.copyToChannel(data, c);
  }
  return out;
}

/** `Ds1` → `D#1`：Tone 的音名解析只认 # / b，不认 rs 记法的 s */
function toneNote(fileBase: string): string {
  return fileBase.replace(/^([A-G])s/, "$1#");
}

type BufferMap = Record<string, Tone.ToneAudioBuffer>;

const cache = new Map<InstrumentId, BufferMap>();
const inflight = new Map<InstrumentId, Promise<void>>();
/** 加载失败的音色：不再重试，直接退回合成，避免每次播放都卡一轮超时 */
const failed = new Set<InstrumentId>();

export function sampleSetOf(id: InstrumentId): SampleSet | undefined {
  return SAMPLE_SETS[id];
}

/** 已就绪的采样；没就绪返回 undefined（调用方据此决定用采样还是合成） */
export function readyBuffers(id: InstrumentId): BufferMap | undefined {
  return cache.get(id);
}

/**
 * 采样退回合成时的通知口。
 *
 * 为什么要暴露：退回合成是**静默降级** —— 还能出声，只是音色变回电子味。
 * 用户不会知道，我们排查时也看不到（release 版没有控制台）。这类"看起来正常
 * 的降级"比直接报错更难查，所以让它有机会变成一句可见的提示。
 */
let fallbackHandler: ((id: InstrumentId) => void) | null = null;

export function setSampleFallbackHandler(fn: ((id: InstrumentId) => void) | null): void {
  fallbackHandler = fn;
}

/** 采样是否可用（配了采样、且没加载失败） */
export function hasSamples(id: InstrumentId): boolean {
  return SAMPLE_SETS[id] !== undefined && !failed.has(id);
}

/**
 * 取一个采样的原始字节。
 *
 * 不直接用 Tone 的 `ToneAudioBuffer.fromUrl`：它内部只走 `fetch`。装机版里前端
 * 资源是通过 Tauri 的自定义协议（`tauri://localhost`）提供的，自定义协议对
 * fetch 的支持完全取决于 WebView 实现；一旦不支持，表现就是"采样全静音、
 * 只退回合成音色"，而且**只在装机版复现、dev 一切正常**——这个仓已经被这种
 * 伪装坑过两次（CSP 拦 Worker、CSP 拦 blob）。所以这里自己取字节，fetch 不行
 * 就退到 XHR（自定义协议下 XHR 的状态码常是 0，也算成功）。
 */
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.arrayBuffer();
    throw new Error(`HTTP ${res.status}`);
  } catch (first) {
    try {
      return await new Promise<ArrayBuffer>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
          // 自定义协议下 status 通常是 0 而不是 200
          if (xhr.status === 200 || xhr.status === 0) {
            const buf = xhr.response as ArrayBuffer | null;
            if (buf && buf.byteLength > 0) resolve(buf);
            else reject(new Error("XHR 返回空数据"));
          } else {
            reject(new Error(`XHR ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error("XHR 网络错误"));
        xhr.send();
      });
    } catch {
      throw first;
    }
  }
}

/** 取字节 + 解码，返回可直接喂给 Sampler 的 buffer */
async function loadSample(url: string): Promise<AudioBuffer> {
  return Tone.getContext().decodeAudioData(await fetchBytes(url));
}

/**
 * 预加载某个音色的全部采样。幂等：并发调用共享同一个 Promise。
 *
 * 失败不抛错 —— 采样是"更好"，不是"必须"。文件缺失、解码失败、磁盘读不到，
 * 都退回合成音色继续播，绝不能让整个播放链路挂掉。
 */
export function preload(id: InstrumentId): Promise<void> {
  const set = SAMPLE_SETS[id];
  if (!set || cache.has(id) || failed.has(id)) return Promise.resolve();

  const running = inflight.get(id);
  if (running) return running;

  const task = (async () => {
    try {
      const entries = await Promise.all(
        set.notes.map(async (n) => {
          const raw = await loadSample(`${BASE}${set.dir}/${n}.mp3`);
          return [toneNote(n), new Tone.ToneAudioBuffer(trimBuffer(raw, MAX_SAMPLE_SECONDS))] as const;
        }),
      );
      cache.set(id, Object.fromEntries(entries));
    } catch (e) {
      failed.add(id);
      console.warn(`[samples] ${id} 采样加载失败，本次退回合成音色：`, e);
      fallbackHandler?.(id);
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, task);
  return task;
}

/** 批量预加载（去重），用于「这份乐谱用到了哪些音色」 */
export async function preloadFor(ids: Iterable<InstrumentId>): Promise<void> {
  await Promise.all([...new Set(ids)].map(preload));
}

/**
 * 造一个采样乐器。采样没就绪时返回 null，交给调用方走合成兜底。
 *
 * 这里刻意不用 `new Tone.Sampler({ urls: {...路径} })` 的异步加载形式：
 * 那样播放要等 onload，首帧必然是静音的，而且离线渲染时几乎肯定还没加载完，
 * 导出的 WAV 会变成合成音色 —— 用户听到的和导出的又不是同一个东西了。
 * 传入已解码的 ToneAudioBuffer 之后，Sampler 是同步可用的。
 */
export function makeSampler(id: InstrumentId, output: Tone.InputNode): Tone.Sampler | null {
  const set = SAMPLE_SETS[id];
  const buffers = cache.get(id);
  if (!set || !buffers) return null;
  return new Tone.Sampler({
    urls: buffers,
    release: set.release,
    attack: set.attack,
    volume: set.volume,
  }).connect(output);
}

/** 测试/重置用：清空缓存（改采样源之后强制重载） */
export function resetSampleCache(): void {
  cache.clear();
  inflight.clear();
  failed.clear();
}
