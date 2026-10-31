/**
 * AI 作曲链路。
 *
 * 链路：一句话 → 提示词 → 大模型输出 ABC → 严格子集解析 → Score IR。
 * 三个关键设计：
 *   1) 用 ABC 当中间语言（见 abc.ts 顶部说明）；
 *   2) **不接受自由格式**：模型输出必须是 ABC，解析失败把错误回抛给它重试一次；
 *   3) 重试仍失败 → 抛错，界面上明确降级到本地算法（compose.ts），
 *      绝不把"算法生成的曲子"标成"AI 生成"。
 *
 * 兼容任何 OpenAI 兼容的 chat/completions 端点：OpenAI / DeepSeek / Kimi / 智谱 / 本地 Ollama 都行。
 * API Key 只存在本机 localStorage，不进仓、不打印、不随工程文件导出。
 */

import { MusicError, beatsPerMeasure, type Score } from "./model.ts";
import { abcKeyName } from "./theory.ts";
import { parseAbc, toAbc } from "./abc.ts";
import type { StyleId } from "./compose.ts";

export interface AiProvider {
  /** 例如 https://api.deepseek.com/v1（末尾不要带斜杠） */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** 本地模型不需要 Key */
  needsKey: boolean;
  hint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    needsKey: true,
    hint: "中文乐理描述理解好，价格低",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    needsKey: true,
    hint: "通用能力强",
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    needsKey: true,
    hint: "国内直连",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    needsKey: true,
    hint: "国内直连、有免费额度",
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    needsKey: false,
    hint: "完全离线，质量取决于本机模型",
  },
  {
    // 家族自建的本地推理网关（OpenAI 兼容）。默认地址是网关所在的**本机**；
    // 网关跑在另一台机器（如 mini）时，把地址换成那台的 IP 即可。
    // 模型名取网关 `/v1/models` 里的文本模型（当前是 35B-A3B 那条）。
    id: "zbiz-local",
    label: "zBiz 本地网关",
    baseUrl: "http://127.0.0.1:8200/v1",
    model: "zBiz-Text-35B",
    needsKey: false,
    hint: "自建网关，无需密钥；跑在别的机器上时改地址",
  },
];

export const DEFAULT_PROVIDER: AiProvider = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  temperature: 0.8,
};

/* -------------------------------------------------------------- 提示词 */

const SYSTEM_PROMPT = `你是一位职业作曲与编曲师，输出格式是 ABC 记谱法文本。
只能输出 ABC 文本本身：不要 Markdown 代码块，不要解释，不要前后缀。

必须遵守的 ABC 子集（超出的写法会被解析器拒绝）：
- 头字段只有这些：X:1 / T:标题 / C:作者 / M:拍号 / L:默认时值 / Q:速度 / K:调号
- 多声部用 V:1 V:2 V:3 分声部，并在 K: 之前写 %%score 1 2 3
- 音名：CDEFGAB（中音区），小写 cdefgab 为高八度，' 再加高八度，, 降八度
- 升降：# 写成 ^，降号写成 _（例如 ^F 表示升 F）
- 时值：在音名后写数字或斜杠：C2 二分、C/2 八分、C/4 十六分、C3/2 附点二分、C 默认时值
- 休止：z（z2 二分休止、z/2 八分休止）
- 和弦：方括号写在一起，如 [CEG]
- 连音线：音后加减号，如 C2- | C2
- 小节线：| （每小节必须写，且每小节总时值要与拍号一致）
- 禁止使用：装饰音 {}、破碎节奏 > <、多声部连接符 &、反复记号、装饰记号 !!

编曲要求：
- 至少两个声部：V:1 主旋律，V:2 伴奏（和弦或分解和弦）；需要低音时加 V:3
- 主旋律要好听、可唱：以级进为主，偶尔跳进，每 4 小节乐句收尾
- 强拍落在和弦音上，弱拍可用经过音
- 音域：主旋律不要超过 c' 到 a''，低音不要低于 C,`;

