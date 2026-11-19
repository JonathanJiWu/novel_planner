import json
from pathlib import Path

from novel_architect import NovelProject, build_planning_stages


WEB_ROOT = Path(__file__).resolve().parent / "web"

project = NovelProject.with_questions("Novel")
questions = [
    {
        **question.__dict__,
        "answer": "",
        "dependencies": list(question.dependencies),
    }
    for question in project.questions.values()
]

(WEB_ROOT / "questions.json").write_text(
    json.dumps(questions, ensure_ascii=False),
    encoding="utf-8",
)
(WEB_ROOT / "stages.json").write_text(
    json.dumps(build_planning_stages(), ensure_ascii=False),
    encoding="utf-8",
)
