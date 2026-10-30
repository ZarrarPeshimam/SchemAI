import { modelResponseSchema } from "./operationSchema.js";

/**
 * Provider-facing (Gemini) JSON Schema for the refinement proposal.
 *
 * Why this exists: passing the Zod schema straight to `withStructuredOutput` lets zod-to-json-schema replace every
 * repeated Zod *instance* (here `attributeDefinition`, used by both `add_attribute` and `add_entity`) with a
 * `{"$ref": "#/..."}` pointer, which Gemini's function-declaration schema does not support. This converter expands
 * every occurrence inline instead, and emits only the keywords Gemini accepts (type, description, enum, properties,
 * required, items). The Zod schema remains the single source of truth and is still used afterwards to validate the
 * model's output (parseModelResponse), so application-side validation is unchanged.
 *
 * Unsupported Zod constructs throw at start-up/test time instead of silently producing a schema Gemini would reject.
 */
export function zodToProviderSchema(zodType) {
  const def = zodType?._def;
  if (!def) throw new Error("zodToProviderSchema: not a Zod schema");
  const description = zodType.description;
  const withDescription = (schema) => (description ? { ...schema, description } : schema);

  switch (def.typeName) {
    case "ZodString":
      return withDescription({ type: "string" });
    case "ZodBoolean":
      return withDescription({ type: "boolean" });
    case "ZodNumber":
      return withDescription({ type: def.checks?.some((c) => c.kind === "int") ? "integer" : "number" });
    case "ZodEnum":
      return withDescription({ type: "string", enum: [...def.values] });
    case "ZodArray":
      return withDescription({ type: "array", items: zodToProviderSchema(def.type) });
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault": {
      const inner = zodToProviderSchema(def.innerType);
      return description && !inner.description ? { ...inner, description } : inner;
    }
    case "ZodEffects": {
      const inner = zodToProviderSchema(def.schema);
      return description && !inner.description ? { ...inner, description } : inner;
    }
    case "ZodObject": {
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(def.shape())) {
        properties[key] = zodToProviderSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      return withDescription({ type: "object", properties, ...(required.length ? { required } : {}) });
    }
    default:
      throw new Error(`zodToProviderSchema: unsupported Zod type ${def.typeName}`);
  }
}

/** Returns the JSON paths of every `$ref` / `$defs` / `definitions` key found anywhere in a schema (empty when clean). */
export function findUnsupportedRefs(node, path = "$") {
  if (node === null || typeof node !== "object") return [];
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" || key === "$defs" || key === "definitions") found.push(`${path}.${key}`);
    found.push(...findUnsupportedRefs(value, `${path}.${key}`));
  }
  return found;
}

const schema = zodToProviderSchema(modelResponseSchema);
const refs = findUnsupportedRefs(schema);
if (refs.length) throw new Error(`Provider schema must not contain references: ${refs.join(", ")}`);

const PROVIDER_SCHEMA = { ...schema, description: "Proposed changes to the existing database schema" };

/**
 * Plain, fully inlined JSON Schema handed to the Gemini SDK. A fresh copy is returned on every call because SDK/LangChain
 * helpers may normalise (mutate) the object they receive and must never affect the shared definition.
 */
export const getModelResponseJsonSchema = () => structuredClone(PROVIDER_SCHEMA);
