import { indexRepository, getSource } from "../src/lib/nia";

const REPO = "supabase/supabase-js";
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 30 * 60 * 1000;

async function main() {
  console.log(`Submitting ${REPO} to Nia for indexing...`);
  const created = await indexRepository(REPO);
  console.log(`Source created: id=${created.id} status=${created.status}`);

  const start = Date.now();
  let last = created.status;
  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const current = await getSource(created.id);
    if (current.status !== last) {
      console.log(`Status: ${current.status}`);
      last = current.status;
    }
    if (["completed", "ready", "indexed"].includes(current.status)) {
      console.log(`\nDone. Source ID: ${current.id}`);
      console.log(`Identifier (use in /search): ${current.identifier}`);
      return;
    }
    if (current.status === "failed") {
      throw new Error(`Indexing failed for ${REPO}`);
    }
  }
  throw new Error(`Indexing did not complete within ${MAX_WAIT_MS / 1000}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
