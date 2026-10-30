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

const issueText = (i) => `${i.code}: ${i.message}${i.path ? ` (at ${i.path})` : ""}`;
const warningKey = (w) => [w.code, w.entity ?? "", w.attribute ?? "", w.relationship ?? ""].join("|");

export function validateCandidate(original, candidate) {
  const validation = validateSchemaSemantics(candidate);
  if (!validation.valid) {
    return { valid: false, issues: validation.errors.map(issueText), validation };
  }

  const baseline = new Set(validateSchemaSemantics(original).warnings.map(warningKey));
  const newWarnings = validation.warnings.filter((w) => !baseline.has(warningKey(w)));
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
