import {
  formatDuration,
  type ProgressEvent,
  type ProgressModel,
  type ProgressBlock,
  type ProgressTarget,
} from "@thor/common";
import type { SlackProgressTransport, SlackProgressTransportTarget } from "./slack-progress.js";

/** One request owns native loading, one compact footer and frozen-source reactions; no global registries. */
export class PiSlackPresentation {
  private line = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private finished = false;
  private threshold = false;
  private activity: "thinking" | "working" | "responding" = "thinking";
  private model?: ProgressModel;
  private tools = new Set<string>();
  private lastWrite = 0;
  private messageTs?: string;
  private nativeAvailable = true;
  private phaseDue?: number;
  private nextTick: number;

  constructor(
    private readonly target: ProgressTarget<SlackProgressTransportTarget>,
    private readonly transport: SlackProgressTransport,
    private readonly startedAt: number,
    private readonly saveFooter: (ts: string | undefined) => Promise<void>,
    footerTs?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.messageTs = footerTs;
    this.nextTick = this.now() + 1500;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.line = this.line.then(work).catch(() => undefined);
    return this.line;
  }

  /** Acknowledgement precedes even a fast completion; queued work never calls start. */
  async start(isActive: () => Promise<boolean> = async () => true): Promise<void> {
    await this.enqueue(async () => {
      await this.removeFooter();
      try {
        await this.transport.addReaction(this.target.transportTarget, this.target.sourceTs, "eyes");
      } catch {
        /* best effort */
      }
      const active = await isActive();
      this.finished = !active;
      await this.status(active ? "processing" : "active");
    });
    this.schedule();
  }

  private async status(status: "processing" | "suspended" | "active"): Promise<void> {
    if (!this.transport.setStatus || (!this.nativeAvailable && status === "processing")) return;
    try {
      const result = await this.transport.setStatus(this.target.transportTarget, status);
      this.nativeAvailable = result.state === "confirmed";
    } catch {
      this.nativeAvailable = false;
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.finished) return;
    const due = Math.min(this.nextTick, this.phaseDue ?? Infinity);
    this.timer = setTimeout(
      () => {
        void this.enqueue(async () => {
          if (this.finished) return;
          this.threshold = true;
          this.phaseDue = undefined;
          await this.footer();
          if (this.transport.statusMode === "verified-legacy") await this.status("processing");
          this.nextTick =
            this.now() + (this.transport.statusMode === "verified-legacy" ? 30_000 : 10_000);
        }).then(() => this.schedule());
      },
      Math.max(0, due - this.now()),
    );
    this.timer.unref?.();
  }

  /** Native snapshots restore accounting but cannot count as newly completed calls or trigger the grace threshold. */
  async event(event: ProgressEvent): Promise<void> {
    if (this.finished) return;
    switch (event.type) {
      case "model":
        this.model = event;
        break;
      case "activity":
        if (this.activity === event.activity) return;
        this.activity = event.activity;
        break;
      case "tools_snapshot":
        this.tools = new Set(event.tools.map((tool) => tool.toolCallId));
        return;
      case "tool":
        if (event.status === "running") return;
        if (event.toolCallId) this.tools.add(event.toolCallId);
        if (!this.threshold && this.tools.size >= 3) {
          this.threshold = true;
          await this.enqueue(() => (this.finished ? Promise.resolve() : this.footer()));
          return;
        }
        break;
      default:
        return; // No tool arguments, paths, model prose, private reasoning or token writes.
    }
    if (!this.threshold) return;
    if (this.activity === "responding") {
      this.phaseDue = undefined;
      await this.enqueue(() => (this.finished ? Promise.resolve() : this.footer()));
    } else {
      // Latest phase/model wins; make short nonterminal phases readable without delaying cleanup.
      this.phaseDue = Math.max(this.now() + 300, this.lastWrite + 1200);
      this.schedule();
    }
  }

  private blocks(text: string, still = false): ProgressBlock[] {
    let imageUrl: string | undefined;
    try {
      const base = new URL(this.target.assetBaseUrl ?? "");
      if (
        ["http:", "https:"].includes(base.protocol) &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash
      )
        imageUrl = new URL(
          still || this.activity === "responding"
            ? "/neo-ai-still-v1.png"
            : this.activity === "working"
              ? "/neo-working-v1.gif"
              : "/neo-thinking-v1.gif",
          base,
        ).href;
    } catch {
      /* Text-only presentation when artwork cannot be safely addressed. */
    }
    return [
      {
        type: "context",
        elements: [
          ...(imageUrl ? [{ type: "image", image_url: imageUrl, alt_text: "Neo activity" }] : []),
          { type: "mrkdwn", text },
          ...(this.model
            ? [
                {
                  type: "plain_text",
                  text: `Model: ${this.model.modelId} · Thinking: ${this.model.thinkingLevel}`,
                  emoji: false,
                },
              ]
            : []),
        ],
      },
    ];
  }

