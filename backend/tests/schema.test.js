import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app.js";
import { mockSchema } from "../src/data/mockSchema.js";

describe("SchemAI Backend API Suite", () => {
  let server;
  let baseUrl;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // 1. Health Endpoint
  it("GET /api/health returns 200 with running message", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.message, "SchemAI backend is running");
  });

  // 2. Retrieval of Mock Schema
  it("GET /api/schema returns canonical mock schema with entities and relationships", async () => {
    const res = await fetch(`${baseUrl}/schema`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.entities));
    assert.ok(Array.isArray(body.data.relationships));
    assert.equal(body.data.entities.length, 6);
    assert.equal(body.data.relationships.length, 5);
  });

  // 3. Valid schema passes validation
  it("POST /api/schema/validate confirms the canonical mock schema is valid", async () => {
    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: mockSchema }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.valid, true);
    assert.equal(body.data.errors.length, 0);
    assert.equal(body.data.summary.entityCount, 6);
    assert.equal(body.data.summary.checksPassed, 12);
  });

  // 4. Duplicate entities are detected
  it("POST /api/schema/validate detects duplicate entity names or IDs", async () => {
    const duplicateSchema = {
      entities: [
        {
          id: "customer",
          name: "Customer",
          attributes: [{ name: "id", type: "INT", primaryKey: true, foreignKey: false }],
        },
        {
          id: "customer_copy",
          name: "Customer", // duplicate name
          attributes: [{ name: "id", type: "INT", primaryKey: true, foreignKey: false }],
        },
      ],
      relationships: [],
    };

    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: duplicateSchema }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.valid, false);
    const hasDuplicateNameError = body.data.errors.some(
      (e) => e.code === "DUPLICATE_ENTITY_NAME"
    );
    assert.ok(hasDuplicateNameError, "Should report DUPLICATE_ENTITY_NAME error");
  });

  // 5. Missing entity references in relationships are detected
  it("POST /api/schema/validate detects relationships referencing nonexistent entities", async () => {
    const invalidRelSchema = {
      entities: [
        {
          id: "customer",
          name: "Customer",
          attributes: [{ name: "id", type: "INT", primaryKey: true, foreignKey: false }],
        },
      ],
      relationships: [
        {
          id: "rel-1",
          source: "customer",
          target: "non_existent_target",
          name: "places",
          cardinality: "1:N",
        },
      ],
    };

    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: invalidRelSchema }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.valid, false);
    const hasInvalidTarget = body.data.errors.some(
      (e) => e.code === "INVALID_RELATIONSHIP_TARGET"
    );
    assert.ok(hasInvalidTarget, "Should report INVALID_RELATIONSHIP_TARGET error");
  });

  // 6. Invalid foreign-key references are detected
  it("POST /api/schema/validate detects invalid foreign-key references", async () => {
    const invalidFkSchema = {
      entities: [
        {
          id: "order",
          name: "Order",
          attributes: [
            { name: "id", type: "INT", primaryKey: true, foreignKey: false },
            {
              name: "user_id",
              type: "INT",
              primaryKey: false,
              foreignKey: true,
              references: { entity: "ghost_user", attribute: "id" },
            },
          ],
        },
      ],
      relationships: [],
    };

    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: invalidFkSchema }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.valid, false);
    const hasInvalidFk = body.data.errors.some(
      (e) => e.code === "INVALID_FOREIGN_KEY_TARGET_ENTITY"
    );
    assert.ok(hasInvalidFk, "Should report INVALID_FOREIGN_KEY_TARGET_ENTITY");
  });

  // 7. Invalid cardinalities are detected
  it("POST /api/schema/validate detects invalid cardinalities", async () => {
    const invalidCardinalitySchema = {
      entities: [
        {
          id: "parent",
          name: "Parent",
          attributes: [{ name: "id", type: "INT", primaryKey: true, foreignKey: false }],
        },
        {
          id: "child",
          name: "Child",
          attributes: [{ name: "id", type: "INT", primaryKey: true, foreignKey: false }],
        },
      ],
      relationships: [
        {
          id: "rel-1",
          source: "parent",
          target: "child",
          name: "has",
          cardinality: "INVALID_CARDINALITY",
        },
      ],
    };

    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: invalidCardinalitySchema }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.valid, false);
    const hasCardinalityError = body.data.errors.some(
      (e) => e.code === "STRUCTURAL_ERROR" && e.path.includes("cardinality")
    );
    assert.ok(hasCardinalityError, "Should report invalid cardinality structural error");
  });

  // 8. SQL generation produces tables and key constraints
  it("POST /api/schema/sql generates valid PostgreSQL DDL statements with constraints", async () => {
    const res = await fetch(`${baseUrl}/schema/sql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: mockSchema, dialect: "postgresql" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.dialect, "postgresql");
    assert.ok(typeof body.sql === "string");
    assert.ok(body.sql.includes('CREATE TABLE "customer"'));
    assert.ok(body.sql.includes('CREATE TABLE "address"'));
    assert.ok(body.sql.includes('CREATE TABLE "order"'));
    assert.ok(body.sql.includes('PRIMARY KEY ("customer_id")'));
    assert.ok(body.sql.includes('FOREIGN KEY ("customer_id") REFERENCES "customer" ("customer_id")'));
  });

  // 9. Invalid schemas are rejected by SQL generation
  it("POST /api/schema/sql rejects invalid schemas with status 400", async () => {
    const invalidSchema = {
      entities: [
        {
          id: "user",
          name: "User",
          attributes: [
            // Missing primary key
            { name: "username", type: "VARCHAR", primaryKey: false, foreignKey: false },
          ],
        },
      ],
      relationships: [],
    };

    const res = await fetch(`${baseUrl}/schema/sql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: invalidSchema }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(body.error.message.includes("Cannot generate SQL from invalid schema"));
  });

  // 10. Generation placeholder returns 501 Not Implemented
  it("POST /api/schema/generate reports that AI generation is not yet implemented", async () => {
    const res = await fetch(`${baseUrl}/schema/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requirement: "Create a database for a library management system",
      }),
    });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "FEATURE_NOT_IMPLEMENTED");
    assert.ok(body.error.message.includes("not yet implemented"));
  });

  // 11. Refinement placeholder returns 501 Not Implemented
  it("POST /api/schema/refine reports that schema refinement is not yet implemented", async () => {
    const res = await fetch(`${baseUrl}/schema/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: mockSchema,
        instruction: "Add phone_number VARCHAR to customer",
      }),
    });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "FEATURE_NOT_IMPLEMENTED");
    assert.ok(body.error.message.includes("not yet implemented"));
  });

  // 12. Malformed request handling
  it("POST /api/schema/validate returns 400 for malformed payload", async () => {
    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrongField: 123 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "MALFORMED_REQUEST");
  });

  // 13. Unknown route handling (404)
  it("GET /api/nonexistent returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "ROUTE_NOT_FOUND");
  });

  // 14. Primary key cannot be nullable
  it("POST /api/schema/validate rejects nullable primary key attribute", async () => {
    const schemaWithNullablePk = {
      entities: [
        {
          id: "item",
          name: "Item",
          attributes: [
            { name: "id", type: "INT", primaryKey: true, foreignKey: false, nullable: true },
          ],
        },
      ],
      relationships: [],
    };

    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: schemaWithNullablePk }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.valid, false);
    const hasPkNullableErr = body.data.errors.some((e) => e.code === "PRIMARY_KEY_NULLABLE");
    assert.ok(hasPkNullableErr, "Should detect PRIMARY_KEY_NULLABLE error");
  });

  // 15. Unsupported data type is rejected
  it("POST /api/schema/validate rejects unsupported attribute data type", async () => {
    const schemaWithBadType = {
      entities: [
        {
          id: "item",
          name: "Item",
          attributes: [
            { name: "id", type: "INT", primaryKey: true, foreignKey: false },
            { name: "metadata", type: "IMAGINARY_TYPE", primaryKey: false, foreignKey: false },
          ],
        },
      ],
      relationships: [],
    };

    const res = await fetch(`${baseUrl}/schema/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: schemaWithBadType }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.valid, false);
    const hasTypeErr = body.data.errors.some((e) => e.code === "UNSUPPORTED_DATA_TYPE");
    assert.ok(hasTypeErr, "Should detect UNSUPPORTED_DATA_TYPE error");
  });

  // 16. Empty requirement in generate endpoint
  it("POST /api/schema/generate rejects empty requirement string", async () => {
    const res = await fetch(`${baseUrl}/schema/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirement: "   " }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "MALFORMED_REQUEST");
  });
});
