import { z } from "zod";

export const SUPPORTED_DATA_TYPES = [
  "INT",
  "INTEGER",
  "BIGINT",
  "SMALLINT",
  "VARCHAR",
  "TEXT",
  "CHAR",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "DECIMAL",
  "NUMERIC",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "JSON",
  "JSONB",
  "UUID",
  "SERIAL",
  "BIGSERIAL",
];

export const SUPPORTED_CARDINALITIES = ["1:1", "1:N", "N:M"];

// Safe SQL Identifier check
export const SQL_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Attribute Zod Schema
export const attributeSchema = z.object({
  name: z
    .string({ required_error: "Attribute name is required" })
    .trim()
    .min(1, "Attribute name cannot be empty")
    .regex(SQL_IDENTIFIER_REGEX, "Attribute name must be a valid alphanumeric identifier"),
  type: z
    .string({ required_error: "Attribute type is required" })
    .trim()
    .min(1, "Attribute type cannot be empty")
    .transform((val) => val.toUpperCase()),
  primaryKey: z.boolean().optional().default(false),
  foreignKey: z.boolean().optional().default(false),
  nullable: z.boolean().optional(),
  unique: z.boolean().optional(),
  references: z
    .object({
      entity: z.string().trim().min(1, "Referenced entity id is required"),
      attribute: z.string().trim().min(1, "Referenced attribute name is required"),
    })
    .optional(),
});

// Entity Zod Schema
export const entitySchema = z.object({
  id: z
    .string({ required_error: "Entity id is required" })
    .trim()
    .min(1, "Entity id cannot be empty"),
  name: z
    .string({ required_error: "Entity name is required" })
    .trim()
    .min(1, "Entity name cannot be empty")
    .regex(SQL_IDENTIFIER_REGEX, "Entity name must be a valid alphanumeric identifier"),
  description: z.string().optional(),
  attributes: z
    .array(attributeSchema)
    .min(1, "Entity must have at least one attribute"),
});

// Relationship Zod Schema
export const relationshipSchema = z.object({
  id: z
    .string({ required_error: "Relationship id is required" })
    .trim()
    .min(1, "Relationship id cannot be empty"),
  source: z
    .string({ required_error: "Relationship source is required" })
    .trim()
    .min(1, "Relationship source cannot be empty"),
  target: z
    .string({ required_error: "Relationship target is required" })
    .trim()
    .min(1, "Relationship target cannot be empty"),
  name: z
    .string({ required_error: "Relationship name is required" })
    .trim()
    .min(1, "Relationship name cannot be empty"),
  cardinality: z.enum(["1:1", "1:N", "N:M"], {
    errorMap: () => ({
      message: "Cardinality must be one of: 1:1, 1:N, N:M",
    }),
  }),
});

// Canonical Root Schema
export const canonicalSchemaDef = z.object({
  entities: z
    .array(entitySchema, { required_error: "Schema must contain an entities array" })
    .min(1, "Schema must have at least one entity"),
  relationships: z
    .array(relationshipSchema, { required_error: "Schema must contain a relationships array" })
    .default([]),
});

// Request body schemas
const schemaObjectField = z
  .record(z.string(), z.unknown(), {
    required_error: "Request body must contain 'schema' property",
    invalid_type_error: "'schema' property must be an object",
  });

export const validateRequestSchema = z.object({
  schema: schemaObjectField,
});

export const sqlRequestSchema = z.object({
  schema: schemaObjectField,
  dialect: z
    .string()
    .optional()
    .default("postgresql")
    .transform((val) => val.toLowerCase())
    .refine((val) => val === "postgresql" || val === "postgres", {
      message: "Currently supported SQL dialect is 'postgresql'",
    }),
});

export const refineRequestSchema = z.object({
  schema: schemaObjectField,
  instruction: z
    .string({ required_error: "Request body must contain 'instruction' property" })
    .trim()
    .min(1, "Instruction cannot be empty"),
});

export const generateRequestSchema = z
  .object({
    requirement: z
      .string()
      .trim()
      .min(1, "Requirement cannot be empty")
      .max(4000, "Requirement is too long (maximum 4000 characters)")
      .optional(),
    requirements: z
      .string()
      .trim()
      .min(1, "Requirements cannot be empty")
      .max(4000, "Requirements is too long (maximum 4000 characters)")
      .optional(),
  })
  .refine((data) => data.requirement || data.requirements, {
    message: "Request body must contain non-empty 'requirement' or 'requirements' text",
  });

/**
 * Deterministic Semantic Validation
 * Evaluates business and relational modeling rules.
 */
