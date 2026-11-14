from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from xml.sax.saxutils import escape

from novel_architect import NovelProject, build_planning_stages


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
PROJECT_FILE = ROOT / "novel_project.json"
MAX_REQUEST_BYTES = 2_000_000
IDEA_CATEGORIES = {
    "Unsorted",
    "Story",
    "Character",
    "World",
    "Plot",
    "Theme",
    "Tone & style",
    "Scene",
}
MATERIAL_STATUSES = {
    "approved",
    "tentative",
    "deferred",
    "intentionally_unknown",
    "imported",
    "archived",
}
THEMES = {"dark", "light", "paper"}


def new_project_data() -> dict[str, Any]:
    return {
        "title": "My Novel",
        "answers": {},
        "question_states": {},
        "ideas": [],
        "materials": [],
        "theme": "dark",
        "saved_at": None,
    }


def load_project_data(path: Path = PROJECT_FILE) -> dict[str, Any]:
    if not path.exists():
        return new_project_data()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read saved novel project at {path}: {exc}") from exc
    return validate_project_data(data)


def validate_project_data(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("Project data must be a JSON object.")

    title = data.get("title", "My Novel")
    answers = data.get("answers", {})
    question_states = data.get("question_states", {})
    ideas = data.get("ideas", [])
    materials = data.get("materials", [])
    theme = data.get("theme", "dark")
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        raise ValueError("Project title must be between 1 and 200 characters.")
    if not isinstance(answers, dict):
        raise ValueError("Answers must be a JSON object.")
    if not isinstance(question_states, dict):
        raise ValueError("Question states must be a JSON object.")
    if not isinstance(ideas, list) or len(ideas) > 500:
        raise ValueError("Ideas must be a list containing no more than 500 items.")
    if not isinstance(materials, list) or len(materials) > 500:
        raise ValueError("Materials must be a list containing no more than 500 items.")
    if theme not in THEMES:
        raise ValueError(f"Unknown theme: {theme!r}.")

    question_ids = NovelProject.with_questions(title.strip()).questions
    clean_answers: dict[str, str] = {}
    for question_id, answer in answers.items():
        if question_id not in question_ids or not isinstance(answer, str):
            raise ValueError(f"Invalid answer entry: {question_id!r}.")
        if len(answer) > 100_000:
            raise ValueError(f"Answer for {question_id} is too long.")
        clean_answers[question_id] = answer

    allowed_levels = {"essential", "important", "optional", "deferred", "intentionally_unknown"}
    allowed_certainties = {"settled", "provisional", "needs_work"}
    clean_question_states: dict[str, dict[str, str]] = {}
    for question_id, state in question_states.items():
        if question_id not in question_ids or not isinstance(state, dict):
            raise ValueError(f"Invalid question state: {question_id!r}.")
        level = state.get("planning_level", question_ids[question_id].planning_level)
        certainty = state.get("certainty", "needs_work")
        if (
            not isinstance(level, str)
            or level not in allowed_levels
            or not isinstance(certainty, str)
            or certainty not in allowed_certainties
        ):
            raise ValueError(f"Invalid planning status for question {question_id}.")
        clean_question_states[question_id] = {
            "planning_level": level,
            "certainty": certainty,
        }

    clean_ideas: list[dict[str, str]] = []
    for idea in ideas:
        if not isinstance(idea, dict):
            raise ValueError("Each idea must be a JSON object.")
        text = idea.get("text")
        category = idea.get("category", "Unsorted")
        idea_id = idea.get("id")
        if not isinstance(text, str) or not text.strip() or len(text) > 20_000:
            raise ValueError("Each idea must contain 1 to 20,000 characters.")
        if category not in IDEA_CATEGORIES:
            raise ValueError(f"Unknown idea category: {category!r}.")
        if not isinstance(idea_id, str) or not idea_id or len(idea_id) > 100:
            raise ValueError("Each idea must have a valid id.")
        clean_ideas.append(
            {"id": idea_id, "text": text.strip(), "category": category}
        )

    clean_materials: list[dict[str, str]] = []
    for material in materials:
        if not isinstance(material, dict):
            raise ValueError("Each material must be a JSON object.")
        material_id = material.get("id")
        text = material.get("text")
        category = material.get("category", "Unsorted")
        status = material.get("status", "imported")
        source = material.get("source", "Pasted material")
        if (
            not isinstance(material_id, str)
            or not material_id
            or len(material_id) > 100
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > 100_000
            or category not in IDEA_CATEGORIES
            or status not in MATERIAL_STATUSES
            or not isinstance(source, str)
            or not source.strip()
            or len(source) > 500
        ):
            raise ValueError("Each material must contain valid text, category, status, and source.")
        clean_materials.append(
            {
                "id": material_id,
                "text": text.strip(),
                "category": category,
                "status": status,
                "source": source.strip(),
            }
        )

    saved_at = data.get("saved_at")
    return {
        "title": title.strip(),
        "answers": clean_answers,
        "question_states": clean_question_states,
        "ideas": clean_ideas,
        "materials": clean_materials,
        "theme": theme,
        "saved_at": saved_at if isinstance(saved_at, str) else None,
    }


def save_project_data(data: dict[str, Any], path: Path = PROJECT_FILE) -> dict[str, Any]:
    clean_data = validate_project_data(data)
    clean_data["saved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(clean_data, temporary_file, ensure_ascii=False, indent=2)
        temporary_path.replace(path)
    except OSError as exc:
        raise RuntimeError(f"Could not save novel project at {path}: {exc}") from exc
    finally:
        if temporary_path is not None and temporary_path.exists():
            os.unlink(temporary_path)
    return clean_data


def build_markdown(data: dict[str, Any]) -> str:
    project = NovelProject.with_questions(data["title"])
    for question_id, answer in data["answers"].items():
        project.set_answer(question_id, answer)
    for question_id, state in data.get("question_states", {}).items():
        question = project.questions[question_id]
        question.planning_level = state["planning_level"]
    markdown = project.to_markdown()
    if data.get("question_states"):
        markdown += "\n## Decision confidence\n\n"
        for question_id, state in data["question_states"].items():
            question = project.questions[question_id]
            markdown += (
                f"- **{question.prompt}** — {state['planning_level'].replace('_', ' ').title()}, "
                f"{state['certainty'].replace('_', ' ').title()}\n"
            )
    if data["ideas"]:
        markdown += "\n## Idea Inbox\n\n"
        for idea in data["ideas"]:
            markdown += f"### {idea['category']}\n\n{idea['text']}\n\n"
    if data.get("materials"):
        markdown += "\n## Original Materials\n\n"
        for material in data["materials"]:
            status = material["status"].replace("_", " ").title()
            markdown += (
                f"### {material['category']} — {status}\n\n"
                f"Source: {material['source']}\n\n{material['text']}\n\n"
            )
    return markdown


def build_pdf(data: dict[str, Any]) -> bytes:
    try:
        from reportlab.lib.enums import TA_CENTER
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import (
            PageBreak,
            Paragraph,
            SimpleDocTemplate,
            Spacer,
        )
    except ImportError as exc:
        raise RuntimeError("PDF export requires the reportlab package.") from exc

    from io import BytesIO

    buffer = BytesIO()
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="BlueprintTitle",
        parent=styles["Title"],
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=24,
        leading=30,
        spaceAfter=24,
    ))
    styles.add(ParagraphStyle(
        name="BlueprintHeading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=15,
        leading=19,
        spaceBefore=14,
        spaceAfter=8,
    ))
    styles.add(ParagraphStyle(
        name="BlueprintQuestion",
        parent=styles["Heading3"],
        fontName="Helvetica-Bold",
        fontSize=10,
        leading=13,
        spaceBefore=8,
        spaceAfter=3,
    ))
    styles.add(ParagraphStyle(
        name="BlueprintBody",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=14,
        spaceAfter=6,
    ))

    def footer(canvas, document) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColorRGB(0.35, 0.38, 0.35)
        canvas.drawString(0.7 * inch, 0.45 * inch, "Novel Architect")
        canvas.drawRightString(7.8 * inch, 0.45 * inch, f"Page {document.page}")
        canvas.restoreState()

    story = [
        Paragraph(escape(data["title"]), styles["BlueprintTitle"]),
        Paragraph("Novel Development Blueprint", styles["Heading2"]),
        Spacer(1, 0.2 * inch),
    ]
    project = NovelProject.with_questions(data["title"])
    for question_id, answer in data["answers"].items():
        project.set_answer(question_id, answer)
    grouped: dict[str, list[Any]] = {}
    for question in project.questions.values():
        grouped.setdefault(question.section, []).append(question)
    stage_guides = {stage["title"]: stage for stage in build_planning_stages()}
    story.append(Paragraph("Contents", styles["BlueprintHeading"]))
    for section_name in grouped:
        story.append(Paragraph(f"• {escape(section_name)}", styles["BlueprintBody"]))
    story.append(PageBreak())
    for section_name, questions in grouped.items():
        story.append(Paragraph(escape(section_name), styles["BlueprintHeading"]))
        stage = stage_guides.get(section_name)
        if stage:
            story.append(Paragraph(escape(stage["purpose"]), styles["BlueprintBody"]))
            story.append(Paragraph(
                f"<b>Output:</b> {escape(stage['output'])}<br/>"
                f"<b>Completion:</b> {escape(stage['completion'])}",
                styles["BlueprintBody"],
            ))
        for question in questions:
            answer = question.answer.strip() or "Not yet answered"
            state = data.get("question_states", {}).get(question.question_id, {})
            status = state.get("planning_level", question.planning_level).replace("_", " ").title()
            certainty = state.get("certainty", "needs_work").replace("_", " ").title()
            story.append(Paragraph(escape(question.prompt), styles["BlueprintQuestion"]))
            story.append(Paragraph(
                f"<b>{escape(status)} · {escape(certainty)}</b><br/>{escape(answer).replace(chr(10), '<br/>')}",
                styles["BlueprintBody"],
            ))
    if data.get("ideas") or data.get("materials"):
        story.append(PageBreak())
        story.append(Paragraph("Collected Material", styles["BlueprintHeading"]))
        for item in [*data.get("ideas", []), *data.get("materials", [])]:
            status = item.get("status", "idea").replace("_", " ").title()
            story.append(Paragraph(
                f"<b>{escape(item['category'])} · {escape(status)}</b> "
                f"({escape(item.get('source', 'Idea inbox'))})",
                styles["BlueprintQuestion"],
            ))
            story.append(Paragraph(
                escape(item["text"]).replace(chr(10), "<br/>"),
                styles["BlueprintBody"],
            ))
    document = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        rightMargin=0.7 * inch,
        leftMargin=0.7 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title=data["title"],
        author="Novel Architect",
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()


