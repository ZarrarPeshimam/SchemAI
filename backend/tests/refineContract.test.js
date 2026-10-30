import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyOperations } from "../src/services/refinement/applyOperations.js";
import { validateCandidate } from "../src/services/refinement/refinementValidator.js";
import { parseModelResponse } from "../src/services/refinement/operationSchema.js";
import { mockSchema } from "../src/data/mockSchema.js";

/**
 * Regression tests for the exact `date_of_birth` failure reported from the logs. Pure: no LLM, no network, no database.
 * Instruction: "Add a date_of_birth attribute of type DATE to Customer. It should be nullable."
 */

const proposal = (operations) => ({ outcome: "operations", message: "Add date_of_birth to Customer", operations });
const attrOf = (schema, entityId, name) => schema.entities.find((e) => e.id === entityId)?.attributes.find((a) => a.name === name);

// Shapes copied from the reported logs.
const LOGGED_FIRST_RESPONSE = { op: "add_attribute", entity: "customer", foreignKey: false, nullable: true, primaryKey: false, unique: false };
const LOGGED_REPAIR_RESPONSE = { op: "add_attribute", entity: "customer", newName: "date_of_birth", type: "DATE", unique: false };
const CANONICAL = { op: "add_attribute", entity: "customer", attributeDefinition: { name: "date_of_birth", type: "DATE", nullable: true } };

const applyAndCheck = (operations) => {
  const original = structuredClone(mockSchema);
  const applied = applyOperations(original, operations);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const check = validateCandidate(original, applied.schema);
  assert.equal(check.valid, true, JSON.stringify(check.issues));
  return { original, applied, check };
};

describe("date_of_birth regression (exact logged shapes)", () => {
  it("rejects the first logged response (flags only, no name/type) and invents nothing", () => {
    const parsed = parseModelResponse(proposal([LOGGED_FIRST_RESPONSE]));
    assert.equal(parsed.ok, false);
    const text = parsed.issues.join(" | ");
    assert.match(text, /add_attribute requires attributeDefinition/);
    // The issue is what the repair prompt shows the model: it must say how to fix the shape.
    assert.match(text, /'name' and 'type'/);
    assert.match(text, /modify_attribute/);
  });

  it("normalizes the second logged response (newName + type, no nullable) into the canonical shape", () => {
    const parsed = parseModelResponse(proposal([LOGGED_REPAIR_RESPONSE]));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.data.operations[0].attributeDefinition, { name: "date_of_birth", type: "DATE", unique: false });
    for (const k of ["newName", "type", "unique"]) assert.equal(parsed.data.operations[0][k], undefined, `${k} must be moved into attributeDefinition`);
  });

  it("adds exactly one nullable DATE column to Customer and changes nothing else (logged repair shape)", () => {
    const parsed = parseModelResponse(proposal([LOGGED_REPAIR_RESPONSE]));
    const { original, applied } = applyAndCheck(parsed.data.operations);

    const dob = attrOf(applied.schema, "customer", "date_of_birth");
    assert.ok(dob);
    assert.equal(dob.type, "DATE");
    assert.equal(dob.nullable, true);
    assert.equal(dob.primaryKey, false);
    assert.equal(dob.foreignKey, false);

    const customer = applied.schema.entities.find((e) => e.id === "customer");
    assert.deepEqual(customer.attributes.slice(0, -1), original.entities.find((e) => e.id === "customer").attributes);
    assert.equal(customer.attributes.length, original.entities.find((e) => e.id === "customer").attributes.length + 1);
    assert.deepEqual(applied.schema.relationships, original.relationships);
    for (const e of original.entities.filter((x) => x.id !== "customer")) {
      assert.deepEqual(applied.schema.entities.find((x) => x.id === e.id), e);
    }
    assert.equal(applied.schema.entities.length, original.entities.length);
  });

  it("the canonical shape and the normalized logged shape produce the identical schema", () => {
    const a = applyAndCheck(parseModelResponse(proposal([CANONICAL])).data.operations).applied.schema;
    const b = applyAndCheck(parseModelResponse(proposal([LOGGED_REPAIR_RESPONSE])).data.operations).applied.schema;
    assert.deepEqual(a, b);
  });

  it("applying never mutates the input schema", () => {
    const original = structuredClone(mockSchema);
    const snapshot = structuredClone(original);
    applyOperations(original, parseModelResponse(proposal([CANONICAL])).data.operations);
    assert.deepEqual(original, snapshot);
  });

  it("rejects adding date_of_birth twice (no silent overwrite)", () => {
    const first = applyAndCheck(parseModelResponse(proposal([CANONICAL])).data.operations).applied.schema;
    const again = applyOperations(first, parseModelResponse(proposal([CANONICAL])).data.operations);
    assert.equal(again.ok, false);
    assert.match(again.issues[0], /already exists/);
  });
});

describe("normalizeOperations precedence and ambiguity", () => {
  it("nested attributeDefinition values win over conflicting stray top-level fields", () => {
    const parsed = parseModelResponse(
      proposal([{ op: "add_attribute", entity: "customer", type: "INT", nullable: false, attributeDefinition: { name: "date_of_birth", type: "DATE", nullable: true } }])
    );
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.data.operations[0].attributeDefinition, { name: "date_of_birth", type: "DATE", nullable: true });
    assert.equal(parsed.data.operations[0].type, undefined);
    assert.equal(parsed.data.operations[0].nullable, undefined);
  });

  it("top-level fields only fill gaps in a nested definition", () => {
    const parsed = parseModelResponse(
      proposal([{ op: "add_attribute", entity: "customer", nullable: true, attributeDefinition: { name: "date_of_birth", type: "DATE" } }])
    );
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.operations[0].attributeDefinition, { name: "date_of_birth", type: "DATE", nullable: true });
  });

  it("does not normalize when the name or the type is missing", () => {
    assert.equal(parseModelResponse(proposal([{ op: "add_attribute", entity: "customer", newName: "date_of_birth" }])).ok, false);
    assert.equal(parseModelResponse(proposal([{ op: "add_attribute", entity: "customer", type: "DATE" }])).ok, false);
  });

  it("does not touch modify_attribute, where top-level newName/type are the canonical fields", () => {
    const op = { op: "modify_attribute", entity: "customer", attribute: "name", newName: "full_name", type: "TEXT" };
    const parsed = parseModelResponse(proposal([op]));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.operations[0].newName, "full_name");
    assert.equal(parsed.data.operations[0].type, "TEXT");
    assert.equal(parsed.data.operations[0].attributeDefinition, undefined);
  });
});
