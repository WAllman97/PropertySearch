// Proof that a request came from one of our own GitHub Actions workflows,
// with no shared secret anywhere. The workflow asks GitHub for a short-lived
// token (an OpenID Connect JWT, signed by GitHub, valid for minutes) and
// sends it as  Authorization: Bearer <token>. We check GitHub's signature
// against GitHub's published public keys, then that it was issued for this
// repository, this workflow file, the main branch and our audience.
//
// A fork or any other repository gets a token naming *its* repository, so
// it can't pass. Nothing here is secret: the keys are public.
import { createPublicKey, verify } from "node:crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
// Our repository. Overridable if the repo is ever renamed or moved.
const REPOSITORY = process.env.GITHUB_REPOSITORY_ALLOWED || "WAllman97/PropertySearch";
const LEEWAY_S = 60;

// GitHub's keys, cached per server instance and refetched when a token is
// signed with one we haven't seen (GitHub rotates them now and then).
let keys = null;
let fetchedAt = 0;

async function githubKey(kid) {
  const fresh = Date.now() - fetchedAt < 10 * 60000;
  if (!keys?.has(kid) && !fresh) {
    const response = await fetch(JWKS_URL);
    if (!response.ok) throw new Error(`GitHub keys: HTTP ${response.status}`);
    const { keys: list } = await response.json();
    keys = new Map((list || []).filter((k) => k.kid && k.kty === "RSA").map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]));
    fetchedAt = Date.now();
  }
  return keys?.get(kid) || null;
}

const fromB64url = (part) => Buffer.from(part, "base64url");

// -> the token's claims if it's a valid GitHub token for this repository's
// `workflow` file on main, with this audience; otherwise null.
export async function verifyGithubWorkflow(req, { workflow, audience }) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let head, claims;
  try {
    head = JSON.parse(fromB64url(parts[0]).toString("utf8"));
    claims = JSON.parse(fromB64url(parts[1]).toString("utf8"));
  } catch {
    return null;
  }
  if (head.alg !== "RS256" || !head.kid) return null;

  const key = await githubKey(head.kid).catch((error) => {
    console.error("Couldn't fetch GitHub's keys:", error);
    return null;
  });
  if (!key) return null;
  const signed = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
  if (!signed) return null;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const ok =
    claims.iss === ISSUER &&
    audiences.includes(audience) &&
    typeof claims.exp === "number" && claims.exp + LEEWAY_S > now &&
    (claims.nbf === undefined || claims.nbf - LEEWAY_S <= now) &&
    claims.repository === REPOSITORY &&
    claims.ref === "refs/heads/main" &&
    claims.workflow_ref === `${REPOSITORY}/.github/workflows/${workflow}@refs/heads/main` &&
    ["schedule", "workflow_dispatch"].includes(claims.event_name);
  return ok ? claims : null;
}
