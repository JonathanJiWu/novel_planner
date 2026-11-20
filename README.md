# Novel Architect

**Turn the first spark of a story into a clear, workable plan.**

Novel Architect is a guided writing workspace for collecting ideas, shaping story decisions, and building a complete novel blueprint. It keeps planning flexible: uncertain choices stay visible, strong decisions become easier to revisit, and original notes remain separate from final story choices.

## Plan the whole novel, one decision at a time

Move through ten connected stages instead of facing a blank outline:

1. Story identity
2. Reader promise
3. Tone, voice, and style
4. Theme
5. Characters
6. World and internal logic
7. Conflict and plot
8. Subplot integration
9. Scenes and chapters
10. Continuity and drafting readiness

Every stage includes a purpose, exercise, useful output, completion standard, decision check, common pitfalls, and the craft sources it draws on. Every question explains what it asks and why, how to approach it, what a strong answer looks like, a common weak answer and how to improve it, and what it connects to; many include an example and a fillable worksheet. Later questions show what you already decided for the questions they build on, and each stage shows the notes from your idea inbox filed under it.

The planner follows `readme.txt` as its blueprint: the five planning statuses (essential, important, optional, deferred, intentionally unknown) are explained in the app, and the project overview and every export end with a **Ready to Write Chapter One?** assessment and a pre-drafting checklist, built only from your own decisions.

## Built for the messy beginning

- **Start right away**: no account needed. Your work is saved in this browser, and you can sign in whenever you like; everything you wrote comes with you
- **Capture ideas quickly** in a categorized idea inbox, and re-file them later
- **Import existing notes** from one or more `.txt` or Markdown files (long files are split into parts)
- **Keep source material intact** without accidentally turning it into a final decision
- **Mark every choice** as essential, important, optional, deferred, or intentionally unknown
- **Track confidence** as needs development, provisional, or settled
- **Search your project** across planning answers, ideas, and source material, and jump back to any answer
- **Watch your progress** as essential decisions become settled (deferring or downgrading a decision removes it from the target)
- **Export a blueprint** as Markdown or PDF (PDF exports keep Chinese, Japanese, Korean, Cyrillic, and Greek text)
- **Choose a comfortable look**: Dark mode, Bright mode, or Parchment mode (warm, textured like old sheepskin parchment)
- **Never lose work silently**: autosave with retries, a warning before closing with unsaved changes, and a conflict prompt when the same project was changed in another tab or device

## Three ways to run it

