import { modelCatalogService } from "../../src/services/modelCatalogService.js";
import { geminiService, DEFAULT_GEMINI_MODEL } from "../../src/services/geminiService.js";

/** Models the seeded test catalog reports (compatible text models). Tests may select any of these. */
export const TEST_MODEL_IDS = [DEFAULT_GEMINI_MODEL, "test-model-x", "gemini-test-model", "gemini-a", "gemini-b"];

const rawModel = (id) => ({
  name: `models/${id}`,
  displayName: id,
  supportedGenerationMethods: ["generateContent"],
});

/**
 * Test setup: primes the shared catalog (so no test performs a real model-list request) and disables retry delays so
 * provider-error tests stay fast and deterministic. Call from beforeEach.
 */
export function useTestModelCatalog({ ids = TEST_MODEL_IDS, retry = { maxRetries: 0 } } = {}) {
  modelCatalogService.reset();
  modelCatalogService.seed(ids.map(rawModel));
  geminiService.retry = retry;
}

export function resetTestModelCatalog() {
  modelCatalogService.reset();
  geminiService.retry = {};
}
