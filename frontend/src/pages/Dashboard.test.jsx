import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

// --- Mocks: the network layer and the (canvas-based) ERD viewer. Everything else renders for real. ---------------
vi.mock('../services/api', () => ({
  api: {
    getSchema: vi.fn(),
    validateSchema: vi.fn(),
    generateSchema: vi.fn(),
    refineSchema: vi.fn(),
    generateSql: vi.fn(),
    getHealth: vi.fn(),
  },
}));

// Stand-in for React Flow: exposes exactly what the Dashboard hands to the ERD (entities, attributes, relationships).
vi.mock('../components/ERDViewer', () => ({
  default: ({ schema }) => (
    <div data-testid="erd">
      {schema.entities.map((e) => (
        <div key={e.id} data-testid={`erd-entity-${e.id}`}>
          {e.name}: {e.attributes.map((a) => a.name).join(',')}
        </div>
      ))}
      {schema.relationships.map((r) => (
        <div key={r.id} data-testid={`erd-rel-${r.id}`}>
          {r.source}-{r.cardinality}-{r.target}
        </div>
      ))}
    </div>
  ),
}));

import Dashboard from './Dashboard';
import { api } from '../services/api';

const attr = (name, extra = {}) => ({ name, type: 'INT', primaryKey: false, foreignKey: false, nullable: false, unique: false, ...extra });

const sampleSchema = {
  entities: [{ id: 'customer', name: 'Customer', description: 'sample', attributes: [attr('customer_id', { primaryKey: true })] }],
  relationships: [],
};

const generatedSchema = {
  entities: [
    { id: 'owner', name: 'Owner', description: 'o', attributes: [attr('owner_id', { primaryKey: true })] },
    { id: 'pet', name: 'Pet', description: 'p', attributes: [attr('pet_id', { primaryKey: true }), attr('owner_id', { foreignKey: true, references: { entity: 'owner', attribute: 'owner_id' } })] },
  ],
  relationships: [{ id: 'owner_pet', source: 'owner', target: 'pet', name: 'owns', cardinality: '1:N' }],
};

const generatedValidation = { valid: true, errors: [], warnings: [], summary: { entityCount: 2, relationshipCount: 1, totalAttributes: 3, checksPassed: 12, totalChecks: 12 } };

const okGenerate = (overrides = {}) => ({
  status: 200,
  ok: true,
  data: { success: true, data: { schema: generatedSchema, validation: generatedValidation, repaired: false, ...overrides } },
});

const errorResponse = (status, code, message, extra = {}) => ({ status, ok: false, data: { success: false, error: { code, message, ...extra } } });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

async function renderLoaded() {
  render(<Dashboard />);
  await screen.findByTestId('erd');
}

const generateButton = () => screen.getByRole('button', { name: /generat/i });
const setRequirement = (text) => fireEvent.change(screen.getByLabelText(/natural language specification/i), { target: { value: text } });

beforeEach(() => {
  vi.resetAllMocks();
  api.getSchema.mockResolvedValue({ status: 200, ok: true, data: { success: true, data: sampleSchema } });
  api.validateSchema.mockResolvedValue({ status: 200, ok: true, data: { success: true, data: { ...generatedValidation, summary: { ...generatedValidation.summary, entityCount: 1 } } } });
});

