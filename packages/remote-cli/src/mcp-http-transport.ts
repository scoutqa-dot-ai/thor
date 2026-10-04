import type { UpstreamConfig } from "./upstream.js";

/** SDK HTTP I/O is pinned to the configured endpoint for POST, SSE/resume and DELETE alike. */
export function createPinnedMcpFetch(
  config: Extract<UpstreamConfig, { kind: "http" }>,
): typeof fetch {
  const endpoint = new URL(config.url).href;
  return async (input, init) => {
    const requested = input instanceof Request ? input.url : String(input);
    if (new URL(requested).href !== endpoint) throw new Error("MCP HTTP endpoint change denied");
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, value);
    if (config.bearer) headers.set("Authorization", `Bearer ${config.bearer.reveal()}`);
    let response: Response;
    try {
      response = await fetch(input, { ...init, headers, redirect: "manual" });
    } catch {
      throw new Error("MCP HTTP transport unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("MCP HTTP redirect denied");
    }
    if (!response.ok) {
      // The SDK otherwise embeds vendor response bodies in exceptions. Do not retain headers/body.
      await response.body?.cancel();
      return new Response(null, { status: response.status });
    }
    return response;
  };
}
