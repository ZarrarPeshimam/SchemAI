import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RunnableLambda } from "@langchain/core/runnables";
import app from "../src/app.js";
import { useTestModelCatalog, resetTestModelCatalog } from "./helpers/testModelCatalog.js";
import { geminiService } from "../src/services/geminiService.js";
import { refinementService, MAX_REPAIR_ATTEMPTS } from "../src/services/refinementService.js";
import { applyOperations } from "../src/services/refinement/applyOperations.js";
import { mockSchema } from "../src/data/mockSchema.js";

/**
 * Refinement tests. No test can reach the network or use a real API key:
 *  - most tests inject a fake LangChain chat model (the real prompt templates still run),
 *  - the "real LangChain wiring" tests stub global fetch,
 *  - GEMINI_* env vars are cleared before every test.
 */

const pk = (name, type = "INT") => ({ name, type, primaryKey: true, foreignKey: false, nullable: false, unique: true });
const col = (name, type = "VARCHAR", extra = {}) => ({ name, type, primaryKey: false, foreignKey: false, nullable: true, unique: false, ...extra });

const hrSchema = () => ({
  entities: [
    { id: "employee", name: "Employee", description: "Staff", attributes: [pk("employee_id"), col("name", "VARCHAR", { nullable: false }), col("email", "VARCHAR")] },
    { id: "orders", name: "Orders", description: "Customer orders", attributes: [pk("order_id")] },
    { id: "products", name: "Products", description: "Catalogue", attributes: [pk("product_id"), col("title")] },
  ],
  relationships: [],
});

const attrOf = (schema, entityId, name) => schema.entities.find((e) => e.id === entityId)?.attributes.find((a) => a.name === name);
const ops = (message, operations) => ({ outcome: "operations", message, operations });

/** Fake LangChain chat model. Queue items: object (structured result) | Error (thrown) | function(promptValue). */
function makeFakeModel(queue) {
  const prompts = [];
  return {
    prompts,
    withStructuredOutput: () =>
      RunnableLambda.from(async (promptValue) => {
        prompts.push(promptValue.toString());
        if (queue.length === 0) throw new Error("Unexpected extra LLM call");
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (typeof next === "function") return next(promptValue);
        return next;
      }),
  };
}
const providerError = (status, message = "provider failure") => Object.assign(new Error(message), { name: "ApiError", status });

