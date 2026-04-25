import { describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk";
import { createDelegateProgressState, getDelegateProgressEvents } from "./delegate-progress.js";

describe("getDelegateProgressEvents", () => {
  it("emits delegate from task tool input", () => {
    const state = createDelegateProgressState();
    const part = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      state: {
        status: "running",
        input: {
          subagent_type: " research-agent ",
          description: " investigate flaky test ",
        },
      },
    } as unknown as Part;

    expect(getDelegateProgressEvents(part, state)).toEqual([
      {
        type: "delegate",
        agent: "research-agent",
        description: "investigate flaky test",
      },
    ]);
  });

  it("emits delegate from subtask part as backward-compatible fallback", () => {
    const state = createDelegateProgressState();
    const part = {
      type: "subtask",
      agent: "coding-agent",
      description: " implement fix ",
    } as unknown as Part;

    expect(getDelegateProgressEvents(part, state)).toEqual([
      {
        type: "delegate",
        agent: "coding-agent",
        description: "implement fix",
      },
    ]);
  });

  it("dedupes repeated task updates for the same invocation", () => {
    const state = createDelegateProgressState();

    const running = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      state: {
        status: "running",
        time: { start: 1710000000000 },
        input: {
          subagent_type: "research-agent",
          description: "investigate",
        },
      },
    } as unknown as Part;

    const completed = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      state: {
        status: "completed",
        time: { start: 1710000000000 },
        input: {
          subagent_type: "research-agent",
          description: "investigate",
        },
      },
    } as unknown as Part;

    expect(getDelegateProgressEvents(running, state)).toHaveLength(1);
    expect(getDelegateProgressEvents(completed, state)).toEqual([]);
  });

  it("emits separate delegates for distinct task invocations", () => {
    const state = createDelegateProgressState();

    const first = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      state: {
        status: "running",
        time: { start: 1710000000000 },
        input: {
          subagent_type: "research-agent",
          description: "first investigation",
        },
      },
    } as unknown as Part;

    const second = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      state: {
        status: "running",
        time: { start: 1710000001000 },
        input: {
          subagent_type: "research-agent",
          description: "second investigation",
        },
      },
    } as unknown as Part;

    expect(getDelegateProgressEvents(first, state)).toHaveLength(1);
    expect(getDelegateProgressEvents(second, state)).toHaveLength(1);
  });

  it("ignores task tool parts without a non-empty subagent_type", () => {
    const state = createDelegateProgressState();
    const part = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      state: {
        status: "running",
        input: {
          subagent_type: "   ",
          description: "ignored",
        },
      },
    } as unknown as Part;

    expect(getDelegateProgressEvents(part, state)).toEqual([]);
  });

  it("dedupes when the same task invocation gains a description later", () => {
    const state = createDelegateProgressState();

    const running = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      callID: "call-1",
      state: {
        status: "running",
        input: {
          subagent_type: "research-agent",
        },
      },
    } as unknown as Part;

    const completed = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      callID: "call-1",
      state: {
        status: "completed",
        time: { start: 1710000000000 },
        input: {
          subagent_type: "research-agent",
          description: "filled later",
        },
      },
    } as unknown as Part;

    expect(getDelegateProgressEvents(running, state)).toHaveLength(1);
    expect(getDelegateProgressEvents(completed, state)).toEqual([]);
  });

  it("treats subtask emission as fallback when a matching task delegate already emitted", () => {
    const state = createDelegateProgressState();

    const taskPart = {
      type: "tool",
      tool: "task",
      sessionID: "s1",
      messageID: "m1",
      state: {
        status: "running",
        input: {
          subagent_type: "coding-agent",
          description: "implement fix",
        },
      },
    } as unknown as Part;

    const subtaskPart = {
      type: "subtask",
      sessionID: "s1",
      messageID: "m1",
      agent: "coding-agent",
      description: "implement fix",
    } as unknown as Part;

    expect(getDelegateProgressEvents(taskPart, state)).toHaveLength(1);
    expect(getDelegateProgressEvents(subtaskPart, state)).toEqual([]);
  });

  it("suppresses child-session subtask fallback after a task-derived delegate for the same agent", () => {
    const state = createDelegateProgressState();

    const parentTaskPart = {
      type: "tool",
      tool: "task",
      sessionID: "parent-session",
      messageID: "parent-message",
      callID: "call-1",
      state: {
        status: "running",
        input: {
          subagent_type: "thinker",
          description: "review changes",
        },
      },
    } as unknown as Part;

    const childSubtaskPart = {
      type: "subtask",
      sessionID: "child-session",
      messageID: "child-message",
      agent: "thinker",
      description: "review changes",
    } as unknown as Part;

    expect(getDelegateProgressEvents(parentTaskPart, state)).toHaveLength(1);
    expect(getDelegateProgressEvents(childSubtaskPart, state)).toEqual([]);
  });

  it("only suppresses one matching subtask fallback per task-derived delegate", () => {
    const state = createDelegateProgressState();

    const taskPart = {
      type: "tool",
      tool: "task",
      sessionID: "parent-session",
      messageID: "parent-message",
      callID: "call-1",
      state: {
        status: "running",
        input: {
          subagent_type: "thinker",
          description: "review changes",
        },
      },
    } as unknown as Part;

    const firstSubtask = {
      type: "subtask",
      sessionID: "child-session-1",
      messageID: "child-message-1",
      agent: "thinker",
      description: "review changes",
    } as unknown as Part;

    const secondSubtask = {
      type: "subtask",
      sessionID: "child-session-2",
      messageID: "child-message-2",
      agent: "thinker",
      description: "review changes",
    } as unknown as Part;

    expect(getDelegateProgressEvents(taskPart, state)).toHaveLength(1);
    expect(getDelegateProgressEvents(firstSubtask, state)).toEqual([]);
    expect(getDelegateProgressEvents(secondSubtask, state)).toEqual([
      {
        type: "delegate",
        agent: "thinker",
        description: "review changes",
      },
    ]);
  });
});
