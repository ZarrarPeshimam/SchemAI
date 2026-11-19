import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeModel } from "./helpers/fakeConversationModel.js";
import { RefinementService, MAX_REPAIR_ATTEMPTS } from "../src/services/refinementService.js";
import { ConversationRefinementService } from "../src/services/conversationRefinementService.js";
import { parseModelResponse } from "../src/services/refinement/operationSchema.js";
import { mapProviderError } from "../src/services/providerErrors.js";
import { createAppError } from "../src/services/appError.js";

/**
 * End-to-end: conversation id -> stored schema -> (scripted) Gemini proposal -> normalize -> execute -> validate ->
 * atomic versioned save. The ONLY fakes are the model (a script of raw proposals / errors, shaped like what
 * RefinementChain.propose returns) and the Mongoose model (tests/helpers/fakeConversationModel.js, which is a test
 * double and does not prove real MongoDB behaviour).
 */

const pk = (name, type = "INT") => ({ name, type, primaryKey: true, foreignKey: false, nullable: false, unique: true });
const col = (name, type = "VARCHAR", extra = {}) => ({ name, type, primaryKey: false, foreignKey: false, nullable: true, unique: false, ...extra });

const storedSchema = () => ({
  entities: [
    { id: "customer", name: "Customer", description: "", attributes: [pk("customer_id"), col("email", "VARCHAR", { nullable: false }), col("phone_number")] },
    { id: "department", name: "Department", description: "", attributes: [pk("department_id")] },
    { id: "employee", name: "Employee", description: "", attributes: [pk("employee_id"), col("employee_name")] },
  ],
  relationships: [],
});

/** What `RefinementChain.propose` returns, driven by a script. Items: raw proposal | Error | { malformed: [issues] }. */
function scriptedChain(script) {
  const calls = [];
  return {
    calls,
    async propose({ schema, instruction, previous, issues, attempt }) {
      calls.push({ schema: structuredClone(schema), instruction, previous, issues, attempt });
      if (script.length === 0) throw new Error("Unexpected extra model call");
      const next = script.shift();
      if (next instanceof Error) throw next;
      if (next.malformed) return { ok: false, issues: next.malformed, raw: { note: "unreadable" } };
      const parsed = parseModelResponse(next);
      return parsed.ok ? { ok: true, response: parsed.data } : { ok: false, issues: parsed.issues, raw: next };
    },
  };
}
const ops = (message, operations) => ({ outcome: "operations", message, operations });

