"""Markdown and PDF exports, and consistency between the Python and browser implementations."""
from __future__ import annotations

import json
import re
import shutil
import subprocess

import pytest

import generate_static_assets
import project_data
from config import PROJECT_ROOT
from exports import build_markdown, build_pdf, has_cjk, pdf_markup
from novel_architect import build_planning_stages, question_catalog
from project_data import validate_project_data


RICH_PROJECT = {
    "title": "  The   Quiet Archive ",
    "answers": {
        "story_identity": "Line one\nLine two\n\n- a list inside the answer",
        "protagonist": "林黛玉 — émigré; Пушкин",
        "genre": "Literary fantasy",
        "deferred_decisions": "   ",
        "atmosphere": "Salt, fog, and lamp oil.",
        "readiness_assessment": "Close: the opening is clear, the ending is not.",
    },
    "question_states": {
        "story_identity": {"planning_level": "intentionally_unknown", "certainty": "settled"},
        "genre": {"planning_level": "essential", "certainty": "provisional"},
        "protagonist": {"planning_level": "essential", "certainty": "settled"},
        "chapter_pacing": {"planning_level": "deferred", "certainty": "needs_work"},
        "atmosphere": {"planning_level": "important", "certainty": "provisional"},
    },
    "ideas": [{"id": "i1", "text": "An idea\nwith two lines", "category": "Tone & style"}],
    "materials": [
        {"id": "m1", "text": "The harbor closes at dusk.", "category": "World", "status": "intentionally_unknown", "source": "notes.md"}
    ],
    "theme": "light",
}


def test_multiline_answers_stay_inside_their_list_item():
    markdown = build_markdown(validate_project_data(RICH_PROJECT))
    # Regression: continuation lines used to start at column 0 and break the list.
    assert "  - Line one\n    Line two\n\n    - a list inside the answer\n" in markdown
    assert "(Intentionally Unknown)" in markdown
    assert "Intentionally_Unknown" not in markdown
    assert "- **Which genre or combination best describes" in markdown
    assert "— Essential, Provisional" in markdown
    assert "### World — Intentionally Unknown" in markdown
    assert markdown.startswith("# The Quiet Archive\n")


def test_markdown_ends_with_the_readme_completion_standard():
    markdown = build_markdown(validate_project_data(RICH_PROJECT))
    readiness = markdown[markdown.index("## Ready to Write Chapter One?"):]
    assert readiness.startswith("## Ready to Write Chapter One?\n\nNot yet: ")
    assert "- Character: 1 of 3 essential decisions settled" in readiness
    assert "### Address before drafting" in readiness
    assert "### Monitor while drafting\n\n- Tone, voice & style: What should it feel like to inhabit this world?" in readiness
    assert "### Discover through drafting\n\n- Scenes & chapters:" in readiness
    assert "### Intentionally unknown\n\n- Story identity: What is happening in this story" in readiness
    assert "### Your assessment\n\nClose: the opening is clear, the ending is not." in readiness
    assert "- [x] Characters: Who carries the story?" in readiness
    assert "- [ ] Reader promise: Which genre or combination" in readiness
    # Every stage credits its sources (readme.txt §2).
    assert markdown.count("- **Draws on:** ") == 10
    assert "Lisa Cron (Story Genius)" in markdown and "K.M. Weiland" in markdown and "Jessica Brody" in markdown


def test_pdf_embeds_unicode_fonts_and_keeps_cjk_text():
    # Regression: every non-Latin character used to be drawn as a black box.
    pdf = build_pdf(validate_project_data(RICH_PROJECT))
    assert pdf.startswith(b"%PDF")
    fonts = set(re.findall(rb"/BaseFont /([A-Za-z0-9+_-]+)", pdf))
    assert any(font.endswith(b"+DejaVuSans") for font in fonts), fonts  # embedded subset of the bundled font
    assert b"STSong-Light" in fonts
    assert b"Helvetica" not in fonts


def test_pdf_markup_escapes_and_switches_fonts():
    assert pdf_markup("a < b & c") == "a &lt; b &amp; c"
    assert pdf_markup("中文 text") == '<font name="STSong-Light">中文</font> text'
    assert pdf_markup("日本語のテキスト").startswith('<font name="HeiseiKakuGo-W5">')
    assert pdf_markup("한국어") == '<font name="HYGothic-Medium">한국어</font>'
    assert pdf_markup("line\nbreak") == "line<br/>break"
    assert has_cjk("Plain English") is False


@pytest.mark.parametrize("length", [5_000, 100_000])
def test_pdf_handles_long_unbroken_text(length):
    data = validate_project_data({"title": "Long", "answers": {"story_identity": "x" * length, "protagonist": "字" * 3000}})
    assert build_pdf(data).startswith(b"%PDF")


def test_static_json_matches_the_generator():
    for name, content in generate_static_assets.render().items():
        committed = (PROJECT_ROOT / "web" / name).read_text(encoding="utf-8")
        assert committed == content, f"web/{name} is stale: run python generate_static_assets.py"


node = shutil.which("node")


def run_node(script: str, payload: object) -> str:
    result = subprocess.run(
        [node, "-e", script],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
        cwd=PROJECT_ROOT,
    )
    return result.stdout


@pytest.mark.skipif(node is None, reason="Node.js is required for the browser-logic comparison")
def test_browser_markdown_matches_the_server_export():
    data = validate_project_data(RICH_PROJECT)
    script = (
        "const logic = require('./web/planner-logic.js');"
        "let input = ''; process.stdin.on('data', (c) => input += c);"
        "process.stdin.on('end', () => { const p = JSON.parse(input);"
        "process.stdout.write(logic.buildMarkdown(p.project, p.questions, p.stages)); });"
    )
    browser = run_node(script, {"project": data, "questions": question_catalog(), "stages": build_planning_stages()})
    assert browser == build_markdown(data)


@pytest.mark.skipif(node is None, reason="Node.js is required for the browser-logic comparison")
def test_browser_limits_match_the_server():
    script = "process.stdout.write(JSON.stringify(require('./web/planner-logic.js')))"
    logic = json.loads(run_node(script, {}))
    assert logic["LIMITS"] == {
        "requestBytes": project_data.MAX_REQUEST_BYTES,
        "title": project_data.MAX_TITLE_LENGTH,
        "answer": project_data.MAX_ANSWER_LENGTH,
        "idea": project_data.MAX_IDEA_LENGTH,
        "material": project_data.MAX_MATERIAL_LENGTH,
        "source": project_data.MAX_SOURCE_LENGTH,
        "items": project_data.MAX_ITEMS,
    }
    assert logic["IDEA_CATEGORIES"] == list(project_data.IDEA_CATEGORIES)
    assert logic["MATERIAL_STATUSES"] == list(project_data.MATERIAL_STATUSES)
    assert logic["PLANNING_LEVELS"] == list(project_data.PLANNING_LEVELS)
    assert logic["CERTAINTIES"] == list(project_data.CERTAINTIES)
    assert logic["THEMES"] == list(project_data.THEMES)
