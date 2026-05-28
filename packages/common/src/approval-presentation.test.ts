import { describe, expect, it } from "vitest";
import { extractApprovalFailureCategory } from "./approval-presentation.js";

describe("extractApprovalFailureCategory", () => {
  it("keeps the existing safe upstream failure categories", () => {
    expect(extractApprovalFailureCategory('Error calling "merge_pull_request": failed\n')).toBe(
      'Error calling "merge_pull_request"',
    );
    expect(extractApprovalFailureCategory('Unknown upstream "posthog".\n')).toBe(
      'Unknown upstream "posthog"',
    );
  });

  it("surfaces known-safe approval-time profile routing failures", () => {
    expect(
      extractApprovalFailureCategory(
        "session s1 is bound to channels in multiple profiles (<none>, QA): C123, C999\n",
      ),
    ).toBe("session s1 is bound to channels in multiple profiles (<none>, QA): C123, C999");

    expect(
      extractApprovalFailureCategory(
        'partial grafana profile bundle for "QA": missing GRAFANA_SERVICE_ACCOUNT_TOKEN_QA. Set the whole bundle or none of it.\n',
      ),
    ).toBe(
      'partial grafana profile bundle for "QA": missing GRAFANA_SERVICE_ACCOUNT_TOKEN_QA. Set the whole bundle or none of it.',
    );

    expect(
      extractApprovalFailureCategory(
        'Upstream "atlassian" is not configured for the resolved profile.\n',
      ),
    ).toBe('Upstream "atlassian" is not configured for the resolved profile.');
  });

  it("does not surface arbitrary stderr", () => {
    expect(
      extractApprovalFailureCategory("request failed with token secret-token-123 and raw body"),
    ).toBeUndefined();
  });
});
