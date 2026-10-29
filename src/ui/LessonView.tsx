/**
 * 课程视图 —— 讲解、谱子、琴键、跟弹判定，一屏里闭环。
 *
 * 为什么不做成「阅读页 + 独立练习页」两屏：
 * 学琴的反馈回路是「看一句 → 立刻弹 → 听到错 → 回去看」。中间任何一次跳页
 * 都会打断这个回路，学生就会开始读而不弹。所以讲解和琴键必须在同一屏，
 * 而且要能一边看谱一边按键。
 *
 * 判定逻辑全在 core/practice.ts（纯函数，有单测）。这一层只负责：
 * 把按键事件送进判定器、把状态画出来、把成绩记进进度。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Divider, Modal, Progress, Space, Tag, Tooltip, message } from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  BulbOutlined,
  CheckCircleFilled,
  CustomerServiceOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SoundOutlined,
  StopOutlined,
  TrophyOutlined,
} from "@ant-design/icons";
import {
  CHAPTERS,
  chapterOf,
  doneCount,
  findLesson,
  lessonScore,
  loadProgress,
  nextLesson,
  prevLesson,
  recordAttempt,
  saveProgress,
  totalLessons,
  totalTries,
  type Lesson,
  type Progress as LessonProgress,
} from "../core/curriculum.ts";
import {
  accuracy,
  buildSteps,
  createSession,
  expectPitches,
  keyName,
  keyRangeFor,
  press,
  progressRatio,
  solfegeOf,
  stepCount,
  type Session,
} from "../core/practice.ts";
import { beatsPerMeasure, scoreEnd, type Score } from "../core/model.ts";
import { generateFromMessages, type ChatMessage } from "../core/ai.ts";
import { useStore } from "../state.ts";
import Keyboard, { KEYBOARD_HINT, keyToPitch } from "./Keyboard.tsx";
import { JianpuView, StaffView } from "./views.tsx";
import type { PlaybackEngine } from "../audio/engine.ts";

export interface LessonViewProps {
  getEngine: () => Promise<PlaybackEngine>;
  /** 通知 App：引擎里装的不再是主工程，回主视图时要重载 */
  invalidateEngine: () => void;
  /** 把课程练习曲载入主工程并切到谱面视图 */
  onOpenInProject: (score: Score) => void;
}

type Phase = "read" | "practice" | "result";