describe("POST /api/schema/refine", () => {
  let server;
  let baseUrl;
  const savedEnv = {};
  const originalModel = refinementService.chain.model;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    useTestModelCatalog();
    for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_TIMEOUT_MS"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    refinementService.chain.model = null;
    geminiService.client = null;
  });
  afterEach(() => {
    resetTestModelCatalog();
    refinementService.chain.model = originalModel;
    geminiService.client = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const post = async (body, path = "/schema/refine") => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const refine = (schema, instruction, queue) => {
    const model = makeFakeModel(queue);
    refinementService.chain.model = model;
    const snapshot = structuredClone(schema);
    return post({ schema, instruction }).then((r) => ({ ...r, model, snapshot }));
  };

  // ---- request validation ----------------------------------------------------------------------------------------
  describe("request validation (no model call)", () => {
    const cases = [
      ["missing instruction", { schema: hrSchema() }],
      ["blank instruction", { schema: hrSchema(), instruction: "   " }],
      ["missing schema", { instruction: "Add x" }],
      ["instruction too long", { schema: hrSchema(), instruction: "x".repeat(1001) }],
    ];
    for (const [label, payload] of cases) {
      it(`rejects ${label} with 400 MALFORMED_REQUEST`, async () => {
        const model = makeFakeModel([]);
        refinementService.chain.model = model;
        const { status, body } = await post(payload);
        assert.equal(status, 400);
        assert.equal(body.error.code, "MALFORMED_REQUEST");
        assert.equal(model.prompts.length, 0);
      });
    }

    it("rejects a structurally invalid current schema with 422 INVALID_BASE_SCHEMA", async () => {
      const bad = hrSchema();
      bad.entities[0].attributes = [col("name")]; // no primary key
      const model = makeFakeModel([]);
      refinementService.chain.model = model;
      const { status, body } = await post({ schema: bad, instruction: "Add x" });
      assert.equal(status, 422);
      assert.equal(body.error.code, "INVALID_BASE_SCHEMA");
      assert.equal(model.prompts.length, 0);
    });

    it("returns 503 MISSING_API_KEY when no key is configured (real model path)", async () => {
      const { status, body } = await post({ schema: hrSchema(), instruction: "Add salary" });
      assert.equal(status, 503);
      assert.equal(body.error.code, "MISSING_API_KEY");
    });
  });

  // ---- successful changes ----------------------------------------------------------------------------------------
  describe("successful refinements", () => {
    it("adds an attribute and preserves everything else", async () => {
      const { status, body, model, snapshot } = await refine(hrSchema(), "Add a salary attribute of type DECIMAL to Employee", [
        ops("Added salary", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]),
      ]);
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.repairAttempts, 0);
      assert.equal(attrOf(body.data.schema, "employee", "salary").type, "DECIMAL");
      // unrelated entities / attributes untouched
      assert.deepEqual(body.data.schema.entities.find((e) => e.id === "products"), snapshot.entities.find((e) => e.id === "products"));
      assert.deepEqual(
        body.data.schema.entities[0].attributes.slice(0, 3),
        snapshot.entities[0].attributes
      );
      assert.equal(body.data.validation.valid, true);
      assert.ok(body.data.summary.changes.some((c) => /salary/.test(c)));
      assert.equal(model.prompts.length, 1);
      // the prompt carried both the current schema and the instruction (LangChain template ran for real)
      assert.match(model.prompts[0], /"employee_id"/);
      assert.match(model.prompts[0], /<instruction>\s*Add a salary attribute/);
    });

    it("modifies an attribute: VARCHAR(255) + unique, and notes that length is not stored", async () => {
      const { body } = await refine(hrSchema(), "Change email to VARCHAR(255) and make it unique", [
        ops("Email updated", [{ op: "modify_attribute", entity: "employee", attribute: "email", type: "VARCHAR(255)", unique: true }]),
      ]);
      const email = attrOf(body.data.schema, "employee", "email");
      assert.equal(email.type, "VARCHAR");
      assert.equal(email.unique, true);
      assert.ok(body.data.summary.changes.some((c) => /Length\/precision/.test(c)));
    });

    it("renaming / retyping a referenced key propagates to foreign keys", async () => {
      const { body } = await refine(mockSchema, "Rename customer_id to id and use BIGINT", [
        ops("Rename", [{ op: "modify_attribute", entity: "customer", attribute: "customer_id", newName: "id", type: "BIGINT" }]),
      ]);
      assert.equal(body.data.status, "applied");
      const fk = attrOf(body.data.schema, "order", "customer_id");
      assert.deepEqual(fk.references, { entity: "customer", attribute: "id" });
      assert.equal(fk.type, "BIGINT");
    });

    it("adds an entity then connects it with a 1:N relationship, creating the foreign key", async () => {
      const { body } = await refine(hrSchema(), "Add a Department entity and connect it to Employee (one-to-many)", [
        ops("Department", [
          {
            op: "add_entity",
            entityDefinition: { id: "department", name: "Department", description: "Org units", attributes: [{ name: "department_id", type: "INT", primaryKey: true }, { name: "name", type: "VARCHAR" }] },
          },
          { op: "add_relationship", relationship: { source: "department", target: "employee", name: "employs", cardinality: "1:N" } },
        ]),
      ]);
      assert.equal(body.data.status, "applied");
      const fk = attrOf(body.data.schema, "employee", "department_id");
      assert.equal(fk.foreignKey, true);
      assert.deepEqual(fk.references, { entity: "department", attribute: "department_id" });
      assert.equal(fk.nullable, true); // existing child table: optional participation
      assert.ok(body.data.schema.relationships.some((r) => r.source === "department" && r.target === "employee" && r.cardinality === "1:N"));
    });

    it("adds a primary key when a new entity has none (and says so)", async () => {
      const { body } = await refine(hrSchema(), "Add Department", [
        ops("Department", [{ op: "add_entity", entityDefinition: { id: "department", name: "Department", attributes: [{ name: "name", type: "VARCHAR" }] } }]),
      ]);
      assert.equal(attrOf(body.data.schema, "department", "department_id").primaryKey, true);
      assert.ok(body.data.summary.changes.some((c) => /primary key/.test(c)));
    });

    it("N:M between two entities creates a junction entity with a composite key and two 1:N relationships", async () => {
      const { body } = await refine(hrSchema(), "Add a many-to-many relationship between Orders and Products", [
        ops("N:M", [{ op: "add_relationship", relationship: { source: "orders", target: "products", name: "contains", cardinality: "N:M" } }]),
      ]);
      assert.equal(body.data.status, "applied");
      const j = body.data.schema.entities.find((e) => e.id === "orders_products");
      assert.ok(j);
      assert.deepEqual(j.attributes.map((a) => [a.name, a.primaryKey, a.foreignKey]), [["order_id", true, true], ["product_id", true, true]]);
      assert.equal(body.data.schema.relationships.filter((r) => r.target === "orders_products" && r.cardinality === "1:N").length, 2);
      assert.equal(body.data.schema.relationships.some((r) => r.cardinality === "N:M"), false);
    });

    it("removes an attribute that nothing depends on", async () => {
      const { body } = await refine(hrSchema(), "Remove the email attribute", [ops("Removed", [{ op: "remove_attribute", entity: "employee", attribute: "email" }])]);
      assert.equal(attrOf(body.data.schema, "employee", "email"), undefined);
      assert.equal(body.data.schema.entities[0].attributes.length, 2);
    });

    it("the refined schema still works with the existing SQL generator", async () => {
      const { body } = await refine(hrSchema(), "Add salary", [
        ops("salary", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]),
      ]);
      const sql = await post({ schema: body.data.schema }, "/schema/sql");
      assert.equal(sql.status, 200);
      assert.match(sql.body.sql, /"salary" NUMERIC\(12, 2\)/);
    });

    it("accepts model output that uses nulls for absent optional fields", async () => {
      const { body } = await refine(hrSchema(), "Add salary", [
        ops("salary", [{ op: "add_attribute", entity: "employee", entityDefinition: null, relationship: null, cascade: null, attributeDefinition: { name: "salary", type: "DECIMAL", references: null } }]),
      ]);
      assert.equal(body.data.status, "applied");
    });
  });

  // ---- clarification / unsupported / destructive -----------------------------------------------------------------
  describe("ambiguity, unsupported and destructive instructions", () => {
    it("returns the model's clarification question; nothing is applied and no repair is attempted", async () => {
      const { status, body, model } = await refine(hrSchema(), "Add a name", [
        { outcome: "needs_clarification", message: "Which entity should get the new 'name' attribute?" },
      ]);
      assert.equal(status, 200);
      assert.equal(body.data.status, "needs_clarification");
      assert.match(body.data.message, /Which entity/);
      assert.equal(body.data.schema, undefined);
      assert.equal(model.prompts.length, 1);
    });

    it("unsupported instructions return 422 REFINEMENT_UNSUPPORTED", async () => {
      const { status, body } = await refine(hrSchema(), "Train a model on it", [{ outcome: "unsupported", message: "Not a schema change." }]);
      assert.equal(status, 422);
      assert.equal(body.error.code, "REFINEMENT_UNSUPPORTED");
    });

    it("removing an entity with dependents asks for clarification instead of deleting dependent data", async () => {
      const { status, body, model } = await refine(mockSchema, "Remove the Customer entity", [ops("rm", [{ op: "remove_entity", entity: "customer" }])]);
      assert.equal(status, 200);
      assert.equal(body.data.status, "needs_clarification");
      assert.match(body.data.message, /address\.customer_id/);
      assert.equal(model.prompts.length, 1);
    });

    it("removes dependents only when the operation is explicitly cascading", async () => {
      const { body } = await refine(mockSchema, "Remove Address and everything that depends on it", [ops("rm", [{ op: "remove_entity", entity: "address", cascade: true }])]);
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.schema.entities.some((e) => e.id === "address"), false);
      assert.equal(body.data.schema.relationships.some((r) => r.target === "address"), false);
      assert.ok(body.data.summary.changes.some((c) => /Removed relationship 'customer-address'/.test(c)));
    });

    it("removing an attribute that other foreign keys reference asks for clarification", async () => {
      const { body } = await refine(mockSchema, "Remove customer_id from Customer", [ops("rm", [{ op: "remove_attribute", entity: "customer", attribute: "customer_id" }])]);
      assert.equal(body.data.status, "needs_clarification");
    });

    it("N:M between entities already linked through a junction asks instead of creating a second one", async () => {
      const { body } = await refine(mockSchema, "Add a many-to-many relationship between Orders and Products", [
        ops("nm", [{ op: "add_relationship", relationship: { source: "order", target: "product", name: "contains", cardinality: "N:M" } }]),
      ]);
      assert.equal(body.data.status, "needs_clarification");
      assert.match(body.data.message, /OrderItem/);
    });
  });

  // ---- failures + repair -----------------------------------------------------------------------------------------
  describe("invalid proposals and bounded repair", () => {
    const dupAttr = ops("dup", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "email", type: "VARCHAR" } }]);

    it("duplicate attribute: fed back to the model, repaired on the second call", async () => {
      const { body, model } = await refine(hrSchema(), "Add email to Employee", [
        dupAttr,
        ops("fixed", [{ op: "modify_attribute", entity: "employee", attribute: "email", unique: true }]),
      ]);
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.repairAttempts, 1);
      assert.equal(model.prompts.length, 2);
      assert.match(model.prompts[1], /already exists in entity 'employee'/);
      assert.match(model.prompts[1], /<previous_proposal>/);
      // repair prompt still carries the ORIGINAL schema (no email-less or modified copy)
      assert.match(model.prompts[1], /<current_schema>/);
    });

    it("duplicate entity is rejected and, when never repaired, the original is preserved", async () => {
      const dup = ops("dup", [{ op: "add_entity", entityDefinition: { id: "employee2", name: "employee", attributes: [{ name: "x_id", type: "INT", primaryKey: true }] } }]);
      const { status, body, model, snapshot } = await refine(hrSchema(), "Add Employee", [dup, dup, dup]);
      assert.equal(status, 422);
      assert.equal(body.error.code, "REFINEMENT_FAILED");
      assert.equal(model.prompts.length, 1 + MAX_REPAIR_ATTEMPTS); // exactly 3 calls, never more
      assert.ok(body.error.details.some((d) => /already exists/.test(d)));
      assert.equal(body.data, undefined);
      assert.deepEqual(hrSchema(), snapshot);
    });

    it("invalid foreign key target fails validation after at most two repairs", async () => {
      const badFk = ops("fk", [
        { op: "add_attribute", entity: "employee", attributeDefinition: { name: "ghost_id", type: "INT", foreignKey: true, references: { entity: "ghost", attribute: "ghost_id" } } },
      ]);
      const { status, body, model } = await refine(hrSchema(), "Link employee to ghost", [badFk, badFk, badFk]);
      assert.equal(status, 422);
      assert.equal(body.error.code, "REFINEMENT_FAILED");
      assert.equal(model.prompts.length, 3);
      assert.ok(body.error.details.some((d) => /INVALID_FOREIGN_KEY_TARGET_ENTITY/.test(d)));
      assert.match(model.prompts[2], /INVALID_FOREIGN_KEY_TARGET_ENTITY/);
    });

    it("relationship with a non-existent endpoint is rejected (and repairable)", async () => {
      const bad = ops("rel", [{ op: "add_relationship", relationship: { source: "department", target: "employee", name: "employs", cardinality: "1:N" } }]);
      const good = ops("rel", [
        { op: "add_entity", entityDefinition: { id: "department", name: "Department", attributes: [{ name: "department_id", type: "INT", primaryKey: true }] } },
        { op: "add_relationship", relationship: { source: "department", target: "employee", name: "employs", cardinality: "1:N" } },
      ]);
      const { body, model } = await refine(hrSchema(), "Connect Department and Employee", [bad, good]);
      assert.equal(body.data.status, "applied");
      assert.match(model.prompts[1], /Entity 'department' does not exist/);
    });

    it("a validator-detected problem (not caught by the applier) blocks the candidate: PK made nullable", async () => {
      const bad = ops("pk", [{ op: "modify_attribute", entity: "employee", attribute: "employee_id", nullable: true }]);
      const { status, body } = await refine(hrSchema(), "Make employee id optional", [bad, bad, bad]);
      assert.equal(status, 422);
      assert.ok(body.error.details.some((d) => /PRIMARY_KEY_NULLABLE/.test(d)));
    });

    it("a NEW foreign-key type mismatch warning blocks the candidate", async () => {
      const bad = ops("fk", [
        { op: "add_attribute", entity: "products", attributeDefinition: { name: "owner_id", type: "VARCHAR", foreignKey: true, references: { entity: "employee", attribute: "employee_id" } } },
      ]);
      const { status, body } = await refine(hrSchema(), "x", [bad, bad, bad]);
      assert.equal(status, 422);
      assert.ok(body.error.details.some((d) => /FOREIGN_KEY_TYPE_MISMATCH/.test(d)));
    });

    it("pre-existing warnings do not block an unrelated edit", async () => {
      const withWarning = hrSchema();
      withWarning.relationships.push({ id: "employee_products", source: "employee", target: "products", name: "x", cardinality: "1:N" }); // no FK -> existing warning
      const { body } = await refine(withWarning, "Add salary", [
        ops("salary", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]),
      ]);
      assert.equal(body.data.status, "applied");
    });

    it("an empty operation list is treated as a failed proposal and repaired", async () => {
      const { body, model } = await refine(hrSchema(), "Add salary", [
        ops("nothing", []),
        ops("salary", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]),
      ]);
      assert.equal(body.data.repairAttempts, 1);
      assert.match(model.prompts[1], /no operations/);
    });

    it("each repair is applied to a fresh copy of the original (earlier ops do not leak into later attempts)", async () => {
      const first = ops("a", [
        { op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } },
        { op: "add_attribute", entity: "employee", attributeDefinition: { name: "ghost", type: "INT", foreignKey: true, references: { entity: "nope", attribute: "id" } } },
      ]);
      const second = ops("b", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]);
      const { body } = await refine(hrSchema(), "x", [first, second]);
      // if attempt 1 had leaked into attempt 2, 'salary' would be a duplicate and attempt 2 would fail
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.schema.entities[0].attributes.filter((a) => a.name === "salary").length, 1);
      assert.equal(attrOf(body.data.schema, "employee", "ghost"), undefined);
    });
  });

  // ---- malformed model output ------------------------------------------------------------------------------------
  describe("malformed model output", () => {
    const malformedCases = [
      ["a non-object", "not an object"],
      ["an unknown outcome", { outcome: "dance", message: "x" }],
      ["an unknown operation type", ops("x", [{ op: "drop_database" }])],
      ["a missing message", { outcome: "operations", operations: [] }],
    ];
    for (const [label, bad] of malformedCases) {
      it(`${label} for every attempt -> 502 MALFORMED_LLM_OUTPUT and the schema is untouched`, async () => {
        const { status, body, model } = await refine(hrSchema(), "Add salary", [bad, bad, bad]);
        assert.equal(status, 502);
        assert.equal(body.error.code, "MALFORMED_LLM_OUTPUT");
        assert.equal(model.prompts.length, 3);
      });
    }

    it("malformed first response followed by a good repair succeeds", async () => {
      const { body, model } = await refine(hrSchema(), "Add salary", [
        { outcome: "dance", message: "x" },
        ops("salary", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]),
      ]);
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.repairAttempts, 1);
      assert.match(model.prompts[1], /Problems found/);
    });

    it("recovers from initial incomplete add_attribute via alternate repair response (newName and type)", async () => {
      const initialMalformed = ops("add attribute", [{ op: "add_attribute", entity: "customer" }]);
      const repairResponse = ops("added dob", [{ op: "add_attribute", entity: "customer", newName: "date_of_birth", type: "DATE", nullable: true }]);
      const { status, body, model, snapshot } = await refine(mockSchema, "Add a date_of_birth attribute of type DATE to Customer. It should be nullable.", [
        initialMalformed,
        repairResponse,
      ]);
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.repairAttempts, 1);
      const dob = attrOf(body.data.schema, "customer", "date_of_birth");
      assert.ok(dob);
      assert.equal(dob.type, "DATE");
      assert.equal(dob.nullable, true);
      assert.match(model.prompts[1], /Canonical structure requirements/);
      assert.match(model.prompts[1], /attributeDefinition/);
      // unrelated entities and relationships untouched
      assert.deepEqual(body.data.schema.relationships, snapshot.relationships);
      for (const e of snapshot.entities.filter((x) => x.id !== "customer")) {
        assert.deepEqual(body.data.schema.entities.find((x) => x.id === e.id), e);
      }
    });

    it("date_of_birth: exact logged sequence (flags-only proposal, then newName/type repair) ends in one correct nullable DATE column", async () => {
      const instruction = "Add a date_of_birth attribute of type DATE to Customer. It should be nullable.";
      const first = ops("add attribute", [{ op: "add_attribute", entity: "customer", foreignKey: false, nullable: true, primaryKey: false, unique: false }]);
      const repair = ops("added dob", [{ op: "add_attribute", entity: "customer", newName: "date_of_birth", type: "DATE", unique: false }]);
      const { status, body, model, snapshot } = await refine(mockSchema, instruction, [first, repair]);

      assert.equal(status, 200);
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.repairAttempts, 1);
      assert.equal(model.prompts.length, 2);
      // The repair prompt carries the ORIGINAL instruction + schema, the model's own malformed output and an actionable issue.
      assert.match(model.prompts[1], /Add a date_of_birth attribute of type DATE to Customer/);
      assert.match(model.prompts[1], /<current_schema>/);
      assert.match(model.prompts[1], /"foreignKey":false/);
      assert.match(model.prompts[1], /'name' and 'type'/);

      const dob = attrOf(body.data.schema, "customer", "date_of_birth");
      assert.ok(dob);
      assert.equal(dob.type, "DATE");
      assert.equal(dob.nullable, true);
      assert.equal(body.data.schema.entities.length, snapshot.entities.length);
      assert.equal(body.data.schema.entities.find((e) => e.id === "customer").attributes.length, snapshot.entities.find((e) => e.id === "customer").attributes.length + 1);
      assert.deepEqual(body.data.schema.relationships, snapshot.relationships);
    });

    it("rejects proposals with more than 25 operations", async () => {
      const many = ops("lots", Array.from({ length: 26 }, (_, i) => ({ op: "add_attribute", entity: "employee", attributeDefinition: { name: `c${i}`, type: "INT" } })));
      const { status, body } = await refine(hrSchema(), "x", [many, many, many]);
      assert.equal(status, 502);
      assert.equal(body.error.code, "MALFORMED_LLM_OUTPUT");
    });
  });

  // ---- Gemini / provider errors ----------------------------------------------------------------------------------
  describe("Gemini API errors", () => {
    const cases = [
      ["429 rate limit", providerError(429), 429, "RATE_LIMIT_EXCEEDED"],
      ["401 auth", providerError(401), 503, "LLM_AUTH_ERROR"],
      ["404 model", providerError(404), 503, "MODEL_UNAVAILABLE"],
      ["500 provider", providerError(500, "internal"), 502, "LLM_PROVIDER_ERROR"],
      ["timeout", Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" }), 504, "LLM_TIMEOUT"],
    ];
    for (const [label, err, status, code] of cases) {
      it(`${label} -> ${status} ${code}, no retry, schema untouched`, async () => {
        const res = await refine(hrSchema(), "Add salary", [err]);
        assert.equal(res.status, status);
        assert.equal(res.body.error.code, code);
        assert.equal(res.model.prompts.length, 1);
      });
    }

    it("a real AbortSignal.timeout() error -> 504 LLM_TIMEOUT after a single call (no retry, no repair)", async () => {
      const signal = AbortSignal.timeout(5);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const res = await refine(hrSchema(), "Add salary", [signal.reason]);
      assert.equal(res.status, 504);
      assert.equal(res.body.error.code, "LLM_TIMEOUT");
      assert.equal(res.model.prompts.length, 1);
      assert.equal(res.body.data, undefined, "a timeout must not return a schema");
    });

    it("a timeout during a repair attempt is still LLM_TIMEOUT (not malformed output) and stops the loop", async () => {
      const signal = AbortSignal.timeout(5);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const res = await refine(hrSchema(), "x", [ops("bad", [{ op: "add_attribute", entity: "employee" }]), signal.reason]);
      assert.equal(res.status, 504);
      assert.equal(res.body.error.code, "LLM_TIMEOUT");
      assert.equal(res.model.prompts.length, 2);
    });

    it("a provider failure during a repair attempt is also surfaced safely", async () => {
      const res = await refine(hrSchema(), "x", [ops("dup", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "email", type: "VARCHAR" } }]), providerError(429)]);
      assert.equal(res.status, 429);
      assert.equal(res.model.prompts.length, 2);
    });

    it("never leaks provider messages or API keys", async () => {
      const res = await refine(hrSchema(), "x", [providerError(500, "boom key=AIzaSyFAKE_SECRET_KEY_1234567890abcdef at /srv/internal.js:1")]);
      const text = JSON.stringify(res.body);
      assert.equal(text.includes("AIza"), false);
      assert.equal(text.includes("/srv/"), false);
      assert.equal(text.includes("stack"), false);
    });
  });

  // ---- real LangChain + Gemini wiring, HTTP stubbed --------------------------------------------------------------
  describe("real LangChain wiring (global fetch stubbed, no network)", () => {
    const realFetch = globalThis.fetch;
    let requests;
    const gemini = (status, body) => async (url, init) => {
      if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, init);
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    const textResponse = (text) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }] });

    beforeEach(() => {
      requests = [];
      process.env.GEMINI_API_KEY = "AIzaFAKEKEYFAKEKEYFAKEKEYFAKEKEY12345";
      process.env.GEMINI_MODEL = "gemini-test-model";
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("uses the configured Gemini model + key with JSON structured output and parses the result", async () => {
      globalThis.fetch = gemini(200, textResponse(JSON.stringify(ops("salary", [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]))));
      const { status, body } = await post({ schema: hrSchema(), instruction: "Add salary DECIMAL to Employee" });
      assert.equal(status, 200);
      assert.equal(attrOf(body.data.schema, "employee", "salary").type, "DECIMAL");
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /models\/gemini-test-model:generateContent/);
      assert.equal(requests[0].body.generationConfig.responseMimeType, "application/json");
      assert.ok(requests[0].body.generationConfig.responseSchema.properties.operations);
      assert.match(JSON.stringify(requests[0].body.contents), /Add salary DECIMAL to Employee/);
    });

    it("unparseable model text is handled as malformed output (3 bounded calls) -> 502", async () => {
      globalThis.fetch = gemini(200, textResponse("Sure! Here is your schema: {oops"));
      const { status, body } = await post({ schema: hrSchema(), instruction: "Add salary" });
      assert.equal(status, 502);
      assert.equal(body.error.code, "MALFORMED_LLM_OUTPUT");
      assert.equal(requests.length, 1 + MAX_REPAIR_ATTEMPTS);
    });

    it("an HTTP 429 from Gemini maps to 429 RATE_LIMIT_EXCEEDED after a single call", async () => {
      globalThis.fetch = gemini(429, { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } });
      const { status, body } = await post({ schema: hrSchema(), instruction: "Add salary" });
      assert.equal(status, 429);
      assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED");
      assert.equal(requests.length, 1);
    });
  });

  // ---- initial generation is untouched ---------------------------------------------------------------------------
  it("initial generation still uses the direct @google/genai client and never touches the LangChain model", async () => {
    const lcModel = makeFakeModel([]);
    refinementService.chain.model = lcModel;
    const generated = { entities: [{ id: "a", name: "A", description: "", attributes: [pk("a_id")] }], relationships: [] };
    const calls = [];
    geminiService.client = { models: { generateContent: async (p) => (calls.push(p), { text: JSON.stringify(generated) }) } };
    const { status, body } = await post({ requirement: "A thing" }, "/schema/generate");
    assert.equal(status, 200);
    assert.equal(body.data.schema.entities[0].id, "a");
    assert.equal(calls.length, 1);
    assert.equal(lcModel.prompts.length, 0);
  });
});

