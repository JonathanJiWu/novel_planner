"""Markdown and PDF exports of a validated project document."""
from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timezone
from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from config import PROJECT_ROOT
from novel_architect import NovelProject, build_planning_stages, planning_label, question_catalog
from readiness import SECTIONS, assess, dimension_line, other_open_line, readiness_markdown, verdict


logger = logging.getLogger("novel_architect.exports")
FONT_DIR = PROJECT_ROOT / "fonts"

# CJK text is set in the standard Adobe Asian fonts (referenced by name, not
# embedded): PDF viewers supply them, so the export stays small. Everything else
# uses the bundled DejaVu Sans, which covers Latin, Greek, and Cyrillic.
_CJK_RUN = re.compile(
    "["
    "ᄀ-ᇿ"  # Hangul Jamo
    "⺀-⿟"  # CJK radicals
    "　-〿"  # CJK symbols and punctuation
    "぀-ヿ"  # Hiragana, Katakana
    "㄀-ㇿ"  # Bopomofo, Hangul compatibility Jamo, Kanbun, Katakana extensions
    "㈀-䶿"  # Enclosed CJK, CJK compatibility, Extension A
    "一-鿿"  # CJK unified ideographs
    "ꥠ-꥿"  # Hangul Jamo extended A
    "가-퟿"  # Hangul syllables, Jamo extended B
    "豈-﫿"  # CJK compatibility ideographs
    "︰-﹏"  # CJK compatibility forms
    "＀-￯"  # Half-width and full-width forms
    "]+"
)
_HANGUL = re.compile("[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿]")
_KANA = re.compile("[぀-ヿㇰ-ㇿｦ-ﾟ]")
_CJK_FONTS = {"chinese": "STSong-Light", "japanese": "HeiseiKakuGo-W5", "korean": "HYGothic-Medium"}

_font_lock = threading.Lock()
_fonts: dict[str, str] | None = None


def pdf_fonts() -> dict[str, str]:
    """Register PDF fonts once and return the names used for body and bold text."""
    global _fonts
    with _font_lock:
        if _fonts is not None:
            return _fonts
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.pdfbase.ttfonts import TTFont

        fonts = {"regular": "Helvetica", "bold": "Helvetica-Bold"}
        try:
            pdfmetrics.registerFont(TTFont("NovelSans", str(FONT_DIR / "DejaVuSans.ttf")))
            pdfmetrics.registerFont(TTFont("NovelSans-Bold", str(FONT_DIR / "DejaVuSans-Bold.ttf")))
            pdfmetrics.registerFontFamily(
                "NovelSans",
                normal="NovelSans",
                bold="NovelSans-Bold",
                italic="NovelSans",
                boldItalic="NovelSans-Bold",
            )
            fonts = {"regular": "NovelSans", "bold": "NovelSans-Bold"}
        except Exception:  # pragma: no cover - only when the bundled fonts are missing
            logger.warning("Bundled PDF fonts are unavailable; non-Latin text may not render.", exc_info=True)
        for name in _CJK_FONTS.values():
            pdfmetrics.registerFont(UnicodeCIDFont(name))
            pdfmetrics.registerFontFamily(name, normal=name, bold=name, italic=name, boldItalic=name)
        _fonts = fonts
        return fonts


def _cjk_font(run: str, context: str) -> str:
    if _HANGUL.search(run):
        return _CJK_FONTS["korean"]
    if _KANA.search(context):
        return _CJK_FONTS["japanese"]
    return _CJK_FONTS["chinese"]


def has_cjk(text: str) -> bool:
    return bool(_CJK_RUN.search(text))


def pdf_markup(text: str) -> str:
    """Escape author text for a reportlab Paragraph, switching fonts for CJK runs."""
    escaped = escape(text)
    marked = _CJK_RUN.sub(
        lambda match: f'<font name="{_cjk_font(match.group(0), text)}">{match.group(0)}</font>',
        escaped,
    )
    return marked.replace("\n", "<br/>")


