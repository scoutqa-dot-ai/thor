import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type { JsonSchemaValidatorResult } from "@modelcontextprotocol/sdk/validation/types.js";

const draft07 = "http://json-schema.org/draft-07/schema#";
const draft2020 = "https://json-schema.org/draft/2020-12/schema";
const commonKeywords = new Set([
  "$schema",
  "$id",
  "$ref",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "type",
  "enum",
  "const",
  "multipleOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minProperties",
  "maxProperties",
  "required",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "items",
  "definitions",
  "$defs",
]);
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);
const schemaValues = new Set([
  "additionalProperties",
  "additionalItems",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function schemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface McpSchemaProjection {
  readonly paths: Set<string>;
  readonly references: string[];
}

function schemaPointerChild(parent: string, token: string): string {
  return `${parent}/${token.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

// Walk schema positions, not arbitrary business values in enum/default/examples. Unknown assertions
// fail closed; only private metadata is discarded. Nested IDs would change local reference scope.
function projectSchema(
  value: unknown,
  dialect: "07" | "2020",
  projection: McpSchemaProjection,
  path = "#",
): unknown {
  projection.paths.add(path);
  const root = path === "#";
  if (typeof value === "boolean") return value;
  if (!schemaObject(value)) throw new Error("MCP schema unsupported: invalid schema node");
  const projected: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(value)) {
    if (key === "_meta") continue;
    const dialectKeyword =
      dialect === "07"
        ? ["additionalItems", "dependencies"].includes(key)
        : [
            "prefixItems",
            "minContains",
            "maxContains",
            "dependentRequired",
            "dependentSchemas",
            "unevaluatedProperties",
            "unevaluatedItems",
          ].includes(key);
    if (!commonKeywords.has(key) && !dialectKeyword)
      throw new Error("MCP schema unsupported: assertion keyword");
    if (key === "$schema" && (!root || node !== (dialect === "07" ? draft07 : draft2020)))
      throw new Error("MCP schema unsupported: dialect");
    if (key === "$id" && !root) throw new Error("MCP schema unsupported: nested identity");
    if (key === "$ref") {
      if (typeof node !== "string" || (node !== "#" && !node.startsWith("#/")))
        throw new Error("MCP schema unsupported: nonlocal reference");
      projection.references.push(decodeURIComponent(node));
    }
    const childPath = schemaPointerChild(path, key);
    if (schemaMaps.has(key)) {
      if (!schemaObject(node)) throw new Error("MCP schema unsupported: schema map");
      projected[key] = Object.fromEntries(
        Object.entries(node).map(([name, child]) => [
          name,
          projectSchema(child, dialect, projection, schemaPointerChild(childPath, name)),
        ]),
      );
    } else if (schemaValues.has(key)) {
      projected[key] = projectSchema(node, dialect, projection, childPath);
    } else if (schemaArrays.has(key) || (key === "items" && Array.isArray(node))) {
      if (!Array.isArray(node) || (key === "items" && dialect === "2020"))
        throw new Error("MCP schema unsupported: schema array");
      projected[key] = node.map((child, index) =>
        projectSchema(child, dialect, projection, schemaPointerChild(childPath, String(index))),
      );
    } else if (key === "items") {
      projected[key] = projectSchema(node, dialect, projection, childPath);
    } else if (key === "dependencies") {
      if (!schemaObject(node)) throw new Error("MCP schema unsupported: dependencies");
      projected[key] = Object.fromEntries(
        Object.entries(node).map(([name, child]) => [
          name,
          Array.isArray(child)
            ? child
            : projectSchema(child, dialect, projection, schemaPointerChild(childPath, name)),
        ]),
      );
    } else {
      projected[key] = node;
    }
  }
  return projected;
}

/** A compiled schema retains all supported assertions; it never coerces, strips fields or applies defaults. */
export interface McpArgumentValidator {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly validate: ValidateFunction;
}
/** Compile an isolated draft-07/2020-12 validator; unsupported dialect/assertions/remote refs fail closed. */
export function compileMcpSchema(input: unknown): McpArgumentValidator | undefined {
  try {
    if (!schemaObject(input)) return undefined;
    const dialect = input.$schema === draft2020 ? "2020" : "07";
    const projection: McpSchemaProjection = { paths: new Set(), references: [] };
    const schema = projectSchema(input, dialect, projection);
    // A reference cannot reinterpret annotation/business data as an unreviewed schema.
    if (projection.references.some((reference) => !projection.paths.has(reference)))
      return undefined;
    if (!schemaObject(schema)) return undefined;
    const options = {
      strict: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allErrors: true,
      validateFormats: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      // Each compiler is revision-local; identical $id values never reuse another tool's schema.
      addUsedSchema: false,
      ownProperties: true,
      formats: fullFormats,
      // Draft-07 reference siblings are annotations, not additional assertions; 2020-12 applies them.
      ignoreKeywordsWithRef: dialect === "07",
      logger: false as const,
    };
    const ajv = dialect === "2020" ? new Ajv2020(options) : new Ajv(options);
    return { schema, validate: ajv.compile(schema) };
  } catch {
    return undefined;
  }
}

/** The installed SDK also uses the reviewed dialect contract for structured output validation. */
export const mcpJsonSchemaValidator = {
  getValidator<T>(
    schema: Record<string, unknown>,
  ): (input: unknown) => JsonSchemaValidatorResult<T> {
    const compiled = compileMcpSchema(schema);
    // Hidden tools need not have supported schemas; permitted tools fail inventory validation.
    // If an internal adapter ever invokes an unsupported hidden output, the SDK still fails closed.
    if (!compiled)
      return () => ({
        valid: false,
        data: undefined,
        errorMessage: "MCP output schema unsupported",
      });
    return (input: unknown) => {
      if (!compiled.validate(input))
        return {
          valid: false,
          data: undefined,
          errorMessage: "MCP output does not match its schema",
        };
      // SAFETY: Ajv established the caller-supplied JSON schema contract. The SDK's generic T
      // is its typed view of that schema, which TypeScript cannot infer from runtime JSON.
      return { valid: true, data: input as T, errorMessage: undefined };
    };
  },
};
