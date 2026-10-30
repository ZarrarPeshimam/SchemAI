import { z } from "zod";
import { SUPPORTED_DATA_TYPES, SUPPORTED_CARDINALITIES } from "../../validators/schemaValidator.js";

/**
 * Change-operation contract between the LLM (via LangChain structured output) and the deterministic applier.
 *
 * The model-facing schema is intentionally FLAT (optional fields rather than a discriminated union) because Gemini's
 * structured-output support for `anyOf`/unions is limited. Per-operation required fields are enforced afterwards by
 * applyOperations.js, so a model that omits a field produces a precise, repairable error instead of a silent guess.
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
];

export const MAX_OPERATIONS = 25;

// A described string (not an enum) so that e.g. "VARCHAR(255)" is accepted and normalised to VARCHAR by the applier;
// genuinely unsupported types are rejected there with a precise, repairable message.
const DATA_TYPE_HELP = `SQL data type, one of: ${SUPPORTED_DATA_TYPES.join(", ")} (length/precision parameters are not stored)`;

const attributeDefinition = z.object({
  name: z.string().describe("lowercase snake_case column name"),
  type: z.string().describe(DATA_TYPE_HELP),
  primaryKey: z.boolean().optional(),
  foreignKey: z.boolean().optional(),
  nullable: z.boolean().optional(),
  unique: z.boolean().optional(),
  references: z
    .object({
      entity: z.string().describe("id of the referenced entity"),
      attribute: z.string().describe("referenced column name"),
    })
    .optional(),
});

const entityDefinition = z.object({
  id: z.string().describe("unique lowercase snake_case id, e.g. 'department'"),
  name: z.string().describe("singular PascalCase name, e.g. 'Department'"),
  description: z.string().optional(),
  attributes: z.array(attributeDefinition).describe("columns; include a primary key"),
});

const relationshipDefinition = z.object({
  id: z.string().optional().describe("optional unique id; derived from source and target when omitted"),
  source: z.string().describe("id of the parent entity (the '1' side, or either side for N:M)"),
  target: z.string().describe("id of the child entity (the 'N' side, or either side for N:M)"),
  name: z.string().describe("short verb phrase, e.g. 'employs'"),
  cardinality: z.enum(SUPPORTED_CARDINALITIES),
  junctionName: z.string().optional().describe("N:M only: PascalCase name for the associative entity"),
});

export const operationSchema = z.object({
  op: z.enum(OPERATION_TYPES),
  entity: z.string().optional().describe("existing entity id (remove_entity, rename_entity, *_attribute operations)"),
  attribute: z.string().optional().describe("existing attribute name (modify_attribute, remove_attribute)"),
  attributeDefinition: attributeDefinition.optional().describe("add_attribute: the new column. Required for add_attribute (do not use top-level newName or type)"),
  newName: z.string().optional().describe("modify_attribute: new column name; rename_entity: new PascalCase entity name (do not use for add_attribute)"),
  type: z.string().optional().describe(`modify_attribute: new data type (do not use for add_attribute; put inside attributeDefinition). ${DATA_TYPE_HELP}`),
  nullable: z.boolean().optional().describe("modify_attribute: new nullability"),
  unique: z.boolean().optional().describe("modify_attribute: new uniqueness"),
  primaryKey: z.boolean().optional().describe("modify_attribute: make the column part of (true) / remove it from (false) the primary key"),
  foreignKey: z.boolean().optional().describe("modify_attribute: make the column a foreign key (true, needs references) / a plain column (false)"),
  references: z
    .object({
      entity: z.string().describe("id of the referenced entity"),
      attribute: z.string().describe("referenced column name (use the entity's primary key when unspecified)"),
    })
    .optional()
    .describe("modify_attribute: the foreign-key target, used together with foreignKey=true"),
  entityDefinition: entityDefinition.optional().describe("add_entity: the new entity"),
  relationship: relationshipDefinition.optional().describe("add_relationship: the new relationship"),
  relationshipId: z.string().optional().describe("modify_relationship / remove_relationship / convert_many_to_many: id of an existing relationship"),
  cardinality: z.enum(SUPPORTED_CARDINALITIES).optional().describe("modify_relationship: the new cardinality (1:1 or 1:N; N:M is not allowed here)"),
  relationshipName: z.string().optional().describe("modify_relationship: the new relationship name"),
  junctionName: z.string().optional().describe("convert_many_to_many: PascalCase name of the associative entity to create"),
  cascade: z
    .boolean()
    .optional()
    .describe("true ONLY if the user explicitly asked to also remove dependent relationships / foreign keys"),
}).superRefine((obj, ctx) => {
  if (obj.op === "add_attribute") {
    if (!obj.attributeDefinition) {
      ctx.addIssue({
        code: "custom",
        message:
          "add_attribute requires attributeDefinition (an object with 'name' and 'type'); top-level newName/type are only valid for modify_attribute",
      });
    }
  }
  if (obj.op === "add_entity" && !obj.entityDefinition) {
    ctx.addIssue({ code: "custom", message: "add_entity requires entityDefinition" });
  }
  if (obj.op === "add_relationship" && !obj.relationship) {
    ctx.addIssue({ code: "custom", message: "add_relationship requires relationship" });
  }
});

/** What the model must return. `outcome` lets it ask for clarification or decline instead of guessing. */
export const modelResponseSchema = z.object({
  outcome: z.enum(["operations", "needs_clarification", "unsupported"]),
  message: z
    .string()
    .describe("operations: one-sentence summary; needs_clarification: the question to ask; unsupported: the reason"),
  operations: z.array(operationSchema).optional(),
});

