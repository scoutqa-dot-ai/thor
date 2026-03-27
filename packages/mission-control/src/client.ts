/**
 * Mission Control API client.
 *
 * Handles agent registration, task queue polling, and status reporting.
 * See: https://github.com/builderz-labs/mission-control
 */

import { z } from "zod/v4";

// --- Schemas ---

export const MCTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  priority: z.string().optional(),
  projectId: z.string().optional(),
  assigneeId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type MCTask = z.infer<typeof MCTaskSchema>;

export const MCAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(),
});

export type MCAgent = z.infer<typeof MCAgentSchema>;

// --- Client ---

export interface MCClientConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class MCClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(config: MCClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MC API ${method} ${path} returned ${response.status}: ${text}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return undefined;
  }

  /** Register Thor as an agent. Returns the agent record. */
  async registerAgent(name: string, capabilities?: string[]): Promise<MCAgent> {
    const result = await this.request("POST", "/api/agents/register", {
      name,
      capabilities: capabilities ?? ["coding", "devops", "analysis"],
    });
    return MCAgentSchema.parse(result);
  }

  /** Send a heartbeat to keep the agent alive. */
  async heartbeat(agentId: string): Promise<void> {
    await this.request("POST", `/api/agents/${agentId}/heartbeat`, {});
  }

  /** Poll the task queue for work assigned to this agent. */
  async pollQueue(agentId: string): Promise<MCTask | undefined> {
    const result = await this.request("GET", `/api/tasks/queue?agentId=${agentId}`);
    if (!result) return undefined;

    // Queue may return a single task or null
    const parsed = MCTaskSchema.safeParse(result);
    return parsed.success ? parsed.data : undefined;
  }

  /** Update a task's status. */
  async updateTask(
    taskId: string,
    update: {
      status: "in_progress" | "review" | "done" | "error";
      output?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.request("PATCH", `/api/tasks/${taskId}`, update);
  }

  /** Add a comment to a task. */
  async addComment(taskId: string, content: string): Promise<void> {
    await this.request("POST", `/api/tasks/${taskId}/comments`, { content });
  }

  /** Health check. */
  async health(): Promise<boolean> {
    try {
      await this.request("GET", "/api/health");
      return true;
    } catch {
      return false;
    }
  }
}
