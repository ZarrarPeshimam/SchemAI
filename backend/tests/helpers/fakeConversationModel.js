/**
 * In-memory FAKE of the Mongoose Conversation model, mimicking only the operations the refinement code uses
 * (findById/select/lean, conditional findOneAndUpdate with $set/$push, updateOne $push).
 * It is a test double: it does NOT prove the behaviour of a real MongoDB server.
 *
 * `hooks` lets a test simulate trouble: `beforeCommit(store)` runs right before the conditional write (use it to
 * simulate a concurrent writer), `failCommit` / `failLoad` make the respective call throw.
 */
export const clone = (v) => structuredClone(v);

export function makeFakeModel(initial) {
  const store = new Map(initial.map((d) => [String(d._id), clone(d)]));
  const calls = { findOneAndUpdate: 0, updateOne: 0 };
  const hooks = { beforeCommit: null, failCommit: false, failLoad: false };

  const applyUpdate = (doc, update) => {
    if (update.$set) Object.assign(doc, clone(update.$set));
    if (update.$push) for (const [k, v] of Object.entries(update.$push)) doc[k].push(...clone(v.$each ?? [v]));
  };

  return {
    store,
    calls,
    hooks,
    findById(id) {
      return {
        select() {
          return this;
        },
        async lean() {
          if (hooks.failLoad) throw new Error("load boom");
          const doc = store.get(String(id));
          return doc ? clone(doc) : null;
        },
      };
    },
    findOneAndUpdate(filter, update) {
      calls.findOneAndUpdate++;
      return {
        async lean() {
          if (hooks.beforeCommit) hooks.beforeCommit(store);
          if (hooks.failCommit) throw new Error("write boom");
          const doc = store.get(String(filter._id));
          if (!doc) return null;
          // `null` in a Mongo filter matches a missing field too.
          if ("schemaVersion" in filter && (doc.schemaVersion ?? null) !== filter.schemaVersion) return null;
          applyUpdate(doc, update);
          return { _id: doc._id, schemaVersion: doc.schemaVersion };
        },
      };
    },
    async updateOne(filter, update) {
      calls.updateOne++;
      const doc = store.get(String(filter._id));
      if (!doc) return { matchedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1 };
    },
  };
}
