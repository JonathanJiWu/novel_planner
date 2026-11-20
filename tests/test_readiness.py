"""The "Ready to Write Chapter One?" assessment and the planner content readme.txt requires."""
from __future__ import annotations

import re

from novel_architect import build_planning_stages, build_question_bank, question_catalog
from readiness import assess, dimension_line, readiness_markdown, verdict


QUESTIONS = question_catalog()
STAGES = build_planning_stages()
ESSENTIAL = [question for question in QUESTIONS if question["required"]]


def project(answers=None, states=None):
    return {"answers": answers or {}, "question_states": states or {}}


def settle(question_ids, level="essential"):
    return {question_id: {"planning_level": level, "certainty": "settled"} for question_id in question_ids}


def test_a_new_project_is_not_ready_and_lists_every_essential_decision():
    report = assess(project(), QUESTIONS, STAGES)
    assert report["ready"] is False
    assert report["total"] == len(ESSENTIAL)
    assert [entry["question_id"] for entry in report["address"]] == [question["question_id"] for question in ESSENTIAL]
    assert report["other_open"] == len(QUESTIONS) - len(ESSENTIAL)
    assert verdict(report).startswith(f"Not yet: {len(ESSENTIAL)} of {len(ESSENTIAL)} essential decisions are still open.")


def test_settling_every_essential_decision_makes_the_novel_ready():
    ids = [question["question_id"] for question in ESSENTIAL]
    report = assess(project({question_id: "Decided." for question_id in ids}, settle(ids)), QUESTIONS, STAGES)
    assert report["ready"] is True
    assert report["settled"] == report["total"] == len(ESSENTIAL)
    assert all(item["done"] for item in report["checklist"])
    assert verdict(report) == f"Ready: all {len(ESSENTIAL)} essential decisions are settled for now. Keep an eye on the items below while drafting."


def test_deferring_or_keeping_a_question_unknown_is_a_decision_not_a_gap():
    ids = [question["question_id"] for question in ESSENTIAL]
    answers = {question_id: "Decided." for question_id in ids[2:]}
    states = settle(ids[2:])
    states[ids[0]] = {"planning_level": "deferred", "certainty": "needs_work"}
    states[ids[1]] = {"planning_level": "intentionally_unknown", "certainty": "settled"}
    report = assess(project(answers, states), QUESTIONS, STAGES)
    assert report["ready"] is True
    assert [entry["question_id"] for entry in report["discover"]] == [ids[0]]
    assert [entry["question_id"] for entry in report["unknown"]] == [ids[1]]
    assert report["total"] == len(ESSENTIAL) - 1  # deferring removes it from the essentials


def test_each_question_appears_in_at_most_one_list():
    states = {
        "story_identity": {"planning_level": "intentionally_unknown", "certainty": "needs_work"},
        "atmosphere": {"planning_level": "important", "certainty": "provisional"},
        "chapter_pacing": {"planning_level": "deferred", "certainty": "settled"},
    }
    report = assess(project({"atmosphere": "Fog."}, states), QUESTIONS, STAGES)
    listed = [entry["question_id"] for key in ("address", "monitor", "discover", "unknown") for entry in report[key]]
    assert len(listed) == len(set(listed))
    assert "story_identity" in [entry["question_id"] for entry in report["address"]]  # unknown but not yet confirmed
    assert [entry["question_id"] for entry in report["monitor"]] == ["atmosphere"]


def test_wording_handles_singular_and_empty_cases():
    assert dimension_line({"name": "Theme", "settled": 0, "total": 1}) == "Theme: 0 of 1 essential decision settled"
    assert dimension_line({"name": "Theme", "settled": 0, "total": 0}) == "Theme: no essential decisions marked"
    ids = [question["question_id"] for question in ESSENTIAL]
    all_deferred = {question_id: {"planning_level": "deferred", "certainty": "needs_work"} for question_id in ids}
    report = assess(project(states=all_deferred), QUESTIONS, STAGES)
    assert verdict(report).startswith("Ready by your choices")
    assert "- No decisions are currently marked essential." in readiness_markdown(report)


def test_every_question_has_the_guidance_readme_section_5_requires():
    for question in build_question_bank():
        # What is requested, why it matters, prompts, a strong answer, a weak answer and its fix, and what it affects.
        for field in ("definition", "purpose", "guidance", "strong", "weak", "affects"):
            assert getattr(question, field).strip(), f"{question.question_id} has no {field}"
    templates = [question for question in build_question_bank() if question.template]
    assert len(templates) >= 15
    assert any(question.question_id == "style_samples" for question in build_question_bank())


def test_every_stage_credits_its_sources_and_feeds_a_readiness_dimension():
    dimensions = {"Narrative clarity", "Tone & voice", "Theme", "Character", "World & continuity", "Structure"}
    for stage in STAGES:
        assert stage["dimension"] in dimensions
        assert re.search(r"Lisa Cron|Jessica Brody|K\.M\. Weiland|Planner synthesis", stage["sources"]), stage["title"]
    plot = next(stage for stage in STAGES if stage["title"] == "Stage G — Conflict & Plot")
    assert "Where they differ" in plot["sources"]  # readme.txt §2: compare approaches where the authors differ
    assert {stage["dimension"] for stage in STAGES} == dimensions
