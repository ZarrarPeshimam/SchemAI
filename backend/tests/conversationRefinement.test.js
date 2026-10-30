import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ConversationRefinementService } from "../src/services/conversationRefinementService.js";
import { mockSchema } from "../src/data/mockSchema.js";
import { makeFakeModel, clone } from "./helpers/fakeConversationModel.js";

/**
 * Service-level tests for refinement of a saved conversation.
 *
 * IMPORTANT: these tests use an in-memory FAKE of the Mongoose model (tests/helpers/fakeConversationModel.js). They
 * verify the service's logic (authoritative schema, version check, atomic single write, failure preservation). They do
 * NOT prove the behaviour of a real MongoDB server.
 */

const ID = "64b7f0c2a1b2c3d4e5f60718";
const refinedSchema = () => {
  const s = clone(mockSchema);
  s.entities[0].attributes.push({ name: "phone", type: "VARCHAR", primaryKey: false, foreignKey: false, nullable: true, unique: false });
  return s;
};

const makeRefiner = (impl) => {
  const calls = [];
  return {
    calls,
    async refineSchema(args) {
      calls.push(clone(args));
      return impl(args);
    },
  };
};
const appliedResult = (schema = refinedSchema()) => ({ status: "applied", schema, validation: { valid: true }, summary: { message: "Added phone", changes: ["Added Customer.phone"] }, operations: [], repairAttempts: 0 });

const rejects = async (promise, { status, code }) => {
  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, status, `status ${err.statusCode} / ${err.code}: ${err.message}`);
    assert.equal(err.code, code);
    assert.equal(err.expose, true);
    return true;
  });
};

