import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-desktop-"));
const gatewayPort = 47571;
const chromePort = 9224;
const base = `http://127.0.0.1:${gatewayPort}`;
const desktop = process.env.PA_DESKTOP_URL ?? "http://127.0.0.1:47341";
const artifactDir = process.env.PA_ARTIFACT_DIR ?? path.join(repo, "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });

const children = [];
function start(cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}

async function waitOk(url) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`没有等到 ${url}`);
}

function stopAll() {
  for (const child of children) child.kill("SIGTERM");
}

start(process.execPath, ["--import", "tsx", "apps/gateway/src/main.ts"], {
  PA_HOST: "127.0.0.1",
  PA_PORT: String(gatewayPort),
  PA_DATA_DIR: dataDir,
  PA_FIXTURES_DIR: path.join(repo, "fixtures"),
  PA_TEST_HOOKS: "1",
  OPENAI_API_KEY: "",
});
const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-chrome-"));
start(
  "google-chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${chromeProfile}`,
    "about:blank",
  ],
  {},
);

try {
  await waitOk(`${base}/v1/health`);
  await waitOk(desktop);
  await waitOk(`http://127.0.0.1:${chromePort}/json/version`);
  const summary = await drive();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const report = { sha, ...summary };
  const out = path.join(artifactDir, "desktop-final-states.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stdout.write(`desktop-final-states ${out}\n`);
} finally {
  stopAll();
}

async function drive() {
  const target = await fetch(
    `http://127.0.0.1:${chromePort}/json/new?${desktop}`,
    {
      method: "PUT",
    },
  ).then((response) => response.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: desktop });
  await sleep(600);
  const evalJs = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitText = async (needle) => {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      const text = await evalJs("document.body.innerText");
      if (text.includes(needle)) return text;
      await sleep(150);
    }
    const text = await evalJs("document.body.innerText");
    throw new Error(
      `界面没有出现 ${needle}\n---\n${String(text).slice(-1200)}`,
    );
  };
  const click = (label) =>
    evalJs(`(() => {
      const buttons = [...document.querySelectorAll("button")].filter((item) => item.textContent.includes(${JSON.stringify(label)}));
      const button = buttons.find((item) => !item.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`);
  const clickAction = (action) =>
    evalJs(`(() => {
      const button = document.querySelector('[data-action="${action}"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
  const setField = async (label, value) => {
    const ok = await evalJs(`(() => {
      const input = document.querySelector('[aria-label="${label}"]');
      if (!input) return false;
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      proto.set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`没有输入框 ${label}`);
  };
  const setWidth = async (width, height) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    await evalJs(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await sleep(500);
  };
  await waitText("zxb bot");
  await shot(send, path.join(artifactDir, "desktop-wide-list.png"));
  if (!(await clickAction("open-settings"))) throw new Error("没有连接设置");
  await waitText("连接设置");
  await assertSettings(evalJs, "宽屏设置");
  await shot(send, path.join(artifactDir, "desktop-wide-settings.png"));
  await setField("Gateway 地址", "notaurl");
  if (!(await clickAction("save-connection"))) throw new Error("没有保存按钮");
  await waitText("不是有效的 URL");
  await setField("Gateway 地址", base);
  await setField("设备令牌", "invalid-token-value");
  if (!(await clickAction("save-connection"))) throw new Error("没有保存按钮");
  await waitText("设备令牌无效");
  const leaked = await evalJs(
    'document.documentElement.innerHTML.includes("invalid-token-value")',
  );
  if (leaked) throw new Error("令牌出现在 HTML 里");
  await setField("设备令牌", "");
  if (!(await clickAction("toggle-pairing"))) throw new Error("没有本机配对");
  if (!(await clickAction("mint"))) throw new Error("没有配对码按钮");
  const startedCode = Date.now();
  let pairedCode = "";
  while (Date.now() - startedCode < 8000) {
    pairedCode = await evalJs(
      'document.querySelector(\'[aria-label="一次性配对码"]\')?.value ?? ""',
    );
    if (typeof pairedCode === "string" && pairedCode.length >= 8) break;
    await sleep(150);
  }
  if (!pairedCode || pairedCode.length < 8)
    throw new Error("没有读到一次性配对码");
  if (!(await clickAction("pair"))) throw new Error("没有配对按钮");
  await waitText("已连接");
  const storage = await evalJs(`({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    htmlHasBearer: document.documentElement.innerHTML.includes("Bearer ")
  })`);
  const second = await pairSecond();
  const approve = await oneTask(
    "请根据资料整理摘要并写入笔记。",
    "批准",
    "已写入",
    {
      pending: path.join(artifactDir, "desktop-wide-approval.png"),
      done: path.join(artifactDir, "desktop-wide-chat.png"),
    },
  );
  const notesAfterApprove = listNotes();
  const secondAfterApprove = await second.snapshot();
  await shot(send, path.join(artifactDir, "desktop-approve-final.png"));
  await setWidth(390, 844);
  if (!(await clickAction("back"))) throw new Error("窄屏没有返回");
  await sleep(800);
  await evalJs(
    "window.scrollTo(0,0); document.querySelector('.sidebar')?.scrollTo(0,0)",
  );
  await shot(send, path.join(artifactDir, "desktop-narrow-list.png"));
  if (!(await clickAction("open-settings")))
    throw new Error("窄屏没有连接设置");
  await sleep(400);
  const expanded = await evalJs(
    'document.body.innerText.includes("收起本机配对")',
  );
  if (expanded && !(await clickAction("toggle-pairing"))) {
    throw new Error("窄屏不能收起本机配对");
  }
  await assertSettings(evalJs, "窄屏设置");
  await shot(send, path.join(artifactDir, "desktop-narrow-settings.png"));
  if (!(await clickAction("close-settings")))
    throw new Error("窄屏设置无法关闭");
  const reject = await oneTask(
    "请再整理一次，但这次拒绝写入。",
    "拒绝",
    "没有产生文件变更",
    {
      chat: path.join(artifactDir, "desktop-narrow-chat.png"),
      pending: path.join(artifactDir, "desktop-narrow-approval.png"),
    },
  );
  const notesAfterReject = listNotes();
  const secondAfterReject = await second.snapshot();
  await shot(send, path.join(artifactDir, "desktop-reject-final.png"));
  ws.close();
  return {
    storage,
    approve: {
      ...approve,
      files: notesAfterApprove.length,
      secondClientEffect: secondAfterApprove.outcomes.at(-1)?.effect ?? null,
      secondClientSawOutcome: secondAfterApprove.outcomes.some(
        (item) => item.effect === "applied",
      ),
    },
    reject: {
      ...reject,
      files: notesAfterReject.length,
      secondClientEffect: secondAfterReject.outcomes.at(-1)?.effect ?? null,
    },
  };

  async function oneTask(text, button, done, shots = {}) {
    const sessionsBefore = await evalJs(
      "document.querySelectorAll('.row-btn').length",
    );
    if (!(await clickAction("new-session"))) throw new Error("不能新建会话");
    const opened = Date.now();
    let readyToType = false;
    while (Date.now() - opened < 8000) {
      const state = await evalJs(`(() => ({
        count: document.querySelectorAll(".row-btn").length,
        chat: document.querySelector(".shell").classList.contains("chat"),
        wide: window.innerWidth >= 720,
        title: document.querySelector('[data-action="send"]')?.title ?? ""
      }))()`);
      if (
        state.count > sessionsBefore &&
        (state.wide || state.chat) &&
        (state.title === "请先输入内容" || state.title === "发送")
      ) {
        readyToType = true;
        break;
      }
      await sleep(100);
    }
    if (!readyToType) throw new Error("新建会话没有成为当前会话");
    if (shots.chat) {
      await assertSend(evalJs);
      await shot(send, shots.chat);
    }
    await evalJs(`(() => {
      const el = document.querySelector("textarea");
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      proto.set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!(await click("发送"))) throw new Error("不能发送");
    await waitText("write_demo_note");
    await evalJs(
      "document.querySelector('[data-action=\"approve\"]')?.scrollIntoView({block:'center'})",
    );
    await sleep(200);
    if (shots.pending) await shot(send, shots.pending);
    const before = await effects();
    const approval = await waitPending(() => second.snapshot());
    const clicked = await evalJs(`(() => {
      const action = ${JSON.stringify(button === "批准" ? "approve" : "reject")};
      const buttons = [...document.querySelectorAll('[data-action="' + action + '"]')];
      const target = buttons.find((item) => !item.disabled);
      if (!target) return { found: buttons.length, enabled: false };
      target.click();
      return { found: buttons.length, enabled: true, text: target.textContent.trim() };
    })()`);
    if (!clicked?.enabled)
      throw new Error(`不能点击 ${button} ${JSON.stringify(clicked)}`);
    const startedDone = Date.now();
    let sawDone = false;
    let lastText = "";
    while (Date.now() - startedDone < 10000) {
      lastText = await evalJs("document.body.innerText");
      if (String(lastText).includes(done)) {
        sawDone = true;
        break;
      }
      await sleep(150);
    }
    if (!sawDone) {
      const summary = await effects();
      throw new Error(
        `界面没有出现 ${done} clicked=${JSON.stringify(clicked)} effects=${summary.effects} runs=${JSON.stringify(summary.runs)} head=${String(lastText).slice(0, 400)}`,
      );
    }
    if (shots.done) await shot(send, shots.done);
    const after = await effects();
    const dom = await approvalButtons(evalJs);
    const decisions = dom.filter(
      (item) => item.label === "批准" || item.label === "拒绝",
    );
    if (decisions.length < 2 || decisions.some((item) => !item.disabled)) {
      throw new Error(`终态审批按钮仍可操作 ${JSON.stringify(dom)}`);
    }
    const repeatClick = await repeatDisabledClicks(evalJs, send);
    const sameDecision = button === "批准" ? "approve" : "reject";
    const oppositeDecision = sameDecision === "approve" ? "reject" : "approve";
    const repeatSame = await second.decide(approval, sameDecision);
    const repeatOpposite = await second.decide(approval, oppositeDecision);
    const afterRepeat = await effects();
    const runId = approval.runId;
    if (repeatClick.decidePosts !== 0) {
      throw new Error("终态点击仍发出审批请求");
    }
    if (
      writesFor(afterRepeat, runId).length !== writesFor(after, runId).length
    ) {
      throw new Error("重复请求改变了文件 effect");
    }
    return {
      runId,
      approvalId: approval.id,
      version: approval.version,
      before: writesFor(before, runId),
      after: writesFor(after, runId),
      fileEffects: writesFor(after, runId).length,
      maxSeq: after.maxSeq,
      dom,
      repeatClick,
      repeatSame,
      repeatOpposite,
      afterRepeat: writesFor(afterRepeat, runId),
      fileEffectsAfterRepeat: writesFor(afterRepeat, runId).length,
    };
  }
}

async function waitPending(read) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const snap = await read();
    const approval = snap.approvals.find((item) => item.status === "pending");
    if (approval) return approval;
    await sleep(150);
  }
  throw new Error("第二客户端没有看到待审批");
}

async function pairSecond() {
  const minted = await fetch(`${base}/v1/pairing/mint`, { method: "POST" });
  const code = (await minted.json()).code;
  const redeemed = await fetch(`${base}/v1/pairing/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceLabel: "第二客户端", kind: "test" }),
  });
  const token = (await redeemed.json()).token;
  return {
    async snapshot() {
      const response = await fetch(`${base}/v1/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.json();
    },
    async decide(approval, decision) {
      const response = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "pa.command.v1",
          commandId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          type: "approval.decide",
          payload: {
            approvalId: approval.id,
            decision,
            expectedVersion: approval.version,
            paramsHash: approval.paramsHash,
          },
        }),
      });
      const body = await response.json();
      return {
        decision,
        httpStatus: response.status,
        outcome: body.result?.outcome ?? null,
        code: body.error?.code ?? null,
      };
    },
  };
}

async function assertSend(evalJs) {
  const measured = await evalJs(`(() => {
    const send = document.querySelector('[data-action="send"]');
    if (!send) return null;
    const rect = send.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(send);
    return {
      width: rect.width,
      height: rect.height,
      scrollHeight: send.scrollHeight,
      clientHeight: send.clientHeight,
      whiteSpace: getComputedStyle(send).whiteSpace,
      lines: range.getClientRects().length,
    };
  })()`);
  const ok =
    measured &&
    measured.whiteSpace === "nowrap" &&
    measured.lines <= 1 &&
    measured.width >= 56;
  if (!ok)
    throw new Error(`发送按钮文字被挤成两行 ${JSON.stringify(measured)}`);
}

async function assertSettings(evalJs, label) {
  const box = await evalJs(`(() => {
    const panel = document.querySelector('[aria-label="连接设置"]');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const inside = rect.left >= -1 && rect.top >= -1 && rect.right <= viewportWidth + 1 && rect.bottom <= viewportHeight + 1;
    const actions = ["close-settings", "save-connection", "disconnect", "toggle-pairing"].map((action) => {
      const el = panel.querySelector('[data-action="' + action + '"]');
      if (!el) return { action, ok: false };
      const item = el.getBoundingClientRect();
      const centerX = Math.min(viewportWidth - 1, Math.max(0, item.left + item.width / 2));
      const centerY = Math.min(viewportHeight - 1, Math.max(0, item.top + item.height / 2));
      const hit = document.elementFromPoint(centerX, centerY);
      return {
        action,
        width: item.width,
        height: item.height,
        uncovered: Boolean(hit && (hit === el || el.contains(hit))),
        inside: item.top >= -1 && item.left >= -1 && item.bottom <= viewportHeight + 1 && item.right <= viewportWidth + 1,
      };
    });
    const save = panel.querySelector('[data-action="save-connection"]');
    const saveStyle = getComputedStyle(save);
    const gateway = panel.querySelector('[aria-label="Gateway 地址"]').getBoundingClientRect();
    const send = document.querySelector('[data-action="send"]');
    const sendRect = send ? send.getBoundingClientRect() : null;
    const sendVisible = Boolean(sendRect && sendRect.width > 0 && sendRect.height > 0);
    const avatars = [...document.querySelectorAll(".preset .avatar")].map((el) => ({
      text: el.textContent.trim(),
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
    }));
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth,
      viewportHeight,
      inside,
      actions,
      saveBackground: saveStyle.backgroundColor,
      saveColor: saveStyle.color,
      gatewayWidth: gateway.width,
      gatewayRight: gateway.right,
      panelRight: rect.right,
      sendOneLine: !sendVisible || (send.scrollHeight <= send.clientHeight + 1 && sendRect.width >= 56),
      avatars,
    };
  })()`);
  if (!box) throw new Error(`${label} 没有连接层`);
  if (!box.inside)
    throw new Error(`${label} 连接层超出视口 ${JSON.stringify(box)}`);
  if (box.viewportWidth >= 900 && (box.width < 280 || box.width > 320)) {
    throw new Error(`${label} 浮层宽度不是约 300px ${JSON.stringify(box)}`);
  }
  if (
    !/rgb\(28,\s*28,\s*30\)/.test(box.saveBackground ?? "") ||
    !/rgb\(255,\s*255,\s*255\)/.test(box.saveColor ?? "")
  ) {
    throw new Error(`${label} 保存按钮没有深色底白字 ${JSON.stringify(box)}`);
  }
  if (
    box.gatewayRight > box.panelRight + 1 ||
    box.gatewayWidth < box.width - 56
  ) {
    throw new Error(`${label} Gateway 输入被裁切 ${JSON.stringify(box)}`);
  }
  for (const action of box.actions) {
    if (!action.inside || !action.uncovered || action.width < 8) {
      throw new Error(`${label} 按钮不可见 ${JSON.stringify(action)}`);
    }
  }
  if (!box.sendOneLine)
    throw new Error(`发送按钮文字被挤成两行 ${JSON.stringify(box)}`);
  if (box.avatars.some((item) => item.overflowX > 1 || item.overflowY > 1)) {
    throw new Error(`预设头像文字挤出 ${JSON.stringify(box.avatars)}`);
  }
}

function writesFor(report, runId) {
  return (report.effectRows ?? [])
    .filter((row) => row.runId === runId && row.kind === "write")
    .map((row) => ({
      effectKey: row.effectKey,
      runId: row.runId,
      approvalId: row.approvalId,
      file: row.file,
    }));
}

async function approvalButtons(evalJs) {
  return evalJs(`(() => {
    const card = document.querySelector('[data-action="approve"]')?.closest("article");
    if (!card) return [];
    return [...card.querySelectorAll("button")].map((button) => ({
      label: button.textContent.trim(),
      disabled: button.disabled,
    }));
  })()`);
}

async function repeatDisabledClicks(evalJs, send) {
  await evalJs(`(() => {
    window.__paDecidePosts = 0;
    const original = window.fetch;
    window.fetch = function(input, init) {
      const url = String(input);
      const body = init && init.body ? String(init.body) : "";
      if (url.includes("/v1/commands") && body.includes("approval.decide")) {
        window.__paDecidePosts += 1;
      }
      return original.apply(this, arguments);
    };
    return true;
  })()`);
  const fired = {};
  for (const label of ["批准", "拒绝"]) {
    const box = await evalJs(`(() => {
      const button = [...document.querySelectorAll("article.card button")]
        .find((item) => item.textContent.trim() === ${JSON.stringify(label)});
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        disabled: button.disabled,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    })()`);
    if (!box) {
      fired[label] = { found: false, disabled: null };
      continue;
    }
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    fired[label] = { found: true, disabled: box.disabled };
  }
  await sleep(400);
  const posts = await evalJs("window.__paDecidePosts");
  return { fired, decidePosts: posts };
}

async function effects() {
  const response = await fetch(`${base}/v1/test/summary`);
  if (!response.ok)
    return { effects: null, maxSeq: null, note: "test hooks disabled" };
  return response.json();
}

function listNotes() {
  const dir = path.join(dataDir, "sandbox", "notes");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
}

async function shot(send, file) {
  const image = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(image.data, "base64"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
