// Vercel's Hobby plan deploys at most 12 serverless functions: every .js
// file directly in api/ (files starting with "_" aren't routes). Going over
// fails the production deploy, so fail the build here first.
// Add new endpoints as actions on an existing route (see api/lookup.js).
import { readdirSync } from "node:fs";

const LIMIT = 12;
const routes = readdirSync(new URL("../api/", import.meta.url)).filter(
  (f) => f.endsWith(".js") && !f.startsWith("_")
);
if (routes.length > LIMIT) {
  console.error(
    `api/ has ${routes.length} functions; Vercel Hobby allows ${LIMIT}. ` +
      "Fold the new endpoint into an existing route as an action (see api/lookup.js)."
  );
  process.exit(1);
}
console.log(`api/ functions: ${routes.length}/${LIMIT}`);
