import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { getModelResponseJsonSchema, findUnsupportedRefs, zodToProviderSchema } from "../src/services/refinement/providerSchema.js";
import { OPERATION_TYPES, parseModelResponse } from "../src/services/refinement/operationSchema.js";
import { GEMINI_SCHEMA_OUTPUT_SCHEMA } from "../src/services/geminiService.js";
import { SUPPORTED_CARDINALITIES } from "../src/validators/schemaValidator.js";

/**
 * The Gemini function-declaration schema does not support `$ref`. These tests inspect the exact plain object that is
 * handed to the SDK (not the Zod source) for both the refinement proposal and the initial-generation schema.
 */

const ALLOWED_KEYWORDS = new Set(["type", "description", "enum", "properties", "required", "items"]);

/** Walks schema NODES (not property names) and returns every keyword outside the Gemini-safe subset. */
function unsupportedKeywords(node, path = "$") {
  const bad = [];
  for (const key of Object.keys(node)) if (!ALLOWED_KEYWORDS.has(key)) bad.push(`${path}.${key}`);
  for (const [name, child] of Object.entries(node.properties ?? {})) bad.push(...unsupportedKeywords(child, `${path}.properties.${name}`));
  if (node.items) bad.push(...unsupportedKeywords(node.items, `${path}.items`));
  return bad;
}

describe("provider-facing JSON Schema (Gemini)", () => {
  it("refinement proposal schema contains no $ref / $defs / definitions anywhere", () => {
    assert.deepEqual(findUnsupportedRefs(getModelResponseJsonSchema()), []);
  });

  it("initial-generation schema contains no $ref / $defs / definitions anywhere", () => {
    assert.deepEqual(findUnsupportedRefs(GEMINI_SCHEMA_OUTPUT_SCHEMA), []);
  });

  it("the reference detector really finds refs (positive control)", () => {
    assert.deepEqual(findUnsupportedRefs({ a: { items: { $ref: "#/x" } }, $defs: {} }), ["$.a.items.$ref", "$.$defs"]);
  });

  it("repeated definitions are expanded inline: the attribute definition is identical in add_attribute and add_entity", () => {
    const op = getModelResponseJsonSchema().properties.operations.items.properties;
    const viaAddAttribute = op.attributeDefinition;
    const viaAddEntity = op.entityDefinition.properties.attributes.items;
    assert.equal(viaAddAttribute.type, "object");
    assert.deepEqual(viaAddEntity.properties, viaAddAttribute.properties);
    assert.deepEqual(viaAddEntity.properties.references.required, ["entity", "attribute"]);
  });

  it("uses only keywords from the Gemini-safe subset", () => {
    assert.deepEqual(unsupportedKeywords(getModelResponseJsonSchema()), []);
    assert.deepEqual(unsupportedKeywords(GEMINI_SCHEMA_OUTPUT_SCHEMA), []);
  });

  it("stays in sync with the Zod contract: enums, required fields and the new operations", () => {
    const s = getModelResponseJsonSchema();
    const op = s.properties.operations.items;
    assert.deepEqual(op.properties.op.enum, OPERATION_TYPES);
    assert.deepEqual(op.properties.cardinality.enum, SUPPORTED_CARDINALITIES);
    assert.deepEqual(op.properties.relationship.properties.cardinality.enum, SUPPORTED_CARDINALITIES);
    assert.deepEqual(s.required, ["outcome", "message"]);
    assert.deepEqual(op.required, ["op"]);
    for (const f of ["primaryKey", "foreignKey", "references", "relationshipName", "junctionName"]) assert.ok(op.properties[f], f);
  });

  it("returns a fresh copy each call so SDK-side mutation cannot corrupt the shared schema", () => {
    const first = getModelResponseJsonSchema();
    delete first.properties.operations;
    first.required.push("junk");
    const second = getModelResponseJsonSchema();
    assert.ok(second.properties.operations);
    assert.deepEqual(second.required, ["outcome", "message"]);
  });

  it("application-side Zod validation is unchanged: it still rejects malformed model output", () => {
    assert.equal(parseModelResponse({ outcome: "operations", message: "ok", operations: [{ op: "rename_entity", entity: "a", newName: "B" }] }).ok, true);
    assert.equal(parseModelResponse({ outcome: "maybe", message: "x" }).ok, false);
    assert.equal(parseModelResponse({ outcome: "operations", message: "x", operations: [{ op: "drop_table" }] }).ok, false);
  });

  it("the converter inlines shared Zod instances and fails loudly on unsupported constructs", () => {
    const shared = z.object({ id: z.string() });
    const out = zodToProviderSchema(z.object({ a: shared, b: z.array(shared), c: z.enum(["x", "y"]).optional() }));
    assert.deepEqual(out.properties.a, out.properties.b.items);
    assert.deepEqual(out.required, ["a", "b"]);
    assert.deepEqual(findUnsupportedRefs(out), []);
    assert.throws(() => zodToProviderSchema(z.object({ u: z.union([z.string(), z.number()]) })), /unsupported Zod type/);
  });
});
