/**
 * 导入 / 导出。
 *
 * 桌面壳里走原生对话框（Rust 命令 save_file / open_file），浏览器里退到下载与 <input>。
 * 两条路都要能跑：开发用浏览器，交付用桌面壳，行为不一致会让测试结论失真。
 */

import { invoke } from "@tauri-apps/api/core";
import { MusicError, serializeScore, type Score } from "../core/model.ts";
import { toAbc, parseAbc } from "../core/abc.ts";
import { toMusicXml, fromMusicXml } from "../core/musicxml.ts";
import { toMidiBytes, fromMidiBytes } from "../core/midi.ts";
import { bytesToText, bytesToBase64, textToBytes } from "../core/bytes.ts";
import { projectFromJson } from "../state.ts";

export type ExportKind = "zmusic" | "midi" | "musicxml" | "abc" | "wav";

export const EXPORT_META: Record<ExportKind, { label: string; ext: string; mime: string; hint: string }> = {
  zmusic: { label: "工程文件", ext: "zmusic", mime: "application/json", hint: "可再次打开继续编辑" },
  midi: { label: "MIDI", ext: "mid", mime: "audio/midi", hint: "Logic / Cubase / MuseScore 都能开" },
  musicxml: { label: "MusicXML", ext: "musicxml", mime: "application/vnd.recordare.musicxml+xml", hint: "给 MuseScore / Sibelius 接着改" },
  abc: { label: "ABC 文本", ext: "abc", mime: "text/plain", hint: "纯文本谱，方便贴给 AI 或论坛" },
  wav: { label: "音频 WAV", ext: "wav", mime: "audio/wav", hint: "离线渲染，带多轨混音" },
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function safeName(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "未命名";
  return base;
}

async function saveBytes(name: string, bytes: Uint8Array): Promise<string> {
  if (isTauri()) {
    const path = await invoke<string | null>("save_file", { fileName: name, bytes: Array.from(bytes) });
    if (!path) throw new MusicError("已取消保存");
    return path;
  }
  // 浏览器：走 a[download]
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return name;
}

export async function saveText(name: string, text: string): Promise<string> {
  return saveBytes(name, textToBytes(text));
}

/** 按类型导出；返回实际落盘路径（浏览器里是下载文件名） */
export async function exportScore(kind: ExportKind, score: Score): Promise<string> {
  const base = safeName(score.title);
  switch (kind) {
    case "zmusic":
      return saveText(`${base}.zmusic`, serializeScore(score));
    case "abc":
      return saveText(`${base}.abc`, toAbc(score));
    case "musicxml":
      return saveText(`${base}.musicxml`, toMusicXml(score));
    case "midi":
      return saveBytes(`${base}.mid`, toMidiBytes(score));
    case "wav": {
      // 动态引用：只有在真的导出音频时才把合成器那一坨加载进来
      const { renderWav } = await import("../audio/engine.ts");
      return saveBytes(`${base}.wav`, await renderWav(score));
    }
    default: {
      const never: never = kind;
      throw new MusicError(`不支持的导出类型：${String(never)}`);
    }
  }
}

export interface OpenedFile {
  name: string;
  text?: string;
  bytes?: Uint8Array;
}

/** 打开文件：桌面走原生对话框，浏览器走 <input type=file> */
export async function pickFile(accept: string): Promise<OpenedFile | null> {
  if (isTauri()) {
    const res = await invoke<{ name: string; path: string; bytes: number[] } | null>("open_file");
    if (!res) return null;
    const bytes = new Uint8Array(res.bytes);
    return { name: res.name, bytes, text: looksTextual(res.name) ? bytesToText(bytes) : undefined };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve({ name: file.name, bytes, text: looksTextual(file.name) ? bytesToText(bytes) : undefined });
    };
    input.click();
  });
}

function looksTextual(name: string): boolean {
  return /\.(zmusic|json|abc|musicxml|xml|txt)$/i.test(name);
}

/** 打开工程（.zmusic / JSON） */
export async function openProjectFile(): Promise<{ name: string; score: Score } | null> {
  const file = await pickFile(".zmusic,.json,application/json");
  if (!file) return null;
  const text = file.text ?? (file.bytes ? bytesToText(file.bytes) : "");
  if (!text.trim()) throw new MusicError("文件是空的");
  return { name: file.name, score: projectFromJson(text) };
}

export interface ImportResult {
  score: Score;
  warnings: string[];
  kind: "midi" | "musicxml" | "abc";
}

/** 智能导入：按扩展名分派到 MIDI / MusicXML / ABC */
export async function importFile(): Promise<ImportResult | null> {
  const file = await pickFile(".mid,.midi,.musicxml,.xml,.abc,.txt");
  if (!file) return null;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".mid") || lower.endsWith(".midi")) {
    if (!file.bytes) throw new MusicError("读不到 MIDI 内容");
    const r = fromMidiBytes(file.bytes);
    return { ...r, kind: "midi" };
  }
  if (lower.endsWith(".musicxml") || lower.endsWith(".xml")) {
    const text = file.text ?? (file.bytes ? bytesToText(file.bytes) : "");
    const r = fromMusicXml(text);
    return { ...r, kind: "musicxml" };
  }
  const text = file.text ?? (file.bytes ? bytesToText(file.bytes) : "");
  const r = parseAbc(text, file.name.replace(/\.[^.]+$/, ""));
  return { ...r, kind: "abc" };
}

/** 把一段文本（ABC / MusicXML）按内容猜格式导入，给「粘贴乐谱」用 */
export function importFromText(text: string, title?: string): ImportResult {
  const t = text.trim();
  if (!t) throw new MusicError("内容是空的");
  if (t.startsWith("<") || t.includes("<score-partwise")) {
    const r = fromMusicXml(t);
    return { ...r, kind: "musicxml" };
  }
  const r = parseAbc(t, title ?? "粘贴的乐谱");
  return { ...r, kind: "abc" };
}

export { bytesToBase64 };
