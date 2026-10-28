import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import UpdaterGate from "./components/UpdaterDialog";
import "./index.css";

/**
 * 渲染出错时的兜底：乐谱在内存里、也在 localStorage 里各有一份，
 * 白屏不该等于"这一轮的手活全丢"。所以这里给的是重新载入而不是空页面。
 */
class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state: { err: string | null } = { err: null };

  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) };
  }

  componentDidCatch(e: unknown) {
    console.error("MuseLab 渲染失败", e);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.7 }}>
        <h2 style={{ fontSize: 15 }}>界面渲染出错了</h2>
        <p>工程未受影响：上次自动留存的状态会在重新载入后回来。</p>
        <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7 }}>{this.state.err}</pre>
        <button onClick={() => location.reload()}>重新载入</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <App />
      <UpdaterGate />
    </Boundary>
  </StrictMode>,
);
