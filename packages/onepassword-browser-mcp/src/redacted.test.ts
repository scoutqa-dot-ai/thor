import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { RedactedString, withRedactedString } from "./redacted.ts";

it("redacts secrets during ordinary inspection and serialization", async () => {
  const raw = "secret-password-fixture";
  const secret = RedactedString.make(raw);

  expect(String(secret)).toBe("[REDACTED]");
  expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
  expect(inspect(secret)).not.toContain(raw);
  await expect(withRedactedString(secret, async (value) => value.length)).resolves.toBe(raw.length);
});