def _project_from_data(data: dict[str, Any]) -> NovelProject:
    project = NovelProject.with_questions(data["title"])
    for question_id, answer in data["answers"].items():
        project.set_answer(question_id, answer)
    for question_id, state in data.get("question_states", {}).items():
        project.questions[question_id].planning_level = state["planning_level"]
    return project


def readiness_report(data: dict[str, Any]) -> dict[str, Any]:
    return assess(data, question_catalog(), build_planning_stages())


def build_markdown(data: dict[str, Any]) -> str:
    project = _project_from_data(data)
    markdown = project.to_markdown()
    markdown += "\n" + readiness_markdown(readiness_report(data))
    if data.get("question_states"):
        markdown += "\n## Decision confidence\n\n"
        for question_id, state in data["question_states"].items():
            question = project.questions[question_id]
            markdown += (
                f"- **{question.prompt}** — {planning_label(state['planning_level'])}, "
                f"{planning_label(state['certainty'])}\n"
            )
    if data["ideas"]:
        markdown += "\n## Idea Inbox\n\n"
        for idea in data["ideas"]:
            markdown += f"### {idea['category']}\n\n{idea['text']}\n\n"
    if data.get("materials"):
        markdown += "\n## Original Materials\n\n"
        for material in data["materials"]:
            markdown += (
                f"### {material['category']} — {planning_label(material['status'])}\n\n"
                f"Source: {material['source']}\n\n{material['text']}\n\n"
            )
    return markdown


