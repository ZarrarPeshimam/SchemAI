import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeOperations } from "../src/services/refinement/operationNormalizer.js";
import { applyOperations } from "../src/services/refinement/applyOperations.js";
import { validateCandidate, consistencyWarnings } from "../src/services/refinement/refinementValidator.js";
import { missingRequiredFields, OPERATION_TYPES, REQUIRED_FIELDS } from "../src/services/refinement/operationContract.js";

/**
 * Scenario tests: the user's sentence, the proposal Gemini would plausibly return for it (including sloppy-but-equivalent
 * shapes), and the resulting schema. Everything between the model and the schema is the REAL production code:
 * normalizeOperations -> applyOperations -> validateCandidate. No model, network or database is involved.
 */

const pk = (name, type = "INT") => ({ name, type, primaryKey: true, foreignKey: false, nullable: false, unique: true });
const col = (name, type = "VARCHAR", extra = {}) => ({ name, type, primaryKey: false, foreignKey: false, nullable: true, unique: false, ...extra });
const fk = (name, entity, attribute, extra = {}) => ({ name, type: "INT", primaryKey: false, foreignKey: true, nullable: false, unique: false, references: { entity, attribute }, ...extra });

const company = () => ({
  entities: [
    { id: "department", name: "Department", description: "Departments", attributes: [pk("department_id"), col("department_name", "VARCHAR", { nullable: false })] },
    {
      id: "employee",
      name: "Employee",
      description: "Staff",
      attributes: [pk("employee_id"), col("employee_name", "VARCHAR", { nullable: false }), col("email", "VARCHAR", { nullable: false }), col("phone_number"), col("salary", "INT")],
    },
    { id: "project", name: "Project", description: "Projects", attributes: [pk("project_id"), col("title")] },
    {
      id: "payment",
      name: "Payment",
      description: "Payments",
      attributes: [pk("payment_id"), fk("employee_id", "employee", "employee_id"), col("amount", "DECIMAL")],
    },
    { id: "student", name: "Student", description: "Students", attributes: [pk("id"), col("student_id", "VARCHAR", { nullable: false, unique: true }), col("name")] },
    { id: "enrollment", name: "Enrollment", description: "Enrollments", attributes: [pk("enrollment_id"), fk("student_ref", "student", "id")] },
  ],
  relationships: [
    { id: "employee_payment", source: "employee", target: "payment", name: "receives", cardinality: "1:N" },
    { id: "student_enrollment", source: "student", target: "enrollment", name: "has", cardinality: "1:N" },
  ],
});

const entityOf = (schema, id) => schema.entities.find((e) => e.id === id);
const attrOf = (schema, e, name) => entityOf(schema, e)?.attributes.find((a) => a.name === name);

/** normalize -> apply -> validate, exactly like the pipeline (minus the model call). */
function run(schema, rawOps) {
  const original = structuredClone(schema);
  const operations = normalizeOperations(rawOps);
  const applied = applyOperations(original, operations);
  assert.deepEqual(original, schema, "input schema must never be mutated");
  if (!applied.ok) return { ...applied, operations };
  const check = validateCandidate(original, applied.schema);
  return { ...applied, operations, check };
}
const mustApply = (schema, rawOps) => {
  const r = run(schema, rawOps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.check.valid, true, JSON.stringify(r.check.issues));
  return r;
};

