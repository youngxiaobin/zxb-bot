import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { MarkdownSpan, Projection } from "@pa/sdk";
import {
  emptyProjection,
  markdownToPlain,
  MemoryCredentialStore,
  MemoryProjectionStore,
  parseMarkdown,
  PersonalAgentClient,
  validateGatewayUrl,
} from "@pa/sdk";

const EMPTY = emptyProjection();
const PRESETS = [
  {
    id: "fixture_research",
    name: "资料研究员",
    letter: "资",
    color: "#2f9e8f",
    hint: "预设 · 只在一次委托里运行，不能单独对话",
  },
  {
    id: "outline_planner",
    name: "提纲规划",
    letter: "纲",
    color: "#e2a15a",
    hint: "预设 · 只在一次委托里运行，不能单独对话",
  },
] as const;

const connectionCopy: Record<Projection["connection"], string> = {
  idle: "未连接",
  connecting: "正在连接",
  live: "已连接",
  reconnecting: "正在重连",
  offline: "离线",
  unauthorized: "未授权",
};

export function App() {
  const bridge = window.personalAgent;
  const [browser, setBrowser] = useState<PersonalAgentClient | null>(null);
  const [bridgeSnapshot, setBridgeSnapshot] = useState<Projection | null>(null);
  const browserSnapshot = useSyncExternalStore(
    (listener) => (browser ? browser.subscribe(listener) : () => {}),
    () => (browser ? browser.getSnapshot() : EMPTY),
    () => (browser ? browser.getSnapshot() : EMPTY),
  );
  const projection = bridge ? bridgeSnapshot : browserSnapshot;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [mobileChat, setMobileChat] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:47471");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const tokenRef = useRef<HTMLInputElement>(null);
  const settingsAnchor = useRef<HTMLButtonElement>(null);

  const sessions = projection?.sessions ?? [];
  const active = sessions.find((session) => session.id === sessionId) ?? null;
  const messages = active ? (projection?.messages[active.id] ?? []) : [];
  const runs = Object.values(projection?.runs ?? {}).filter(
    (run) => run.sessionId === active?.id && run.kind === "root",
  );
  const activeRun = runs[runs.length - 1];
  const tools = Object.values(projection?.tools ?? {}).filter(
    (tool) => tool.rootRunId === activeRun?.id || tool.runId === activeRun?.id,
  );
  const specialists = activeRun
    ? (projection?.specialists[activeRun.id] ?? [])
    : [];
  const approvals = (projection?.approvals ?? []).filter(
    (item) => item.sessionId === active?.id,
  );
  const sensitiveReady = projection?.sensitiveReady ?? false;
  const connected = projection?.connection === "live";
  const query = search.trim().toLowerCase();
  const visibleSessions = sessions.filter((session) => {
    const preview = previewOf(projection, session.id);
    return (
      !query ||
      session.title.toLowerCase().includes(query) ||
      preview.toLowerCase().includes(query)
    );
  });
  const visiblePresets = PRESETS.filter(
    (preset) =>
      !query ||
      preset.name.toLowerCase().includes(query) ||
      preset.hint.toLowerCase().includes(query),
  );

  async function refreshBridge() {
    const current = window.personalAgent;
    if (!current) return;
    setBridgeSnapshot(await current.getSnapshot());
  }

  async function connectPair() {
    const url = readUrl();
    if (!url) return;
    setBusy(true);
    setNotice(null);
    try {
      if (bridge) {
        await bridge.redeem({
          baseUrl: url,
          code: code.trim(),
          deviceLabel: "桌面",
        });
        await refreshBridge();
      } else {
        await switchBrowser(url, async (next) => {
          await next.redeem({
            code: code.trim(),
            deviceLabel: "桌面预览",
            kind: "desktop",
          });
        });
      }
      setCode("");
      setSettingsOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "配对失败");
    } finally {
      setBusy(false);
    }
  }

  async function connectToken() {
    const url = readUrl();
    if (!url) return;
    const token = tokenRef.current?.value ?? "";
    if (tokenRef.current) tokenRef.current.value = "";
    if (token.trim().length < 8) {
      setNotice("请填写设备令牌，或展开本机配对。");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (bridge) {
        await bridge.adopt({ baseUrl: url, token: token.trim() });
        await refreshBridge();
      } else {
        await switchBrowser(url, async (next) => {
          await next.adoptToken(token.trim());
        });
      }
      setSettingsOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  async function switchBrowser(
    url: string,
    setup: (next: PersonalAgentClient) => Promise<void>,
  ) {
    const next = new PersonalAgentClient({
      baseUrl: url,
      credentials: new MemoryCredentialStore(),
      persistence: new MemoryProjectionStore(),
    });
    try {
      await setup(next);
      await next.connect();
      const snap = next.getSnapshot();
      if (snap.connection !== "live") {
        const message =
          snap.lastError?.message ?? "设备令牌无效、过期或已吊销。";
        await next.forget();
        throw new Error(message);
      }
      await browser?.forget();
      setBrowser(next);
      setSessionId(null);
      setPresetId(null);
    } catch (error) {
      await next.forget();
      throw error;
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      if (bridge) await bridge.forget();
      await browser?.forget();
      setBrowser(null);
      setBridgeSnapshot(emptyProjection());
      setSessionId(null);
      setCode("");
      if (tokenRef.current) tokenRef.current.value = "";
      setNotice("已断开。网页里的令牌只存在过内存，现已清除。");
    } finally {
      setBusy(false);
    }
  }

  async function mint() {
    const url = readUrl();
    if (!url) return;
    setNotice(null);
    try {
      const response = bridge
        ? await bridge.mint(url)
        : await fetch(`${url}/v1/pairing/mint`, { method: "POST" }).then(
            async (result) => {
              if (!result.ok) throw new Error("只能在网关本机申请配对码");
              return (await result.json()) as { code: string };
            },
          );
      setCode(response.code);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "申请失败");
    }
  }

  function readUrl(): string | null {
    try {
      const url = validateGatewayUrl(baseUrl);
      setBaseUrl(url);
      return url;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "地址无效");
      return null;
    }
  }

  async function createSession() {
    if (!connected) return;
    setBusy(true);
    setNotice(null);
    try {
      if (bridge) {
        const result = (await bridge.command({
          type: "session.open",
          title: "新的委托",
        })) as { result?: { sessionId?: string } };
        if (result.result?.sessionId) {
          setSessionId(result.result.sessionId);
          setPresetId(null);
          setMobileChat(true);
        }
        await refreshBridge();
      } else if (browser) {
        const opened = await browser.openSession("新的委托");
        setSessionId(
          String((opened.result as { sessionId: string }).sessionId),
        );
        setPresetId(null);
        setMobileChat(true);
        await browser.resync();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建会话");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!active || !draft.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      if (bridge) {
        await bridge.command({
          type: "message.submit",
          sessionId: active.id,
          text: draft,
          providerMode: mode,
        });
        await refreshBridge();
      } else {
        await browser?.submit({
          sessionId: active.id,
          text: draft,
          providerMode: mode,
        });
      }
      setDraft("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function decide(
    approvalId: string,
    decision: "approve" | "reject",
    version: number,
    paramsHash: string,
  ) {
    if (!sensitiveReady) {
      setNotice("离线时不能审批，请求不会排队。");
      return;
    }
    try {
      if (bridge) {
        await bridge.command({
          type: "approval.decide",
          approvalId,
          decision,
          expectedVersion: version,
          paramsHash,
        });
        await refreshBridge();
      } else {
        await browser?.decide({
          approvalId,
          decision,
          expectedVersion: version,
          paramsHash,
        });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "审批失败");
    }
  }

  async function cancel() {
    if (!activeRun || !sensitiveReady) {
      setNotice("离线时不能取消，请求不会排队。");
      return;
    }
    try {
      if (bridge)
        await bridge.command({ type: "run.cancel", runId: activeRun.id });
      else await browser?.cancel(activeRun.id);
      await refreshBridge();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "取消失败");
    }
  }

  const preset = PRESETS.find((item) => item.id === presetId) ?? null;
  const sendReason = !connected
    ? "连接后才能发送"
    : preset
      ? "预设专员不能单独接收消息"
      : !active
        ? "请先新建或选择一个会话"
        : !draft.trim()
          ? "请先输入内容"
          : "";

  return (
    <div className={mobileChat ? "shell chat" : "shell"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="avatar" aria-hidden="true">
            z
          </div>
          <strong>zxb bot</strong>
        </div>
        <div className="tools">
          <input
            className="search"
            aria-label="搜索会话"
            placeholder="搜索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            className="icon-btn"
            type="button"
            data-action="new-session"
            aria-label="新会话"
            title={connected ? "新建真实会话" : "连接后才能新建会话"}
            disabled={!connected || busy}
            onClick={() => void createSession()}
          >
            +
          </button>
        </div>
        <div className="list">
          {visibleSessions.length === 0 ? (
            <p className="muted">没有匹配的会话。连接后可以新建。</p>
          ) : null}
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              className={
                session.id === active?.id && !preset
                  ? "row-btn active"
                  : "row-btn"
              }
              type="button"
              onClick={() => {
                setSessionId(session.id);
                setPresetId(null);
                setMobileChat(true);
              }}
            >
              <span className="avatar sm">z</span>
              <span className="row-copy">
                <strong>{session.title}</strong>
                <span>{previewOf(projection, session.id) || "zxb bot"}</span>
              </span>
            </button>
          ))}
          <div className="section-label">预设专员</div>
          {visiblePresets.map((item) => (
            <button
              key={item.id}
              className={presetId === item.id ? "preset active" : "preset"}
              type="button"
              onClick={() => {
                setPresetId(item.id);
                setMobileChat(true);
              }}
            >
              <span className="avatar sm" style={{ background: item.color }}>
                {item.letter}
              </span>
              <span className="row-copy">
                <strong>{item.name}</strong>
                <span>{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <button
          className="me"
          type="button"
          data-action="open-settings"
          aria-label="打开连接设置"
          ref={settingsAnchor}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <span className="avatar user">我</span>
          <span className="row-copy">
            <strong>我的</strong>
            <span>{connectionCopy[projection?.connection ?? "idle"]}</span>
          </span>
          <span className={connected ? "dot live" : "dot"} />
        </button>
        {settingsOpen
          ? createPortal(
              <SettingsPanel anchor={settingsAnchor.current}>
                <header>
                  <span className="avatar user">我</span>
                  <span className="grow">
                    <strong>我的</strong>
                    <span className="muted">
                      {connectionCopy[projection?.connection ?? "idle"]}
                    </span>
                  </span>
                  <button
                    className="icon-btn"
                    type="button"
                    data-action="close-settings"
                    aria-label="关闭"
                    onClick={() => setSettingsOpen(false)}
                  >
                    ×
                  </button>
                </header>
                <h2>连接设置</h2>
                <label>
                  Gateway 地址
                  <input
                    aria-label="Gateway 地址"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  设备令牌
                  <input
                    ref={tokenRef}
                    aria-label="设备令牌"
                    type="password"
                    defaultValue=""
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  className="full primary"
                  type="button"
                  data-action="save-connection"
                  disabled={busy}
                  onClick={() => void connectToken()}
                >
                  保存并重新连接
                </button>
                <button
                  className="full ghost"
                  type="button"
                  data-action="disconnect"
                  disabled={!connected && !browser && !bridgeSnapshot}
                  title={
                    connected
                      ? "断开并清除内存中的令牌"
                      : "当前没有可断开的连接"
                  }
                  onClick={() => void disconnect()}
                >
                  断开连接
                </button>
                <div className="pair">
                  <button
                    className="full ghost"
                    type="button"
                    data-action="toggle-pairing"
                    onClick={() => setPairingOpen((open) => !open)}
                  >
                    {pairingOpen ? "收起本机配对" : "本机配对"}
                  </button>
                  {pairingOpen ? (
                    <>
                      <button
                        className="full ghost"
                        type="button"
                        data-action="mint"
                        onClick={() => void mint()}
                      >
                        申请本机配对码
                      </button>
                      <label>
                        一次性配对码
                        <input
                          aria-label="一次性配对码"
                          value={code}
                          onChange={(event) => setCode(event.target.value)}
                          autoComplete="off"
                        />
                      </label>
                      <button
                        className="full primary"
                        type="button"
                        data-action="pair"
                        disabled={busy || !code.trim()}
                        title={
                          code.trim()
                            ? "用一次性配对码连接"
                            : "请先填写一次性配对码"
                        }
                        onClick={() => void connectPair()}
                      >
                        配对并连接
                      </button>
                    </>
                  ) : null}
                </div>
                <p className="muted">
                  {bridge
                    ? "正式窗口沿用已有的安全存储保存令牌，不会写进页面。"
                    : "网页预览把令牌只放在内存里。刷新页面后需要重新连接。"}
                </p>
                {notice ? (
                  <div className="alert" role="alert">
                    {notice}
                  </div>
                ) : null}
              </SettingsPanel>,
              document.body,
            )
          : null}
      </aside>
      <main className="stage">
        <div className="capsule-wrap">
          <button
            className="back"
            type="button"
            data-action="back"
            onClick={() => setMobileChat(false)}
          >
            返回
          </button>
          <div className="capsule">
            <span className="avatar sm">z</span>
            zxb bot
            <span className="mode">
              {mode === "demo" ? "演示 · 不是大模型" : "实况"}
            </span>
          </div>
        </div>
        <div className="transcript">
          {notice && !settingsOpen ? (
            <div className="alert" role="alert">
              {notice}
            </div>
          ) : null}
          {projection?.lastError && projection.connection !== "live" ? (
            <div className="alert" role="alert">
              {projection.lastError.message}
            </div>
          ) : null}
          {preset ? (
            <article className="card">
              <h3>{preset.name}</h3>
              <p>{preset.hint}。它不是另一个机器人，也不会单独保存会话。</p>
            </article>
          ) : null}
          {!preset && !active ? (
            <p className="empty">
              选择一个会话，或新建一次委托。zxb bot 会在写入前停下等你批准。
            </p>
          ) : null}
          {messages.map((message) => (
            <article
              key={message.id}
              className={message.role === "user" ? "bubble user" : "bubble"}
            >
              <MarkdownText source={message.content} />
            </article>
          ))}
          {activeRun && projection?.ephemeralByRun[activeRun.id] ? (
            <article className="bubble">
              预览，尚未入库：{projection.ephemeralByRun[activeRun.id]}
            </article>
          ) : null}
          {specialists.map((item) => (
            <article key={item.id} className="card">
              <h3>专员 {labelOf(item.role)}</h3>
              <p className="muted">
                {item.role} · {item.status}
                {item.errorMessage ? ` · ${item.errorMessage}` : ""}
              </p>
            </article>
          ))}
          {tools.map((tool) => (
            <article key={tool.id} className="card">
              <h3>{tool.toolName}</h3>
              <p className="muted">
                {tool.resource} · {tool.status}
              </p>
            </article>
          ))}
          {approvals.map((approval) => (
            <article key={approval.id} className="card">
              <h3>{approval.toolName}</h3>
              <p className="muted">
                {approval.status} · 版本 {approval.version}
              </p>
              <p>目标 {approval.resource}</p>
              {detailId === approval.id ? (
                <pre>{JSON.stringify(approval.params, null, 2)}</pre>
              ) : null}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  data-action="approve"
                  disabled={!sensitiveReady || approval.status !== "pending"}
                  title={
                    approval.status === "pending"
                      ? "批准这次写入"
                      : "这项审批已经结束"
                  }
                  onClick={() =>
                    void decide(
                      approval.id,
                      "approve",
                      approval.version,
                      approval.paramsHash,
                    )
                  }
                >
                  批准
                </button>
                <button
                  className="danger"
                  type="button"
                  data-action="reject"
                  disabled={!sensitiveReady || approval.status !== "pending"}
                  title={
                    approval.status === "pending"
                      ? "拒绝这次写入"
                      : "这项审批已经结束"
                  }
                  onClick={() =>
                    void decide(
                      approval.id,
                      "reject",
                      approval.version,
                      approval.paramsHash,
                    )
                  }
                >
                  拒绝
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() =>
                    setDetailId(detailId === approval.id ? null : approval.id)
                  }
                >
                  {detailId === approval.id ? "收起详情" : "审批详情"}
                </button>
              </div>
            </article>
          ))}
        </div>
        <div className="composer-wrap">
          {menuOpen ? (
            <div className="menu">
              <button
                type="button"
                onClick={() => {
                  setMode("demo");
                  setMenuOpen(false);
                }}
              >
                演示（确定性脚本，不是大模型）
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("live");
                  setMenuOpen(false);
                }}
              >
                实况（使用网关上的供应商配置）
              </button>
              <button
                type="button"
                disabled={!sensitiveReady || !activeRun}
                title={
                  activeRun && sensitiveReady
                    ? "接受取消，不保证立刻停止"
                    : "没有可取消的运行，或当前离线"
                }
                onClick={() => {
                  setMenuOpen(false);
                  void cancel();
                }}
              >
                取消当前运行
              </button>
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (!sendReason) void send();
            }}
          >
            <button
              className="icon-btn"
              type="button"
              data-action="more"
              aria-label="更多操作"
              onClick={() => setMenuOpen((open) => !open)}
            >
              +
            </button>
            <textarea
              aria-label="委托内容"
              value={draft}
              placeholder="输入你的回答，或聊点别的"
              disabled={Boolean(preset)}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              className="send"
              type="submit"
              data-action="send"
              disabled={Boolean(sendReason) || busy}
              title={sendReason || "发送"}
            >
              发送
            </button>
          </form>
          {sendReason ? <p className="hint muted">{sendReason}</p> : null}
          <p className="hint muted">
            取消被接受，并不表示已经开始的工具会立刻停止，也不能撤销已经发生的写入。
          </p>
        </div>
      </main>
    </div>
  );
}

