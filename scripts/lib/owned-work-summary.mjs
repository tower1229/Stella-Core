import { recordOwnedWorkState } from "./sdk-owner-supervisor.mjs";

/** One instance per owning test file. Register before allocating each fixture;
 * publish once from the file's final after hook, after fixture cleanup hooks. */
export function createOwnedWorkSummary() {
  const fixtures = new Set(); let publication;
  return {
    register() {
      if (publication) throw new Error("owned_work_summary_sealed");
      const cell = { result: null }; fixtures.add(cell);
      return {
        finish({ pending = 0, stopFailures = 0, pendingFailures = 0 } = {}) {
          if (publication || cell.result) throw new Error("owned_fixture_already_finished_or_sealed");
          if (![pending, stopFailures, pendingFailures].every(value => Number.isSafeInteger(value) && value >= 0))
            throw new Error("owned_fixture_result_invalid");
          cell.result = { pending, stopFailures, pendingFailures };
        },
      };
    },
    publish() {
      return publication ??= (async () => {
        const total = { pending: 0, stopFailures: 0, pendingFailures: 0 };
        for (const { result } of fixtures) {
          if (!result) total.pending++;
          else for (const key of Object.keys(total)) total[key] += result[key];
        }
        await recordOwnedWorkState({ status: Object.values(total).some(Boolean) ? "shutdown_failed" : "complete", ...total });
        return total;
      })();
    },
  };
}
