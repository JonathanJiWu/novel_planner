from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List


def planning_label(value: str) -> str:
    """Human-readable label for a planning level or certainty (e.g. "Intentionally Unknown")."""
    return value.replace("_", " ").title()


def markdown_list_item(text: str, indent: str = "  ") -> str:
    """Render ``text`` as a nested list item, keeping later lines inside the item."""
    first, *rest = text.splitlines() or [""]
    lines = [f"{indent}- {first}"]
    continuation = indent + "  "
    lines.extend(f"{continuation}{line}" if line.strip() else "" for line in rest)
    return "\n".join(lines)


@dataclass
class Question:
    question_id: str
    section: str
    prompt: str
    definition: str = ""
    purpose: str = ""
    guidance: str = ""
    examples: str = ""
    answer_type: str = "text"
    required: bool = False
    dependencies: tuple[str, ...] = ()
    answer: str = ""
    planning_level: str = "important"
    affects: str = ""

    @property
    def status(self) -> str:
        return "answered" if self.answer.strip() else "pending"


@dataclass
class NovelProject:
    title: str
    genre: str = ""
    premise: str = ""
    reading_experience: str = ""
    audience: str = ""
    tone: str = ""
    protagonist: str = ""
    world: str = ""
    conflict: str = ""
    theme: str = ""
    style: str = ""
    questions: Dict[str, Question] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)

    @classmethod
    def with_questions(cls, title: str) -> "NovelProject":
        project = cls(title=title)
        project.questions = {q.question_id: q for q in build_question_bank()}
        return project

    def set_answer(self, question_id: str, value: str) -> None:
        question = self.questions.get(question_id)
        if question is None:
            raise KeyError(f"Unknown question id: {question_id}")
        question.answer = (value or "").strip()

        field_map = {
            "story_identity": "premise",
            "reading_experience": "reading_experience",
            "genre": "genre",
            "target_audience": "audience",
            "tone_atmosphere": "tone",
            "protagonist": "protagonist",
            "world_system": "world",
            "central_conflict": "conflict",
            "core_theme": "theme",
            "style_charter": "style",
        }
        if question_id in field_map:
            setattr(self, field_map[question_id], question.answer)

    def next_questions(self) -> List[Question]:
        pending: List[Question] = []
        for question in self.questions.values():
            if question.status == "pending":
                if all(dep in self.answers for dep in question.dependencies):
                    pending.append(question)
        return pending

    @property
    def answers(self) -> Dict[str, str]:
        return {key: question.answer for key, question in self.questions.items() if question.answer.strip()}

    def to_markdown(self) -> str:
        sections = [
            f"# {self.title}",
            "",
            "## Project Snapshot",
            "",
            f"- Premise: {self.premise or 'Not yet defined'}",
            f"- Genre: {self.genre or 'Not yet defined'}",
            f"- Reading experience: {self.reading_experience or 'Not yet defined'}",
            f"- Intended audience: {self.audience or 'Not yet defined'}",
            f"- Tone and atmosphere: {self.tone or 'Not yet defined'}",
            f"- Protagonist: {self.protagonist or 'Not yet defined'}",
            f"- World system: {self.world or 'Not yet defined'}",
            f"- Central conflict: {self.conflict or 'Not yet defined'}",
            f"- Core theme: {self.theme or 'Not yet defined'}",
            f"- Style charter: {self.style or 'Not yet defined'}",
            "",
            "## Planning Stages",
            "",
        ]

        grouped: Dict[str, List[Question]] = {}
        for question in self.questions.values():
            grouped.setdefault(question.section, []).append(question)

        stage_guides = {stage["title"]: stage for stage in build_planning_stages()}
        for section_name, questions in grouped.items():
            sections.append(f"### {section_name}")
            sections.append("")
            stage = stage_guides.get(section_name)
            if stage is not None:
                sections.append(f"_{stage['purpose']}_")
                sections.append("")
                sections.append(f"- **Why it matters:** {stage['why']}")
                sections.append(f"- **Method:** {stage['method']}")
                sections.append(f"- **Exercise:** {stage['exercise']}")
                sections.append(f"- **Decision check:** {stage['criteria']}")
                sections.append(f"- **Watch for:** {stage['watch_for']}")
                sections.append(f"- **Output:** {stage['output']}")
                sections.append(f"- **Move on when:** {stage['completion']}")
                sections.append("")
            for question in questions:
                answer_text = question.answer or "Not yet answered"
                sections.append(
                    f"- **{question.prompt}** ({planning_label(question.planning_level)})\n"
                    + markdown_list_item(answer_text)
                    + (f"\n  - Connects to: {question.affects}" if question.affects else "")
                )
            sections.append("")

        return "\n".join(sections).rstrip() + "\n"

    def export_markdown(self, output_path: str | Path) -> Path:
        path = Path(output_path)
        path.write_text(self.to_markdown(), encoding="utf-8")
        return path


