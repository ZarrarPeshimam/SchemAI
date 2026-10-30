import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyOperations } from "../src/services/refinement/applyOperations.js";
import { validateCandidate } from "../src/services/refinement/refinementValidator.js";
import { parseModelResponse, normalizeOperations, OPERATION_TYPES } from "../src/services/refinement/operationSchema.js";
import { generateSql } from "../src/services/sqlGeneratorService.js";
import { mockSchema } from "../src/data/mockSchema.js";
import { RefinementService } from "../src/services/refinementService.js";

/**
 * Deterministic tests for the operations added for rename / constraint / relationship refinement. No LLM, no network,
 * no database: operations -> applyOperations -> validateCandidate (the same two steps the service runs).
 */

const pk = (name, type = "INT") => ({ name, type, primaryKey: true, foreignKey: false, nullable: false, unique: true });
const col = (name, type = "VARCHAR", extra = {}) => ({ name, type, primaryKey: false, foreignKey: false, nullable: true, unique: false, ...extra });

const hr = () => ({
  entities: [
    { id: "employee", name: "Employee", description: "", attributes: [pk("employee_id"), col("department_id", "BIGINT"), col("email")] },
    { id: "department", name: "Department", description: "", attributes: [pk("department_id"), col("title")] },
  ],
  relationships: [],
});
const school = () => ({
  entities: [
    { id: "student", name: "Student", description: "", attributes: [pk("student_id"), col("name")] },
    { id: "course", name: "Course", description: "", attributes: [pk("course_id")] },
  ],
  relationships: [{ id: "student-course", source: "student", target: "course", name: "enrolls_in", cardinality: "N:M" }],
});

const run = (schema, operations) => {
  const applied = applyOperations(schema, operations);
  if (!applied.ok) return applied;
  return { ...applied, check: validateCandidate(schema, applied.schema) };
};
const attrOf = (schema, entityId, name) => schema.entities.find((e) => e.id === entityId)?.attributes.find((a) => a.name === name);
const entityOf = (schema, id) => schema.entities.find((e) => e.id === id);

describe("operation contract", () => {
  it("exposes the new operations to the model", () => {
    for (const op of ["rename_entity", "modify_relationship", "convert_many_to_many"]) assert.ok(OPERATION_TYPES.includes(op), op);
  });

  it("accepts the new flat fields in a model response", () => {
    const parsed = parseModelResponse({
      outcome: "operations",
      message: "ok",
      operations: [
        { op: "modify_attribute", entity: "employee", attribute: "department_id", foreignKey: true, references: { entity: "department", attribute: "department_id" } },
        { op: "modify_relationship", relationshipId: "r", cardinality: "1:1", relationshipName: "leads" },
        { op: "convert_many_to_many", relationshipId: "r", junctionName: "Enrollment" },
        { op: "rename_entity", entity: "employee", newName: "Staff" },
      ],
    });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  });

  it("still rejects an unknown operation type", () => {
    assert.equal(parseModelResponse({ outcome: "operations", message: "x", operations: [{ op: "drop_database" }] }).ok, false);
  });
});

describe("rename_entity", () => {
  it("renames, keeps the id, and preserves everything else", () => {
    const res = run(mockSchema, [{ op: "rename_entity", entity: "customer", newName: "Client" }]);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.equal(entityOf(res.schema, "customer").name, "Client");
    // relationships and foreign keys still point at the stable id
    assert.deepEqual(attrOf(res.schema, "order", "customer_id").references, { entity: "customer", attribute: "customer_id" });
    assert.equal(res.schema.entities.length, mockSchema.entities.length);
    assert.deepEqual(res.schema.relationships, mockSchema.relationships);
    for (const e of mockSchema.entities.filter((x) => x.id !== "customer")) assert.deepEqual(entityOf(res.schema, e.id), e);
    assert.match(generateSql(res.check.schema).sql, /CREATE TABLE "client"/);
  });

  it("rejects a name that clashes with another entity or its table name", () => {
    assert.match(run(mockSchema, [{ op: "rename_entity", entity: "customer", newName: "product" }]).issues[0], /already uses/);
    assert.match(run(mockSchema, [{ op: "rename_entity", entity: "customer", newName: "Order_Item" }]).issues[0], /already uses/);
  });

  it("rejects missing target, missing/invalid/identical names", () => {
    assert.match(run(mockSchema, [{ op: "rename_entity", entity: "ghost", newName: "X" }]).issues[0], /does not exist/);
    assert.match(run(mockSchema, [{ op: "rename_entity", entity: "customer" }]).issues[0], /requires 'newName'/);
    assert.match(run(mockSchema, [{ op: "rename_entity", entity: "customer", newName: "two words" }]).issues[0], /valid identifier/);
    assert.match(run(mockSchema, [{ op: "rename_entity", entity: "customer", newName: "Customer" }]).issues[0], /already named/);
  });
});

