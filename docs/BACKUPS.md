# Backups

Supabase's free plan keeps no backups. Until the project moves to Supabase
Pro (daily backups included), a GitHub workflow makes one every night.

## What's backed up

`.github/workflows/nightly-backup.yml`, at 02:30 UTC every night:

- **The database:** every app table (properties, notes, households, agents,
  listings, viewings, offers, buying positions, searches...), plus the
  logins (`auth.users`, `auth.identities`) and the file index.
- **Uploaded files:** everything in Supabase Storage (buyers' mortgage
  agreements and proof of funds).

It's encrypted (AES-256, with your `BACKUP_PASSPHRASE`) and kept as a
workflow artifact for **30 days**. Older ones delete themselves. If a night's
run fails, GitHub emails you.

**Without the passphrase, the backups can't be opened.** Keep it in your
password manager, not only in GitHub (GitHub never shows a secret again).

## One-time setup: two GitHub secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**:

1. **`SUPABASE_DB_URL`**: in Supabase, click **Connect** (top of the
   project), choose **Session pooler**, copy the **URI**. It looks like
   `postgresql://postgres.<project>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with the database password. Forgotten it?
   Supabase → **Project Settings** → **Database** → **Reset database
   password**: safe to do, the app itself only uses API keys.
   (Use the *session* pooler: the direct connection doesn't work from
   GitHub, and the transaction pooler can't run backups.)
2. **`BACKUP_PASSPHRASE`**: a long random passphrase. Save it in your
   password manager first.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already there.

## Getting a backup

Repo → **Actions** → **Nightly Backup** → a run → **Artifacts** →
`backup-YYYY-MM-DD`. It downloads as a zip containing
`viewpal-backup-YYYY-MM-DD.tar.gz.gpg`.

Decrypt and unpack (Git Bash on Windows, or a Mac terminal):

```
gpg --decrypt viewpal-backup-YYYY-MM-DD.tar.gz.gpg > backup.tar.gz
mkdir backup && tar -xzf backup.tar.gz -C backup
```

Inside: `database.dump` (the app's tables, data, functions and policies),
`logins-and-files-index.dump` (logins and the storage index), both
Postgres custom format; `contents.txt` (what's in them) and `files/`
(uploaded documents, by bucket and path).

## Restoring

Ask for help with this the first time; the outline:

1. **Into a new Supabase project** (if the old one is lost): create it, run
   the migrations in `backend/migrations` in order (001 → latest) in the SQL
   editor, then load the data only:
   ```
   pg_restore --data-only --no-owner \
     --dbname "<new project's session pooler URI>" backup/logins-and-files-index.dump
   pg_restore --data-only --no-owner \
     --dbname "<new project's session pooler URI>" backup/database.dump
   ```
   Logins first (the app's tables point at them); they come back with
   their passwords. Then point Vercel, GitHub
   and the app at the new project's URL and keys.
2. **One table or a few rows** (a mistake, not a disaster): restore into a
   scratch database or read the rows out, e.g.
   `pg_restore --data-only --table=properties -f properties.sql backup/database.dump`,
   then copy back just what's needed.
3. **Uploaded files:** upload `backup/files/<bucket>/...` back to the same
   paths in Supabase Storage.

`pg_restore` comes with Postgres (on Windows: the PostgreSQL installer's
"Command Line Tools"; on a Mac: `brew install libpq`).
