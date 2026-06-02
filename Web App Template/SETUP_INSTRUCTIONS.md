Setup and verification

1. Install dependencies:

```bash
cd "Web App Template"
npm install
```

2. Run the dev server:

```bash
npm run dev
```

3. Open the URL shown (default http://localhost:5173).

4. Copy `.env.example` to `.env` and add backend credentials if using Supabase.

```bash
cp .env.example .env
```

5. Optional: use the rename helper to set project name/description:

```bash
npm run rename-template -- --name "My New App" --description "Short description"
```

6. To switch to Supabase-backed data, open `src/services/recordsService.js`, follow the commented instructions and enable the Supabase code path.
