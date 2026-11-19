import {
  CARDINALITY_ALIASES,
  FIELD_ALIASES,
  FLAG_ALIASES,
  INVERTED_FLAG_ALIASES,
  MODIFY_ATTRIBUTE_CHANGE_KEYS,
  OP_ALIASES,
  OP_ALIAS_IMPLIED_CHANGES,
} from "./operationContract.js";

/**
 * Operation normalizer: maps every equivalent shape a model may emit onto the ONE canonical contract defined in
 * operationContract.js, before Zod validation and before execution.
 *
 * Rules (they are what keeps the normalizer and the executor in agreement):
 *  - Output shapes are built from the canonical field names only (operationContract.js).
 *  - Only the unambiguous is normalized. A missing attribute name/type, relationship cardinality, etc. is NEVER
 *    invented: the operation is left incomplete so validation rejects it and the bounded repair step can ask the model.
 *  - `cascade` is never defaulted. Removing dependents needs the model to set it, which it may only do when the user
 *    said so explicitly.
 *  - Pure and idempotent: normalizing an already canonical operation returns an equal operation.
 *
 * No imports apart from the contract (no Zod), so this module is trivially unit-testable.
 */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function toBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes") return true;
    if (s === "false" || s === "no") return false;
  }
  return undefined;
}

const toSnake = (s) =>
  String(s)
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

const toPascal = (s) =>
  String(s)
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/** Fills `target[canonical]` from the first present alias (never overrides a present canonical value). */
function aliasInto(target, canonical, aliases) {
  if (target[canonical] !== undefined && target[canonical] !== null) return;
  for (const alias of aliases) {
    if (target[alias] !== undefined && target[alias] !== null) {
      target[canonical] = target[alias];
      return;
    }
  }
}

/** Entity reference given as a string, or as an object carrying `id` / `name`. */
function entityRef(v) {
  if (isObj(v)) return nonEmpty(v.id) ?? nonEmpty(v.name) ?? v;
  return typeof v === "string" ? v.trim() : v;
}

function normalizeEntityField(op, extraAliases = []) {
  aliasInto(op, "entity", [...FIELD_ALIASES.entity, ...extraAliases]);
  if (op.entity !== undefined) op.entity = entityRef(op.entity);
}

export function normalizeCardinality(value) {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s_\-:.>]+/g, "");
  return CARDINALITY_ALIASES[key];
}

/** "customer.customer_id" or {table, column} -> { entity, attribute }. Anything else is returned untouched. */
export function normalizeReferences(ref) {
  if (typeof ref === "string") {
    const m = ref.trim().match(/^([^.\s]+)\.([^.\s]+)$/);
    return m ? { entity: m[1], attribute: m[2] } : ref;
  }
  if (!isObj(ref)) return ref;
  const entity = ref.entity ?? ref.entityId ?? ref.entity_id ?? ref.table ?? ref.tableName ?? ref.table_name;
  const attribute = ref.attribute ?? ref.attributeName ?? ref.attribute_name ?? ref.column ?? ref.columnName ?? ref.column_name ?? ref.field;
  if (typeof entity === "string" && typeof attribute === "string") return { entity: entity.trim(), attribute: attribute.trim() };
  return ref;
}

/** Flag/type spellings of an attribute-like object -> canonical `nullable` / `unique` / `primaryKey` / `foreignKey` / `type`. */
function normalizeAttributeLike(obj) {
  const out = { ...obj };
  for (const [canonical, aliases] of Object.entries(FLAG_ALIASES)) {
    aliasInto(out, canonical, aliases);
    for (const a of aliases) delete out[a];
  }
  for (const [canonical, aliases] of Object.entries(INVERTED_FLAG_ALIASES)) {
    if (out[canonical] === undefined) {
      for (const a of aliases) {
        const b = toBool(out[a]);
        if (b !== undefined) {
          out[canonical] = !b;
          break;
        }
      }
    }
    for (const a of aliases) delete out[a];
  }
  aliasInto(out, "type", FIELD_ALIASES.type);
  for (const a of FIELD_ALIASES.type) delete out[a];
  for (const key of ["primaryKey", "foreignKey", "nullable", "unique"]) {
    if (typeof out[key] === "string") {
      const b = toBool(out[key]);
      if (b === undefined) delete out[key];
      else out[key] = b;
    }
  }
  return out;
}