/**
 * Safely normalizes alternate LLM operation representations into the canonical schema.
 * Only normalizes when the meaning is unambiguous.
 * If the model omitted required fields (like name or type for add_attribute), they are NOT invented,
 * ensuring the parser rejects the operation and triggers the repair loop.
 */
export function normalizeOperations(rawOperations) {
  if (!Array.isArray(rawOperations)) return rawOperations;
  return rawOperations.map((rawOp) => {
    if (!rawOp || typeof rawOp !== "object") return rawOp;
    const op = { ...rawOp };
    if (op.op === "add_attribute") {
      const existingDef = op.attributeDefinition && typeof op.attributeDefinition === "object" ? { ...op.attributeDefinition } : null;
      // In add_attribute, models sometimes emit top-level 'newName', 'name', or 'attribute' instead of nesting in attributeDefinition.
      // Note: newName is NOT treated as an attribute name universally; in rename_entity, it is the entity name.
      const candidateName =
        (typeof existingDef?.name === "string" && existingDef.name.trim()) ||
        (typeof op.newName === "string" && op.newName.trim()) ||
        (typeof op.name === "string" && op.name.trim()) ||
        (typeof op.attribute === "string" && op.attribute.trim()) ||
        null;
      const candidateType =
        (typeof existingDef?.type === "string" && existingDef.type.trim()) ||
        (typeof op.type === "string" && op.type.trim()) ||
        null;

      // Only normalize when both name and type are unambiguously present.
      // If either is missing, do not invent them; leave op unnormalized so parser rejects and repair is triggered.
      if (candidateName && candidateType) {
        const attrDef = {
          name: candidateName,
          type: candidateType,
        };
        // Canonical (nested) values win; stray top-level values only fill gaps. Nothing is invented.
        const pick = (key) => (typeof existingDef?.[key] === "boolean" ? existingDef[key] : typeof op[key] === "boolean" ? op[key] : undefined);
        for (const key of ["nullable", "unique", "primaryKey", "foreignKey"]) {
          const value = pick(key);
          if (value !== undefined) attrDef[key] = value;
        }

        const references =
          existingDef?.references && typeof existingDef.references === "object"
            ? existingDef.references
            : op.references && typeof op.references === "object"
              ? op.references
              : undefined;
        if (references !== undefined) attrDef.references = references;

        op.attributeDefinition = attrDef;
        // Strip top-level fields that belonged to the alternate representation to conform to the canonical contract
        delete op.newName;
        delete op.name;
        delete op.type;
        delete op.nullable;
        delete op.unique;
        delete op.primaryKey;
        delete op.foreignKey;
        delete op.references;
        delete op.attribute;
      }
    }
    return op;
  });
}

/** Strict re-parse of the (null-stripped) model output. Returns { ok, data } | { ok:false, issues }. */
export function parseModelResponse(raw) {
  let normalizedRaw = raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.operations)) {
    normalizedRaw = { ...raw, operations: normalizeOperations(raw.operations) };
  }
  const result = modelResponseSchema.safeParse(normalizedRaw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "response"}: ${i.message}`),
    };
  }
  const data = result.data;
  if (data.operations && data.operations.length > MAX_OPERATIONS) {
    return { ok: false, issues: [`Too many operations (${data.operations.length}); at most ${MAX_OPERATIONS} are allowed.`] };
  }
  return { ok: true, data: { ...data, operations: data.operations ?? [] } };
}
