// Checks before every build, so a broken deploy fails here instead of live.
//
// 1. Vercel's Hobby plan deploys at most 12 serverless functions: every .js
//    file directly in api/ (files starting with "_" aren't routes). Going
//    over fails the production deploy. Add new endpoints as actions on an
//    existing route (see api/lookup.js).
// 2. Vercel turns api/ files into CommonJS, so a top-level `import x from
//    "pkg"` becomes require("pkg"). If require gets a file other than the
//    package's import file or its "main", Vercel doesn't ship it and the route
//    crashes on every request ("Cannot find module"). That took down
//    /api/agent-signup on 26-27 Nov (ical.js). Load such packages with
//    `await import("pkg")` inside the function that needs them instead.
import { readdirSync, readFileSync, existsSync } from "node:fs";

const apiDir = new URL("../api/", import.meta.url);
const LIMIT = 12;
const routes = readdirSync(apiDir).filter((f) => f.endsWith(".js") && !f.startsWith("_"));
if (routes.length > LIMIT) {
  console.error(
    `api/ has ${routes.length} functions; Vercel Hobby allows ${LIMIT}. ` +
      "Fold the new endpoint into an existing route as an action (see api/lookup.js)."
  );
  process.exit(1);
}
console.log(`api/ functions: ${routes.length}/${LIMIT}`);

// The file a package's "." entry resolves to under one condition.
function entryFor(exports, condition) {
  let entry = exports && typeof exports === "object" && "." in exports ? exports["."] : exports;
  for (let depth = 0; entry && typeof entry === "object" && depth < 5; depth++) {
    entry = entry[condition] ?? entry.node ?? entry.default;
  }
  return typeof entry === "string" ? entry : null;
}

const problems = [];
const files = [
  ...routes.map((f) => new URL(f, apiDir)),
  ...readdirSync(new URL("_lib/", apiDir)).filter((f) => f.endsWith(".js")).map((f) => new URL(`_lib/${f}`, apiDir)),
];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const [, pkg] of source.matchAll(/^import\s[^;]*?\sfrom\s+["']([^./"'][^"']*)["']/gm)) {
    if (pkg.startsWith("node:")) continue;
    const name = pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split("/")[0];
    const manifest = new URL(`../node_modules/${name}/package.json`, import.meta.url);
    if (!existsSync(manifest)) continue;
    const { exports, main } = JSON.parse(readFileSync(manifest, "utf8"));
    const forImport = entryFor(exports, "import");
    const forRequire = entryFor(exports, "require");
    // Vercel ships the import file and "main"; require() is only safe if it
    // asks for one of those.
    const shipped = [forImport, main].filter(Boolean).map((f) => f.replace(/^\.\//, ""));
    if (forImport && forRequire && !shipped.includes(forRequire.replace(/^\.\//, ""))) {
      problems.push(`${file.pathname.split("/api/")[1]}: top-level import of "${pkg}"`);
    }
  }
}
if (problems.length) {
  console.error(
    "These would crash on Vercel (require() would ask for a file Vercel doesn't ship):\n  " +
      problems.join("\n  ") +
      '\nLoad the package with `await import("...")` inside the function that uses it.'
  );
  process.exit(1);
}