/** An attribute definition (nested in add_attribute or in an entity definition). */
function normalizeAttributeDef(def) {
  if (!isObj(def)) return def;
  const out = normalizeAttributeLike(def);
  if (out.name === undefined || out.name === null) {
    for (const a of ["attributeName", "attribute_name", "columnName", "column_name", "fieldName", "field_name"]) {
      if (out[a] !== undefined) {
        out.name = out[a];
        break;
      }
    }
  }
  for (const a of ["attributeName", "attribute_name", "columnName", "column_name", "fieldName", "field_name"]) delete out[a];
  if (typeof out.name === "string") out.name = out.name.trim();
  if (typeof out.type === "string") out.type = out.type.trim();
  if (out.references !== undefined) out.references = normalizeReferences(out.references);
  return out;
}

const firstObject = (op, keys) => {
  for (const key of keys) if (isObj(op[key])) return op[key];
  return null;
};

// ---- per-operation normalizers -------------------------------------------------------------------------------------

function normalizeAddAttribute(rawOp) {
  const op = { ...rawOp };
  normalizeEntityField(op);

  let def = firstObject(op, ["attributeDefinition", ...FIELD_ALIASES.attributeDefinition]);
  if (!def) def = firstObject(op, ["attribute", "column", "field"]);

  // Several attributes in one operation -> one canonical add_attribute each.
  if (!def) {
    const list = ["attributeDefinitions", "attribute_definitions", "attributes", "columns", "fields"]
      .map((k) => op[k])
      .find((v) => Array.isArray(v) && v.length > 0 && v.every(isObj));
    if (list && op.entity !== undefined) {
      return list.map((d) => normalizeAddAttribute({ op: "add_attribute", entity: op.entity, attributeDefinition: d }));
    }
  }

  const nested = def ? normalizeAttributeDef(def) : {};
  const top = normalizeAttributeLike(op);
  aliasInto(top, "newName", FIELD_ALIASES.newName);

  // Name: the nested definition wins; stray top-level spellings only fill the gap. `newName` is accepted here ONLY
  // because the add_attribute operation has no other use for it (for modify_attribute / rename_entity it means something else).
  const name =
    nonEmpty(nested.name) ??
    nonEmpty(top.newName) ??
    nonEmpty(top.name) ??
    nonEmpty(op.attribute) ??
    nonEmpty(op.attributeName) ??
    nonEmpty(op.attribute_name) ??
    nonEmpty(op.column) ??
    nonEmpty(op.columnName) ??
    nonEmpty(op.column_name) ??
    nonEmpty(op.field) ??
    nonEmpty(op.fieldName) ??
    nonEmpty(op.field_name);
  const type = nonEmpty(nested.type) ?? nonEmpty(top.type);

  // Never invent a missing name or type: leave the operation as it is so validation rejects it precisely.
  if (!name || !type) return op;

  const attributeDefinition = { name, type };
  for (const key of ["nullable", "unique", "primaryKey", "foreignKey"]) {
    const v = typeof nested[key] === "boolean" ? nested[key] : typeof top[key] === "boolean" ? top[key] : undefined;
    if (v !== undefined) attributeDefinition[key] = v;
  }
  const references = nested.references !== undefined ? nested.references : top.references !== undefined ? normalizeReferences(top.references) : undefined;
  if (references !== undefined) attributeDefinition.references = references;

  const out = { op: "add_attribute", attributeDefinition };
  if (op.entity !== undefined) out.entity = op.entity;
  return out;
}

const CHANGE_CONTAINERS = ["changes", "updates", "set", "newValues", "new_values", "modifications", "patch"];

function applyConstraint(op, constraint, value) {
  const key = constraint.toLowerCase().replace(/[\s-]+/g, "_");
  const set = (field, v) => {
    if (op[field] === undefined) op[field] = v;
  };
  if (["unique", "uniqueness"].includes(key)) set("unique", value ?? true);
  else if (["not_null", "notnull", "required", "non_nullable", "mandatory", "non_null"].includes(key)) set("nullable", !(value ?? true));
  else if (["nullable", "null", "optional", "allow_null"].includes(key)) set("nullable", value ?? true);
  else if (["primary_key", "primarykey", "pk"].includes(key)) set("primaryKey", value ?? true);
}

