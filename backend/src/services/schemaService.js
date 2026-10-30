import { mockSchema } from "../data/mockSchema.js";
import { validateSchemaSemantics } from "../validators/schemaValidator.js";
import { generateSql } from "./sqlGeneratorService.js";
import { geminiService } from "./geminiService.js";
import { refinementService } from "./refinementService.js";

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
  async generateSchema({ requirement, model }) {
    return await geminiService.generateSchema(requirement, { model });
  }

  /**
   * Natural-language schema refinement (LangChain.js + Gemini proposes operations; deterministic code applies
   * and validates them). Initial generation above is deliberately NOT routed through LangChain.
   */
  async refineSchema({ schema, instruction, model, reqId }) {
    return await refinementService.refineSchema({ schema, instruction, model, reqId });
  }
}

export const schemaService = new SchemaService();
