import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command, interrupt } from "@langchain/langgraph";
import {
  TOOL_LIST,
  TOOL_LIST_VERSION,
  TOOL_READ,
  TOOL_READ_VERSION,
  TOOL_WRITE,
  TOOL_WRITE_VERSION,
  type DurableEvent,
  type EphemeralPreview,
} from "@pa/contracts";
import { sha256Json, type AppStore } from "@pa/persistence";
import { FaultController } from "./faults.js";
import { compileRunGraph } from "./graph.js";
import {
  listFixtures,
  PathRejected,
  readFixture,
  writeDemoNote,
} from "./paths.js";
import { redactValue } from "./redact.js";

type SqlRow = Record<string, unknown>;
type Effect = "none" | "applied" | "unknown";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

export class AgentRuntime {
  readonly faults = new FaultController();
  readonly secrets: string[];
  private store: AppStore;
  private fixturesDir: string;
  private dataDir: string;
  private approvalTtlMs: number;
  private toolTimeoutMs: number;
  private openai: { apiKey: string; baseUrl?: string; model: string } | null;
  private checkpointPath: string;
  private graph: ReturnType<typeof compileRunGraph>["graph"];
  private saver: ReturnType<typeof compileRunGraph>["saver"];
  private tails = new Map<string, Promise<void>>();
  private eventListeners = new Set<(event: DurableEvent) => void>();
  private ephemeralListeners = new Set<(frame: EphemeralPreview) => void>();

  constructor(options: {
    store: AppStore;
    fixturesDir: string;
    dataDir: string;
    approvalTtlMs: number;
    toolTimeoutMs: number;
    openai: { apiKey: string; baseUrl?: string; model: string } | null;
    secrets: string[];
  }) {
    this.store = options.store;
    this.fixturesDir = options.fixturesDir;
    this.dataDir = options.dataDir;
    this.approvalTtlMs = options.approvalTtlMs;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.openai = options.openai;
    this.secrets = options.secrets;
    this.checkpointPath = path.join(options.dataDir, "checkpoints.sqlite");
    const compiled = compileRunGraph(this.checkpointPath, (state) =>
      this.step(state),
    );
    this.graph = compiled.graph;
    this.saver = compiled.saver;
  }

