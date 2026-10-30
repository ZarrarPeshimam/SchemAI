const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

/**
 * Helper to fetch from SchemAI Backend API
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE_URL}/api${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  try {
    const response = await fetch(url, { ...options, headers });
    const data = await response.json();
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      data: {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: error.message || 'Unable to connect to SchemAI backend',
        },
      },
    };
  }
}

export const api = {
  getHealth: () => request('/health'),
  getSchema: () => request('/schema'),
  validateSchema: (schema) =>
    request('/schema/validate', {
      method: 'POST',
      body: JSON.stringify({ schema }),
    }),
  generateSql: (schema, dialect = 'postgresql') =>
    request('/schema/sql', {
      method: 'POST',
      body: JSON.stringify({ schema, dialect }),
    }),
  /**
   * Model list from SchemAI's backend (which discovers it server-side from Google's REST API and caches it).
   * `refresh: true` asks the backend to re-fetch; the backend still throttles upstream calls.
   */
  getModels: ({ refresh = false } = {}) => request(`/models${refresh ? '?refresh=true' : ''}`),
  /** `model` = canonical Gemini model id captured when the request was started (the backend validates it). */
  generateSchema: (requirement, model = null) =>
    request('/schema/generate', {
      method: 'POST',
      body: JSON.stringify({ requirement, ...(model ? { model } : {}) }),
    }),
  /**
   * `conversation` = { conversationId, schemaVersion } for a saved conversation. In that case the backend uses the
   * schema stored for the conversation (authoritative) and the client schema is deliberately NOT sent. Without a
   * conversation (sample schema / unsaved generation) the current schema is sent and nothing is persisted.
   */
  refineSchema: (schema, instruction, conversation = null, model = null) => {
    const body = conversation?.conversationId
      ? {
          instruction,
          conversationId: conversation.conversationId,
          ...(Number.isInteger(conversation.schemaVersion) ? { schemaVersion: conversation.schemaVersion } : {}),
        }
      : { schema, instruction };
    if (model) body.model = model;
    return request('/schema/refine', { method: 'POST', body: JSON.stringify(body) });
  },
  // Conversation APIs
  listConversations: () => request('/conversations'),
  getConversation: (id) => request(`/conversations/${id}`),
  addMessage: (conversationId, message) =>
    request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(message),
    }),
};
