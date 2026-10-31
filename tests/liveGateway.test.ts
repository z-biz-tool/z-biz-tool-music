/**
 * 本地网关直连用例（node --test）。
 *
 * 分两层：
 * 1. `isPrivateEndpoint` —— 纯函数，始终跑。钉死「局域网地址也算私有」，
 *    因为 2026-10-31 之前这里只认 localhost/127.0.0.1，
 *    `http://192.168.31.249:8200/v1` 被判成「要 key」，用户只能填假密钥。
 * 2. 真实调用 —— **未设 ZBIZ_GW 时跳过**，默认测试不碰网络。
 *
 * 跑真实调用：
 * ```sh
 * ZBIZ_GW=http://192.168.31.249:8200/v1 ZBIZ_MODEL=zBiz-Text-35B \
 *   npm test --prefix z-biz-tool-music
 * ```
 */

import assert from "node:assert/strict";
import test from "node:test";

import { callChat, isPrivateEndpoint } from "../src/core/ai.ts";

const GW = process.env.ZBIZ_GW;
const MODEL = process.env.ZBIZ_MODEL ?? "zBiz-Text-35B";

test("局域网/回环地址判为私有，公网地址判为公开", () => {
  for (const url of [
    "http://127.0.0.1:8200/v1",
    "http://localhost:8200/v1",
    "http://192.168.31.249:8200/v1",
    "http://10.1.2.3/v1",
    "http://172.20.0.5:8000/v1",
    "http://[::1]:8200/v1",
    "http://zifangs-mac-mini.local:8200/v1",
    "http://192.168.31.249:8200/v1".replace("://", "://user:pw@"),
  ]) {
    assert.equal(isPrivateEndpoint(url), true, `${url} 应判为私有`);
  }
  for (const url of [
    "https://api.deepseek.com/v1",
    "https://api.minimax.chat/v1",
    "http://172.32.0.1/v1",
    "http://192.169.1.1/v1",
    "https://example.local.evil.com/v1",
  ]) {
    assert.equal(isPrivateEndpoint(url), false, `${url} 不该判为私有`);
  }
});

test("免密钥的本地网关能真的生成内容（需 ZBIZ_GW）", async (t) => {
  if (!GW) {
    t.skip("未设 ZBIZ_GW，跳过真实调用");
    return;
  }
  const out = await callChat(
    { baseUrl: GW, apiKey: "", model: MODEL, temperature: 0.3 },
    [{ role: "user", content: "用一句话介绍你自己，不超过30字。" }],
  );
  assert.ok(out.trim().length > 0, "返回为空");
  assert.ok(/[\u4e00-\u9fff]/.test(out), `应返回中文，实际：${out}`);
  console.log(`[music → ${GW}] ${out.trim()}`);
});
