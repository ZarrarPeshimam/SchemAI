// Single source of truth for the demo schema.
//
// The shape below is intentionally LLM-friendly: a future backend can return
// JSON in exactly this form ({ entities, relationships }) and every consumer
// (diagram, entity list, relationship list) will pick it up.
//
//   attribute.references  -> optional { entity, attribute } for foreign keys
//   relationship.source   -> parent entity id (the "1" side)
//   relationship.target   -> child entity id  (the "N" side)

export const INITIAL_REQUIREMENT =
  "Create an e-commerce database where customers can place multiple orders. Each order can contain multiple products. Products belong to categories, and customers can have multiple addresses.";

const pk = (name, type = "INT") => ({ name, type, primaryKey: true, foreignKey: false });
const fk = (name, entity, attribute, type = "INT") => ({
  name,
  type,
  primaryKey: false,
  foreignKey: true,
  references: { entity, attribute },
});
const col = (name, type) => ({ name, type, primaryKey: false, foreignKey: false });

export const mockSchema = {
  entities: [
    {
      id: "customer",
      name: "Customer",
      description: "Registered buyers and profile information",
      attributes: [pk("customer_id"), col("name", "VARCHAR"), col("email", "VARCHAR")],
    },
    {
      id: "address",
      name: "Address",
      description: "Shipping and billing addresses linked to customers",
      attributes: [
        pk("address_id"),
        fk("customer_id", "customer", "customer_id"),
        col("street", "VARCHAR"),
        col("city", "VARCHAR"),
      ],
    },
    {
      id: "order",
      name: "Order",
      description: "Customer purchasing transactions and status",
      attributes: [
        pk("order_id"),
        fk("customer_id", "customer", "customer_id"),
        col("order_date", "DATE"),
        col("status", "VARCHAR"),
      ],
    },
    {
      id: "order_item",
      name: "OrderItem",
      description: "Line items linking orders to purchased products",
      attributes: [
        pk("order_item_id"),
        fk("order_id", "order", "order_id"),
        fk("product_id", "product", "product_id"),
        col("quantity", "INT"),
      ],
    },
    {
      id: "product",
      name: "Product",
      description: "Catalog items available for purchase",
      attributes: [
        pk("product_id"),
        fk("category_id", "category", "category_id"),
        col("name", "VARCHAR"),
        col("price", "DECIMAL"),
      ],
    },
    {
      id: "category",
      name: "Category",
      description: "Hierarchical product classification groups",
      attributes: [pk("category_id"), col("name", "VARCHAR")],
    },
  ],
  relationships: [
    { id: "customer-address", source: "customer", target: "address", name: "has", cardinality: "1:N" },
    { id: "customer-order", source: "customer", target: "order", name: "places", cardinality: "1:N" },
    { id: "order-order_item", source: "order", target: "order_item", name: "contains", cardinality: "1:N" },
    { id: "product-order_item", source: "product", target: "order_item", name: "included_in", cardinality: "1:N" },
    { id: "category-product", source: "category", target: "product", name: "contains", cardinality: "1:N" },
  ],
};

// Mock validation results (unchanged from the original dashboard).
export const MOCK_VALIDATIONS = [
  {
    id: "val-1",
    rule: "Foreign Key Integrity",
    message: "All foreign keys reference existing entities",
    status: "valid",
    details: "4 foreign key references checked and resolved successfully",
  },
  {
    id: "val-2",
    rule: "Entity Uniqueness",
    message: "No duplicate entity names",
    status: "valid",
    details: "6 unique entity names validated against schema namespace",
  },
  {
    id: "val-3",
    rule: "Cardinality Validity",
    message: "All relationships have valid cardinality",
    status: "valid",
    details: "Crow's foot notation and binary multiplicity constraints verified",
  },
  {
    id: "val-4",
    rule: "Primary Key Definition",
    message: "Primary keys defined for all entities",
    status: "valid",
    details: "6/6 entities have non-nullable unique primary key identifiers",
  },
];
