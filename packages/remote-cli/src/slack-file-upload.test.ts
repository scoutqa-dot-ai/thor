import { describe, expect, it, vi } from "vitest";
import { deleteSlackFileApi, uploadSlackFileApi } from "./slack-post-message.ts";

const env = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_API_BASE_URL: "https://slack.test/api" };

function routingFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "https://slack.test/api/files.getUploadURLExternal") {
      return new Response(
        JSON.stringify(
          overrides.getUploadURL ?? {
            ok: true,
            upload_url: "https://files.slack.test/upload/abc",
            file_id: "F1",
          },
        ),
      );
    }
    if (url === "https://files.slack.test/upload/abc") {
      return new Response("", { status: (overrides.uploadStatus as number) ?? 200 });
    }
    if (url === "https://slack.test/api/files.completeUploadExternal") {
      return new Response(
        JSON.stringify(
          overrides.completeUpload ?? {
            ok: true,
            files: [{ id: "F1", permalink: "https://slack.test/files/F1" }],
          },
        ),
      );
    }
    if (url === "https://slack.test/api/files.delete") {
      return new Response(JSON.stringify(overrides.delete ?? { ok: true }));
    }
    throw new Error(`unexpected url: ${url}`);
  });
}

describe("uploadSlackFileApi", () => {
  it("runs the 3-call external upload flow and returns the shared permalink", async () => {
    const fetchMock = routingFetch();

    const result = await uploadSlackFileApi(
      { channel: "C1", threadTs: "t1", filename: "a.md", title: "Title", content: "hello" },
      { fetch: fetchMock as unknown as typeof fetch, env },
    );

    expect(result).toEqual({ fileId: "F1", permalink: "https://slack.test/files/F1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const getForm = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(getForm.get("filename")).toBe("a.md");
    expect(getForm.get("length")).toBe("5");

    // Step 2 hits the pre-signed upload_url verbatim with the raw content and no
    // Authorization header (the base-url override does not apply to it).
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://files.slack.test/upload/abc");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe("hello");
    expect(
      (fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization,
    ).toBeUndefined();

    const completeForm = new URLSearchParams(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(completeForm.get("channel_id")).toBe("C1");
    expect(completeForm.get("thread_ts")).toBe("t1");
    expect(JSON.parse(completeForm.get("files") ?? "[]")).toEqual([{ id: "F1", title: "Title" }]);
  });

  it("propagates a getUploadURLExternal error without attempting the upload", async () => {
    const fetchMock = routingFetch({ getUploadURL: { ok: false, error: "missing_scope" } });

    const result = await uploadSlackFileApi(
      { channel: "C1", filename: "a.md", title: "Title", content: "hello" },
      { fetch: fetchMock as unknown as typeof fetch, env },
    );

    expect(result).toEqual({ error: "Slack API error: missing_scope" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("errors when the completed upload has no permalink but returns the file id for cleanup", async () => {
    const fetchMock = routingFetch({ completeUpload: { ok: true, files: [{ id: "F1" }] } });

    const result = await uploadSlackFileApi(
      { channel: "C1", filename: "a.md", title: "Title", content: "hello" },
      { fetch: fetchMock as unknown as typeof fetch, env },
    );

    expect(result).toEqual({
      error: "Slack files.completeUploadExternal response missing permalink",
      fileId: "F1",
    });
  });

  it("fails fast when the raw upload returns a non-2xx status and skips completion", async () => {
    const fetchMock = routingFetch({ uploadStatus: 500 });

    const result = await uploadSlackFileApi(
      { channel: "C1", filename: "a.md", title: "Title", content: "hello" },
      { fetch: fetchMock as unknown as typeof fetch, env },
    );

    expect(result).toEqual({ error: "Slack file upload failed with HTTP 500" });
    // Stops after getUploadURLExternal + the failed raw POST; never completes.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(
      "https://slack.test/api/files.completeUploadExternal",
    );
  });

  it("surfaces a thrown network error during the raw upload and attempts no completion", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://slack.test/api/files.getUploadURLExternal") {
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: "https://files.slack.test/upload/abc",
            file_id: "F1",
          }),
        );
      }
      throw new Error("connection reset");
    });

    const result = await uploadSlackFileApi(
      { channel: "C1", filename: "a.md", title: "Title", content: "hello" },
      { fetch: fetchMock as unknown as typeof fetch, env },
    );

    expect(result).toEqual({ error: "connection reset" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires a bot token", async () => {
    const result = await uploadSlackFileApi(
      { channel: "C1", filename: "a.md", title: "Title", content: "hello" },
      { env: {} },
    );
    expect(result).toEqual({ error: "SLACK_BOT_TOKEN is not set" });
  });
});

describe("deleteSlackFileApi", () => {
  it("deletes by file id", async () => {
    const fetchMock = routingFetch();
    const result = await deleteSlackFileApi("F1", {
      fetch: fetchMock as unknown as typeof fetch,
      env,
    });
    expect(result).toEqual({ ok: true });
    const form = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(form.get("file")).toBe("F1");
  });

  it("requires a bot token", async () => {
    const result = await deleteSlackFileApi("F1", { env: {} });
    expect(result).toEqual({ error: "SLACK_BOT_TOKEN is not set" });
  });

  it("surfaces a Slack API error from files.delete", async () => {
    const fetchMock = routingFetch({ delete: { ok: false, error: "file_not_found" } });
    const result = await deleteSlackFileApi("F1", {
      fetch: fetchMock as unknown as typeof fetch,
      env,
    });
    expect(result).toEqual({ error: "Slack API error: file_not_found" });
  });
});
