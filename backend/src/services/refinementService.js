import { canonicalSchemaDef, validateSchemaSemantics } from "../validators/schemaValidator.js";
import { createAppError } from "./geminiService.js";
import { RefinementChain } from "./refinement/refinementChain.js";
import { applyOperations } from "./refinement/applyOperations.js";
import { validateCandidate } from "./refinement/refinementValidator.js";

/** Repair attempts allowed after the initial proposal (so at most 3 model calls per request). */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Orchestrates: LangChain/Gemini proposal -> deterministic apply on a fresh copy -> deterministic validation,
 * with bounded validation-feedback repair. The original schema is never mutated and an invalid candidate is never
 * returned: on any failure the caller keeps its original schema.
 */
export class RefinementService {
  constructor(chain = new RefinementChain()) {
    this.chain = chain;
  }

  /** `model`: request-scoped canonical model id (validated by modelCatalogService.resolveModel); used for EVERY call below, including repairs. */
  async refineSchema({ schema, instruction, model, reqId = 'stateless' }) {
    console.log(`[Refine:Request] [${reqId}] RefinementService.refineSchema started. model: ${model}, instruction: "${instruction.slice(0, 80)}"`);
    const baseValidation = validateSchemaSemantics(schema);
    if (!baseValidation.valid) {
      console.log(`[Refine:Validate] [${reqId}] Base schema failed semantic validation.`);
      throw createAppError(
        "INVALID_BASE_SCHEMA",
        "The current schema is not valid, so it cannot be refined. Fix or regenerate it first.",
        422,
        { validation: baseValidation }
      );
    }
    // Normalised, detached copy; `original` is never modified below (applyOperations works on a clone each attempt).
    const original = canonicalSchemaDef.parse(structuredClone(schema));

    let previous = null;
    let issues = [];
    let lastFailure = "invalid";

    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        console.log(`[Refine:Repair] [${reqId}] Initiating repair attempt ${attempt}/${MAX_REPAIR_ATTEMPTS}. Supplying issues: ${JSON.stringify(issues)}`);
      }
      const proposal = await this.chain.propose({ schema: original, instruction, previous, issues, model, reqId, attempt });

      if (attempt > 0) {
        console.log(`[Refine:Repair] [${reqId}] Repair attempt ${attempt} response received: ok=${proposal.ok}, outcome=${proposal.response?.outcome}, repairedOperationsCount=${proposal.response?.operations?.length ?? 0}`);
      }

      if (!proposal.ok) {
        lastFailure = "malformed";
        // Keep showing the model its own malformed proposal when we have it (the first one, as before).
        previous = previous ?? (proposal.raw && typeof proposal.raw === "object" ? proposal.raw : { note: "unreadable output" });
        issues = proposal.issues;
        console.log(`[Refine:Validate] [${reqId}] Attempt ${attempt} proposal not ok (malformed): ${JSON.stringify(proposal.issues)}`);
        continue;
      }

      const { outcome, message, operations } = proposal.response;
      if (outcome === "needs_clarification") {
        console.log(`[Refine:Commit] [${reqId}] Outcome is needs_clarification. Original schema preserved.`);
        return { status: "needs_clarification", message: message.trim() || "Could you clarify what you want to change?" };
      }
      if (outcome === "unsupported") {
        console.log(`[Refine:Commit] [${reqId}] Outcome is unsupported. Original schema preserved.`);
        throw createAppError("REFINEMENT_UNSUPPORTED", message.trim() || "That change is not supported.", 422);
      }
      if (operations.length === 0) {
        lastFailure = "invalid";
        previous = proposal.response;
        issues = ["The proposal contained no operations. Return operations, or use needs_clarification / unsupported."];
        console.log(`[Refine:Validate] [${reqId}] Attempt ${attempt} proposal contained 0 operations.`);
        continue;
      }

      const applied = applyOperations(original, operations, { reqId });
      if (!applied.ok) {
        if (applied.kind === "clarify") {
          console.log(`[Refine:Commit] [${reqId}] applyOperations requested clarification. Original schema preserved.`);
          return { status: "needs_clarification", message: applied.question };
        }
        lastFailure = "invalid";
        previous = proposal.response;
        issues = applied.issues;
        console.log(`[Refine:Validate] [${reqId}] Attempt ${attempt} applyOperations failed. Issues: ${JSON.stringify(applied.issues)}`);
        continue;
      }

      const check = validateCandidate(original, applied.schema);
      if (!check.valid) {
        lastFailure = "invalid";
        previous = proposal.response;
        issues = check.issues;
        console.log(`[Refine:Validate] [${reqId}] Attempt ${attempt} validateCandidate failed. Issues: ${JSON.stringify(check.issues)}`);
        continue;
      }

      console.log(`[Refine:Commit] [${reqId}] Candidate schema passed all validation checks on attempt ${attempt}. Committing result.`);
      return {
        status: "applied",
        schema: check.schema,
        validation: check.validation,
        summary: { message: message.trim(), changes: applied.changes },
        operations,
        repairAttempts: attempt,
      };
    }

    console.log(`[Refine:Commit] [${reqId}] All ${MAX_REPAIR_ATTEMPTS} repair attempts exhausted. Refinement failed (${lastFailure}). Original schema was preserved.`);
    if (lastFailure === "malformed") {
      throw createAppError(
        "MALFORMED_LLM_OUTPUT",
        "The AI returned a response that could not be read as a change proposal. Your schema was not changed. Please try rephrasing the instruction.",
        502
      );
    }
    throw createAppError(
      "REFINEMENT_FAILED",
      "The requested change could not be applied without breaking schema validation, even after automatic correction. Your schema was not changed.",
      422,
      { details: issues.slice(0, 10) }
    );
  }
}

export const refinementService = new RefinementService();
