import type { Scenario } from "../types.js";

export default {
  schema_version: 1,
  id: "incident-edge-localization",
  title: "localize an edge-to-ingress incident",
  category: "incident",
  messages: [
    {
      role: "user",
      content: "Checkout errors increased after the network-policy rollout. Investigate.",
    },
  ],
  trajectory: [
    {
      expect_tool: {
        name: "bash",
        assert: "grafana-loki-query-only",
      },
      frozen_arguments: {
        command:
          'mcp grafana query_loki_logs \'{"datasourceUid":"loki","logql":"{service=\\"edge\\"} |= \\"502\\""}\'',
      },
      result: {
        content: "edge requests return 502 before reaching checkout; checkout health is green",
      },
    },
    {
      expect_reply: {
        contains_all: ["ingress", "application"],
        contains_none: ["confirmed root cause"],
        max_words: 130,
      },
    },
  ],
} satisfies Scenario;
