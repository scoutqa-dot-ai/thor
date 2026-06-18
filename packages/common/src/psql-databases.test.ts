import { describe, expect, it } from "vitest";
import { resolvePsqlDatabases } from "./psql-databases.ts";

const bundle = (obj: unknown) => JSON.stringify(obj);

const commerce = {
  host: "qa-commerce.cluster-abc.us-east-1.rds.amazonaws.com",
  port: 5432,
  database: "commerce",
  username: "thor_ro",
  password: "secret",
  sslmode: "require",
};

describe("resolvePsqlDatabases", () => {
  it("returns an empty map when no bundle is configured", () => {
    expect(resolvePsqlDatabases(undefined, {}).size).toBe(0);
    expect(resolvePsqlDatabases("QA", {}).size).toBe(0);
  });

  it("parses a valid bundle keyed by alias", () => {
    const targets = resolvePsqlDatabases(undefined, { PSQL_DATABASES: bundle({ commerce }) });
    expect(targets.get("commerce")).toEqual(commerce);
  });

  it("defaults port to 5432 and sslmode to require when omitted", () => {
    const targets = resolvePsqlDatabases(undefined, {
      PSQL_DATABASES: bundle({
        bedrock: { host: "h", database: "bedrock", username: "thor_ro", password: "x" },
      }),
    });
    expect(targets.get("bedrock")).toMatchObject({ port: 5432, sslmode: "require" });
  });

  it("accepts a numeric string port", () => {
    const targets = resolvePsqlDatabases(undefined, {
      PSQL_DATABASES: bundle({ ...{}, kit: { ...commerce, port: "6543" } }),
    });
    expect(targets.get("kit")?.port).toBe(6543);
  });

  it("prefers the profile-scoped bundle over the global one", () => {
    const targets = resolvePsqlDatabases("QA", {
      PSQL_DATABASES: bundle({ commerce }),
      PSQL_DATABASES_QA: bundle({ scout: { ...commerce, database: "scout" } }),
    });
    expect([...targets.keys()]).toEqual(["scout"]);
  });

  it("falls back to the global bundle when the profile-scoped one is absent", () => {
    const targets = resolvePsqlDatabases("STAGING", { PSQL_DATABASES: bundle({ commerce }) });
    expect([...targets.keys()]).toEqual(["commerce"]);
  });

  it("throws on malformed JSON, naming the source var", () => {
    expect(() => resolvePsqlDatabases("QA", { PSQL_DATABASES_QA: "{not json" })).toThrow(
      /PSQL_DATABASES_QA is not valid JSON/,
    );
  });

  it("throws when the bundle is not a JSON object", () => {
    expect(() => resolvePsqlDatabases(undefined, { PSQL_DATABASES: bundle([commerce]) })).toThrow(
      /must be a JSON object/,
    );
  });

  it("rejects an invalid alias", () => {
    expect(() =>
      resolvePsqlDatabases(undefined, { PSQL_DATABASES: bundle({ "bad alias": commerce }) }),
    ).toThrow(/invalid database alias/);
  });

  it.each(["host", "database", "username", "password"])("throws when %s is missing", (field) => {
    const { [field as keyof typeof commerce]: _omitted, ...rest } = commerce;
    expect(() =>
      resolvePsqlDatabases(undefined, { PSQL_DATABASES: bundle({ commerce: rest }) }),
    ).toThrow(new RegExp(`"${field}" must be a non-empty string`));
  });

  it("throws on an out-of-range port", () => {
    expect(() =>
      resolvePsqlDatabases(undefined, {
        PSQL_DATABASES: bundle({ commerce: { ...commerce, port: 0 } }),
      }),
    ).toThrow(/"port" must be an integer/);
  });
});
