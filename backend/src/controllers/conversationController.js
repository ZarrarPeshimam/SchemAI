import { Conversation } from "../models/conversation.js";
import { isConnected } from "../db.js";
import { isValidConversationId } from "../services/conversationRefinementService.js";
import { addMessageRequestSchema } from "../validators/schemaValidator.js";

const invalidIdResponse = (res) =>
  res.status(400).json({
    success: false,
    error: { code: "INVALID_CONVERSATION_ID", message: "The conversation id is not valid." },
  });

// List all conversations (summary)
export const listConversations = async (req, res, next) => {
  if (!isConnected()) {
    return res.status(200).json({ success: true, data: [] });
  }
  try {
    const conversations = await Conversation.find()
      .select('_id title createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();
    return res.status(200).json({ success: true, data: conversations });
  } catch (error) {
    next(error);
  }
};

// Get a single conversation with messages
export const getConversation = async (req, res, next) => {
  if (!isConnected()) {
    return res.status(503).json({
      success: false,
      error: { code: 'DATABASE_UNAVAILABLE', message: 'MongoDB is not connected.' },
    });
  }
  try {
    const { id } = req.params;
    if (!isValidConversationId(id)) return invalidIdResponse(res);
    const conversation = await Conversation.findById(id).lean();
    if (!conversation) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    }
    return res.status(200).json({ success: true, data: conversation });
  } catch (error) {
    next(error);
  }
};

// Append a message to a conversation's history.
// This endpoint never changes the conversation's schema or schemaVersion: the schema is only updated by a validated,
// version-checked refinement (POST /schema/refine) or by generation. Accepting a client-supplied schema here would let a
// stale or unvalidated schema overwrite the latest valid one.
export const addMessage = async (req, res, next) => {
  if (!isConnected()) {
    return res.status(503).json({
      success: false,
      error: { code: 'DATABASE_UNAVAILABLE', message: 'MongoDB is not connected.' },
    });
  }
  try {
    const { id } = req.params;
    if (!isValidConversationId(id)) return invalidIdResponse(res);

    if (req.body && typeof req.body === 'object' && 'schema' in req.body) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'SCHEMA_UPDATE_NOT_ALLOWED',
          message: "The conversation schema cannot be changed through this endpoint. Use POST /api/schema/refine.",
        },
      });
    }
    const parsed = addMessageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MALFORMED_REQUEST',
          message: parsed.error.issues[0]?.message || 'Invalid message payload.',
          details: parsed.error.issues,
        },
      });
    }

    // Atomic append: no read-modify-write, so it cannot race with (or clobber) a concurrent schema update.
    const result = await Conversation.updateOne({ _id: id }, { $push: { messages: parsed.data } });
    if (!result.matchedCount) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    }
    return res.status(200).json({ success: true, data: { conversationId: id } });
  } catch (error) {
    next(error);
  }
};