class NovelPlannerHandler(BaseHTTPRequestHandler):
    server_version = "NovelArchitect/1.0"

    def do_GET(self) -> None:
        if self.path == "/api/config":
            self._send_json(
                {
                    "supabase_configured": False,
                    "supabase_url": "",
                    "supabase_anon_key": "",
                }
            )
        elif self.path == "/api/project":
            try:
                self._send_json(load_project_data())
            except RuntimeError as exc:
                self._send_json({"error": str(exc)}, status=500)
        elif self.path == "/api/questions":
            project = NovelProject.with_questions("Novel")
            self._send_json(
                [
                    {
                        **asdict(question),
                        "answer": "",
                        "dependencies": list(question.dependencies),
                    }
                    for question in project.questions.values()
                ]
            )
        elif self.path == "/api/stages":
            self._send_json(build_planning_stages())
        elif self.path == "/api/export":
            try:
                data = load_project_data()
                content = build_markdown(data).encode("utf-8")
            except (RuntimeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=500)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header(
                "Content-Disposition",
                'attachment; filename="novel-writing-plan.md"',
            )
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/api/export/pdf":
            try:
                data = load_project_data()
                content = build_pdf(data)
            except (RuntimeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=500)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header(
                "Content-Disposition",
                'attachment; filename="novel-writing-plan.pdf"',
            )
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/":
            self._send_file("index.html", "text/html; charset=utf-8")
        elif self.path in {"/app.js", "/styles.css"}:
            file_name = unquote(self.path.lstrip("/"))
            content_type = (
                "text/javascript; charset=utf-8"
                if file_name.endswith(".js")
                else "text/css; charset=utf-8"
            )
            self._send_file(file_name, content_type)
        else:
            self.send_error(404, "Not found")

    def do_PUT(self) -> None:
        if self.path != "/api/project":
            self.send_error(404, "Not found")
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
                raise ValueError("Request body must be between 1 byte and 2 MB.")
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            saved_data = save_project_data(payload)
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_json({"error": str(exc)}, status=400)
            return
        except RuntimeError as exc:
            self._send_json({"error": str(exc)}, status=500)
            return
        self._send_json(saved_data)

    def _send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, file_name: str, content_type: str) -> None:
        file_path = WEB_ROOT / file_name
        if file_path.parent != WEB_ROOT or not file_path.is_file():
            self.send_error(404, "Not found")
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format_string % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Novel Architect idea-gathering frontend.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), NovelPlannerHandler)
    print(f"Novel Architect is running at http://{args.host}:{args.port}")
    print("Project data is saved locally in novel_project.json. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Novel Architect.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
