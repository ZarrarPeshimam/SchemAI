import { GoogleGenAI } from "@google/genai";
import { validateSchemaSemantics } from "../validators/schemaValidator.js";

export const GEMINI_SCHEMA_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      description: "List of relational database entities/tables",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique lowercase identifier for the entity (e.g. 'student', 'course')",
          },
          name: {
            type: "string",
            description: "Singular PascalCase or capitalized entity name (e.g. 'Student', 'Course')",
          },
          description: {
            type: "string",
            description: "Short description of the entity purpose",
          },
          attributes: {
            type: "array",
            description: "Columns/attributes belonging to this entity",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Column name in lowercase snake_case (e.g. 'student_id', 'email')",
                },
                type: {
                  type: "string",
                  description: "Data type: INT, VARCHAR, TEXT, DECIMAL, DATE, TIMESTAMP, BOOLEAN, UUID",
                },
                primaryKey: {
                  type: "boolean",
                  description: "Whether this attribute is part of the primary key",
                },
                foreignKey: {
                  type: "boolean",
                  description: "Whether this attribute is a foreign key reference",
                },
                nullable: {
                  type: "boolean",
                  description: "Whether NULL values are allowed (false for primary keys)",
                },
                unique: {
                  type: "boolean",
                  description: "Whether values must be unique across rows",
                },
                references: {
                  type: "object",
                  description: "Referential metadata when foreignKey is true",
                  properties: {
                    entity: {
                      type: "string",
                      description: "Entity ID of the referenced parent table",
                    },
                    attribute: {
                      type: "string",
                      description: "Attribute name of the referenced primary key",
                    },
                  },
                  required: ["entity", "attribute"],
                },
              },
              required: ["name", "type", "primaryKey", "foreignKey", "nullable", "unique"],
            },
          },
        },
        required: ["id", "name", "attributes"],
      },
    },
    relationships: {
      type: "array",
      description: "Relational connections between entities",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique identifier for the relationship (e.g. 'student-enrollment')",
          },
          source: {
            type: "string",
            description: "Parent entity id (the 1 side of 1:N or 1:1)",
          },
          target: {
            type: "string",
            description: "Child entity id (the N side of 1:N or other side)",
          },
          name: {
            type: "string",
            description: "Relationship verb phrase (e.g. 'has', 'enrolls_in', 'teaches')",
          },
          cardinality: {
            type: "string",
            description: "Relationship cardinality: '1:1', '1:N', or 'N:M'",
          },
        },
        required: ["id", "source", "target", "name", "cardinality"],
      },
    },
  },
  required: ["entities", "relationships"],
};

export const SYSTEM_INSTRUCTION = `You are an expert relational database architect and schema designer.
Your task is to analyze natural-language database requirements and generate a normalized, structurally sound Entity-Relationship (ER) schema in strict JSON format.

Relational Modeling Guidelines:
1. Identify all core entities and associative entities (junction tables for N:M relationships).
2. For each entity, specify a unique 'id' (lowercase snake_case, e.g. "student", "course_offering") and 'name' (e.g. "Student", "CourseOffering").
3. Ensure EVERY entity has at least one primary key attribute with primaryKey=true, nullable=false, unique=true, foreignKey=false.
4. For foreign keys:
   - Mark foreignKey=true, primaryKey=false.
   - Include 'references' with { entity: "<parent_entity_id>", attribute: "<parent_pk_attribute_name>" }.
   - If an attribute is NOT a foreign key, set foreignKey=false and DO NOT include references.
   - Attribute types must match the referenced primary key type (e.g., INT to INT, UUID to UUID).
5. Use only standard supported data types: INT, BIGINT, VARCHAR, TEXT, BOOLEAN, DATE, TIMESTAMP, DECIMAL, UUID.
6. Relationships:
   - For 1:N relationships: 'source' is the parent entity ID (1 side), 'target' is the child entity ID (N side).
   - Ensure the child entity has the corresponding foreign key attribute referencing the parent.
   - For N:M relationships, create an associative entity (junction table) with foreign keys to both parents, and create two 1:N relationships.
   - Cardinality must be one of "1:1", "1:N", "N:M".
7. All entity IDs, entity names, relationship IDs, and attribute names within each entity must be unique and use valid alphanumeric/underscore identifiers.`;

