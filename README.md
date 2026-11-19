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

Every stage includes a purpose, exercise, useful output, completion standard, decision check, and common pitfalls.

## Built for the messy beginning

- **Capture ideas quickly** in a categorized idea inbox
- **Import existing notes** from `.txt` or Markdown files
- **Keep source material intact** without accidentally turning it into a final decision
- **Mark every choice** as essential, important, optional, deferred, or intentionally unknown
- **Track confidence** as needs development, provisional, or settled
- **Search your project** across planning answers, ideas, and source material
- **Watch your progress** as key decisions become settled
- **Export a blueprint** as Markdown or print-ready PDF
- **Choose a comfortable theme** in dark, light, or warm paper mode

## Try the live website

Novel Architect can be published as a GitHub Pages website. The public demo runs in the browser and saves your project locally on the device you are using.

> Local browser storage is convenient for a personal demo, but it is not a replacement for account-based cloud backup.

To publish the demo:

1. Push the repository to GitHub, or update the existing `main` branch.
2. Open **Settings > Pages** in the repository.
3. Under **Build and deployment**, select **GitHub Actions**.
4. Open the **Actions** tab and run **Test and deploy Novel Architect**.

The workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the tests, generates the planning data, and deploys the browser application to GitHub Pages.

## Host a private, account-based beta

For projects that need sign-in and access across devices, Novel Architect includes a FastAPI backend, Supabase authentication, and PostgreSQL-backed project storage.

### Supabase setup

1. Create a Supabase project.
2. Run [`supabase_schema.sql`](supabase_schema.sql) in the Supabase SQL editor.
3. Configure Supabase Auth providers and redirect URLs for the deployed website.
4. Use a real SMTP provider for verification, password reset, and magic-link emails.

### Render setup

1. Create a Render Web Service for this repository.
2. Use [`render.yaml`](render.yaml) as the deployment reference.
3. Set the environment values described in [`.env.example`](.env.example).
4. Set `AUTH_REQUIRED=true`.
5. Set `ALLOWED_ORIGINS` to the live website origin.

Never place service-role or SMTP credentials in the browser or commit secrets to the repository.

The production entrypoint is [`app.py`](app.py). It verifies Supabase JWTs, assigns project records to authenticated users, and keeps browser configuration limited to the Supabase publishable key.

## Run locally

Install the dependencies:

```bash
python -m pip install -r requirements.txt
```

Start the browser application:

```bash
python web_app.py
```

Then visit `http://127.0.0.1:8000`.

For a production-mode local test:

```bash
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

## Generate a plan from the command line

Create a demo blueprint:

```bash
python novel_architect.py --demo --output novel_plan.md
```

Answer the planning questions interactively:

```bash
python novel_architect.py --interactive --output my_novel_plan.md
```

## Test

```bash
python -m pytest -q
```

## Project structure

- [`novel_architect.py`](novel_architect.py): planning model and command-line application
- [`web_app.py`](web_app.py): local browser server and JSON project API
- [`app.py`](app.py): production FastAPI entrypoint
- [`auth.py`](auth.py): Supabase JWT verification
- [`store.py`](store.py): local or Supabase project storage
- [`web/`](web/): browser interface and static deployment assets
- [`tests/test_novel_architect.py`](tests/test_novel_architect.py): project and export tests