export default function LessonView({ getEngine, invalidateEngine, onOpenInProject }: LessonViewProps) {
  const provider = useStore((s) => s.provider);

  const [currentId, setCurrentId] = useState<string>(() => {
    // 深链 ?lesson=c3-2 方便截图核对，也方便把某一课发给别人
    try {
      const id = new URLSearchParams(window.location.search).get("lesson");
      if (id && findLesson(id)) return id;
    } catch {
      /* 非浏览器环境走默认 */
    }
    return CHAPTERS[0].lessons[0].id;
  });
  const [progress, setProgress] = useState<LessonProgress>(() => loadProgress());
  const [phase, setPhase] = useState<Phase>("read");
  const [session, setSession] = useState<Session | null>(null);
  const [result, setResult] = useState<{ accuracy: number; passed: boolean; firstTime: boolean } | null>(null);
  const [hot, setHot] = useState<number[]>([]);
  const [wrongPitch, setWrongPitch] = useState<number | null>(null);
  const [metronome, setMetronome] = useState(true);
  const [showJianpu, setShowJianpu] = useState(false);
  const [demo, setDemo] = useState<"none" | "all" | "accomp">("none");
  const [aiBusy, setAiBusy] = useState(false);
  /** 自由探索模式：按过哪些不同的键 */
  const [visited, setVisited] = useState<number[]>([]);

  const hotTimer = useRef<number | null>(null);
  const wrongTimer = useRef<number | null>(null);
  /** 示范播完自动复位「停」按钮的状态 */
  const demoTimer = useRef<number | null>(null);

  const lesson = findLesson(currentId) ?? CHAPTERS[0].lessons[0];
  const chapter = chapterOf(lesson.id);
  const score = useMemo(() => lessonScore(lesson), [lesson]);
  const practice = lesson.practice;
  const isFree = practice?.free === true;
  const steps = useMemo(
    () => (score && practice && !isFree ? buildSteps(score, practice.judgeTrack ?? 0) : []),
    [score, practice, isFree],
  );
  const range = useMemo(() => {
    if (practice?.keys) return { from: practice.keys[0], to: practice.keys[1] };
    if (steps.length > 0) return keyRangeFor(steps);
    return { from: 60, to: 71 };
  }, [practice, steps]);

  const cleanupTimers = () => {
    if (hotTimer.current !== null) window.clearTimeout(hotTimer.current);
    if (wrongTimer.current !== null) window.clearTimeout(wrongTimer.current);
    if (demoTimer.current !== null) window.clearTimeout(demoTimer.current);
  };

  /** 离开课程视图：停播、把引擎交回主工程 */
  useEffect(() => {
    return () => {
      cleanupTimers();
      invalidateEngine();
      void getEngine().then((e) => e.stop()).catch(() => undefined);
    };
  }, [getEngine, invalidateEngine]);

  /* ------------------------------------------------------------ 练习控制 */

  const reset = useCallback(() => {
    cleanupTimers();
    setHot([]);
    setWrongPitch(null);
    setVisited([]);
    setResult(null);
    if (isFree) {
      setSession(null);
      setPhase("practice");
      return;
    }
    setSession(createSession(steps));
    setPhase("practice");
  }, [isFree, steps]);

  const finish = useCallback(
    (final: Session) => {
      const acc = accuracy(final);
      const passLine = practice?.pass ?? 0.8;
      const r = recordAttempt(progress, lesson.id, acc, passLine);
      setProgress(r.progress);
      saveProgress(r.progress);
      setResult({ accuracy: acc, passed: r.passed, firstTime: r.firstTime });
      setPhase("result");
      void getEngine().then((e) => e.stop()).catch(() => undefined);
      setDemo("none");
    },
    [progress, lesson.id, practice, getEngine],
  );

  const flash = (pitch: number, ok: boolean) => {
    if (ok) {
      setHot((h) => (h.includes(pitch) ? h : [...h, pitch]));
      if (hotTimer.current !== null) window.clearTimeout(hotTimer.current);
      hotTimer.current = window.setTimeout(() => setHot([]), 260);
    } else {
      setWrongPitch(pitch);
      if (wrongTimer.current !== null) window.clearTimeout(wrongTimer.current);
      wrongTimer.current = window.setTimeout(() => setWrongPitch(null), 420);
    }
  };

  /** 自由模式凑够 12 个不同音就算摸过一遍 */
  const passFree = useCallback(() => {
    const r = recordAttempt(progress, lesson.id, 1, 0);
    setProgress(r.progress);
    saveProgress(r.progress);
    setResult({ accuracy: 1, passed: true, firstTime: r.firstTime });
    setPhase("result");
  }, [progress, lesson.id]);

  const handlePress = useCallback(
    (pitch: number) => {
      void getEngine()
        .then((e) => e.pluck(pitch, 0.9))
        .catch(() => undefined);

      if (isFree) {
        setPhase("practice");
        setVisited((v) => {
          if (v.includes(pitch)) return v;
          const next = [...v, pitch];
          if (next.length >= 12) passFree();
          return next;
        });
        return;
      }

      if (!session || phase !== "practice") return;
      const { session: s2, verdict } = press(session, pitch);
      setSession(s2);
      if (verdict === "wrong") {
        flash(pitch, false);
        return;
      }
      if (verdict === "hit") flash(pitch, true);
      if (verdict === "done") {
        flash(pitch, true);
        window.setTimeout(() => finish(s2), 260);
      }
    },
    [session, phase, isFree, finish, getEngine, passFree],
  );

  /* -------------------------------------------------------- 电脑键盘弹奏 */

  useEffect(() => {
    if (phase !== "practice") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const pitch = keyToPitch(e.key, range.from);
      if (pitch === null) return;
      if (pitch > range.to) return;
      e.preventDefault();
      handlePress(pitch);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, range.from, range.to, handlePress]);

  /* ------------------------------------------------------------ 示范播放 */

  const playDemo = useCallback(
    async (muteIndex?: number) => {
      if (!score) return;
      try {
        const eng = await getEngine();
        const prepared: Score = {
          ...score,
          tracks: score.tracks.map((t, i) => ({ ...t, mute: muteIndex === i, solo: false })),
        };
        await eng.load(prepared);
        eng.setMetronome(metronome);
        const total = Math.max(beatsPerMeasure(score), scoreEnd(score));
        eng.setLoop(0, total);
        await eng.play(0);
        setDemo(muteIndex === undefined ? "all" : "accomp");
        // 播完自动复位：Transport 停了不会通知这里，只能按长度算个预计时间
        if (demoTimer.current !== null) window.clearTimeout(demoTimer.current);
        const seconds = (total * 60) / Math.max(20, score.tempo) + 2;
        demoTimer.current = window.setTimeout(() => setDemo("none"), seconds * 1000);
      } catch (e) {
        message.error(`播放失败：${e instanceof Error ? e.message : String(e)}`);
        setDemo("none");
      }
    },
    [score, getEngine, metronome],
  );

  const stopDemo = useCallback(async () => {
    if (demoTimer.current !== null) {
      window.clearTimeout(demoTimer.current);
      demoTimer.current = null;
    }
    const eng = await getEngine();
    eng.stop();
    setDemo("none");
  }, [getEngine]);

  /* ---------------------------------------------------------- AI 出练习题 */

  const aiExercise = useCallback(async () => {
    if (!score || !practice) return;
    const bars = Math.max(2, Math.ceil(scoreEnd(score) / beatsPerMeasure(score)));
    const lo = keyName(range.from);
    const hi = keyName(range.to);
    const system: ChatMessage = {
      role: "system",
      content: [
        "你是钢琴入门教材的作者。只输出 ABC 记谱法文本，不要任何解释、不要 markdown 代码块围栏。",
        "严格文法（其他写法一律视为错误）：",
        "1) 头字段只写 X:1 / T:标题 / M:4/4 / L:1/4 / Q:1/4=<bpm> / K:<调>；",
        "2) 音符用 A-G 与 a-c（小写高一个八度），升号 ^、降号 _、还原 =；",
        "3) 时值后缀：空=一拍，2=两拍，/2=半拍，3/2=一拍半；",
        "4) 和弦写 [CEG]；休止写 z；小节线用 |；",
        `5) 每一小节必须正好 4 拍，总共 ${bars} 小节。`,
      ].join("\n"),
    };
    const user: ChatMessage = {
      role: "user",
      content: [
        `为初学钢琴的学生写一段 ${bars} 小节的练习曲。`,
        `调性 ${score.key.mode === "major" ? "大调" : "小调"}，参照练习「${score.title}」。`,
        `速度 ${practice.bpm} BPM，音域限制在 ${lo} 到 ${hi} 之间（不要超出）。`,
        "难度：只用四分音符与二分音符，旋律以相邻音级为主，最多一个跳进。",
        `要求：右手单声部，右手旋律要能配 ${score.key.mode === "major" ? "主-属-主" : "主-属-主"} 的和声骨架。`,
      ].join("\n"),
    };
    setAiBusy(true);
    try {
      const r = await generateFromMessages(provider, [system, user], undefined, `AI 练习：${lesson.title}`);
      onOpenInProject(r.score);
      message.success(r.retried ? "已生成（模型第一次写错，自动修正过一次）" : "已生成，并载入工程");
    } catch (e) {
      message.error(`生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAiBusy(false);
    }
  }, [score, practice, provider, lesson.title, onOpenInProject, range.from, range.to]);

  /* ---------------------------------------------------------------- 渲染 */

  const done = doneCount(progress);
  const tries = totalTries(progress);
  const expected = session ? expectPitches(session) : [];
  const ratio = isFree
    ? Math.min(1, visited.length / 12)
    : session
      ? progressRatio(session)
      : 0;
  const next = nextLesson(lesson.id);
  const prev = prevLesson(lesson.id);

  const switchLesson = (l: Lesson) => {
    setCurrentId(l.id);
    setSession(null);
    setResult(null);
    setPhase("read");
    setHot([]);
    setWrongPitch(null);
    setVisited([]);
    setDemo("none");
    void getEngine().then((e) => e.stop()).catch(() => undefined);
  };

  return (
    <div className="mu-lesson">
      {/* 目录 */}
      <aside className="mu-lesson-nav" aria-label="课程目录">
        <div className="mu-lesson-stat">
          <div className="mu-lesson-stat-num">
            {done}
            <small> / {totalLessons()}</small>
          </div>
          <div className="mu-hint">已通关 · 累计练习 {tries} 次</div>
          <Progress percent={Math.round((done / Math.max(1, totalLessons())) * 100)} size="small" showInfo={false} />
        </div>
        <div className="mu-lesson-chapters">
          {CHAPTERS.map((c) => (
            <div key={c.id} className="mu-lesson-chapter">
              <div className="mu-lesson-chapter-title">{c.title.replace(/^第 \d+ 章 · /, "")}</div>
              {c.lessons.map((l) => {
                const rec = progress.lessons[l.id];
                return (
                  <button
                    key={l.id}
                    type="button"
                    className="mu-lesson-item"
                    data-active={l.id === lesson.id}
                    data-done={rec?.done === true}
                    onClick={() => switchLesson(l)}
                    aria-current={l.id === lesson.id ? "true" : undefined}
                  >
                    <span className="mu-lesson-tick">
                      {rec?.done ? <CheckCircleFilled style={{ color: "#52c41a" }} /> : <span className="mu-dot" />}
                    </span>
                    <span className="mu-lesson-item-name">{l.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      {/* 主区 */}
      <main className="mu-lesson-main">
        <header className="mu-lesson-head">
          <div>
            <div className="mu-hint">
              {chapter?.title} · 第 {chapter ? chapter.lessons.findIndex((l) => l.id === lesson.id) + 1 : 1} 课
            </div>
            <h2 className="mu-lesson-title">{lesson.title}</h2>
            <div className="mu-lesson-goal">
              学完你能：{lesson.goal}
              <Tag style={{ marginLeft: 8 }}>{lesson.minutes} 分钟</Tag>
              {progress.lessons[lesson.id]?.done && <Tag color="green">已通关</Tag>}
            </div>
          </div>
          <Space size={6}>
            {practice && (
              <Tooltip title={showJianpu ? "看五线谱" : "看简谱"}>
                <Button size="small" onClick={() => setShowJianpu((v) => !v)}>
                  {showJianpu ? "五线谱" : "简谱"}
                </Button>
              </Tooltip>
            )}
            {score && (
              <Tooltip title="把这课练习曲载入工作台，可以继续改、换音色、导出">
                <Button size="small" onClick={() => onOpenInProject(score)}>
                  在工程里打开
                </Button>
              </Tooltip>
            )}
          </Space>
        </header>

        <div className="mu-lesson-body">
          {/* 讲解 */}
          <section className="mu-lesson-card">
            {lesson.brief.map((b, i) => (
              <div key={i} className="mu-lesson-block">
                {b.h && <h3>{b.h}</h3>}
                <p>{b.body}</p>
                {b.tip && (
                  <p className="mu-lesson-tip">
                    <BulbOutlined /> {b.tip}
                  </p>
                )}
              </div>
            ))}
          </section>

          {/* 练习 */}
          {practice && score && (
            <section className="mu-lesson-card">
              <div className="mu-lesson-practice-head">
                <h3>
                  <SoundOutlined /> 动手练
                </h3>
                <Space size={6} wrap>
                  <Button
                    size="small"
                    icon={<PlayCircleOutlined />}
                    onClick={() => void playDemo()}
                    disabled={demo !== "none"}
                  >
                    听示范
                  </Button>
                  {score.tracks.length > 1 && (
                    <Button
                      size="small"
                      icon={<CustomerServiceOutlined />}
                      onClick={() => void playDemo(0)}
                      disabled={demo !== "none"}
                    >
                      只听左手（伴奏）
                    </Button>
                  )}
                  <Button size="small" icon={<StopOutlined />} onClick={() => void stopDemo()} disabled={demo === "none"}>
                    停
                  </Button>
                  <Button
                    size="small"
                    type={metronome ? "primary" : "default"}
                    ghost={metronome}
                    onClick={() => {
                      setMetronome((v) => !v);
                      void getEngine().then((e) => e.setMetronome(!metronome)).catch(() => undefined);
                    }}
                  >
                    节拍器
                  </Button>
                </Space>
              </div>

              <div className="mu-lesson-sheet">{showJianpu ? <JianpuView score={score} trackIndex={0} beat={0} /> : <StaffView score={score} beat={0} />}</div>

              <div className="mu-lesson-kbdbar">
                <div className="mu-lesson-focus">
                  {isFree ? "随便按：听低音区和高音区的区别" : practice.focus}
                </div>
                <div className="mu-lesson-judge">
                  {session && !isFree && (
                    <>
                      <span>
                        第 {Math.min(stepCount(session), session.cursor + 1)} / {stepCount(session)} 步
                      </span>
                      <Progress percent={Math.round(ratio * 100)} size="small" showInfo={false} style={{ width: 120 }} />
                    </>
                  )}
                  {isFree && (
                    <>
                      <span>已摸 {visited.length} / 12 个键</span>
                      <Progress percent={Math.round(ratio * 100)} size="small" showInfo={false} style={{ width: 120 }} />
                    </>
                  )}
                </div>
              </div>

              <Keyboard
                from={range.from}
                to={range.to}
                target={expected}
                hot={hot}
                wrong={wrongPitch}
                onPress={handlePress}
                showSolfege={showJianpu}
                keySig={score.key}
              />

              <div className="mu-lesson-keys-hint">
                <span>{KEYBOARD_HINT}</span>
                <span className="mu-hint">· 简谱对照：{expected.map((p) => solfegeOf(p, score.key)).join(" ")}</span>
              </div>

              {phase === "read" && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 10 }}
                  message="先看谱，再点开始。"
                  description={
                    <span>
                      {isFree
                        ? "点「开始探索」，然后随便按琴键。"
                        : "点「开始练习」后，琴键上会用青色标出下一个该按的键；按对了变绿，按错了闪红。判定只顺序，不限速度。"}
                    </span>
                  }
                  action={
                    <Button type="primary" size="small" onClick={reset}>
                      {isFree ? "开始探索" : "开始练习"}
                    </Button>
                  }
                />
              )}

              {phase === "practice" && (
                <div className="mu-lesson-actions">
                  <Button icon={<ReloadOutlined />} onClick={reset} size="small">
                    重来
                  </Button>
                  {session && !isFree && expected.length > 0 && (
                    <span className="mu-lesson-expected">
                      该按：<b>{expected.map(keyName).join(" + ")}</b>
                      <span className="mu-hint">（{expected.map((p) => solfegeOf(p, score.key)).join(" ")}）</span>
                    </span>
                  )}
                </div>
              )}

              {phase === "result" && result && (
                <div className="mu-lesson-result" data-pass={result.passed}>
                  <div className="mu-lesson-result-title">
                    {result.passed ? (
                      <>
                        <TrophyOutlined /> 过关
                      </>
                    ) : (
                      <>还差一点 —— 准确率 {Math.round(result.accuracy * 100)}%，需要 {Math.round((practice.pass ?? 0.8) * 100)}%</>
                    )}
                  </div>
                  <div className="mu-hint">
                    本次准确率 {Math.round(result.accuracy * 100)}% · 通关线 {Math.round((practice.pass ?? 0.8) * 100)}%
                    {progress.lessons[lesson.id]?.best ? ` · 最好成绩 ${Math.round((progress.lessons[lesson.id].best ?? 0) * 100)}%` : ""}
                    {result.firstTime ? " · 第一次通关，继续往下走" : ""}
                  </div>
                  <Space style={{ marginTop: 8 }}>
                    <Button size="small" icon={<ReloadOutlined />} onClick={reset}>
                      再练一遍
                    </Button>
                    {result.passed && next && (
                      <Button size="small" type="primary" icon={<ArrowRightOutlined />} onClick={() => switchLesson(next)}>
                        下一课：{next.title}
                      </Button>
                    )}
                  </Space>
                </div>
              )}

              {lesson.takeaway && <div className="mu-lesson-takeaway">这一课记住一句：{lesson.takeaway}</div>}
            </section>
          )}

          {/* 无练习曲的课（如导出实操） */}
          {!practice && (
            <section className="mu-lesson-card">
              <div className="mu-lesson-takeaway">这一课不动手，照着做一遍就行。</div>
              {score && (
                <Button size="small" onClick={() => onOpenInProject(score)} style={{ marginTop: 8 }}>
                  在工程里打开
                </Button>
              )}
            </section>
          )}

          {/* 页脚：AI 出题 + 翻页 */}
          <footer className="mu-lesson-foot">
            <Space size={6}>
              <Button size="small" icon={<ArrowLeftOutlined />} disabled={!prev} onClick={() => prev && switchLesson(prev)}>
                上一课
              </Button>
              <Button size="small" disabled={!next} onClick={() => next && switchLesson(next)}>
                下一课 <ArrowRightOutlined />
              </Button>
            </Space>
            <Tooltip title="让 AI 按这一课的难度另写一段练习曲，并载入工作台">
              <Button
                size="small"
                icon={<RobotOutlined />}
                loading={aiBusy}
                disabled={!practice || !score}
                onClick={() => {
                  Modal.confirm({
                    title: "让 AI 出一段同难度的练习曲？",
                    content: "生成后会把当前工程替换成这首练习曲（可撤销）。如果工作台里有没保存的东西，先存一下。",
                    okText: "生成",
                    cancelText: "算了",
                    onOk: () => aiExercise(),
                  });
                }}
              >
                AI 出同难度练习
              </Button>
            </Tooltip>
          </footer>

          <Divider style={{ margin: "4px 0 0" }} />
          <div className="mu-hint" style={{ paddingBottom: 4 }}>
            课程练习曲都是本应用自己的乐谱：点「在工程里打开」就能在卷帘里改音符、在混音台换音色、导出成 MIDI 或 MusicXML 交给别人。
            判定只顺序不限速度 —— 慢练是对的，别赶。
          </div>
        </div>
      </main>
    </div>
  );
}
