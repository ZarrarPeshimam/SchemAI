import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeModel } from "./helpers/fakeConversationModel.js";
import { mockSchema } from "../src/data/mockSchema.js";
import {
  ConversationRefinementService,
  getCurrentSchema,
  saveUpdatedSchema,
} from "../src/services/conversationRefinementService.js";
import {
  refinementService,
  buildRefinementContext,
  applyRefinementOperations,
  validateUpdatedSchema,
  validateRefinementProposal,
} from "../src/services/refinementService.js";
import { parseModelResponse } from "../src/services/refinement/operationSchema.js";

/** Helpers to inspect schemas in tests */
const entity = (schema, id) => schema.entities.find((e) => e.id.toLowerCase() === id.toLowerCase());
const attr = (schema, entityId, attrName) => entity(schema, entityId)?.attributes.find((a) => a.name.toLowerCase() === attrName.toLowerCase());
const rel = (schema, id) => schema.relationships.find((r) => r.id.toLowerCase() === id.toLowerCase());

/** Realistic shopping schema for test scenarios */
const createShoppingSchema = () => ({
  entities: [
    {
      id: "customer",
      name: "Customer",
      description: "Customer accounts",
      attributes: [
        { name: "customer_id", type: "UUID", primaryKey: true, foreignKey: false, nullable: false, unique: true },
        { name: "full_name", type: "VARCHAR", primaryKey: false, foreignKey: false, nullable: false, unique: false },
        { name: "email", type: "VARCHAR", primaryKey: false, foreignKey: false, nullable: false, unique: true },
        { name: "phone_number", type: "VARCHAR", primaryKey: false, foreignKey: false, nullable: true, unique: false },
      ],
    },
    {
      id: "order",
      name: "Order",
      description: "Customer orders",
      attributes: [
        { name: "order_id", type: "UUID", primaryKey: true, foreignKey: false, nullable: false, unique: true },
        { name: "customer_id", type: "UUID", primaryKey: false, foreignKey: true, nullable: false, unique: false, references: { entity: "customer", attribute: "customer_id" } },
        { name: "order_date", type: "TIMESTAMP", primaryKey: false, foreignKey: false, nullable: false, unique: false },
        { name: "total_amount", type: "DECIMAL", primaryKey: false, foreignKey: false, nullable: false, unique: false },
      ],
    },
    {
      id: "product",
      name: "Product",
      description: "Store products",
      attributes: [
        { name: "product_id", type: "UUID", primaryKey: true, foreignKey: false, nullable: false, unique: true },
        { name: "name", type: "VARCHAR", primaryKey: false, foreignKey: false, nullable: false, unique: false },
        { name: "price", type: "DECIMAL", primaryKey: false, foreignKey: false, nullable: false, unique: false },
        { name: "stock_quantity", type: "INT", primaryKey: false, foreignKey: false, nullable: false, unique: false },
      ],
    },
  ],
  relationships: [
    { id: "customer_order", source: "customer", target: "order", name: "places", cardinality: "1:N" },
  ],
});

/** Mock refiner that simulates Gemini refinement proposals */
function createMockRefiner(proposals) {
  let callIndex = 0;
  return {
    async refineSchema({ schema, instruction, model, reqId }) {
      if (callIndex >= proposals.length) {
        throw new Error(`Unexpected refineSchema call #${callIndex + 1}`);
      }
      const proposal = proposals[callIndex++];
      if (typeof proposal === "function") return proposal({ schema, instruction });
      if (proposal.error) throw proposal.error;

      // Validate proposal structure
      const parsed = parseModelResponse(proposal);
      if (!parsed.ok) {
        throw new Error(`Malformed proposal: ${parsed.issues.join(", ")}`);
      }

      // Deterministically apply operations
      const applied = applyRefinementOperations(schema, parsed.data.operations, { reqId });
      if (!applied.ok) {
        throw new Error(`Failed to apply operations: ${applied.issues?.join(", ") || applied.question}`);
      }

      // Deterministically validate result candidate
      const validated = validateUpdatedSchema(schema, applied.schema);
      if (!validated.valid) {
        throw new Error(`Validation failed: ${validated.issues.join(", ")}`);
      }

      return {
        status: "applied",
        schema: validated.schema,
        validation: validated.validation,
        summary: { message: proposal.message || "Updated schema", changes: applied.changes },
        operations: parsed.data.operations,
        repairAttempts: 0,
      };
    },
  };
}