function normalizeModifyAttribute(rawOp, impliedChanges) {
  const op = normalizeAttributeLike(rawOp);
  normalizeEntityField(op);
  aliasInto(op, "attribute", FIELD_ALIASES.attribute);
  aliasInto(op, "newName", FIELD_ALIASES.newName);

  for (const key of CHANGE_CONTAINERS) {
    if (!isObj(op[key])) continue;
    const nested = normalizeAttributeLike(op[key]);
    aliasInto(nested, "newName", FIELD_ALIASES.newName);
    if (nested.newName === undefined && typeof nested.name === "string") nested.newName = nested.name;
    for (const k of MODIFY_ATTRIBUTE_CHANGE_KEYS) if (op[k] === undefined && nested[k] !== undefined) op[k] = nested[k];
    delete op[key];
  }

  const constraint = nonEmpty(op.constraint) ?? nonEmpty(op.constraintType) ?? nonEmpty(op.constraint_type);
  if (constraint) applyConstraint(op, constraint, toBool(op.value ?? op.enabled));

  if (impliedChanges) for (const [k, v] of Object.entries(impliedChanges)) if (op[k] === undefined) op[k] = v;

  if (isObj(op.attribute)) op.attribute = nonEmpty(op.attribute.name) ?? op.attribute;
  if (op.attribute === undefined && typeof op.name === "string") op.attribute = op.name;
  if (op.attribute !== undefined && op.newName === undefined && typeof op.name === "string" && op.name.trim() !== op.attribute) {
    op.newName = op.name;
  }
  delete op.name;
  if (typeof op.attribute === "string") op.attribute = op.attribute.trim();
  if (typeof op.newName === "string") op.newName = op.newName.trim();
  if (op.references !== undefined) op.references = normalizeReferences(op.references);
  if (typeof op.cascade === "string") {
    const b = toBool(op.cascade);
    if (b === undefined) delete op.cascade;
    else op.cascade = b;
  }
  return op;
}

function normalizeRemoveAttribute(rawOp) {
  const op = { ...rawOp };
  normalizeEntityField(op);
  aliasInto(op, "attribute", FIELD_ALIASES.attribute);
  if (isObj(op.attribute)) op.attribute = nonEmpty(op.attribute.name) ?? op.attribute;
  if (op.attribute === undefined && typeof op.name === "string") op.attribute = op.name;
  if (typeof op.attribute === "string") op.attribute = op.attribute.trim();
  coerceCascade(op);
  return op;
}

function normalizeRemoveEntity(rawOp) {
  const op = { ...rawOp };
  normalizeEntityField(op);
  if (op.entity === undefined && typeof op.name === "string") op.entity = op.name.trim();
  coerceCascade(op);
  return op;
}

function normalizeRenameEntity(rawOp) {
  const op = { ...rawOp };
  normalizeEntityField(op, ["oldName", "old_name", "currentName", "current_name", "from"]);
  aliasInto(op, "newName", [...FIELD_ALIASES.newName, "to"]);
  if (op.newName === undefined && op.entity !== undefined && typeof op.name === "string") op.newName = op.name;
  if (typeof op.newName === "string") op.newName = op.newName.trim();
  return op;
}

function normalizeAddEntity(rawOp) {
  const op = { ...rawOp };
  let def = firstObject(op, ["entityDefinition", ...FIELD_ALIASES.entityDefinition]);
  if (!def && isObj(op.entity)) def = op.entity;

  if (def) {
    const d = { ...def };
    if (Array.isArray(d.attributes)) d.attributes = d.attributes.map(normalizeAttributeDef);
    if (typeof d.name === "string") d.name = d.name.trim();
    if (typeof d.id === "string") d.id = d.id.trim();
    if (!nonEmpty(d.id) && nonEmpty(d.name)) d.id = toSnake(d.name);
    if (!nonEmpty(d.name) && nonEmpty(d.id)) d.name = toPascal(d.id);
    if (!Array.isArray(d.attributes)) d.attributes = [];
    return { op: "add_entity", entityDefinition: d };
  }

  // Flat shape: { op, name | entity | id, description?, attributes? } -> entityDefinition. A name is required: never invented.
  const rawName = nonEmpty(op.name) ?? nonEmpty(op.entityName) ?? nonEmpty(op.entity_name) ?? nonEmpty(op.entity);
  const rawId = nonEmpty(op.id) ?? nonEmpty(op.entityId) ?? nonEmpty(op.entity_id);
  if (!rawName && !rawId) return op;
  const name = nonEmpty(op.name) ?? nonEmpty(op.entityName) ?? nonEmpty(op.entity_name) ?? toPascal(rawName ?? rawId);
  const id = rawId ?? toSnake(rawName ?? name);
  return {
    op: "add_entity",
    entityDefinition: {
      id,
      name,
      description: typeof op.description === "string" ? op.description : "",
      attributes: Array.isArray(op.attributes) ? op.attributes.map(normalizeAttributeDef) : [],
    },
  };
}

