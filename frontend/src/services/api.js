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
  generateSchema: (requirement) =>
    request('/schema/generate', {
      method: 'POST',
      body: JSON.stringify({ requirement }),
    }),
  refineSchema: (schema, instruction) =>
    request('/schema/refine', {
      method: 'POST',
      body: JSON.stringify({ schema, instruction }),
    }),
};
