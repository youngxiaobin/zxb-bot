import type { FaultName } from "@pa/contracts";

type Hold = { promise: Promise<void>; release: () => void };

export class FaultController {
  name: FaultName | null = null;
  delayMs = 0;
  replayDelayMs = 0;
  dropResponses = 0;
  private hold: Hold | null = null;

  set(
    name: FaultName,
    extra?: { delayMs?: number; replayDelayMs?: number },
  ): void {
    if (name === "clear") {
      this.hold?.release();
      this.name = null;
      this.delayMs = 0;
      this.replayDelayMs = 0;
      this.dropResponses = 0;
      this.hold = null;
      return;
    }
    this.name = name;
    this.delayMs = extra?.delayMs ?? 0;
    this.replayDelayMs = extra?.replayDelayMs ?? 0;
    if (name === "drop_response_once") this.dropResponses += 1;
    if (name === "hold_before_effect" || name === "hold_after_effect") {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.hold = { promise, release };
    }
  }

  release(name?: string): void {
    if (name && this.name !== name) return;
    this.hold?.release();
    this.hold = null;
  }

  async delayBeforeEffect(signal: AbortSignal): Promise<void> {
    if (this.name !== "delay_before_tool_effect" && this.delayMs <= 0) return;
    const ms = this.delayMs || 0;
    if (ms <= 0 || this.name !== "delay_before_tool_effect") return;
    await sleep(ms, signal);
  }

  async holdBefore(): Promise<void> {
    if (this.name !== "hold_before_effect" || !this.hold) return;
    await this.hold.promise;
  }

  async holdAfter(): Promise<void> {
    if (this.name !== "hold_after_effect" || !this.hold) return;
    await this.hold.promise;
  }

  crashIfNeeded(): void {
    if (this.name === "effect_succeed_then_crash_before_result") {
      process.kill(process.pid, "SIGKILL");
    }
  }

  shouldLagCheckpoint(): boolean {
    return this.name === "skip_checkpoint_advance";
  }

  shouldExitAfterApproval(): boolean {
    return this.name === "exit_after_approval_before_resume";
  }

  async delayReplay(): Promise<void> {
    if (this.name !== "delay_replay" || this.replayDelayMs <= 0) return;
    await sleep(this.replayDelayMs);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error("工具调用超时"), { code: "TOOL_TIMEOUT" }),
      );
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