/** Source/target/name/cardinality/etc. of a relationship definition (nested or flat). */
function normalizeRelationshipLike(raw) {
  const out = { ...raw };
  aliasInto(out, "source", ["sourceEntity", "source_entity", "from", "fromEntity", "from_entity", "parent", "parentEntity", "parent_entity"]);
  aliasInto(out, "target", ["targetEntity", "target_entity", "to", "toEntity", "to_entity", "child", "childEntity", "child_entity"]);
  if (out.source !== undefined) out.source = entityRef(out.source);
  if (out.target !== undefined) out.target = entityRef(out.target);
  aliasInto(out, "name", ["relationshipName", "relationship_name", "label", "verb"]);
  aliasInto(out, "junctionName", FIELD_ALIASES.junctionName);
  aliasInto(out, "foreignKeyName", ["foreign_key_name", "fkName", "fk_name", "foreignKeyColumn", "foreign_key_column", "foreignKeyAttribute"]);
  if (out.foreignKeyName === undefined && typeof out.foreignKey === "string") out.foreignKeyName = out.foreignKey;
  aliasInto(out, "mandatory", ["required", "isRequired", "is_required"]);
  if (out.mandatory === undefined && out.optional !== undefined) {
    const b = toBool(out.optional);
    if (b !== undefined) out.mandatory = !b;
  }
  if (typeof out.mandatory === "string") {
    const b = toBool(out.mandatory);
    if (b === undefined) delete out.mandatory;
    else out.mandatory = b;
  }
  const card = normalizeCardinality(out.cardinality);
  if (card) {
    out.cardinality = card.cardinality;
    if (card.swap) [out.source, out.target] = [out.target, out.source];
  }
  for (const key of ["name", "junctionName", "foreignKeyName", "id"]) if (typeof out[key] === "string") out[key] = out[key].trim();
  if (!nonEmpty(out.name)) out.name = "has";
  return out;
}

const RELATIONSHIP_KEYS = ["id", "source", "target", "name", "cardinality", "junctionName", "foreignKeyName", "mandatory"];

function normalizeAddRelationship(rawOp) {
  const op = { ...rawOp };
  const nested = firstObject(op, ["relationship", ...FIELD_ALIASES.relationship]);
  if (nested) {
    const relationship = normalizeRelationshipLike(nested);
    const cleaned = {};
    for (const k of RELATIONSHIP_KEYS) if (relationship[k] !== undefined) cleaned[k] = relationship[k];
    return { op: "add_relationship", relationship: cleaned };
  }

  // Flat shape: { op, source, target, name?, cardinality?, ... }. The relationship id is NOT invented here; the executor
  // derives a free one. (A missing cardinality has always defaulted to 1:N for this flat shape.)
  const flat = normalizeRelationshipLike({
    ...(op.relationshipId !== undefined ? { id: op.relationshipId } : op.id !== undefined ? { id: op.id } : {}),
    source: op.source ?? op.sourceEntity ?? op.source_entity ?? op.from ?? op.fromEntity ?? op.parent,
    target: op.target ?? op.targetEntity ?? op.target_entity ?? op.to ?? op.toEntity ?? op.child,
    name: op.name ?? op.relationshipName,
    cardinality: op.cardinality,
    junctionName: op.junctionName ?? op.junction_name,
    foreignKeyName: op.foreignKeyName ?? op.foreign_key_name,
    mandatory: op.mandatory ?? op.required,
  });
  if (!nonEmpty(flat.source) || !nonEmpty(flat.target)) return op;
  if (flat.cardinality === undefined) flat.cardinality = "1:N";
  const cleaned = {};
  for (const k of RELATIONSHIP_KEYS) if (flat[k] !== undefined) cleaned[k] = flat[k];
  return { op: "add_relationship", relationship: cleaned };
}

