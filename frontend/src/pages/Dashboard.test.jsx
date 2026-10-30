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
    getConversation: vi.fn(),
    generateSql: vi.fn(),
    getHealth: vi.fn(),
    getModels: vi.fn(),
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

const TEST_MODEL = 'gemini-test-flash';
const catalogResponse = (overrides = {}) => ({
  status: 200,
  ok: true,
  data: {
    success: true,
    data: {
      models: [
        { id: TEST_MODEL, displayName: 'Test Flash', channel: 'stable', capabilities: { generateContent: true, structuredOutput: 'unverified' } },
        { id: 'gemini-test-pro', displayName: 'Test Pro', channel: 'stable', capabilities: { generateContent: true, structuredOutput: 'unverified' } },
      ],
      defaultModelId: TEST_MODEL,
      sourceUpdatedAt: '2026-10-20T00:00:00.000Z',
      stale: false,
      ...overrides,
    },
  },
});

async function renderLoaded() {
  render(<Dashboard />);
  await screen.findByTestId('erd');
  // The model selector resolves its selection asynchronously; requests need it.
  await waitFor(() => expect(screen.getByTestId('model-selector-trigger')).toHaveTextContent('Test Flash'));
}

const generateButton = () => screen.getByRole('button', { name: /generat/i });
const setRequirement = (text) => fireEvent.change(screen.getByLabelText(/natural language specification/i), { target: { value: text } });

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  api.getModels.mockResolvedValue(catalogResponse());
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
    expect(api.generateSchema).toHaveBeenCalledWith('A veterinary clinic with owners and pets', TEST_MODEL);

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

const refineInput = () => screen.getByLabelText(/refinement instruction/i);
const refineButton = () => screen.getByRole('button', { name: /update schema|updating/i });
const setInstruction = (text) => fireEvent.change(refineInput(), { target: { value: text } });

const refinedSchema = {
  entities: [
    { id: 'customer', name: 'Customer', description: 'sample', attributes: [attr('customer_id', { primaryKey: true }), attr('salary', { type: 'DECIMAL' })] },
    { id: 'department', name: 'Department', description: 'd', attributes: [attr('department_id', { primaryKey: true })] },
  ],
  relationships: [{ id: 'department_customer', source: 'department', target: 'customer', name: 'has', cardinality: '1:N' }],
};

const okRefine = (overrides = {}) => ({
  status: 200,
  ok: true,
  data: {
    success: true,
    data: {
      status: 'applied',
      schema: refinedSchema,
      validation: { ...generatedValidation, summary: { ...generatedValidation.summary, entityCount: 2 } },
      summary: { message: 'Added salary and a Department entity.', changes: ['Added attribute Customer.salary (DECIMAL).', 'Added entity Department with 1 attribute(s): department_id.'] },
      repairAttempts: 0,
      ...overrides,
    },
  },
});