describe("applyOperations (deterministic, no LLM)", () => {
  it("never mutates its input", () => {
    const input = hrSchema();
    const snapshot = structuredClone(input);
    const res = applyOperations(input, [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "salary", type: "DECIMAL" } }]);
    assert.equal(res.ok, true);
    assert.deepEqual(input, snapshot);
    assert.notEqual(res.schema, input);
  });

  it("resolves entities by id or case-insensitive name", () => {
    const res = applyOperations(hrSchema(), [{ op: "add_attribute", entity: "EMPLOYEE", attributeDefinition: { name: "salary", type: "decimal(10,2)" } }]);
    assert.equal(res.ok, true);
    assert.equal(attrOf(res.schema, "employee", "salary").type, "DECIMAL");
  });

  it("rejects unsupported data types, bad identifiers and missing fields with precise issues", () => {
    const run = (op) => applyOperations(hrSchema(), [op]);
    assert.match(run({ op: "add_attribute", entity: "employee", attributeDefinition: { name: "x", type: "MONEY" } }).issues[0], /not supported/);
    assert.match(run({ op: "add_attribute", entity: "employee", attributeDefinition: { name: "bad name", type: "INT" } }).issues[0], /valid identifier/);
    assert.match(run({ op: "add_attribute", entity: "employee" }).issues[0], /requires 'attributeDefinition'/);
    assert.match(run({ op: "modify_attribute", entity: "employee", attribute: "email" }).issues[0], /at least one of/);
    assert.match(run({ op: "modify_attribute", entity: "employee", attribute: "nope", unique: true }).issues[0], /does not exist/);
    assert.match(run({ op: "remove_relationship", relationshipId: "nope" }).issues[0], /does not exist/);
    assert.match(run({ op: "add_entity", entityDefinition: { id: "Bad Id", name: "X", attributes: [] } }).issues[0], /snake_case/);
  });

  it("rejects duplicate relationships", () => {
    const op = { op: "add_relationship", relationship: { source: "employee", target: "orders", name: "places", cardinality: "1:N" } };
    const first = applyOperations(hrSchema(), [op]);
    assert.equal(first.ok, true);
    const second = applyOperations(first.schema, [op]);
    assert.equal(second.ok, false);
    assert.match(second.issues[0], /already exists/);
  });

  it("removing a relationship also removes the foreign key that implemented it", () => {
    const res = applyOperations(mockSchema, [{ op: "remove_relationship", relationshipId: "customer-address" }]);
    assert.equal(res.ok, true);
    assert.equal(attrOf(res.schema, "address", "customer_id"), undefined);
    assert.equal(res.schema.relationships.some((r) => r.id === "customer-address"), false);
  });

  it("supports self-referencing 1:N relationships with a nullable parent key", () => {
    const res = applyOperations(hrSchema(), [{ op: "add_relationship", relationship: { source: "employee", target: "employee", name: "manages", cardinality: "1:N" } }]);
    assert.equal(res.ok, true);
    const fk = attrOf(res.schema, "employee", "parent_employee_id");
    assert.equal(fk.nullable, true);
    assert.deepEqual(fk.references, { entity: "employee", attribute: "employee_id" });
  });

  it("1:1 relationships create a unique foreign key", () => {
    const res = applyOperations(hrSchema(), [{ op: "add_relationship", relationship: { source: "employee", target: "orders", name: "has", cardinality: "1:1" } }]);
    assert.equal(attrOf(res.schema, "orders", "employee_id").unique, true);
  });
});