function normalizeRelationshipIdField(op) {
  aliasInto(op, "relationshipId", [...FIELD_ALIASES.relationshipId, "id"]);
  if (op.relationshipId === undefined && typeof op.relationship === "string") op.relationshipId = op.relationship;
  if (typeof op.relationshipId === "string") op.relationshipId = op.relationshipId.trim();
}

function normalizeModifyRelationship(rawOp) {
  const op = { ...rawOp };
  normalizeRelationshipIdField(op);
  aliasInto(op, "relationshipName", [...FIELD_ALIASES.relationshipName, "name", "newName", "new_name", "label"]);
  const card = normalizeCardinality(op.cardinality);
  if (card) op.cardinality = card.cardinality;
  if (typeof op.relationshipName === "string") op.relationshipName = op.relationshipName.trim();
  return op;
}

function normalizeRelationshipIdOnly(rawOp) {
  const op = { ...rawOp };
  normalizeRelationshipIdField(op);
  aliasInto(op, "junctionName", FIELD_ALIASES.junctionName);
  if (typeof op.junctionName === "string") op.junctionName = op.junctionName.trim();
  return op;
}

function normalizeModifyPrimaryKey(rawOp) {
  const op = { ...rawOp };
  normalizeEntityField(op);
  let value = op.primaryKeyAttributes;
  if (value === undefined) {
    for (const key of [...FIELD_ALIASES.primaryKeyAttributes, "attribute", "attributeName", "attribute_name", "column", "field", "primaryKey", "primary_key", "name", "attributes"]) {
      if (op[key] !== undefined && op[key] !== null) {
        value = op[key];
        break;
      }
    }
  }
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const seen = new Set();
  const primaryKeyAttributes = [];
  for (const item of items) {
    const text = isObj(item) ? nonEmpty(item.name) ?? nonEmpty(item.attribute) : nonEmpty(item);
    if (!text) continue;
    for (const part of text.split(",")) {
      const name = part.trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        primaryKeyAttributes.push(name);
      }
    }
  }
  const out = { op: "modify_primary_key", primaryKeyAttributes };
  if (op.entity !== undefined) out.entity = op.entity;
  return out;
}

function coerceCascade(op) {
  if (typeof op.cascade === "string") {
    const b = toBool(op.cascade);
    if (b === undefined) delete op.cascade;
    else op.cascade = b;
  }
}

// ---- public API ----------------------------------------------------------------------------------------------------

/** Canonical operation name for a raw `op` value (aliases resolved, case/space/hyphen insensitive). */
export function canonicalOpName(raw) {
  if (typeof raw !== "string") return raw;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return OP_ALIASES[key] ?? key;
}

/** Normalizes ONE raw operation. May return an array when the model packed several attributes into one operation. */
export function normalizeOperation(rawOp) {
  if (!isObj(rawOp)) return rawOp;
  const aliasKey = typeof rawOp.op === "string" ? rawOp.op.trim().toLowerCase().replace(/[\s-]+/g, "_") : null;
  const op = { ...rawOp, op: canonicalOpName(rawOp.op) };

  switch (op.op) {
    case "add_attribute":
      return normalizeAddAttribute(op);
    case "modify_attribute":
      return normalizeModifyAttribute(op, aliasKey ? OP_ALIAS_IMPLIED_CHANGES[aliasKey] : undefined);
    case "remove_attribute":
      return normalizeRemoveAttribute(op);
    case "remove_entity":
      return normalizeRemoveEntity(op);
    case "rename_entity":
      return normalizeRenameEntity(op);
    case "add_entity":
      return normalizeAddEntity(op);
    case "add_relationship":
      return normalizeAddRelationship(op);
    case "modify_relationship":
      return normalizeModifyRelationship(op);
    case "remove_relationship":
    case "convert_many_to_many":
      return normalizeRelationshipIdOnly(op);
    case "modify_primary_key":
      return normalizeModifyPrimaryKey(op);
    default:
      return op;
  }
}

/** Normalizes a list of raw operations (non-arrays are returned unchanged so the schema validator reports them). */
export function normalizeOperations(rawOperations) {
  if (!Array.isArray(rawOperations)) return rawOperations;
  const out = [];
  for (const raw of rawOperations) {
    const normalized = normalizeOperation(raw);
    if (Array.isArray(normalized)) out.push(...normalized);
    else out.push(normalized);
  }
  return out;
}
