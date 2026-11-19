import { canonicalSchemaDef, validateSchemaSemantics } from "../../validators/schemaValidator.js";
import { generateSql } from "../sqlGeneratorService.js";

/**
 * Deterministic gate for refinement candidates. The LLM can never bypass this.
 *
 * A candidate is accepted only if:
 *  1. the existing Zod + semantic validators report no errors,
 *  2. it introduces no NEW warnings (e.g. missing foreign key for a relationship, FK type mismatch) compared with the
 *     original schema (warnings that already existed do not block unrelated edits),
 *  3. the existing SQL generator can still produce DDL for it.
 */

/**
 * Extra structural checks beyond validateSchemaSemantics, reported as warnings so the same "only NEW problems block"
 * baseline applies (a pre-existing quirk never blocks an unrelated edit):
 *  - ASSOCIATIVE_ENTITY_MISSING_RELATIONSHIP: an associative entity (composite primary key made only of foreign keys)
 *    must be linked to each parent it references by a relationship.
 *  - ONE_TO_ONE_MISSING_FOREIGN_KEY: a 1:1 relationship needs a foreign key on one side referencing the other.
 *  - FOREIGN_KEY_TARGET_NOT_KEY: a foreign key must reference a primary-key or unique column.
 */
export function consistencyWarnings(schema) {
  const warnings = [];
  const byId = new Map(schema.entities.map((e) => [e.id, e]));
  const refsTo = (from, toId) => from.attributes.filter((a) => a.foreignKey && a.references?.entity === toId);

  for (const e of schema.entities) {
    const pks = e.attributes.filter((a) => a.primaryKey);
    if (pks.length >= 2 && pks.every((a) => a.foreignKey && a.references)) {
      for (const parentId of new Set(pks.map((a) => a.references.entity))) {
        const linked = schema.relationships.some((r) => r.source === parentId && r.target === e.id);
        if (!linked) {
          warnings.push({
            code: "ASSOCIATIVE_ENTITY_MISSING_RELATIONSHIP",
            message: `Associative entity '${e.id}' has a foreign key to '${parentId}' but no relationship from '${parentId}' to '${e.id}'`,
            entity: e.id,
          });
        }
      }
    }
    for (const a of e.attributes) {
      if (!(a.foreignKey && a.references)) continue;
      const parent = byId.get(a.references.entity);
      const col = parent?.attributes.find((x) => x.name.toLowerCase() === a.references.attribute.toLowerCase());
      if (col && !col.primaryKey && !col.unique) {
        warnings.push({
          code: "FOREIGN_KEY_TARGET_NOT_KEY",
          message: `Foreign key '${e.id}.${a.name}' references '${parent.id}.${col.name}', which is neither a primary key nor unique`,
          entity: e.id,
          attribute: a.name,
        });
      }
    }
  }
  for (const r of schema.relationships) {
    if (r.cardinality !== "1:1") continue;
    const s = byId.get(r.source);
    const t = byId.get(r.target);
    if (s && t && refsTo(t, s.id).length === 0 && refsTo(s, t.id).length === 0) {
      warnings.push({
        code: "ONE_TO_ONE_MISSING_FOREIGN_KEY",
        message: `1:1 relationship '${r.id}' has no foreign key between '${r.source}' and '${r.target}'`,
        relationship: r.id,
      });
    }
  }
  return warnings;
}

const issueText = (i) => `${i.code}: ${i.message}${i.path ? ` (at ${i.path})` : ""}`;
const warningKey = (w) => [w.code, w.entity ?? "", w.attribute ?? "", w.relationship ?? ""].join("|");

/** The original may be an unnormalised stored schema; never let a quirk in it break the comparison. */
function safeConsistency(schema) {
  try {
    return consistencyWarnings(schema);
  } catch {
    return [];
  }
}

export function validateCandidate(original, candidate) {
  const validation = validateSchemaSemantics(candidate);
  if (!validation.valid) {
    return { valid: false, issues: validation.errors.map(issueText), validation };
  }

  const baseline = new Set([...validateSchemaSemantics(original).warnings, ...safeConsistency(original)].map(warningKey));
  const newWarnings = [...validation.warnings, ...consistencyWarnings(candidate)].filter((w) => !baseline.has(warningKey(w)));
  if (newWarnings.length > 0) {
    return { valid: false, issues: newWarnings.map(issueText), validation };
  }

  let normalized;
  try {
    normalized = canonicalSchemaDef.parse(candidate);
    generateSql(normalized, "postgresql");
  } catch (err) {
    return { valid: false, issues: [`SQL_GENERATION_FAILED: ${String(err?.message ?? err).slice(0, 200)}`], validation };
  }

  return { valid: true, issues: [], validation, schema: normalized };
}
