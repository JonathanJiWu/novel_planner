# Novel Architect

A Python-based novel-planning prototype with a local browser frontend for gathering raw ideas and answering guided planning questions.

## Features

- Guided, stage-by-stage question flow covering all ten planning stages in `readme.txt`
- Stage purpose, method, exercise, decision check, output, completion standard, and common pitfalls
- Question-level links to affected story areas
- Per-decision planning priority and certainty (essential, important, optional, deferred, intentionally unknown; needs development, provisional, settled)
- Author-facing question bank based on the README requirements
- Idea inbox with categories for story, character, world, plot, theme, style, and scenes
- Project overview with searchable answers, ideas, and original material
- Paste or import `.txt`/Markdown material without promoting it to an approved decision
- Autosaved project title, ideas, and planning answers in a local JSON file
- Blueprint progress tracking
- Markdown export including the idea inbox and captured planning answers
- Structured PDF export with page numbers and planning-stage guidance
- Persistent default dark, comfortable light, and warm paper themes
- Exported decision status, so provisional and intentionally deferred choices remain visible
- Demo mode that generates a sample blueprint

## Quick start

```bash
cd "C:\Users\jwu82\OneDrive\Documents\novel_planner"
py -3 novel_architect.py --demo --output novel_plan.md
```

To answer the questions interactively:

```bash
py -3 novel_architect.py --interactive --output my_novel_plan.md
```

To start the browser frontend:

```bash
py -3 web_app.py
```

Then open `http://127.0.0.1:8000`. The app stores project data in `novel_project.json` beside the Python files. Use **Export writing plan** to download a Markdown copy.

The guided process follows the README's ten-stage sequence: story identity; reader promise; tone, voice, and style; theme; characters; world and internal logic; conflict and plot; subplot integration; scenes and chapters; continuity and drafting readiness. Each stage explains its purpose, offers a short exercise, states what it produces, and gives a completion standard. Questions can be marked essential, important, optional, deferred, or intentionally unknown; decision confidence can be tracked separately as needs development, provisional, or settled.

Use **Project overview** to search the current blueprint and review collected material in one place. Imported text is preserved with its source and starts as `imported`; it does not overwrite planning answers. Use **Export PDF** for a print-friendly blueprint. The PDF dependency is installed from `requirements.txt`.

## Hosted beta deployment

The hosted beta uses Supabase Auth/PostgreSQL and a Python ASGI service on Render.
The local JSON workflow remains available when Supabase environment variables are
not configured.

1. Create a Supabase project and run [`supabase_schema.sql`](C:/Users/jwu82/OneDrive/Documents/novel_planner/supabase_schema.sql) in the SQL editor.
2. Configure Supabase Auth providers and redirect URLs for the Render service.
3. Configure a real SMTP provider such as Resend for verification, reset, and magic-link emails.
4. Create a Render Web Service from this project using [`render.yaml`](C:/Users/jwu82/OneDrive/Documents/novel_planner/render.yaml).
5. Add the values from [`.env.example`](C:/Users/jwu82/OneDrive/Documents/novel_planner/.env.example) in Render's environment settings. Never commit secrets.
6. Set `AUTH_REQUIRED=true` and set `ALLOWED_ORIGINS` to the deployed origin.

For local production-mode testing:

```powershell
py -3 -m pip install -r requirements.txt
py -3 -m uvicorn app:app --host 127.0.0.1 --port 8000
```

The production entrypoint is [`app.py`](C:/Users/jwu82/OneDrive/Documents/novel_planner/app.py). It verifies Supabase JWTs, derives project ownership from the authenticated user, and uses PostgreSQL-backed JSON project records. The browser only receives the Supabase publishable/anon key; service-role and SMTP credentials must remain server-side.

## Project files

- `novel_architect.py`: core planner app
- `web_app.py`: local HTTP server and project API
- `web/`: browser frontend assets
- `tests/test_novel_architect.py`: validation tests
- `novel_plan.md`: sample generated output
