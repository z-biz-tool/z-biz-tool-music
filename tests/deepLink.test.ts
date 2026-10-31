/**
 * music 仓深链语义层的单测。
 *
 * 跑法：node --experimental-strip-types --test tests/deepLink.test.ts
 *
 * 语义层是纯函数，所以这里不碰 Tauri、不碰 store，只喂 Handoff 看结果。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMusicDeepLink } from "../src/_shared/deepLink.ts";
import type { Handoff } from "z-biz-tool-shared/protocol";

function handoff(action: string, params: Record<string, string> = {}): Handoff {
  return { product: "music", action, params };
}

test("open 带 view：切到该视图", () => {
  const out = resolveMusicDeepLink(handoff("open", { view: "jianpu" }));
  assert.equal(out.problem, null);
  assert.equal(out.view, "jianpu");
  assert.equal(out.shouldPlay, false);
});

test("view 是 open 的别名", () => {
  const out = resolveMusicDeepLink(handoff("view", { view: "mixer" }));
  assert.equal(out.problem, null);
  assert.equal(out.view, "mixer");
});

test("action 缺省按 open 处理", () => {
  const out = resolveMusicDeepLink(handoff("", { view: "roll" }));
  assert.equal(out.problem, null);
  assert.equal(out.view, "roll");
});

test("play 会要求播放；没给视图时默认五线谱", () => {
  const out = resolveMusicDeepLink(handoff("play"));
  assert.equal(out.problem, null);
  assert.equal(out.shouldPlay, true);
  assert.equal(out.view, "staff");
});

test("play 带视图：照给的切", () => {
  const out = resolveMusicDeepLink(handoff("play", { view: "lesson" }));
  assert.equal(out.view, "lesson");
  assert.equal(out.shouldPlay, true);
});

test("track 带 id：定位到该轨道", () => {
  const out = resolveMusicDeepLink(handoff("track", { track: "t-42" }));
  assert.equal(out.problem, null);
  assert.equal(out.trackId, "t-42");
});

test("name 是可读兜底（发深链的人只有轨道名）", () => {
  const out = resolveMusicDeepLink(handoff("track", { name: "钢琴" }));
  assert.equal(out.problem, null);
  assert.equal(out.trackName, "钢琴");
  assert.equal(out.trackId, null);
});

test("id 与 name 同时给时以 id 为准，name 一并保留", () => {
  const out = resolveMusicDeepLink(handoff("track", { track: "t-42", name: "钢琴" }));
  assert.equal(out.trackId, "t-42");
  assert.equal(out.trackName, "钢琴");
});

test("track 动作但没给任何轨道标识：接不住并说明原因", () => {
  const out = resolveMusicDeepLink(handoff("track"));
  assert.equal(out.trackId, null);
  assert.match(out.problem ?? "", /track|name/);
});

test("白名单外的视图名：接不住并说是哪个", () => {
  const out = resolveMusicDeepLink(handoff("open", { view: "3d" }));
  assert.equal(out.view, null);
  assert.match(out.problem ?? "", /3d/);
});

test("不认识的动作：接不住并说明是哪个动作", () => {
  const out = resolveMusicDeepLink(handoff("export", { view: "staff" }));
  assert.match(out.problem ?? "", /export/);
  assert.equal(out.view, null);
});

test("既没有 view 也没有轨道：接不住", () => {
  const out = resolveMusicDeepLink(handoff("open"));
  assert.ok(out.problem);
});

test("from 参数透传出来（用于提示与日志）", () => {
  const out = resolveMusicDeepLink(handoff("open", { view: "staff", from: "box" }));
  assert.equal(out.from, "box");
});

test("参数前后空格被裁掉（深链解析容易带上）", () => {
  const out = resolveMusicDeepLink(handoff("open", { view: "  jianpu  " }));
  assert.equal(out.view, "jianpu");
});

test("空字符串等同于没有该参数", () => {
  const out = resolveMusicDeepLink(handoff("open", { view: "   " }));
  assert.equal(out.view, null);
  assert.ok(out.problem);
});
