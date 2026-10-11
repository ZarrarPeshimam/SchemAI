import {
  SQL_IDENTIFIER_REGEX,
  validateSchemaSemantics,
} from "../validators/schemaValidator.js";

const POSTGRESQL_TYPE_MAP = {
  INT: "INTEGER",
  INTEGER: "INTEGER",
  BIGINT: "BIGINT",
  SMALLINT: "SMALLINT",
  VARCHAR: "VARCHAR(255)",
  TEXT: "TEXT",
  CHAR: "CHAR(1)",
  BOOLEAN: "BOOLEAN",
  DATE: "DATE",
  TIMESTAMP: "TIMESTAMP",
  TIMESTAMPTZ: "TIMESTAMPTZ",
  DECIMAL: "NUMERIC(12, 2)",
  NUMERIC: "NUMERIC(12, 2)",
  FLOAT: "REAL",
  REAL: "REAL",
  DOUBLE: "DOUBLE PRECISION",
  JSON: "JSONB",
  JSONB: "JSONB",
  UUID: "UUID",
  SERIAL: "SERIAL",
  BIGSERIAL: "BIGSERIAL",
};

/**
 * Format entity name to a safe SQL table name (snake_case)
 */
export function toSqlTableName(name) {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Safely quote an SQL identifier
 */
function quoteIdentifier(identifier) {
  if (!SQL_IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: "${identifier}"`);
  }
  return `"${identifier.toLowerCase()}"`;
}

/**
 * Topologically sort entities based on foreign key dependencies
 */
function topologicalSortEntities(entities) {
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const adj = new Map(entities.map((e) => [e.id, new Set()]));
  const inDegree = new Map(entities.map((e) => [e.id, 0]));

  entities.forEach((entity) => {
    entity.attributes.forEach((attr) => {
      if (attr.foreignKey && attr.references && attr.references.entity !== entity.id) {
        const parentId = attr.references.entity;
        if (entityMap.has(parentId)) {
          // Parent must be created before child (entity)
          if (!adj.get(parentId).has(entity.id)) {
            adj.get(parentId).add(entity.id);
            inDegree.set(entity.id, (inDegree.get(entity.id) || 0) + 1);
          }
        }
      }
    });
  });

  const queue = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  const sorted = [];
  while (queue.length > 0) {
    const currId = queue.shift();
    sorted.push(entityMap.get(currId));

    adj.get(currId).forEach((childId) => {
      inDegree.set(childId, inDegree.get(childId) - 1);
      if (inDegree.get(childId) === 0) {
        queue.push(childId);
      }
    });
  }

  // If cycle detected, append remaining entities
  if (sorted.length < entities.length) {
    const included = new Set(sorted.map((e) => e.id));
    entities.forEach((e) => {
      if (!included.has(e.id)) sorted.push(e);
    });
  }

  return sorted;
}

/**
 * Deterministic SQL generator for PostgreSQL
 */
export function generateSql(schema, dialect = "postgresql") {
  // 1. Validate schema before generating SQL
  const validation = validateSchemaSemantics(schema);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => e.message).join("; ");
    const err = new Error(`Cannot generate SQL from invalid schema: ${errorMessages}`);
    err.validation = validation;
    err.statusCode = 400;
    throw err;
  }

  const entities = schema.entities;
  const entityIdToTableMap = new Map();

  // Validate identifiers and build table map
  entities.forEach((entity) => {
    const tableName = toSqlTableName(entity.name);
    if (!SQL_IDENTIFIER_REGEX.test(tableName)) {
      throw new Error(`Invalid table name derived from entity '${entity.name}': '${tableName}'`);
    }
    entityIdToTableMap.set(entity.id, tableName);

    entity.attributes.forEach((attr) => {
      if (!SQL_IDENTIFIER_REGEX.test(attr.name)) {
        throw new Error(
          `Invalid column name '${attr.name}' in entity '${entity.name}'`
        );
      }
      const upperType = attr.type.toUpperCase();
      if (!POSTGRESQL_TYPE_MAP[upperType]) {
        throw new Error(
          `Unsupported SQL data type '${attr.type}' for column '${attr.name}' in entity '${entity.name}'`
        );
      }
    });
  });

  // Topologically sort entities
  const sortedEntities = topologicalSortEntities(entities);

  const statements = [];
  statements.push(`-- ====================================================================`);
  statements.push(`-- SchemAI Generated DDL Schema`);
  statements.push(`-- Dialect: PostgreSQL`);
  statements.push(`-- Generated At: ${new Date().toISOString()}`);
  statements.push(`-- Entities: ${entities.length} | Relationships: ${schema.relationships?.length || 0}`);
  statements.push(`-- ====================================================================\n`);

  sortedEntities.forEach((entity) => {
    const tableName = entityIdToTableMap.get(entity.id);
    const quotedTable = quoteIdentifier(tableName);

    const columnDefs = [];
    const constraints = [];
    const primaryKeyCols = [];

    entity.attributes.forEach((attr) => {
      const quotedCol = quoteIdentifier(attr.name);
      const sqlType = POSTGRESQL_TYPE_MAP[attr.type.toUpperCase()];
      const parts = [`  ${quotedCol} ${sqlType}`];

      // Primary Key collection
      if (attr.primaryKey) {
        primaryKeyCols.push(quotedCol);
        parts.push("NOT NULL");
      } else {
        if (attr.nullable === false) {
          parts.push("NOT NULL");
        }
        if (attr.unique === true) {
          parts.push("UNIQUE");
        }
      }

      // Foreign Key constraint
      if (attr.foreignKey && attr.references) {
        const parentTable = entityIdToTableMap.get(attr.references.entity);
        const quotedParentTable = quoteIdentifier(parentTable);
        const quotedParentCol = quoteIdentifier(attr.references.attribute);
        const fkConstraintName = `fk_${tableName}_${attr.name}`;

        constraints.push(
          `  CONSTRAINT ${quoteIdentifier(fkConstraintName)} FOREIGN KEY (${quotedCol}) REFERENCES ${quotedParentTable} (${quotedParentCol}) ON DELETE CASCADE`
        );
      }

      columnDefs.push(parts.join(" "));
    });

    // Primary Key constraint
    if (primaryKeyCols.length > 0) {
      const pkConstraintName = `pk_${tableName}`;
      constraints.unshift(
        `  CONSTRAINT ${quoteIdentifier(pkConstraintName)} PRIMARY KEY (${primaryKeyCols.join(", ")})`
      );
    }

    const tableElements = [...columnDefs, ...constraints];
    const comment = entity.description
      ? `\n-- Entity: ${entity.name} (${entity.description})`
      : `\n-- Entity: ${entity.name}`;

    statements.push(comment);
    statements.push(`CREATE TABLE ${quotedTable} (\n${tableElements.join(",\n")}\n);`);
  });

  return {
    success: true,
    dialect: "postgresql",
    sql: statements.join("\n"),
  };
}
