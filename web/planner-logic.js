/*
 * Pure planning logic shared by the browser app and the Node test suite.
 * No DOM access here. Limits must match project_data.py (a test checks this).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlannerLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LIMITS = Object.freeze({
    requestBytes: 2000000,
    title: 200,
    answer: 100000,
    idea: 20000,
    material: 100000,
    source: 500,
    items: 500,
  });
  const DEFAULT_TITLE = "My Novel";
  const UNTITLED_TITLE = "Untitled novel";
  const IDEA_CATEGORIES = Object.freeze(["Unsorted", "Story", "Character", "World", "Plot", "Theme", "Tone & style", "Scene"]);
  const MATERIAL_STATUSES = Object.freeze(["imported", "approved", "tentative", "deferred", "intentionally_unknown", "archived"]);
  const PLANNING_LEVELS = Object.freeze(["essential", "important", "optional", "deferred", "intentionally_unknown"]);
  const CERTAINTIES = Object.freeze(["needs_work", "provisional", "settled"]);
  const THEMES = Object.freeze(["dark", "light", "paper"]);
  const OPEN_MATERIAL_STATUSES = Object.freeze(["imported", "tentative", "deferred"]);

  // Same line boundaries as Python's str.splitlines().
  const LINE_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;

  function emptyProject() {
    return {
      title: DEFAULT_TITLE,
      answers: {},
      question_states: {},
      ideas: [],
      materials: [],
      theme: "dark",
      saved_at: null,
      revision: 0,
    };
  }

  function normalizeTitle(title) {
    const collapsed = String(title == null ? "" : title).split(/\s+/).filter(Boolean).join(" ");
    return collapsed || UNTITLED_TITLE;
  }

  function planningLabel(value) {
    return String(value)
      .replace(/_/g, " ")
      .replace(/[A-Za-z]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }

  function answerText(answers, questionId) {
    return String((answers && answers[questionId]) || "").trim();
  }

  function effectiveState(question, questionStates) {
    const saved = (questionStates && questionStates[question.question_id]) || {};
    return {
      planning_level: saved.planning_level || question.planning_level || (question.required ? "essential" : "important"),
      certainty: saved.certainty || "needs_work",
    };
  }

  // A decision counts toward blueprint progress while the author treats it as
  // essential: marked essential, or an essential question deliberately kept as
  // an intentional unknown. Downgrading or deferring it removes it from the count.
  function countsTowardProgress(question, questionStates) {
    const level = effectiveState(question, questionStates).planning_level;
    if (level === "essential") return true;
    return level === "intentionally_unknown" && (question.required || question.planning_level === "essential");
  }

  // Settled for now: confirmed as settled and either answered or deliberately unknown.
  function isSettled(question, answers, questionStates) {
    const state = effectiveState(question, questionStates);
    if (state.certainty !== "settled") return false;
    return state.planning_level === "intentionally_unknown" || Boolean(answerText(answers, question.question_id));
  }

  function progress(questions, answers, questionStates) {
    const counted = questions.filter((question) => countsTowardProgress(question, questionStates));
    const settled = counted.filter((question) => isSettled(question, answers, questionStates)).length;
    return {
      settled,
      total: counted.length,
      percent: counted.length ? Math.round((settled / counted.length) * 100) : 0,
    };
  }

  function stageComplete(questions, answers, questionStates) {
    const counted = questions.filter((question) => countsTowardProgress(question, questionStates));
    return counted.length > 0 && counted.every((question) => isSettled(question, answers, questionStates));
  }

  // Needs the author's attention: deferred, answered but not settled, or an
  // essential decision that is still unresolved.
  function isOpenDecision(question, answers, questionStates) {
    const state = effectiveState(question, questionStates);
    if (state.planning_level === "deferred") return true;
    if (answerText(answers, question.question_id)) return !isSettled(question, answers, questionStates);
    return countsTowardProgress(question, questionStates) && !isSettled(question, answers, questionStates);
  }

  function isOpenMaterial(material) {
    return OPEN_MATERIAL_STATUSES.includes(material.status);
  }

  function blockedDependencies(question, answers) {
    return (question.dependencies || []).filter((dependency) => !answerText(answers, dependency));
  }

  function utf8Length(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    return Buffer.byteLength(text, "utf8");
  }

  // Split long text into parts no longer than maxLength, preferring paragraph,
  // then line, then word boundaries, and never splitting a surrogate pair.
  function splitText(text, maxLength) {
    const parts = [];
    let rest = String(text);
    while (rest.length > maxLength) {
      const minimum = Math.floor(maxLength / 2);
      let cut = rest.lastIndexOf("\n\n", maxLength);
      if (cut < minimum) cut = rest.lastIndexOf("\n", maxLength);
      if (cut < minimum) cut = rest.lastIndexOf(" ", maxLength);
      if (cut < minimum) cut = maxLength;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    parts.push(rest);
    return parts.map((part) => part.trim()).filter(Boolean);
  }

  // Mirrors the server's validation so an invalid project is caught (with a
  // helpful message) before it is sent. Returns null when the project is valid.
  function validationError(project) {
    if (String(project.title || "").length > LIMITS.title) {
      return `The project name can be at most ${LIMITS.title} characters.`;
    }
    for (const [questionId, answer] of Object.entries(project.answers || {})) {
      if (String(answer).length > LIMITS.answer) {
        return `An answer is longer than ${LIMITS.answer.toLocaleString("en-US")} characters (${questionId}). Shorten it or move part of it into imported material.`;
      }
    }
    if ((project.ideas || []).length > LIMITS.items) return `A project can hold at most ${LIMITS.items} ideas.`;
    if ((project.materials || []).length > LIMITS.items) return `A project can hold at most ${LIMITS.items} imported materials.`;
    for (const idea of project.ideas || []) {
      if (!String(idea.text || "").trim()) return "An idea is empty. Remove it or add some text.";
      if (String(idea.text).length > LIMITS.idea) return `Ideas can be at most ${LIMITS.idea.toLocaleString("en-US")} characters.`;
    }
    for (const material of project.materials || []) {
      if (!String(material.text || "").trim()) return "An imported material is empty.";
      if (String(material.text).length > LIMITS.material) {
        return `Imported material can be at most ${LIMITS.material.toLocaleString("en-US")} characters per item.`;
      }
    }
    return null;
  }

  function markdownListItem(text, indent) {
    const lines = String(text).split(LINE_BREAK);
    const continuation = indent + "  ";
    return [
      `${indent}- ${lines[0]}`,
      ...lines.slice(1).map((line) => (line.trim() ? `${continuation}${line}` : "")),
    ].join("\n");
  }

  // Port of exports.build_markdown (Python); a test keeps the two identical.
  function buildMarkdown(project, questions, stages) {
    const title = normalizeTitle(project.title);
    const answers = project.answers || {};
    const questionStates = project.question_states || {};
    const value = (id) => answerText(answers, id) || "Not yet defined";
    const lines = [
      `# ${title}`,
      "",
      "## Project Snapshot",
      "",
      `- Premise: ${value("story_identity")}`,
      `- Genre: ${value("genre")}`,
      `- Reading experience: ${value("reading_experience")}`,
      `- Intended audience: ${value("target_audience")}`,
      `- Tone and atmosphere: ${value("tone_atmosphere")}`,
      `- Protagonist: ${value("protagonist")}`,
      `- World system: ${value("world_system")}`,
      `- Central conflict: ${value("central_conflict")}`,
      `- Core theme: ${value("core_theme")}`,
      `- Style charter: ${value("style_charter")}`,
      "",
      "## Planning Stages",
      "",
    ];
    const grouped = new Map();
    questions.forEach((question) => {
      if (!grouped.has(question.section)) grouped.set(question.section, []);
      grouped.get(question.section).push(question);
    });
    const stageGuides = new Map(stages.map((stage) => [stage.title, stage]));
    grouped.forEach((sectionQuestions, sectionName) => {
      lines.push(`### ${sectionName}`, "");
      const stage = stageGuides.get(sectionName);
      if (stage) {
        lines.push(
          `_${stage.purpose}_`,
          "",
          `- **Why it matters:** ${stage.why}`,
          `- **Method:** ${stage.method}`,
          `- **Exercise:** ${stage.exercise}`,
          `- **Decision check:** ${stage.criteria}`,
          `- **Watch for:** ${stage.watch_for}`,
          `- **Output:** ${stage.output}`,
          `- **Move on when:** ${stage.completion}`,
          "",
        );
      }
      sectionQuestions.forEach((question) => {
        const saved = questionStates[question.question_id];
        const level = (saved && saved.planning_level) || question.planning_level;
        lines.push(
          `- **${question.prompt}** (${planningLabel(level)})\n`
          + markdownListItem(answerText(answers, question.question_id) || "Not yet answered", "  ")
          + (question.affects ? `\n  - Connects to: ${question.affects}` : ""),
        );
      });
      lines.push("");
    });
    let markdown = lines.join("\n").replace(/\s+$/, "") + "\n";

    const byId = new Map(questions.map((question) => [question.question_id, question]));
    const stateEntries = Object.entries(questionStates).filter(([questionId]) => byId.has(questionId));
    if (stateEntries.length) {
      markdown += "\n## Decision confidence\n\n";
      stateEntries.forEach(([questionId, state]) => {
        markdown += `- **${byId.get(questionId).prompt}** — ${planningLabel(state.planning_level)}, ${planningLabel(state.certainty)}\n`;
      });
    }
    const ideas = project.ideas || [];
    if (ideas.length) {
      markdown += "\n## Idea Inbox\n\n";
      ideas.forEach((idea) => {
        markdown += `### ${idea.category}\n\n${String(idea.text).trim()}\n\n`;
      });
    }
    const materials = project.materials || [];
    if (materials.length) {
      markdown += "\n## Original Materials\n\n";
      materials.forEach((material) => {
        markdown += `### ${material.category} — ${planningLabel(material.status)}\n\n`
          + `Source: ${String(material.source).trim()}\n\n${String(material.text).trim()}\n\n`;
      });
    }
    return markdown;
  }

  return Object.freeze({
    LIMITS,
    DEFAULT_TITLE,
    UNTITLED_TITLE,
    IDEA_CATEGORIES,
    MATERIAL_STATUSES,
    PLANNING_LEVELS,
    CERTAINTIES,
    THEMES,
    emptyProject,
    normalizeTitle,
    planningLabel,
    answerText,
    effectiveState,
    countsTowardProgress,
    isSettled,
    progress,
    stageComplete,
    isOpenDecision,
    isOpenMaterial,
    blockedDependencies,
    utf8Length,
    splitText,
    validationError,
    buildMarkdown,
  });
});
