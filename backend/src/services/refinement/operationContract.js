/**
 * THE canonical operation contract for schema refinement.
 *
 * Gemini proposes operations, `operationNormalizer.js` maps every accepted equivalent shape onto the shapes below,
 * `operationSchema.js` validates them with Zod and `applyOperations.js` executes them. All three read the field names
 * from THIS file, so the normalizer can never produce a property the executor does not read (the original
 * `attributeDefinition` vs flat `newName`/`type` mismatch).
 *
 * This module has no imports on purpose: it is plain data + tiny pure helpers.
 *
 * Canonical operations and their required fields
 * ----------------------------------------------
 *   add_entity            entityDefinition { id, name, description?, attributes[] }
 *   remove_entity         entity                       (cascade? only when the user explicitly agreed)
 *   rename_entity         entity, newName
 *   add_attribute         entity, attributeDefinition { name, type, nullable?, unique?, primaryKey?, foreignKey?, references? }
 *   remove_attribute      entity, attribute            (cascade? only when the user explicitly agreed)
 *   modify_attribute      entity, attribute, and at least one of newName | type | nullable | unique | primaryKey |
 *                         foreignKey | references
 *   add_relationship      relationship { source, target, name, cardinality, junctionName?, foreignKeyName?, mandatory? }
 *   remove_relationship   relationshipId
 *   modify_relationship   relationshipId, and at least one of cardinality | relationshipName
 *   convert_many_to_many  relationshipId, junctionName?
 *   modify_primary_key    entity, primaryKeyAttributes[]   (REPLACES the entity's primary key)
 *
 * Requests the user may phrase as "rename an attribute", "make email unique/compulsory" or "change a constraint" are
 * all `modify_attribute` (see OP_ALIASES): one operation, one executor path.
 */

export const OPERATION_TYPES = [
  "add_entity",
  "remove_entity",
  "rename_entity",
  "add_attribute",
  "modify_attribute",
  "remove_attribute",
  "add_relationship",
  "modify_relationship",
  "remove_relationship",
  "convert_many_to_many",
  "modify_primary_key",
];

/** Properties of `modify_attribute` that describe a change (at least one is required). */
export const MODIFY_ATTRIBUTE_CHANGE_KEYS = ["newName", "type", "nullable", "unique", "primaryKey", "foreignKey", "references"];

/** Properties of a nested relationship definition that must be present for `add_relationship`. */
export const RELATIONSHIP_DEFINITION_REQUIRED = ["source", "target", "name", "cardinality"];

/** Top-level fields each operation requires. The executor checks exactly this list before running a handler. */
export const REQUIRED_FIELDS = {
  add_entity: ["entityDefinition"],
  remove_entity: ["entity"],
  rename_entity: ["entity", "newName"],
  add_attribute: ["entity", "attributeDefinition"],
  remove_attribute: ["entity", "attribute"],
  modify_attribute: ["entity", "attribute"],
  add_relationship: ["relationship"],
  remove_relationship: ["relationshipId"],
  modify_relationship: ["relationshipId"],
  convert_many_to_many: ["relationshipId"],
  modify_primary_key: ["entity", "primaryKeyAttributes"],
};

