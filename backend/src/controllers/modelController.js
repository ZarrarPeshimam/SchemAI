import { modelCatalogService } from "../services/modelCatalogService.js";

/**
 * GET /api/models[?refresh=true]
 *
 * Returns the normalised, filtered Gemini model list discovered server-side through Google's REST API. Response
 * data: { models, defaultModelId, sourceUpdatedAt, stale, refreshError? }. It never contains the API key, provider URLs
 * or raw provider fields. `defaultModelId` is the server's configured default ONLY when the list verifies it.
 *
 * `refresh=true` asks for a re-fetch, but the catalog still throttles upstream calls and coalesces concurrent ones, so
 * browsers cannot cause uncontrolled traffic to Google. If the refresh fails the last good list is returned with
 * `stale: true`; with no list at all a 503 MODEL_LIST_UNAVAILABLE error is returned.
 */
export const listModels = async (req, res, next) => {
  try {
    const forceRefresh = ["true", "1"].includes(String(req.query.refresh ?? "").toLowerCase());
    const data = await modelCatalogService.getCatalog({ forceRefresh });
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
