import { schemaService } from "../services/schemaService.js";
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

export const refineSchema = (req, res, next) => {
  try {
    const parseResult = refineRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MALFORMED_REQUEST",
          message: "Invalid request payload. 'schema' object and 'instruction' string are required.",
          details: parseResult.error.issues,
        },
      });
    }

    schemaService.refineSchema({
      schema: parseResult.data.schema,
      instruction: parseResult.data.instruction,
    });
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
    const result = await schemaService.generateSchema({ requirement: requirementText });

    return res.status(200).json({
      success: true,
      data: {
        schema: result.schema,
        validation: result.validation,
        repaired: result.repaired,
      },
    });
  } catch (error) {
    next(error);
  }
};