describe("attribute instructions", () => {
  it('"Add a date_of_birth field to Customer. It should be a DATE and nullable." (canonical AND flat Gemini shapes)', () => {
    for (const raw of [
      { op: "add_attribute", entity: "employee", attributeDefinition: { name: "date_of_birth", type: "DATE", nullable: true } },
      { op: "add_attribute", entity: "employee", name: "date_of_birth", type: "DATE", nullable: true },
      { op: "add_attribute", entity: "employee", newName: "date_of_birth", dataType: "date", isNullable: true },
      { op: "add_column", table: "Employee", column_definition: { name: "date_of_birth", type: "DATE", nullable: "true" } },
    ]) {
      const r = mustApply(company(), [raw]);
      assert.deepEqual(attrOf(r.schema, "employee", "date_of_birth"), col("date_of_birth", "DATE", { nullable: true }), JSON.stringify(raw));
    }
  });

  it('"Add a non-nullable attribute" and "make email compulsory and unique"', () => {
    const r = mustApply(company(), [
      { op: "add_attribute", entity: "employee", attributeDefinition: { name: "hire_date", type: "DATE", nullable: false } },
      { op: "modify_attribute", entity: "employee", attribute: "email", nullable: false, unique: true },
    ]);
    assert.equal(attrOf(r.schema, "employee", "hire_date").nullable, false);
    assert.equal(attrOf(r.schema, "employee", "email").unique, true);
    assert.equal(attrOf(r.schema, "employee", "email").nullable, false);
  });

  it("constraint-style and alias operations all end up as the same modify_attribute", () => {
    const expected = mustApply(company(), [{ op: "modify_attribute", entity: "employee", attribute: "phone_number", unique: true }]).schema;
    for (const raw of [
      { op: "modify_constraint", entity: "employee", attribute: "phone_number", constraint: "unique" },
      { op: "set_unique", entity: "employee", attribute: "phone_number" },
      { op: "modify_attribute", entity: "employee", attribute: "phone_number", changes: { unique: true } },
      { op: "Modify Attribute", entity: "employee", column: "phone_number", is_unique: true },
    ]) {
      assert.deepEqual(mustApply(company(), [raw]).schema, expected, JSON.stringify(raw));
    }
    const notNull = mustApply(company(), [{ op: "modify_constraint", entity: "employee", attribute: "phone_number", constraint: "not_null" }]);
    assert.equal(attrOf(notNull.schema, "employee", "phone_number").nullable, false);
  });

  it('"Change Employee salary to DECIMAL and make it non-nullable."', () => {
    const r = mustApply(company(), [{ op: "modify_attribute", entity: "employee", attribute: "salary", type: "DECIMAL", nullable: false }]);
    assert.equal(attrOf(r.schema, "employee", "salary").type, "DECIMAL");
    assert.equal(attrOf(r.schema, "employee", "salary").nullable, false);
  });

  it('"Rename employee_name to full_name." keeps constraints (every rename spelling)', () => {
    for (const raw of [
      { op: "modify_attribute", entity: "employee", attribute: "employee_name", newName: "full_name" },
      { op: "rename_attribute", entity: "employee", attribute: "employee_name", newName: "full_name" },
      { op: "rename_column", table: "employee", oldName: "employee_name", new_name: "full_name" },
    ]) {
      const r = mustApply(company(), [raw]);
      assert.deepEqual(attrOf(r.schema, "employee", "full_name"), col("full_name", "VARCHAR", { nullable: false }), JSON.stringify(raw));
      assert.equal(attrOf(r.schema, "employee", "employee_name"), undefined);
    }
  });

  it("renaming a referenced key updates the foreign keys that point at it", () => {
    const r = mustApply(company(), [{ op: "modify_attribute", entity: "employee", attribute: "employee_id", newName: "staff_id" }]);
    assert.equal(attrOf(r.schema, "payment", "employee_id").references.attribute, "staff_id");
  });

  it('"Remove phone_number from Customer." / "Get rid of the phone field" resolves tolerant names to the canonical attribute', () => {
    for (const attribute of ["phone_number", "Phone Number", "phoneNumber", "PHONE_NUMBER"]) {
      const r = mustApply(company(), [{ op: "remove_attribute", entity: "Employee", attribute }]);
      assert.equal(attrOf(r.schema, "employee", "phone_number"), undefined, attribute);
      assert.equal(entityOf(r.schema, "employee").attributes.length, entityOf(company(), "employee").attributes.length - 1);
    }
  });

  it("failure cases: missing entity, missing attribute, duplicate attribute, invalid data type", () => {
    assert.match(run(company(), [{ op: "add_attribute", entity: "ghost", attributeDefinition: { name: "x", type: "INT" } }]).issues[0], /Entity 'ghost' does not exist/);
    assert.match(run(company(), [{ op: "remove_attribute", entity: "employee", attribute: "nope" }]).issues[0], /does not exist in entity 'employee'/);
    assert.match(run(company(), [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "EMAIL", type: "VARCHAR" } }]).issues[0], /already exists/);
    assert.match(run(company(), [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "blob_col", type: "BLOB" } }]).issues[0], /not supported/);
  });

  it("a rename that collides with an existing attribute is rejected and nothing changes", () => {
    assert.match(run(company(), [{ op: "modify_attribute", entity: "employee", attribute: "employee_name", newName: "email" }]).issues[0], /already exists/);
  });

  it("an incomplete operation is reported by the shared contract, never executed with guessed values", () => {
    const r = run(company(), [{ op: "add_attribute", entity: "employee" }]);
    assert.equal(r.ok, false);
    assert.match(r.issues[0], /requires 'attributeDefinition'/);
    const r2 = run(company(), [{ op: "add_attribute", entity: "employee", attributeDefinition: { name: "only_a_name" } }]);
    assert.equal(r2.ok, false, "attribute definition without a type must not be executed");
  });
});

