"""Project document model shared by the local server, the production API, and exports.

The browser keeps a single JSON document per project. Every backend validates it
with :func:`validate_project_data` before storing it, so the same limits apply no
matter where the project is saved. The browser enforces the same limits up front
(see ``LIMITS`` in ``web/planner-logic.js``) so users get a clear message instead
of a rejected save.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from novel_architect import NovelProject


DEFAULT_TITLE = "My Novel"
UNTITLED_TITLE = "Untitled novel"
MAX_REQUEST_BYTES = 2_000_000
MAX_TITLE_LENGTH = 200
MAX_ANSWER_LENGTH = 100_000
MAX_IDEA_LENGTH = 20_000
MAX_MATERIAL_LENGTH = 100_000
MAX_SOURCE_LENGTH = 500
MAX_ITEMS = 500
MAX_ID_LENGTH = 100

IDEA_CATEGORIES = (
    "Unsorted",
    "Story",
    "Character",
    "World",
    "Plot",
    "Theme",
    "Tone & style",
    "Scene",
)
MATERIAL_STATUSES = (
    "imported",
    "approved",
    "tentative",
    "deferred",
    "intentionally_unknown",
    "archived",
)
PLANNING_LEVELS = ("essential", "important", "optional", "deferred", "intentionally_unknown")
CERTAINTIES = ("needs_work", "provisional", "settled")
THEMES = ("dark", "light", "paper")


class ConflictError(Exception):
    """A save was based on an outdated revision of the project."""

    def __init__(self, current: dict[str, Any]) -> None:
        super().__init__("This project was changed in another window or on another device.")
        self.current = current


def new_project_data() -> dict[str, Any]:
    return {
        "title": DEFAULT_TITLE,
        "answers": {},
        "question_states": {},
        "ideas": [],
        "materials": [],
        "theme": "dark",
        "saved_at": None,
        "revision": 0,
    }


@lru_cache(maxsize=1)
def _question_defaults() -> dict[str, str]:
    """Map each question id to its default planning level."""
    project = NovelProject.with_questions("Novel")
    return {question_id: question.planning_level for question_id, question in project.questions.items()}


def known_question_ids() -> frozenset[str]:
    return frozenset(_question_defaults())


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _clean_text(value: str) -> str:
    """Replace unpaired UTF-16 surrogates, which cannot be stored as UTF-8."""
    return _LONE_SURROGATE.sub("\ufffd", value)


def parse_revision(value: Any) -> int | None:
    """Return a client-supplied base revision, or None when it is absent."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("Revision must be a non-negative integer.")
    return value


def _normalize_title(title: Any) -> str:
    if not isinstance(title, str):
        raise ValueError("Project title must be text.")
    collapsed = " ".join(_clean_text(title).split())
    if not collapsed:
        # An empty title field must never block saving the rest of the project.
        return UNTITLED_TITLE
    if len(collapsed) > MAX_TITLE_LENGTH:
        raise ValueError(f"Project title must be at most {MAX_TITLE_LENGTH} characters.")
    return collapsed


def validate_project_data(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("Project data must be a JSON object.")

    title = _normalize_title(data.get("title", DEFAULT_TITLE))
    answers = data.get("answers", {})
    question_states = data.get("question_states", {})
    ideas = data.get("ideas", [])
    materials = data.get("materials", [])
    theme = data.get("theme", "dark")
    if not isinstance(answers, dict):
        raise ValueError("Answers must be a JSON object.")
    if not isinstance(question_states, dict):
        raise ValueError("Question states must be a JSON object.")
    if not isinstance(ideas, list) or len(ideas) > MAX_ITEMS:
        raise ValueError(f"Ideas must be a list containing no more than {MAX_ITEMS} items.")
    if not isinstance(materials, list) or len(materials) > MAX_ITEMS:
        raise ValueError(f"Materials must be a list containing no more than {MAX_ITEMS} items.")
    if theme not in THEMES:
        raise ValueError(f"Unknown theme: {theme!r}.")

    defaults = _question_defaults()
    clean_answers: dict[str, str] = {}
    for question_id, answer in answers.items():
        if question_id not in defaults or not isinstance(answer, str):
            raise ValueError(f"Invalid answer entry: {question_id!r}.")
        if len(answer) > MAX_ANSWER_LENGTH:
            raise ValueError(f"Answer for {question_id} is longer than {MAX_ANSWER_LENGTH:,} characters.")
        clean_answers[question_id] = _clean_text(answer)

    clean_question_states: dict[str, dict[str, str]] = {}
    for question_id, state in question_states.items():
        if question_id not in defaults or not isinstance(state, dict):
            raise ValueError(f"Invalid question state: {question_id!r}.")
        level = state.get("planning_level", defaults[question_id])
        certainty = state.get("certainty", "needs_work")
        if level not in PLANNING_LEVELS or certainty not in CERTAINTIES:
            raise ValueError(f"Invalid planning status for question {question_id}.")
        clean_question_states[question_id] = {"planning_level": level, "certainty": certainty}

    def _check_id(item_id: Any, kind: str) -> str:
        if not isinstance(item_id, str) or not item_id or len(item_id) > MAX_ID_LENGTH:
            raise ValueError(f"Each {kind} must have a valid id.")
        return item_id

    clean_ideas: list[dict[str, str]] = []
    for idea in ideas:
        if not isinstance(idea, dict):
            raise ValueError("Each idea must be a JSON object.")
        text = idea.get("text")
        category = idea.get("category", "Unsorted")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_IDEA_LENGTH:
            raise ValueError(f"Each idea must contain 1 to {MAX_IDEA_LENGTH:,} characters.")
        if category not in IDEA_CATEGORIES:
            raise ValueError(f"Unknown idea category: {category!r}.")
        clean_ideas.append(
            {"id": _check_id(idea.get("id"), "idea"), "text": _clean_text(text.strip()), "category": category}
        )

    clean_materials: list[dict[str, str]] = []
    for material in materials:
        if not isinstance(material, dict):
            raise ValueError("Each material must be a JSON object.")
        text = material.get("text")
        category = material.get("category", "Unsorted")
        status = material.get("status", "imported")
        source = material.get("source", "Pasted material")
        if (
            not isinstance(text, str)
            or not text.strip()
            or len(text) > MAX_MATERIAL_LENGTH
            or category not in IDEA_CATEGORIES
            or status not in MATERIAL_STATUSES
            or not isinstance(source, str)
            or not source.strip()
            or len(source) > MAX_SOURCE_LENGTH
        ):
            raise ValueError("Each material must contain valid text, category, status, and source.")
        clean_materials.append(
            {
                "id": _check_id(material.get("id"), "material"),
                "text": _clean_text(text.strip()),
                "category": category,
                "status": status,
                "source": _clean_text(source.strip()),
            }
        )

    saved_at = data.get("saved_at")
    return {
        "title": title,
        "answers": clean_answers,
        "question_states": clean_question_states,
        "ideas": clean_ideas,
        "materials": clean_materials,
        "theme": theme,
        "saved_at": saved_at if isinstance(saved_at, str) else None,
        "revision": parse_revision(data.get("revision")) or 0,
    }


def storable(data: dict[str, Any]) -> dict[str, Any]:
    """Strip server-managed fields before a project document is persisted."""
    return {key: value for key, value in data.items() if key not in {"saved_at", "revision"}}