export interface ComposeBrief {
  /** 用户原话 */
  text: string;
  key: { tonic: number; mode: "major" | "minor" };
  bars: number;
  tempo: number;
  style: StyleId;
  tracks: number;
}

export function buildComposeMessages(brief: ComposeBrief): { role: "system" | "user"; content: string }[] {
  const beats = (4 * 4) / 4;
  const user = `请写一首 ${brief.bars} 小节的曲子。
- 调性：${abcKeyName(brief.key)}（ABC 的 K: 字段就写 ${abcKeyName(brief.key)}）
- 拍号：4/4，速度 ${brief.tempo} BPM（Q:1/4=${brief.tempo}）
- 声部数：${brief.tracks}（V:1 主旋律，V:2 伴奏${brief.tracks > 2 ? "，V:3 低音" : ""}）
- 每小节 ${beats} 拍，共 ${brief.bars} 个小节，每行结尾必须有 | 且小节时值正确
- 风格要求：${brief.text || "抒情、好听、结构完整"}

只输出 ABC 文本。`;

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function buildExtendMessages(score: Score, instruction: string, bars: number): { role: "system" | "user"; content: string }[] {
  const head = toAbc(score);
  // 只给模型看最后 4 小节，省 token 也避免它把整首重写
  const tail = head.trim().split("\n").slice(-12).join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `这是一首曲子的结尾（ABC 片段）：\n${tail}\n\n请接着写 ${bars} 个小节（${instruction || "自然延续，情绪推向高潮后收束"}）。
只输出**新增部分**的 ABC：从 V:1 的后续小节开始，每声部都要写，不要重复已有小节，不要写头字段。
如果必须写头字段才能表达调性变化，就完整重写整首并把长度控制在 ${bars} 小节新增。`,
    },
  ];
}

export function buildVaryMessages(score: Score, instruction: string): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请把下面这首曲子做一次变奏：${instruction || "保持和声骨架，改节奏与织体，情绪更推进一层"}。
保持小节数、调性、拍号不变。只输出完整的 ABC 文本。

${toAbc(score)}`,
    },
  ];
}

export function buildPolishMessages(score: Score, instruction: string): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请润色下面这首曲子：${instruction || "低音太单调，加走动低音；旋律加一点模进"}。
保持小节数、调性、拍号、旋律骨架不变，只改需要改的地方。只输出完整的 ABC 文本。

${toAbc(score)}`,
    },
  ];
}

/** 从模型回复里把 ABC 抠出来：容忍 Markdown 代码块与前置解释 */
export function extractAbc(raw: string): string {
  let text = raw.trim();
  const fence = /```(?:abc|ABC)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  const xIdx = text.search(/^\s*X:/m);
  if (xIdx > 0) text = text.slice(xIdx);
  return text.trim();
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 该地址是否指向本机 / 局域网。
 *
 * 这类地址上的 OpenAI 兼容服务（llama.cpp、Ollama、LM Studio、vLLM，以及
 * 家里那台 mini 上的网关）没有鉴权层，不该逼用户填 API Key。
 *
 * 2026-10-31 修：原来这里是 `/localhost|127\.0\.0\.1/.test(base)`，于是
 * `http://192.168.31.249:8200/v1` 这种局域网地址被判成「要 key」，
 * 用户只能往设置里塞一个假密钥。判据与 cap-llm::is_private_endpoint 同源。
 */
export function isPrivateEndpoint(baseUrl: string): boolean {
  const rest = baseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostport = (rest.split(/[/?#]/)[0] ?? "").trim();
  const afterUser = hostport.includes("@") ? hostport.slice(hostport.lastIndexOf("@") + 1) : hostport;
  // IPv6 字面量带方括号：`[::1]:8200`，括号内就是完整地址，不能再按冒号切
  let host = afterUser;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else {
    host = host.split(":")[0] ?? "";
  }
  host = host.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "host.docker.internal") return true;
  if (/\.(local|lan|internal)$/.test(host)) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) // link-local
    );
  }
  // IPv6 回环 / 唯一本地地址 fc00::/7
  return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host);
}

