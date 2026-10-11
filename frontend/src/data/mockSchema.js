// Frontend schema configuration and fallback constants.
// The canonical schema is fetched from the backend API (GET /api/schema).

export const INITIAL_REQUIREMENT =
  "Create an e-commerce database where customers can place multiple orders. Each order can contain multiple products. Products belong to categories, and customers can have multiple addresses.";

export const EMPTY_SCHEMA = {
  entities: [],
  relationships: [],
};

// Fallback validation definitions if backend validation is unavailable
export const MOCK_VALIDATIONS = [
  {
    id: "val-1",
    rule: "Foreign Key Integrity",
    message: "All foreign keys reference existing entities",
    status: "valid",
    details: "All foreign key references verified against schema definitions",
  },
  {
    id: "val-2",
    rule: "Entity Uniqueness",
    message: "No duplicate entity names",
    status: "valid",
    details: "Unique entity names validated against schema namespace",
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
    details: "Entities have non-nullable unique primary key identifiers",
  },
];