export function validateSchemaSemantics(schema) {
  const errors = [];
  const warnings = [];
  let checksPassed = 0;
  const TOTAL_CHECKS = 12;

  // 1. Structural check
  const parseResult = canonicalSchemaDef.safeParse(schema);
  if (!parseResult.success) {
    parseResult.error.issues.forEach((issue) => {
      errors.push({
        code: "STRUCTURAL_ERROR",
        message: issue.message,
        path: issue.path.join("."),
      });
    });
    return {
      valid: false,
      errors,
      warnings,
      summary: {
        entityCount: Array.isArray(schema?.entities) ? schema.entities.length : 0,
        relationshipCount: Array.isArray(schema?.relationships) ? schema.relationships.length : 0,
        totalAttributes: 0,
        checksPassed: 0,
        totalChecks: TOTAL_CHECKS,
      },
    };
  }

  checksPassed++; // 1 passed
  const validated = parseResult.data;
  const entities = validated.entities;
  const relationships = validated.relationships;

  const entityIdMap = new Map();
  const entityNameMap = new Map();
  let totalAttributes = 0;

  // 2. Entity names are not duplicated
  let duplicateEntityNames = false;
  entities.forEach((entity) => {
    const lowerName = entity.name.toLowerCase();
    if (entityNameMap.has(lowerName)) {
      errors.push({
        code: "DUPLICATE_ENTITY_NAME",
        message: `Entity name '${entity.name}' is already used by entity '${entityNameMap.get(lowerName)}'`,
        entity: entity.id,
      });
      duplicateEntityNames = true;
    } else {
      entityNameMap.set(lowerName, entity.name);
    }
  });
  if (!duplicateEntityNames) checksPassed++;

  // 3. Entity IDs are unique
  let duplicateEntityIds = false;
  entities.forEach((entity) => {
    if (entityIdMap.has(entity.id)) {
      errors.push({
        code: "DUPLICATE_ENTITY_ID",
        message: `Entity ID '${entity.id}' is duplicated`,
        entity: entity.id,
      });
      duplicateEntityIds = true;
    } else {
      entityIdMap.set(entity.id, entity);
    }
  });
  if (!duplicateEntityIds) checksPassed++;

  // 4 & 5. Attribute checks per entity
  let duplicateAttributeNames = false;
  let missingPrimaryKeys = false;
  let invalidDataTypes = false;
  let constraintInconsistencies = false;

  entities.forEach((entity) => {
    const attributeNameSet = new Set();
    const pkAttributes = [];

    entity.attributes.forEach((attr) => {
      totalAttributes++;
      const lowerAttrName = attr.name.toLowerCase();

      // Check 4: Duplicate attribute names
      if (attributeNameSet.has(lowerAttrName)) {
        errors.push({
          code: "DUPLICATE_ATTRIBUTE_NAME",
          message: `Attribute '${attr.name}' is duplicated in entity '${entity.name}'`,
          entity: entity.id,
          attribute: attr.name,
        });
        duplicateAttributeNames = true;
      } else {
        attributeNameSet.add(lowerAttrName);
      }

      // Check 10: Allowlist data types
      const normalizedType = attr.type.toUpperCase();
      if (!SUPPORTED_DATA_TYPES.includes(normalizedType)) {
        errors.push({
          code: "UNSUPPORTED_DATA_TYPE",
          message: `Attribute '${attr.name}' in entity '${entity.name}' has unsupported data type '${attr.type}'`,
          entity: entity.id,
          attribute: attr.name,
        });
        invalidDataTypes = true;
      }

      // Check 11: Constraint consistency
      if (attr.primaryKey) {
        pkAttributes.push(attr);
        if (attr.nullable === true) {
          errors.push({
            code: "PRIMARY_KEY_NULLABLE",
            message: `Primary key attribute '${attr.name}' in entity '${entity.name}' cannot be nullable`,
            entity: entity.id,
            attribute: attr.name,
          });
          constraintInconsistencies = true;
        }
      }

      if (attr.foreignKey && !attr.references) {
        errors.push({
          code: "FOREIGN_KEY_MISSING_REFERENCES",
          message: `Attribute '${attr.name}' in entity '${entity.name}' is marked as foreignKey but missing references metadata`,
          entity: entity.id,
          attribute: attr.name,
        });
        constraintInconsistencies = true;
      }

      if (!attr.foreignKey && attr.references) {
        errors.push({
          code: "UNEXPECTED_REFERENCES",
          message: `Attribute '${attr.name}' in entity '${entity.name}' specifies references but foreignKey is false`,
          entity: entity.id,
          attribute: attr.name,
        });
        constraintInconsistencies = true;
      }
    });

    // Check 5: Primary key defined
    if (pkAttributes.length === 0) {
      errors.push({
        code: "MISSING_PRIMARY_KEY",
        message: `Entity '${entity.name}' must have at least one primary key attribute`,
        entity: entity.id,
      });
      missingPrimaryKeys = true;
    }
  });

  if (!duplicateAttributeNames) checksPassed++; // 4
  if (!missingPrimaryKeys) checksPassed++; // 5
  if (!invalidDataTypes) checksPassed++; // 10
  if (!constraintInconsistencies) checksPassed++; // 11

  // 6. Foreign-key references point to existing entities and attributes
  let invalidForeignKeyRefs = false;
  entities.forEach((entity) => {
    entity.attributes.forEach((attr) => {
      if (attr.foreignKey && attr.references) {
        const targetEntity = entityIdMap.get(attr.references.entity);
        if (!targetEntity) {
          errors.push({
            code: "INVALID_FOREIGN_KEY_TARGET_ENTITY",
            message: `Foreign key '${attr.name}' in entity '${entity.name}' references non-existent entity '${attr.references.entity}'`,
            entity: entity.id,
            attribute: attr.name,
          });
          invalidForeignKeyRefs = true;
        } else {
          const targetAttr = targetEntity.attributes.find(
            (a) => a.name.toLowerCase() === attr.references.attribute.toLowerCase()
          );
          if (!targetAttr) {
            errors.push({
              code: "INVALID_FOREIGN_KEY_TARGET_ATTRIBUTE",
              message: `Foreign key '${attr.name}' in entity '${entity.name}' references non-existent attribute '${attr.references.attribute}' in entity '${targetEntity.name}'`,
              entity: entity.id,
              attribute: attr.name,
            });
            invalidForeignKeyRefs = true;
          } else {
            // Type compatibility check
            if (attr.type.toUpperCase() !== targetAttr.type.toUpperCase()) {
              warnings.push({
                code: "FOREIGN_KEY_TYPE_MISMATCH",
                message: `Foreign key '${attr.name}' (${attr.type}) in '${entity.name}' has differing type from referenced attribute '${targetAttr.name}' (${targetAttr.type}) in '${targetEntity.name}'`,
                entity: entity.id,
                attribute: attr.name,
              });
            }
          }
        }
      }
    });
  });
  if (!invalidForeignKeyRefs) checksPassed++; // 6

  // 7. Relationships reference existing entities
  let invalidRelationshipEndpoints = false;
  relationships.forEach((rel) => {
    const sourceExists = entityIdMap.has(rel.source);
    const targetExists = entityIdMap.has(rel.target);

    if (!sourceExists) {
      errors.push({
        code: "INVALID_RELATIONSHIP_SOURCE",
        message: `Relationship '${rel.id}' references non-existent source entity '${rel.source}'`,
        relationship: rel.id,
      });
      invalidRelationshipEndpoints = true;
    }
    if (!targetExists) {
      errors.push({
        code: "INVALID_RELATIONSHIP_TARGET",
        message: `Relationship '${rel.id}' references non-existent target entity '${rel.target}'`,
        relationship: rel.id,
      });
      invalidRelationshipEndpoints = true;
    }
  });
  if (!invalidRelationshipEndpoints) checksPassed++; // 7

  // 8. Relationship IDs are unique
  let duplicateRelationshipIds = false;
  const relationshipIdSet = new Set();
  relationships.forEach((rel) => {
    if (relationshipIdSet.has(rel.id)) {
      errors.push({
        code: "DUPLICATE_RELATIONSHIP_ID",
        message: `Relationship ID '${rel.id}' is duplicated`,
        relationship: rel.id,
      });
      duplicateRelationshipIds = true;
    } else {
      relationshipIdSet.add(rel.id);
    }
  });
  if (!duplicateRelationshipIds) checksPassed++; // 8

  // 9. Cardinality validity (already checked in zod, but counted in checksPassed)
  checksPassed++; // 9

  // 12. Referential metadata consistency with relationships
  let referentialInconsistencies = false;
  relationships.forEach((rel) => {
    if (rel.cardinality === "1:N") {
      const targetEntity = entityIdMap.get(rel.target);
      if (targetEntity) {
        const hasFk = targetEntity.attributes.some(
          (a) => a.foreignKey && a.references?.entity === rel.source
        );
        if (!hasFk) {
          warnings.push({
            code: "MISSING_CORRESPONDING_FOREIGN_KEY",
            message: `Relationship '${rel.name}' (${rel.source} 1:N ${rel.target}) has no matching foreign key in target entity '${targetEntity.name}'`,
            relationship: rel.id,
          });
        }
      }
    }
  });
  if (!referentialInconsistencies) checksPassed++; // 12

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      entityCount: entities.length,
      relationshipCount: relationships.length,
      totalAttributes,
      checksPassed,
      totalChecks: TOTAL_CHECKS,
    },
  };
}
