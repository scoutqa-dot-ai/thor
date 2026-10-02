import { describe, expect, it } from "vitest";

import {
  ApprovalRequiredEventPayloadSchema,
  GoogleWorkspaceCommandApprovalArgsSchema,
} from "./approval-events.js";
import { buildApprovalPresentation } from "./approval-presentation.js";

const args = {
  operation: "drive.files.update",
  argument_count: 7,
  command_fingerprint: "a".repeat(64),
  google_workspace_email: "person@example.com",
  slack_user_id: "U123",
  connection_id: "019d0000-0000-7000-8000-000000000001",
};

describe("Google Workspace approval", () => {
  it("accepts only the secret-free command binding", () => {
    expect(GoogleWorkspaceCommandApprovalArgsSchema.parse(args)).toEqual(args);
    expect(
      ApprovalRequiredEventPayloadSchema.parse({
        type: "approval_required",
        actionId: "action-1",
        proxyName: "gws",
        tool: "google_workspace_command",
        args,
      }),
    ).toMatchObject({ tool: "google_workspace_command", args });

    expect(
      GoogleWorkspaceCommandApprovalArgsSchema.safeParse({
        ...args,
        argv: ["drive", "files", "update", "--json", '{"secret":"value"}'],
      }).success,
    ).toBe(false);
  });

  it("shows identity, operation, argument count, and exact command fingerprint only", () => {
    const presentation = buildApprovalPresentation("google_workspace_command", args);
    expect(presentation).toBeDefined();
    if (!presentation) throw new Error("Google Workspace approval presentation missing");
    expect(presentation.title).toBe("Run Google Workspace command: drive.files.update");
    expect(presentation.markdown).toContain("person@example.com");
    expect(presentation.markdown).toContain("U123");
    expect(presentation.markdown).toContain("a".repeat(64));
    expect(presentation.markdown).not.toContain("connection_id");
    expect(JSON.stringify(presentation)).not.toContain("secret");
  });
});
