/**
 * 右侧三块面板：AI 作曲 / 乐理工具 / 属性检查。
 *
 * 面板只负责「收集意图 + 展示结果」，真正的计算都在 core/。
 * 这里有两条与交互契约直接相关的规矩：
 *   - 生成过程必须可取消（AbortController），取消后不写回乐谱；
 *   - 没配 Key 时不能说"AI 生成失败"，而是明确指向「本地算法生成」，并说明两者的区别。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Collapse,
  Divider,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Select,
  Slider,
  Space,
  Tag,
  Tooltip,
} from "antd";
import {
  BulbOutlined,
  CloudOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { scoreFacts, useStore } from "../state.ts";
import {
  PROVIDER_PRESETS,
  abcBarCheck,
  buildComposeMessages,
  buildExtendMessages,
  buildPolishMessages,
  buildVaryMessages,
  callChat,
  generateFromMessages,
} from "../core/ai.ts";
import { STYLES, chordTimeline, compose, styleSpec, vary, type StyleId } from "../core/compose.ts";
import { beatsPerMeasure, measureCount, pitchName, type KeySig } from "../core/model.ts";
import { keyLabel, scalePitchClasses } from "../core/theory.ts";

const KEYS: { label: string; value: string }[] = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
].flatMap((n, i) => [
  { label: `${n} 大调`, value: `${i}:major` },
  { label: `${n} 小调`, value: `${i}:minor` },
]);

function parseKey(v: string): KeySig {
  const [t, m] = v.split(":");
  return { tonic: Number(t), mode: m === "minor" ? "minor" : "major" };
}

/* ================================================================ AI 面板 */

type AiMode = "compose" | "extend" | "vary" | "polish";