| | Where projects are stored | Accounts | Use it for |
|---|---|---|---|
| [Live demo](https://jonathanjiwu.github.io/novel_planner/) (GitHub Pages) | This browser only (IndexedDB) | Optional local profiles in this browser | Trying the planner |
| `python web_app.py` | `novel_project.json` on your computer | None (single user) | Personal use on your own machine |
| `uvicorn app:app` | Your account (SQLite or Supabase); this browser until you sign in | Optional real accounts | Anything shared or used across devices |

### Live demo (GitHub Pages)

**Live website: [https://jonathanjiwu.github.io/novel_planner/](https://jonathanjiwu.github.io/novel_planner/)**

Anyone can start planning immediately; the project is saved in this browser. The demo has no server, so its optional profiles are local too: they keep separate projects for different people using the same browser, don't sync to other devices, and are deleted if the site's data is cleared. Export your plan regularly. **Print or save as PDF** opens the browser's print dialog with a print-ready version of the plan.

Projects saved by the first version of the demo are restored automatically (a backup copy stays in the browser's storage).

Publishing: pushes to `main` run [`deploy.yml`](.github/workflows/deploy.yml), which runs the full test suite, builds the static site, deploys it to GitHub Pages, and smoke-tests the live URL. (Repository **Settings › Pages › Build and deployment** must be set to **GitHub Actions**.)

### Single-user local server

```bash
python -m pip install -r requirements.txt
python web_app.py            # then open http://127.0.0.1:8000
```

The project is saved in `novel_project.json` (use `--project-file PATH` to choose another file). There are no accounts, so keep the server on `127.0.0.1`.

### Account-based server

```bash
python -m pip install -r requirements.txt
AUTH_REQUIRED=true python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

With no Supabase settings, accounts and projects are stored in SQLite at `NOVEL_PLANNER_DB` (default `novel_planner.db` in the project folder). See [`.env.example`](.env.example) for every setting.

Signing in is optional. Visitors plan right away with their project kept in their own browser, and the app offers sign-in at natural moments (after their first saved work, or after an export) without interrupting them. When they sign in, their work moves into the account: blank answers are filled, nothing in the account is overwritten, and any answer that differs is kept as tentative material to review. Visitors can also export; the server renders the project they send without storing it (rate-limited). `AUTH_REQUIRED=true` means the server stores projects only for signed-in accounts.

- Passwords are hashed with scrypt; sessions are signed tokens that can be revoked (signing out ends the session on the server).
- Failed logins and registrations are rate-limited.
- Every save carries the revision it was based on; a save from an outdated tab is rejected and the writer chooses which version to keep.
- Schema changes are applied by numbered migrations when the server starts. Before migrating an existing database, the server writes a backup next to it (`<database>.backup-v<old version>-<timestamp>`).

#### Administrators

Addresses listed in `ADMIN_EMAILS` can open **Database admin** to list projects (owner, title, last update) and delete them. With built-in accounts, those addresses cannot be registered from the website. Create them on the server instead:

```bash
python manage.py create-user you@example.com      # prompts for a password
python manage.py set-password you@example.com     # reset a password and sign out its sessions
python manage.py list-users
python manage.py backup                           # timestamped copy of the database
python manage.py migrate                          # apply migrations (also happens at startup)
```

#### Deploying to Render

[`render.yaml`](render.yaml) describes the service: a persistent disk at `/var/data` for the SQLite database (persistent disks need a paid Render instance), `AUTH_REQUIRED=true`, and a generated `AUTH_SECRET`.

1. Create the service from `render.yaml` (Render **Blueprints**), then set `ADMIN_EMAILS`.
2. In the Render service, copy the **Deploy Hook** URL and add it to this GitHub repository as the Actions secret `RENDER_DEPLOY_HOOK_URL`.
3. Optionally add the repository variable `RENDER_SERVICE_URL` (for example `https://novel-architect.onrender.com`).
4. Open the Render **Shell** and create your administrator account with `python manage.py create-user`.

[`deploy-render.yml`](.github/workflows/deploy-render.yml) then deploys every `main` commit that passed the tests. With `RENDER_SERVICE_URL` set, it waits until `/api/health` reports the new commit before reporting success. Without the secret, the workflow reports that nothing was deployed.

Behind Render's proxy all requests can appear to come from a few addresses, which makes the per-address login limits shared. If you know your proxy's address range, set uvicorn's `FORWARDED_ALLOW_IPS` so real client addresses are used.

#### Using Supabase instead of SQLite

1. Create a Supabase project and run [`supabase_schema.sql`](supabase_schema.sql) in the SQL editor. The script is idempotent: run it again after upgrading Novel Architect (version 1.1 adds the `revision` column and its trigger).
2. Configure Auth providers and redirect URLs; use a real SMTP provider for confirmation and magic-link emails. Keep **Confirm email** enabled, since administrator access is granted by email address.
3. For each OAuth provider, add `https://<project-ref>.supabase.co/auth/v1/callback` as the callback URL, and add `PUBLIC_APP_URL` under **Authentication › URL Configuration**.
4. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only), and `PUBLIC_APP_URL`.

Row Level Security limits each user to their own project; the admin page uses the service-role key on the server. The browser loads the Supabase client library only in this mode (pinned version with a Subresource Integrity hash). Tokens are verified with the project's JWKS (asymmetric signing keys).

Never place service-role keys, `AUTH_SECRET`, or SMTP credentials in the browser or commit them to the repository.

## Generate a plan from the command line

```bash
python novel_architect.py --demo --output novel_plan.md          # sample blueprint
python novel_architect.py --interactive --output my_novel_plan.md
```

## Test

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q                 # unit, API, database, export, and server tests

npm ci                              # browser tests (Playwright)
npx playwright install chromium
npm test                            # browser-logic unit tests + end-to-end journeys
```

The end-to-end suite starts real servers (local, account-based, and the static Pages build) and drives Chromium through the main journeys: autosave and reload, imports, conflicts between tabs, sign-in and sign-out, expired sessions, administration, exports, themes, and the phone layout. Set `PYTHON` if your Python interpreter is not `python3`.

`tests/test_supabase_schema.py` applies the Supabase schema to a real PostgreSQL database when `NOVEL_PLANNER_TEST_POSTGRES_DSN` is set (CI provides one).

## Project structure

- [`novel_architect.py`](novel_architect.py): planning model, question catalog, and command-line application
- [`planner_content.py`](planner_content.py): stage guides and the question bank
- [`project_data.py`](project_data.py): the project document format, limits, and validation
- [`exports.py`](exports.py): Markdown and PDF exports
- [`web_app.py`](web_app.py): single-user local server
- [`app.py`](app.py): production API (FastAPI)
- [`auth.py`](auth.py), [`auth_store.py`](auth_store.py): sessions, built-in accounts, migrations
- [`store.py`](store.py): project storage (SQLite or Supabase)
- [`manage.py`](manage.py): operator commands
- [`web/`](web/): browser application (`app.js`, `planner-logic.js`, `styles.css`) and static data
- [`fonts/`](fonts/): DejaVu Sans for PDF exports (see `fonts/LICENSE-DejaVu.txt`)
- [`tests/`](tests/): Python tests; [`tests/js/`](tests/js/) and [`tests/e2e/`](tests/e2e/): browser tests