describe("multiple operations in one instruction", () => {
  it('"Add salary as a non-nullable DECIMAL attribute to Employee and make email unique." (salary already INT here, so use a new column)', () => {
    const r = mustApply(company(), [
      { op: "add_attribute", entity: "employee", attributeDefinition: { name: "bonus", type: "DECIMAL", nullable: false } },
      { op: "modify_attribute", entity: "employee", attribute: "email", unique: true },
    ]);
    assert.equal(attrOf(r.schema, "employee", "bonus").type, "DECIMAL");
    assert.equal(attrOf(r.schema, "employee", "email").unique, true);
    assert.equal(r.changes.length >= 2, true);
  });

  it("several attributes packed into one operation are expanded into canonical add_attribute operations", () => {
    const ops = normalizeOperations([{ op: "add_attribute", entity: "employee", attributes: [{ name: "a1", type: "INT" }, { name: "a2", type: "DATE" }] }]);
    assert.equal(ops.length, 2);
    assert.deepEqual(ops.map((o) => o.attributeDefinition.name), ["a1", "a2"]);
    mustApply(company(), ops);
  });

  it("if the second operation fails nothing from the first is returned (all-or-nothing)", () => {
    const r = run(company(), [
      { op: "add_attribute", entity: "employee", attributeDefinition: { name: "ok_col", type: "INT" } },
      { op: "remove_attribute", entity: "employee", attribute: "nope" },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.schema, undefined);
  });
});

describe("entity instructions and dependency policy", () => {
  it('"Add a Department entity with department_id and department_name." (no primary key flagged -> sensible default only when missing)', () => {
    const base = company();
    base.entities = base.entities.filter((e) => e.id !== "department");
    base.relationships = base.relationships;
    const r = mustApply(base, [
      { op: "add_entity", name: "Department", attributes: [{ name: "department_id", type: "INT", primaryKey: true }, { name: "department_name", type: "VARCHAR", nullable: false }] },
    ]);
    const d = entityOf(r.schema, "department");
    assert.equal(d.name, "Department");
    assert.deepEqual(d.attributes.map((a) => a.name), ["department_id", "department_name"]);
    assert.equal(d.attributes[0].nullable, false);
  });

  it("adding an entity that already exists is rejected (also by name, case-insensitively)", () => {
    assert.match(run(company(), [{ op: "add_entity", entityDefinition: { id: "dept2", name: "DEPARTMENT", attributes: [{ name: "x", type: "INT", primaryKey: true }] } }]).issues[0], /already exists/);
  });

  it('"Remove the Payment entity." works without confirmation: its own relationships go with it, nothing else is touched', () => {
    const r = mustApply(company(), [{ op: "remove_entity", entity: "Payment" }]);
    assert.equal(entityOf(r.schema, "payment"), undefined);
    assert.equal(r.schema.relationships.some((x) => x.id === "employee_payment"), false);
    assert.deepEqual(entityOf(r.schema, "employee"), entityOf(company(), "employee"));
    assert.equal(r.schema.relationships.some((x) => x.id === "student_enrollment"), true);
  });

  it("removing an entity that other entities hold foreign keys to asks first (no silent cascade)", () => {
    const r = run(company(), [{ op: "remove_entity", entity: "employee" }]);
    assert.equal(r.ok, false);
    assert.equal(r.kind, "clarify");
    assert.match(r.question, /payment\.employee_id/);
  });

  it("... and removes those foreign keys and relationships only when explicitly cascading", () => {
    const r = mustApply(company(), [{ op: "remove_entity", entity: "employee", cascade: true }]);
    assert.equal(entityOf(r.schema, "employee"), undefined);
    assert.equal(attrOf(r.schema, "payment", "employee_id"), undefined);
    assert.equal(r.schema.relationships.some((x) => x.source === "employee" || x.target === "employee"), false);
    assert.deepEqual(entityOf(r.schema, "student"), entityOf(company(), "student"), "unrelated entities untouched");
  });

  it("a dependent foreign key that is part of another entity's primary key is never dropped, even with cascade", () => {
    const s = company();
    s.entities.push({ id: "assignment", name: "Assignment", description: "", attributes: [{ ...fk("employee_id", "employee", "employee_id"), primaryKey: true }, { ...fk("project_id", "project", "project_id"), primaryKey: true }] });
    s.relationships.push({ id: "employee_assignment", source: "employee", target: "assignment", name: "has", cardinality: "1:N" }, { id: "project_assignment", source: "project", target: "assignment", name: "has", cardinality: "1:N" });
    const r = run(s, [{ op: "remove_entity", entity: "employee", cascade: true }]);
    assert.equal(r.kind, "clarify");
    assert.match(r.question, /primary key/);
  });

  it("removing the only primary-key column asks which column should replace it", () => {
    const r = run(company(), [{ op: "remove_attribute", entity: "project", attribute: "project_id" }]);
    assert.equal(r.kind, "clarify");
    assert.match(r.question, /only primary-key column/);
  });

  it("tolerant entity references: plural, case and separators resolve to the existing entity, ambiguity never guesses", () => {
    for (const entity of ["Employees", "EMPLOYEE", "employee"]) {
      assert.equal(run(company(), [{ op: "add_attribute", entity, attributeDefinition: { name: "x_col", type: "INT" } }]).ok, true, entity);
    }
    // an exact match always wins over a fuzzy one
    const s = company();
    s.entities.push({ id: "employees", name: "Employees", description: "", attributes: [pk("employees_id")] });
    const exact = run(s, [{ op: "add_attribute", entity: "Employees", attributeDefinition: { name: "x_col", type: "INT" } }]);
    assert.equal(exact.ok, true);
    assert.ok(attrOf(exact.schema, "employees", "x_col"));
    assert.equal(attrOf(exact.schema, "employee", "x_col"), undefined);
    // two entities equally close to the reference: error, never a guess
    const amb = company();
    amb.entities.push({ id: "order_item", name: "OrderItem", description: "", attributes: [pk("a_id")] }, { id: "orderitem", name: "Orderitem2", description: "", attributes: [pk("b_id")] });
    assert.match(run(amb, [{ op: "add_attribute", entity: "Order Item", attributeDefinition: { name: "x_col", type: "INT" } }]).issues[0], /several entities/);
  });
});

describe("relationship instructions", () => {
  it('"Employees can work on multiple projects." -> N:M becomes an associative entity with a composite key', () => {
    const r = mustApply(company(), [{ op: "add_relationship", relationship: { source: "employee", target: "project", name: "works_on", cardinality: "N:M", junctionName: "EmployeeProject" } }]);
    const j = entityOf(r.schema, "employee_project");
    assert.ok(j);
    assert.deepEqual(j.attributes.map((a) => [a.name, a.primaryKey, a.foreignKey]), [["employee_id", true, true], ["project_id", true, true]]);
    assert.equal(r.schema.relationships.filter((x) => x.target === "employee_project" && x.cardinality === "1:N").length, 2);
    assert.equal(r.schema.relationships.some((x) => x.cardinality === "N:M"), false);
    assert.deepEqual(consistencyWarnings(r.schema), []);
  });

  it('"Each employee belongs to exactly one department." -> mandatory 1:N from Department to Employee', () => {
    const r = mustApply(company(), [{ op: "add_relationship", relationship: { source: "department", target: "employee", name: "employs", cardinality: "1:N", mandatory: true } }]);
    assert.deepEqual(attrOf(r.schema, "employee", "department_id"), fk("department_id", "department", "department_id", { nullable: false }));
    // the same relationship without a statement about optionality keeps existing rows valid: nullable
    const optional = mustApply(company(), [{ op: "add_relationship", relationship: { source: "department", target: "employee", name: "employs", cardinality: "1:N" } }]);
    assert.equal(attrOf(optional.schema, "employee", "department_id").nullable, true);
  });

  it('"many-to-one" phrasing is turned around into SchemAI\'s parent -> child convention', () => {
    const r = mustApply(company(), [{ op: "add_relationship", source: "employee", target: "department", name: "belongs_to", cardinality: "many-to-one" }]);
    const rel = r.schema.relationships.find((x) => x.name === "belongs_to");
    assert.deepEqual([rel.source, rel.target, rel.cardinality], ["department", "employee", "1:N"]);
    assert.ok(attrOf(r.schema, "employee", "department_id"));
  });

  it('"An employee reports to another employee." -> self-referencing relationship with a nullable manager_id', () => {
    const r = mustApply(company(), [{ op: "add_relationship", relationship: { source: "employee", target: "employee", name: "manages", cardinality: "1:N", foreignKeyName: "manager_id" } }]);
    assert.deepEqual(attrOf(r.schema, "employee", "manager_id"), fk("manager_id", "employee", "employee_id", { nullable: true }));
    const rel = r.schema.relationships.find((x) => x.name === "manages");
    assert.equal(rel.source, "employee");
    assert.equal(rel.target, "employee");
  });

  it("self-reference without a foreign key name gets a derived, collision-free column", () => {
    const r = mustApply(company(), [{ op: "add_relationship", relationship: { source: "employee", target: "employee", name: "manages", cardinality: "1:N" } }]);
    assert.equal(attrOf(r.schema, "employee", "parent_employee_id").nullable, true);
  });

  it("self-referencing many-to-many gets a junction whose two key columns have distinct names", () => {
    const r = mustApply(company(), [{ op: "add_relationship", relationship: { source: "employee", target: "employee", name: "mentors", cardinality: "N:M", junctionName: "Mentorship" } }]);
    const names = entityOf(r.schema, "mentorship").attributes.map((a) => a.name);
    assert.equal(new Set(names).size, 2);
  });

  it("one-to-one: unique foreign key on the target", () => {
    const r = mustApply(company(), [{ op: "add_relationship", relationship: { source: "employee", target: "project", name: "leads", cardinality: "1:1" } }]);
    assert.equal(attrOf(r.schema, "project", "employee_id").unique, true);
    assert.equal(r.schema.relationships.find((x) => x.name === "leads").cardinality, "1:1");
  });

  it("modify and remove relationships (ids resolved tolerantly)", () => {
    const mod = mustApply(company(), [{ op: "modify_relationship", relationshipId: "Employee Payment", cardinality: "one-to-one" }]);
    assert.equal(mod.schema.relationships.find((x) => x.id === "employee_payment").cardinality, "1:1");
    const rm = mustApply(company(), [{ op: "remove_relationship", relationship_id: "employee_payment" }]);
    assert.equal(rm.schema.relationships.some((x) => x.id === "employee_payment"), false);
    assert.equal(attrOf(rm.schema, "payment", "employee_id"), undefined, "the foreign key that implemented it goes too");
  });

  it("invalid relationships: unknown entity, bad cardinality, duplicate", () => {
    assert.match(run(company(), [{ op: "add_relationship", relationship: { source: "ghost", target: "employee", name: "x", cardinality: "1:N" } }]).issues[0], /does not exist/);
    assert.match(run(company(), [{ op: "add_relationship", relationship: { source: "department", target: "employee", name: "x", cardinality: "weird" } }]).issues[0], /Cardinality/);
    assert.match(run(company(), [{ op: "add_relationship", relationship: { source: "employee", target: "payment", name: "again", cardinality: "1:N" } }]).issues[0], /already exists/);
  });
});

describe("modify_primary_key", () => {
  it('"Make student_id the primary key of Student." REPLACES the key, re-pointing the foreign keys that used the old one', () => {
    for (const raw of [
      { op: "modify_primary_key", entity: "student", primaryKeyAttributes: ["student_id"] },
      { op: "set_primary_key", entity: "Student", attribute: "student_id" },
      { op: "modify_primary_key", entity: "student", columns: "student_id" },
    ]) {
      const r = mustApply(company(), [raw]);
      const pks = entityOf(r.schema, "student").attributes.filter((a) => a.primaryKey).map((a) => a.name);
      assert.deepEqual(pks, ["student_id"], JSON.stringify(raw));
      assert.equal(attrOf(r.schema, "student", "id").primaryKey, false);
      const ref = attrOf(r.schema, "enrollment", "student_ref");
      assert.deepEqual(ref.references, { entity: "student", attribute: "student_id" });
      assert.equal(ref.type, "VARCHAR", "foreign key takes the type of the new key");
    }
  });

  it("a composite key on a referenced entity is a question, not a guess; an unchanged key is rejected", () => {
    assert.equal(run(company(), [{ op: "modify_primary_key", entity: "student", primaryKeyAttributes: ["student_id", "name"] }]).kind, "clarify");
    assert.match(run(company(), [{ op: "modify_primary_key", entity: "student", primaryKeyAttributes: ["id"] }]).issues[0], /nothing to change/);
    assert.match(run(company(), [{ op: "modify_primary_key", entity: "student", primaryKeyAttributes: ["nope"] }]).issues[0], /does not exist/);
  });
});

describe("shared operation contract (normalizer output must always satisfy what the executor reads)", () => {
  const SAMPLES = {
    add_entity: { op: "add_entity", name: "Tag", attributes: [{ name: "tag_id", type: "INT", primaryKey: true }] },
    remove_entity: { op: "remove_entity", table: "payment" },
    rename_entity: { op: "rename_entity", entity: "payment", newName: "Remittance" },
    add_attribute: { op: "add_attribute", entity: "payment", name: "note", type: "TEXT" },
    remove_attribute: { op: "remove_attribute", entity: "payment", field: "amount" },
    modify_attribute: { op: "modify_attribute", entity: "payment", attribute: "amount", unique: true },
    add_relationship: { op: "add_relationship", source: "department", target: "project", name: "owns", cardinality: "1:N" },
    remove_relationship: { op: "remove_relationship", id: "employee_payment" },
    modify_relationship: { op: "modify_relationship", relationship: "employee_payment", cardinality: "1:1" },
    convert_many_to_many: null, // needs an N:M relationship; covered in refineOperations.test.js
    modify_primary_key: { op: "modify_primary_key", entity: "student", attribute: "student_id" },
  };

  it("every operation type has a sample, a requirement list, and a normalized sample that has all required fields", () => {
    for (const type of OPERATION_TYPES) {
      assert.ok(REQUIRED_FIELDS[type], `${type} has no required-field list`);
      assert.ok(type in SAMPLES, `${type} has no contract sample`);
      if (!SAMPLES[type]) continue;
      const [normalized] = normalizeOperations([SAMPLES[type]]);
      assert.equal(normalized.op, type);
      assert.deepEqual(missingRequiredFields(normalized), [], `${type}: ${JSON.stringify(normalized)}`);
      mustApply(company(), [SAMPLES[type]]);
    }
  });

  it("normalization is idempotent for every sample", () => {
    for (const raw of Object.values(SAMPLES).filter(Boolean)) {
      const once = normalizeOperations([raw]);
      assert.deepEqual(normalizeOperations(once), once);
    }
  });

  it("unknown operation names are not guessed", () => {
    assert.equal(normalizeOperations([{ op: "drop_table", entity: "payment" }])[0].op, "drop_table");
    assert.match(run(company(), [{ op: "drop_table", entity: "payment" }]).issues[0], /Unknown operation/);
  });

  it("nothing is invented: cascade stays unset, missing name/type stay missing", () => {
    assert.equal("cascade" in normalizeOperations([{ op: "remove_entity", entity: "payment" }])[0], false);
    assert.equal(normalizeOperations([{ op: "add_attribute", entity: "payment", name: "only_name" }])[0].attributeDefinition, undefined);
  });
});

describe("refinement consistency checks (deterministic, baseline-aware)", () => {
  it("flags an associative entity that is not linked to its parents, and a 1:1 relationship without a key", () => {
    const s = company();
    s.entities.push({ id: "link", name: "Link", description: "", attributes: [{ ...fk("employee_id", "employee", "employee_id"), primaryKey: true }, { ...fk("project_id", "project", "project_id"), primaryKey: true }] });
    assert.deepEqual(consistencyWarnings(s).map((w) => w.code).sort(), ["ASSOCIATIVE_ENTITY_MISSING_RELATIONSHIP", "ASSOCIATIVE_ENTITY_MISSING_RELATIONSHIP"]);
    s.relationships.push({ id: "dp", source: "department", target: "project", name: "x", cardinality: "1:1" });
    assert.ok(consistencyWarnings(s).some((w) => w.code === "ONE_TO_ONE_MISSING_FOREIGN_KEY"));
  });

  it("blocks a candidate that introduces a foreign key to a non-key column, but not pre-existing quirks", () => {
    const r = run(company(), [{ op: "modify_attribute", entity: "payment", attribute: "amount", foreignKey: true, references: { entity: "employee", attribute: "salary" } }]);
    assert.equal(r.ok, true);
    assert.equal(r.check.valid, false);
    assert.match(r.check.issues.join(" "), /FOREIGN_KEY_TARGET_NOT_KEY/);
  });
});
