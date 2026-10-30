import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { RunnableLambda } from "@langchain/core/runnables";
import app from "../src/app.js";
import { useTestModelCatalog, resetTestModelCatalog } from "./helpers/testModelCatalog.js";
import { Conversation } from "../src/models/conversation.js";
import { conversationRefinementService } from "../src/services/conversationRefinementService.js";
import { refinementService } from "../src/services/refinementService.js";
import { geminiService } from "../src/services/geminiService.js";
import { mockSchema } from "../src/data/mockSchema.js";
import { makeFakeModel, clone } from "./helpers/fakeConversationModel.js";

/**
 * HTTP-level tests of POST /api/schema/refine with a saved conversation, and of the hardened /api/conversations routes.
 * The real Express app, the real RefinementService (prompt templates, applier, validator) and the real controllers
 * run; only the LLM (fake LangChain chat model) and MongoDB (in-memory fake, tests/helpers/fakeConversationModel.js)
 * are replaced. No network, no API key, no database server is needed.
 */

const ID = "64b7f0c2a1b2c3d4e5f60718";
const MISSING_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ops = (message, operations) => ({ outcome: "operations", message, operations });

function makeFakeLlm(queue) {
  const prompts = [];
  return {
    prompts,
    withStructuredOutput: () =>
      RunnableLambda.from(async (promptValue) => {
        prompts.push(promptValue.toString());
        if (queue.length === 0) throw new Error("Unexpected extra LLM call");
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
  };
}

describe("refine with a saved conversation + conversation routes", () => {
  let server;
  let baseUrl;
  let fake;
  const savedEnv = {};
  const original = {};

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
    geminiService.client = null;

    fake = makeFakeModel([
      {
        _id: ID,
        title: "Shop",
        schema: clone(mockSchema),
        schemaVersion: 3,
        messages: [
          { role: "user", content: "shop db", operation: "generate", schemaVersion: 1 },
          { role: "assistant", content: JSON.stringify({ entities: [], relationships: [] }), operation: "generate", schemaVersion: 1 },
        ],
      },
    ]);
    original.model = conversationRefinementService.model;
    original.connected = conversationRefinementService.connected;
    original.llm = refinementService.chain.model;
    conversationRefinementService.model = fake;
    conversationRefinementService.connected = () => true;

    // Routes that use the Mongoose model directly (GET conversation, POST message) + the connection check.
    Conversation.findById = (id) => fake.findById(id);
    Conversation.updateOne = (filter, update) => fake.updateOne(filter, update);
    Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
  });

  afterEach(() => {
    resetTestModelCatalog();
    conversationRefinementService.model = original.model;
    conversationRefinementService.connected = original.connected;
    refinementService.chain.model = original.llm;
    delete Conversation.findById;
    delete Conversation.updateOne;
    delete mongoose.connection.readyState;
    geminiService.client = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const llm = (queue) => {
    const model = makeFakeLlm(queue);
    refinementService.chain.model = model;
    return model;
  };
  const stored = () => fake.store.get(ID);

  describe("authoritative schema", () => {
    it("refines the STORED schema and ignores a different schema sent by the client", async () => {
      const model = llm([ops("Added phone", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "phone", type: "VARCHAR" } }])]);
      const bogus = { entities: [{ id: "x", name: "ClientSideOnly", attributes: [{ name: "x_id", type: "INT", primaryKey: true }] }], relationships: [] };

      const { status, body } = await call("POST", "/schema/refine", { schema: bogus, instruction: "Add a phone number to Customer", conversationId: ID, schemaVersion: 3 });

      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.success, true);
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.conversationId, ID);
      assert.equal(body.data.schemaVersion, 4);
      assert.equal(body.data.persisted, true);
      assert.ok(model.prompts[0].includes('"order_item"'), "prompt must contain the stored schema");
      assert.ok(!model.prompts[0].includes("ClientSideOnly"), "client-supplied schema must not reach the model");

      // everything unrelated is preserved; only Customer gained a column
      assert.equal(body.data.schema.entities.length, mockSchema.entities.length);
      assert.deepEqual(body.data.schema.relationships, mockSchema.relationships);
      assert.ok(body.data.schema.entities.find((e) => e.id === "customer").attributes.some((a) => a.name === "phone"));
      for (const e of mockSchema.entities.filter((x) => x.id !== "customer")) {
        assert.deepEqual(body.data.schema.entities.find((x) => x.id === e.id), e);
      }

      assert.deepEqual(stored().schema, body.data.schema);
      assert.equal(stored().schemaVersion, 4);
      assert.equal(stored().messages.length, 4);
    });

    it("works without a client schema when a conversationId is given", async () => {
      llm([ops("Renamed", [{ op: "rename_entity", entity: "customer", newName: "Client" }])]);
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Rename Customer to Client", conversationId: ID });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(stored().schema.entities.find((e) => e.id === "customer").name, "Client");

      // the refreshed schema still produces SQL through the existing generator
      const sql = await call("POST", "/schema/sql", { schema: body.data.schema });
      assert.equal(sql.status, 200);
      assert.match(sql.body.sql, /CREATE TABLE "client"/);
    });

    it("changes a relationship's cardinality through the whole pipeline", async () => {
      llm([ops("1:1", [{ op: "modify_relationship", relationshipId: "customer-order", cardinality: "1:1" }])]);
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Make customer-order one-to-one", conversationId: ID });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(stored().schema.relationships.find((r) => r.id === "customer-order").cardinality, "1:1");
      assert.equal(stored().schema.entities.find((e) => e.id === "order").attributes.find((a) => a.name === "customer_id").unique, true);
    });
  });

  describe("failures preserve the last valid schema", () => {
    it("validation failure after the 3 bounded model calls: 422 and nothing is stored", async () => {
      const dup = ops("dup", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "email", type: "VARCHAR" } }]);
      const model = llm([dup, dup, dup]);
      const before = clone(stored());

      const { status, body } = await call("POST", "/schema/refine", { instruction: "Add email to Customer", conversationId: ID });
      assert.equal(status, 422);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "REFINEMENT_FAILED");
      assert.equal(model.prompts.length, 3, "initial proposal + at most two repairs");
      assert.deepEqual(stored(), before);
    });

    it("an invalid foreign-key reference and a missing target are rejected, nothing is stored", async () => {
      const bad = ops("bad", [{ op: "modify_attribute", entity: "ghost", attribute: "x", unique: true }]);
      llm([bad, bad, bad]);
      const before = clone(stored());
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Make x unique", conversationId: ID });
      assert.equal(status, 422);
      assert.equal(body.error.code, "REFINEMENT_FAILED");
      assert.deepEqual(stored(), before);
    });

    it("a clarification is returned as 200 needs_clarification; schema and version are unchanged", async () => {
      llm([{ outcome: "needs_clarification", message: "Which address do you mean?", operations: [] }]);
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Remove the address", conversationId: ID });
      assert.equal(status, 200);
      assert.equal(body.data.status, "needs_clarification");
      assert.equal(body.data.message, "Which address do you mean?");
      assert.equal(body.data.schema, undefined, "no schema may accompany a clarification");
      assert.deepEqual(stored().schema, mockSchema);
      assert.equal(stored().schemaVersion, 3);
      assert.equal(stored().messages.at(-1).operation, "clarification");
    });

    it("an unsupported request is 422 and nothing is stored", async () => {
      llm([{ outcome: "unsupported", message: "Cannot do that", operations: [] }]);
      const before = clone(stored());
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Send an email", conversationId: ID });
      assert.equal(status, 422);
      assert.equal(body.error.code, "REFINEMENT_UNSUPPORTED");
      assert.deepEqual(stored(), before);
    });

    it("a failing database write is NOT reported as success", async () => {
      llm([ops("Added phone", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "phone", type: "VARCHAR" } }])]);
      fake.hooks.failCommit = true;
      const before = clone(stored());
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Add phone to Customer", conversationId: ID });
      assert.equal(status, 503);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "PERSISTENCE_FAILED");
      assert.deepEqual(stored(), before);
    });
  });

  describe("stale / concurrent updates", () => {
    it("a stale client schemaVersion is a 409 and the model is never called", async () => {
      const model = llm([]);
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Add phone to Customer", conversationId: ID, schemaVersion: 1 });
      assert.equal(status, 409);
      assert.equal(body.error.code, "SCHEMA_VERSION_CONFLICT");
      assert.equal(model.prompts.length, 0);
    });

    it("a change committed while the model is running wins; the late refinement is rejected with 409", async () => {
      llm([ops("Added phone", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "phone", type: "VARCHAR" } }])]);
      const newer = clone(mockSchema);
      newer.entities.pop();
      newer.relationships = newer.relationships.filter((r) => r.source !== "category");
      fake.hooks.beforeCommit = (store) => {
        const d = store.get(ID);
        d.schema = clone(newer);
        d.schemaVersion = 4;
      };
      const { status, body } = await call("POST", "/schema/refine", { instruction: "Add phone to Customer", conversationId: ID, schemaVersion: 3 });
      assert.equal(status, 409);
      assert.equal(body.error.code, "SCHEMA_VERSION_CONFLICT");
      assert.deepEqual(stored().schema, newer);
      assert.equal(stored().schemaVersion, 4);
    });
  });

  describe("request validation and status codes", () => {
    it("malformed conversation id -> 400 INVALID_CONVERSATION_ID", async () => {
      const model = llm([]);
      const { status, body } = await call("POST", "/schema/refine", { instruction: "x", conversationId: "not-an-id" });
      assert.equal(status, 400);
      assert.equal(body.error.code, "INVALID_CONVERSATION_ID");
      assert.equal(model.prompts.length, 0);
    });

    it("unknown conversation -> 404", async () => {
      const { status, body } = await call("POST", "/schema/refine", { instruction: "x", conversationId: MISSING_ID });
      assert.equal(status, 404);
      assert.equal(body.error.code, "CONVERSATION_NOT_FOUND");
    });

    it("database unavailable for a saved conversation -> 503 (the client schema is NOT used as a fallback)", async () => {
      conversationRefinementService.connected = () => false;
      const model = llm([]);
      const { status, body } = await call("POST", "/schema/refine", { schema: mockSchema, instruction: "Add phone to Customer", conversationId: ID });
      assert.equal(status, 503);
      assert.equal(body.error.code, "DATABASE_UNAVAILABLE");
      assert.equal(model.prompts.length, 0);
    });

    for (const [label, payload] of [
      ["neither schema nor conversationId", { instruction: "x" }],
      ["schemaVersion 0", { instruction: "x", conversationId: ID, schemaVersion: 0 }],
      ["schemaVersion as a string", { instruction: "x", conversationId: ID, schemaVersion: "3" }],
      ["schemaVersion non-integer", { instruction: "x", conversationId: ID, schemaVersion: 1.5 }],
      ["blank instruction", { instruction: "  ", conversationId: ID }],
    ]) {
      it(`rejects ${label} with 400 MALFORMED_REQUEST`, async () => {
        const model = llm([]);
        const { status, body } = await call("POST", "/schema/refine", payload);
        assert.equal(status, 400);
        assert.equal(body.error.code, "MALFORMED_REQUEST");
        assert.equal(model.prompts.length, 0);
      });
    }

    it("stateless mode still works, and accepts conversationId/schemaVersion = null (regression: null used to be a 400)", async () => {
      llm([ops("Added phone", [{ op: "add_attribute", entity: "customer", attributeDefinition: { name: "phone", type: "VARCHAR" } }])]);
      const { status, body } = await call("POST", "/schema/refine", { schema: mockSchema, instruction: "Add phone to Customer", conversationId: null, schemaVersion: null });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.data.status, "applied");
      assert.equal(body.data.persisted, false);
      assert.equal(body.data.conversationId, null);
      assert.deepEqual(stored().schema, mockSchema, "stateless refinement must not touch any stored conversation");
    });
  });

  describe("conversation routes", () => {
    it("GET /conversations/:id returns the stored schema and version; malformed id -> 400; unknown -> 404", async () => {
      const ok = await call("GET", `/conversations/${ID}`);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.schemaVersion, 3);
      assert.deepEqual(ok.body.data.schema, mockSchema);
      assert.equal((await call("GET", "/conversations/not-an-id")).status, 400);
      assert.equal((await call("GET", `/conversations/${MISSING_ID}`)).status, 404);
    });

    it("POST /conversations/:id/messages appends a message and never touches the schema", async () => {
      const { status } = await call("POST", `/conversations/${ID}/messages`, { role: "user", content: "a note", operation: "note" });
      assert.equal(status, 200);
      assert.equal(stored().messages.at(-1).content, "a note");
      assert.deepEqual(stored().schema, mockSchema);
      assert.equal(stored().schemaVersion, 3);
    });

    it("POST /conversations/:id/messages refuses to overwrite the schema (stale/unvalidated schema protection)", async () => {
      const before = clone(stored());
      const { status, body } = await call("POST", `/conversations/${ID}/messages`, {
        role: "assistant",
        content: "old snapshot",
        schema: { entities: [], relationships: [] },
        schemaVersion: 99,
      });
      assert.equal(status, 400);
      assert.equal(body.error.code, "SCHEMA_UPDATE_NOT_ALLOWED");
      assert.deepEqual(stored(), before);
    });

    it("POST /conversations/:id/messages validates id, body and existence", async () => {
      assert.equal((await call("POST", "/conversations/bad/messages", { role: "user", content: "x" })).status, 400);
      assert.equal((await call("POST", `/conversations/${ID}/messages`, { role: "system", content: "x" })).status, 400);
      assert.equal((await call("POST", `/conversations/${ID}/messages`, { role: "user", content: "" })).status, 400);
      assert.equal((await call("POST", `/conversations/${MISSING_ID}/messages`, { role: "user", content: "x" })).status, 404);
    });
  });
});