  private async footer(
    text = `Neo ${this.activity}... ${this.tools.size} tool calls | ${formatDuration(this.now() - this.startedAt)} elapsed`,
    still = false,
  ): Promise<void> {
    this.lastWrite = this.now();
    try {
      if (this.messageTs)
        await this.transport.update(
          this.target.transportTarget,
          this.messageTs,
          text,
          this.blocks(text, still),
        );
      else {
        const result = await this.transport.post(
          this.target.transportTarget,
          text,
          this.blocks(text, still),
        );
        if (result.ts) {
          this.messageTs = result.ts;
          await this.saveFooter(result.ts);
        }
      }
    } catch {
      /* UI failure never replays native work. */
    }
  }

  private async removeFooter(): Promise<void> {
    if (!this.messageTs) return;
    const ts = this.messageTs;
    try {
      await this.transport.update(
        this.target.transportTarget,
        ts,
        "Neo stopped",
        this.blocks("Neo stopped", true),
      );
    } catch {
      /* best effort */
    }
    try {
      await this.transport.delete(this.target.transportTarget, ts);
      this.messageTs = undefined;
      await this.saveFooter(undefined);
    } catch {
      /* Retain cleanup evidence for restart. */
    }
  }

  /** Native settlement stops motion/loading immediately, before potentially unavailable broker observation. */
  async nativeSettled(): Promise<void> {
    this.finished = true;
    clearTimeout(this.timer);
    this.phaseDue = undefined;
    await this.enqueue(async () => {
      await this.status("active");
      if (this.messageTs) await this.footer("Neo responding", true);
    });
  }

  /** Terminal clear bypasses pacing, drains old writes and stops motion before final publication. */
  async settle(event: Extract<ProgressEvent, { type: "done" | "error" }>): Promise<void> {
    this.finished = true;
    clearTimeout(this.timer);
    this.phaseDue = undefined;
    await this.enqueue(async () => {
      await this.status(
        event.type === "done" && (event.authWait === "google" || event.authWait === "approval")
          ? "suspended"
          : "active",
      );
      if (event.type === "done" && event.authWait) {
        await this.footer(
          event.authWait === "google"
            ? "Neo waiting for Google sign-in — the task will automatically continue."
            : event.authWait === "approval"
              ? "Neo waiting for human approval — the operation has not completed."
              : "Neo authorization status unavailable — completion is unconfirmed.",
          true,
        );
      } else if (this.messageTs) {
        await this.footer(
          event.type === "done" && event.status === "completed" ? "Neo responding" : "Neo stopped",
          true,
        );
      }
    });
  }

  /** Completion checks denote normal turn completion, not authorization or delivery success. */
  async finish(event: Extract<ProgressEvent, { type: "done" | "error" }>): Promise<void> {
    await this.enqueue(async () => {
      if (event.type === "done" && event.authWait) return;
      if (event.type === "done" && event.status === "completed") {
        try {
          await this.transport.removeReaction?.(
            this.target.transportTarget,
            this.target.sourceTs,
            "eyes",
          );
        } catch {
          /* best effort */
        }
        try {
          await this.transport.addReaction(
            this.target.transportTarget,
            this.target.sourceTs,
            "white_check_mark",
          );
        } catch {
          /* best effort */
        }
        if (this.messageTs)
          await this.footer(
            `✅ Done — ${this.tools.size} tool calls in ${formatDuration(event.durationMs ?? this.now() - this.startedAt)}`,
            true,
          );
        await this.removeFooter();
      } else if (event.type === "done" && /abort|interrupt|supersed/i.test(event.error ?? "")) {
        await this.removeFooter();
      } else if (this.messageTs) {
        await this.footer("❌ Neo failed — task unavailable", true);
      } else {
        try {
          await this.transport.addReaction(this.target.transportTarget, this.target.sourceTs, "x");
        } catch {
          /* best effort */
        }
      }
    });
  }

  /** Restart repairs only owned UI from validated facts; never repeats answers or completion reactions. */
  async reconcile(authorization?: string): Promise<void> {
    this.finished = true;
    clearTimeout(this.timer);
    await this.enqueue(async () => {
      await this.status(
        authorization === "waiting" || authorization === "approval_waiting"
          ? "suspended"
          : "active",
      );
      if (authorization && authorization !== "clear")
        await this.footer(
          authorization === "waiting"
            ? "Neo waiting for Google sign-in — the task will automatically continue."
            : authorization === "approval_waiting"
              ? "Neo waiting for human approval — the operation has not completed."
              : "Neo authorization status unavailable — completion is unconfirmed.",
          true,
        );
      else await this.removeFooter();
    });
  }

  /** Supersession/shutdown drain before the replacement can own the same native session or footer. */
  async stop(): Promise<void> {
    this.finished = true;
    clearTimeout(this.timer);
    await this.enqueue(async () => {
      await this.status("active");
      await this.removeFooter();
    });
  }
}
