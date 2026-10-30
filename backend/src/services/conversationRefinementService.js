import { Conversation } from "../models/conversation.js";
import { isConnected } from "../db.js";
import { createAppError } from "./geminiService.js";
import { refinementService } from "./refinementService.js";

/**
 * Refinement of a schema that belongs to a saved conversation.
 *
 * Source of truth: the `schema` / `schemaVersion` stored on the Conversation document. A schema sent by the client is
 * never used for a conversation, and message history (which contains earlier schema snapshots) is never used to derive
 * the current schema.
 *
 * Consistency: the new schema, the bumped version and the two new messages are written by ONE atomic
 * `findOneAndUpdate` that is conditional on the version that was read before the (slow) LLM call. If anything else
 * changed the conversation in the meantime, nothing is written and a 409 is returned. A failed or rejected refinement
 * never touches `schema` or `schemaVersion`.
 */

const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;
export const isValidConversationId = (id) => typeof id === "string" && OBJECT_ID_REGEX.test(id);

const versionConflict = (currentVersion) =>
  createAppError(
    "SCHEMA_VERSION_CONFLICT",
    `This conversation's schema changed since you last loaded it (current version ${currentVersion}). ` +
      "Reload the conversation to continue from the latest schema, then repeat your instruction.",
    409,
    { currentVersion }
  );

export class ConversationRefinementService {
  /** Dependencies are injectable so tests never need a real MongoDB or LLM. */
  constructor({ model = Conversation, refiner = refinementService, connected = isConnected } = {}) {
    this.model = model;
    this.refiner = refiner;
    this.connected = connected;
  }

  async loadCurrent(conversationId) {
    try {
      return await this.model.findById(conversationId).select("schema schemaVersion").lean();
    } catch (err) {
      console.warn("[SchemAI] Failed to load conversation for refinement:", err?.message);
      throw createAppError("PERSISTENCE_FAILED", "The conversation could not be loaded. Please try again.", 503);
    }
  }

  /**
   * @returns {Promise<object>} the refinement result (status "applied" | "needs_clarification") plus
   *   `conversationId`, `schemaVersion` (the version the client must now hold) and `persisted`.
   */
  async refine({ conversationId, instruction, expectedVersion, model, reqId = 'stateless' }) {
    console.log(`[Refine:Request] [${reqId}] ConversationRefinementService.refine starting. Conversation: ${conversationId}, expectedVersion: ${expectedVersion}`);
    if (!isValidConversationId(conversationId)) {
      throw createAppError("INVALID_CONVERSATION_ID", "The conversation id is not valid.", 400);
    }
    if (!this.connected()) {
      throw createAppError(
        "DATABASE_UNAVAILABLE",
        "MongoDB is not connected, so this saved conversation cannot be refined right now.",
        503
      );
    }

    const conv = await this.loadCurrent(conversationId);
    if (!conv) throw createAppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
    if (!conv.schema || typeof conv.schema !== "object") {
      throw createAppError("CONVERSATION_HAS_NO_SCHEMA", "This conversation has no saved schema to refine.", 422);
    }

    // Legacy documents may lack schemaVersion; the model default is 1.
    const storedVersion = Number.isInteger(conv.schemaVersion) ? conv.schemaVersion : 1;
    if (expectedVersion !== undefined && expectedVersion !== storedVersion) throw versionConflict(storedVersion);

    // May throw (invalid base schema, unsupported, failed validation, provider errors): nothing has been written yet.
    const result = await this.refiner.refineSchema({ schema: conv.schema, instruction, model, reqId });

    if (result.status !== "applied") {
      console.log(`[Refine:Commit] [${reqId}] Non-applied status (${result.status}); recording clarification, original schema preserved.`);
      await this.recordClarification(conversationId, instruction, result.message, storedVersion);
      return { ...result, conversationId, schemaVersion: storedVersion, persisted: true };
    }

    const nextVersion = storedVersion + 1;
    const now = Date.now();
    let updated;
    console.log(`[Refine:Commit] [${reqId}] Committing updated schema version ${nextVersion} to conversation ${conversationId}.`);
    try {
      updated = await this.model
        .findOneAndUpdate(
          // `null` also matches a legacy document that has no schemaVersion field.
          { _id: conversationId, schemaVersion: Number.isInteger(conv.schemaVersion) ? storedVersion : null },
          {
            $set: { schema: result.schema, schemaVersion: nextVersion },
            $push: {
              messages: {
                $each: [
                  { role: "user", content: instruction, operation: "refine", schemaVersion: storedVersion, createdAt: new Date(now) },
                  // Same message format as initial generation: the assistant message carries the accepted schema snapshot.
                  { role: "assistant", content: JSON.stringify(result.schema), operation: "refine", schemaVersion: nextVersion, createdAt: new Date(now + 1) },
                ],
              },
            },
          },
          { returnDocument: "after", projection: { schemaVersion: 1 } }
        )
        .lean();
    } catch (err) {
      console.warn("[SchemAI] Failed to save refined schema:", err?.message);
      console.log(`[Refine:Commit] [${reqId}] Failed to commit schema to DB. Original schema preserved.`);
      throw createAppError(
        "PERSISTENCE_FAILED",
        "The change was valid but could not be saved, so your schema was not changed. Please try again.",
        503
      );
    }

    if (!updated) {
      console.log(`[Refine:Commit] [${reqId}] Concurrent conflict detected on commit for conversation ${conversationId}. Original schema preserved.`);
      // Someone else committed (or the conversation vanished) while the model was working.
      const latest = await this.loadCurrent(conversationId);
      if (!latest) throw createAppError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
      throw versionConflict(Number.isInteger(latest.schemaVersion) ? latest.schemaVersion : 1);
    }

    console.log(`[Refine:Commit] [${reqId}] Successfully committed schema version ${nextVersion} to conversation ${conversationId}.`);
    return { ...result, conversationId, schemaVersion: nextVersion, persisted: true };
  }

  /** History only: a clarification does not change the schema or its version, so this is best-effort. */
  async recordClarification(conversationId, instruction, question, version) {
    try {
      const now = Date.now();
      await this.model.updateOne(
        { _id: conversationId },
        {
          $push: {
            messages: {
              $each: [
                { role: "user", content: instruction, operation: "refine", schemaVersion: version, createdAt: new Date(now) },
                { role: "assistant", content: question, operation: "clarification", schemaVersion: version, createdAt: new Date(now + 1) },
              ],
            },
          },
        }
      );
    } catch (err) {
      console.warn("[SchemAI] Failed to record clarification message:", err?.message);
    }
  }
}

export const conversationRefinementService = new ConversationRefinementService();
