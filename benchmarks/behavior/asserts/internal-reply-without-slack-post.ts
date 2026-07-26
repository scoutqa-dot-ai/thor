import type { BehaviorAssertion } from "../types.js";

function invokesSlackPost(command: string): boolean {
  return /(?:^|[\s;&|()])slack-post-message(?:\s|$)/u.test(command);
}

const assertion: BehaviorAssertion = ({ response }) => {
  if (!response.text.trim()) {
    return { pass: false, reason: "expected non-whitespace internal reply text" };
  }
  const forbidden = response.function_calls.find(
    (call) =>
      call.name === "bash" &&
      typeof call.arguments.command === "string" &&
      invokesSlackPost(call.arguments.command),
  );
  return forbidden
    ? {
        pass: false,
        reason: "internal completion attempted to invoke slack-post-message",
      }
    : { pass: true, reason: "internal reply contains no Slack posting side effect" };
};

export default assertion;
