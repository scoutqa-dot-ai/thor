/**
 * Metabase API client for data warehouse queries.
 *
 * All configuration comes from environment variables:
 *   METABASE_URL            — base URL of the Metabase instance
 *   METABASE_API_KEY        — API key (x-api-key header, must be scoped to read-only DB role)
 *   METABASE_DATABASE_ID    — target database ID
 *   METABASE_ALLOWED_SCHEMAS — comma-separated schema allowlist (UX filtering only)
 */

// ── Config (read once at startup, cached) ──────────────────────────────────

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

let _config: { url: string; apiKey: string; dbId: number; schemas: Set<string> } | null = null;

function config() {
  if (!_config) {
    _config = {
      url: env("METABASE_URL").replace(/\/+$/, ""),
      apiKey: env("METABASE_API_KEY"),
      dbId: parseInt(env("METABASE_DATABASE_ID"), 10),
      schemas: new Set(
        env("METABASE_ALLOWED_SCHEMAS")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    };
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
    throw new Error(`Metabase GET ${path} → ${res.status}: ${body.slice(0, 500)}`);
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
    throw new Error(`Metabase POST ${path} → ${res.status}: ${text.slice(0, 500)}`);
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
    throw new Error(`Table "${tableName}" not found in schema "${schema}"`);
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
    throw new Error(`Query failed: ${result.error || result.status}`);
  }

  return {
    columns: result.data.cols.map((c) => c.name),
    rows: result.data.rows,
    row_count: result.row_count,
  };
}

/**
 * Fetch the native SQL from a saved Metabase question (card).
 * Accepts a question ID parsed from a numeric string or URL slug like "7751-daily-log-web-pages-paths".
 */
export async function getQuestion(questionId: number): Promise<QuestionInfo> {
  const card = await mbGet<{
    id: number;
    name: string;
    description: string | null;
    dataset_query: {
      type: string;
      native?: { query: string };
    };
  }>(`/api/card/${questionId}`);

  if (card.dataset_query.type !== "native" || !card.dataset_query.native?.query) {
    throw new Error(
      `Question ${questionId} is not a native SQL question (type: ${card.dataset_query.type}). ` +
        `Only native SQL questions are supported.`,
    );
  }

  return {
    id: card.id,
    name: card.name,
    description: card.description,
    sql: card.dataset_query.native.query,
  };
}

/**
 * Check if a schema is in the allowlist.
 */
export function isSchemaAllowed(schema: string): boolean {
  return config().schemas.has(schema);
}