describe("modify_attribute: keys and references", () => {
  it("makes a column a foreign key, aligns its type and adds the missing relationship", () => {
    const res = run(hr(), [
      { op: "modify_attribute", entity: "employee", attribute: "department_id", foreignKey: true, references: { entity: "Department", attribute: "department_id" } },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    const fk = attrOf(res.schema, "employee", "department_id");
    assert.equal(fk.foreignKey, true);
    assert.equal(fk.type, "INT"); // was BIGINT; aligned to the referenced primary key
    assert.deepEqual(fk.references, { entity: "department", attribute: "department_id" });
    assert.equal(res.schema.relationships.length, 1);
    assert.deepEqual(
      { s: res.schema.relationships[0].source, t: res.schema.relationships[0].target, c: res.schema.relationships[0].cardinality },
      { s: "department", t: "employee", c: "1:N" }
    );
    assert.match(generateSql(res.check.schema).sql, /FOREIGN KEY \("department_id"\) REFERENCES "department" \("department_id"\)/);
  });

  it("defaults to the referenced entity's primary key and does not duplicate an existing relationship", () => {
    const schema = hr();
    schema.relationships.push({ id: "department-employee", source: "department", target: "employee", name: "employs", cardinality: "1:N" });
    const res = run(schema, [{ op: "modify_attribute", entity: "employee", attribute: "department_id", foreignKey: true, references: { entity: "department", attribute: "" } }]);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.equal(res.schema.relationships.length, 1);
  });

  it("rejects: foreign key without references, unknown entity, unknown attribute, self reference, contradictory flags", () => {
    const base = { op: "modify_attribute", entity: "employee", attribute: "department_id" };
    assert.match(run(hr(), [{ ...base, foreignKey: true }]).issues[0], /requires 'references'/);
    assert.match(run(hr(), [{ ...base, foreignKey: true, references: { entity: "ghost", attribute: "x" } }]).issues[0], /does not exist/);
    assert.match(run(hr(), [{ ...base, foreignKey: true, references: { entity: "department", attribute: "nope" } }]).issues[0], /does not exist/);
    assert.match(run(hr(), [{ ...base, foreignKey: true, references: { entity: "employee", attribute: "department_id" } }]).issues[0], /cannot reference itself/);
    assert.match(run(hr(), [{ ...base, foreignKey: false, references: { entity: "department", attribute: "department_id" } }]).issues[0], /cannot set foreignKey=false/);
  });

  it("turning a foreign key into a plain column asks first when a relationship relies on it, and only cascades explicitly", () => {
    const ask = run(mockSchema, [{ op: "modify_attribute", entity: "order", attribute: "customer_id", foreignKey: false }]);
    assert.equal(ask.ok, false);
    assert.equal(ask.kind, "clarify");
    const done = run(mockSchema, [{ op: "modify_attribute", entity: "order", attribute: "customer_id", foreignKey: false, cascade: true }]);
    assert.equal(done.ok, true);
    assert.equal(done.check.valid, true, JSON.stringify(done.check.issues));
    assert.equal(attrOf(done.schema, "order", "customer_id").references, undefined);
    assert.equal(done.schema.relationships.some((r) => r.id === "customer-order"), false);
  });

  it("re-pointing a foreign key replaces the relationship that relied on the old target", () => {
    const res = run(mockSchema, [
      { op: "modify_attribute", entity: "order", attribute: "customer_id", foreignKey: true, references: { entity: "product", attribute: "product_id" } },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.equal(res.schema.relationships.some((r) => r.id === "customer-order"), false);
    assert.ok(res.schema.relationships.some((r) => r.source === "product" && r.target === "order"));
  });

  it("primaryKey=true forces NOT NULL; removing the only primary key is rejected by the validator", () => {
    const made = run(hr(), [{ op: "modify_attribute", entity: "employee", attribute: "email", primaryKey: true }]);
    assert.equal(made.check.valid, true);
    assert.equal(attrOf(made.schema, "employee", "email").nullable, false);

    const stripped = run(hr(), [{ op: "modify_attribute", entity: "employee", attribute: "employee_id", primaryKey: false }]);
    assert.equal(stripped.ok, true);
    assert.equal(stripped.check.valid, false);
    assert.match(stripped.check.issues.join(" "), /MISSING_PRIMARY_KEY/);
  });

  it("changes an integer column to decimal and rejects a no-op change", () => {
    const schema = hr();
    schema.entities[0].attributes.push(col("salary", "INT"));
    const res = run(schema, [{ op: "modify_attribute", entity: "employee", attribute: "salary", type: "DECIMAL(10,2)" }]);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.equal(attrOf(res.schema, "employee", "salary").type, "DECIMAL");
    assert.match(run(mockSchema, [{ op: "modify_attribute", entity: "product", attribute: "price", type: "DECIMAL" }]).issues[0], /nothing to change/);
  });

  it("retyping a referenced key keeps the foreign keys that point at it consistent", () => {
    const res = run(mockSchema, [{ op: "modify_attribute", entity: "customer", attribute: "customer_id", type: "BIGINT" }]);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.equal(attrOf(res.schema, "order", "customer_id").type, "BIGINT");
    assert.equal(attrOf(res.schema, "address", "customer_id").type, "BIGINT");
  });
});

describe("modify_relationship", () => {
  it("1:N -> 1:1 makes the foreign key unique, and back again", () => {
    const one = run(mockSchema, [{ op: "modify_relationship", relationshipId: "customer-order", cardinality: "1:1" }]);
    assert.equal(one.ok, true);
    assert.equal(one.check.valid, true, JSON.stringify(one.check.issues));
    assert.equal(attrOf(one.schema, "order", "customer_id").unique, true);
    assert.equal(one.schema.relationships.find((r) => r.id === "customer-order").cardinality, "1:1");

    const many = run(one.schema, [{ op: "modify_relationship", relationshipId: "customer-order", cardinality: "1:N" }]);
    assert.equal(many.check.valid, true);
    assert.equal(attrOf(many.schema, "order", "customer_id").unique, false);
  });

  it("preserves every unrelated relationship and entity", () => {
    const res = run(mockSchema, [{ op: "modify_relationship", relationshipId: "customer-order", cardinality: "1:1" }]);
    assert.deepEqual(res.schema.relationships.filter((r) => r.id !== "customer-order"), mockSchema.relationships.filter((r) => r.id !== "customer-order"));
    for (const e of mockSchema.entities.filter((x) => x.id !== "order")) assert.deepEqual(entityOf(res.schema, e.id), e);
  });

  it("renames a relationship without touching keys", () => {
    const res = run(mockSchema, [{ op: "modify_relationship", relationshipId: "customer-order", relationshipName: "submits" }]);
    assert.equal(res.check.valid, true);
    assert.equal(res.schema.relationships.find((r) => r.id === "customer-order").name, "submits");
    assert.deepEqual(entityOf(res.schema, "order"), entityOf(mockSchema, "order"));
  });

  it("rejects: nothing requested, no-op, unknown id, N:M target", () => {
    assert.match(run(mockSchema, [{ op: "modify_relationship", relationshipId: "customer-order" }]).issues[0], /at least one of/);
    assert.match(run(mockSchema, [{ op: "modify_relationship", relationshipId: "customer-order", cardinality: "1:N" }]).issues[0], /nothing to change/);
    assert.match(run(mockSchema, [{ op: "modify_relationship", relationshipId: "nope", cardinality: "1:1" }]).issues[0], /does not exist/);
    assert.match(run(mockSchema, [{ op: "modify_relationship", relationshipId: "customer-order", cardinality: "N:M" }]).issues[0], /remove_relationship/);
    assert.match(run(mockSchema, [{ op: "modify_relationship", cardinality: "1:1" }]).issues[0], /requires 'relationshipId'/);
  });

  it("asks instead of guessing when the child has several foreign keys to the parent, or the key is part of the primary key", () => {
    const multi = hr();
    multi.entities[0].attributes.push(col("backup_department_id", "INT", { foreignKey: true, references: { entity: "department", attribute: "department_id" } }));
    multi.entities[0].attributes.find((a) => a.name === "department_id").foreignKey = true;
    multi.entities[0].attributes.find((a) => a.name === "department_id").type = "INT";
    multi.entities[0].attributes.find((a) => a.name === "department_id").references = { entity: "department", attribute: "department_id" };
    multi.relationships.push({ id: "department-employee", source: "department", target: "employee", name: "employs", cardinality: "1:N" });
    assert.equal(run(multi, [{ op: "modify_relationship", relationshipId: "department-employee", cardinality: "1:1" }]).kind, "clarify");

    const sharedKey = hr();
    const e = sharedKey.entities[0].attributes;
    e.splice(0, 1, { ...pk("employee_id"), foreignKey: true, references: { entity: "department", attribute: "department_id" } });
    sharedKey.relationships.push({ id: "department-employee", source: "department", target: "employee", name: "is", cardinality: "1:1" });
    assert.equal(run(sharedKey, [{ op: "modify_relationship", relationshipId: "department-employee", cardinality: "1:N" }]).kind, "clarify");
  });

  it("a stored N:M relationship can be realised as a direct 1:N foreign key", () => {
    const res = run(school(), [{ op: "modify_relationship", relationshipId: "student-course", cardinality: "1:N" }]);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.equal(attrOf(res.schema, "course", "student_id").foreignKey, true);
  });
});

describe("convert_many_to_many", () => {
  it("replaces an N:M relationship with an associative entity and two 1:N relationships", () => {
    const res = run(school(), [{ op: "convert_many_to_many", relationshipId: "student-course", junctionName: "Enrollment" }]);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.equal(res.schema.relationships.some((r) => r.cardinality === "N:M"), false);
    assert.equal(res.schema.relationships.length, 2);
    const junction = entityOf(res.schema, "enrollment");
    assert.deepEqual(junction.attributes.map((a) => [a.name, a.primaryKey, a.foreignKey]), [["student_id", true, true], ["course_id", true, true]]);
    assert.deepEqual(junction.attributes.map((a) => a.references.entity), ["student", "course"]);
    assert.match(generateSql(res.check.schema).sql, /PRIMARY KEY \("student_id", "course_id"\)/);
    // unrelated entities untouched
    assert.deepEqual(entityOf(res.schema, "student"), entityOf(school(), "student"));
  });

  it("derives a junction name when none is given", () => {
    const res = run(school(), [{ op: "convert_many_to_many", relationshipId: "student-course" }]);
    assert.equal(res.check.valid, true);
    assert.ok(entityOf(res.schema, "student_course"));
  });

  it("rejects a relationship that is not N:M, a missing id, and a clashing junction name", () => {
    assert.match(run(mockSchema, [{ op: "convert_many_to_many", relationshipId: "customer-order" }]).issues[0], /not N:M/);
    assert.match(run(school(), [{ op: "convert_many_to_many", relationshipId: "ghost" }]).issues[0], /does not exist/);
    assert.match(run(school(), [{ op: "convert_many_to_many", relationshipId: "student-course", junctionName: "Student" }]).issues[0], /already exists/);
  });

  it("is atomic with respect to the input: a failing later operation leaves nothing applied", () => {
    const input = school();
    const snapshot = structuredClone(input);
    const res = applyOperations(input, [
      { op: "convert_many_to_many", relationshipId: "student-course", junctionName: "Enrollment" },
      { op: "add_attribute", entity: "ghost", attributeDefinition: { name: "x", type: "INT" } },
    ]);
    assert.equal(res.ok, false);
    assert.deepEqual(input, snapshot);
  });
});

describe("add_relationship still creates its junction through the shared code path", () => {
  it("N:M between two entities", () => {
    const res = run(hr(), [{ op: "add_relationship", relationship: { source: "employee", target: "department", name: "works_in", cardinality: "N:M", junctionName: "Assignment" } }]);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));
    assert.ok(entityOf(res.schema, "assignment"));
    assert.match(res.changes.join(" "), /Added many-to-many/);
  });
});

describe("add_attribute refinement and normalization (regression tests)", () => {
  it("processes the canonical valid operation: adds exactly one nullable DATE attribute to Customer", () => {
    const canonicalOp = {
      op: "add_attribute",
      entity: "customer",
      attributeDefinition: {
        name: "date_of_birth",
        type: "DATE",
        nullable: true,
      },
    };

    const parsed = parseModelResponse({
      outcome: "operations",
      message: "Add date_of_birth to customer",
      operations: [canonicalOp],
    });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.data.operations[0].attributeDefinition, {
      name: "date_of_birth",
      type: "DATE",
      nullable: true,
    });

    const res = run(mockSchema, parsed.data.operations);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true, JSON.stringify(res.check.issues));

    // Exactly one attribute added to customer
    const customer = entityOf(res.schema, "customer");
    assert.equal(customer.attributes.length, mockSchema.entities.find((e) => e.id === "customer").attributes.length + 1);

    const dob = attrOf(res.schema, "customer", "date_of_birth");
    assert.ok(dob, "date_of_birth attribute must exist");
    assert.equal(dob.name, "date_of_birth");
    assert.equal(dob.type, "DATE");
    assert.equal(dob.nullable, true);
    assert.equal(dob.primaryKey, false);
    assert.equal(dob.foreignKey, false);
    assert.equal(dob.unique, false);

    // Existing attributes of Customer remain unchanged
    const originalCustomer = mockSchema.entities.find((e) => e.id === "customer");
    for (const originalAttr of originalCustomer.attributes) {
      assert.deepEqual(attrOf(res.schema, "customer", originalAttr.name), originalAttr);
    }

    // Unrelated entities and relationships are untouched
    for (const otherEntity of mockSchema.entities.filter((e) => e.id !== "customer")) {
      assert.deepEqual(entityOf(res.schema, otherEntity.id), otherEntity);
    }
    assert.deepEqual(res.schema.relationships, mockSchema.relationships);
  });

  it("handles the initial malformed response from logs: rejects missing attributeDefinition without inventing fields", () => {
    // Initial Gemini response from logs: op="add_attribute", entity="customer", missing attributeDefinition, name, type
    const malformed = {
      outcome: "operations",
      message: "Add attribute",
      operations: [{ op: "add_attribute", entity: "customer" }],
    };

    const parsed = parseModelResponse(malformed);
    assert.equal(parsed.ok, false);
    assert.ok(
      parsed.issues.some((issue) => issue.includes("add_attribute requires attributeDefinition")),
      `Expected issue about attributeDefinition, got: ${JSON.stringify(parsed.issues)}`
    );
  });

  it("safely normalizes the alternate repair response containing newName and type", () => {
    // First repair response from logs: op="add_attribute", entity="customer", newName="date_of_birth", type="DATE"
    const alternateRepair = {
      outcome: "operations",
      message: "Add date of birth",
      operations: [
        {
          op: "add_attribute",
          entity: "customer",
          newName: "date_of_birth",
          type: "DATE",
          nullable: true,
        },
      ],
    };

    const parsed = parseModelResponse(alternateRepair);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.data.operations[0].attributeDefinition, {
      name: "date_of_birth",
      type: "DATE",
      nullable: true,
    });
    // Top-level newName and type were stripped
    assert.equal(parsed.data.operations[0].newName, undefined);
    assert.equal(parsed.data.operations[0].type, undefined);

    const res = run(mockSchema, parsed.data.operations);
    assert.equal(res.ok, true);
    assert.equal(res.check.valid, true);
    const dob = attrOf(res.schema, "customer", "date_of_birth");
    assert.ok(dob);
    assert.equal(dob.type, "DATE");
    assert.equal(dob.nullable, true);
  });

  it("rejects incomplete alternate responses where name or type is missing without inventing them", () => {
    // Missing type
    const missingType = {
      outcome: "operations",
      message: "Add dob",
      operations: [{ op: "add_attribute", entity: "customer", newName: "date_of_birth" }],
    };
    assert.equal(parseModelResponse(missingType).ok, false);

    // Missing name
    const missingName = {
      outcome: "operations",
      message: "Add date column",
      operations: [{ op: "add_attribute", entity: "customer", type: "DATE" }],
    };
    assert.equal(parseModelResponse(missingName).ok, false);

    // Blank name
    const blankName = {
      outcome: "operations",
      message: "Add date column",
      operations: [{ op: "add_attribute", entity: "customer", newName: "   ", type: "DATE" }],
    };
    assert.equal(parseModelResponse(blankName).ok, false);
  });

  it("does not treat newName as an attribute name for other operations", () => {
    const renameEntity = {
      outcome: "operations",
      message: "Rename customer",
      operations: [{ op: "rename_entity", entity: "customer", newName: "Client" }],
    };
    const parsed = parseModelResponse(renameEntity);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.operations[0].newName, "Client");
    assert.equal(parsed.data.operations[0].attributeDefinition, undefined);
  });

  it("end-to-end multi-turn repair: recovers from initial malformed response and applies alternate repair response", async () => {
    // Chain simulates:
    // Attempt 0: initial malformed response (missing attributeDefinition, name, type)
    // Attempt 1: alternate repair response with newName and type
    const fakeChain = {
      calls: [],
      propose: async ({ previous, issues, attempt }) => {
        fakeChain.calls.push({ previous, issues, attempt });
        if (attempt === 0) {
          // Model returned raw malformed output; parseModelResponse rejects it
          const parsed = parseModelResponse({
            outcome: "operations",
            message: "Add attribute",
            operations: [{ op: "add_attribute", entity: "customer" }],
          });
          return parsed.ok ? { ok: true, response: parsed.data } : { ok: false, issues: parsed.issues };
        }
        // Repair attempt 1: model returns alternate structure
        const parsed = parseModelResponse({
          outcome: "operations",
          message: "Added date_of_birth",
          operations: [
            {
              op: "add_attribute",
              entity: "customer",
              newName: "date_of_birth",
              type: "DATE",
              nullable: true,
            },
          ],
        });
        return parsed.ok ? { ok: true, response: parsed.data } : { ok: false, issues: parsed.issues };
      },
    };

    const service = new RefinementService(fakeChain);
    const originalSnapshot = structuredClone(mockSchema);

    const result = await service.refineSchema({
      schema: mockSchema,
      instruction: "Add a date_of_birth attribute of type DATE to Customer. It should be nullable.",
    });

    assert.equal(result.status, "applied");
    assert.equal(result.repairAttempts, 1);
    assert.equal(fakeChain.calls.length, 2);

    // Verify repair call received the issue
    assert.ok(fakeChain.calls[1].issues.length > 0);

    // Verify the refined schema has date_of_birth
    const dob = attrOf(result.schema, "customer", "date_of_birth");
    assert.ok(dob);
    assert.equal(dob.type, "DATE");
    assert.equal(dob.nullable, true);

    // Verify input mockSchema was never mutated
    assert.deepEqual(mockSchema, originalSnapshot);
  });

  it("repair failure preserves the original schema when all repair attempts fail", async () => {
    const fakeChain = {
      calls: [],
      propose: async ({ attempt }) => {
        fakeChain.calls.push(attempt);
        // Returns malformed output on every attempt
        return parseModelResponse({
          outcome: "operations",
          message: "bad",
          operations: [{ op: "add_attribute", entity: "customer" }],
        });
      },
    };

    const service = new RefinementService(fakeChain);
    const originalSnapshot = structuredClone(mockSchema);

    await assert.rejects(
      () =>
        service.refineSchema({
          schema: mockSchema,
          instruction: "Add a date_of_birth attribute of type DATE to Customer. It should be nullable.",
        }),
      (err) => {
        assert.equal(err.statusCode || err.status, 502);
        assert.equal(err.code, "MALFORMED_LLM_OUTPUT");
        return true;
      }
    );

    // Input schema must be preserved untouched
    assert.deepEqual(mockSchema, originalSnapshot);
    // Verified 3 attempts (initial + 2 repairs)
    assert.equal(fakeChain.calls.length, 3);
  });
});