function SettingsPanel({
  anchor,
  children,
}: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  useLayoutEffect(() => {
    function placePanel() {
      const margin = 12;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(300, viewportWidth - margin * 2);
      const rect = anchor?.getBoundingClientRect();
      const left = Math.min(
        Math.max(margin, rect?.left ?? margin),
        viewportWidth - margin - width,
      );
      const maxHeight = Math.min(560, viewportHeight - margin * 2);
      const above = rect ? rect.top - margin - 8 : maxHeight;
      const top = Math.max(
        margin,
        (rect?.top ?? viewportHeight) - 8 - Math.min(maxHeight, above),
      );
      setPlace({
        left,
        top,
        width,
        maxHeight: Math.min(maxHeight, viewportHeight - margin - top),
      });
    }
    placePanel();
    window.addEventListener("resize", placePanel);
    return () => window.removeEventListener("resize", placePanel);
  }, [anchor]);
  if (!place) return null;
  return (
    <div
      className="popover"
      role="dialog"
      aria-label="连接设置"
      style={{
        left: place.left,
        top: place.top,
        width: place.width,
        maxHeight: place.maxHeight,
      }}
    >
      {children}
    </div>
  );
}

function previewOf(projection: Projection | null, sessionId: string): string {
  const messages = projection?.messages[sessionId] ?? [];
  const last = messages[messages.length - 1];
  return last ? markdownToPlain(last.content) : "";
}

