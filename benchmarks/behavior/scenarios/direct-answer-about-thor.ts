import type { Scenario } from "../types.js";

export default {
  schema_version: 1,
  id: "direct-answer-about-thor",
  title: "answer how to change Thor without tools",
  category: "direct-answer",
  messages: [
    {
      role: "user",
      content: "Where can I see how Thor works, and how should I propose a prompt change?",
    },
  ],
  trajectory: [
    {
      expect_reply: {
        contains_all: ["github.com/scoutqa-dot-ai/thor", "PR"],
        contains_none: ["black box"],
        max_words: 80,
      },
    },
  ],
} satisfies Scenario;