def build_question_bank() -> List[Question]:
    from planner_content import build_questions

    return build_questions(Question)


def build_planning_stages() -> List[dict[str, str]]:
    from planner_content import build_planning_stages as get_stages

    return get_stages()


def question_catalog() -> List[dict[str, Any]]:
    """Questions as JSON-ready dictionaries, as served to the browser."""
    return [
        {**asdict(question), "answer": "", "dependencies": list(question.dependencies)}
        for question in build_question_bank()
    ]


def _demo_answers() -> Dict[str, str]:
    return {
        "story_identity": "A grieving archivist uncovers a hidden history that could either save her city or destroy it.",
        "reading_experience": "A tense, immersive mystery with intimate emotional stakes and a growing sense of dread.",
        "genre": "Literary fantasy thriller",
        "target_audience": "Adult readers who enjoy character-driven mysteries and morally complicated worlds.",
        "tone_atmosphere": "Gritty, atmospheric, intimate, and quietly ominous.",
        "core_theme": "Memory shapes identity; the past cannot be erased without cost.",
        "protagonist": "Mara, a disgraced archivist whose family was destroyed by a government cover-up and who wants to restore the truth at any cost.",
        "antagonist": "The Ministry of Memory, which believes public forgetting is the only true stability.",
        "world_system": "A city built atop memory archives where public records are weaponized to control social order.",
        "central_conflict": "Mara must expose the city's hidden history before the ministry burns the archives and remakes reality.",
        "plot_architecture": "A mystery-driven rising-stakes plot with a mid-point revelation that turns the protagonist's goal into a larger moral crisis.",
        "subplots": "A sibling relationship, a political romance, and a secret apprenticeship all deepen the story's moral complexity.",
        "scene_architecture": "Opening revelation, false hope, collapse, crisis, and final act of truth.",
        "narrative_voice": "Third-person limited from Mara's perspective with occasional brief flashes of institutional perspective.",
        "style_charter": "Lean prose, concrete detail, emotional restraint, and sharp insight rather than melodrama.",
        "opening_chapter": "Mara discovers a sealed chamber that contains proof that an official tragedy was staged.",
        "consistency_rules": "Magic, if present, is always tied to memory and cannot rewrite events; all secrets must have emotional consequences.",
        "deferred_decisions": "The exact chapter structure and final epilogue wording will be designed during drafting.",
    }


def run_interactive(project: NovelProject) -> NovelProject:
    for question in project.questions.values():
        if question.answer:
            continue
        print(f"\n[{question.section}]")
        print(f"Question: {question.prompt}")
        if question.definition:
            print(f"Definition: {question.definition}")
        if question.purpose:
            print(f"Why it matters: {question.purpose}")
        if question.guidance:
            print(f"Guidance: {question.guidance}")
        if question.examples:
            print(f"Example: {question.examples}")
        answer = input("Your answer (leave blank to skip): ").strip()
        if answer:
            project.set_answer(question.question_id, answer)
    return project


def main() -> None:
    parser = argparse.ArgumentParser(description="Novel Architect: guided novel-planning assistant")
    parser.add_argument("--title", default="Novel Development Blueprint", help="Title for the novel project")
    parser.add_argument("--demo", action="store_true", help="Populate the planner with a sample novel")
    parser.add_argument("--output", default="novel_plan.md", help="Markdown output path for the final plan")
    parser.add_argument("--interactive", action="store_true", help="Answer questions interactively in the terminal")
    args = parser.parse_args()

    project = NovelProject.with_questions(args.title)
    if args.demo:
        for question_id, answer in _demo_answers().items():
            if question_id in project.questions:
                project.set_answer(question_id, answer)
    elif args.interactive:
        run_interactive(project)
    else:
        for question in project.questions.values():
            if not question.answer:
                question.answer = "TBD"

    markdown = project.to_markdown()
    output = project.export_markdown(args.output)
    print(f"\nProject saved to: {output}")
    print("\n--- Final planning document preview ---\n")
    print(markdown[:2500])


if __name__ == "__main__":
    main()