export function AiPanel() {
  const score = useStore((s) => s.score);
  const provider = useStore((s) => s.provider);
  const setProvider = useStore((s) => s.setProvider);
  const loadScore = useStore((s) => s.loadScore);
  const say = useStore((s) => s.say);

  const [mode, setMode] = useState<AiMode>("compose");
  const [brief, setBrief] = useState("写一首温柔的钢琴小品，像初雪落在窗台，8 小节");
  const [style, setStyle] = useState<StyleId>("ballad");
  const [keySel, setKeySel] = useState("0:major");
  const [bars, setBars] = useState(8);
  const [tempo, setTempo] = useState(72);
  const [voices, setVoices] = useState(3);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const hasKey = provider.apiKey.trim().length > 0 || /localhost|127\.0\.0\.1/.test(provider.baseUrl);

  const pushLog = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 12));

  useEffect(() => {
    setTempo(styleSpec(style).tempo[0] + 10);
  }, [style]);

  const runAi = async () => {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    pushLog(`开始请求 ${provider.model} …`);
    try {
      const k = mode === "compose" ? parseKey(keySel) : score.key;
      const messages =
        mode === "compose"
          ? buildComposeMessages({ text: brief, key: k, bars, tempo, style, tracks: voices })
          : mode === "extend"
            ? buildExtendMessages(score, instruction, Math.max(2, bars))
            : mode === "vary"
              ? buildVaryMessages(score, instruction)
              : buildPolishMessages(score, instruction);
      const res = await generateFromMessages(provider, messages, controller.signal, score.title);
      const warns = abcBarCheck(res.score);
      loadScore(
        res.score,
        `AI 生成完成：${measureCount(res.score)} 小节 / ${scoreFacts(res.score).notes} 个音${
          res.retried ? "（自动修正一次）" : ""
        }`,
        res.score.title,
      );
      pushLog(`成功：${res.model}${res.retried ? "（第二次输出才通过校验）" : ""}`);
      if (warns.length > 0) warns.forEach((w) => pushLog(`提示：${w}`));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog(`失败：${msg}`);
      say(msg, "err");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const runLocal = () => {
    const k = mode === "compose" ? parseKey(keySel) : score.key;
    const next =
      mode === "vary" || mode === "polish"
        ? vary(score, Math.floor(Math.random() * 1e9))
        : compose({
            brief,
            style,
            key: k,
            bars: mode === "compose" ? bars : Math.max(2, bars),
            tempo,
            seed: Math.floor(Math.random() * 1e9),
            withBand: true,
            title: undefined,
          });
    loadScore(next, `已用本地算法生成（未调用 AI）：${measureCount(next)} 小节`, next.title);
    pushLog("本地算法生成完成（不需要 API Key）");
  };

  const testConnection = async () => {
    setBusy(true);
    pushLog("测试连接…");
    try {
      const reply = await callChat(provider, [
        { role: "system", content: "你是一个测试助手，只回答两个字。" },
        { role: "user", content: "请回答：可以" },
      ]);
      pushLog(`连接正常，模型回复：${reply.slice(0, 40)}`);
      say("AI 服务连接正常", "ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog(`连接失败：${msg}`);
      say(msg, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mu-panel-body">
      <Segmented
        block
        size="small"
        value={mode}
        onChange={(v) => setMode(v as AiMode)}
        options={[
          { label: "成曲", value: "compose" },
          { label: "续写", value: "extend" },
          { label: "变奏", value: "vary" },
          { label: "润色", value: "polish" },
        ]}
      />

      {mode === "compose" ? (
        <div style={{ marginTop: 12 }}>
          <div className="mu-field">
            <label htmlFor="ai-brief">想要什么曲子（一句话就行）</label>
            <Input.TextArea
              id="ai-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              placeholder="例：16 小节，宫崎骏那种温柔，钢琴加弦乐，最后一句往上扬"
            />
          </div>
          <Space.Compact block style={{ marginBottom: 10 }}>
            <Select
              style={{ width: "55%" }}
              value={keySel}
              onChange={setKeySel}
              options={KEYS}
              showSearch
              optionFilterProp="label"
            />
            <InputNumber
              style={{ width: "45%" }}
              min={2}
              max={64}
              value={bars}
              onChange={(v) => setBars(v ?? 8)}
              addonAfter="小节"
              aria-label="小节数"
            />
          </Space.Compact>
          <div className="mu-field">
            <label htmlFor="ai-style">风格（影响和声进行与织体）</label>
            <Select
              id="ai-style"
              style={{ width: "100%" }}
              value={style}
              onChange={(v) => setStyle(v as StyleId)}
              options={STYLES.map((s) => ({ value: s.id, label: `${s.label} · ${s.hint}` }))}
            />
          </div>
          <Space style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--mu-muted)" }}>速度</span>
            <InputNumber min={20} max={300} value={tempo} onChange={(v) => setTempo(v ?? 80)} style={{ width: 78 }} />
            <span style={{ fontSize: 12, color: "var(--mu-muted)" }}>声部</span>
            <InputNumber min={2} max={4} value={voices} onChange={(v) => setVoices(v ?? 3)} style={{ width: 60 }} />
          </Space>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="mu-field">
            <label htmlFor="ai-inst">要求（可留空）</label>
            <Input.TextArea
              id="ai-inst"
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={
                mode === "extend"
                  ? "例：往明亮的方向发展，加一个上行模进"
                  : mode === "vary"
                    ? "例：改成小调，加切分节奏"
                    : "例：低音太单调，改成走动低音"
              }
            />
          </div>
          {mode === "extend" && (
            <Space style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: "var(--mu-muted)" }}>追加小节</span>
              <InputNumber min={2} max={32} value={bars} onChange={(v) => setBars(v ?? 8)} style={{ width: 70 }} />
            </Space>
          )}
          <div className="mu-hint" style={{ marginBottom: 10 }}>
            续写/变奏/润色都会把当前乐谱转成 ABC 发给模型；返回后整份替换当前工程（可撤销）。
          </div>
        </div>
      )}

      <Space style={{ width: "100%" }} size={8}>
        <Tooltip title={hasKey ? "把要求发给大模型，等它写完" : "先在下方「AI 服务」里填 API Key"}>
          <Button
            type="primary"
            icon={<CloudOutlined />}
            loading={busy}
            disabled={!hasKey}
            onClick={() => void runAi()}
          >
            AI 生成
          </Button>
        </Tooltip>
        {busy && (
          <Button
            onClick={() => {
              abortRef.current?.abort();
              pushLog("已请求取消");
            }}
          >
            取消
          </Button>
        )}
        <Button icon={<ThunderboltOutlined />} onClick={runLocal} disabled={busy}>
          本地生成
        </Button>
      </Space>

      {!hasKey && (
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          icon={<BulbOutlined />}
          title="现在可以用「本地生成」"
          description="本地算法作曲不需要任何 Key，会按所选风格、调性、小节数生成旋律 + 伴奏 + 低音；配置 AI 服务后可以用大模型按你的文字要求写。"
        />
      )}

      <Collapse
        style={{ marginTop: 12 }}
        size="small"
        items={[
          {
            key: "provider",
            label: (
              <Space size={6}>
                <RobotOutlined />
                <span>AI 服务</span>
                <Tag color={hasKey ? "green" : "default"}>{hasKey ? provider.model : "未配置"}</Tag>
              </Space>
            ),
            children: (
              <Space orientation="vertical" style={{ width: "100%" }} size={8}>
                <Select
                  style={{ width: "100%" }}
                  placeholder="选一个预设"
                  options={PROVIDER_PRESETS.map((p) => ({ value: p.id, label: `${p.label} · ${p.hint}` }))}
                  onChange={(id) => {
                    const p = PROVIDER_PRESETS.find((x) => x.id === id);
                    if (p) setProvider({ baseUrl: p.baseUrl, model: p.model });
                  }}
                />
                <Input
                  addonBefore="地址"
                  value={provider.baseUrl}
                  onChange={(e) => setProvider({ baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                />
                <Input
                  addonBefore="模型"
                  value={provider.model}
                  onChange={(e) => setProvider({ model: e.target.value })}
                  placeholder="deepseek-chat"
                />
                <Input.Password
                  addonBefore="Key"
                  value={provider.apiKey}
                  onChange={(e) => setProvider({ apiKey: e.target.value })}
                  placeholder="sk-…（只存在本机，不会写进工程文件）"
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--mu-muted)" }}>温度</span>
                  <Slider
                    style={{ flex: 1 }}
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={provider.temperature}
                    onChange={(v) => setProvider({ temperature: v })}
                  />
                  <span style={{ fontSize: 12, width: 30 }}>{provider.temperature.toFixed(2)}</span>
                </div>
                <Button size="small" onClick={() => void testConnection()} loading={busy}>
                  测试连接
                </Button>
                <div className="mu-hint">
                  Key 只保存在本机 localStorage，不会随工程导出，也不会写进日志或仓库。请求只包含乐谱 ABC 与文字要求。
                </div>
              </Space>
            ),
          },
        ]}
      />

      {log.length > 0 && (
        <>
          <Divider style={{ margin: "12px 0 8px" }} />
          <div className="mu-hint" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
            {log.map((l, i) => (
              <div key={i} style={{ opacity: i === 0 ? 1 : 0.6 }}>
                {l}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================== 乐理工具 */

export function TheoryPanel() {
  const score = useStore((s) => s.score);
  const store = useStore();
  const track = score.tracks.find((t) => t.id === store.trackId) ?? score.tracks[0];
  const facts = scoreFacts(score);
  const chords = useMemo(() => chordTimeline(score), [score]);
  const scale = scalePitchClasses(score.key);

  return (
    <div className="mu-panel-body">
      <div className="mu-field">
        <label htmlFor="th-key">调号</label>
        <Select
          id="th-key"
          style={{ width: "100%" }}
          value={`${score.key.tonic}:${score.key.mode}`}
          onChange={(v) => store.setKey(parseKey(v))}
          options={KEYS}
        />
      </div>
      <Space style={{ marginBottom: 10 }}>
        <div>
          <div className="mu-hint">拍号</div>
          <Select
            style={{ width: 92 }}
            value={`${score.time[0]}/${score.time[1]}`}
            onChange={(v) => {
              const [a, b] = v.split("/").map(Number);
              store.setTime([a, b]);
            }}
            options={["4/4", "3/4", "2/4", "6/8", "12/8"].map((t) => ({ value: t, label: t }))}
          />
        </div>
        <div>
          <div className="mu-hint">速度</div>
          <InputNumber
            style={{ width: 92 }}
            min={20}
            max={300}
            value={score.tempo}
            onChange={(v) => v && store.setTempo(v)}
            addonAfter="BPM"
          />
        </div>
      </Space>

      <Divider style={{ margin: "10px 0" }} />

      <div className="mu-hint" style={{ marginBottom: 6 }}>
        移调（有选中音符时只移选中的，否则整曲 + 调号一起移）
      </div>
      <Space wrap>
        {[-12, -5, -2, -1, 1, 2, 5, 12].map((s) => (
          <Button key={s} size="small" onClick={() => store.transpose(s)}>
            {s > 0 ? `+${s}` : s}
          </Button>
        ))}
      </Space>

      <div className="mu-hint" style={{ margin: "10px 0 6px" }}>
        量化（把音符起点/时值对齐到网格）
      </div>
      <Space wrap>
        {[
          { label: "1/4", v: 1 },
          { label: "1/8", v: 0.5 },
          { label: "1/16", v: 0.25 },
        ].map((g) => (
          <Button key={g.label} size="small" onClick={() => store.quantize(g.v)}>
            {g.label}
          </Button>
        ))}
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => store.clearTrack()}
          disabled={!track}
        >
          清空当前轨
        </Button>
      </Space>

      <Divider style={{ margin: "12px 0" }} />

      <div className="mu-field">
        <label>本曲和弦（按小节识别，取强拍）</label>
        {chords.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有足够的音可以识别和弦" />
        ) : (
          <div className="mu-chips">
            {chords.map((c) => (
              <Tag key={c.bar} color="purple">
                {c.bar}: {c.label}
              </Tag>
            ))}
          </div>
        )}
      </div>

      <Divider style={{ margin: "12px 0" }} />
      <div className="mu-hint">
        工程概况：{facts.bars} 小节 × {beatsPerMeasure(score)} 拍 · {facts.notes} 个音 · 时长约 {facts.duration}
        <br />
        调内音级：{scale.map((pc) => ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pc]).join(" ")}
        <br />
        当前调：{keyLabel(score.key)}
      </div>
    </div>
  );
}

/* =============================================================== 属性检查 */

export function InspectorPanel() {
  const score = useStore((s) => s.score);
  const selected = useStore((s) => s.selected);
  const trackId = useStore((s) => s.trackId);
  const updateNote = useStore((s) => s.updateNote);
  const deleteSelected = useStore((s) => s.deleteSelected);
  const setTitle = useStore((s) => s.setTitle);

  const track = score.tracks.find((t) => t.id === trackId);
  const notes = track ? track.notes.filter((n) => selected.includes(n.id)) : [];
  const one = notes.length === 1 ? notes[0] : null;

  return (
    <div className="mu-panel-body">
      <div className="mu-field">
        <label htmlFor="insp-title">工程名</label>
        <Input
          id="insp-title"
          value={score.title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="给这首曲子起个名字"
        />
      </div>
      <div className="mu-hint" style={{ marginBottom: 10 }}>
        {score.composer ? `作者：${score.composer}` : "作者：未填写"}
        {score.meta?.brief ? (
          <>
            <br />
            来路：{score.meta.brief}
          </>
        ) : null}
        {score.meta?.model ? (
          <>
            <br />
            模型：{score.meta.model}
          </>
        ) : null}
      </div>

      <Divider style={{ margin: "10px 0" }} />

      {notes.length === 0 && (
        <div className="mu-empty">
          没有选中音符。
          <br />
          在卷帘里点一个音符可以看它的音高、位置和力度。
        </div>
      )}

      {notes.length > 1 && (
        <Alert
          type="info"
          showIcon
          title={`已选中 ${notes.length} 个音符`}
          description="移调、删除会对整组生效；单音参数请在选中单个音符后修改。"
          action={
            <Button size="small" danger onClick={deleteSelected}>
              删除
            </Button>
          }
        />
      )}

      {one && (
        <Space orientation="vertical" style={{ width: "100%" }} size={10}>
          <div>
            <div className="mu-hint">音高</div>
            <Space>
              <Tag color="blue" style={{ fontSize: 14 }}>
                {pitchName(one.pitch)}
              </Tag>
              <InputNumber
                min={0}
                max={127}
                value={one.pitch}
                onChange={(v) => v !== null && updateNote(trackId, one.id, { pitch: v })}
                aria-label="音高 MIDI 号"
              />
            </Space>
          </div>
          <div>
            <div className="mu-hint">起点（拍）</div>
            <InputNumber
              min={0}
              step={0.25}
              value={one.start}
              onChange={(v) => v !== null && updateNote(trackId, one.id, { start: v })}
              aria-label="起点"
            />
          </div>
          <div>
            <div className="mu-hint">时值（拍）</div>
            <InputNumber
              min={0.0625}
              step={0.25}
              value={one.dur}
              onChange={(v) => v !== null && updateNote(trackId, one.id, { dur: v })}
              aria-label="时值"
            />
          </div>
          <div>
            <div className="mu-hint">力度 {one.vel}</div>
            <Slider
              min={1}
              max={127}
              value={one.vel}
              onChange={(v) => updateNote(trackId, one.id, { vel: v })}
            />
          </div>
          <Space>
            <Tooltip title="与下一个同音高的音连线，播放时不重触发">
              <Button size="small" onClick={() => updateNote(trackId, one.id, { tie: !one.tie })}>
                {one.tie ? "取消连音线" : "加连音线"}
              </Button>
            </Tooltip>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={deleteSelected}>
              删除音符
            </Button>
          </Space>
        </Space>
      )}

      <Divider style={{ margin: "12px 0" }} />
      <div className="mu-hint">
        <ExperimentOutlined /> 快捷键：空格 播放/暂停 · ←/→ 移动播放头一小节 · Delete 删除选中 · Ctrl/⌘+Z 撤销 ·
        Ctrl/⌘+S 保存工程
      </div>
    </div>
  );
}
