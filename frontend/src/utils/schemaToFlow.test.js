import { describe, it, expect } from 'vitest';
import { schemaToFlow } from './schemaToFlow';

const pk = (name) => ({ name, type: 'INT', primaryKey: true, foreignKey: false, nullable: false, unique: true });
const fk = (name, entity, attribute, extra = {}) => ({ name, type: 'INT', primaryKey: false, foreignKey: true, nullable: false, unique: false, references: { entity, attribute }, ...extra });

// Shape of what the generation endpoint returns: associative entity + a self-referencing FK.
const generated = {
  entities: [
    { id: 'employee', name: 'Employee', attributes: [pk('employee_id'), fk('manager_id', 'employee', 'employee_id', { nullable: true })] },
    { id: 'project', name: 'Project', attributes: [pk('project_id')] },
    { id: 'employee_project', name: 'EmployeeProject', attributes: [{ ...fk('employee_id', 'employee', 'employee_id'), primaryKey: true }, { ...fk('project_id', 'project', 'project_id'), primaryKey: true }] },
  ],
  relationships: [
    { id: 'employee_manager', source: 'employee', target: 'employee', name: 'manages', cardinality: '1:N' },
    { id: 'employee_assignment', source: 'employee', target: 'employee_project', name: 'has', cardinality: '1:N' },
    { id: 'project_assignment', source: 'project', target: 'employee_project', name: 'has', cardinality: '1:N' },
  ],
};

describe('schemaToFlow with generated-style schemas', () => {
  it('lays out every entity with finite positions (including self-references and junction tables)', () => {
    const { nodes, edges } = schemaToFlow(generated);
    expect(nodes.map((n) => n.id).sort()).toEqual(['employee', 'employee_project', 'project']);
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    expect(edges).toHaveLength(3);
  });

  it('passes relationship name and cardinality to edges and attributes (with keys) to nodes', () => {
    const { nodes, edges } = schemaToFlow(generated);
    const manager = edges.find((e) => e.id === 'employee_manager');
    expect(manager.data).toMatchObject({ name: 'manages', cardinality: '1:N' });
    const junction = nodes.find((n) => n.id === 'employee_project');
    expect(junction.data.attributes.filter((a) => a.primaryKey && a.foreignKey)).toHaveLength(2);
  });

  it('handles a schema with no relationships', () => {
    const { nodes, edges } = schemaToFlow({ entities: [generated.entities[1]], relationships: [] });
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});
