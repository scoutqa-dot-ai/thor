import type { Scenario } from "../types.js";

export default {
  schema_version: 1,
  id: "successful-ci-wake-stays-silent",
  title: "do not announce a successful CI wake",
  category: "notification",
  messages: [
    {
      role: "user",
      content: "The check suite completed successfully; no human is waiting.",
    },
  ],
  trajectory: [
    {
      expect_reply: {
        assert: "internal-reply-without-slack-post",
      },
    },
  ],
} satisfies Scenario;
