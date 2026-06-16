/**
 * Metabase API client for data warehouse queries.
 *
 * All configuration comes from environment variables:
 *   METABASE_URL            — base URL of the Metabase instance
 *   METABASE_API_KEY        — API key (x-api-key header, must be scoped to read-only DB role)
 *   METABASE_DATABASE_ID    — target database ID
 *   METABASE_ALLOWED_SCHEMAS — comma-separated schema allowlist (UX filtering only)
 */

import { loadMetabaseEnv } from "@thor/common";

/**
 * Error from the Metabase client. `userFailure` records — at the throw site,
 * where the full context is known — whether the failure was caused by the
 * caller's input (bad SQL, missing table/resource, unsupported question, a 4xx
 * request) rather than a service or config fault. Callers classify on this flag
 * instead of parsing the message, so behavior survives upstream wording changes.
 */
export class MetabaseError extends Error {
  readonly userFailure: boolean;
  readonly status?: number;

  constructor(message: string, userFailure: boolean, status?: number) {
    super(message);
    this.name = "MetabaseError";
    this.userFailure = userFailure;
    this.status = status;
  }
}

/**
 * A 4xx that reflects the caller's request (bad input or a missing resource the
 * caller named). Auth (401/403), rate limiting (429), and 5xx are service/config
 * faults that should still page.
 */
function isUserFailureStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

// ── Config (read once at startup, cached) ──────────────────────────────────

let _config: ReturnType<typeof loadMetabaseEnv> | null = null;

function config() {
  if (!_config) {
    _config = loadMetabaseEnv();
  }
  return _config;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function mbGet<T>(path: string): Promise<T> {
  const { url, apiKey } = config();
  const res = await fetch(`${url}${path}`, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MetabaseError(
      `Metabase GET ${path} → ${res.status}: ${body.slice(0, 500)}`,
      isUserFailureStatus(res.status),
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

async function mbPost<T>(path: string, body: unknown): Promise<T> {
  const { url, apiKey } = config();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MetabaseError(
      `Metabase POST ${path} → ${res.status}: ${text.slice(0, 500)}`,
      isUserFailureStatus(res.status),
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface TableInfo {
  name: string;
  id: number;
  description: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  description: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
}

export interface QuestionInfo {
  id: number;
  name: string;
  description: string | null;
  sql: string;
}

/**
 * List schemas, filtered by METABASE_ALLOWED_SCHEMAS.
 */
export async function listSchemas(): Promise<string[]> {
  const { dbId, schemas } = config();
  const all = await mbGet<string[]>(`/api/database/${dbId}/schemas`);
  return all.filter((s) => schemas.has(s));
}

/**
 * List tables in a schema.
 */
export async function listTables(schema: string): Promise<TableInfo[]> {
  const { dbId } = config();
  const raw = await mbGet<Array<{ name: string; id: number; description: string | null }>>(
    `/api/database/${dbId}/schema/${encodeURIComponent(schema)}`,
  );
  return raw.map((t) => ({ name: t.name, id: t.id, description: t.description }));
}

/**
 * Get column metadata for a table.
 * Two-step: resolve table name → ID from schema listing, then fetch metadata.
 */
export async function getColumns(schema: string, tableName: string): Promise<ColumnInfo[]> {
  const tables = await listTables(schema);
  const table = tables.find((t) => t.name === tableName);
  if (!table) {
    throw new MetabaseError(`Table "${tableName}" not found in schema "${schema}"`, true);
  }

  const meta = await mbGet<{
    fields: Array<{ name: string; database_type: string; description: string | null }>;
  }>(`/api/table/${table.id}/query_metadata`);
  return meta.fields.map((f) => ({
    name: f.name,
    type: f.database_type,
    description: f.description,
  }));
}

/**
 * Execute a read-only SQL query via Metabase's native query API.
 */
export async function executeQuery(sql: string): Promise<QueryResult> {
  const { dbId } = config();
  const result = await mbPost<{
    data: {
      rows: unknown[][];
      cols: Array<{ name: string }>;
    };
    row_count: number;
    status: string;
    error?: string;
  }>("/api/dataset", {
    database: dbId,
    type: "native",
    native: { query: sql },
  });

  if (result.status !== "completed" || result.error) {
    throw new MetabaseError(`Query failed: ${result.error || result.status}`, true);
  }

  return {
    columns: result.data.cols.map((c) => c.name),
    rows: result.data.rows,
    row_count: result.row_count,
  };
}

/**
 * Fetch the native SQL from a saved Metabase question (card).
 * Accepts either a numeric string or a slug-like card ref such as
 * "7751-daily-log-web-pages-paths", which Metabase resolves directly.
 */
export async function getQuestion(questionRef: string): Promise<QuestionInfo> {
  const card = await mbGet<{
    id: number;
    name: string;
    description: string | null;
    dataset_query: {
      type: string;
      native?: { query: string };
    };
  }>(`/api/card/${encodeURIComponent(questionRef)}`);

  if (card.dataset_query.type !== "native" || !card.dataset_query.native?.query) {
    throw new MetabaseError(
      `Question ${questionRef} is not a native SQL question (type: ${card.dataset_query.type}). ` +
        `Only native SQL questions are supported.`,
      true,
    );
  }

  return {
    id: card.id,
    name: card.name,
    description: card.description,
    sql: card.dataset_query.native.query,
  };
}
