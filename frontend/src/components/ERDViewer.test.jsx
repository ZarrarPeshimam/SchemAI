import React from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ERDViewer from './ERDViewer';

// Real ERDViewer + real React Flow, rendered in jsdom. jsdom lacks a few browser APIs React Flow needs.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.DOMMatrixReadOnly = class {
    constructor() {
      this.m22 = 1;
    }
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
});

const attr = (name, extra = {}) => ({ name, type: 'INT', primaryKey: false, foreignKey: false, nullable: false, unique: false, ...extra });

const sample = {
  entities: [{ id: 'customer', name: 'Customer', attributes: [attr('customer_id', { primaryKey: true })] }],
  relationships: [],
};

const generated = {
  entities: [
    { id: 'owner', name: 'Owner', attributes: [attr('owner_id', { primaryKey: true }), attr('full_name', { type: 'VARCHAR' })] },
    {
      id: 'pet',
      name: 'Pet',
      attributes: [attr('pet_id', { primaryKey: true }), attr('owner_id', { foreignKey: true, references: { entity: 'owner', attribute: 'owner_id' } })],
    },
  ],
  relationships: [{ id: 'owner_pet', source: 'owner', target: 'pet', name: 'owns', cardinality: '1:N' }],
};

const props = { selectedEntityId: null, onSelectEntity: vi.fn(), isFullscreen: false, onToggleFullscreen: vi.fn() };

describe('ERDViewer (real React Flow)', () => {
  it('renders entity cards with attributes and key badges', async () => {
    render(<ERDViewer schema={generated} {...props} />);
    await waitFor(() => expect(screen.getByText('OWNER')).toBeInTheDocument());
    expect(screen.getByText('PET')).toBeInTheDocument();
    expect(screen.getByText('full_name')).toBeInTheDocument();
    expect(screen.getAllByText('PK').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('FK')).toHaveLength(1);
  });

  it('replaces the previous diagram when a new schema is passed (sample -> generated)', async () => {
    const { rerender } = render(<ERDViewer schema={sample} {...props} />);
    await waitFor(() => expect(screen.getByText('CUSTOMER')).toBeInTheDocument());

    rerender(<ERDViewer schema={generated} {...props} />);

    await waitFor(() => expect(screen.getByText('OWNER')).toBeInTheDocument());
    expect(screen.getByText('PET')).toBeInTheDocument();
    expect(screen.queryByText('CUSTOMER')).not.toBeInTheDocument();
  });

  // NOTE: edge rendering is intentionally not asserted here. React Flow only draws edges after measuring node
  // handle bounds, which jsdom cannot do. Edge data (name, cardinality, endpoints) is covered in
  // utils/schemaToFlow.test.js; the drawn edges need a manual check in a real browser (see README smoke test).
});