function labelOf(role: string): string {
  return PRESETS.find((item) => item.id === role)?.name ?? role;
}

function MarkdownText({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  let offset = 0;
  const nodes = [];
  for (const block of blocks) {
    const key = `b${offset}`;
    offset += 1;
    if (block.type === "heading") {
      nodes.push(
        <h3 key={key}>
          <Spans spans={block.spans} />
        </h3>,
      );
    } else if (block.type === "list") {
      nodes.push(
        <ul key={key}>
          <ListItems items={block.items} />
        </ul>,
      );
    } else {
      nodes.push(
        <p key={key}>
          <Spans spans={block.spans} />
        </p>,
      );
    }
  }
  return nodes;
}

function ListItems({ items }: { items: MarkdownSpan[][] }) {
  let offset = 0;
  const nodes = [];
  for (const item of items) {
    const key = `i${offset}`;
    offset += item.reduce((sum, span) => sum + span.text.length, 1);
    nodes.push(
      <li key={key}>
        <Spans spans={item} />
      </li>,
    );
  }
  return nodes;
}

function Spans({ spans }: { spans: MarkdownSpan[] }) {
  let offset = 0;
  const nodes = [];
  for (const span of spans) {
    const key = `${offset}-${span.type}`;
    offset += span.text.length + 1;
    if (span.type === "strong")
      nodes.push(<strong key={key}>{span.text}</strong>);
    else if (span.type === "code")
      nodes.push(<code key={key}>{span.text}</code>);
    else nodes.push(<span key={key}>{span.text}</span>);
  }
  return nodes;
}
