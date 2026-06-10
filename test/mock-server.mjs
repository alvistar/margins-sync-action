// Hermetic mock of the Margins CAS sync endpoints for the action E2E.
//
// Implements just enough of the real contract to assert what the composite
// action + pinned margins-cli actually send:
//   GET  /api/workspaces/:id/sync/manifest   -> { data: { files, headSha } }
//   PUT  /api/workspaces/:id/sync/objects/:hash
//   POST /api/workspaces/:id/sync/manifest   -> CAS swap on headSha
//
// OIDC *signature* verification is stubbed (no JWKS in CI), but the token is
// decoded and structurally asserted: three-part JWT, RS256 header, aud exactly
// equal to MOCK_EXPECTED_AUD (single string, no trailing slash). Without this,
// wrong-audience / wrong-env-var bugs in the action pass CI and ship.
//
// Scenario knobs (env):
//   MOCK_PORT             listen port (default 8787)
//   MOCK_EXPECTED_AUD     required aud claim (e.g. http://localhost:8787)
//   MOCK_FAIL_FIRST_POST  "409" -> first manifest POST returns 409 (retry test)
//   MOCK_MAX_FILES        manifest file cap (default 1000)
//   MOCK_STATE_FILE       where to dump received state as JSON on every change
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const EXPECTED_AUD = process.env.MOCK_EXPECTED_AUD ?? `http://localhost:${PORT}`;
const FAIL_FIRST_POST = process.env.MOCK_FAIL_FIRST_POST === "409";
const MAX_FILES = Number(process.env.MOCK_MAX_FILES ?? 1000);
const STATE_FILE = process.env.MOCK_STATE_FILE ?? "/tmp/margins-mock-state.json";

const state = {
  headSha: null,
  files: {},                 // path -> hash (current manifest)
  blobs: {},                 // hash -> byte length
  posts: [],                 // every manifest POST body + outcome
  authSeen: [],              // structural auth assessment per request
  clientHeaderSeen: [],      // X-Margins-Client values
  failedFirstPost: false,
};

function persist() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function assertAuth(req) {
  const auth = req.headers.authorization ?? "";
  const entry = { ok: false, reason: "" };
  if (!auth.startsWith("Bearer ")) {
    entry.reason = "missing-bearer";
  } else {
    const token = auth.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) {
      entry.reason = `not-a-jwt(parts=${parts.length})`;
    } else {
      try {
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        if (header.alg !== "RS256") {
          entry.reason = `alg=${header.alg}`;
        } else if (payload.aud !== EXPECTED_AUD) {
          // Must be a single exact string — arrays and trailing slashes fail.
          entry.reason = `aud=${JSON.stringify(payload.aud)} expected=${EXPECTED_AUD}`;
        } else {
          entry.ok = true;
        }
      } catch {
        entry.reason = "undecodable";
      }
    }
  }
  state.authSeen.push(entry);
  const client = req.headers["x-margins-client"];
  if (client) state.clientHeaderSeen.push(client);
  return entry.ok;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/sync\/(manifest|objects\/([a-f0-9]{64}))$/);
  if (!m) return json(res, 404, { error: { code: "NOT_FOUND" } });

  if (!assertAuth(req)) {
    persist();
    return json(res, 401, { error: { code: "UNAUTHORIZED", message: "structural auth check failed (see mock state)" } });
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  // PUT /sync/objects/:hash
  if (m[3] && req.method === "PUT") {
    state.blobs[m[3]] = body.length;
    persist();
    return json(res, 200, { data: { stored: true } });
  }

  // GET /sync/manifest
  if (m[2] === "manifest" && req.method === "GET") {
    persist();
    return json(res, 200, { data: { files: state.files, headSha: state.headSha } });
  }

  // POST /sync/manifest — mirrors the real route's CAS + validation order
  if (m[2] === "manifest" && req.method === "POST") {
    const parsed = JSON.parse(body.toString());
    const record = { body: parsed, outcome: "" };
    state.posts.push(record);

    const SHA = /^[a-f0-9]{64}$/;
    if (!SHA.test(parsed.commitSha ?? "") || (parsed.parentSha !== null && !SHA.test(parsed.parentSha ?? ""))) {
      record.outcome = "400-bad-sha";
      persist();
      return json(res, 400, { error: { code: "VALIDATION", message: "commitSha/parentSha must be 64-hex sha256" } });
    }
    if (Object.keys(parsed.files ?? {}).length > MAX_FILES) {
      record.outcome = "413-too-many-files";
      persist();
      return json(res, 413, { error: { code: "PAYLOAD_TOO_LARGE" } });
    }
    if (FAIL_FIRST_POST && !state.failedFirstPost) {
      state.failedFirstPost = true;
      record.outcome = "409-injected";
      persist();
      return json(res, 409, { error: { code: "SYNC_STALE_PUSH" } });
    }
    if (parsed.commitSha === state.headSha) {
      record.outcome = "200-idempotent";
      persist();
      return json(res, 200, { data: { idempotent: true } });
    }
    if (parsed.parentSha !== state.headSha) {
      record.outcome = "409-stale";
      persist();
      return json(res, 409, { error: { code: "SYNC_STALE_PUSH" } });
    }
    state.headSha = parsed.commitSha;
    state.files = parsed.files;
    record.outcome = "200-applied";
    persist();
    return json(res, 200, { data: { applied: true } });
  }

  return json(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
});

server.listen(PORT, () => {
  console.log(`mock margins server on :${PORT} (aud=${EXPECTED_AUD})`);
  persist();
});
