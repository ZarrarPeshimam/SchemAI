import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunnableLambda } from "@langchain/core/runnables";
import { RefinementChain } from "../src/services/refinement/refinementChain.js";
import { findUnsupportedRefs } from "../src/services/refinement/providerSchema.js";
import { mockSchema } from "../src/data/mockSchema.js";

/** What RefinementChain really passes to LangChain's withStructuredOutput (the object that becomes the Gemini request). */
describe("RefinementChain -> withStructuredOutput", () => {
  it("passes a plain, $ref-free JSON Schema (not a Zod object) and still returns the validated proposal", async () => {
    const captured = [];
    const chain = new RefinementChain();
    chain.model = {
      withStructuredOutput: (schema, options) => {
        captured.push({ schema, options });
        return RunnableLambda.from(async () => ({ outcome: "needs_clarification", message: "Which address?", operations: null }));
      },
    };
    const result = await chain.propose({ schema: mockSchema, instruction: "Remove the address" });

    assert.equal(result.ok, true);
    assert.equal(result.response.outcome, "needs_clarification");
    assert.equal(captured.length, 1);
    const { schema, options } = captured[0];
    assert.equal(options.name, "schema_change_proposal");
    assert.equal(typeof schema, "object");
    assert.equal("_def" in schema || "safeParse" in schema, false, "must be plain JSON Schema, not a Zod schema");
    assert.deepEqual(findUnsupportedRefs(schema), []);
    assert.equal(schema.type, "object");
  });
});