describe("Rebuilt Schema Refinement Pipeline", () => {
  const convId = "64b7f0c2a1b2c3d4e5f60718";
  let fakeDb;

  beforeEach(() => {
    fakeDb = makeFakeModel([
      {
        _id: convId,
        title: "Test Store",
        schema: createShoppingSchema(),
        schemaVersion: 1,
        messages: [],
      },
    ]);
  });

  describe("Section 3: Dedicated schema retrieval and persistence", () => {
    it("getCurrentSchema retrieves the authoritative latest schema from MongoDB", async () => {
      const result = await getCurrentSchema(convId, { model: fakeDb, connected: () => true });
      assert.ok(result.schema);
      assert.equal(result.schemaVersion, 1);
      assert.equal(result.entities.length, 3);
      assert.equal(result.relationships.length, 1);
      assert.equal(entity(result.schema, "customer").name, "Customer");
    });

    it("getCurrentSchema safely handles nonexistent conversation with 404", async () => {
      await assert.rejects(
        () => getCurrentSchema("aaaaaaaaaaaaaaaaaaaaaaaa", { model: fakeDb, connected: () => true }),
        (err) => err.code === "CONVERSATION_NOT_FOUND" && err.statusCode === 404
      );
    });

    it("saveUpdatedSchema atomically bumps schemaVersion and updates MongoDB document", async () => {
      const current = await getCurrentSchema(convId, { model: fakeDb, connected: () => true });
      const updatedSchema = structuredClone(current.schema);
      updatedSchema.entities[0].attributes.push({
        name: "test_col",
        type: "VARCHAR",
        primaryKey: false,
        foreignKey: false,
        nullable: true,
        unique: false,
      });

      const saveRes = await saveUpdatedSchema(convId, updatedSchema, 1, {
        instruction: "Add test col",
        model: fakeDb,
      });

      assert.equal(saveRes.success, true);
      assert.equal(saveRes.schemaVersion, 2);

      // Verify MongoDB store reflects the update
      const stored = await getCurrentSchema(convId, { model: fakeDb, connected: () => true });
      assert.equal(stored.schemaVersion, 2);
      assert.ok(attr(stored.schema, "customer", "test_col"));
    });

    it("saveUpdatedSchema rejects stale version with 409 conflict", async () => {
      const current = await getCurrentSchema(convId, { model: fakeDb, connected: () => true });
      await assert.rejects(
        () => saveUpdatedSchema(convId, current.schema, 99, { model: fakeDb }),
        (err) => err.code === "SCHEMA_VERSION_CONFLICT" && err.statusCode === 409
      );
    });
  });

  describe("Section 9: Core Refinement Requirements (1-15)", () => {
    // 1. Adding a nullable attribute to an existing entity
    it("1. Adds a nullable attribute to an existing entity", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added middle_name attribute",
          operations: [
            {
              op: "add_attribute",
              entity: "customer",
              attributeDefinition: { name: "middle_name", type: "VARCHAR", nullable: true },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Add middle name" });

      assert.equal(res.status, "applied");
      assert.equal(res.schemaVersion, 2);
      const a = attr(res.schema, "customer", "middle_name");
      assert.ok(a);
      assert.equal(a.nullable, true);
      assert.equal(a.type, "VARCHAR");
    });

    // 2. Adding a non-nullable unique attribute
    it("2. Adds a non-nullable unique attribute", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added loyalty_number attribute",
          operations: [
            {
              op: "add_attribute",
              entity: "customer",
              attributeDefinition: { name: "loyalty_number", type: "VARCHAR", nullable: false, unique: true },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Add unique loyalty number" });

      const a = attr(res.schema, "customer", "loyalty_number");
      assert.ok(a);
      assert.equal(a.nullable, false);
      assert.equal(a.unique, true);
    });

    // 3. Renaming an existing attribute
    it("3. Renames an existing attribute and preserves constraints", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Renamed full_name to display_name",
          operations: [
            {
              op: "modify_attribute",
              entity: "customer",
              attribute: "full_name",
              newName: "display_name",
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Rename full_name to display_name" });

      assert.equal(attr(res.schema, "customer", "full_name"), undefined);
      const renamed = attr(res.schema, "customer", "display_name");
      assert.ok(renamed);
      assert.equal(renamed.type, "VARCHAR");
      assert.equal(renamed.nullable, false);
    });

    // 4. Changing an existing attribute's data type
    it("4. Changes an existing attribute data type", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Changed stock_quantity to BIGINT",
          operations: [
            {
              op: "modify_attribute",
              entity: "product",
              attribute: "stock_quantity",
              type: "BIGINT",
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Change stock_quantity to BIGINT" });

      const a = attr(res.schema, "product", "stock_quantity");
      assert.equal(a.type, "BIGINT");
    });

    // 5. Removing an attribute
    it("5. Removes an attribute cleanly", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Removed phone_number",
          operations: [
            {
              op: "remove_attribute",
              entity: "customer",
              attribute: "phone_number",
              cascade: true,
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Remove phone number" });

      assert.equal(attr(res.schema, "customer", "phone_number"), undefined);
    });

    // 6. Adding a new entity
    it("6. Adds a new entity with primary key", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added Supplier entity",
          operations: [
            {
              op: "add_entity",
              entityDefinition: {
                id: "supplier",
                name: "Supplier",
                description: "Product suppliers",
                attributes: [
                  { name: "supplier_id", type: "UUID", primaryKey: true, nullable: false, unique: true },
                  { name: "company_name", type: "VARCHAR", nullable: false },
                ],
              },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Add supplier entity" });

      const sup = entity(res.schema, "supplier");
      assert.ok(sup);
      assert.equal(sup.name, "Supplier");
      assert.ok(attr(res.schema, "supplier", "supplier_id").primaryKey);
    });

    // 7. Adding a relationship between existing entities
    it("7. Adds a relationship between existing entities and creates foreign key", async () => {
      // First add supplier
      const base = createShoppingSchema();
      base.entities.push({
        id: "supplier",
        name: "Supplier",
        description: "Product suppliers",
        attributes: [
          { name: "supplier_id", type: "UUID", primaryKey: true, foreignKey: false, nullable: false, unique: true },
          { name: "name", type: "VARCHAR", primaryKey: false, foreignKey: false, nullable: false, unique: false },
        ],
      });
      fakeDb.store.get(convId).schema = base;

      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Linked supplier to product",
          operations: [
            {
              op: "add_relationship",
              relationship: {
                source: "supplier",
                target: "product",
                name: "supplies",
                cardinality: "1:N",
              },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Suppliers supply products" });

      assert.ok(rel(res.schema, "supplier_product"));
      const fk = attr(res.schema, "product", "supplier_id");
      assert.ok(fk);
      assert.equal(fk.foreignKey, true);
      assert.deepEqual(fk.references, { entity: "supplier", attribute: "supplier_id" });
    });

    // 8. Creating a missing entity when a requested relationship requires it
    it("8. Creates a missing entity when a requested relationship requires it", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Created Category entity and linked Products",
          operations: [
            {
              op: "add_entity",
              entityDefinition: {
                id: "category",
                name: "Category",
                description: "Product categories",
                attributes: [
                  { name: "category_id", type: "UUID", primaryKey: true, nullable: false, unique: true },
                  { name: "name", type: "VARCHAR", nullable: false },
                ],
              },
            },
            {
              op: "add_relationship",
              relationship: {
                source: "category",
                target: "product",
                name: "categorizes",
                cardinality: "1:N",
              },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Products belong to categories" });

      const cat = entity(res.schema, "category");
      assert.ok(cat);
      assert.equal(cat.name, "Category");
      assert.ok(rel(res.schema, "category_product"));
      assert.ok(attr(res.schema, "product", "category_id"));
    });

    // 9. Modifying multiple attributes in one request
    it("9. Modifies multiple attributes in a single request", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Modified email and price attributes",
          operations: [
            { op: "modify_attribute", entity: "customer", attribute: "email", nullable: true },
            { op: "modify_attribute", entity: "product", attribute: "price", type: "NUMERIC" },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Make email optional and change price to NUMERIC" });

      assert.equal(attr(res.schema, "customer", "email").nullable, true);
      assert.equal(attr(res.schema, "product", "price").type, "NUMERIC");
    });

    // 10. Removing an entity and handling dependent relationships
    it("10. Removes an entity and automatically cleans up dependent relationships and foreign keys", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Removed Order entity and its relationships",
          operations: [
            {
              op: "remove_entity",
              entity: "order",
              cascade: true,
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Remove orders" });

      assert.equal(entity(res.schema, "order"), undefined);
      assert.equal(rel(res.schema, "customer_order"), undefined);
      assert.ok(entity(res.schema, "customer"));
      assert.ok(entity(res.schema, "product"));
    });

    // 11. Preserving all unrelated schema information
    it("11. Preserves all unrelated entities, attributes, and relationships", async () => {
      const original = createShoppingSchema();
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added loyalty_points to Customer",
          operations: [
            { op: "add_attribute", entity: "customer", attributeDefinition: { name: "loyalty_points", type: "INT" } },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Add loyalty points to customer" });

      // Product and Order entities and relationships must be untouched
      assert.deepEqual(entity(res.schema, "product"), entity(original, "product"));
      assert.deepEqual(entity(res.schema, "order"), entity(original, "order"));
      assert.deepEqual(res.schema.relationships, original.relationships);
    });

    // 12. Retrieving latest schema from MongoDB rather than stale client state
    it("12. Refinement uses latest schema stored in MongoDB rather than stale client state", async () => {
      // Simulate MongoDB having already bumped to version 3 with a new attribute
      const stored = createShoppingSchema();
      stored.entities[0].attributes.push({ name: "v3_field", type: "VARCHAR", nullable: true });
      fakeDb.store.get(convId).schema = stored;
      fakeDb.store.get(convId).schemaVersion = 3;

      let passedSchema = null;
      const refiner = {
        async refineSchema({ schema }) {
          passedSchema = schema;
          return {
            status: "applied",
            schema,
            validation: { valid: true },
            summary: { message: "ok", changes: [] },
            operations: [],
          };
        },
      };

      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      await service.refine({ conversationId: convId, instruction: "Next update" });

      // Ensure the schema passed to the refiner contained v3_field
      assert.ok(attr(passedSchema, "customer", "v3_field"));
    });

    // 13. Saving the modified schema and returning the committed version
    it("13. Saves the modified schema and returns the new committed version number", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added nickname",
          operations: [
            { op: "add_attribute", entity: "customer", attributeDefinition: { name: "nickname", type: "VARCHAR" } },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Add nickname" });

      assert.equal(res.schemaVersion, 2);
      assert.equal(res.persisted, true);
      const dbDoc = fakeDb.store.get(convId);
      assert.equal(dbDoc.schemaVersion, 2);
      assert.ok(attr(dbDoc.schema, "customer", "nickname"));
    });

    // 14. Ensuring failed modifications never partially update the saved schema
    it("14. Failed modifications leave the stored schema completely intact (atomicity)", async () => {
      const originalDoc = structuredClone(fakeDb.store.get(convId));

      const refiner = createMockRefiner([
        {
          error: new Error("Gemini generation failed"),
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });

      await assert.rejects(
        () => service.refine({ conversationId: convId, instruction: "Broken request" })
      );

      // Verify DB was NOT mutated
      const afterDoc = fakeDb.store.get(convId);
      assert.deepEqual(afterDoc.schema, originalDoc.schema);
      assert.equal(afterDoc.schemaVersion, originalDoc.schemaVersion);
    });

    // 15. Ensuring the frontend diagram reflects the committed schema
    it("15. The committed schema produces valid diagram nodes and edges", async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added tags attribute",
          operations: [
            { op: "add_attribute", entity: "product", attributeDefinition: { name: "tags", type: "VARCHAR" } },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({ conversationId: convId, instruction: "Add tags to product" });

      // Check structure expected by React Flow (entities as nodes, relationships as edges)
      assert.equal(res.schema.entities.length, 3);
      assert.ok(attr(res.schema, "product", "tags"));
      assert.equal(res.schema.relationships.length, 1);
    });
  });

  describe("Shopping database natural-language instructions", () => {
    it('"Customers should also have a date of birth. This should be optional."', async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added date_of_birth to Customer as an optional DATE attribute.",
          operations: [
            {
              op: "add_attribute",
              entity: "customer",
              attributeDefinition: { name: "date_of_birth", type: "DATE", nullable: true },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({
        conversationId: convId,
        instruction: "Customers should also have a date of birth. This should be optional.",
      });

      assert.equal(res.status, "applied");
      const dob = attr(res.schema, "customer", "date_of_birth");
      assert.ok(dob);
      assert.equal(dob.type, "DATE");
      assert.equal(dob.nullable, true);
      assert.equal(dob.primaryKey, false);
    });

    it('"Every product should have a unique SKU."', async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added unique SKU attribute to Product.",
          operations: [
            {
              op: "add_attribute",
              entity: "product",
              attributeDefinition: { name: "sku", type: "VARCHAR", nullable: false, unique: true },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({
        conversationId: convId,
        instruction: "Every product should have a unique SKU.",
      });

      const sku = attr(res.schema, "product", "sku");
      assert.ok(sku);
      assert.equal(sku.type, "VARCHAR");
      assert.equal(sku.unique, true);
      assert.equal(sku.nullable, false);
    });

    it('"Rename full_name to customer_name."', async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Renamed Customer.full_name to customer_name.",
          operations: [
            {
              op: "modify_attribute",
              entity: "customer",
              attribute: "full_name",
              newName: "customer_name",
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({
        conversationId: convId,
        instruction: "Rename full_name to customer_name.",
      });

      assert.equal(attr(res.schema, "customer", "full_name"), undefined);
      const cname = attr(res.schema, "customer", "customer_name");
      assert.ok(cname);
      assert.equal(cname.nullable, false);
    });

    it('"I want to organize products into categories. Each product should belong to one category, while a category can contain multiple products."', async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Created Category entity and added 1:N relationship from Category to Product.",
          operations: [
            {
              op: "add_entity",
              entityDefinition: {
                id: "category",
                name: "Category",
                description: "Product categories",
                attributes: [
                  { name: "category_id", type: "UUID", primaryKey: true, nullable: false, unique: true },
                  { name: "name", type: "VARCHAR", nullable: false, unique: true },
                ],
              },
            },
            {
              op: "add_relationship",
              relationship: {
                source: "category",
                target: "product",
                name: "contains",
                cardinality: "1:N",
              },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({
        conversationId: convId,
        instruction: "I want to organize products into categories. Each product should belong to one category, while a category can contain multiple products.",
      });

      const cat = entity(res.schema, "category");
      assert.ok(cat);
      assert.equal(cat.name, "Category");
      const fk = attr(res.schema, "product", "category_id");
      assert.ok(fk);
      assert.equal(fk.foreignKey, true);
      assert.deepEqual(fk.references, { entity: "category", attribute: "category_id" });
      const r = rel(res.schema, "category_product");
      assert.ok(r);
      assert.equal(r.cardinality, "1:N");
    });

    it('"Orders should also track when they were shipped."', async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added shipped_at timestamp to Order.",
          operations: [
            {
              op: "add_attribute",
              entity: "order",
              attributeDefinition: { name: "shipped_at", type: "TIMESTAMP", nullable: true },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({
        conversationId: convId,
        instruction: "Orders should also track when they were shipped.",
      });

      const shipped = attr(res.schema, "order", "shipped_at");
      assert.ok(shipped);
      assert.equal(shipped.type, "TIMESTAMP");
      assert.equal(shipped.nullable, true);
    });

    it('"Remove the phone number field from Customer."', async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Removed phone_number attribute from Customer.",
          operations: [
            {
              op: "remove_attribute",
              entity: "customer",
              attribute: "phone_number",
              cascade: true,
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({
        conversationId: convId,
        instruction: "Remove the phone number field from Customer.",
      });

      assert.equal(attr(res.schema, "customer", "phone_number"), undefined);
    });

    it('"Add a discount percentage to products, and make it optional."', async () => {
      const refiner = createMockRefiner([
        {
          outcome: "operations",
          message: "Added optional discount_percentage to Product.",
          operations: [
            {
              op: "add_attribute",
              entity: "product",
              attributeDefinition: { name: "discount_percentage", type: "DECIMAL", nullable: true },
            },
          ],
        },
      ]);
      const service = new ConversationRefinementService({ model: fakeDb, refiner, connected: () => true });
      const res = await service.refine({
        conversationId: convId,
        instruction: "Add a discount percentage to products, and make it optional.",
      });

      const disc = attr(res.schema, "product", "discount_percentage");
      assert.ok(disc);
      assert.equal(disc.type, "DECIMAL");
      assert.equal(disc.nullable, true);
    });
  });

  describe("Initial ER Generation integrity", () => {
    it("geminiService.generateSchema generates, parses and semantically validates initial ER schemas", async () => {
      const { geminiService } = await import("../src/services/geminiService.js");
      const initialSchema = createShoppingSchema();
      const fakeClient = {
        models: {
          generateContent: async () => ({
            text: JSON.stringify(initialSchema),
          }),
        },
      };
      geminiService.client = fakeClient;
      try {
        const result = await geminiService.generateSchema("Online Shopping Store", { model: "gemini-2.5-flash" });
        assert.ok(result.schema);
        assert.equal(result.schema.entities.length, 3);
        assert.equal(result.validation.valid, true);
      } finally {
        geminiService.client = null;
      }
    });
  });
});