describe('Dashboard: generation workflow', () => {
  it('initially shows the sample schema, labelled as a sample', async () => {
    await renderLoaded();
    expect(within(screen.getByTestId('erd')).getByText(/Customer/)).toBeInTheDocument();
    expect(screen.getByText(/E-Commerce Database \(sample\)/)).toBeInTheDocument();
    expect(api.generateSchema).not.toHaveBeenCalled();
  });

  it('sends the typed requirement (trimmed) to the backend and renders the returned schema instead of the sample', async () => {
    api.generateSchema.mockResolvedValue(okGenerate());
    await renderLoaded();

    setRequirement('  A veterinary clinic with owners and pets  ');
    fireEvent.click(generateButton());

    await waitFor(() => expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument());
    expect(api.generateSchema).toHaveBeenCalledTimes(1);
    expect(api.generateSchema).toHaveBeenCalledWith('A veterinary clinic with owners and pets');

    const erd = screen.getByTestId('erd');
    // Entities + attributes + relationships/cardinality come from the response...
    expect(within(erd).getByText(/Pet: pet_id,owner_id/)).toBeInTheDocument();
    expect(screen.getByTestId('erd-rel-owner_pet')).toHaveTextContent('owner-1:N-pet');
    // ...and the old sample diagram is gone.
    expect(within(erd).queryByText(/Customer/)).not.toBeInTheDocument();
    expect(screen.getByText('Generated Schema')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Generated 2 entities.*1 relationships/);
    // Validation summary reflects the backend validation of the generated schema (12/12 from the response).
    expect(screen.getByRole('button', { name: /validation/i })).toHaveTextContent('12/12');
  });

  it('shows loading state, disables the button and ignores duplicate requests while generating', async () => {
    const pending = deferred();
    api.generateSchema.mockReturnValue(pending.promise);
    await renderLoaded();

    fireEvent.click(generateButton());
    await waitFor(() => expect(generateButton()).toBeDisabled());
    expect(generateButton()).toHaveTextContent(/generating/i);
    expect(screen.getByRole('status')).toHaveTextContent(/generating schema/i);

    fireEvent.click(generateButton());
    fireEvent.click(generateButton());
    expect(api.generateSchema).toHaveBeenCalledTimes(1);

    pending.resolve(okGenerate());
    await waitFor(() => expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument());
    expect(generateButton()).not.toBeDisabled();
    expect(generateButton()).toHaveTextContent(/generate erd/i);
  });

  it('ignores a second click fired in the same tick, before React has re-rendered the disabled button', async () => {
    const pending = deferred();
    api.generateSchema.mockReturnValue(pending.promise);
    await renderLoaded();

    const btn = generateButton();
    act(() => {
      fireEvent.click(btn);
      fireEvent.click(btn); // button is not disabled in the DOM yet; only the in-flight ref can stop this
    });
    expect(api.generateSchema).toHaveBeenCalledTimes(1);

    pending.resolve(okGenerate());
    await waitFor(() => expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument());
  });

  it('mentions the automatic correction when the backend had to repair the output', async () => {
    api.generateSchema.mockResolvedValue(okGenerate({ repaired: true }));
    await renderLoaded();
    fireEvent.click(generateButton());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/after one automatic correction/i));
  });

  it('shows the backend error (e.g. missing API key), keeps the previous diagram, and does not fake a result', async () => {
    api.generateSchema.mockResolvedValue(errorResponse(503, 'MISSING_API_KEY', 'AI generation is not configured on the server. Set GEMINI_API_KEY in backend/.env and restart the backend.'));
    await renderLoaded();

    fireEvent.click(generateButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/GEMINI_API_KEY/);
    expect(alert).toHaveTextContent(/diagram below was not changed/i);
    expect(within(screen.getByTestId('erd')).getByText(/Customer/)).toBeInTheDocument(); // unchanged sample
    expect(screen.queryByTestId('erd-entity-owner')).not.toBeInTheDocument();
    expect(screen.getByText(/E-Commerce Database \(sample\)/)).toBeInTheDocument();
    expect(generateButton()).not.toBeDisabled(); // can retry
  });

  it('shows validation problems from a 422 and lets the user retry successfully', async () => {
    api.generateSchema
      .mockResolvedValueOnce(
        errorResponse(422, 'SCHEMA_VALIDATION_FAILED', 'The AI generated a schema that failed validation.', {
          validation: { errors: [{ code: 'MISSING_PRIMARY_KEY', message: "Entity 'Pet' must have at least one primary key attribute" }] },
        })
      )
      .mockResolvedValueOnce(okGenerate());
    await renderLoaded();

    fireEvent.click(generateButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/failed validation/i);
    expect(alert).toHaveTextContent(/Entity 'Pet' must have at least one primary key attribute/);

    fireEvent.click(generateButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-pet')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // error cleared on success
  });

  it('shows a friendly message when the backend is unreachable', async () => {
    api.generateSchema.mockResolvedValue({ status: 0, ok: false, data: { success: false, error: { code: 'NETWORK_ERROR', message: 'Failed to fetch' } } });
    await renderLoaded();
    fireEvent.click(generateButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the schemai backend/i);
  });

  it('survives an unexpected exception from the API layer', async () => {
    api.generateSchema.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderLoaded();
    fireEvent.click(generateButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(generateButton()).not.toBeDisabled();
    spy.mockRestore();
  });

  it('does not call the backend for a blank requirement (button disabled)', async () => {
    await renderLoaded();
    setRequirement('    ');
    expect(generateButton()).toBeDisabled();
    fireEvent.click(generateButton());
    expect(api.generateSchema).not.toHaveBeenCalled();
  });

  it('does not call the backend for an over-long requirement', async () => {
    await renderLoaded();
    setRequirement('x'.repeat(4001));
    expect(generateButton()).toBeDisabled();
    expect(screen.getByText(/4001 \/ 4000 chars/)).toBeInTheDocument();
    expect(api.generateSchema).not.toHaveBeenCalled();
  });

  it('does not silently substitute a default requirement for empty input', async () => {
    await renderLoaded();
    setRequirement('');
    fireEvent.click(generateButton());
    expect(api.generateSchema).not.toHaveBeenCalled();
  });
});

describe('Dashboard: refinement is still an honest placeholder', () => {
  it('shows the backend 501 message instead of claiming success', async () => {
    api.refineSchema.mockResolvedValue(errorResponse(501, 'FEATURE_NOT_IMPLEMENTED', 'Schema refinement is not yet implemented. LLM integration is planned for a later phase.'));
    await renderLoaded();

    fireEvent.change(screen.getByPlaceholderText(/add a payment entity/i), { target: { value: 'Add phone to customer' } });
    fireEvent.click(screen.getByRole('button', { name: /update schema/i }));

    expect(await screen.findByText(/not yet implemented/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('erd')).getByText(/Customer/)).toBeInTheDocument();
  });
});