describe("conversation refinement, end to end", () => {
  const convId = "64b7f0c2a1b2c3d4e5f60718";
  let db;
  const build = (script, { connected = () => true } = {}) => {
    const chain = scriptedChain(script);
    const refiner = new RefinementService(chain);
    const service = new ConversationRefinementService({ model: db, refiner, connected });
    return { chain, service };
  };
  const stored = () => db.store.get(convId);

  beforeEach(() => {
    db = makeFakeModel([{ _id: convId, title: "T", schema: storedSchema(), schemaVersion: 3, messages: [] }]);
  });

  it("applies a plain-English change to the STORED schema, validates it, saves it atomically and bumps the version", async () => {
    const { chain, service } = build([
      // sloppy-but-equivalent shape: flat fields instead of attributeDefinition
      ops("Add date of birth", [{ op: "add_attribute", entity: "Customer", name: "date_of_birth", type: "date", nullable: true }, { op: "modify_attribute", entity: "customer", attribute: "email", unique: true }]),
    ]);
    const out = await service.refine({ conversationId: convId, instruction: "Add date of birth to Customer and make email unique", expectedVersion: 3, model: "m" });

    assert.equal(out.status, "applied");
    assert.equal(out.persisted, true);
    assert.equal(out.schemaVersion, 4);
    assert.equal(chain.calls.length, 1);
    assert.equal(stored().schemaVersion, 4);
    const customer = stored().schema.entities.find((e) => e.id === "customer");
    assert.deepEqual(customer.attributes.find((a) => a.name === "date_of_birth"), col("date_of_birth", "DATE", { nullable: true }));
    assert.equal(customer.attributes.find((a) => a.name === "email").unique, true);
    assert.deepEqual(stored().schema.entities.find((e) => e.id === "department"), storedSchema().entities[1], "unrelated entities preserved");
    assert.deepEqual(stored().messages.map((m) => [m.role, m.operation, m.schemaVersion]), [["user", "refine", 3], ["assistant", "refine", 4]]);
    assert.equal(db.calls.findOneAndUpdate, 1);
  });

  it("the model is shown the schema stored in the database, never a client copy", async () => {
    const { chain, service } = build([ops("x", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "n", type: "INT" } }])]);
    await service.refine({ conversationId: convId, instruction: "add n", model: "m" });
    assert.deepEqual(chain.calls[0].schema, storedSchema());
  });

  it("asks a clarification without touching the schema or the version", async () => {
    const { service } = build([{ outcome: "needs_clarification", message: "Which entity?" }]);
    const out = await service.refine({ conversationId: convId, instruction: "add a name", model: "m" });
    assert.equal(out.status, "needs_clarification");
    assert.deepEqual(stored().schema, storedSchema());
    assert.equal(stored().schemaVersion, 3);
  });

  it("an unsafe destructive request is answered with an explanation and changes nothing", async () => {
    db.store.get(convId).schema.entities.push({ id: "invoice", name: "Invoice", description: "", attributes: [pk("invoice_id"), col("customer_id", "INT", { foreignKey: true, references: { entity: "customer", attribute: "customer_id" } })] });
    db.store.get(convId).schema.relationships.push({ id: "customer_invoice", source: "customer", target: "invoice", name: "has", cardinality: "1:N" });
    const before = structuredClone(stored().schema);
    const { service } = build([ops("rm", [{ op: "remove_entity", entity: "customer" }])]);
    const out = await service.refine({ conversationId: convId, instruction: "Remove the Customer entity", model: "m" });
    assert.equal(out.status, "needs_clarification");
    assert.match(out.message, /invoice\.customer_id/);
    assert.deepEqual(stored().schema, before);
    assert.equal(stored().schemaVersion, 3);
  });

  describe("bounded correction", () => {
    it("an operation the executor rejects is fed back with the problem; the corrected proposal is applied", async () => {
      const { chain, service } = build([
        ops("bad", [{ op: "add_attribute", entity: "ghost", attributeDefinition: { name: "x", type: "INT" } }]),
        ops("good", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "x", type: "INT" } }]),
      ]);
      const out = await service.refine({ conversationId: convId, instruction: "add x to customer", model: "m" });
      assert.equal(out.status, "applied");
      assert.equal(out.repairAttempts, 1);
      assert.equal(chain.calls.length, 2);
      assert.equal(chain.calls[1].attempt, 1);
      assert.match(chain.calls[1].issues.join(" "), /Entity 'ghost' does not exist/);
      assert.equal(stored().schemaVersion, 4);
    });

    it("a malformed response is retried only with the validation error as new context, then gives up (never loops)", async () => {
      const { chain, service } = build(Array.from({ length: MAX_REPAIR_ATTEMPTS + 1 }, () => ({ malformed: ["operations.0: add_attribute requires attributeDefinition"] })));
      await assert.rejects(
        () => service.refine({ conversationId: convId, instruction: "add dob", model: "m" }),
        (e) => e.code === "MALFORMED_LLM_OUTPUT" && e.statusCode === 502
      );
      assert.equal(chain.calls.length, MAX_REPAIR_ATTEMPTS + 1);
      assert.equal(chain.calls[0].previous, null);
      assert.ok(chain.calls[1].previous, "repair call carries the previous output");
      assert.match(chain.calls[1].issues[0], /attributeDefinition/);
      assert.deepEqual(stored().schema, storedSchema());
      assert.equal(stored().schemaVersion, 3);
      assert.equal(db.calls.findOneAndUpdate, 0);
    });

    it("a result that fails schema validation is never saved (primary key removed through an N-op sequence)", async () => {
      const { service } = build(Array.from({ length: MAX_REPAIR_ATTEMPTS + 1 }, () => ops("bad", [{ op: "modify_attribute", entity: "department", attribute: "department_id", primaryKey: false }])));
      await assert.rejects(
        () => service.refine({ conversationId: convId, instruction: "department id is not a key", model: "m" }),
        (e) => e.code === "REFINEMENT_FAILED" && e.statusCode === 422
      );
      assert.deepEqual(stored().schema, storedSchema());
      assert.equal(stored().schemaVersion, 3);
    });
  });

  describe("provider failures leave the saved schema untouched", () => {
    for (const [label, status, code, http] of [
      ["Gemini rate limit (429)", 429, "RATE_LIMIT_EXCEEDED", 429],
      ["Gemini high demand (503)", 503, "MODEL_TEMPORARILY_UNAVAILABLE", 503],
    ]) {
      it(label, async () => {
        const { chain, service } = build([mapProviderError(Object.assign(new Error("provider"), { status }))]);
        await assert.rejects(() => service.refine({ conversationId: convId, instruction: "add x", model: "m" }), (e) => e.code === code && e.statusCode === http);
        assert.equal(chain.calls.length, 1, "no silent retry loop and no silent model switch");
        assert.deepEqual(stored().schema, storedSchema());
        assert.equal(stored().schemaVersion, 3);
        assert.equal(stored().messages.length, 0);
      });
    }

    it("timeout", async () => {
      const { service } = build([mapProviderError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))]);
      await assert.rejects(() => service.refine({ conversationId: convId, instruction: "add x", model: "m" }), (e) => e.code === "LLM_TIMEOUT" && e.statusCode === 504);
      assert.deepEqual(stored().schema, storedSchema());
    });
  });

  describe("persistence and concurrency", () => {
    it("rejects a missing or malformed conversation id before any model call", async () => {
      const { chain, service } = build([]);
      await assert.rejects(() => service.refine({ conversationId: "aaaaaaaaaaaaaaaaaaaaaaaa", instruction: "x", model: "m" }), (e) => e.code === "CONVERSATION_NOT_FOUND" && e.statusCode === 404);
      await assert.rejects(() => service.refine({ conversationId: "nope", instruction: "x", model: "m" }), (e) => e.code === "INVALID_CONVERSATION_ID" && e.statusCode === 400);
      assert.equal(chain.calls.length, 0);
    });

    it("MongoDB not connected / unreadable: explicit 503, no model call, nothing written", async () => {
      const a = build([], { connected: () => false });
      await assert.rejects(() => a.service.refine({ conversationId: convId, instruction: "x", model: "m" }), (e) => e.code === "DATABASE_UNAVAILABLE" && e.statusCode === 503);
      db.hooks.failLoad = true;
      const b = build([]);
      await assert.rejects(() => b.service.refine({ conversationId: convId, instruction: "x", model: "m" }), (e) => e.code === "PERSISTENCE_FAILED" && e.statusCode === 503);
      assert.equal(a.chain.calls.length + b.chain.calls.length, 0);
    });

    it("a stale client version is a 409 conflict before any model call", async () => {
      const { chain, service } = build([]);
      await assert.rejects(() => service.refine({ conversationId: convId, instruction: "x", expectedVersion: 2, model: "m" }), (e) => e.code === "SCHEMA_VERSION_CONFLICT" && e.statusCode === 409 && e.currentVersion === 3);
      assert.equal(chain.calls.length, 0);
    });

    it("a concurrent update during the (slow) model call wins: 409, and the newer schema is NOT overwritten", async () => {
      const { service } = build([ops("x", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "n", type: "INT" } }])]);
      db.hooks.beforeCommit = (store) => {
        const doc = store.get(convId);
        doc.schemaVersion = 4;
        doc.schema.entities[0].attributes.push(col("added_by_other_writer"));
      };
      await assert.rejects(() => service.refine({ conversationId: convId, instruction: "add n", expectedVersion: 3, model: "m" }), (e) => e.code === "SCHEMA_VERSION_CONFLICT" && e.statusCode === 409 && e.currentVersion === 4);
      assert.equal(stored().schemaVersion, 4);
      const names = stored().schema.entities[0].attributes.map((a) => a.name);
      assert.ok(names.includes("added_by_other_writer"));
      assert.equal(names.includes("n"), false);
      assert.equal(stored().messages.length, 0);
    });

    it("a failed write is reported honestly (valid change, not saved) and leaves schema and version as they were", async () => {
      const { service } = build([ops("x", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "n", type: "INT" } }])]);
      db.hooks.failCommit = true;
      await assert.rejects(() => service.refine({ conversationId: convId, instruction: "add n", model: "m" }), (e) => e.code === "PERSISTENCE_FAILED" && e.statusCode === 503);
      assert.deepEqual(stored().schema, storedSchema());
      assert.equal(stored().schemaVersion, 3);
    });

    it("two successive refinements chain on the latest stored schema and version", async () => {
      const { service } = build([
        ops("1", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "a", type: "INT" } }]),
        ops("2", [{ op: "modify_attribute", entity: "customer", attribute: "a", newName: "b" }]),
      ]);
      const first = await service.refine({ conversationId: convId, instruction: "add a", expectedVersion: 3, model: "m" });
      const second = await service.refine({ conversationId: convId, instruction: "rename a to b", expectedVersion: first.schemaVersion, model: "m" });
      assert.equal(second.schemaVersion, 5);
      const names = stored().schema.entities[0].attributes.map((a) => a.name);
      assert.ok(names.includes("b") && !names.includes("a"));
    });
  });

  it("stateless refinement (no conversation) never writes to the database", async () => {
    const service = new RefinementService(scriptedChain([ops("x", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "n", type: "INT" } }])]));
    const out = await service.refineSchema({ schema: storedSchema(), instruction: "add n", model: "m" });
    assert.equal(out.status, "applied");
    assert.equal(db.calls.findOneAndUpdate + db.calls.updateOne, 0);
  });

  it("every typed error carries a code and status the frontend can show (sanity for createAppError)", () => {
    const e = createAppError("X", "msg", 418);
    assert.deepEqual([e.code, e.statusCode, e.expose], ["X", 418, true]);
  });
});
