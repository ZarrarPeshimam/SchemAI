import { mockSchema } from "../data/mockSchema.js";
import { validateSchemaSemantics } from "../validators/schemaValidator.js";
import { generateSql } from "./sqlGeneratorService.js";
import { geminiService } from "./geminiService.js";

/**
 * Service handling all schema operations.
 */
class SchemaService {
  /**
   * Return the canonical sample e-commerce schema
   */
  getMockSchema() {
    return mockSchema;
  }

  /**
   * Run deterministic semantic validation on a schema
   */
  validateSchema(schema) {
    return validateSchemaSemantics(schema);
  }

  /**
   * Generate SQL DDL statements from a schema
   */
  generateSql(schema, dialect = "postgresql") {
    return generateSql(schema, dialect);
  }

  /**
   * LLM-Powered schema generation from natural-language requirements
   */
  async generateSchema({ requirement }) {
    return await geminiService.generateSchema(requirement);
  }

  /**
   * Refinement placeholder service boundary.
   * In future phases, this will invoke the LLM to modify the structured schema.
   */
  refineSchema({ schema, instruction }) {
    const error = new Error(
      "Schema refinement is not yet implemented. LLM integration is planned for a later phase."
    );
    error.code = "FEATURE_NOT_IMPLEMENTED";
    error.statusCode = 501;
    throw error;
  }
}

export const schemaService = new SchemaService();
