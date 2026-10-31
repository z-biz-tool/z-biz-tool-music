/**
 * zbiz:// 深链接的 **music 语义层**。
 *
 * ## 分工
 *
 * | 层 | 在哪 | 管什么 |
 * |----|----|--------|
 * | 协议 | `z-biz-tool-shared/protocol/deeplink` | 字节级编解码（金标 = Rust `cap-hub`） |
 * | 机制 | `z-biz-tool-shared/protocol/deeplinkReceiver` | 冷启动补取、事件监听、不静默吞掉 |
 * | **语义** | **本文件** | **收到深链后 music 该做什么** |
 *
 * ## music 支持的动作
 *
 * | action | 含义 | 参数 |
 * |--------|------|------|
 * | `open` | 切到某个视图 | `view`（staff/jianpu/roll/mixer/lesson），可选 `track` |
 * | `view` | 同 `open`（更直白的别名） | 同上 |
 * | `play` | 切到某视图并开始播放 | 同上 |
 * | `track` | 定位到某条轨道 | `track`（轨道 id）或 `name`（轨道名，兜底） |
 *
 * ## 为什么 `track` id 是可靠的
 *
 * `Track.id` 由 `uid("t")` 生成，**看起来**像进程内随机值，但：
 * - `serializeScore` 把 `id` 原样写进 `.zmusic`；
 * - `parseScore` 优先读 `t.id`，只有缺失时才现场 `uid("t")`。
 *
 * 也就是说 **id 随工程文件持久化** —— 只要对方拿的是同一个工程文件，
 * 轨道 id 就是稳定的。所以深链可以直接用它定位轨道。
 *
 * 但用户看得见、说得出的仍然是轨道**名**（"钢琴那条"），所以 `name` 是兜底。
 *
 * ## 视图名的白名单
 *
 * `view` 必须是 `ViewMode` 里的五个值之一。深链是外部输入，
 * 直接把它塞进 `setView` 会让 store 落到一个不存在的视图上，
 * 界面渲染成空白 —— 所以这里做白名单校验，接不住就明确说接不住。
 */

import type { Handoff } from "z-biz-tool-shared/protocol";

/**
 * Rust 侧 `cap_hub::Handoff` 的镜像。
 *
 * 名字叫 `HandoffItem` 是为了在本仓内部读起来更顺（本仓此前一直用这个名字），
 * 实质就是共享层的 `Handoff`。
 */
export type { Handoff as HandoffItem } from "z-biz-tool-shared/protocol";

/** music 的视图名。与 `state.ts` 的 `ViewMode` 一致（这里独立列出，避免语义层 import store）。 */
export const MUSIC_VIEWS = ["staff", "jianpu", "roll", "mixer", "lesson"] as const;

/** 视图名的类型。 */
export type MusicView = (typeof MUSIC_VIEWS)[number];

/**
 * music 的深链结果。
 *
 * `view` 非 null 表示要切视图；
 * `trackId` / `trackName` 非 null 表示要定位某条轨道；
 * `shouldPlay` 为 true 表示落地后要开始播放；
 * `problem` 非 null 表示接不住 —— 前端必须给可见提示（不静默吞掉）。
 */
export interface MusicDeepLinkOutcome {
  /** 要切到的视图（null = 不切）。 */
  view: MusicView | null;
  /** 要定位的轨道 id（深链直接给的）。 */
  trackId: string | null;
  /** 要定位的轨道名（深链给的兜底标识）。 */
  trackName: string | null;
  /** 落地后是否要开始播放。 */
  shouldPlay: boolean;
  /** 发送方（from），仅用于提示与日志 */
  from: string | null;
  /** 无法适配时的原因 */
  problem: string | null;
}

function isMusicView(v: string): v is MusicView {
  return (MUSIC_VIEWS as readonly string[]).includes(v);
}

/**
 * 把一条深链翻译成 music 内的动作。
 *
 * 纯函数 —— 不碰 store、不碰 Tauri，所以可以直接单测。
 *
 * @param item 深链
 */
export function resolveMusicDeepLink(item: Handoff): MusicDeepLinkOutcome {
  const outcome: MusicDeepLinkOutcome = {
    view: null,
    trackId: null,
    trackName: null,
    shouldPlay: false,
    from: item.params.from ?? null,
    problem: null,
  };

  const action = item.action.trim() || "open";

  // 动作先校验：动作不认识的话，后面的参数再合法也没意义，
  // 而且不能让已解析的字段残留在 outcome 里（接不住就是接不住，别半落地）。
  const known =
    action === "open" || action === "view" || action === "play" || action === "track";
  if (!known) {
    outcome.problem = `不认识的动作 ${action}`;
    return outcome;
  }

  const rawView = item.params.view?.trim() ?? "";
  const rawTrack = item.params.track?.trim() ?? "";
  const rawName = item.params.name?.trim() ?? "";

  // 视图白名单：白名单外的视图名是「深链说错了」，不是「本应用接不住」。
  if (rawView) {
    if (!isMusicView(rawView)) {
      outcome.problem = `不认识的音乐视图 ${rawView}`;
      return outcome;
    }
    outcome.view = rawView;
  }

  if (rawTrack) {
    outcome.trackId = rawTrack;
    if (rawName) outcome.trackName = rawName;
  } else if (rawName) {
    outcome.trackName = rawName;
  }

  if (action === "play") {
    outcome.shouldPlay = true;
    // play 不给视图时给一个默认：混音台之外的任何视图都能播，
    // 这里默认用五线谱 —— 它是主视图，用户看到的第一眼。
    if (!outcome.view) outcome.view = "staff";
  }

  // track 动作的语义是「定位轨道」，视图不是重点。
  // 但如果深链没给任何轨道标识，接不住。
  if (action === "track" && !outcome.trackId && !outcome.trackName) {
    outcome.problem = "深链里没有 track（轨道 id）或 name（轨道名）参数";
    return outcome;
  }

  // 至少要有一件事可做，否则这条深链等于没带信息。
  if (!outcome.view && !outcome.trackId && !outcome.trackName) {
    outcome.problem = "深链里既没有 view，也没有 track/name 参数";
    return outcome;
  }

  return outcome;
}