def build_pdf(data: dict[str, Any]) -> bytes:
    try:
        from reportlab.lib.enums import TA_CENTER
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer
    except ImportError as exc:
        raise RuntimeError("PDF export requires the reportlab package.") from exc

    fonts = pdf_fonts()
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="BlueprintTitle",
        parent=styles["Title"],
        alignment=TA_CENTER,
        fontName=fonts["bold"],
        fontSize=24,
        leading=30,
        spaceAfter=24,
    ))
    styles.add(ParagraphStyle(
        name="BlueprintSubtitle",
        parent=styles["Heading2"],
        alignment=TA_CENTER,
        fontName=fonts["regular"],
    ))
    styles.add(ParagraphStyle(
        name="BlueprintMeta",
        parent=styles["BodyText"],
        alignment=TA_CENTER,
        fontName=fonts["regular"],
        fontSize=9,
        textColor="#555555",
    ))
    styles.add(ParagraphStyle(
        name="BlueprintHeading",
        parent=styles["Heading2"],
        fontName=fonts["bold"],
        fontSize=15,
        leading=19,
        spaceBefore=14,
        spaceAfter=8,
    ))
    styles.add(ParagraphStyle(
        name="BlueprintQuestion",
        parent=styles["Heading3"],
        fontName=fonts["bold"],
        fontSize=10,
        leading=13,
        spaceBefore=8,
        spaceAfter=3,
    ))
    styles.add(ParagraphStyle(
        name="BlueprintBody",
        parent=styles["BodyText"],
        fontName=fonts["regular"],
        fontSize=9.5,
        leading=14,
        spaceAfter=6,
    ))

    def paragraph(text: str, style_name: str, prefix: str = "") -> Paragraph:
        style = styles[style_name]
        if has_cjk(text):
            # Allow line breaks between CJK characters, which have no spaces.
            style = ParagraphStyle(name=f"{style_name}CJK", parent=style, wordWrap="CJK")
        return Paragraph(prefix + pdf_markup(text), style)

    def footer(canvas, document) -> None:
        canvas.saveState()
        canvas.setFont(fonts["regular"], 8)
        canvas.setFillColorRGB(0.35, 0.38, 0.35)
        canvas.drawString(0.7 * inch, 0.45 * inch, "Novel Architect")
        canvas.drawRightString(7.8 * inch, 0.45 * inch, f"Page {document.page}")
        canvas.restoreState()

    exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    meta = f"Exported {exported_at}"
    if data.get("revision"):
        meta += f" · revision {data['revision']}"
    story = [
        paragraph(data["title"], "BlueprintTitle"),
        Paragraph("Novel Development Blueprint", styles["BlueprintSubtitle"]),
        Paragraph(escape(meta), styles["BlueprintMeta"]),
        Spacer(1, 0.2 * inch),
    ]
    project = _project_from_data(data)
    grouped: dict[str, list[Any]] = {}
    for question in project.questions.values():
        grouped.setdefault(question.section, []).append(question)
    stage_guides = {stage["title"]: stage for stage in build_planning_stages()}
    story.append(Paragraph("Contents", styles["BlueprintHeading"]))
    for section_name in grouped:
        story.append(paragraph(section_name, "BlueprintBody", prefix="• "))
    story.append(PageBreak())
    for section_name, questions in grouped.items():
        story.append(paragraph(section_name, "BlueprintHeading"))
        stage = stage_guides.get(section_name)
        if stage:
            story.append(paragraph(stage["purpose"], "BlueprintBody"))
            story.append(Paragraph(
                f"<b>Output:</b> {pdf_markup(stage['output'])}<br/>"
                f"<b>Completion:</b> {pdf_markup(stage['completion'])}<br/>"
                f"<b>Draws on:</b> {pdf_markup(stage['sources'])}",
                styles["BlueprintBody"],
            ))
        for question in questions:
            answer = question.answer.strip() or "Not yet answered"
            state = data.get("question_states", {}).get(question.question_id, {})
            status = planning_label(state.get("planning_level", question.planning_level))
            certainty = planning_label(state.get("certainty", "needs_work"))
            story.append(paragraph(question.prompt, "BlueprintQuestion"))
            story.append(paragraph(answer, "BlueprintBody", prefix=f"<b>{escape(status)} · {escape(certainty)}</b><br/>"))
    report = readiness_report(data)
    story.append(PageBreak())
    story.append(Paragraph("Ready to Write Chapter One?", styles["BlueprintHeading"]))
    story.append(paragraph(verdict(report), "BlueprintBody"))
    for dimension in report["dimensions"]:
        story.append(paragraph(dimension_line(dimension), "BlueprintBody", prefix="• "))
    for key, heading in SECTIONS:
        if report[key]:
            story.append(Paragraph(heading, styles["BlueprintQuestion"]))
            for entry in report[key]:
                story.append(paragraph(f"{entry['stage']}: {entry['prompt']}", "BlueprintBody", prefix="• "))
    if report["other_open"]:
        story.append(paragraph(other_open_line(report["other_open"]), "BlueprintBody"))
    story.append(Paragraph("Your assessment", styles["BlueprintQuestion"]))
    story.append(paragraph(report["assessment"] or "Not yet written.", "BlueprintBody"))
    story.append(Paragraph("Pre-drafting checklist", styles["BlueprintHeading"]))
    for item in report["checklist"] or [{"done": False, "stage": "", "prompt": "No decisions are currently marked essential."}]:
        mark = "☑" if item["done"] else "☐"
        label = f"{item['stage']}: {item['prompt']}" if item["stage"] else item["prompt"]
        story.append(paragraph(label, "BlueprintBody", prefix=f"{mark} "))

    if data.get("ideas") or data.get("materials"):
        story.append(PageBreak())
        story.append(Paragraph("Collected Material", styles["BlueprintHeading"]))
        for item in [*data.get("ideas", []), *data.get("materials", [])]:
            status = planning_label(item.get("status", "idea"))
            label = f"{item['category']} · {status} ({item.get('source', 'Idea inbox')})"
            story.append(paragraph(label, "BlueprintQuestion"))
            story.append(paragraph(item["text"], "BlueprintBody"))

    buffer = BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        rightMargin=0.7 * inch,
        leftMargin=0.7 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title=data["title"],
        author="Novel Architect",
        initialFontName=fonts["regular"],
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