export class GeminiService {
  constructor(client = null) {
    this.client = client;
  }

  getClient() {
    if (this.client) return this.client;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.trim() === "" || apiKey === "your_gemini_api_key_here") {
      const error = new Error(
        "GEMINI_API_KEY is not configured in the backend environment. Please set GEMINI_API_KEY in backend/.env"
      );
      error.code = "MISSING_API_KEY";
      error.statusCode = 500;
      throw error;
    }
    return new GoogleGenAI({ apiKey });
  }

  getModel() {
    return process.env.GEMINI_MODEL || "gemini-2.5-flash";
  }

  /**
   * Generates a validated relational schema from natural language requirements.
   * Performs at most 1 bounded repair attempt if initial LLM output has semantic validation issues.
   */
  async generateSchema(requirement) {
    const ai = this.getClient();
    const model = this.getModel();

    let rawOutput;
    try {
      const response = await ai.models.generateContent({
        model,
        contents: `Generate a complete relational database schema for the following requirements:\n\n"${requirement}"`,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: GEMINI_SCHEMA_OUTPUT_SCHEMA,
        },
      });

      rawOutput = response.text;
    } catch (err) {
      if (err.code === "MISSING_API_KEY") throw err;
      const error = new Error(`Gemini API generation failed: ${err.message}`);
      error.code = err.status === 429 ? "RATE_LIMIT_EXCEEDED" : "LLM_PROVIDER_ERROR";
      error.statusCode = err.status === 429 ? 429 : 502;
      error.details = err.message;
      throw error;
    }

    let parsedSchema;
    try {
      parsedSchema = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput;
    } catch (parseErr) {
      const error = new Error(`Failed to parse LLM JSON response: ${parseErr.message}`);
      error.code = "MALFORMED_LLM_OUTPUT";
      error.statusCode = 502;
      throw error;
    }

    // Run deterministic semantic validation
    let validation = validateSchemaSemantics(parsedSchema);

    // If valid on first attempt, return immediately
    if (validation.valid) {
      return {
        schema: parsedSchema,
        validation,
        repaired: false,
      };
    }

    // Bounded repair attempt (at most 1 retry)
    const errorDetails = validation.errors.map((e) => `- ${e.code}: ${e.message}`).join("\n");
    const repairPrompt = `The previous schema output had the following relational validation errors:\n${errorDetails}\n\nOriginal requirement:\n"${requirement}"\n\nPlease fix the errors and return the corrected complete relational schema JSON.`;

    try {
      const repairResponse = await ai.models.generateContent({
        model,
        contents: [
          { role: "user", parts: [{ text: `Original requirement:\n"${requirement}"` }] },
          { role: "model", parts: [{ text: JSON.stringify(parsedSchema) }] },
          { role: "user", parts: [{ text: repairPrompt }] },
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: GEMINI_SCHEMA_OUTPUT_SCHEMA,
        },
      });

      const repairedRaw = repairResponse.text;
      const repairedParsed = typeof repairedRaw === "string" ? JSON.parse(repairedRaw) : repairedRaw;
      const repairValidation = validateSchemaSemantics(repairedParsed);

      if (repairValidation.valid) {
        return {
          schema: repairedParsed,
          validation: repairValidation,
          repaired: true,
        };
      }

      // If still invalid after repair attempt
      const err = new Error(
        `Generated schema failed relational validation: ${repairValidation.errors.map((e) => e.message).join("; ")}`
      );
      err.code = "SCHEMA_VALIDATION_FAILED";
      err.statusCode = 422;
      err.validation = repairValidation;
      throw err;
    } catch (repairErr) {
      if (repairErr.code === "SCHEMA_VALIDATION_FAILED") throw repairErr;
      const err = new Error(
        `Generated schema failed relational validation: ${validation.errors.map((e) => e.message).join("; ")}`
      );
      err.code = "SCHEMA_VALIDATION_FAILED";
      err.statusCode = 422;
      err.validation = validation;
      throw err;
    }
  }
}

export const geminiService = new GeminiService();