  onEvent(listener: (event: DurableEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onEphemeral(listener: (frame: EphemeralPreview) => void): () => void {
    this.ephemeralListeners.add(listener);
    return () => this.ephemeralListeners.delete(listener);
  }

  async startup(): Promise<void> {
    this.publish(this.store.reconcileDispatching());
    for (const runId of this.store.activeRootIds()) {
      await this.kick(runId);
    }
  }

  async reload(): Promise<void> {
    this.saver.db.close();
    const compiled = compileRunGraph(this.checkpointPath, (state) =>
      this.step(state),
    );
    this.graph = compiled.graph;
    this.saver = compiled.saver;
    await this.startup();
  }

  close(): void {
    this.saver.db.close();
  }

  kick(runId: string): Promise<void> {
    const prev = this.tails.get(runId) ?? Promise.resolve();
    const next = prev.then(
      () => this.drive(runId),
      () => this.drive(runId),
    );
    this.tails.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private publish(events: DurableEvent[]): void {
    for (const event of events) {
      const scrubbed = {
        ...event,
        payload: redactValue(event.payload, this.secrets) as Record<
          string,
          unknown
        >,
      };
      for (const listener of this.eventListeners) listener(scrubbed);
    }
  }

  private preview(runId: string, text: string): void {
    const frame: EphemeralPreview = {
      type: "ephemeral.preview",
      runId,
      text: String(redactValue(text, this.secrets)),
    };
    for (const listener of this.ephemeralListeners) listener(frame);
  }

  private async drive(runId: string): Promise<void> {
    if (!this.store.heartbeat()) {
      throw Object.assign(new Error("执行器租约已失效"), {
        code: "FENCE_LOST",
      });
    }
    const run = this.store.getRun(runId);
    if (!run || TERMINAL.has(String(run.status))) return;
    const config = { configurable: { thread_id: runId } };
    const snap = await this.graph.getState(config);
    const tasks = snap.tasks ?? [];
    const errored = tasks.some((task) => Boolean(task.error));
    const interrupted =
      (snap.next?.length ?? 0) > 0 ||
      tasks.some((task) => (task.interrupts?.length ?? 0) > 0);
    const started = Boolean((snap.values as { runId?: string }).runId);
    if (!started && !interrupted && !errored) {
      await this.graph.invoke({ runId, done: false }, config);
      return;
    }
    if (errored) {
      await this.graph.invoke(null, config);
      return;
    }
    if (interrupted) {
      const write = this.writeTool(runId);
      if (
        write &&
        (write.status === "awaiting_approval" || write.status === "intent")
      )
        return;
      await this.graph.invoke(new Command({ resume: { wake: true } }), config);
    }
  }

  private async step(state: {
    runId: string;
    done: boolean;
  }): Promise<{ runId: string; done: boolean }> {
    await this.progress(state.runId);
    return { runId: state.runId, done: true };
  }

  private async progress(runId: string): Promise<void> {
    const run = this.mustRun(runId);
    if (TERMINAL.has(String(run.status))) return;
    if (this.deadlineExceeded(run)) {
      this.finishTerminal(run, {
        status: "timed_out",
        resultCode: "run_deadline",
        errorCode: "RUN_DEADLINE",
        errorMessage: "运行的执行时限已到。等待审批的时间不计入这段时限。",
        content: "执行时限已到，未继续调用工具。",
        effect: "none",
        eventType: "run.timed_out",
      });
      return;
    }
    const stage = String(run.stage);
    if (stage === "created" || stage === "working") {
      this.store.armDeadline(runId);
      if (run.provider_mode === "live") await this.liveWork(run);
      else await this.demoWork(run);
    }
    await this.finishWrite(runId);
  }

  private async demoWork(run: SqlRow): Promise<void> {
    const runId = String(run.id);
    this.store.patchRun(runId, { stage: "working", status: "running" });
    if (!this.modelStep(runId, "plan")) return;
    const script = String(run.script);
    if (script === "budget_burn") {
      await this.budgetBurn(run);
      this.store.patchRun(runId, {
        stage: "finalizing",
        output_draft: "预算演练只做只读调用。",
      });
      return;
    }
    if (script === "slow_read") {
      await this.oneRead(run, "slow:read", "weekly-notes.md");
      this.store.patchRun(runId, {
        stage: "finalizing",
        output_draft: "慢读取演练没有写入。",
      });
      return;
    }
    await this.runSpecialists(run);
    if (!this.modelStep(runId, "synthesize")) return;
    const draft = this.compose(runId);
    this.preview(
      runId,
      draft.slice(0, Math.max(1, Math.ceil(draft.length / 2))),
    );
    this.preview(runId, draft);
    this.store.patchRun(runId, { output_draft: draft });
    const begun = this.store.beginTool({
      logicalKey: "write_demo_note",
      runId,
      rootRunId: runId,
      userId: String(run.user_id),
      sessionId: String(run.session_id),
      toolName: TOOL_WRITE,
      toolVersion: TOOL_WRITE_VERSION,
      params: { title: "个人助理摘要", body: draft },
      paramsHash: sha256Json({ title: "个人助理摘要", body: draft }),
      resource: `sandbox/notes/${runId}.md`,
      sideEffect: true,
      requiresApproval: true,
      approvalTtlMs: this.approvalTtlMs,
    });
    if (begun.blocked) {
      this.publish([begun.event]);
      this.store.patchRun(runId, { stage: "finalizing" });
      return;
    }
    this.publish(begun.events);
  }

  private async liveWork(run: SqlRow): Promise<void> {
    const runId = String(run.id);
    if (!this.openai?.apiKey) {
      this.finishTerminal(run, {
        status: "failed",
        resultCode: "provider_not_configured",
        errorCode: "PROVIDER_NOT_CONFIGURED",
        errorMessage: "未配置实况模型。系统没有改用演示提供方。",
        content: "实况模型未配置，本次没有执行，也没有切换到演示。",
        effect: "none",
        eventType: "run.failed",
      });
      return;
    }
    const { completeLive } = await import("./live.js");
    const user = this.store.getMessage(String(run.root_message_id));
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      {
        role: "system",
        content:
          "你是 Personal Agent 的协调者。只能使用提供的工具。两名专员只读且不能再委托。写入必须调用 write_demo_note，运行时会先请求人工批准。不要声称自己是其他产品。",
      },
      { role: "user", content: String(user?.content ?? "") },
    ];
    for (let step = 0; step < 6; step += 1) {
      if (!this.modelStep(runId, "live")) return;
      const decision = await completeLive({
        apiKey: this.openai.apiKey,
        baseUrl: this.openai.baseUrl,
        model: this.openai.model,
        messages,
        timeoutMs: this.toolTimeoutMs,
      });
      if (decision.toolCalls.length === 0) {
        this.store.patchRun(runId, {
          stage: "finalizing",
          output_draft: decision.text,
        });
        return;
      }
      for (const call of decision.toolCalls) {
        if (call.name === "delegate_specialists") {
          await this.runSpecialists(run);
          messages.push({ role: "assistant", content: this.compose(runId) });
        } else if (call.name === "write_demo_note") {
          const body = String(call.args.body ?? decision.text ?? "");
          const title = String(call.args.title ?? "个人助理摘要");
          const begun = this.store.beginTool({
            logicalKey: "write_demo_note",
            runId,
            rootRunId: runId,
            userId: String(run.user_id),
            sessionId: String(run.session_id),
            toolName: TOOL_WRITE,
            toolVersion: TOOL_WRITE_VERSION,
            params: { title, body },
            paramsHash: sha256Json({ title, body }),
            resource: `sandbox/notes/${runId}.md`,
            sideEffect: true,
            requiresApproval: true,
            approvalTtlMs: this.approvalTtlMs,
          });
          if (!begun.blocked) this.publish(begun.events);
          else this.publish([begun.event]);
          this.store.patchRun(runId, { output_draft: body });
          return;
        } else if (call.name === TOOL_READ || call.name === TOOL_LIST) {
          const name = String(call.args.name ?? "weekly-notes.md");
          await this.oneRead(
            run,
            `live:${call.name}:${name}`,
            call.name === TOOL_LIST ? "" : name,
            call.name === TOOL_LIST,
          );
        }
      }
    }
    this.finishTerminal(run, {
      status: "failed",
      resultCode: "model_step_limit",
      errorCode: "MODEL_STEP_LIMIT",
      errorMessage: "实况模型步数已到上限。",
      content: "模型步数达到上限，已停止。",
      effect: "none",
      eventType: "run.failed",
    });
  }

  private async finishWrite(runId: string): Promise<void> {
    const write = this.writeTool(runId);
    if (
      write &&
      (write.status === "awaiting_approval" ||
        (write.status === "intent" && Number(write.side_effect) === 1))
    ) {
      interrupt({
        approvalId: write.approval_id,
        toolCallId: write.id,
        paramsHash: write.params_hash,
      });
    }
    const current = this.writeTool(runId);
    const run = this.mustRun(runId);
    if (!current) {
      if (
        String(run.stage) === "finalizing" ||
        String(run.script) !== "standard"
      ) {
        const draft = String(run.output_draft ?? "没有需要写入的内容。");
        this.finishTerminal(run, {
          status:
            String(run.error_code) === "TOOL_TIMEOUT" ? "failed" : "completed",
          resultCode:
            String(run.error_code) === "TOOL_TIMEOUT"
              ? "tool_timeout"
              : "read_only_done",
          errorCode: run.error_code ? String(run.error_code) : null,
          errorMessage: run.error_message ? String(run.error_message) : null,
          content: draft,
          effect: "none",
          eventType:
            String(run.error_code) === "TOOL_TIMEOUT"
              ? "run.failed"
              : "run.completed",
        });
      }
      return;
    }
    if (current.status === "ready") {
      await this.executeTool(current, true);
    }
    const after = this.writeTool(runId);
    const fresh = this.mustRun(runId);
    if (!after) return;
    if (after.status === "succeeded") {
      if (this.faults.shouldLagCheckpoint()) {
        this.faults.set("clear");
        throw new Error("skip_checkpoint_advance");
      }
      const resource = String(after.resource);
      this.finishTerminal(fresh, {
        status: fresh.cancel_requested_at ? "cancelled" : "completed",
        resultCode: fresh.cancel_requested_at
          ? "cancelled_with_late_result"
          : "write_applied",
        errorCode: null,
        errorMessage: null,
        content: `${fresh.output_draft ?? ""}\n\n已写入 ${resource}。`,
        effect: "applied",
        resource,
        eventType: fresh.cancel_requested_at
          ? "run.cancelled"
          : "run.completed",
        preserveCancelled: Boolean(fresh.cancel_requested_at),
      });
      return;
    }
    if (after.status === "outcome_unknown") {
      this.finishTerminal(fresh, {
        status: "failed",
        resultCode: "outcome_unknown",
        errorCode: "OUTCOME_UNKNOWN",
        errorMessage: "副作用结果未知，没有自动重放。",
        content:
          "写入结果未知。系统没有自动再写一次，请人工核对 sandbox/notes。",
        effect: "unknown",
        resource: String(after.resource),
        eventType: "run.failed",
      });
      return;
    }
    if (after.status === "rejected" || after.status === "cancelled") {
      const expired = after.error_code === "approval_expired";
      this.finishTerminal(fresh, {
        status: expired
          ? "failed"
          : fresh.cancel_requested_at
            ? "cancelled"
            : "completed",
        resultCode: expired
          ? "approval_expired"
          : fresh.cancel_requested_at
            ? "user_cancelled"
            : "approval_rejected",
        errorCode: after.error_code ? String(after.error_code) : null,
        errorMessage: after.error_message ? String(after.error_message) : null,
        content: expired
          ? "审批已过期，写入没有执行。"
          : "已拒绝或取消写入，没有产生文件变更。",
        effect: "none",
        resource: String(after.resource),
        eventType: expired
          ? "run.failed"
          : fresh.cancel_requested_at
            ? "run.cancelled"
            : "run.completed",
        preserveCancelled: Boolean(fresh.cancel_requested_at),
      });
    }
  }

  private async budgetBurn(run: SqlRow): Promise<void> {
    const root = this.mustRun(String(run.id));
    if (Number(root.budget_reserved) >= Number(root.budget_total)) return;
    for (let index = 1; index <= Number(root.budget_total) + 1; index += 1) {
      const latest = this.mustRun(String(run.id));
      if (
        Number(latest.budget_reserved) >= Number(latest.budget_total) &&
        index > Number(latest.budget_reserved)
      ) {
        const begun = this.store.beginTool(
          this.readInput(run, `read:${index}`, "weekly-notes.md"),
        );
        if (begun.blocked) this.publish([begun.event]);
        else this.publish(begun.events);
        break;
      }
      await this.oneRead(run, `read:${index}`, "weekly-notes.md");
    }
  }

  private async oneRead(
    run: SqlRow,
    logicalKey: string,
    name: string,
    list = false,
  ): Promise<void> {
    const begun = list
      ? this.store.beginTool(this.listInput(run, logicalKey))
      : this.store.beginTool(this.readInput(run, logicalKey, name));
    if (begun.blocked) {
      this.publish([begun.event]);
      return;
    }
    this.publish(begun.events);
    await this.executeTool(begun.tool, false);
  }

  private async runSpecialists(run: SqlRow): Promise<void> {
    const roles = [
      {
        role: "fixture_research",
        files: ["weekly-notes.md", "project-brief.md"],
        list: true,
      },
      { role: "outline_planner", files: ["project-brief.md"], list: false },
    ] as const;
    await Promise.all(roles.map(async (role) => this.runExpert(run, role)));
  }

  private async runExpert(
    run: SqlRow,
    role: {
      role: "fixture_research" | "outline_planner";
      files: readonly string[];
      list: boolean;
    },
  ): Promise<void> {
    await Promise.resolve();
    const goal = String(
      this.store.getMessage(String(run.root_message_id))?.content ?? "",
    );
    const isolated = {
      role: role.role,
      goal,
      files: role.files,
      boundary:
        "只收到这个目标和允许的文件名，没有父运行草稿，也没有另一名专员的输出。不能再委托，不能写入。",
    };
    const created = this.store.transaction(() =>
      this.store.ensureExpert({
        root: run,
        role: role.role,
        isolatedInput: isolated,
      }),
    );
    if (created.created) {
      this.publish([
        this.store.transaction(() =>
          this.store.addEvent({
            userId: String(run.user_id),
            channelId: String(run.channel_id),
            sessionId: String(run.session_id),
            runId: String(run.id),
            taskId: String(created.task.id),
            type: "specialist.started",
            payload: { role: role.role, taskId: created.task.id, isolated },
          }),
        ),
      ]);
    }
    const task = this.store
      .listExpertTasks(String(run.id))
      .find((item) => item.role === role.role);
    if (!task || task.status === "completed" || task.status === "failed")
      return;
    const partial =
      String(run.script) === "partial_fail" && role.role === "outline_planner";
    try {
      if (partial) {
        const begun = this.store.beginTool(
          this.readInput(
            run,
            `${role.role}:attempt`,
            "project-brief.md",
            String(created.runId),
          ),
        );
        if (!begun.blocked) {
          this.publish(begun.events);
          const token = randomUUID();
          const claim = this.store.claimTool(
            String(begun.tool.id),
            "intent",
            token,
          );
          if (claim.claimed) {
            this.store.finishTool(String(begun.tool.id), token, "failed", {
              errorCode: "specialist_forced_failure",
              errorMessage: "提纲专员按演练失败，没有生成替代结论。",
            });
            this.publish([
              this.store.transaction(() =>
                this.store.addEvent({
                  userId: String(run.user_id),
                  channelId: null,
                  sessionId: String(run.session_id),
                  runId: String(run.id),
                  taskId: String(begun.tool.id),
                  type: "tool.failed",
                  payload: {
                    toolCallId: begun.tool.id,
                    errorCode: "specialist_forced_failure",
                    message: "提纲专员失败，未读取后的内容不会被编造。",
                  },
                }),
              ),
            ]);
          }
        } else this.publish([begun.event]);
        this.store.finishExpert(String(task.id), {
          status: "failed",
          errorCode: "specialist_forced_failure",
          errorMessage: "提纲专员失败。已保留研究专员的真实引用。",
        });
        this.publish([
          this.store.transaction(() =>
            this.store.addEvent({
              userId: String(run.user_id),
              channelId: String(run.channel_id),
              sessionId: String(run.session_id),
              runId: String(run.id),
              taskId: String(task.id),
              type: "specialist.failed",
              payload: {
                role: role.role,
                errorCode: "specialist_forced_failure",
              },
            }),
          ),
        ]);
        return;
      }
      const collected: unknown[] = [];
      if (role.list) {
        const listed = await this.readForExpert(
          run,
          created.runId,
          `${role.role}:list`,
          "",
          true,
        );
        if (listed.blocked) {
          this.failExpert(
            run,
            task,
            role.role,
            collected,
            "BUDGET_EXHAUSTED",
            "预算不足，缺少的文件没有被编造。",
          );
          return;
        }
        collected.push(listed.result);
      }
      for (const file of role.files) {
        const read = await this.readForExpert(
          run,
          created.runId,
          `${role.role}:read:${file}`,
          file,
          false,
        );
        if (read.blocked) {
          this.failExpert(
            run,
            task,
            role.role,
            collected,
            "BUDGET_EXHAUSTED",
            "预算不足，缺少的文件没有被编造。",
          );
          return;
        }
        collected.push(read.result);
      }
      this.store.finishExpert(String(task.id), {
        status: "completed",
        output: { observations: collected },
      });
      this.publish([
        this.store.transaction(() =>
          this.store.addEvent({
            userId: String(run.user_id),
            channelId: String(run.channel_id),
            sessionId: String(run.session_id),
            runId: String(run.id),
            taskId: String(task.id),
            type: "specialist.completed",
            payload: { role: role.role, output: { observations: collected } },
          }),
        ),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "专员失败";
      this.failExpert(run, task, role.role, [], "specialist_failed", message);
    }
  }

  private failExpert(
    run: SqlRow,
    task: SqlRow,
    role: string,
    partial: unknown[],
    code: string,
    message: string,
  ): void {
    this.store.finishExpert(String(task.id), {
      status: "failed",
      output: { partial },
      errorCode: code,
      errorMessage: message,
    });
    this.publish([
      this.store.transaction(() =>
        this.store.addEvent({
          userId: String(run.user_id),
          channelId: String(run.channel_id),
          sessionId: String(run.session_id),
          runId: String(run.id),
          taskId: String(task.id),
          type: "specialist.failed",
          payload: { role, errorCode: code, message, partial },
        }),
      ),
    ]);
  }

  private async readForExpert(
    run: SqlRow,
    expertRunId: string,
    logicalKey: string,
    name: string,
    list: boolean,
  ): Promise<{ blocked: boolean; result: unknown }> {
    const begun = list
      ? this.store.beginTool(this.listInput(run, logicalKey, expertRunId))
      : this.store.beginTool(
          this.readInput(run, logicalKey, name, expertRunId),
        );
    if (begun.blocked) {
      this.publish([begun.event]);
      return { blocked: true, result: null };
    }
    this.publish(begun.events);
    const result = await this.executeTool(begun.tool, false);
    return { blocked: false, result };
  }

  private async executeTool(
    tool: SqlRow,
    sideEffect: boolean,
  ): Promise<unknown> {
    if (
      [
        "succeeded",
        "failed",
        "rejected",
        "cancelled",
        "outcome_unknown",
      ].includes(String(tool.status))
    ) {
      return tool.result_json ? JSON.parse(String(tool.result_json)) : null;
    }
    if (tool.status === "dispatching") return null;
    const from = sideEffect ? "ready" : "intent";
    if (tool.status !== from) return null;
    const token = randomUUID();
    const claim = this.store.claimTool(String(tool.id), from, token);
    if (!claim.claimed) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.toolTimeoutMs);
    try {
      await this.faults.delayBeforeEffect(controller.signal);
      await this.faults.holdBefore();
      const root = this.mustRun(String(tool.root_run_id));
      if (sideEffect && root.cancel_requested_at) {
        this.store.finishTool(String(tool.id), token, "cancelled", {
          errorCode: "user_cancelled",
          errorMessage: "取消发生在副作用之前，没有写入。",
        });
        return null;
      }
      const params = JSON.parse(String(tool.params_json)) as {
        name?: string;
        body?: string;
        title?: string;
      };
      let result: unknown;
      if (sideEffect) {
        try {
          const written = writeDemoNote(
            this.dataDir,
            String(tool.root_run_id),
            String(params.body ?? ""),
          );
          this.store.insertEffect(
            String(tool.id),
            String(tool.root_run_id),
            "write",
            written.path,
          );
          result = written;
        } catch (error) {
          const coded = error as { code?: string };
          if (coded.code === "EEXIST") {
            this.store.finishTool(String(tool.id), token, "outcome_unknown", {
              errorCode: "OUTCOME_UNKNOWN",
              errorMessage:
                "目标文件已存在，系统没有覆盖，也没有把它当成新的成功写入。",
            });
            return null;
          }
          throw error;
        }
        await this.faults.holdAfter();
        this.faults.crashIfNeeded();
      } else if (String(tool.tool_name) === TOOL_LIST) {
        result = { files: listFixtures(this.fixturesDir) };
      } else {
        result = readFixture(this.fixturesDir, String(params.name));
      }
      this.store.finishTool(String(tool.id), token, "succeeded", { result });
      this.publish([
        this.store.transaction(() =>
          this.store.addEvent({
            userId: String(tool.user_id),
            channelId: null,
            sessionId: String(tool.session_id),
            runId: String(tool.root_run_id),
            taskId: String(tool.id),
            type: "tool.completed",
            payload: {
              toolCallId: tool.id,
              toolName: tool.tool_name,
              resource: tool.resource,
              result,
            },
          }),
        ),
      ]);
      return result;
    } catch (error) {
      const coded = error as { code?: string; message?: string };
      const code =
        controller.signal.aborted || coded.code === "TOOL_TIMEOUT"
          ? "TOOL_TIMEOUT"
          : coded.code === "PATH_REJECTED" || error instanceof PathRejected
            ? "PATH_REJECTED"
            : "TOOL_FAILED";
      const message = coded.message ?? "工具失败";
      this.store.finishTool(String(tool.id), token, "failed", {
        errorCode: code,
        errorMessage: message,
      });
      if (code === "TOOL_TIMEOUT") {
        this.store.patchRun(String(tool.root_run_id), {
          error_code: "TOOL_TIMEOUT",
          error_message: message,
        });
      }
      this.publish([
        this.store.transaction(() =>
          this.store.addEvent({
            userId: String(tool.user_id),
            channelId: null,
            sessionId: String(tool.session_id),
            runId: String(tool.root_run_id),
            taskId: String(tool.id),
            type: "tool.failed",
            payload: { toolCallId: tool.id, errorCode: code, message },
          }),
        ),
      ]);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private finishTerminal(
    run: SqlRow,
    input: {
      status: string;
      resultCode: string;
      errorCode: string | null;
      errorMessage: string | null;
      content: string;
      effect: Effect;
      resource?: string | null;
      eventType:
        | "run.completed"
        | "run.failed"
        | "run.cancelled"
        | "run.timed_out";
      preserveCancelled?: boolean;
    },
  ): void {
    const events = this.store.transaction(() => {
      const fresh = this.mustRun(String(run.id));
      if (this.store.assistantMessageForRun(String(fresh.id))) return [];
      const preserve =
        input.preserveCancelled &&
        (fresh.cancel_requested_at || fresh.status === "cancelled");
      const status = preserve ? "cancelled" : input.status;
      if (!TERMINAL.has(String(fresh.status)) || fresh.status === "cancelled") {
        if (!(fresh.status === "cancelled" && status !== "cancelled")) {
          this.store.patchRun(String(fresh.id), {
            status,
            result_code: input.resultCode,
            error_code: input.errorCode,
            error_message: input.errorMessage,
            stage: "done",
            terminal_at: new Date().toISOString(),
            active_deadline_at: null,
          });
        }
      }
      const messageId = this.store.insertAssistantMessage({
        run: fresh,
        content: input.content,
      });
      const produced: DurableEvent[] = [
        this.store.addEvent({
          userId: String(fresh.user_id),
          channelId: String(fresh.channel_id),
          sessionId: String(fresh.session_id),
          runId: String(fresh.id),
          type: "message.assistant.completed",
          payload: {
            messageId,
            runId: fresh.id,
            sessionId: fresh.session_id,
            content: input.content,
          },
        }),
        this.store.addEvent({
          userId: String(fresh.user_id),
          channelId: String(fresh.channel_id),
          sessionId: String(fresh.session_id),
          runId: String(fresh.id),
          type: preserve ? "run.cancelled" : input.eventType,
          payload: { runId: fresh.id, resultCode: input.resultCode },
        }),
        this.store.addEvent({
          userId: String(fresh.user_id),
          channelId: null,
          sessionId: String(fresh.session_id),
          runId: String(fresh.id),
          type: "run.outcome",
          payload: {
            runId: fresh.id,
            sessionId: fresh.session_id,
            resultCode: input.resultCode,
            effect: input.effect,
            resource: input.resource ?? null,
            excerpt: input.content.slice(0, 280),
          },
        }),
      ];
      return produced;
    });
    this.publish(events);
  }

  private compose(runId: string): string {
    const tasks = this.store.listExpertTasks(runId);
    const lines = [
      "以下内容只转述已经落账的专员结果；失败的专员不会被补写成成功结论。",
    ];
    for (const task of tasks) {
      if (task.status === "completed") {
        lines.push(`专员 ${task.role} 的来源：`);
        lines.push(formatEvidence(String(task.output_json)));
      } else {
        lines.push(
          `专员 ${task.role} 失败：${task.error_code ?? ""} ${task.error_message ?? ""}。没有采用该专员的结论。`,
        );
      }
    }
    if (tasks.length === 0) lines.push("没有专员结果。");
    return lines.join("\n");
  }

  private modelStep(runId: string, phase: string): boolean {
    const ok = this.store.recordModelStep(runId);
    const run = this.mustRun(runId);
    if (!ok) {
      this.finishTerminal(run, {
        status: "failed",
        resultCode: "model_step_limit",
        errorCode: "MODEL_STEP_LIMIT",
        errorMessage: "模型步数达到上限。",
        content: "模型步数达到上限，已停止。",
        effect: "none",
        eventType: "run.failed",
      });
      return false;
    }
    this.publish([
      this.store.transaction(() =>
        this.store.addEvent({
          userId: String(run.user_id),
          channelId: String(run.channel_id),
          sessionId: String(run.session_id),
          runId,
          type: "run.model_step",
          payload: {
            runId,
            phase,
            modelSteps: this.mustRun(runId).model_steps,
            providerMode: run.provider_mode,
          },
        }),
      ),
    ]);
    return true;
  }

  private readInput(
    run: SqlRow,
    logicalKey: string,
    name: string,
    runId = String(run.id),
  ) {
    const params = { name };
    return {
      logicalKey,
      runId,
      rootRunId: String(run.id),
      userId: String(run.user_id),
      sessionId: String(run.session_id),
      toolName: TOOL_READ,
      toolVersion: TOOL_READ_VERSION,
      params,
      paramsHash: sha256Json(params),
      resource: `fixtures/${name}`,
      sideEffect: false,
      requiresApproval: false,
      approvalTtlMs: this.approvalTtlMs,
    };
  }

  private listInput(run: SqlRow, logicalKey: string, runId = String(run.id)) {
    const params = {};
    return {
      logicalKey,
      runId,
      rootRunId: String(run.id),
      userId: String(run.user_id),
      sessionId: String(run.session_id),
      toolName: TOOL_LIST,
      toolVersion: TOOL_LIST_VERSION,
      params,
      paramsHash: sha256Json(params),
      resource: "fixtures",
      sideEffect: false,
      requiresApproval: false,
      approvalTtlMs: this.approvalTtlMs,
    };
  }

  private writeTool(runId: string): SqlRow | null {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM tool_calls WHERE root_run_id=? AND logical_key='write_demo_note'",
      )
      .get(runId) as SqlRow | undefined;
    return rows ?? null;
  }

  private mustRun(id: string): SqlRow {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`运行不存在: ${id}`);
    return run;
  }

  private deadlineExceeded(run: SqlRow): boolean {
    if (!run.active_deadline_at) return false;
    return Date.now() > Date.parse(String(run.active_deadline_at));
  }
}

function formatEvidence(outputJson: string): string {
  try {
    const parsed = JSON.parse(outputJson) as {
      observations?: Array<{ files?: string[]; path?: string; text?: string }>;
    };
    const observations = parsed.observations ?? [];
    if (observations.length === 0) return outputJson;
    return observations
      .map((item) => {
        if (item.files) return `目录：${item.files.join("、")}`;
        if (item.path && item.text) return `来源 ${item.path}\n${item.text}`;
        return JSON.stringify(item);
      })
      .join("\n");
  } catch {
    return outputJson;
  }
}