describe("ConversationRefinementService", () => {
  let model;
  let doc;
  const make = (refiner, overrides = {}) => new ConversationRefinementService({ model, refiner, connected: () => true, ...overrides });

  beforeEach(() => {
    doc = {
      _id: ID,
      title: "Shop",
      schema: clone(mockSchema),
      schemaVersion: 3,
      messages: [
        { role: "user", content: "shop db", operation: "generate", schemaVersion: 1 },
        // An old assistant snapshot that differs from the latest schema: it must never be used as the current schema.
        { role: "assistant", content: JSON.stringify({ entities: [{ id: "stale", name: "Stale", attributes: [] }], relationships: [] }), operation: "generate", schemaVersion: 1 },
      ],
    };
    model = makeFakeModel([doc]);
  });

  it("refines the STORED schema (not the history) and commits schema, version and messages together", async () => {
    const refiner = makeRefiner(() => appliedResult());
    const out = await make(refiner).refine({ conversationId: ID, instruction: "Add a phone number to Customer" });

    assert.equal(refiner.calls.length, 1);
    assert.deepEqual(refiner.calls[0].schema, mockSchema, "refiner must receive the stored latest schema");
    assert.equal(refiner.calls[0].instruction, "Add a phone number to Customer");

    assert.equal(out.status, "applied");
    assert.equal(out.persisted, true);
    assert.equal(out.conversationId, ID);
    assert.equal(out.schemaVersion, 4);

    const saved = model.store.get(ID);
    assert.deepEqual(saved.schema, refinedSchema());
    assert.equal(saved.schemaVersion, 4);
    assert.equal(saved.messages.length, 4);
    const [user, assistant] = saved.messages.slice(2);
    assert.deepEqual([user.role, user.operation, user.schemaVersion, user.content], ["user", "refine", 3, "Add a phone number to Customer"]);
    assert.deepEqual([assistant.role, assistant.operation, assistant.schemaVersion], ["assistant", "refine", 4]);
    assert.deepEqual(JSON.parse(assistant.content), refinedSchema());
    assert.ok(new Date(user.createdAt) <= new Date(assistant.createdAt));
    assert.equal(model.calls.findOneAndUpdate, 1, "exactly one atomic write");
  });

  it("successive refinements chain: the second one starts from the first one's committed schema", async () => {
    const second = clone(refinedSchema());
    second.entities[0].attributes.push({ name: "dob", type: "DATE", primaryKey: false, foreignKey: false, nullable: true, unique: false });
    const results = [appliedResult(refinedSchema()), appliedResult(second)];
    const refiner = makeRefiner(() => results.shift());
    const svc = make(refiner);

    const a = await svc.refine({ conversationId: ID, instruction: "one", expectedVersion: 3 });
    const b = await svc.refine({ conversationId: ID, instruction: "two", expectedVersion: a.schemaVersion });
    assert.deepEqual(refiner.calls[1].schema, refinedSchema());
    assert.equal(b.schemaVersion, 5);
    assert.deepEqual(model.store.get(ID).schema, second);
  });

  it("a clarification changes neither schema nor version, but is recorded in the history", async () => {
    const refiner = makeRefiner(() => ({ status: "needs_clarification", message: "Which address?" }));
    const out = await make(refiner).refine({ conversationId: ID, instruction: "Remove the address" });

    assert.equal(out.status, "needs_clarification");
    assert.equal(out.schemaVersion, 3);
    const saved = model.store.get(ID);
    assert.deepEqual(saved.schema, mockSchema);
    assert.equal(saved.schemaVersion, 3);
    assert.equal(model.calls.findOneAndUpdate, 0);
    assert.deepEqual(saved.messages.slice(2).map((m) => [m.role, m.operation, m.content]), [
      ["user", "refine", "Remove the address"],
      ["assistant", "clarification", "Which address?"],
    ]);
  });

  it("a failed refinement (validation, unsupported, provider error) leaves the stored conversation untouched", async () => {
    const before = clone(model.store.get(ID));
    for (const err of [
      Object.assign(new Error("failed"), { code: "REFINEMENT_FAILED", statusCode: 422, expose: true }),
      Object.assign(new Error("nope"), { code: "REFINEMENT_UNSUPPORTED", statusCode: 422, expose: true }),
      Object.assign(new Error("llm"), { code: "LLM_PROVIDER_ERROR", statusCode: 502, expose: true }),
    ]) {
      const refiner = makeRefiner(() => {
        throw err;
      });
      await assert.rejects(make(refiner).refine({ conversationId: ID, instruction: "x" }), (e) => e === err);
    }
    assert.deepEqual(model.store.get(ID), before);
    assert.equal(model.calls.findOneAndUpdate, 0);
    assert.equal(model.calls.updateOne, 0);
  });

  it("rejects a stale client version with 409 before calling the model", async () => {
    const refiner = makeRefiner(() => appliedResult());
    await rejects(make(refiner).refine({ conversationId: ID, instruction: "x", expectedVersion: 2 }), { status: 409, code: "SCHEMA_VERSION_CONFLICT" });
    assert.equal(refiner.calls.length, 0);
    assert.deepEqual(model.store.get(ID).schema, mockSchema);
  });

  it("a concurrent change while the model is working yields 409 and does NOT overwrite the newer schema", async () => {
    const newer = clone(mockSchema);
    newer.entities.push({ id: "tag", name: "Tag", description: "", attributes: [{ name: "tag_id", type: "INT", primaryKey: true, foreignKey: false, nullable: false, unique: true }] });
    model.hooks.beforeCommit = (store) => {
      const d = store.get(ID);
      d.schema = clone(newer);
      d.schemaVersion = 4;
    };
    const refiner = makeRefiner(() => appliedResult());
    await rejects(make(refiner).refine({ conversationId: ID, instruction: "Add phone", expectedVersion: 3 }), { status: 409, code: "SCHEMA_VERSION_CONFLICT" });

    const saved = model.store.get(ID);
    assert.deepEqual(saved.schema, newer);
    assert.equal(saved.schemaVersion, 4);
    assert.equal(saved.messages.length, 2, "no messages from the rejected refinement");
  });

  it("a failed database write is reported as an error, never as success, and changes nothing", async () => {
    model.hooks.failCommit = true;
    const before = clone(model.store.get(ID));
    await rejects(make(makeRefiner(() => appliedResult())).refine({ conversationId: ID, instruction: "x" }), { status: 503, code: "PERSISTENCE_FAILED" });
    assert.deepEqual(model.store.get(ID), before);
  });

  it("a failed conversation load is a 503, not a crash", async () => {
    model.hooks.failLoad = true;
    await rejects(make(makeRefiner(() => appliedResult())).refine({ conversationId: ID, instruction: "x" }), { status: 503, code: "PERSISTENCE_FAILED" });
  });

  it("validates the conversation id, DB availability, existence and that a schema is stored", async () => {
    const refiner = makeRefiner(() => appliedResult());
    await rejects(make(refiner).refine({ conversationId: "not-an-id", instruction: "x" }), { status: 400, code: "INVALID_CONVERSATION_ID" });
    await rejects(make(refiner).refine({ conversationId: "{$ne:1}", instruction: "x" }), { status: 400, code: "INVALID_CONVERSATION_ID" });
    await rejects(make(refiner, { connected: () => false }).refine({ conversationId: ID, instruction: "x" }), { status: 503, code: "DATABASE_UNAVAILABLE" });
    await rejects(make(refiner).refine({ conversationId: "aaaaaaaaaaaaaaaaaaaaaaaa", instruction: "x" }), { status: 404, code: "CONVERSATION_NOT_FOUND" });
    model.store.get(ID).schema = null;
    await rejects(make(refiner).refine({ conversationId: ID, instruction: "x" }), { status: 422, code: "CONVERSATION_HAS_NO_SCHEMA" });
    assert.equal(refiner.calls.length, 0);
  });

  it("supports a legacy conversation that has no schemaVersion field (treated as version 1)", async () => {
    delete model.store.get(ID).schemaVersion;
    const refiner = makeRefiner(() => appliedResult());
    const out = await make(refiner).refine({ conversationId: ID, instruction: "x", expectedVersion: 1 });
    assert.equal(out.schemaVersion, 2);
    assert.equal(model.store.get(ID).schemaVersion, 2);
  });

  it("never creates a conversation (the model is only read and updated)", async () => {
    const out = await make(makeRefiner(() => appliedResult())).refine({ conversationId: ID, instruction: "x" });
    assert.equal(out.conversationId, ID);
    assert.equal(model.store.size, 1);
  });
});
