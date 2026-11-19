import { SQL_IDENTIFIER_REGEX, SUPPORTED_DATA_TYPES, SUPPORTED_CARDINALITIES } from "../../validators/schemaValidator.js";
import { toSqlTableName } from "../sqlGeneratorService.js";
import { MODIFY_ATTRIBUTE_CHANGE_KEYS, missingRequiredFields } from "./operationContract.js";

/**
 * Deterministic application of change operations to a COPY of the schema.
 * Pure: never mutates its input, never calls an LLM, never validates the whole schema (refinementValidator does).
 *
 * Returns one of:
 *   { ok: true,  schema, changes: string[] }
 *   { ok: false, kind: "invalid", issues: string[] }            -> repairable (fed back to the model)
 *   { ok: false, kind: "clarify", question: string }            -> shown to the user, NO repair, nothing applied
 */

const ENTITY_ID_REGEX = /^[a-z][a-z0-9_]*$/;

class OpError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "invalid" | "clarify"
  }
}
const invalid = (msg) => new OpError("invalid", msg);
const clarify = (msg) => new OpError("clarify", msg);

const norm = (s) => String(s ?? "").trim().toLowerCase();
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function listEntities(schema) {
  return schema.entities.map((e) => `${e.id} ("${e.name}")`).join(", ");
}

/**
 * Tolerant name matching, used ONLY to resolve references to things that already exist. The canonical spelling of the
 * existing name is always what the schema keeps. Order: exact (case-insensitive) -> same letters/digits ignoring
 * separators and case ("order item" / "OrderItem" / "order_item") -> the same after dropping a plural "s"/"es"/"ies".
 * A fuzzy tier is only used when it identifies exactly ONE candidate; several candidates is an error, never a guess.
 */
const squash = (s) => norm(s).replace(/[^a-z0-9]/g, "");
const singularize = (s) => (s.endsWith("ies") && s.length > 4 ? `${s.slice(0, -3)}y` : /(ss|us|is)$/.test(s) ? s : /(ches|shes|xes|zes|sses)$/.test(s) ? s.slice(0, -2) : s.endsWith("s") && s.length > 2 ? s.slice(0, -1) : s);

