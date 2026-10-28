/**
 * MuseLab 外壳：顶栏（工程/导入导出/视图/主题）、左轨道列表、中视图、右面板、底部走带。
 *
 * 这一层只做三件事：把 store 接到各视图、把引擎接到走带、把文件对话框接到导出。
 * 任何乐谱计算都不在这里——它应该出现在 core/ 里并带测试。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntdApp,
  Button,
  ConfigProvider,
  Divider,
  Dropdown,
  Input,
  Modal,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  message as antdMessage,
  theme as antdTheme,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  BarsOutlined,
  CopyOutlined,
  DownloadOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  MoonOutlined,
  NumberOutlined,
  SaveOutlined,
  SettingOutlined,
  SlidersOutlined,
  SoundOutlined,
  SunOutlined,
  RobotOutlined,
  ReadOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { toAbc } from "./core/abc.ts";
import { beatsPerMeasure, measureCount, scoreEnd, serializeScore, type InstrumentId } from "./core/model.ts";
import { useStore, type ViewMode } from "./state.ts";
import { JianpuView, MixerView, PianoRoll, StaffView, TrackList } from "./ui/views.tsx";
import { AiPanel, InspectorPanel, TheoryPanel } from "./ui/panels.tsx";
import Transport from "./ui/Transport.tsx";
import {
  EXPORT_META,
  exportScore,
  importFile,
  importFromText,
  openProjectFile,
  saveText,
  type ExportKind,
} from "./ui/exporters.ts";
import type { PlaybackEngine } from "./audio/engine.ts";

const VIEWS: { value: ViewMode; label: string; icon: React.ReactNode }[] = [
  { value: "staff", label: "五线谱", icon: <FileTextOutlined /> },
  { value: "jianpu", label: "简谱", icon: <NumberOutlined /> },
  { value: "roll", label: "卷帘", icon: <BarsOutlined /> },
  { value: "mixer", label: "混音", icon: <SlidersOutlined /> },
];

/** 结构指纹：只有它变了才重建音色节点；音量/声像变化不算 */
function structureSig(score: ReturnType<typeof useStore.getState>["score"]): string {
  return [
    score.tempo,
    score.time.join("/"),
    score.tracks
      .map(
        (t) =>
          `${t.id}#${t.notes.length}#${t.mute ? 1 : 0}${t.solo ? 1 : 0}#${t.notes.reduce(
            (a, n) => a + n.pitch + n.start * 7 + n.dur * 13,
            0,
          )}`,
      )
      .join("|"),
  ].join("~");
}