/** 调用 OpenAI 兼容的 chat/completions；错误翻成人话 */
export async function callChat(
  provider: AiProvider,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (!base) throw new MusicError("还没有填 AI 服务地址（设置 → AI 服务）");
  if (!provider.model) throw new MusicError("还没有填模型名（设置 → AI 服务）");
  const needsKey = !isPrivateEndpoint(base);
  if (needsKey && !provider.apiKey) throw new MusicError("还没有填 API Key（设置 → AI 服务）");

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: provider.temperature,
        max_tokens: 3000,
      }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new MusicError("已取消生成");
    throw new MusicError(`连不上 AI 服务（${base}）：${e instanceof Error ? e.message : String(e)}。检查地址与网络代理。`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint =
      res.status === 401 || res.status === 403
        ? "API Key 无效或没有该模型权限"
        : res.status === 404
          ? "接口地址不对（要填到 /v1 这一级）"
          : res.status === 429
            ? "请求太频繁或额度用尽"
            : res.status >= 500
              ? "AI 服务端出错，稍后重试"
              : "请求被拒绝";
    throw new MusicError(`${hint}（HTTP ${res.status}）${body ? `：${body.slice(0, 160)}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (data.error?.message) throw new MusicError(`AI 服务返回错误：${data.error.message}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new MusicError("AI 返回了空内容（可能是被内容过滤或被截断）");
  return content;
}

export interface GenerateResult {
  score: Score;
  abc: string;
  model: string;
  /** 解析第二次才成功时为 true，界面可以提示"已自动修正一次" */
  retried: boolean;
}

/**
 * 一次完整生成：发请求 → 解析 → 失败则带错误重试一次。
 * 返回的 score 已经是 IR，界面不用再管 ABC。
 */
export async function generateFromMessages(
  provider: AiProvider,
  messages: ChatMessage[],
  signal?: AbortSignal,
  title?: string,
): Promise<GenerateResult> {
  const first = extractAbc(await callChat(provider, messages, signal));
  try {
    const parsed = parseAbc(first, title ?? "AI 作品");
    return { score: { ...parsed.score, meta: { origin: "ai", model: provider.model } }, abc: first, model: provider.model, retried: false };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (signal?.aborted) throw new MusicError("已取消生成");
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: first.slice(0, 2000) },
      {
        role: "user",
        content: `上面这段 ABC 有语法错误：${err}
请只修正这个错误后重新输出**完整**的 ABC 文本（不要解释，不要代码块）。特别注意每小节时值要等于拍号。`,
      },
    ];
    const second = extractAbc(await callChat(provider, retryMessages, signal));
    try {
      const parsed = parseAbc(second, title ?? "AI 作品");
      return {
        score: { ...parsed.score, meta: { origin: "ai", model: provider.model } },
        abc: second,
        model: provider.model,
        retried: true,
      };
    } catch (e2) {
      const err2 = e2 instanceof Error ? e2.message : String(e2);
      throw new MusicError(`AI 两次输出的 ABC 都解析不了：${err2}。可以点「本地生成」先用算法出一版。`);
    }
  }
}

/** 生成时的自检：小节数与拍号是否对得上（对不上时界面给提示而不是假装没事） */
export function abcBarCheck(score: Score): string[] {
  const beats = beatsPerMeasure(score);
  const out: string[] = [];
  for (const t of score.tracks) {
    let end = 0;
    for (const n of t.notes) end = Math.max(end, n.start + n.dur);
    const rest = end % beats;
    if (rest > 1e-6 && beats - rest > 1e-6) {
      out.push(`轨道「${t.name}」末尾差 ${(beats - rest).toFixed(2)} 拍满一小节`);
    }
  }
  return out;
}