function matchOne(items, ref, keysOf) {
  const exact = norm(ref);
  const tiers = [
    (k) => norm(k) === exact,
    (k) => squash(k) === squash(ref),
    (k) => singularize(squash(k)) === singularize(squash(ref)),
  ];
  for (const tier of tiers) {
    const hits = items.filter((item) => keysOf(item).some((k) => k && tier(k)));
    if (hits.length === 1) return { found: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
  }
  return {};
}

function resolveEntity(schema, ref, what = "entity") {
  const key = norm(ref);
  if (!key) throw invalid(`A ${what} reference is required.`);
  const { found, ambiguous } = matchOne(schema.entities, ref, (e) => [e.id, e.name]);
  if (ambiguous) {
    throw invalid(`'${ref}' could mean several entities (${ambiguous.map((e) => e.id).join(", ")}). Use the exact entity id.`);
  }
  if (!found) throw invalid(`Entity '${ref}' does not exist. Existing entities: ${listEntities(schema)}.`);
  return found;
}

// Strict (case-insensitive) lookup: used to detect DUPLICATES, where near-matches must not be conflated.
const findAttr = (entity, name) => entity.attributes.find((a) => norm(a.name) === norm(name));

function requireAttr(entity, name) {
  if (!name) throw invalid(`An attribute name is required for entity '${entity.id}'.`);
  const { found, ambiguous } = matchOne(entity.attributes, name, (a) => [a.name]);
  if (ambiguous) {
    throw invalid(`'${name}' could mean several attributes of '${entity.id}' (${ambiguous.map((a) => a.name).join(", ")}). Use the exact attribute name.`);
  }
  if (!found) {
    throw invalid(
      `Attribute '${name}' does not exist in entity '${entity.id}'. Its attributes: ${entity.attributes.map((a) => a.name).join(", ")}.`
    );
  }
  return found;
}

/** "VARCHAR(255)" -> { type: "VARCHAR", note }, "decimal(10,2)" -> DECIMAL. Unsupported types are rejected. */
function normalizeType(raw, notes) {
  const text = String(raw ?? "").trim();
  const base = text.replace(/\s*\(.*\)\s*$/, "").toUpperCase();
  if (!SUPPORTED_DATA_TYPES.includes(base)) {
    throw invalid(`Data type '${raw}' is not supported. Supported types: ${SUPPORTED_DATA_TYPES.join(", ")}.`);
  }
  if (/\(.*\)/.test(text)) {
    notes.add("Length/precision parameters are not stored in the schema; the SQL generator applies its own defaults.");
  }
  return base;
}

function buildAttribute(def, notes) {
  if (!def || typeof def !== "object") throw invalid("An attribute definition is required.");
  const name = String(def.name ?? "").trim();
  if (!SQL_IDENTIFIER_REGEX.test(name)) throw invalid(`Attribute name '${def.name}' is not a valid identifier (letters, digits, underscore).`);
  const primaryKey = def.primaryKey === true;
  const foreignKey = def.foreignKey === true;
  const attr = {
    name,
    type: normalizeType(def.type, notes),
    primaryKey,
    foreignKey,
    nullable: primaryKey ? false : def.nullable ?? true,
    unique: def.unique ?? false,
  };
  if (foreignKey && def.references) attr.references = { entity: def.references.entity, attribute: def.references.attribute };
  return attr;
}

function referencesTo(schema, entityId, attrName) {
  const out = [];
  for (const e of schema.entities) {
    for (const a of e.attributes) {
      if (a.foreignKey && a.references?.entity === entityId && (!attrName || norm(a.references.attribute) === norm(attrName))) {
        out.push({ entity: e, attr: a });
      }
    }
  }
  return out;
}

const describeRefs = (refs) => refs.map((r) => `${r.entity.id}.${r.attr.name}`).join(", ");

function singlePk(entity) {
  const pks = entity.attributes.filter((a) => a.primaryKey);
  if (pks.length !== 1) {
    throw invalid(
      `Entity '${entity.id}' needs exactly one primary-key column to be linked by a foreign key (it has ${pks.length}).`
    );
  }
  return pks[0];
}

function freeAttrName(entity, preferred) {
  let name = preferred;
  let i = 2;
  while (findAttr(entity, name)) name = `${preferred}_${i++}`;
  return name;
}

function freeRelationshipId(schema, preferred) {
  let id = preferred;
  let i = 2;
  while (schema.relationships.some((r) => r.id === id)) id = `${preferred}_${i++}`;
  return id;
}

function findRelationship(schema, id) {
  const key = norm(id);
  if (!key) throw invalid("A relationship id is required.");
  const { found, ambiguous } = matchOne(schema.relationships, id, (r) => [r.id]);
  if (ambiguous) throw invalid(`'${id}' could mean several relationships (${ambiguous.map((r) => r.id).join(", ")}). Use the exact relationship id.`);
  if (!found) throw invalid(`Relationship '${id}' does not exist. Existing: ${schema.relationships.map((r) => r.id).join(", ") || "(none)"}.`);
  return found;
}

/** Non-N:M relationships whose only foreign-key column to the parent is `attr` (so they would be left dangling without it). */
function relationshipsRelyingOn(schema, entity, attr) {
  if (!(attr.foreignKey && attr.references)) return [];
  return schema.relationships.filter(
    (r) =>
      r.cardinality !== "N:M" &&
      r.target === entity.id &&
      r.source === attr.references.entity &&
      !entity.attributes.some((a) => a !== attr && a.foreignKey && a.references?.entity === r.source)
  );
}

/** Changes a column type and keeps every foreign key that references it consistent. */
function setAttributeType(schema, entity, attr, newType, ctx) {
  for (const d of referencesTo(schema, entity.id, attr.name)) {
    d.attr.type = newType;
    ctx.changes.push(`Changed type of ${d.entity.name}.${d.attr.name} to ${newType} to keep it consistent with ${entity.name}.${attr.name}.`);
  }
  attr.type = newType;
}

/** Creates the associative entity + two 1:N relationships for an N:M link between `source` and `target`. */
function createJunction(schema, source, target, { relName, junctionName: rawJunctionName, baseId, verb }, ctx) {
  const junctionName = String(rawJunctionName ?? `${source.name}${target.name}`).trim();
  if (!SQL_IDENTIFIER_REGEX.test(junctionName)) throw invalid(`Junction entity name '${junctionName}' is not a valid identifier.`);
  const junctionId = snake(junctionName);
  if (schema.entities.some((e) => norm(e.id) === junctionId || norm(e.name) === norm(junctionName))) {
    throw invalid(`Cannot create junction entity '${junctionName}': an entity with that id/name already exists. Provide a different 'junctionName'.`);
  }
  const sPk = singlePk(source);
  const tPk = singlePk(target);
  const same = source.id === target.id;
  const sName = same || norm(sPk.name) === norm(tPk.name) ? `${source.id}_${sPk.name}` : sPk.name;
  const tName = same ? `related_${tPk.name}` : norm(sPk.name) === norm(tPk.name) ? `${target.id}_${tPk.name}` : tPk.name;
  const mk = (n, pk, ent) => ({
    name: n, type: pk.type, primaryKey: true, foreignKey: true, nullable: false, unique: false,
    references: { entity: ent.id, attribute: pk.name },
  });
  const junction = {
    id: junctionId,
    name: junctionName,
    description: `Associative entity for the many-to-many relationship '${relName}' between ${source.name} and ${target.name}`,
    attributes: [mk(sName, sPk, source), mk(tName, tPk, target)],
  };
  schema.entities.push(junction);
  const r1 = { id: freeRelationshipId(schema, baseId ? `${baseId}_1` : `${source.id}_${junctionId}`), source: source.id, target: junctionId, name: "has", cardinality: "1:N" };
  schema.relationships.push(r1);
  const r2 = { id: freeRelationshipId(schema, baseId ? `${baseId}_2` : `${target.id}_${junctionId}`), source: target.id, target: junctionId, name: "has", cardinality: "1:N" };
  schema.relationships.push(r2);
  ctx.changes.push(
    `${verb} many-to-many relationship '${relName}' between ${source.name} and ${target.name} as the junction entity ${junctionName} ` +
      `(composite key ${sName}, ${tName}) with two 1:N relationships.`
  );
  return junction;
}

// ---- operation handlers -----------------------------------------------------------------------------------------

function addEntity(schema, op, ctx) {
  const def = op.entityDefinition;
  if (!def) throw invalid("add_entity requires 'entityDefinition'.");
  const id = String(def.id ?? "").trim();
  const name = String(def.name ?? "").trim();
  if (!ENTITY_ID_REGEX.test(id)) throw invalid(`Entity id '${def.id}' must be lowercase snake_case (e.g. 'department').`);
  if (!SQL_IDENTIFIER_REGEX.test(name)) throw invalid(`Entity name '${def.name}' must be a valid identifier (letters, digits, underscore).`);
  if (schema.entities.some((e) => norm(e.id) === norm(id) || norm(e.name) === norm(name))) {
    throw invalid(`An entity with id '${id}' or name '${name}' already exists.`);
  }

  const attributes = [];
  for (const a of def.attributes ?? []) {
    const built = buildAttribute(a, ctx.notes);
    if (attributes.some((x) => norm(x.name) === norm(built.name))) throw invalid(`Attribute '${built.name}' is duplicated in new entity '${id}'.`);
    attributes.push(built);
  }
  if (!attributes.some((a) => a.primaryKey)) {
    const pkName = `${id}_id`;
    if (attributes.some((a) => norm(a.name) === pkName)) throw invalid(`New entity '${id}' has no primary key; mark one of its attributes as primaryKey.`);
    attributes.unshift({ name: pkName, type: "INT", primaryKey: true, foreignKey: false, nullable: false, unique: true });
    ctx.changes.push(`Added primary key '${pkName}' (INT) to the new entity ${name}, since none was specified.`);
  }

  const entity = { id, name, description: def.description ?? "", attributes };
  schema.entities.push(entity);
  ctx.changes.push(`Added entity ${name} with ${attributes.length} attribute(s): ${attributes.map((a) => a.name).join(", ")}.`);
}

/**
 * REMOVAL POLICY (entity)
 *  - Relationships that touch the removed entity are removed with it: they cannot exist without it, they are part of it.
 *  - Foreign-key columns in OTHER entities that point at it would dangle. They are columns the user did not name, so they
 *    are removed only when the user explicitly agreed (`cascade: true`); otherwise the user is told exactly what is affected.
 *  - A dependent foreign key that is part of another entity's PRIMARY KEY (typically an associative entity) is never
 *    removed implicitly, even with `cascade`: that entity would have to be redesigned or removed first.
 */
function removeEntity(schema, op, ctx) {
  const entity = resolveEntity(schema, op.entity);
  const rels = schema.relationships.filter((r) => r.source === entity.id || r.target === entity.id);
  const refs = referencesTo(schema, entity.id).filter((r) => r.entity.id !== entity.id);

  for (const { entity: owner, attr } of refs) {
    if (attr.primaryKey) {
      throw clarify(
        `${owner.name}.${attr.name} is part of ${owner.name}'s primary key and references ${entity.name}. ` +
          `Removing ${entity.name} would require redesigning or removing ${owner.name} as well; please say how you want that handled.`
      );
    }
  }

  if (refs.length > 0 && !op.cascade) {
    const parts = [];
    if (rels.length) parts.push(`relationships: ${rels.map((r) => r.id).join(", ")}`);
    parts.push(`foreign keys: ${describeRefs(refs)}`);
    throw clarify(
      `Removing ${entity.name} would also affect ${parts.join(" and ")}. Do you want to remove those as well? ` +
        `If so, say so explicitly (for example "remove ${entity.name} and its relationships and foreign keys").`
    );
  }

  for (const { entity: owner, attr } of refs) {
    owner.attributes = owner.attributes.filter((a) => a !== attr);
    ctx.changes.push(`Removed foreign key ${owner.name}.${attr.name} (it referenced ${entity.name}).`);
  }
  schema.relationships = schema.relationships.filter((r) => !rels.includes(r));
  for (const r of rels) ctx.changes.push(`Removed relationship '${r.id}' (${r.source} ${r.cardinality} ${r.target}).`);
  schema.entities = schema.entities.filter((e) => e !== entity);
  ctx.changes.push(`Removed entity ${entity.name}.`);
}

function renameEntity(schema, op, ctx) {
  const entity = resolveEntity(schema, op.entity);
  const newName = String(op.newName ?? "").trim();
  if (!newName) throw invalid("rename_entity requires 'newName'.");
  if (!SQL_IDENTIFIER_REGEX.test(newName)) throw invalid(`Entity name '${op.newName}' must be a valid identifier (letters, digits, underscore).`);
  if (newName === entity.name) throw invalid(`Entity '${entity.id}' is already named '${newName}'; nothing to change.`);
  const clash = schema.entities.find(
    (e) => e !== entity && (norm(e.name) === norm(newName) || toSqlTableName(e.name) === toSqlTableName(newName))
  );
  if (clash) throw invalid(`Cannot rename to '${newName}': entity '${clash.id}' (\"${clash.name}\") already uses that name or the same table name.`);
  const old = entity.name;
  entity.name = newName;
  // The id is the stable key used by relationships and foreign keys, so it is deliberately kept.
  ctx.changes.push(`Renamed entity ${old} to ${newName} (its id '${entity.id}' is kept so relationships and foreign keys stay linked).`);
}

function addAttribute(schema, op, ctx) {
  const entity = resolveEntity(schema, op.entity);
  if (!op.attributeDefinition) throw invalid("add_attribute requires 'attributeDefinition'.");
  const attr = buildAttribute(op.attributeDefinition, ctx.notes);
  if (findAttr(entity, attr.name)) {
    throw invalid(
      `Attribute '${attr.name}' already exists in entity '${entity.id}'. To change it use modify_attribute, or ask the user what they want.`
    );
  }
  entity.attributes.push(attr);
  const flags = [attr.primaryKey && "primary key", attr.unique && "unique", attr.nullable === false && "not null"].filter(Boolean);
  ctx.changes.push(`Added attribute ${entity.name}.${attr.name} (${attr.type}${flags.length ? `, ${flags.join(", ")}` : ""}).`);
}

const MODIFY_ATTRIBUTE_KEYS = MODIFY_ATTRIBUTE_CHANGE_KEYS;

function dropForeignKey(schema, entity, attr, ctx, { cascade, descr }) {
  const rels = relationshipsRelyingOn(schema, entity, attr);
  if (rels.length && !cascade) {
    throw clarify(
      `${entity.name}.${attr.name} is the foreign key behind the relationship(s) ${rels.map((r) => `'${r.id}'`).join(", ")}. ` +
        `Making it a plain column would remove them as well. Do you want that? If so, say so explicitly.`
    );
  }
  schema.relationships = schema.relationships.filter((r) => !rels.includes(r));
  for (const r of rels) ctx.changes.push(`Removed relationship '${r.id}' (${r.source} ${r.cardinality} ${r.target}) that relied on ${entity.name}.${attr.name}.`);
  attr.foreignKey = false;
  delete attr.references;
  descr.push("no longer a foreign key");
}

function setForeignKey(schema, entity, attr, refDef, ctx, op, descr) {
  const ref = refDef ?? attr.references;
  if (!ref) throw invalid(`Making ${entity.id}.${attr.name} a foreign key requires 'references' (the referenced entity and attribute).`);
  const parent = resolveEntity(schema, ref.entity, "referenced entity");
  const parentAttr = ref.attribute ? requireAttr(parent, ref.attribute) : singlePk(parent);
  if (parent === entity && parentAttr === attr) throw invalid("A column cannot reference itself.");
  if (attr.foreignKey && attr.references?.entity === parent.id && norm(attr.references.attribute) === norm(parentAttr.name)) return; // unchanged

  // Re-pointing an existing foreign key: the relationship that relied on the old target is replaced, not left dangling.
  if (attr.foreignKey) dropForeignKey(schema, entity, attr, ctx, { cascade: true, descr: [] });

  attr.foreignKey = true;
  attr.references = { entity: parent.id, attribute: parentAttr.name };
  if (attr.type !== parentAttr.type) {
    ctx.changes.push(`Changed type of ${entity.name}.${attr.name} from ${attr.type} to ${parentAttr.type} to match ${parent.name}.${parentAttr.name}.`);
    setAttributeType(schema, entity, attr, parentAttr.type, ctx);
  }
  descr.push(`now a foreign key referencing ${parent.name}.${parentAttr.name}`);

  const linked = schema.relationships.some(
    (r) => (r.source === parent.id && r.target === entity.id) || (r.cardinality === "N:M" && r.source === entity.id && r.target === parent.id)
  );
  if (!linked) {
    const id = freeRelationshipId(schema, `${parent.id}_${entity.id}`);
    const cardinality = attr.unique ? "1:1" : "1:N";
    schema.relationships.push({ id, source: parent.id, target: entity.id, name: "has", cardinality });
    ctx.changes.push(`Added ${cardinality} relationship '${id}' from ${parent.name} to ${entity.name} so the new foreign key is shown in the diagram.`);
  }
}

function modifyAttribute(schema, op, ctx) {
  const entity = resolveEntity(schema, op.entity);
  const attr = requireAttr(entity, op.attribute);
  if (!MODIFY_ATTRIBUTE_KEYS.some((k) => op[k] !== undefined)) {
    throw invalid(`modify_attribute needs at least one of: ${MODIFY_ATTRIBUTE_KEYS.join(", ")}.`);
  }
  if (op.foreignKey === false && op.references !== undefined) throw invalid("modify_attribute cannot set foreignKey=false together with 'references'.");

  const descr = [];
  if (op.type !== undefined) {
    const newType = normalizeType(op.type, ctx.notes);
    if (newType !== attr.type) {
      descr.push(`type ${attr.type} → ${newType}`);
      setAttributeType(schema, entity, attr, newType, ctx);
    }
  }
  if (op.primaryKey !== undefined && op.primaryKey !== attr.primaryKey) {
    attr.primaryKey = op.primaryKey;
    if (op.primaryKey) attr.nullable = false;
    descr.push(op.primaryKey ? "now part of the primary key" : "no longer part of the primary key");
  }
  if (op.nullable !== undefined && op.nullable !== attr.nullable) {
    descr.push(op.nullable ? "now nullable" : "now NOT NULL");
    attr.nullable = op.nullable;
  }
  if (op.unique !== undefined && op.unique !== attr.unique) {
    descr.push(op.unique ? "now unique" : "no longer unique");
    attr.unique = op.unique;
  }
  if (op.foreignKey === true || (op.references !== undefined && op.foreignKey !== false)) {
    setForeignKey(schema, entity, attr, op.references, ctx, op, descr);
  } else if (op.foreignKey === false && attr.foreignKey) {
    dropForeignKey(schema, entity, attr, ctx, { cascade: op.cascade === true, descr });
  }
  if (op.newName !== undefined && norm(op.newName) !== norm(attr.name)) {
    const newName = String(op.newName).trim();
    if (!SQL_IDENTIFIER_REGEX.test(newName)) throw invalid(`Attribute name '${op.newName}' is not a valid identifier.`);
    if (findAttr(entity, newName)) throw invalid(`Cannot rename: '${newName}' already exists in entity '${entity.id}'.`);
    for (const d of referencesTo(schema, entity.id, attr.name)) {
      d.attr.references.attribute = newName;
      ctx.changes.push(`Updated foreign key ${d.entity.name}.${d.attr.name} to reference the renamed column ${newName}.`);
    }
    descr.push(`renamed to ${newName}`);
    attr.name = newName;
  }
  if (descr.length === 0) throw invalid(`Attribute ${entity.id}.${attr.name} already has the requested properties; nothing to change.`);
  ctx.changes.push(`Modified ${entity.name}.${op.attribute}: ${descr.join(", ")}.`);
}

function removeAttribute(schema, op, ctx) {
  const entity = resolveEntity(schema, op.entity);
  const attr = requireAttr(entity, op.attribute);

  const refs = referencesTo(schema, entity.id, attr.name).filter((r) => r.attr !== attr);
  const ownRels = relationshipsRelyingOn(schema, entity, attr);

  if ((refs.length || ownRels.length) && !op.cascade) {
    const parts = [];
    if (refs.length) parts.push(`foreign keys that reference it: ${describeRefs(refs)}`);
    if (ownRels.length) parts.push(`relationships that rely on it: ${ownRels.map((r) => r.id).join(", ")}`);
    throw clarify(
      `Removing ${entity.name}.${attr.name} would also affect ${parts.join(" and ")}. Do you want those removed as well? ` +
        `If so, say so explicitly.`
    );
  }
  if (attr.primaryKey && entity.attributes.filter((a) => a.primaryKey).length === 1) {
    throw clarify(
      `${entity.name}.${attr.name} is the only primary-key column of ${entity.name}. ` +
        `Which column should become its primary key instead? (For example: "make <column> the primary key of ${entity.name}".)`
    );
  }
  for (const { entity: owner, attr: fk } of refs) {
    if (fk.primaryKey) {
      throw clarify(
        `${owner.name}.${fk.name} is part of ${owner.name}'s primary key and references ${entity.name}.${attr.name}. ` +
          `Please say how ${owner.name} should be redesigned.`
      );
    }
    owner.attributes = owner.attributes.filter((a) => a !== fk);
    ctx.changes.push(`Removed foreign key ${owner.name}.${fk.name} (it referenced ${entity.name}.${attr.name}).`);
  }
  schema.relationships = schema.relationships.filter((r) => !ownRels.includes(r));
  for (const r of ownRels) ctx.changes.push(`Removed relationship '${r.id}' (${r.source} ${r.cardinality} ${r.target}).`);

  entity.attributes = entity.attributes.filter((a) => a !== attr);
  ctx.changes.push(`Removed attribute ${entity.name}.${attr.name}.`);
}

function createForeignKey(schema, parent, child, ctx, { unique, mandatory, foreignKeyName }) {
  const pk = singlePk(parent);
  const selfRef = parent.id === child.id;
  const existing = child.attributes.find((a) => a.foreignKey && a.references?.entity === parent.id && norm(a.references.attribute) === norm(pk.name));
  if (existing) {
    if (unique && !existing.unique) existing.unique = true;
    if (!selfRef && mandatory !== undefined && existing.nullable === mandatory) {
      existing.nullable = !mandatory;
      ctx.changes.push(`Made ${child.name}.${existing.name} ${mandatory ? "NOT NULL" : "nullable"} to match the requested relationship.`);
    }
    return existing;
  }
  let name;
  if (foreignKeyName) {
    name = String(foreignKeyName).trim();
    if (!SQL_IDENTIFIER_REGEX.test(name)) throw invalid(`Foreign key name '${foreignKeyName}' is not a valid identifier (letters, digits, underscore).`);
    if (findAttr(child, name)) {
      throw invalid(`Cannot create foreign key '${name}': ${child.id} already has an attribute with that name. Choose another foreignKeyName, or use modify_attribute to turn the existing column into a foreign key.`);
    }
  } else {
    const base = selfRef ? `parent_${pk.name}` : findAttr(child, pk.name) ? `${parent.id}_${pk.name}` : pk.name;
    name = freeAttrName(child, base);
  }
  // Optional by default for an entity that already exists (it may already hold rows) and for self-references (the root
  // row has no parent); NOT NULL for a brand-new entity. An explicit `mandatory` from the user wins (except self-references).
  const nullable = selfRef ? true : mandatory !== undefined ? !mandatory : ctx.originalEntityIds.has(child.id);
  const fk = {
    name,
    type: pk.type,
    primaryKey: false,
    foreignKey: true,
    nullable,
    unique: !!unique,
    references: { entity: parent.id, attribute: pk.name },
  };
  child.attributes.push(fk);
  ctx.changes.push(`Added foreign key ${child.name}.${fk.name} (${fk.type}${fk.nullable ? "" : ", not null"}) referencing ${parent.name}.${pk.name}.`);
  return fk;
}

function addRelationship(schema, op, ctx) {
  const def = op.relationship;
  if (!def) throw invalid("add_relationship requires 'relationship'.");
  if (!SUPPORTED_CARDINALITIES.includes(def.cardinality)) throw invalid(`Cardinality '${def.cardinality}' must be one of ${SUPPORTED_CARDINALITIES.join(", ")}.`);
  const name = String(def.name ?? "").trim();
  if (!name) throw invalid("A relationship name is required.");
  const source = resolveEntity(schema, def.source, "source entity");
  const target = resolveEntity(schema, def.target, "target entity");

  const duplicate = schema.relationships.find(
    (r) =>
      r.cardinality === def.cardinality &&
      ((r.source === source.id && r.target === target.id) || (def.cardinality === "N:M" && r.source === target.id && r.target === source.id))
  );
  if (duplicate) {
    throw invalid(
      `A ${def.cardinality} relationship between '${source.id}' and '${target.id}' already exists ('${duplicate.id}'), so the requested link is already in the schema. Omit this operation (or use modify_relationship if its properties should change).`
    );
  }

  if (def.cardinality === "N:M") {
    // Existing associative entity linking both sides? Ask instead of silently creating a second one.
    const via = schema.entities.find(
      (e) =>
        e.id !== source.id &&
        e.id !== target.id &&
        (source.id === target.id
          ? e.attributes.filter((a) => a.foreignKey && a.references?.entity === source.id).length >= 2
          : e.attributes.some((a) => a.foreignKey && a.references?.entity === source.id) &&
            e.attributes.some((a) => a.foreignKey && a.references?.entity === target.id))
    );
    if (via) {
      throw clarify(
        `${source.name} and ${target.name} are already connected many-to-many through ${via.name}. ` +
          `Do you want an additional separate junction entity, or should ${via.name} be changed instead?`
      );
    }

    const baseId = def.id ? String(def.id).trim() : null;
    createJunction(schema, source, target, { relName: name, junctionName: def.junctionName, baseId, verb: "Added" }, ctx);
    return;
  }

  const fk = createForeignKey(schema, source, target, ctx, {
    unique: def.cardinality === "1:1",
    mandatory: typeof def.mandatory === "boolean" ? def.mandatory : undefined,
    foreignKeyName: def.foreignKeyName,
  });
  const baseId = def.id ? String(def.id).trim() : `${source.id}_${target.id}`;
  if (def.id && schema.relationships.some((r) => r.id === baseId)) throw invalid(`Relationship id '${baseId}' is already used.`);
  const id = freeRelationshipId(schema, baseId);
  schema.relationships.push({ id, source: source.id, target: target.id, name, cardinality: def.cardinality });
  ctx.changes.push(`Added ${def.cardinality} relationship '${name}' from ${source.name} to ${target.name} (via ${target.name}.${fk.name}).`);
}

function removeRelationship(schema, op, ctx) {
  if (!norm(op.relationshipId)) throw invalid("remove_relationship requires 'relationshipId'.");
  const rel = findRelationship(schema, op.relationshipId);

  const child = schema.entities.find((e) => e.id === rel.target);
  const parent = schema.entities.find((e) => e.id === rel.source);
  if (child && parent && rel.cardinality !== "N:M") {
    const othersShareFk = schema.relationships.some((r) => r !== rel && r.source === rel.source && r.target === rel.target);
    const fks = othersShareFk ? [] : child.attributes.filter((a) => a.foreignKey && a.references?.entity === parent.id);
    const pkFk = fks.find((a) => a.primaryKey);
    if (pkFk) {
      throw clarify(
        `The foreign key ${child.name}.${pkFk.name} behind '${rel.id}' is part of ${child.name}'s primary key, so removing the relationship would require redesigning ${child.name}. How should that be handled?`
      );
    }
    child.attributes = child.attributes.filter((a) => !fks.includes(a));
    for (const fk of fks) ctx.changes.push(`Removed foreign key ${child.name}.${fk.name} that implemented the relationship.`);
  }
  schema.relationships = schema.relationships.filter((r) => r !== rel);
  ctx.changes.push(`Removed relationship '${rel.id}' (${rel.source} ${rel.cardinality} ${rel.target}).`);
}

function modifyRelationship(schema, op, ctx) {
  if (!norm(op.relationshipId)) throw invalid("modify_relationship requires 'relationshipId'.");
  if (op.cardinality === undefined && op.relationshipName === undefined) {
    throw invalid("modify_relationship needs at least one of: cardinality, relationshipName.");
  }
  const rel = findRelationship(schema, op.relationshipId);
  const parent = schema.entities.find((e) => e.id === rel.source);
  const child = schema.entities.find((e) => e.id === rel.target);
  const changed = [];

  if (op.relationshipName !== undefined) {
    const newName = String(op.relationshipName).trim();
    if (!newName) throw invalid("The new relationship name cannot be empty.");
    if (newName !== rel.name) {
      changed.push(`name '${rel.name}' → '${newName}'`);
      rel.name = newName;
    }
  }

  if (op.cardinality !== undefined && op.cardinality !== rel.cardinality) {
    if (!SUPPORTED_CARDINALITIES.includes(op.cardinality)) throw invalid(`Cardinality '${op.cardinality}' must be one of ${SUPPORTED_CARDINALITIES.join(", ")}.`);
    if (op.cardinality === "N:M") {
      throw invalid(
        `modify_relationship cannot make '${rel.id}' many-to-many. Use remove_relationship for '${rel.id}' followed by add_relationship with cardinality N:M (the junction entity is created automatically).`
      );
    }
    if (!parent || !child) throw invalid(`Relationship '${rel.id}' has a missing endpoint entity.`);

    if (rel.cardinality === "N:M") {
      // A stored N:M relationship has no key columns yet: realise it as a direct foreign key on the target.
      createForeignKey(schema, parent, child, ctx, { unique: op.cardinality === "1:1" });
    } else {
      const fks = child.attributes.filter((a) => a.foreignKey && a.references?.entity === parent.id);
      if (fks.length === 0) throw invalid(`No foreign key in '${child.id}' references '${parent.id}', so '${rel.id}' cannot be changed to ${op.cardinality}.`);
      if (fks.length > 1) {
        throw clarify(
          `${child.name} has several foreign keys to ${parent.name} (${fks.map((f) => f.name).join(", ")}). Which one should the ${op.cardinality} relationship use?`
        );
      }
      const fk = fks[0];
      if (fk.primaryKey) {
        throw clarify(
          `${child.name}.${fk.name} is part of ${child.name}'s primary key, so changing '${rel.id}' to ${op.cardinality} would require redesigning ${child.name}. How should that be handled?`
        );
      }
      const wantUnique = op.cardinality === "1:1";
      if (!!fk.unique !== wantUnique) {
        fk.unique = wantUnique;
        ctx.changes.push(`${wantUnique ? "Made" : "Removed uniqueness on"} foreign key ${child.name}.${fk.name}${wantUnique ? " unique" : ""} to match ${op.cardinality}.`);
      }
    }
    changed.push(`cardinality ${rel.cardinality} → ${op.cardinality}`);
    rel.cardinality = op.cardinality;
  }

  if (changed.length === 0) throw invalid(`Relationship '${rel.id}' already has the requested properties; nothing to change.`);
  ctx.changes.push(`Modified relationship '${rel.id}': ${changed.join(", ")}.`);
}

function convertManyToMany(schema, op, ctx) {
  if (!norm(op.relationshipId)) throw invalid("convert_many_to_many requires 'relationshipId'.");
  const rel = findRelationship(schema, op.relationshipId);
  if (rel.cardinality !== "N:M") {
    throw invalid(`Relationship '${rel.id}' is ${rel.cardinality}, not N:M, so there is nothing to convert into an associative entity.`);
  }
  const source = resolveEntity(schema, rel.source, "source entity");
  const target = resolveEntity(schema, rel.target, "target entity");
  schema.relationships = schema.relationships.filter((r) => r !== rel);
  createJunction(schema, source, target, { relName: rel.name, junctionName: op.junctionName, baseId: rel.id, verb: "Converted" }, ctx);
}

/**
 * modify_primary_key REPLACES the entity's primary key with exactly the named columns.
 * Foreign keys elsewhere that referenced a column that stops being the key are re-pointed at the new (single-column) key
 * and take its type; if that is not possible (composite new key) the user is asked instead of guessing.
 */
function modifyPrimaryKey(schema, op, ctx) {
  const entity = resolveEntity(schema, op.entity);
  const newPks = [];
  for (const name of op.primaryKeyAttributes) {
    const a = requireAttr(entity, name);
    if (!newPks.includes(a)) newPks.push(a);
  }
  const oldPks = entity.attributes.filter((a) => a.primaryKey);
  if (oldPks.length === newPks.length && newPks.every((a) => oldPks.includes(a))) {
    throw invalid(`${entity.name} already has exactly this primary key (${newPks.map((a) => a.name).join(", ")}); nothing to change.`);
  }

  const dropped = oldPks.filter((a) => !newPks.includes(a));
  const dependents = dropped.flatMap((a) => referencesTo(schema, entity.id, a.name));
  if (dependents.length > 0 && newPks.length !== 1) {
    throw clarify(
      `${describeRefs(dependents)} currently reference(s) ${entity.name}'s primary key. A composite key cannot be referenced by a single foreign-key column, ` +
        `so please say how those should be handled (or choose a single column as the new primary key).`
    );
  }

  for (const a of dropped) a.primaryKey = false;
  for (const a of newPks) {
    if (!a.primaryKey) {
      a.primaryKey = true;
      if (a.nullable !== false) {
        a.nullable = false;
        ctx.changes.push(`Made ${entity.name}.${a.name} NOT NULL because it is now part of the primary key.`);
      }
    }
  }
  if (newPks.length === 1 && !newPks[0].unique) newPks[0].unique = true;

  if (newPks.length === 1) {
    const target = newPks[0];
    for (const d of dependents) {
      d.attr.references.attribute = target.name;
      if (d.attr.type !== target.type) {
        ctx.changes.push(`Changed type of ${d.entity.name}.${d.attr.name} from ${d.attr.type} to ${target.type} to match the new key ${entity.name}.${target.name}.`);
        d.attr.type = target.type;
      }
      ctx.changes.push(`Re-pointed foreign key ${d.entity.name}.${d.attr.name} to the new primary key ${entity.name}.${target.name}.`);
    }
  }
  ctx.changes.push(
    `Changed the primary key of ${entity.name} from (${oldPks.map((a) => a.name).join(", ") || "none"}) to (${newPks.map((a) => a.name).join(", ")}).`
  );
}

const HANDLERS = {
  add_entity: addEntity,
  remove_entity: removeEntity,
  rename_entity: renameEntity,
  add_attribute: addAttribute,
  modify_attribute: modifyAttribute,
  remove_attribute: removeAttribute,
  add_relationship: addRelationship,
  modify_relationship: modifyRelationship,
  remove_relationship: removeRelationship,
  convert_many_to_many: convertManyToMany,
  modify_primary_key: modifyPrimaryKey,
};

/** Re-point FK `references.entity` values written as entity names onto canonical entity ids (model tolerance). */
function canonicalizeReferences(schema) {
  for (const e of schema.entities) {
    for (const a of e.attributes) {
      if (a.references) {
        const target = schema.entities.find((x) => norm(x.id) === norm(a.references.entity)) ?? schema.entities.find((x) => norm(x.name) === norm(a.references.entity));
        if (target) a.references.entity = target.id;
        const col = target && findAttr(target, a.references.attribute);
        if (col) a.references.attribute = col.name;
      }
    }
  }
}

export function applyOperations(original, operations, { reqId = 'stateless' } = {}) {
  const schema = structuredClone(original);
  const ctx = { changes: [], notes: new Set(), originalEntityIds: new Set(original.entities.map((e) => e.id)), reqId };

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    try {
      const handler = HANDLERS[op.op];
      if (!handler) throw invalid(`Unknown operation '${op.op}'.`);
      // The executor reads exactly the fields listed in operationContract.js (the normalizer writes the same ones).
      const missing = missingRequiredFields(op);
      if (missing.length) throw invalid(`${op.op} requires ${missing.map((f) => `'${f}'`).join(", ")}.`);
      handler(schema, op, ctx);
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      console.log(`[Refine:Execute] [${reqId}] Operation ${i + 1}/${operations.length} (${op.op}) rejected (${err.kind}): ${err.message}`);
      if (err.kind === "clarify") return { ok: false, kind: "clarify", question: err.message };
      return { ok: false, kind: "invalid", issues: [`Operation ${i + 1} (${op.op}) failed: ${err.message}`] };
    }
  }
  canonicalizeReferences(schema);
  return { ok: true, schema, changes: [...ctx.changes, ...ctx.notes] };
}