export default function App() {
  const score = useStore((s) => s.score);
  const view = useStore((s) => s.view);
  const trackId = useStore((s) => s.trackId);
  const selected = useStore((s) => s.selected);
  const beat = useStore((s) => s.beat);
  const playing = useStore((s) => s.playing);
  const settings = useStore((s) => s.settings);
  const hint = useStore((s) => s.hint);
  const dirty = useStore((s) => s.dirty);
  const store = useStore();

  const engineRef = useRef<PlaybackEngine | null>(null);
  const sigRef = useRef<string>("");
  const [busyExport, setBusyExport] = useState<ExportKind | null>(null);
  // 窄窗口默认收起右面板：900px 宽时左右两栏会把谱面挤到不能看
  const [rightOpen, setRightOpen] = useState(() => (typeof window === "undefined" ? true : window.innerWidth > 1180));
  const [pendingNew, setPendingNew] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const trackIndex = Math.max(
    0,
    score.tracks.findIndex((t) => t.id === trackId),
  );

  const ensureEngine = useCallback(async (): Promise<PlaybackEngine> => {
    if (!engineRef.current) {
      const { PlaybackEngine } = await import("./audio/engine.ts");
      const eng = new PlaybackEngine();
      eng.onTick = (st) => {
        useStore.setState({ playing: st.playing, beat: st.beat });
      };
      engineRef.current = eng;
    }
    return engineRef.current;
  }, []);

  /* 结构变化 → 重建；只动混音 → 只同步推子 */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const sig = structureSig(score);
    if (sig === sigRef.current) {
      eng.syncMix(score);
      return;
    }
    const wasPlaying = useStore.getState().playing;
    const at = useStore.getState().beat;
    eng.load(score);
    sigRef.current = sig;
    if (wasPlaying) {
      eng.seek(at);
      void eng.play();
    }
  }, [score]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.setMetronome(settings.metronome);
  }, [settings.metronome]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const total = Math.max(beatsPerMeasure(score), scoreEnd(score));
    if (settings.loop) eng.setLoop(0, total);
    else eng.setLoop(0, null);
  }, [settings.loop, score]);

  /* 轻量回执 4 秒后自动消失 */
  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => useStore.getState().clearHint(), 4200);
    return () => window.clearTimeout(t);
  }, [hint]);

  const playPause = useCallback(async () => {
    try {
      const eng = await ensureEngine();
      const sig = structureSig(useStore.getState().score);
      if (!eng.isLoaded || sig !== sigRef.current) {
        eng.load(useStore.getState().score);
        sigRef.current = sig;
      }
      const st = useStore.getState();
      if (st.playing) {
        eng.pause();
        return;
      }
      const total = Math.max(beatsPerMeasure(st.score), scoreEnd(st.score));
      const from = st.beat >= total - 0.01 ? 0 : st.beat;
      eng.setMetronome(st.settings.metronome);
      eng.setLoop(0, st.settings.loop ? total : null);
      await eng.play(from);
    } catch (e) {
      store.say(`播放失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, [ensureEngine, store]);

  const stop = useCallback(async () => {
    const eng = await ensureEngine();
    eng.stop();
  }, [ensureEngine]);

  const seek = useCallback(
    async (b: number) => {
      useStore.setState({ beat: b });
      const eng = engineRef.current;
      if (eng) eng.seek(b);
    },
    [],
  );

  const doExport = useCallback(
    async (kind: ExportKind) => {
      setBusyExport(kind);
      try {
        const path = await exportScore(kind, useStore.getState().score);
        store.say(`已导出 ${path}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("取消")) store.say("已取消导出", "info");
        else store.say(`导出失败：${msg}`, "err");
      } finally {
        setBusyExport(null);
      }
    },
    [store],
  );

  const doSave = useCallback(async () => {
    try {
      const s = useStore.getState().score;
      const path = await saveText(`${s.title || "未命名"}.zmusic`, serializeScore(s));
      useStore.getState().markSaved();
      store.say(`已保存 ${path}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("取消")) store.say("已取消保存", "info");
      else store.say(`保存失败：${msg}`, "err");
    }
  }, [store]);

  const doOpen = useCallback(async () => {
    try {
      const r = await openProjectFile();
      if (!r) return;
      useStore.getState().loadScore(r.score, `已打开 ${r.name}`, r.name.replace(/\.(zmusic|json)$/i, ""));
    } catch (e) {
      store.say(`打开失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, [store]);

  const doImport = useCallback(async () => {
    try {
      const r = await importFile();
      if (!r) return;
      useStore.getState().loadScore(r.score, `已导入 ${r.kind.toUpperCase()}`, r.score.title);
      if (r.warnings.length > 0) {
        Modal.info({
          title: "导入完成，但有需要注意的地方",
          content: (
            <ul style={{ paddingLeft: 18, fontSize: 12 }}>
              {r.warnings.slice(0, 8).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ),
        });
      }
    } catch (e) {
      store.say(`导入失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, [store]);

  const doPasteImport = useCallback(() => {
    try {
      const r = importFromText(pasteText, "粘贴的乐谱");
      useStore.getState().loadScore(r.score, `已从文本导入（${r.kind}）`);
      setPasteOpen(false);
      setPasteText("");
    } catch (e) {
      antdMessage.error(`解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [pasteText]);

  /* 快捷键：输入框里不劫持 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
        return;
      }
      if (meta && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
        return;
      }
      if (typing) return;
      if (e.code === "Space") {
        e.preventDefault();
        void playPause();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        useStore.getState().deleteSelected();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const bpm = beatsPerMeasure(useStore.getState().score);
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const cur = useStore.getState().beat;
        void seek(Math.max(0, (Math.floor(cur / bpm) + dir) * bpm));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave, playPause, seek]);

  const exportMenu = useMemo(
    () => ({
      items: (Object.keys(EXPORT_META) as ExportKind[]).map((k) => ({
        key: k,
        label: (
          <Space size={8}>
            <span>{EXPORT_META[k].label}</span>
            <span style={{ fontSize: 11, opacity: 0.55 }}>{EXPORT_META[k].hint}</span>
          </Space>
        ),
        disabled: busyExport !== null,
      })),
      onClick: ({ key }: { key: string }) => void doExport(key as ExportKind),
    }),
    [busyExport, doExport],
  );

  const importMenu = useMemo(
    () => ({
      items: [
        { key: "file", label: "从文件导入（MIDI / MusicXML / ABC）", icon: <ImportOutlined /> },
        { key: "paste", label: "粘贴乐谱文本", icon: <CopyOutlined /> },
      ],
      onClick: ({ key }: { key: string }) => {
        if (key === "file") void doImport();
        else setPasteOpen(true);
      },
    }),
    [doImport],
  );

  const stage = (() => {
    if (view === "staff") return <StaffView score={score} beat={beat} />;
    if (view === "jianpu") return <JianpuView score={score} trackIndex={trackIndex} beat={beat} />;
    if (view === "roll")
      return (
        <PianoRoll
          score={score}
          trackId={trackId}
          selected={selected}
          beat={beat}
          snap={settings.snap}
          onSelect={(ids) => store.select(ids)}
          onAddNote={(start, pitch) => {
            store.addNote(trackId, start, pitch, 1);
          }}
          onMoveNote={(id, start, pitch) => {
            store.updateNote(trackId, id, { start, pitch });
          }}
        />
      );
    return (
      <MixerView
        score={score}
        activeTrackId={trackId}
        onSelect={(id) => store.setTrack(id)}
        onUpdateTrack={(id, patch) => {
          store.updateTrack(id, patch);
          const eng = engineRef.current;
          if (eng) setTimeout(() => eng.syncMix(useStore.getState().score), 0);
        }}
        onAddTrack={(i: InstrumentId) => store.addTrack(i)}
        onRemoveTrack={(id) => store.removeTrack(id)}
        playing={playing}
        onTogglePlay={() => void playPause()}
      />
    );
  })();

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: settings.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: "#667eea", borderRadius: 8, fontSize: 13 },
      }}
    >
      <AntdApp>
        <div className="mu-root" data-dark={settings.dark}>
          <header className="mu-head">
            <div className="mu-brand">
              MuseLab<small>音乐工坊</small>
            </div>
            <Input
              className="mu-title-input"
              size="small"
              value={score.title}
              onChange={(e) => store.setTitle(e.target.value)}
              placeholder="工程名"
              aria-label="工程名"
            />
            {dirty && <Tag color="orange">未保存</Tag>}
            <Space size={4}>
              <Tooltip title="新建空白工程">
                <Button size="small" icon={<FileAddOutlined />} onClick={() => (dirty ? setPendingNew(true) : store.newProject())} aria-label="新建" />
              </Tooltip>
              <Tooltip title="打开工程（.zmusic）">
                <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void doOpen()} aria-label="打开" />
              </Tooltip>
              <Tooltip title="保存工程（⌘S）">
                <Button size="small" icon={<SaveOutlined />} onClick={() => void doSave()} aria-label="保存" />
              </Tooltip>
              <Dropdown menu={importMenu} trigger={["click"]}>
                <Button size="small" icon={<ImportOutlined />}>
                  导入
                </Button>
              </Dropdown>
              <Dropdown menu={exportMenu} trigger={["click"]}>
                <Button size="small" type="primary" icon={<DownloadOutlined />} loading={busyExport !== null}>
                  导出
                </Button>
              </Dropdown>
            </Space>
            <span className="mu-spacer" />
            <Segmented
              size="small"
              value={view}
              onChange={(v) => store.setView(v as ViewMode)}
              options={VIEWS.map((v) => ({ value: v.value, label: v.label, icon: v.icon }))}
            />
            <Tooltip title={settings.dark ? "切到亮色" : "切到暗色"}>
              <Button
                size="small"
                type="text"
                icon={settings.dark ? <SunOutlined /> : <MoonOutlined />}
                onClick={() => store.setSettings({ dark: !settings.dark })}
                aria-label="切换主题"
              />
            </Tooltip>
            <Tooltip title="设置">
              <Button size="small" type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} aria-label="设置" />
            </Tooltip>
            <Tooltip title={rightOpen ? "收起右侧面板" : "展开右侧面板"}>
              <Button
                size="small"
                type="text"
                icon={<ReadOutlined />}
                onClick={() => setRightOpen((v) => !v)}
                aria-label="切换右侧面板"
              />
            </Tooltip>
          </header>

          <div className="mu-body">
            <aside className="mu-left">
              <TrackList
                score={score}
                activeTrackId={trackId}
                onSelect={(id) => store.setTrack(id)}
                onAdd={(i) => store.addTrack(i)}
              />
              <div className="mu-pane-head" style={{ borderTop: "1px solid var(--mu-line)", borderBottom: "none" }}>
                <span>
                  {measureCount(score)} 小节 · {score.time[0]}/{score.time[1]}
                </span>
                <Tag color="blue">{score.tempo} BPM</Tag>
              </div>
            </aside>

            <main className="mu-main">
              <div className="mu-stage">{stage}</div>
            </main>

            <aside className="mu-right" data-collapsed={!rightOpen}>
              <Tabs
                size="small"
                defaultActiveKey="ai"
                style={{ padding: "0 10px" }}
                items={[
                  { key: "ai", label: <span><RobotOutlined /> 作曲</span>, children: <AiPanel /> },
                  { key: "theory", label: <span><SoundOutlined /> 乐理</span>, children: <TheoryPanel /> },
                  {
                    key: "insp",
                    label: <span><InfoCircleOutlined /> 属性</span>,
                    children: <InspectorPanel />,
                  },
                ]}
              />
            </aside>
          </div>

          <Transport
            score={score}
            beat={beat}
            playing={playing}
            metronome={settings.metronome}
            loop={settings.loop !== null}
            onPlayPause={() => void playPause()}
            onStop={() => void stop()}
            onSeek={(b) => void seek(b)}
            onTempo={(bpm) => store.setTempo(bpm)}
            onMetronome={(on) => store.setSettings({ metronome: on })}
            onLoop={(on) => {
              const total = Math.max(beatsPerMeasure(score), scoreEnd(score));
              store.setSettings({ loop: on ? { from: 0, to: total } : null });
            }}
          />

          {hint && (
            <div
              style={{
                position: "fixed",
                right: 18,
                bottom: 62,
                maxWidth: 460,
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.6,
                color: hint.kind === "err" ? "#ffe1e1" : "#e8eaf8",
                background: hint.kind === "err" ? "rgba(180,40,40,0.92)" : "rgba(30,34,58,0.94)",
                border: `1px solid ${hint.kind === "err" ? "rgba(255,140,140,0.5)" : "rgba(102,126,234,0.45)"}`,
                boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
                zIndex: 1200,
              }}
              role="status"
            >
              {hint.text}
            </div>
          )}

          <Modal
            title="还有未保存的改动"
            open={pendingNew}
            onCancel={() => setPendingNew(false)}
            footer={[
              <Button key="cancel" onClick={() => setPendingNew(false)}>
                取消
              </Button>,
              <Button
                key="discard"
                danger
                onClick={() => {
                  setPendingNew(false);
                  store.newProject();
                }}
              >
                不保存，直接新建
              </Button>,
              <Button
                key="save"
                type="primary"
                onClick={async () => {
                  await doSave();
                  setPendingNew(false);
                  store.newProject();
                }}
              >
                先保存再新建
              </Button>,
            ]}
          >
            新建会把当前工程「{score.title}」换成空白工程。选择保存的话，会先弹「另存为」。
          </Modal>

          <Modal
            title="粘贴乐谱文本"
            open={pasteOpen}
            onCancel={() => setPasteOpen(false)}
            onOk={doPasteImport}
            okText="解析并载入"
            okButtonProps={{ disabled: pasteText.trim().length === 0 }}
            width={640}
          >
            <div className="mu-hint" style={{ marginBottom: 8 }}>
              支持 ABC 记谱法（推荐，AI 生成的就是这种）与 MusicXML。粘贴后会整份替换当前工程（可撤销）。
            </div>
            <Input.TextArea
              className="mu-abc"
              rows={14}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"X:1\nT:小星星\nM:4/4\nL:1/4\nK:C\nC C G G | A A G2 |"}
            />
          </Modal>

          <Modal
            title="设置"
            open={settingsOpen}
            onCancel={() => setSettingsOpen(false)}
            footer={<Button onClick={() => setSettingsOpen(false)}>关闭</Button>}
          >
            <Space orientation="vertical" style={{ width: "100%" }} size={14}>
              <div>
                <div className="mu-hint">主题</div>
                <Switch
                  checked={settings.dark}
                  onChange={(v) => store.setSettings({ dark: v })}
                  checkedChildren="暗"
                  unCheckedChildren="亮"
                />
              </div>
              <div>
                <div className="mu-hint">卷帘吸附粒度（拍）</div>
                <Select
                  style={{ width: 160 }}
                  value={settings.snap}
                  onChange={(v) => store.setSettings({ snap: v })}
                  options={[
                    { value: 1, label: "1/4 音符" },
                    { value: 0.5, label: "1/8 音符" },
                    { value: 0.25, label: "1/16 音符" },
                  ]}
                />
              </div>
              <div>
                <div className="mu-hint">简谱字号</div>
                <Slider disabled value={20} min={12} max={32} tooltip={{ formatter: () => "v0.2 可调" }} />
              </div>
              <Divider style={{ margin: "4px 0" }} />
              <div className="mu-hint">
                MuseLab 音乐工坊 v0.1.0 · MIT
                <br />
                乐谱内核与排版全部本地运行；AI 功能需要你自己填一个 OpenAI 兼容服务的 Key（也可用本地 Ollama）。
                <br />
                导出的 MIDI / MusicXML 可在 MuseScore、Logic Pro、Sibelius 里继续编辑。
              </div>
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(toAbc(useStore.getState().score))
                      .then(() => store.say("ABC 已复制到剪贴板"))
                      .catch(() => store.say("复制失败：浏览器不让写剪贴板", "err"));
                  }}
                >
                  复制 ABC
                </Button>
                <Tag>v0.1.0</Tag>
              </Space>
            </Space>
          </Modal>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
