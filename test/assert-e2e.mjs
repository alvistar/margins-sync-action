// Assertions over the mock server's recorded state. Usage:
//   node test/assert-e2e.mjs <first|deletion|retry> <state-file> <fixture-dir>
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [phase, stateFile, fixtureDir] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const SHA = /^[a-f0-9]{64}$/;

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok    ${msg}`);
  else { console.error(`FAIL  ${msg}`); failures++; }
}

// Shared test vector: synthetic commitSha = sha256 over sorted `path\thash\n`,
// byte-identical to margins-desktop cas_sync.rs and margins-cli cas-sync.ts.
function syntheticSha(files) {
  const lines = Object.keys(files).sort().map((p) => `${p}\t${files[p]}\n`).join("");
  return createHash("sha256").update(lines).digest("hex");
}

function fixtureMdFiles() {
  const out = [];
  (function walk(dir, base) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else out.push(rel);
    }
  })(fixtureDir, "");
  return out.filter((p) => p.endsWith(".md"));
}

// Auth structure held on every request.
check(state.authSeen.length > 0, "auth was presented");
check(state.authSeen.every((a) => a.ok), `every request passed structural JWT checks (${state.authSeen.filter((a) => !a.ok).map((a) => a.reason).join(", ") || "—"})`);
check(state.clientHeaderSeen.some((v) => /^margins-cli\//.test(v)), `X-Margins-Client header present (${state.clientHeaderSeen[0] ?? "missing"})`);

const applied = state.posts.filter((p) => p.outcome === "200-applied");
const lastApplied = applied[applied.length - 1];

if (phase === "first") {
  check(applied.length === 1, "exactly one applied manifest POST");
  check(SHA.test(lastApplied.body.commitSha), "commitSha is 64-hex");
  check(lastApplied.body.parentSha === null, "first push parentSha is null (fetched headSha)");
  check(lastApplied.body.commitSha === syntheticSha(lastApplied.body.files), "commitSha matches the shared synthetic-sha test vector");
  const mdInManifest = Object.keys(lastApplied.body.files).filter((p) => p.endsWith(".md")).sort();
  check(JSON.stringify(mdInManifest) === JSON.stringify(fixtureMdFiles().sort()), "manifest covers exactly the fixture's md files");
  check(Object.values(lastApplied.body.files).every((h) => SHA.test(h)), "all file hashes are 64-hex");
  check(Object.keys(state.blobs).length > 0, "blobs were uploaded");
}

if (phase === "deletion") {
  check(applied.length === 2, "second applied manifest POST recorded");
  check(!Object.keys(lastApplied.body.files).includes("extra.md"), "deleted file absent from the new manifest (full-tree semantics)");
  check(lastApplied.body.parentSha === applied[0].body.commitSha, "second push parentSha equals prior headSha");
}

if (phase === "retry") {
  const injected = state.posts.filter((p) => p.outcome === "409-injected");
  check(injected.length === 1, "injected 409 was served once");
  check(applied.length === 1, "push succeeded after exactly one retry");
  check(state.posts.length === 2, `exactly two manifest POSTs (one 409, one retry) — got ${state.posts.length}`);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`\n${phase}: all assertions passed`);
