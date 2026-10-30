import { schemaService } from "../services/schemaService.js";
import { conversationRefinementService } from "../services/conversationRefinementService.js";
import { Conversation } from "../models/conversation.js";
import { isConnected } from "../db.js";
import { modelCatalogService } from "../services/modelCatalogService.js";
import {
  validateRequestSchema,
  sqlRequestSchema,
  refineRequestSchema,
  generateRequestSchema,
} from "../validators/schemaValidator.js";

export const getHealth = (req, res) => {
  return res.status(200).json({
    success: true,
    message: "SchemAI backend is running",
  });
};

export const getSchema = (req, res) => {
  const data = schemaService.getMockSchema();
  return res.status(200).json({
    success: true,
    data,
  });
};

export const validateSchema = (req, res, next) => {
  try {
    const parseResult = validateRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MALFORMED_REQUEST",
          message: "Invalid request payload. 'schema' object is required.",
          details: parseResult.error.issues,
        },
      });
    }

    const validationResult = schemaService.validateSchema(req.body.schema);
    return res.status(200).json({
      success: true,
      data: validationResult,
    });
  } catch (error) {
    next(error);
  }
};

export const generateSql = (req, res, next) => {
  try {
    const parseResult = sqlRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MALFORMED_REQUEST",
          message: "Invalid request payload for SQL generation.",
          details: parseResult.error.issues,
        },
      });
    }

    const { schema, dialect = "postgresql" } = parseResult.data;
    const result = schemaService.generateSql(schema, dialect);

    return res.status(200).json({
      success: true,
      dialect: result.dialect,
      sql: result.sql,
    });
  } catch (error) {
    next(error);
  }
};

export const refineSchema = async (req, res, next) => {
  try {
    const parseResult = refineRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MALFORMED_REQUEST",
          message:
            parseResult.error.issues[0]?.message ||
            "Invalid request payload. 'schema' object and 'instruction' string are required.",
          details: parseResult.error.issues,
        },
      });
    }

    const { schema, instruction, conversationId, schemaVersion } = parseResult.data;

    // Request-scoped model: validated against the current compatible-model list BEFORE any provider call or database
    // work, then passed explicitly down to every Gemini call (including repair attempts) of this request.
    const model = await modelCatalogService.resolveModel(parseResult.data.model);

    const reqId = `refine-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    console.log(`[Refine:Request] [${reqId}] Refinement started. Mode: ${conversationId ? 'saved_conversation' : 'stateless'}, conversationId: ${conversationId || 'none'}, schemaVersion: ${schemaVersion ?? 'none'}, instruction: "${instruction.slice(0, 80)}", model: ${model}`);

    let data;
    if (conversationId) {
      // Saved conversation: the stored schema is authoritative (any `schema` in the body is ignored), the result is
      // committed atomically with a version check, and a failed refinement leaves the stored schema untouched.
      data = await conversationRefinementService.refine({
        conversationId,
        instruction,
        expectedVersion: schemaVersion,
        model,
        reqId,
      });
    } else {
      // Stateless mode (e.g. the sample schema, or generation that was not persisted): nothing is saved.
      const result = await schemaService.refineSchema({ schema, instruction, model, reqId });
      data = { ...result, conversationId: null, schemaVersion: null, persisted: false };
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const generateSchema = async (req, res, next) => {
  try {
    const parseResult = generateRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MALFORMED_REQUEST",
          message:
            parseResult.error.issues[0]?.message ||
            "Invalid request payload. 'requirement' string is required.",
          details: parseResult.error.issues,
        },
      });
    }

    const requirementText = parseResult.data.requirement || parseResult.data.requirements;
    const model = await modelCatalogService.resolveModel(parseResult.data.model);
    const result = await schemaService.generateSchema({ requirement: requirementText, model });

    // Persist conversation if MongoDB is connected
    let conversationId = null;
    if (isConnected()) {
      try {
        const title = requirementText.split('\n')[0].slice(0, 50) || 'Untitled Conversation';
        const conversation = new Conversation({
          title,
          schema: result.schema,
          schemaVersion: 1,
          messages: [
            { role: 'user', content: requirementText, operation: 'generate', schemaVersion: 1 },
            { role: 'assistant', content: JSON.stringify(result.schema), operation: 'generate', schemaVersion: 1 },
          ],
        });
        await conversation.save();
        conversationId = conversation._id;
      } catch (dbErr) {
        console.warn("[SchemAI] Failed to save conversation to MongoDB:", dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        schema: result.schema,
        validation: result.validation,
        repaired: result.repaired,
        conversationId,
        schemaVersion: conversationId ? 1 : null,
      },
    });
  } catch (error) {
    next(error);
  }
};
