// Small pure helpers derived from a schema object. Nothing here stores data.

export const toTableName = (name) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

export const getEntity = (schema, id) => schema.entities.find((e) => e.id === id);

// "ORDER_ITEM.order_id → ORDER.order_id" for a parent→child relationship,
// derived from the FK attribute on the child that references the parent.
export function describeRelationshipKey(schema, rel) {
  const parent = getEntity(schema, rel.source);
  const child = getEntity(schema, rel.target);
  if (!parent || !child) return "";
  const fkAttr = child.attributes.find(
    (a) => a.foreignKey && a.references?.entity === parent.id
  );
  if (!fkAttr) return `${toTableName(child.name)} → ${toTableName(parent.name)}`;
  return `${toTableName(child.name)}.${fkAttr.name} → ${toTableName(parent.name)}.${fkAttr.references.attribute}`;
}
