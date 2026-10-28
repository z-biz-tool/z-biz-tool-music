/**
 * 走带条：播放 / 停止 / 定位 / 速度 / 节拍器 / 循环。
 *
 * 这里只有"按钮 → 回调"，不碰引擎内部：引擎实例在 App 里持，
 * 这样换视图、开面板都不会重建音频上下文。
 */

import { Button, InputNumber, Slider, Space, Switch, Tooltip } from "antd";
import {
  CaretRightOutlined,
  PauseOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
} from "@ant-design/icons";
import { beatToBarBeat, beatsPerMeasure, measureCount, scoreEnd, type Score } from "../core/model.ts";

export interface TransportProps {
  score: Score;
  beat: number;
  playing: boolean;
  metronome: boolean;
  loop: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (beat: number) => void;
  onTempo: (bpm: number) => void;
  onMetronome: (on: boolean) => void;
  onLoop: (on: boolean) => void;
}

export default function Transport({
  score,
  beat,
  playing,
  metronome,
  loop,
  onPlayPause,
  onStop,
  onSeek,
  onTempo,
  onMetronome,
  onLoop,
}: TransportProps) {
  const totalBeats = Math.max(beatsPerMeasure(score), scoreEnd(score));
  const pos = beatToBarBeat(score, Math.min(beat, totalBeats - 0.001));
  const empty = score.tracks.every((t) => t.notes.every((n) => n.pitch < 0));

  const jumpMeasure = (dir: -1 | 1) => {
    const bpm = beatsPerMeasure(score);
    const maxBar = measureCount(score) - 1;
    const bar = Math.floor(beat / bpm) + dir;
    onSeek(Math.max(0, Math.min(maxBar, bar)) * bpm);
  };

  return (
    <div className="mu-transport">
      <Space size={4}>
        <Tooltip title="上一小节">
          <Button type="text" icon={<StepBackwardOutlined />} onClick={() => jumpMeasure(-1)} aria-label="上一小节" />
        </Tooltip>
        <Tooltip title={empty ? "当前工程没有音符，先加几个音再播放" : playing ? "暂停（空格）" : "播放（空格）"}>
          <Button
            type="primary"
            shape="circle"
            disabled={empty}
            icon={playing ? <PauseOutlined /> : <CaretRightOutlined />}
            onClick={onPlayPause}
            aria-label={playing ? "暂停" : "播放"}
          />
        </Tooltip>
        <Tooltip title="停止并回到开头">
          <Button type="text" onClick={onStop} disabled={empty} aria-label="停止">
            ⏹
          </Button>
        </Tooltip>
        <Tooltip title="下一小节">
          <Button type="text" icon={<StepForwardOutlined />} onClick={() => jumpMeasure(1)} aria-label="下一小节" />
        </Tooltip>
      </Space>

      <div className="mu-pos">
        {pos.bar}.{pos.beat.toFixed(2)}
        <small>
          / {measureCount(score)} 小节
        </small>
      </div>

      <Slider
        style={{ flex: 1, minWidth: 160, margin: 0 }}
        min={0}
        max={Math.round(totalBeats * 100) / 100}
        step={0.25}
        value={Math.min(beat, totalBeats)}
        onChange={onSeek}
        tooltip={{ formatter: (v) => `第 ${(beatToBarBeat(score, v ?? 0).bar)} 小节` }}
        aria-label="播放位置"
      />

      <Space size={6}>
        <span style={{ fontSize: 12, color: "var(--mu-muted)" }}>速度</span>
        <InputNumber
          size="small"
          style={{ width: 84 }}
          min={20}
          max={300}
          value={score.tempo}
          onChange={(v) => v && onTempo(v)}
          addonAfter="BPM"
          aria-label="速度"
        />
      </Space>

      <Tooltip title="每拍一下木鱼声，跟节拍用">
        <Space size={4}>
          <Switch size="small" checked={metronome} onChange={onMetronome} aria-label="节拍器" />
          <span style={{ fontSize: 12, color: "var(--mu-muted)" }}>节拍器</span>
        </Space>
      </Tooltip>

      <Tooltip title="整曲循环">
        <Space size={4}>
          <Switch size="small" checked={loop} onChange={onLoop} aria-label="循环" />
          <span style={{ fontSize: 12, color: "var(--mu-muted)" }}>循环</span>
        </Space>
      </Tooltip>
    </div>
  );
}
