"""Write the planner content as static JSON for the GitHub Pages build (no server)."""
import json
from pathlib import Path

from novel_architect import build_planning_stages, question_catalog


WEB_ROOT = Path(__file__).resolve().parent / "web"
STATIC_FILES = {
    "questions.json": question_catalog,
    "stages.json": build_planning_stages,
}


def render() -> dict[str, str]:
    return {name: json.dumps(build(), ensure_ascii=False) for name, build in STATIC_FILES.items()}


def main() -> None:
    for name, content in render().items():
        (WEB_ROOT / name).write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