const isPresent = (v) => {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

/** Names of the required fields that `op` lacks (empty array = the operation has everything its executor reads). */
export function missingRequiredFields(op) {
  const required = REQUIRED_FIELDS[op?.op];
  if (!required) return [];
  return required.filter((field) => !isPresent(op[field]));
}

/**
 * Alternative operation names a model may emit -> canonical operation. Matching is done on the lower-cased name with
 * spaces/hyphens turned into underscores. Anything not listed here (for example `drop_table`) is NOT guessed at: it is
 * rejected by the Zod enum and the model is asked to correct itself.
 */
export const OP_ALIASES = {
  create_entity: "add_entity",
  new_entity: "add_entity",
  delete_entity: "remove_entity",
  create_attribute: "add_attribute",
  new_attribute: "add_attribute",
  add_column: "add_attribute",
  add_field: "add_attribute",
  delete_attribute: "remove_attribute",
  remove_column: "remove_attribute",
  remove_field: "remove_attribute",
  delete_column: "remove_attribute",
  delete_field: "remove_attribute",
  update_attribute: "modify_attribute",
  change_attribute: "modify_attribute",
  alter_attribute: "modify_attribute",
  modify_column: "modify_attribute",
  alter_column: "modify_attribute",
  update_column: "modify_attribute",
  // intent-carrying aliases: the implied change is listed in OP_ALIAS_IMPLIED_CHANGES
  rename_attribute: "modify_attribute",
  rename_column: "modify_attribute",
  rename_field: "modify_attribute",
  change_type: "modify_attribute",
  change_data_type: "modify_attribute",
  set_type: "modify_attribute",
  modify_constraint: "modify_attribute",
  update_constraint: "modify_attribute",
  set_constraint: "modify_attribute",
  set_unique: "modify_attribute",
  make_unique: "modify_attribute",
  set_not_null: "modify_attribute",
  make_required: "modify_attribute",
  make_non_nullable: "modify_attribute",
  set_nullable: "modify_attribute",
  make_nullable: "modify_attribute",
  make_optional: "modify_attribute",
  create_relationship: "add_relationship",
  new_relationship: "add_relationship",
  delete_relationship: "remove_relationship",
  update_relationship: "modify_relationship",
  change_relationship: "modify_relationship",
  change_cardinality: "modify_relationship",
  set_cardinality: "modify_relationship",
  set_primary_key: "modify_primary_key",
  change_primary_key: "modify_primary_key",
  replace_primary_key: "modify_primary_key",
  update_primary_key: "modify_primary_key",
};

/** Changes implied by an alias name itself (explicit fields on the operation always win over these). */
export const OP_ALIAS_IMPLIED_CHANGES = {
  set_unique: { unique: true },
  make_unique: { unique: true },
  set_not_null: { nullable: false },
  make_required: { nullable: false },
  make_non_nullable: { nullable: false },
  set_nullable: { nullable: true },
  make_nullable: { nullable: true },
  make_optional: { nullable: true },
};

/** Canonical property <- alternative spellings, applied only when the canonical property is absent. */
export const FIELD_ALIASES = {
  entity: ["entityId", "entity_id", "entityName", "entity_name", "table", "tableName", "table_name"],
  attribute: [
    "attributeName", "attribute_name", "column", "columnName", "column_name", "field", "fieldName", "field_name",
    "oldName", "old_name", "currentName", "current_name", "originalName", "original_name", "fromName", "from_name", "from",
  ],
  newName: [
    "new_name", "newAttributeName", "new_attribute_name", "newColumnName", "new_column_name", "newFieldName",
    "newEntityName", "new_entity_name", "toName", "to_name", "renameTo", "rename_to", "to", "newColumn", "new_column",
  ],
  type: ["dataType", "data_type", "newType", "new_type", "sqlType", "sql_type", "columnType", "column_type"],
  relationshipId: ["relationship_id", "relationshipID"],
  relationshipName: ["relationship_name", "newRelationshipName", "new_relationship_name"],
  junctionName: ["junction_name", "junctionTable", "junction_table", "junctionEntity", "associativeEntity", "associative_entity"],
  attributeDefinition: [
    "attribute_definition", "attributeDef", "attribute_def", "columnDefinition", "column_definition",
    "newAttribute", "new_attribute", "attributeDetails", "attribute_details", "definition",
  ],
  entityDefinition: ["entity_definition", "entityDef", "entity_def", "newEntity", "new_entity", "entityDetails", "entity_details", "definition"],
  relationship: ["relationshipDefinition", "relationship_definition", "newRelationship", "new_relationship"],
  primaryKeyAttributes: [
    "primary_key_attributes", "primaryKeyColumns", "primary_key_columns", "primaryKeyAttribute", "newPrimaryKey",
    "new_primary_key", "primaryKeys", "primary_keys", "columns", "keyAttributes", "key_attributes",
  ],
};

/** Flag spellings (value kept as is) and inverted flag spellings (value negated) for attribute-like objects. */
export const FLAG_ALIASES = {
  primaryKey: ["primary_key", "isPrimaryKey", "is_primary_key", "pk"],
  foreignKey: ["foreign_key", "isForeignKey", "is_foreign_key", "fk"],
  nullable: ["isNullable", "is_nullable", "allowNull", "allow_null"],
  unique: ["isUnique", "is_unique"],
};
export const INVERTED_FLAG_ALIASES = {
  nullable: ["notNull", "not_null", "isRequired", "is_required", "required", "nonNullable", "non_nullable", "mandatory"],
};

/**
 * Cardinality spellings. Keys are the spelling with spaces, `_`, `-`, `:`, `.` and `>` removed and lower-cased.
 * `swap: true` means the spelling describes the relationship from the child side ("many-to-one"), so source and
 * target must be exchanged to keep SchemAI's convention (source = parent / "1" side, target = child / "N" side).
 */
export const CARDINALITY_ALIASES = {
  "11": { cardinality: "1:1" },
  onetoone: { cardinality: "1:1" },
  oneone: { cardinality: "1:1" },
  "1to1": { cardinality: "1:1" },
  "1n": { cardinality: "1:N" },
  "1m": { cardinality: "1:N" },
  "1*": { cardinality: "1:N" },
  "1many": { cardinality: "1:N" },
  "1tomany": { cardinality: "1:N" },
  "1ton": { cardinality: "1:N" },
  onetomany: { cardinality: "1:N" },
  onemany: { cardinality: "1:N" },
  nm: { cardinality: "N:M" },
  mn: { cardinality: "N:M" },
  nn: { cardinality: "N:M" },
  mm: { cardinality: "N:M" },
  "**": { cardinality: "N:M" },
  manytomany: { cardinality: "N:M" },
  manymany: { cardinality: "N:M" },
  ntom: { cardinality: "N:M" },
  mton: { cardinality: "N:M" },
  n1: { cardinality: "1:N", swap: true },
  m1: { cardinality: "1:N", swap: true },
  "*1": { cardinality: "1:N", swap: true },
  manytoone: { cardinality: "1:N", swap: true },
  manyone: { cardinality: "1:N", swap: true },
  nto1: { cardinality: "1:N", swap: true },
  mto1: { cardinality: "1:N", swap: true },
};
