import { describe, expect, it } from "vitest";
import { IdleAutoResume, MAX_RESUMES, type AssistantMessageSummary } from "./idle-auto-resume.ts";

const failed = (id: string): AssistantMessageSummary => ({
  id,
  finish: "error",
  tokenTotal: 0,
});

// The happy paths (resume once, never twice, re-arm on a new message id) are
// covered end-to-end in trigger.test.ts. These cover the two non-obvious
// invariants that no higher-level test exercises.
describe("IdleAutoResume", () => {
  it("never treats a message that emitted text as a failed idle", () => {
    // Safety boundary: once the caller has real output, a trailing zero-token
    // error update for that same message must not trigger a re-prompt.
    const ar = new IdleAutoResume();
    ar.onAssistantText("m1", true);
    ar.onAssistantMessageUpdate(failed("m1"));
    expect(ar.isFailedAssistantIdle()).toBe(false);
    expect(ar.decideResume()).toBeUndefined();
  });

  it("re-arms only for a new message id, not late tokens on the disarmed one", () => {
    // The disarm is keyed to a specific message id — late tokens on that same
    // id must not re-arm, but a different id reporting tokens must.
    const ar = new IdleAutoResume();
    ar.onAssistantMessageUpdate(failed("m1"));
    ar.markResumed("m1");

    ar.onAssistantMessageUpdate({ id: "m1", finish: "error", tokenTotal: 5 });
    ar.onAssistantMessageUpdate(failed("m1"));
    expect(ar.decideResume()).toBeUndefined();

    ar.onAssistantMessageUpdate({ id: "m2", finish: undefined, tokenTotal: 10 });
    ar.onAssistantMessageUpdate(failed("m2"));
    expect(ar.decideResume()).toBe("m2");
  });

  it("stops resuming once the global cap is hit, even with ever-new message ids", () => {
    // A flapping provider re-arms via tokens>0 on a new id, then fails with zero
    // tokens — without a global cap this loops forever. Cap bounds total resumes.
    const ar = new IdleAutoResume();
    for (let i = 0; i < MAX_RESUMES; i++) {
      const id = `m${i}`;
      ar.onAssistantMessageUpdate({ id, finish: undefined, tokenTotal: 10 });
      ar.onAssistantMessageUpdate(failed(id));
      expect(ar.decideResume()).toBe(id);
      ar.markResumed(id);
    }
    // One more genuine recovery + failure: still classified as a failed idle,
    // but the cap suppresses the resume.
    ar.onAssistantMessageUpdate({ id: "m-final", finish: undefined, tokenTotal: 10 });
    ar.onAssistantMessageUpdate(failed("m-final"));
    expect(ar.isFailedAssistantIdle()).toBe(true);
    expect(ar.decideResume()).toBeUndefined();
  });
});
