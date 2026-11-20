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

  // --- Ready to Write Chapter One? (readme §7); mirrors readiness.py ---------

  const READINESS_SECTIONS = Object.freeze([
    ["address", "Address before drafting"],
    ["monitor", "Monitor while drafting"],
    ["discover", "Discover through drafting"],
    ["unknown", "Intentionally unknown"],
  ]);

  function assess(project, questions, stages) {
    const answers = project.answers || {};
    const states = project.question_states || {};
    const stageByTitle = new Map(stages.map((stage) => [stage.title, stage]));
    const dimensions = [];
    const byName = new Map();
    stages.forEach((stage) => {
      if (!byName.has(stage.dimension)) {
        const dimension = { name: stage.dimension, settled: 0, total: 0 };
        byName.set(stage.dimension, dimension);
        dimensions.push(dimension);
      }
    });
    const lists = { address: [], monitor: [], discover: [], unknown: [] };
    const checklist = [];
    let otherOpen = 0;
    questions.forEach((question) => {
      const stage = stageByTitle.get(question.section);
      const state = effectiveState(question, states);
      const entry = { question_id: question.question_id, prompt: question.prompt, stage: stage.label };
      const counted = countsTowardProgress(question, states);
      const settled = isSettled(question, answers, states);
      const answered = Boolean(answerText(answers, question.question_id));
      if (counted) {
        const dimension = byName.get(stage.dimension);
        dimension.total += 1;
        dimension.settled += settled ? 1 : 0;
        checklist.push({ ...entry, done: settled });
      }
      if (counted && !settled) lists.address.push(entry);
      else if (state.planning_level === "deferred") lists.discover.push(entry);
      else if (state.planning_level === "intentionally_unknown") lists.unknown.push(entry);
      else if (answered && state.certainty !== "settled") lists.monitor.push(entry);
      else if (!answered) otherOpen += 1;
    });
    return {
      ready: lists.address.length === 0,
      settled: dimensions.reduce((sum, dimension) => sum + dimension.settled, 0),
      total: dimensions.reduce((sum, dimension) => sum + dimension.total, 0),
      dimensions,
      ...lists,
      other_open: otherOpen,
      checklist,
      assessment: answerText(answers, "readiness_assessment"),
    };
  }

  function readinessVerdict(report) {
    if (report.ready && report.total === 0) {
      return "Ready by your choices: no decision is currently marked essential. Review the deferred items before drafting.";
    }
    if (report.ready) {
      const settled = report.total === 1 ? "the one essential decision is" : `all ${report.total} essential decisions are`;
      return `Ready: ${settled} settled for now. Keep an eye on the items below while drafting.`;
    }
    const open = report.address.length;
    const noun = open === 1 ? "decision is" : "decisions are";
    return `Not yet: ${open} of ${report.total} essential ${noun} still open. `
      + "Settle them, or mark any you are comfortable discovering while drafting as Deferred.";
  }

  function dimensionLine(dimension) {
    if (!dimension.total) return `${dimension.name}: no essential decisions marked`;
    const noun = dimension.total === 1 ? "decision" : "decisions";
    return `${dimension.name}: ${dimension.settled} of ${dimension.total} essential ${noun} settled`;
  }

  function otherOpenLine(count) {
    const noun = count === 1 ? "question is" : "questions are";
    return `${count} other ${noun} unanswered; none is essential, so they can be explored while drafting.`;
  }

  function readinessMarkdown(report) {
    const lines = ["## Ready to Write Chapter One?", "", readinessVerdict(report), ""];
    report.dimensions.forEach((dimension) => lines.push(`- ${dimensionLine(dimension)}`));
    lines.push("");
    READINESS_SECTIONS.forEach(([key, heading]) => {
      if (!report[key].length) return;
      lines.push(`### ${heading}`, "");
      report[key].forEach((entry) => lines.push(`- ${entry.stage}: ${entry.prompt}`));
      lines.push("");
    });
    if (report.other_open) lines.push(otherOpenLine(report.other_open), "");
    lines.push("### Your assessment", "", report.assessment || "Not yet written.", "");
    lines.push("## Pre-drafting checklist", "");
    if (report.checklist.length) {
      report.checklist.forEach((item) => lines.push(`- [${item.done ? "x" : " "}] ${item.stage}: ${item.prompt}`));
    } else {
      lines.push("- No decisions are currently marked essential.");
    }
    return lines.join("\n") + "\n";
  }

  // --- Planning helpers for the interface -------------------------------------

  // The response categories defined in readme.txt §5, plus decision states.
  const PLANNING_LEVEL_HELP = Object.freeze({
    essential: "Must be sufficiently resolved before writing can begin.",
    important: "Strongly recommended, but can be refined during drafting.",
    optional: "Useful for some novels or genres but not universally necessary.",
    deferred: "Better discovered or decided during drafting.",
    intentionally_unknown: "A deliberate mystery or ambiguity that should remain unresolved by design. If you know the answer but readers shouldn’t yet, answer it and plan the reveal instead.",
  });
  const CERTAINTY_HELP = Object.freeze({
    needs_work: "Not developed enough to build on yet.",
    provisional: "A working decision you expect to test or revise—recorded honestly instead of forcing certainty.",
    settled: "Solid enough to build on for now. You can still revise it later.",
  });

  // Where inbox notes of each category are most useful in the planner.
  const CATEGORY_STAGES = Object.freeze({
    Story: ["Stage A — Story Identity", "Stage B — Reader Promise"],
    "Tone & style": ["Stage C — Tone, Voice & Style"],
    Theme: ["Stage D — Theme"],
    Character: ["Stage E — Characters"],
    World: ["Stage F — World & Internal Logic"],
    Plot: ["Stage G — Conflict & Plot", "Stage H — Subplots & Integration"],
    Scene: ["Stage I — Scenes & Chapters"],
  });

  function categoriesForStage(stageTitle) {
    return Object.keys(CATEGORY_STAGES).filter((category) => CATEGORY_STAGES[category].includes(stageTitle));
  }

  function categoryForStage(stageTitle) {
    return categoriesForStage(stageTitle)[0] || "Unsorted";
  }

  /* Index of the first stage with an essential decision still open, or -1. */
  function nextStageIndex(stages, questions, answers, questionStates) {
    return stages.findIndex((stage) => questions.some((question) => question.section === stage.title
      && countsTowardProgress(question, questionStates) && !isSettled(question, answers, questionStates)));
  }

  function hasContent(project) {
    const title = normalizeTitle(project.title);
    return Object.values(project.answers || {}).some((answer) => String(answer).trim())
      || (project.ideas || []).length > 0
      || (project.materials || []).length > 0
      || (title !== DEFAULT_TITLE && title !== UNTITLED_TITLE);
  }

  // Short stable hash (FNV-1a) so repeated merges produce the same ids.
  function stableHash(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  /*
   * Combine work done before signing in (incoming) with the account's project
   * (base) without losing anything: blank answers are filled, differing answers
   * stay in the account and the browser's version is kept as tentative material
   * to review, and new ideas and materials are added. Safe to repeat: running it
   * again with the same input adds nothing. Returns { project, summary }.
   */
  function mergeProjects(base, incoming, questions) {
    const result = JSON.parse(JSON.stringify(base));
    result.answers = result.answers || {};
    result.question_states = result.question_states || {};
    result.ideas = result.ideas || [];
    result.materials = result.materials || [];
    const summary = { answersAdded: 0, answersKeptAsMaterial: 0, ideasAdded: 0, materialsAdded: 0, titleUsed: false };
    const baseTitle = normalizeTitle(result.title);
    const incomingTitle = normalizeTitle(incoming.title);
    const isDefault = (title) => title === DEFAULT_TITLE || title === UNTITLED_TITLE;
    if (isDefault(baseTitle) && !isDefault(incomingTitle)) {
      result.title = incomingTitle;
      summary.titleUsed = true;
    }
    if (incoming.theme) result.theme = incoming.theme;

    const byId = new Map(questions.map((question) => [question.question_id, question]));
    const materialIds = new Set(result.materials.map((material) => material.id));
    const materialKeys = new Set(result.materials.map((material) => `${String(material.source).trim()}|${String(material.text).trim()}`));
    const addMaterial = (material) => {
      const key = `${String(material.source).trim()}|${String(material.text).trim()}`;
      if (materialIds.has(material.id) || materialKeys.has(key)) return false;
      result.materials.push(material);
      materialIds.add(material.id);
      materialKeys.add(key);
      return true;
    };

    const incomingStates = incoming.question_states || {};
    Object.entries(incoming.answers || {}).forEach(([questionId, answer]) => {
      const text = String(answer || "").trim();
      const question = byId.get(questionId);
      if (!text || !question) return;
      const existing = answerText(result.answers, questionId);
      if (!existing) {
        result.answers[questionId] = answer;
        if (incomingStates[questionId]) result.question_states[questionId] = { ...incomingStates[questionId] };
        summary.answersAdded += 1;
      } else if (existing !== text) {
        const added = addMaterial({
          id: `earlier-${questionId}-${stableHash(text)}`.slice(0, 100),
          text,
          category: categoryForStage(question.section),
          status: "tentative",
          source: `Answer written before signing in: ${question.prompt}`.slice(0, LIMITS.source),
        });
        if (added) summary.answersKeptAsMaterial += 1;
      }
    });
    Object.entries(incomingStates).forEach(([questionId, state]) => {
      if (byId.has(questionId) && !result.question_states[questionId] && !answerText(result.answers, questionId)) {
        result.question_states[questionId] = { ...state };
      }
    });

    const ideaIds = new Set(result.ideas.map((idea) => idea.id));
    const ideaKeys = new Set(result.ideas.map((idea) => `${idea.category}|${String(idea.text).trim()}`));
    (incoming.ideas || []).forEach((idea) => {
      const key = `${idea.category}|${String(idea.text).trim()}`;
      if (ideaKeys.has(key)) return;
      const id = ideaIds.has(idea.id) ? `${idea.id}-${stableHash(key)}`.slice(0, 100) : idea.id;
      result.ideas.push({ ...idea, id });
      ideaIds.add(id);
      ideaKeys.add(key);
      summary.ideasAdded += 1;
    });
    (incoming.materials || []).forEach((material) => {
      if (addMaterial({ ...material })) summary.materialsAdded += 1;
    });
    return { project: result, summary };
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
          `- **Draws on:** ${stage.sources}`,
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
    markdown += "\n" + readinessMarkdown(assess(project, questions, stages));

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
    assess,
    readinessVerdict,
    dimensionLine,
    otherOpenLine,
    readinessMarkdown,
    READINESS_SECTIONS,
    PLANNING_LEVEL_HELP,
    CERTAINTY_HELP,
    categoriesForStage,
    categoryForStage,
    nextStageIndex,
    hasContent,
    mergeProjects,
    stableHash,
  });
});