describe('Dashboard: natural-language schema refinement', () => {
  it('sends the CURRENT schema and the trimmed instruction, then re-renders the diagram with the accepted schema', async () => {
    api.refineSchema.mockResolvedValue(okRefine());
    await renderLoaded();

    setInstruction('  Add a salary attribute and a Department entity  ');
    fireEvent.click(refineButton());

    await waitFor(() => expect(screen.getByTestId('erd-entity-department')).toBeInTheDocument());
    expect(api.refineSchema).toHaveBeenCalledTimes(1);
    expect(api.refineSchema).toHaveBeenCalledWith(sampleSchema, 'Add a salary attribute and a Department entity', null, TEST_MODEL);

    const erd = screen.getByTestId('erd');
    expect(within(erd).getByText(/Customer: customer_id,salary/)).toBeInTheDocument();
    expect(screen.getByTestId('erd-rel-department_customer')).toHaveTextContent('department-1:N-customer');
    expect(screen.getByText('Refined Schema')).toBeInTheDocument();

    const summary = screen.getByTestId('refinement-summary');
    expect(summary).toHaveTextContent('Added salary and a Department entity.');
    expect(summary).toHaveTextContent('Added attribute Customer.salary (DECIMAL).');
    expect(refineInput()).toHaveValue(''); // accepted -> input cleared
    expect(api.generateSchema).not.toHaveBeenCalled();
  });

  it('chains refinements: the next request carries the previously accepted schema', async () => {
    api.refineSchema.mockResolvedValueOnce(okRefine()).mockResolvedValueOnce(okRefine({ summary: { message: 'Second', changes: [] } }));
    await renderLoaded();

    setInstruction('first');
    fireEvent.click(refineButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-department')).toBeInTheDocument());

    setInstruction('second');
    fireEvent.click(refineButton());
    await waitFor(() => expect(api.refineSchema).toHaveBeenCalledTimes(2));
    expect(api.refineSchema.mock.calls[1][0]).toEqual(refinedSchema);
  });

  it('shows a loading state, disables the controls and ignores duplicate submits while refining', async () => {
    const pending = deferred();
    api.refineSchema.mockReturnValue(pending.promise);
    await renderLoaded();

    setInstruction('Add salary');
    const btn = refineButton();
    act(() => {
      fireEvent.click(btn);
      fireEvent.click(btn); // same tick, before React re-renders
    });

    await waitFor(() => expect(refineButton()).toBeDisabled());
    expect(refineButton()).toHaveTextContent(/updating/i);
    expect(refineInput()).toBeDisabled();
    expect(screen.getByTestId('refinement-progress')).toBeInTheDocument();
    expect(api.refineSchema).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('erd')).queryByText(/Department/)).not.toBeInTheDocument(); // not updated yet

    pending.resolve(okRefine());
    await waitFor(() => expect(screen.getByTestId('erd-entity-department')).toBeInTheDocument());
    expect(refineButton()).toHaveTextContent(/update schema/i);
  });

  it('shows a clarification question without changing the diagram, and keeps the instruction for editing', async () => {
    api.refineSchema.mockResolvedValue({
      status: 200,
      ok: true,
      data: { success: true, data: { status: 'needs_clarification', message: 'Which entity should get the new attribute?' } },
    });
    await renderLoaded();

    setInstruction('Add a name');
    fireEvent.click(refineButton());

    const box = await screen.findByTestId('refinement-clarification');
    expect(box).toHaveTextContent('Which entity should get the new attribute?');
    expect(box).toHaveTextContent(/nothing was changed/i);
    expect(within(screen.getByTestId('erd')).getByText(/Customer: customer_id$/)).toBeInTheDocument();
    expect(screen.getByText(/E-Commerce Database \(sample\)/)).toBeInTheDocument();
    expect(refineInput()).toHaveValue('Add a name');
  });

  it('shows validation failures from a 422, keeps the original schema, and allows a retry that succeeds', async () => {
    api.refineSchema
      .mockResolvedValueOnce(
        errorResponse(422, 'REFINEMENT_FAILED', 'The requested change could not be applied without breaking schema validation. Your schema was not changed.', {
          details: ["INVALID_FOREIGN_KEY_TARGET_ENTITY: Foreign key 'ghost_id' in entity 'Customer' references non-existent entity 'ghost'"],
        })
      )
      .mockResolvedValueOnce(okRefine());
    await renderLoaded();

    setInstruction('Link customer to ghost');
    fireEvent.click(refineButton());

    const alert = await screen.findByTestId('refinement-error');
    expect(alert).toHaveTextContent(/could not be applied/i);
    expect(alert).toHaveTextContent(/non-existent entity 'ghost'/);
    expect(alert).toHaveTextContent(/diagram was not changed/i);
    expect(within(screen.getByTestId('erd')).getByText(/Customer: customer_id$/)).toBeInTheDocument();
    expect(refineInput()).toHaveValue('Link customer to ghost');

    setInstruction('Add salary');
    fireEvent.click(refineButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-department')).toBeInTheDocument());
    expect(screen.queryByTestId('refinement-error')).not.toBeInTheDocument();
  });

  it('shows Gemini/provider errors (e.g. rate limit) without touching the diagram', async () => {
    api.refineSchema.mockResolvedValue(errorResponse(429, 'RATE_LIMIT_EXCEEDED', 'The AI service is rate-limited or over quota right now. Please wait a moment and try again.'));
    await renderLoaded();
    setInstruction('Add salary');
    fireEvent.click(refineButton());
    expect(await screen.findByTestId('refinement-error')).toHaveTextContent(/rate-limited/i);
    expect(screen.queryByTestId('erd-entity-department')).not.toBeInTheDocument();
  });

  it('never updates the diagram from a success-shaped response that carries no schema', async () => {
    api.refineSchema.mockResolvedValue({ status: 200, ok: true, data: { success: true, data: { status: 'applied' } } });
    await renderLoaded();
    setInstruction('Add salary');
    fireEvent.click(refineButton());
    expect(await screen.findByTestId('refinement-error')).toBeInTheDocument();
    expect(within(screen.getByTestId('erd')).getByText(/Customer: customer_id$/)).toBeInTheDocument();
  });

  it('shows a friendly message when the backend is unreachable, and survives API-layer exceptions', async () => {
    api.refineSchema.mockResolvedValueOnce({ status: 0, ok: false, data: { success: false, error: { code: 'NETWORK_ERROR', message: 'Failed to fetch' } } });
    await renderLoaded();
    setInstruction('Add salary');
    fireEvent.click(refineButton());
    expect(await screen.findByTestId('refinement-error')).toHaveTextContent(/could not reach the schemai backend/i);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.refineSchema.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(refineButton());
    await waitFor(() => expect(screen.getByTestId('refinement-error')).toHaveTextContent(/something went wrong/i));
    expect(refineButton()).not.toBeDisabled();
    spy.mockRestore();
  });

  it('does not call the backend for a blank or over-long instruction (button disabled)', async () => {
    await renderLoaded();
    expect(refineButton()).toBeDisabled();
    setInstruction('     ');
    expect(refineButton()).toBeDisabled();
    setInstruction('x'.repeat(1001));
    expect(refineButton()).toBeDisabled();
    expect(screen.getByText(/1001 \/ 1000 characters/)).toBeInTheDocument();
    expect(api.refineSchema).not.toHaveBeenCalled();
  });

  it('keeps initial generation working after a refinement (and clears the old refinement summary)', async () => {
    api.refineSchema.mockResolvedValue(okRefine());
    api.generateSchema.mockResolvedValue(okGenerate());
    await renderLoaded();

    setInstruction('Add salary');
    fireEvent.click(refineButton());
    await waitFor(() => expect(screen.getByTestId('refinement-summary')).toBeInTheDocument());

    setRequirement('A veterinary clinic');
    fireEvent.click(generateButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument());
    expect(api.generateSchema).toHaveBeenCalledWith('A veterinary clinic', TEST_MODEL);
    expect(screen.queryByTestId('refinement-summary')).not.toBeInTheDocument();
    expect(screen.getByText('Generated Schema')).toBeInTheDocument();
  });

  it('refines a generated schema using that schema as the base', async () => {
    api.generateSchema.mockResolvedValue(okGenerate());
    api.refineSchema.mockResolvedValue(okRefine());
    await renderLoaded();
    setRequirement('A veterinary clinic');
    fireEvent.click(generateButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument());

    setInstruction('Add salary');
    fireEvent.click(refineButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-department')).toBeInTheDocument());
    expect(api.refineSchema.mock.calls[0][0]).toEqual(generatedSchema);
  });
});

describe('Dashboard: refinement of a saved conversation', () => {
  const CONV = '64b7f0c2a1b2c3d4e5f60718';
  const savedGenerate = () => okGenerate({ conversationId: CONV, schemaVersion: 1 });

  async function generateSaved() {
    api.generateSchema.mockResolvedValue(savedGenerate());
    await renderLoaded();
    setRequirement('A veterinary clinic');
    fireEvent.click(generateButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument());
  }

  it('sends conversationId + schemaVersion (not the schema) and tracks the version the backend returns', async () => {
    api.refineSchema.mockResolvedValueOnce(okRefine({ schemaVersion: 2, persisted: true, conversationId: CONV })).mockResolvedValueOnce(okRefine({ schemaVersion: 3, persisted: true }));
    await generateSaved();

    setInstruction('Add salary');
    fireEvent.click(refineButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-department')).toBeInTheDocument());
    expect(api.refineSchema).toHaveBeenNthCalledWith(1, generatedSchema, 'Add salary', { conversationId: CONV, schemaVersion: 1 }, TEST_MODEL);

    setInstruction('Add more');
    fireEvent.click(refineButton());
    await waitFor(() => expect(api.refineSchema).toHaveBeenCalledTimes(2));
    expect(api.refineSchema.mock.calls[1][2]).toEqual({ conversationId: CONV, schemaVersion: 2 });
  });

  it('does not change the diagram when the backend rejects the change (previous schema preserved)', async () => {
    api.refineSchema.mockResolvedValue(errorResponse(422, 'REFINEMENT_FAILED', 'Your schema was not changed.'));
    await generateSaved();
    setInstruction('Break everything');
    fireEvent.click(refineButton());
    expect(await screen.findByTestId('refinement-error')).toHaveTextContent(/not changed/i);
    expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument();
    expect(screen.queryByTestId('erd-entity-department')).not.toBeInTheDocument();
  });

  it('on a version conflict reloads the latest stored schema and asks the user to repeat the instruction', async () => {
    const latest = { ...generatedSchema, entities: [...generatedSchema.entities, { id: 'tag', name: 'Tag', description: '', attributes: [attr('tag_id', { primaryKey: true })] }] };
    api.refineSchema.mockResolvedValue(errorResponse(409, 'SCHEMA_VERSION_CONFLICT', 'changed'));
    api.getConversation.mockResolvedValue({ status: 200, ok: true, data: { success: true, data: { _id: CONV, schema: latest, schemaVersion: 5 } } });
    await generateSaved();

    setInstruction('Add salary');
    fireEvent.click(refineButton());
    await waitFor(() => expect(screen.getByTestId('erd-entity-tag')).toBeInTheDocument());
    expect(api.getConversation).toHaveBeenCalledWith(CONV);
    expect(screen.getByTestId('refinement-error')).toHaveTextContent(/latest schema has been reloaded/i);
  });
});


describe('Dashboard: Gemini model selection', () => {
  const sel = () => screen.getByTestId('model-selector-trigger');

  it('first visit: selects the backend-verified default and saves only its canonical id', async () => {
    await renderLoaded();
    expect(sel()).toHaveTextContent('Test Flash');
    expect(window.localStorage.getItem('schemai:selectedGeminiModel')).toBe(TEST_MODEL);
  });

  it('first visit with no verified default: shows "Select model", saves nothing and blocks requests until chosen', async () => {
    api.getModels.mockResolvedValue(catalogResponse({ defaultModelId: null }));
    render(<Dashboard />);
    await screen.findByTestId('erd');
    await waitFor(() => expect(sel()).toHaveTextContent('Select model'));
    expect(window.localStorage.getItem('schemai:selectedGeminiModel')).toBeNull();

    setRequirement('A veterinary clinic');
    fireEvent.click(generateButton());
    expect(await screen.findByText(/select a gemini model/i)).toBeInTheDocument();
    expect(api.generateSchema).not.toHaveBeenCalled();
  });

  it('restores a saved model that is still listed', async () => {
    window.localStorage.setItem('schemai:selectedGeminiModel', 'gemini-test-pro');
    render(<Dashboard />);
    await screen.findByTestId('erd');
    await waitFor(() => expect(sel()).toHaveTextContent('Test Pro'));
  });

  it('a saved model that is no longer listed is NOT silently replaced: shows a message and "Select model"', async () => {
    window.localStorage.setItem('schemai:selectedGeminiModel', 'retired-model');
    render(<Dashboard />);
    await screen.findByTestId('erd');
    await waitFor(() => expect(sel()).toHaveTextContent('Select model'));
    expect(screen.getByText('Your saved model is no longer available. Please select another model.')).toBeInTheDocument();
    expect(window.localStorage.getItem('schemai:selectedGeminiModel')).toBeNull();
  });

  it('an invalid saved value is ignored and replaced by the verified default', async () => {
    window.localStorage.setItem('schemai:selectedGeminiModel', '{"not":"an id"}');
    render(<Dashboard />);
    await screen.findByTestId('erd');
    await waitFor(() => expect(sel()).toHaveTextContent('Test Flash'));
    expect(window.localStorage.getItem('schemai:selectedGeminiModel')).toBe(TEST_MODEL);
  });

  it('when the list cannot be loaded, keeps the saved id as unverified (not erased) and shows the problem', async () => {
    window.localStorage.setItem('schemai:selectedGeminiModel', 'gemini-test-pro');
    api.getModels.mockResolvedValue({ status: 0, ok: false, data: { success: false, error: { code: 'NETWORK_ERROR', message: 'Failed to fetch' } } });
    render(<Dashboard />);
    await screen.findByTestId('erd');
    await waitFor(() => expect(sel()).toHaveTextContent('gemini-test-pro'));
    expect(screen.getByText(/could not be verified/i)).toBeInTheDocument();
    expect(window.localStorage.getItem('schemai:selectedGeminiModel')).toBe('gemini-test-pro');
  });

  it('list unavailable and nothing saved: shows an unavailable state with a retry that reloads the list', async () => {
    api.getModels.mockResolvedValueOnce({ status: 503, ok: false, data: { success: false, error: { code: 'MODEL_LIST_UNAVAILABLE', message: 'The list of available AI models could not be loaded.' } } });
    render(<Dashboard />);
    await screen.findByTestId('erd');
    await waitFor(() => expect(sel()).toHaveTextContent('Models unavailable'));
    api.getModels.mockResolvedValue(catalogResponse());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sel()).toHaveTextContent('Test Flash'));
    expect(api.getModels).toHaveBeenLastCalledWith({ refresh: true });
  });

  it('shows a subtle stale-list indication when the backend served a cached list', async () => {
    api.getModels.mockResolvedValue(catalogResponse({ stale: true, refreshError: { code: 'MODEL_LIST_NETWORK_ERROR', message: 'x' } }));
    await renderLoaded();
    expect(screen.getByText(/could not refresh availability/i)).toBeInTheDocument();
  });

  it('selecting another model updates the display, persists its id and is used by the next request', async () => {
    api.generateSchema.mockResolvedValue(okGenerate());
    await renderLoaded();

    fireEvent.click(sel());
    fireEvent.click(await screen.findByRole('option', { name: /Test Pro/ }));
    expect(sel()).toHaveTextContent('Test Pro');
    expect(window.localStorage.getItem('schemai:selectedGeminiModel')).toBe('gemini-test-pro');

    setRequirement('A veterinary clinic');
    fireEvent.click(generateButton());
    await waitFor(() => expect(api.generateSchema).toHaveBeenCalledWith('A veterinary clinic', 'gemini-test-pro'));
  });

  it('changing the model while a request is in flight does not change that request', async () => {
    const pending = deferred();
    api.generateSchema.mockReturnValue(pending.promise);
    await renderLoaded();

    setRequirement('A veterinary clinic');
    fireEvent.click(generateButton());
    await waitFor(() => expect(api.generateSchema).toHaveBeenCalledTimes(1));

    fireEvent.click(sel());
    fireEvent.click(await screen.findByRole('option', { name: /Test Pro/ }));
    expect(api.generateSchema).toHaveBeenCalledWith('A veterinary clinic', TEST_MODEL);

    pending.resolve(okGenerate());
    await waitFor(() => expect(screen.getByTestId('erd-entity-owner')).toBeInTheDocument());
  });

  it('refinement uses the selected model too', async () => {
    api.refineSchema.mockResolvedValue({ status: 200, ok: true, data: { success: true, data: { status: 'needs_clarification', message: 'Which one?' } } });
    await renderLoaded();
    fireEvent.click(sel());
    fireEvent.click(await screen.findByRole('option', { name: /Test Pro/ }));
    fireEvent.change(screen.getByLabelText('Refinement instruction'), { target: { value: 'Add salary' } });
    fireEvent.click(refineButton());
    await waitFor(() => expect(api.refineSchema).toHaveBeenCalledTimes(1));
    expect(api.refineSchema.mock.calls[0][3]).toBe('gemini-test-pro');
  });

  it('keyboard: Escape closes the list and ArrowDown + Enter selects', async () => {
    await renderLoaded();
    fireEvent.click(sel());
    const list = await screen.findByRole('listbox');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(sel());
    const list2 = await screen.findByRole('listbox');
    fireEvent.keyDown(list2, { key: 'ArrowDown' });
    fireEvent.keyDown(list2, { key: 'Enter' });
    await waitFor(() => expect(sel()).toHaveTextContent('Test Pro'));
  });
});
