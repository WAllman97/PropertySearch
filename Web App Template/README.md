# Web App Template

Minimal React + Vite starter extracted from an existing project. Use this as a base for new ideas.

Quick start:

```bash
cd "Web App Template"
npm install
npm run dev
```

Create a new project from this template (option A - GitHub, option B - local copy):

Option A — GitHub template

1. Create a GitHub repository from this template using the "Use this template" button.
2. Clone the new repo and run the quick start above.

Option B — copy locally via `degit`

```bash
npx degit "./Web App Template" my-new-app
cd my-new-app
npm install
npm run dev
```

Environment variables

Copy `.env.example` to `.env` and fill values when using a real backend:

```text
.env.example -> .env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Data service

The default data service is localStorage-backed (`src/services/recordsService.js`). To integrate Supabase, set env vars and swap in the Supabase-mode implementation (see comments in `recordsService.js`).

Automated rename helper

After copying the template to a new folder you can run the helper to replace placeholders in `package.json` and `README.md`:

```bash
npm run rename-template -- --name "My New App" --description "Short description"
```

Alternatively manually update `package.json` fields `name`, `version`, and `description`.

Template config

`template-config.json` contains default placeholder values used by the rename helper; edit it before running the helper if you prefer.

Notes:
- Data uses `localStorage` by default. Swap `src/services/recordsService.js` to integrate a backend like Supabase.
