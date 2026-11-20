"""The “Ready to Write Chapter One?” assessment (readme.txt §7).

Derived only from the author's own planning statuses: nothing is invented.
The same rules live in web/planner-logic.js for the browser; a test keeps the
Markdown both produce identical.
"""
from __future__ import annotations

from typing import Any


def effective_state(question: dict[str, Any], question_states: dict[str, Any]) -> dict[str, str]:
    saved = question_states.get(question["question_id"]) or {}
    default_level = question.get("planning_level") or ("essential" if question.get("required") else "important")
    return {
        "planning_level": saved.get("planning_level") or default_level,
        "certainty": saved.get("certainty") or "needs_work",
    }


def _answered(answers: dict[str, Any], question_id: str) -> bool:
    return bool(str(answers.get(question_id) or "").strip())


def counts_toward_progress(question: dict[str, Any], question_states: dict[str, Any]) -> bool:
    """Essential for this novel: marked essential, or an essential question kept intentionally unknown."""
    level = effective_state(question, question_states)["planning_level"]
    if level == "essential":
        return True
    return level == "intentionally_unknown" and (question.get("required") or question.get("planning_level") == "essential")


def is_settled(question: dict[str, Any], answers: dict[str, Any], question_states: dict[str, Any]) -> bool:
    state = effective_state(question, question_states)
    if state["certainty"] != "settled":
        return False
    return state["planning_level"] == "intentionally_unknown" or _answered(answers, question["question_id"])


def assess(project: dict[str, Any], questions: list[dict[str, Any]], stages: list[dict[str, Any]]) -> dict[str, Any]:
    answers = project.get("answers") or {}
    states = project.get("question_states") or {}
    stage_by_title = {stage["title"]: stage for stage in stages}
    dimensions: list[dict[str, Any]] = []
    by_name: dict[str, dict[str, Any]] = {}
    for stage in stages:
        if stage["dimension"] not in by_name:
            by_name[stage["dimension"]] = {"name": stage["dimension"], "settled": 0, "total": 0}
            dimensions.append(by_name[stage["dimension"]])

    lists: dict[str, list[dict[str, str]]] = {"address": [], "monitor": [], "discover": [], "unknown": []}
    checklist: list[dict[str, Any]] = []
    other_open = 0
    for question in questions:
        stage = stage_by_title[question["section"]]
        state = effective_state(question, states)
        entry = {"question_id": question["question_id"], "prompt": question["prompt"], "stage": stage["label"]}
        counted = counts_toward_progress(question, states)
        settled = is_settled(question, answers, states)
        if counted:
            dimension = by_name[stage["dimension"]]
            dimension["total"] += 1
            dimension["settled"] += int(settled)
            checklist.append({**entry, "done": settled})
        if counted and not settled:
            lists["address"].append(entry)
        elif state["planning_level"] == "deferred":
            lists["discover"].append(entry)
        elif state["planning_level"] == "intentionally_unknown":
            lists["unknown"].append(entry)
        elif _answered(answers, question["question_id"]) and state["certainty"] != "settled":
            lists["monitor"].append(entry)
        elif not _answered(answers, question["question_id"]):
            other_open += 1

    total = sum(dimension["total"] for dimension in dimensions)
    return {
        "ready": not lists["address"],
        "settled": sum(dimension["settled"] for dimension in dimensions),
        "total": total,
        "dimensions": dimensions,
        "address": lists["address"],
        "monitor": lists["monitor"],
        "discover": lists["discover"],
        "unknown": lists["unknown"],
        "other_open": other_open,
        "checklist": checklist,
        "assessment": str(answers.get("readiness_assessment") or "").strip(),
    }


def verdict(report: dict[str, Any]) -> str:
    if report["ready"] and report["total"] == 0:
        return "Ready by your choices: no decision is currently marked essential. Review the deferred items before drafting."
    if report["ready"]:
        settled = "the one essential decision is" if report["total"] == 1 else f"all {report['total']} essential decisions are"
        return f"Ready: {settled} settled for now. Keep an eye on the items below while drafting."
    open_count = len(report["address"])
    noun = "decision is" if open_count == 1 else "decisions are"
    return (
        f"Not yet: {open_count} of {report['total']} essential {noun} still open. "
        "Settle them, or mark any you are comfortable discovering while drafting as Deferred."
    )


def dimension_line(dimension: dict[str, Any]) -> str:
    if not dimension["total"]:
        return f"{dimension['name']}: no essential decisions marked"
    noun = "decision" if dimension["total"] == 1 else "decisions"
    return f"{dimension['name']}: {dimension['settled']} of {dimension['total']} essential {noun} settled"


SECTIONS = (
    ("address", "Address before drafting"),
    ("monitor", "Monitor while drafting"),
    ("discover", "Discover through drafting"),
    ("unknown", "Intentionally unknown"),
)


def other_open_line(count: int) -> str:
    noun = "question is" if count == 1 else "questions are"
    return f"{count} other {noun} unanswered; none is essential, so they can be explored while drafting."


def readiness_markdown(report: dict[str, Any]) -> str:
    lines = ["## Ready to Write Chapter One?", "", verdict(report), ""]
    lines += [f"- {dimension_line(dimension)}" for dimension in report["dimensions"]]
    lines.append("")
    for key, heading in SECTIONS:
        if report[key]:
            lines += [f"### {heading}", ""]
            lines += [f"- {entry['stage']}: {entry['prompt']}" for entry in report[key]]
            lines.append("")
    if report["other_open"]:
        lines += [other_open_line(report["other_open"]), ""]
    lines += ["### Your assessment", "", report["assessment"] or "Not yet written.", ""]
    lines += ["## Pre-drafting checklist", ""]
    if report["checklist"]:
        lines += [f"- [{'x' if item['done'] else ' '}] {item['stage']}: {item['prompt']}" for item in report["checklist"]]
    else:
        lines.append("- No decisions are currently marked essential.")
    return "\n".join(lines) + "\n"
