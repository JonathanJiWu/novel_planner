from pathlib import Path

import pytest

from novel_architect import NovelProject, build_planning_stages, build_question_bank
from web_app import build_markdown, build_pdf, load_project_data, save_project_data, validate_project_data


def test_question_bank_has_expected_sections():
    questions = build_question_bank()
    assert len(questions) >= 35
    sections = {q.section for q in questions}
    assert "Stage A — Story Identity" in sections
    assert "Stage G — Conflict & Plot" in sections
    assert "Stage J — Continuity & Readiness" in sections
    assert all(question.guidance and question.purpose for question in questions)
    assert all(question.planning_level in {"essential", "important", "optional"} for question in questions)
    assert all(not question.required or question.planning_level == "essential" for question in questions)
    assert any(question.dependencies for question in questions)


def test_planning_stages_cover_readme_outputs_and_completion():
    stages = build_planning_stages()
    assert len(stages) == 10
    assert all(stage["purpose"] and stage["exercise"] and stage["completion"] for stage in stages)
    assert {stage["title"] for stage in stages} == {q.section for q in build_question_bank()}


def test_project_answers_and_export(tmp_path):
    project = NovelProject.with_questions("Test Novel")
    project.set_answer("story_identity", "A hidden history rewrites a city")
    project.set_answer("genre", "science fiction mystery")
    project.set_answer("protagonist", "A stubborn archivist")
    project.set_answer("central_conflict", "She must expose the lie before the city collapses")

    markdown = project.to_markdown()
    assert "# Test Novel" in markdown
    assert "A hidden history rewrites a city" in markdown
    assert "science fiction mystery" in markdown

    export_path = tmp_path / "test_output.md"
    project.export_markdown(export_path)
    assert export_path.exists()
    assert export_path.read_text(encoding="utf-8") == markdown


def test_next_questions_depends_on_answers():
    project = NovelProject.with_questions("Dependent Novel")
    assert project.next_questions()
    project.set_answer("story_identity", "A small rebellion against a machine empire")
    assert not any(q.question_id == "reading_experience" for q in project.next_questions())
    project.set_answer("dramatic_interest", "The rebellion is led by the regime's most loyal historian.")
    project.set_answer("genre", "Political fantasy")
    project.set_answer("target_audience", "Adult fantasy readers")
    questions = project.next_questions()
    assert any(q.question_id == "reading_experience" for q in questions)


def test_question_dependencies_are_valid_and_forward_ordered():
    questions = build_question_bank()
    positions = {question.question_id: index for index, question in enumerate(questions)}
    for question in questions:
        for dependency in question.dependencies:
            assert dependency in positions
            assert positions[dependency] < positions[question.question_id]


def test_web_project_round_trip_and_markdown_export(tmp_path):
    project_path = tmp_path / "project.json"
    saved = save_project_data(
        {
            "title": "The Quiet Archive",
            "answers": {"story_identity": "A librarian finds a forbidden record."},
            "ideas": [
                {"id": "idea-1", "category": "Character", "text": "The librarian fears being forgotten."}
            ],
        },
        project_path,
    )

    loaded = load_project_data(project_path)
    markdown = build_markdown(loaded)

    assert saved["saved_at"]
    assert loaded["title"] == "The Quiet Archive"
    assert "A librarian finds a forbidden record." in markdown
    assert "The librarian fears being forgotten." in markdown


def test_web_project_rejects_unknown_answer_and_category():
    with pytest.raises(ValueError, match="Invalid answer"):
        validate_project_data(
            {"title": "Novel", "answers": {"not_a_question": "Some answer"}, "ideas": []}
        )


def test_web_project_persists_planning_level_and_certainty(tmp_path):
    project_path = tmp_path / "project.json"
    saved = save_project_data(
        {
            "title": "Novel",
            "answers": {"story_identity": "A story about a missing harbor."},
            "question_states": {
                "story_identity": {"planning_level": "essential", "certainty": "provisional"}
            },
            "ideas": [],
        },
        project_path,
    )

    assert saved["question_states"]["story_identity"]["certainty"] == "provisional"
    assert "Provisional" in build_markdown(saved)


def test_existing_project_data_without_question_states_remains_compatible():
    project = validate_project_data(
        {"title": "Older project", "answers": {"story_identity": "Existing premise"}, "ideas": []}
    )
    assert project["question_states"] == {}
    assert project["answers"]["story_identity"] == "Existing premise"

    with pytest.raises(ValueError, match="Unknown idea category"):
        validate_project_data(
            {
                "title": "Novel",
                "answers": {},
                "ideas": [{"id": "idea-1", "category": "Other", "text": "An idea"}],
            }
        )


def test_project_persists_materials_and_theme(tmp_path):
    project_path = tmp_path / "project.json"
    saved = save_project_data(
        {
            "title": "Material Novel",
            "answers": {},
            "ideas": [],
            "materials": [
                {
                    "id": "material-1",
                    "category": "World",
                    "status": "imported",
                    "source": "notes.md",
                    "text": "The harbor closes at dusk.",
                }
            ],
            "theme": "paper",
        },
        project_path,
    )

    assert saved["theme"] == "paper"
    assert load_project_data(project_path)["materials"][0]["source"] == "notes.md"
    assert "The harbor closes at dusk." in build_markdown(saved)


def test_pdf_export_returns_a_pdf_document():
    content = build_pdf(
        validate_project_data(
            {
                "title": "PDF Novel",
                "answers": {"story_identity": "A story prepared for print."},
                "ideas": [],
            }
        )
    )

    assert content.startswith(b"%PDF")
    assert len(content) > 500
