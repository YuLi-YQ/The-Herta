import type { ToolCallRequest, ToolSchema } from "@herta/core";
import { failure, object } from "./common.js";

const supported = new Set([
  "$schema",
  "$id",
  "$ref",
  "definitions",
  "$defs",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
]);
function matches(
  value: unknown,
  raw: unknown,
  root: unknown,
  depth = 0,
): boolean {
  if (depth > 64) throw failure("Tool schema recursion limit", "tool-args");
  if (typeof raw === "boolean") return raw;
  const schema = object(raw);
  for (const key of Object.keys(schema))
    if (!supported.has(key))
      throw failure(`Unsupported tool schema keyword: ${key}`, "tool-args");
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/"))
      throw failure(
        "Only local tool schema references are supported",
        "tool-args",
      );
    let resolved = root;
    for (const piece of schema.$ref.slice(2).split("/"))
      resolved =
        object(resolved)[piece.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (resolved === undefined)
      throw failure("Unknown tool schema reference", "tool-args");
    if (!matches(value, resolved, root, depth + 1)) return false;
  }
  const typeMatches = (type: unknown) =>
    type === "null"
      ? value === null
      : type === "array"
        ? Array.isArray(value)
        : type === "object"
          ? value !== null && typeof value === "object" && !Array.isArray(value)
          : type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : type === "number"
              ? typeof value === "number" && Number.isFinite(value)
              : type === "string"
                ? typeof value === "string"
                : type === "boolean"
                  ? typeof value === "boolean"
                  : false;
  if (
    schema.type !== undefined &&
    !(Array.isArray(schema.type)
      ? schema.type.some(typeMatches)
      : typeMatches(schema.type))
  )
    return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    return false;
  if (
    "const" in schema &&
    JSON.stringify(schema.const) !== JSON.stringify(value)
  )
    return false;
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const)
    if (Array.isArray(schema[keyword])) {
      const results = (schema[keyword] as unknown[]).map((s) =>
        matches(value, s, root, depth + 1),
      );
      if (
        (keyword === "anyOf" && !results.some(Boolean)) ||
        (keyword === "oneOf" && results.filter(Boolean).length !== 1) ||
        (keyword === "allOf" && !results.every(Boolean))
      )
        return false;
    }
  if (schema.not !== undefined && matches(value, schema.not, root, depth + 1))
    return false;
  if (typeof value === "string") {
    const length = [...value].length;
    if (
      (typeof schema.minLength === "number" && length < schema.minLength) ||
      (typeof schema.maxLength === "number" && length > schema.maxLength)
    )
      return false;
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    )
      return false;
  }
  if (typeof value === "number") {
    if (
      (typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === "number" &&
        value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === "number" &&
        value >= schema.exclusiveMaximum)
    )
      return false;
    if (
      typeof schema.multipleOf === "number" &&
      Math.abs(
        value / schema.multipleOf - Math.round(value / schema.multipleOf),
      ) > 1e-9
    )
      return false;
  }
  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    )
      return false;
    if (
      schema.uniqueItems === true &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      return false;
    if (
      schema.items !== undefined &&
      !value.every((v, i) =>
        matches(
          v,
          Array.isArray(schema.items)
            ? (schema.items[i] ?? schema.additionalItems ?? true)
            : schema.items,
          root,
          depth + 1,
        ),
      )
    )
      return false;
  } else if (value && typeof value === "object") {
    const input = object(value),
      keys = Object.keys(input),
      props = schema.properties === undefined ? {} : object(schema.properties);
    if (
      (typeof schema.minProperties === "number" &&
        keys.length < schema.minProperties) ||
      (typeof schema.maxProperties === "number" &&
        keys.length > schema.maxProperties)
    )
      return false;
    if (
      Array.isArray(schema.required) &&
      schema.required.some(
        (k) => typeof k !== "string" || !Object.hasOwn(input, k),
      )
    )
      return false;
    for (const key of keys) {
      if (Object.hasOwn(props, key)) {
        if (!matches(input[key], props[key], root, depth + 1)) return false;
      } else if (
        schema.additionalProperties !== undefined &&
        !matches(input[key], schema.additionalProperties, root, depth + 1)
      )
        return false;
    }
  }
  return true;
}
export function validatedCall(
  id: string,
  name: string,
  args: string,
  tools: readonly ToolSchema[],
): ToolCallRequest {
  if (!id || !name) throw failure("Missing tool identity", "tool-identity");
  if (args.length > 1_048_576) throw failure("Tool arguments exceed limit", "tool-limit");
  const schema = tools.find((t) => t.name === name);
  if (!schema) throw failure("Model requested an undeclared tool", "tool-unknown");
  let input: unknown;
  try {
    input = JSON.parse(args);
  } catch {
    throw failure("Tool arguments are not complete JSON", "tool-json");
  }
  try {
    if (!matches(input, schema.inputSchema, schema.inputSchema))
      throw failure("Tool arguments do not match declared schema", "tool-schema");
  } catch (error) {
    if (error instanceof Error && error.name === "ProviderError") throw error;
    throw failure("Tool schema validation failed", "tool-schema");
  }
  return { id, tool: name, input };
}
