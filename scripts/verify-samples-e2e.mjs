/**
 * 采样音源的端到端验证（跑在真实 Chromium 里）。
 *
 * 要回答的问题只有一个：**用户真正听到的是采样还是合成**。
 * 单元测试验证不了这个 —— 单测里没有 AudioContext、没有解码、没有总线。
 *
 * 做法：
 *   1. 开一个无声的 OfflineAudioContext，把采样 buffer 灌进去，量它的频谱重心。
 *   2. 同一条件下量合成音色的频谱重心。
 *   3. 真实录音的频谱重心必然与合成不同 —— 不同就说明采样真的参与了。
 *
 * 判据不写死绝对数值，而是比较"两者是否显著不同"，避免不同机器上音频栈
 * 差异导致的假阴性。
 */

import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:5200";

const browser = await chromium.launch({
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
  ],
});
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(BASE, { waitUntil: "networkidle" });

const result = await page.evaluate(async () => {
  // 浏览器里不能用裸模块名（浏览器不做 node resolution），
  // 走 Vite 的 /@id/ 前缀让它解析到项目依赖。
  const mod = await import("/src/audio/samples.ts");
  const Tone = await import("/@id/tone");

  const out = {
    loaded: null,
    bufferCount: 0,
    sampleCentroid: null,
    synthCentroid: null,
    samplePeak: null,
    noteCount: null,
  };

  // 1) 预加载钢琴采样
  await mod.preload("piano");
  const buffers = mod.readyBuffers("piano");
  out.loaded = !!buffers;
  if (!buffers) return out;

  const keys = Object.keys(buffers);
  out.bufferCount = keys.length;
  out.noteCount = mod.SAMPLE_SETS.piano.notes.length;

  // 2) 基频分析：直接对 Float32Array 做自相关。
  //    不用 OfflineAudioContext —— 它的 AudioBuffer 与实时上下文的不可互换，
  //    跨上下文赋值会直接抛 "Failed to convert value to 'AudioBuffer'"。
  const detectF0 = (d) => {
    // 取能量最集中的 8192 点窗口（起音后、衰减中段）
    const N = 8192;
    if (d.length < N) return 0;
    const win = Math.floor(d.length / 3);
    let bestOff = 0, bestE = -1;
    for (let off = 0; off + N <= d.length; off += N / 2) {
      let e = 0;
      for (let i = off; i < off + N; i += 4) e += d[i] * d[i];
      if (e > bestE) { bestE = e; bestOff = off; }
    }
    const seg = d.subarray(bestOff, bestOff + N);
    let best = 0, bestLag = 0;
    for (let lag = 20; lag < 900; lag++) {
      let s = 0;
      for (let i = 0; i < N - lag; i += 2) s += seg[i] * seg[i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    return bestLag > 0 ? 44100 / bestLag : 0;
  };

  // 采样 C4：直接读 ToneAudioBuffer 里的浮点数据
  const sampleBuf = buffers["C4"];
  if (sampleBuf) {
    const raw = sampleBuf.get();
    const d = raw.getChannelData(0);
    out.sampleCentroid = detectF0(d);
    let pk = 0;
    for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
    out.samplePeak = pk;
    out.sampleSeconds = d.length / raw.sampleRate;
  }

  // 合成 C4（同一引擎的 MonoSynth 预设），用 Tone.Offline 渲染
  const off = await Tone.Offline(() => {
    const s = new Tone.MonoSynth({
      oscillator: { type: "triangle8" },
      envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 1 },
    }).toDestination();
    s.triggerAttackRelease("C4", 1.5, 0);
  }, 2, 2, 44100);
  out.synthCentroid = detectF0(off.getChannelData(0));

  return out;
});

await browser.close();

const ok = [];
const bad = [];
const check = (name, pass, detail) => (pass ? ok : bad).push(`${name} — ${detail}`);

check("钢琴采样已加载", result.loaded, `readyBuffers=${result.loaded}`);
check(
  "采样数量完整",
  result.bufferCount === result.noteCount,
  `${result.bufferCount}/${result.noteCount}`,
);
check(
  "采样基频 ≈ C4 (261.6Hz)",
  result.sampleCentroid && Math.abs(result.sampleCentroid - 261.63) < 30,
  `实测 ${result.sampleCentroid?.toFixed(1)} Hz`,
);
check(
  "采样基频明显区别于合成音色",
  result.sampleCentroid && result.synthCentroid &&
    Math.abs(result.sampleCentroid - result.synthCentroid) > 5,
  `采样 ${result.sampleCentroid?.toFixed(1)}Hz vs 合成 ${result.synthCentroid?.toFixed(1)}Hz`,
);
check("采样峰值 > 0（有声）", result.samplePeak > 0.01, `峰值 ${result.samplePeak?.toFixed(3)}`);

console.log("\n=== 采样端到端验证 ===");
for (const l of ok) console.log("  ✓ " + l);
for (const l of bad) console.log("  ✗ " + l);
if (consoleErrors.length) {
  console.log("\n控制台错误:");
  for (const e of consoleErrors.slice(0, 5)) console.log("  ! " + e);
}

const passed = bad.length === 0;
console.log(`\n${passed ? "✓ 全部通过" : "✗ 存在失败"}：${ok.length} 通过 / ${bad.length} 失败`);
process.exit(passed ? 0 : 1);
