"use strict";

/*
 * Novel Architect browser application.
 *
 * Storage modes (chosen from GET /api/config):
 *   local     web_app.py: one project in a JSON file, no accounts
 *   builtin   app.py with its own accounts (SQLite)
 *   supabase  app.py with Supabase Auth and Postgres
 *   indexeddb static hosting (GitHub Pages): profiles and projects stay in this browser
 *
 * Signing in is optional in every mode: visitors plan right away with their
 * project kept in this browser, and sign-in is offered as they work.
 */

const Logic = window.PlannerLogic;
const { LIMITS } = Logic;

const SUPABASE_SDK = Object.freeze({
  src: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js",
  integrity: "sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK",
});
const STORAGE_KEYS = Object.freeze({
  promptDismissed: "novel-architect-signin-prompt-dismissed",
  token: "novel-architect-auth-token",
  staticEmail: "novel-architect-auth-email",
  legacyProject: "novel-architect-project",
  migratedProject: "novel-architect-project-migrated",
  theme: "novel-architect-theme",
});
const AUTH_COPY = Object.freeze({
  account: "Sign in or create an account to keep your project with your account and open it on any device. "
    + "Anything you wrote before signing in comes with you.",
  indexeddb: "Profiles keep separate projects for different people using this browser. This public demo has no server: "
    + "profiles and projects stay in this browser only, don't sync to other devices, and are deleted if this site's data "
    + "is cleared, so export your plan regularly. Anything you wrote before signing in comes with you.",
});
const PROMPT_COPY = Object.freeze({
  account: "Your work is saved in this browser. Sign in or create an account to keep it with your account and open it on any device.",
  indexeddb: "Your work is saved in this browser. If other people use this browser, create a profile to keep your project "
    + "separate. This demo has no server, so profiles stay on this device.",
});
const PROMPT_DISMISS_DAYS = 14;
const GUEST_OWNER = "guest";
const SAVE_DELAY = 400;
const MAX_RETRY_DELAY = 30000;

const state = Logic.emptyProject();
let questionBank = [];
let stages = [];
let activeStage = -1;
let appLoaded = false;
let toastTimer;

const session = {
  mode: "local",
  target: "local",
  token: "",
  user: null,
  supabase: null,
  staticUser: null,
  authRedirectUrl: "",
};
const sync = {
  dirty: false,
  editVersion: 0,
  inFlight: null,
  timer: null,
  retryDelay: 0,
  blocked: null, // null | { kind: "invalid" | "conflict" | "auth", message }
  pendingConflict: null,
};

const $ = (selector) => document.querySelector(selector);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private browsing, blocked site data).
  }
}

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function setStatus(message, tone = "ok") {
  const status = $("#save-state");
  status.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "save-dot";
  status.append(dot, document.createTextNode(` ${message}`));
  status.classList.toggle("error", tone === "error");
  status.classList.toggle("pending", tone === "pending");
}

function savedLabel() {
  return ["guest", "profile", "memory"].includes(session.target) ? "Saved in this browser" : "All changes saved";
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

async function responseDetail(response, fallback) {
  try {
    const body = await response.json();
    return body.detail || body.error || fallback;
  } catch {
    return fallback;
  }
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (session.token) headers.set("Authorization", `Bearer ${session.token}`);
  return fetch(url, { ...options, headers, cache: "no-store" });
}

// ---------------------------------------------------------------------------
// Project state
// ---------------------------------------------------------------------------

function replaceProject(project) {
  const fresh = Logic.emptyProject();
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, fresh, project || {});
  state.answers = state.answers || {};
  state.question_states = state.question_states || {};
  state.ideas = state.ideas || [];
  state.materials = state.materials || [];
  state.revision = Number.isInteger(state.revision) ? state.revision : 0;
  if (!Logic.THEMES.includes(state.theme)) state.theme = "dark";
}

function projectPayload() {
  return {
    title: state.title,
    answers: state.answers,
    question_states: state.question_states,
    ideas: state.ideas,
    materials: state.materials,
    theme: state.theme,
    revision: state.revision,
  };
}

function questionById(questionId) {
  return questionBank.find((question) => question.question_id === questionId);
}

function questionsForStage(stageTitle) {
  return questionBank.filter((question) => question.section === stageTitle);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function markDirty() {
  sync.dirty = true;
  sync.editVersion += 1;
  if (sync.blocked && sync.blocked.kind === "invalid") sync.blocked = null;
  if (sync.blocked) return; // waiting for the author to resolve a conflict or log in again
  setStatus("Unsaved changes", "pending");
  scheduleSave(SAVE_DELAY);
}

function scheduleSave(delay) {
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => { saveProject(); }, delay);
}

function hasUnsavedWork() {
  return sync.dirty || Boolean(sync.inFlight);
}

async function persist(payload) {
  if (session.target === "guest" || session.target === "profile") {
    const owner = session.target === "guest" ? GUEST_OWNER : session.staticUser.id;
    try {
      return { ok: true, project: await saveBrowserProject(owner, payload) };
    } catch (error) {
      if (error && error.conflict) return { ok: false, status: 409, project: error.current };
      return { ok: false, status: 0, detail: "This browser could not store the project." };
    }
  }
  let response;
  try {
    response = await apiFetch("/api/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, status: 0, detail: "The server could not be reached." };
  }
  if (response.ok) {
    try {
      return { ok: true, project: await response.json() };
    } catch {
      return { ok: false, status: 0, detail: "The server sent an unexpected response." };
    }
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { ok: false, status: response.status, detail: body.detail || body.error, project: body.project };
}

/*
 * Save the project if it has unsaved changes. Resolves true once everything
 * the author typed so far is stored. Saves never overlap, and each one carries
 * the revision it was based on so the server can refuse a stale overwrite.
 */
async function saveProject({ force = false } = {}) {
  clearTimeout(sync.timer);
  // Wait for any save in progress, including one that chains another save.
  while (sync.inFlight) await sync.inFlight;
  if (!sync.dirty) return true;
  if (sync.blocked && !force) return false;
  if (force) sync.blocked = null;

  const problem = Logic.validationError(state);
  if (problem) return blockSaving("invalid", problem);
  const payload = projectPayload();
  const body = JSON.stringify(payload);
  if (Logic.utf8Length(body) > LIMITS.requestBytes) {
    return blockSaving("invalid", "The project is larger than 2 MB, so the latest change was not saved. Remove or shorten some imported material.");
  }

  const version = sync.editVersion;
  setStatus("Saving…", "pending");
  sync.inFlight = persist(payload);
  let result;
  try {
    result = await sync.inFlight;
  } finally {
    sync.inFlight = null;
  }

  if (result.ok) {
    state.revision = result.project.revision;
    state.saved_at = result.project.saved_at;
    sync.retryDelay = 0;
    if (sync.editVersion === version) {
      sync.dirty = false;
      setStatus(savedLabel());
      renderProgress();
      maybeOfferSignIn();
      return true;
    }
    // More edits arrived while saving; store them too.
    return saveProject();
  }
  if (result.status === 409) {
    showConflict(result.project);
    return false;
  }
  if (result.status === 401) {
    session.target = "expired";
    session.token = "";
    writeStorage(STORAGE_KEYS.token, null);
    sync.blocked = { kind: "auth", message: "Session expired" };
    setStatus("Not saved — sign in again", "error");
    renderAccountControls();
    showAuthPage(
      "Your session has expired. Sign in again to keep saving to your account, or continue without signing in to keep your changes in this browser.",
      { error: true, reason: "expired" },
    );
    return false;
  }
  if (result.status === 400 || result.status === 413 || result.status === 422) {
    return blockSaving("invalid", result.detail || "The project could not be saved.");
  }
  // Network failure or temporary server problem: retry with backoff.
  sync.retryDelay = Math.min(MAX_RETRY_DELAY, sync.retryDelay ? sync.retryDelay * 2 : 1000);
  setStatus(`Not saved yet — retrying in ${Math.round(sync.retryDelay / 1000)}s`, "error");
  scheduleSave(sync.retryDelay);
  return false;
}

function blockSaving(kind, message) {
  sync.blocked = { kind, message };
  setStatus("Not saved — see message", "error");
  toast(message);
  return false;
}

function showConflict(serverProject) {
  sync.blocked = { kind: "conflict", message: "Conflict" };
  sync.pendingConflict = serverProject || Logic.emptyProject();
  const saved = sync.pendingConflict.saved_at ? ` (saved ${new Date(sync.pendingConflict.saved_at).toLocaleString()})` : "";
  $("#sync-banner-text").textContent =
    `This project was changed in another window or on another device${saved}. `
    + "Your latest edits in this window are not saved yet. Load the saved version to discard them, "
    + "or keep your version to replace the other changes.";
  $("#sync-banner").hidden = false;
  setStatus("Not saved — resolve the conflict", "error");
}

function resolveConflict(keepMine) {
  const serverProject = sync.pendingConflict || Logic.emptyProject();
  sync.pendingConflict = null;
  sync.blocked = null;
  $("#sync-banner").hidden = true;
  if (keepMine) {
    state.revision = serverProject.revision || 0;
    sync.dirty = true;
    saveProject({ force: true });
    return;
  }
  replaceProject(serverProject);
  sync.dirty = false;
  renderAll();
  setStatus(savedLabel());
  toast("Loaded the saved version of the project.");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function applyTheme() {
  const theme = Logic.THEMES.includes(state.theme) ? state.theme : "dark";
  document.documentElement.dataset.theme = theme;
  $("#theme-select").value = theme;
  writeStorage(STORAGE_KEYS.theme, theme);
}

function renderNavigation() {
  const nav = $("#stage-nav");
  nav.replaceChildren();
  const inbox = document.createElement("button");
  inbox.type = "button";
  inbox.className = `nav-item ${activeStage === -1 ? "active" : ""}`;
  inbox.innerHTML = '<span class="nav-number">✳</span><span>Idea inbox</span>';
  inbox.addEventListener("click", showInbox);
  nav.append(inbox);

  stages.forEach((stage, index) => {
    const button = document.createElement("button");
    button.type = "button";
    const complete = Logic.stageComplete(questionsForStage(stage.title), state.answers, state.question_states);
    button.className = `nav-item ${activeStage === index ? "active" : ""} ${complete ? "done" : ""}`;
    button.innerHTML = `<span class="nav-number">${complete ? "✓" : String(index + 1).padStart(2, "0")}</span><span>${escapeHtml(stage.label)}</span>`;
    if (complete) button.setAttribute("aria-label", `${stage.label} (essential decisions settled)`);
    button.addEventListener("click", () => showStage(index));
    nav.append(button);
  });
  $("#overview-button").classList.toggle("active", activeStage === -2);
  $("#admin-button").classList.toggle("active", activeStage === -3);
}

function renderProgress() {
  const { settled, total, percent } = Logic.progress(questionBank, state.answers, state.question_states);
  $("#progress-value").textContent = `${percent}%`;
  $("#progress-bar").style.width = `${percent}%`;
  $("#progress-detail").textContent = `${settled} of ${total} essential decisions settled`;
  renderContinueCard();
  renderNavigation();
}

function renderIdeas() {
  const list = $("#idea-list");
  list.replaceChildren();
  $("#idea-count").textContent = String(state.ideas.length);
  $("#empty-ideas").hidden = state.ideas.length > 0;
  state.ideas.forEach((idea) => {
    const card = document.createElement("article");
    card.className = "idea-card";
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.className = "idea-text";
    text.textContent = idea.text;
    const meta = document.createElement("div");
    meta.className = "idea-meta";
    const category = document.createElement("select");
    category.className = "idea-category-select";
    category.setAttribute("aria-label", "Idea category");
    Logic.IDEA_CATEGORIES.forEach((value) => category.append(option(value, value)));
    category.value = idea.category;
    category.addEventListener("change", () => {
      idea.category = category.value;
      markDirty();
    });
    meta.append(category);
    content.append(text, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-idea";
    remove.setAttribute("aria-label", "Remove idea");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.ideas = state.ideas.filter((item) => item.id !== idea.id);
      renderIdeas();
      markDirty();
    });
    card.append(content, remove);
    list.append(card);
  });
}

function overviewEntries(filter) {
  const entries = [];
  questionBank.forEach((question) => {
    const answer = Logic.answerText(state.answers, question.question_id);
    const open = Logic.isOpenDecision(question, state.answers, state.question_states);
    if (!answer && !(filter === "open" && open)) return;
    const decision = Logic.effectiveState(question, state.question_states);
    entries.push({
      type: "answers",
      open,
      title: question.prompt,
      text: answer || "Not yet answered.",
      meta: `${question.section} · ${Logic.planningLabel(decision.planning_level)} · ${Logic.planningLabel(decision.certainty)}`,
      questionId: question.question_id,
    });
  });
  state.ideas.forEach((idea) => entries.push({
    type: "ideas", open: false, title: idea.category, text: idea.text, meta: "Idea inbox · author note",
  }));
  state.materials.forEach((material) => entries.push({
    type: "materials",
    open: Logic.isOpenMaterial(material),
    title: material.category,
    text: material.text,
    meta: `${Logic.planningLabel(material.status)} · ${material.source}`,
    id: material.id,
  }));
  return entries.filter((entry) => {
    if (filter === "open") return entry.open;
    return filter === "all" || entry.type === filter;
  });
}

function renderOverview() {
  renderReadiness();
  const list = $("#overview-list");
  const query = ($("#overview-search").value || "").trim().toLowerCase();
  const filter = $("#overview-filter").value;
  const entries = overviewEntries(filter).filter(
    (entry) => !query || `${entry.title} ${entry.text} ${entry.meta}`.toLowerCase().includes(query),
  );
  const { settled, total } = Logic.progress(questionBank, state.answers, state.question_states);
  $("#overview-summary").textContent =
    `${settled} of ${total} essential decisions settled · ${state.ideas.length} ideas · ${state.materials.length} original materials`;
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "overview-empty";
    empty.textContent = "Nothing matches this view yet.";
    list.append(empty);
    return;
  }
  entries.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "overview-card";
    const heading = document.createElement("h3");
    heading.textContent = entry.title;
    const meta = document.createElement("div");
    meta.className = "overview-meta";
    meta.textContent = entry.meta;
    const text = document.createElement("p");
    text.textContent = entry.text;
    card.append(heading, meta, text);
    if (entry.type === "answers") {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary-button";
      edit.textContent = "Open in planner";
      edit.addEventListener("click", () => openQuestion(entry.questionId));
      card.append(edit);
    }
    if (entry.type === "materials") {
      const material = state.materials.find((item) => item.id === entry.id);
      if (material) card.append(materialControls(material, entry.title));
    }
    list.append(card);
  });
}

function materialControls(material, title) {
  const controls = document.createElement("div");
  controls.className = "overview-controls";
  const status = document.createElement("select");
  status.setAttribute("aria-label", `Review status for ${title}`);
  [
    ["imported", "Imported — review"],
    ["approved", "Approved"],
    ["tentative", "Tentative"],
    ["deferred", "Deferred"],
    ["intentionally_unknown", "Intentionally unknown"],
    ["archived", "Archived"],
  ].forEach(([value, label]) => status.append(option(value, label)));
  status.value = material.status;
  status.addEventListener("change", () => {
    material.status = status.value;
    markDirty();
    renderOverview();
  });
  const category = document.createElement("select");
  category.setAttribute("aria-label", `Category for ${title}`);
  Logic.IDEA_CATEGORIES.forEach((value) => category.append(option(value, value)));
  category.value = material.category;
  category.addEventListener("change", () => {
    material.category = category.value;
    markDirty();
    renderOverview();
  });
  controls.append(status, category);
  return controls;
}

function setActiveSection(id) {
  ["idea-inbox", "question-page", "overview-page", "admin-page"].forEach((sectionId) => {
    $(`#${sectionId}`).classList.toggle("active", sectionId === id);
  });
}

function showInbox() {
  activeStage = -1;
  setActiveSection("idea-inbox");
  $("#current-breadcrumb").textContent = "IDEA INBOX";
  renderNavigation();
}

function showOverview({ focusReadiness = false } = {}) {
  activeStage = -2;
  setActiveSection("overview-page");
  $("#current-breadcrumb").textContent = "PROJECT OVERVIEW";
  renderOverview();
  renderNavigation();
  if (focusReadiness) $("#readiness").scrollIntoView({ block: "start" });
  else window.scrollTo({ top: 0, behavior: "smooth" });
}

function excerpt(text, length = 220) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* Notes from the idea inbox and imported material filed under this stage's categories. */
function renderStageNotes(stage) {
  const block = $("#stage-notes");
  const categories = Logic.categoriesForStage(stage.title);
  const notes = [
    ...state.ideas.filter((idea) => categories.includes(idea.category)).map((idea) => ({ text: idea.text, source: "Idea" })),
    ...state.materials
      .filter((material) => categories.includes(material.category) && material.status !== "archived")
      .map((material) => ({ text: material.text, source: `${Logic.planningLabel(material.status)} material · ${material.source}` })),
  ];
  block.hidden = notes.length === 0;
  if (!notes.length) return;
  $("#stage-notes-summary").textContent = `Your notes for this stage (${notes.length}) — ${categories.join(" and ")}`;
  const list = $("#stage-notes-list");
  list.replaceChildren();
  notes.forEach((note) => {
    const item = element("li");
    item.append(element("span", "note-source", note.source), element("span", "note-text", excerpt(note.text, 400)));
    list.append(item);
  });
}

function questionContext(question, promptsById) {
  const dependencies = question.dependencies || [];
  if (!dependencies.length) return null;
  const answered = dependencies.filter((id) => Logic.answerText(state.answers, id)).length;
  const details = element("details", "question-context");
  details.append(element("summary", "", `What you've already decided (${answered} of ${dependencies.length} answered)`));
  dependencies.forEach((id) => {
    const answer = Logic.answerText(state.answers, id);
    const item = element("p", "context-item");
    item.append(element("strong", "", promptsById.get(id) || id), element("span", answer ? "" : "context-missing", answer ? excerpt(answer) : "Not answered yet."));
    details.append(item);
  });
  return details;
}

function answerHelp(question) {
  const details = element("details", "answer-help");
  details.append(element("summary", "", "What makes a strong answer"));
  [
    ["A strong answer", question.strong],
    ["A common weak answer", question.weak],
    ["Example", question.examples],
  ].forEach(([label, text]) => {
    if (!text) return;
    const paragraph = element("p");
    paragraph.append(element("strong", "", `${label}: `), document.createTextNode(text));
    details.append(paragraph);
  });
  return details;
}

function showStage(index, focusQuestionId) {
  if (index < 0 || index >= stages.length) return;
  activeStage = index;
  const stage = stages[index];
  setActiveSection("question-page");
  $("#current-breadcrumb").textContent = stage.label.toUpperCase();
  $("#stage-heading").textContent = stage.label;
  $("#stage-intro").textContent = stage.intro;
  const guide = $("#stage-guide");
  guide.replaceChildren();
  [
    ["PURPOSE", stage.purpose],
    ["WHY IT MATTERS", stage.why],
    ["A WAY IN", stage.method],
    ["TRY THIS", stage.exercise],
  ].forEach(([label, text]) => {
    const block = element("div", "guide-block");
    block.append(element("span", "guide-label", label), element("p", "", text));
    guide.append(block);
  });
  $("#stage-output").textContent = stage.output;
  $("#stage-completion").textContent = stage.completion;
  $("#stage-criteria").textContent = stage.criteria;
  $("#stage-watch").textContent = stage.watch_for;
  $("#stage-sources").textContent = stage.sources;
  renderStageNotes(stage);
  const container = $("#question-list");
  container.replaceChildren();
  const promptsById = new Map(questionBank.map((item) => [item.question_id, item.prompt]));
  let focusTarget = null;

  questionsForStage(stage.title).forEach((question) => {
    const blocked = Logic.blockedDependencies(question, state.answers).length > 0;
    const card = element("article", `question-card ${blocked ? "question-locked" : ""}`);
    card.dataset.questionId = question.question_id;
    const heading = element("h3", "", question.prompt);
    const description = element("p", "question-meta", [question.definition, question.purpose].filter(Boolean).join(" "));

    const controls = element("div", "answer-controls");
    const importance = document.createElement("select");
    importance.setAttribute("aria-label", `Planning status for ${question.prompt}`);
    [
      ["essential", "Essential"],
      ["important", "Important"],
      ["optional", "Optional"],
      ["deferred", "Deferred"],
      ["intentionally_unknown", "Intentionally unknown"],
    ].forEach(([value, label]) => {
      const choice = option(value, label);
      choice.title = Logic.PLANNING_LEVEL_HELP[value];
      importance.append(choice);
    });
    const decision = document.createElement("select");
    decision.setAttribute("aria-label", `Decision state for ${question.prompt}`);
    [
      ["needs_work", "Needs development"],
      ["provisional", "Provisional"],
      ["settled", "Settled for now"],
    ].forEach(([value, label]) => {
      const choice = option(value, label);
      choice.title = Logic.CERTAINTY_HELP[value];
      decision.append(choice);
    });
    const current = Logic.effectiveState(question, state.question_states);
    importance.value = current.planning_level;
    decision.value = current.certainty;
    importance.disabled = blocked;
    decision.disabled = blocked;
    const statusHelp = element("p", "status-help");
    const describeStatus = () => {
      statusHelp.textContent = `${Logic.planningLabel(importance.value)}: ${Logic.PLANNING_LEVEL_HELP[importance.value]}`;
    };
    describeStatus();
    const updateQuestionState = () => {
      state.question_states[question.question_id] = {
        planning_level: importance.value,
        certainty: decision.value,
      };
      describeStatus();
      markDirty();
      renderProgress();
    };
    importance.addEventListener("change", updateQuestionState);
    decision.addEventListener("change", updateQuestionState);
    [["PLANNING STATUS", importance], ["DECISION STATE", decision]].forEach(([labelText, select]) => {
      const wrap = element("div");
      wrap.append(element("label", "", labelText), select);
      controls.append(wrap);
    });

    const textarea = document.createElement("textarea");
    textarea.value = state.answers[question.question_id] || "";
    textarea.disabled = blocked;
    textarea.maxLength = LIMITS.answer;
    textarea.placeholder = "Capture your thoughts…";
    textarea.setAttribute("aria-label", question.prompt);
    textarea.addEventListener("input", () => {
      state.answers[question.question_id] = textarea.value;
      const saved = state.question_states[question.question_id];
      if (saved && saved.certainty === "settled") {
        // Editing a settled answer reopens it for review.
        saved.certainty = "provisional";
        decision.value = "provisional";
      }
      markDirty();
      renderProgress();
    });

    const context = questionContext(question, promptsById);
    card.append(heading, description);
    if (context) card.append(context);
    card.append(controls, statusHelp, textarea);
    if (question.template) {
      const worksheet = element("button", "text-button worksheet-button", "Insert worksheet");
      worksheet.type = "button";
      worksheet.disabled = blocked;
      worksheet.addEventListener("click", () => {
        const existing = textarea.value.replace(/\s+$/, "");
        textarea.value = existing ? `${existing}\n\n${question.template}` : question.template;
        textarea.dispatchEvent(new Event("input"));
        textarea.focus();
      });
      card.append(worksheet);
    }
    if (blocked) {
      card.append(element("p", "question-dependencies", "Answer the prerequisite questions before developing this decision."));
    }
    if (question.guidance) card.append(element("p", "question-hint", question.guidance));
    card.append(answerHelp(question));
    if (question.affects) card.append(element("p", "question-affects", `This connects to: ${question.affects}`));
    container.append(card);
    if (question.question_id === focusQuestionId) focusTarget = { card, textarea };
  });

  const last = index === stages.length - 1;
  $("#stage-readiness-link").hidden = !last;
  $("#previous-stage").disabled = index === 0;
  $("#previous-stage").style.visibility = index === 0 ? "hidden" : "visible";
  $("#next-stage").textContent = last ? "Back to idea inbox" : "Next section →";
  renderNavigation();
  if (focusTarget) {
    focusTarget.card.scrollIntoView({ block: "center" });
    if (!focusTarget.textarea.disabled) focusTarget.textarea.focus({ preventScroll: true });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

/* The response categories from readme.txt §5 and the decision states, explained once per stage page. */
function renderStatusLegend() {
  const legend = $("#status-legend");
  legend.replaceChildren();
  Object.entries(Logic.PLANNING_LEVEL_HELP).forEach(([value, help]) => {
    legend.append(element("dt", "", Logic.planningLabel(value)), element("dd", "", help));
  });
  const certainties = { needs_work: "Needs development", provisional: "Provisional", settled: "Settled for now" };
  Object.entries(Logic.CERTAINTY_HELP).forEach(([value, help]) => {
    legend.append(element("dt", "", certainties[value]), element("dd", "", help));
  });
}

/* "Begin planning" becomes "Continue with …" once work is underway (readme §9). */
function nextPlanningStep() {
  const answered = Object.values(state.answers).some((answer) => String(answer).trim());
  if (!answered) return { label: "Begin planning", index: 0 };
  const next = Logic.nextStageIndex(stages, questionBank, state.answers, state.question_states);
  if (next >= 0) return { label: `Continue with ${stages[next].label}`, index: next };
  return { label: "Review Chapter One readiness", index: -1 };
}

function renderContinueCard() {
  if (!stages.length) return;
  const { label } = nextPlanningStep();
  $("#continue-planning-label").textContent = label;
}

function continuePlanning() {
  const { index } = nextPlanningStep();
  if (index >= 0) showStage(index);
  else showOverview({ focusReadiness: true });
}

function openQuestion(questionId) {
  const question = questionById(questionId);
  if (question) showStage(stages.findIndex((stage) => stage.title === question.section), questionId);
}

function renderReadiness() {
  const report = Logic.assess(state, questionBank, stages);
  $("#readiness-verdict").textContent = Logic.readinessVerdict(report);
  $("#readiness").classList.toggle("is-ready", report.ready);
  const dimensions = $("#readiness-dimensions");
  dimensions.replaceChildren();
  report.dimensions.forEach((dimension) => {
    const item = element("li", dimension.total && dimension.settled === dimension.total ? "complete" : "");
    item.textContent = Logic.dimensionLine(dimension);
    dimensions.append(item);
  });
  const lists = $("#readiness-lists");
  lists.replaceChildren();
  Logic.READINESS_SECTIONS.forEach(([key, heading]) => {
    if (!report[key].length) return;
    const group = element("div", "readiness-group");
    group.append(element("h3", "", heading));
    const list = element("ul");
    report[key].forEach((entry) => {
      const item = element("li");
      const open = element("button", "text-button", "Open");
      open.type = "button";
      open.addEventListener("click", () => openQuestion(entry.question_id));
      item.append(element("span", "", `${entry.stage}: ${entry.prompt}`), open);
      list.append(item);
    });
    group.append(list);
    lists.append(group);
  });
  if (report.other_open) lists.append(element("p", "readiness-note", Logic.otherOpenLine(report.other_open)));
  const assessment = element("p", "readiness-note");
  assessment.append(element("strong", "", "Your assessment: "), document.createTextNode(report.assessment || "Not yet written — answer the last question in Stage J."));
  lists.append(assessment);
}

function renderAll() {
  applyTheme();
  $("#project-title").value = state.title;
  renderIdeas();
  renderProgress();
  if (activeStage >= 0) showStage(activeStage);
  else if (activeStage === -2) showOverview();
  else if (activeStage === -3) showAdmin();
  else showInbox();
}

// ---------------------------------------------------------------------------
// Ideas and imported material
// ---------------------------------------------------------------------------

function addIdea() {
  const textarea = $("#idea-text");
  const text = textarea.value.trim();
  if (!text) {
    textarea.focus();
    toast("Write a thought or fragment before saving it.");
    return;
  }
  if (text.length > LIMITS.idea) {
    toast(`Ideas can be up to ${LIMITS.idea.toLocaleString("en-US")} characters. Use “Import as material” for longer text.`);
    return;
  }
  if (state.ideas.length >= LIMITS.items) {
    toast(`A project can hold ${LIMITS.items} ideas. Remove some before adding more.`);
    return;
  }
  state.ideas.unshift({ id: newId(), text, category: $("#idea-category").value });
  textarea.value = "";
  renderIdeas();
  markDirty();
  toast("Idea added to your shelf.");
}

/*
 * Import text as one or more materials (long text is split into parts).
 * Returns { added, problem } where problem explains why nothing was added.
 */
function importMaterial(rawText, source) {
  const text = String(rawText).replace(/^\uFEFF/, "");
  const label = String(source || "Pasted material").trim().slice(0, 200) || "Pasted material";
  if (!text.trim()) return { added: 0, problem: `${label} is empty` };
  if (text.includes("\u0000")) return { added: 0, problem: `${label} is not a plain-text file` };
  const parts = Logic.splitText(text, LIMITS.material);
  if (state.materials.length + parts.length > LIMITS.items) {
    return { added: 0, problem: `${label} would exceed the limit of ${LIMITS.items} imported materials` };
  }
  const projectedBytes = Logic.utf8Length(JSON.stringify(projectPayload()))
    + Logic.utf8Length(JSON.stringify(parts)) + 300 * parts.length;
  if (projectedBytes > LIMITS.requestBytes) {
    return { added: 0, problem: `${label} is too large (a project holds about 2 MB of text in total)` };
  }
  const items = parts.map((part, index) => ({
    id: newId(),
    text: part,
    category: "Unsorted",
    status: "imported",
    source: parts.length > 1 ? `${label} (part ${index + 1} of ${parts.length})` : label,
  }));
  state.materials.unshift(...items);
  markDirty();
  renderOverview();
  return { added: items.length, problem: null };
}

function importSummary(added, problems) {
  const parts = [];
  if (added) parts.push(added === 1 ? "Imported 1 material for review." : `Imported ${added} materials for review.`);
  if (problems.length) parts.push(`Not imported: ${problems.join("; ")}.`);
  return parts.join(" ") || "Nothing was imported.";
}

async function importFiles(files) {
  let added = 0;
  const problems = [];
  for (const file of files) {
    try {
      const result = importMaterial(await file.text(), file.name);
      added += result.added;
      if (result.problem) problems.push(result.problem);
    } catch (error) {
      console.error(error);
      problems.push(`${file.name} could not be read`);
    }
  }
  if (files.length) toast(importSummary(added, problems));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function downloadBlob(blob, fileName) {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

async function exportPlan(kind) {
  const storageBlocked = Boolean(sync.blocked && sync.blocked.kind === "storage");
  if (!(await saveProject()) && !storageBlocked) {
    toast(sync.blocked ? "Your latest changes are not saved yet, so the export was not created." : "Your changes could not be saved. Try exporting again.");
    return;
  }
  if (session.mode === "indexeddb") {
    if (kind === "pdf") {
      renderPrintView();
      document.body.classList.add("printing-plan");
      window.addEventListener("afterprint", () => document.body.classList.remove("printing-plan"), { once: true });
      window.print();
      return;
    }
    const markdown = Logic.buildMarkdown(state, questionBank, stages);
    downloadBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), "novel-writing-plan.md");
    maybeOfferSignIn();
    return;
  }
  const url = kind === "pdf" ? "/api/export/pdf" : "/api/export";
  // Signed-in exports use the saved project; visitors send the project they see.
  const response = isSignedIn() || session.target === "local"
    ? await apiFetch(url)
    : await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(projectPayload()) });
  if (!response.ok) {
    toast(await responseDetail(response, "The export could not be generated."));
    return;
  }
  downloadBlob(await response.blob(), kind === "pdf" ? "novel-writing-plan.pdf" : "novel-writing-plan.md");
  maybeOfferSignIn();
}

function renderPrintView() {
  const view = $("#print-view");
  view.replaceChildren();
  const add = (tag, text, className) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    view.append(element);
    return element;
  };
  add("h1", Logic.normalizeTitle(state.title));
  add("p", "Novel Development Blueprint", "print-subtitle");
  add("p", `Exported ${new Date().toLocaleString()}`, "print-meta");
  const guides = new Map(stages.map((stage) => [stage.title, stage]));
  stages.forEach((stage) => {
    add("h2", stage.title);
    const guide = guides.get(stage.title);
    if (guide) {
      add("p", guide.purpose, "print-guide");
      add("p", `Output: ${guide.output}`, "print-guide");
      add("p", `Completion: ${guide.completion}`, "print-guide");
      add("p", `Draws on: ${guide.sources}`, "print-guide");
    }
    questionsForStage(stage.title).forEach((question) => {
      const decision = Logic.effectiveState(question, state.question_states);
      add("h3", question.prompt);
      add("p", `${Logic.planningLabel(decision.planning_level)} · ${Logic.planningLabel(decision.certainty)}`, "print-status");
      add("p", Logic.answerText(state.answers, question.question_id) || "Not yet answered", "print-answer");
    });
  });
  const report = Logic.assess(state, questionBank, stages);
  add("h2", "Ready to Write Chapter One?");
  add("p", Logic.readinessVerdict(report), "print-answer");
  report.dimensions.forEach((dimension) => add("p", `• ${Logic.dimensionLine(dimension)}`, "print-guide"));
  Logic.READINESS_SECTIONS.forEach(([key, heading]) => {
    if (!report[key].length) return;
    add("h3", heading);
    report[key].forEach((entry) => add("p", `• ${entry.stage}: ${entry.prompt}`, "print-guide"));
  });
  if (report.other_open) add("p", Logic.otherOpenLine(report.other_open), "print-guide");
  add("h3", "Your assessment");
  add("p", report.assessment || "Not yet written.", "print-answer");
  add("h2", "Pre-drafting checklist");
  if (report.checklist.length) {
    report.checklist.forEach((item) => add("p", `${item.done ? "☑" : "☐"} ${item.stage}: ${item.prompt}`, "print-guide"));
  } else {
    add("p", "No decisions are currently marked essential.", "print-guide");
  }
  if (state.ideas.length || state.materials.length) {
    add("h2", "Collected Material");
    state.ideas.forEach((idea) => {
      add("h3", `${idea.category} · Idea (Idea inbox)`);
      add("p", idea.text, "print-answer");
    });
    state.materials.forEach((material) => {
      add("h3", `${material.category} · ${Logic.planningLabel(material.status)} (${material.source})`);
      add("p", material.text, "print-answer");
    });
  }
}

// ---------------------------------------------------------------------------
// Administration (server modes only)
// ---------------------------------------------------------------------------

async function showAdmin() {
  activeStage = -3;
  setActiveSection("admin-page");
  $("#current-breadcrumb").textContent = "DATABASE ADMIN";
  renderNavigation();
  await loadAdminProjects();
}

async function loadAdminProjects() {
  const list = $("#admin-project-list");
  list.textContent = "Loading projects…";
  const response = await apiFetch("/api/admin/projects");
  if (!response.ok) {
    list.textContent = await responseDetail(response, "Administrator access is not available.");
    return;
  }
  const projects = await response.json();
  list.replaceChildren();
  if (!projects.length) {
    list.textContent = "No user projects have been saved yet.";
    return;
  }
  projects.forEach((project) => {
    const card = document.createElement("article");
    card.className = "overview-card";
    const heading = document.createElement("h3");
    heading.textContent = project.title || "Untitled project";
    const meta = document.createElement("p");
    const owner = project.email ? `${project.email} (${project.owner_id})` : project.owner_id;
    meta.textContent = `${owner} · Updated ${project.updated_at || "unknown"} · Revision ${project.revision || 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary-button";
    remove.textContent = "Delete project";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete the project “${project.title}” owned by ${project.email || project.owner_id}? This cannot be undone.`)) return;
      const deleteResponse = await apiFetch(`/api/admin/projects/${encodeURIComponent(project.owner_id)}`, { method: "DELETE" });
      if (!deleteResponse.ok) {
        toast(await responseDetail(deleteResponse, "The project could not be deleted."));
        return;
      }
      toast("Project deleted.");
      await loadAdminProjects();
    });
    card.append(heading, meta, remove);
    list.append(card);
  });
}

// ---------------------------------------------------------------------------
// Accounts are optional: everyone can plan without signing in. Work done
// without an account is kept in this browser and comes along on sign-in.
//
// session.target says where the project is saved:
//   local    web_app.py's project file          account  the signed-in account
//   guest    this browser, not signed in         profile  a browser-only profile
//   expired  signed out by the server mid-edit   memory   nowhere (storage blocked)
// ---------------------------------------------------------------------------

function accountsEnabled() {
  return session.mode !== "local";
}

function isSignedIn() {
  return session.target === "account" || session.target === "profile";
}

function renderAccountControls() {
  const signedIn = isSignedIn();
  $("#login-button").hidden = !accountsEnabled() || signedIn;
  $("#sign-out").hidden = !signedIn;
  const email = signedIn && session.user && session.user.email;
  $("#account-email").hidden = !email;
  $("#account-email").textContent = email || "";
  $("#admin-button").hidden = !(signedIn && session.user && session.user.is_admin);
  const passwordless = session.mode === "supabase";
  $("#magic-link").hidden = !passwordless;
  document.querySelector(".oauth-actions").hidden = !passwordless;
  if (signedIn || !accountsEnabled()) $("#account-prompt").hidden = true;
}

function setAuthMessage(message, failed = false) {
  const element = $("#auth-message");
  element.textContent = message;
  element.classList.toggle("error", failed);
}

let authReason = "signin";

function showAuthPage(message, { error = false, reason = "signin" } = {}) {
  authReason = reason;
  const dialog = $("#auth-dialog");
  const browserOnly = session.mode === "indexeddb";
  $("#auth-title").textContent = browserOnly ? "Use a profile in this browser" : "Sign in to save your project";
  $("#auth-intro").textContent = browserOnly ? AUTH_COPY.indexeddb : AUTH_COPY.account;
  setAuthMessage(message || "", error);
  renderAccountControls();
  if (!dialog.open) dialog.showModal();
  $("#auth-email").focus();
}

function hideAuthPage() {
  const dialog = $("#auth-dialog");
  if (dialog.open) dialog.close();
}

function onAuthDialogClosed() {
  setAuthMessage("");
  $("#auth-password").value = "";
  const reason = authReason;
  authReason = "signin";
  // Closing the dialog after a session expired keeps the work in this browser.
  if (reason === "expired" && session.target === "expired") continueAsGuest();
}

function snapshotProject() {
  return JSON.parse(JSON.stringify({ ...projectPayload(), saved_at: state.saved_at }));
}

function signInSummary(summary, combined) {
  const where = session.target === "profile" ? "profile" : "account";
  if (!combined) return `Your work from this browser is now saved to your ${where}.`;
  const parts = [];
  if (summary.answersAdded) parts.push(`${summary.answersAdded} answer${summary.answersAdded === 1 ? "" : "s"}`);
  if (summary.ideasAdded) parts.push(`${summary.ideasAdded} idea${summary.ideasAdded === 1 ? "" : "s"}`);
  if (summary.materialsAdded) parts.push(`${summary.materialsAdded} material${summary.materialsAdded === 1 ? "" : "s"}`);
  let message = parts.length ? `Added your work from this browser to your ${where}: ${parts.join(", ")}.` : `Your ${where}'s project is open.`;
  if (summary.answersKeptAsMaterial) {
    const count = summary.answersKeptAsMaterial;
    message += ` ${count} answer${count === 1 ? " differed" : "s differed"} from your ${where}'s, so ${count === 1 ? "it was" : "they were"} kept as material to review in the project overview.`;
  }
  return message;
}

/*
 * Open `destination` (the account's or profile's project) and bring `carried`
 * (work done without signing in) into it without losing anything.
 */
async function adoptWork(destination, carried) {
  const base = destination || Logic.emptyProject();
  if (!carried || !Logic.hasContent(carried)) {
    replaceProject(base);
    sync.dirty = false;
    renderAll();
    setStatus(savedLabel());
    return;
  }
  const { project, summary } = Logic.mergeProjects(base, carried, questionBank);
  const tooLarge = Logic.utf8Length(JSON.stringify(project)) > LIMITS.requestBytes;
  if (Logic.validationError(project) || tooLarge) {
    replaceProject(base);
    sync.dirty = false;
    renderAll();
    setStatus(savedLabel());
    toast("Your project is open. The work from this browser was kept separately here, because combining them would exceed the project limits.");
    return;
  }
  replaceProject({ ...project, revision: base.revision || 0 });
  sync.dirty = true;
  renderAll();
  if (await saveProject({ force: true })) {
    try {
      await deleteBrowserProject(GUEST_OWNER);
    } catch (error) {
      console.error(error);
    }
    toast(signInSummary(summary, Logic.hasContent(base)));
  }
}

async function loadDestinationProject() {
  if (session.mode === "indexeddb") return loadBrowserProject(session.staticUser.id);
  return fetchJson("/api/project");
}

/* Bring work that an earlier visit saved without signing in into the current account or profile. */
async function adoptStoredGuestWork() {
  let stored = null;
  try {
    stored = await loadBrowserProject(GUEST_OWNER);
  } catch {
    return;
  }
  if (stored && Logic.hasContent(stored)) await adoptWork(snapshotProject(), stored);
}

/* Called once credentials are accepted, in every account mode. */
async function completeSignIn(user) {
  const priorTarget = session.target;
  const previous = session.user;
  if (priorTarget === "expired" && previous && previous.id && user && user.id && previous.id !== user.id) {
    // Someone else signed in on this page: don't mix their work with the previous person's.
    window.location.reload();
    return;
  }
  // Make sure the latest work done without an account is stored before switching.
  if (priorTarget === "guest") await saveProject();
  const carried = (priorTarget === "guest" || priorTarget === "memory") && Logic.hasContent(state) ? snapshotProject() : null;
  session.user = { ...(priorTarget === "expired" && previous ? previous : {}), ...(user || {}) };
  session.target = session.mode === "indexeddb" ? "profile" : "account";
  if (session.mode !== "indexeddb") {
    try {
      await loadCurrentUser();
    } catch (error) {
      console.error(error);
    }
  }
  clearTimeout(sync.timer);
  sync.retryDelay = 0;
  sync.blocked = null;
  hideAuthPage();
  renderAccountControls();
  if (priorTarget === "expired") {
    // The same person signed in again: keep the unsaved work and save it.
    if (sync.dirty) await saveProject({ force: true });
    else setStatus(savedLabel());
    return;
  }
  setStatus("Opening your project…", "pending");
  let destination;
  try {
    destination = await loadDestinationProject();
  } catch (error) {
    console.error(error);
    // Everything done so far is stored in this browser; a reload adopts it.
    window.location.reload();
    return;
  }
  await adoptWork(destination, carried);
  renderAccountControls();
}

/* After a session expired, keep editing with the work stored in this browser. */
async function continueAsGuest() {
  session.token = "";
  writeStorage(STORAGE_KEYS.token, null);
  session.user = null;
  session.target = "guest";
  sync.blocked = null;
  let stored = null;
  try {
    stored = await loadBrowserProject(GUEST_OWNER);
  } catch (error) {
    console.error(error);
    session.target = "memory";
  }
  let project = snapshotProject();
  if (stored && Logic.hasContent(stored)) project = Logic.mergeProjects(project, stored, questionBank).project;
  replaceProject({ ...project, revision: stored ? stored.revision : 0 });
  sync.dirty = true;
  renderAll();
  renderAccountControls();
  if (session.target === "memory") {
    blockStorage();
    return;
  }
  if (await saveProject({ force: true })) {
    toast("Your changes are saved in this browser. Sign in any time to move them to your account.");
  }
}

function blockStorage() {
  sync.blocked = { kind: "storage", message: "Storage blocked" };
  setStatus("Not saved — this browser blocks storage", "error");
  toast(session.mode === "indexeddb"
    ? "This browser is blocking site storage, so your work can't be kept. Allow site data for this page, or export your plan before leaving."
    : "This browser is blocking site storage, so your work can't be kept here. Sign in to save it to an account, or export your plan before leaving.");
}

function maybeOfferSignIn() {
  if (session.target !== "guest" || !accountsEnabled() || !Logic.hasContent(state)) return;
  const dismissedAt = Number(readStorage(STORAGE_KEYS.promptDismissed) || 0);
  if (dismissedAt && Date.now() - dismissedAt < PROMPT_DISMISS_DAYS * 86400000) return;
  const browserOnly = session.mode === "indexeddb";
  $("#account-prompt-text").textContent = browserOnly ? PROMPT_COPY.indexeddb : PROMPT_COPY.account;
  $("#account-prompt-signin").textContent = browserOnly ? "Create a profile" : "Sign in to save it";
  $("#account-prompt").hidden = false;
}

function dismissAccountPrompt() {
  $("#account-prompt").hidden = true;
  writeStorage(STORAGE_KEYS.promptDismissed, String(Date.now()));
}

async function loadCurrentUser() {
  const response = await apiFetch("/api/me");
  if (response.status === 401) throw Object.assign(new Error("Session expired"), { status: 401 });
  if (!response.ok) throw new Error("Could not verify the current account.");
  const me = await response.json();
  session.user = { ...(session.user || {}), id: me.user_id, email: me.email, is_admin: Boolean(me.is_admin) };
}

function credentials() {
  return { email: $("#auth-email").value.trim(), password: $("#auth-password").value };
}

async function builtinAuth(path, { email, password }) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    const detail = Array.isArray(result.detail) ? "Enter a valid email and a password of at least 8 characters." : result.detail;
    throw new Error(detail || "The request could not be completed.");
  }
  session.token = result.access_token;
  writeStorage(STORAGE_KEYS.token, session.token);
  return result.user;
}

function supabaseUnavailable() {
  if (session.mode !== "supabase" || session.supabase) return false;
  setAuthMessage("Sign-in is unavailable right now because the authentication library could not be loaded. Your work is still saved in this browser.", true);
  return true;
}

async function handleSignIn(event) {
  event.preventDefault();
  const { email, password } = credentials();
  if (!email || password.length < 8) {
    setAuthMessage("Enter your email and a password of at least 8 characters.", true);
    return;
  }
  if (supabaseUnavailable()) return;
  setAuthMessage("Signing in…");
  try {
    if (session.mode === "indexeddb") {
      await startProfileSession(await staticLogin(email, password));
    } else if (session.mode === "builtin") {
      await completeSignIn(await builtinAuth("/api/auth/login", { email, password }));
    } else if (session.mode === "supabase") {
      const { error } = await session.supabase.auth.signInWithPassword({ email, password });
      if (error) setAuthMessage(error.message, true);
    }
  } catch (error) {
    setAuthMessage(error.message || "Could not sign in.", true);
  }
}

async function handleRegister() {
  const { email, password } = credentials();
  if (!email || password.length < 8) {
    setAuthMessage("Enter an email and a password of at least 8 characters.", true);
    return;
  }
  if (supabaseUnavailable()) return;
  setAuthMessage("Creating your account…");
  try {
    if (session.mode === "indexeddb") {
      await startProfileSession(await staticRegister(email, password));
    } else if (session.mode === "builtin") {
      await completeSignIn(await builtinAuth("/api/auth/register", { email, password }));
    } else if (session.mode === "supabase") {
      const { error } = await session.supabase.auth.signUp({ email, password, options: { emailRedirectTo: session.authRedirectUrl } });
      setAuthMessage(error ? error.message : "Account created. Check your email to confirm it, then sign in. Your work stays saved in this browser meanwhile.", Boolean(error));
    }
  } catch (error) {
    setAuthMessage(error.message || "Could not create the account.", true);
  }
}

async function handleMagicLink() {
  const { email } = credentials();
  if (!email) {
    setAuthMessage("Enter your email first.", true);
    return;
  }
  if (supabaseUnavailable()) return;
  try {
    const { error } = await session.supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: session.authRedirectUrl } });
    setAuthMessage(error ? error.message : "Magic link sent. Check your email; your work stays saved in this browser.", Boolean(error));
  } catch (error) {
    setAuthMessage(error.message || "Could not send the magic link.", true);
  }
}

async function handleOAuth(button) {
  if (supabaseUnavailable()) return;
  // Store the latest work first: the provider's sign-in page replaces this one.
  await saveProject();
  setAuthMessage(`Opening ${button.textContent.trim()} sign-in…`);
  try {
    const { error } = await session.supabase.auth.signInWithOAuth({
      provider: button.dataset.provider,
      options: { redirectTo: session.authRedirectUrl, skipBrowserRedirect: false },
    });
    if (error) setAuthMessage(error.message, true);
  } catch (error) {
    setAuthMessage(error.message || `${button.textContent.trim()} sign-in could not start.`, true);
  }
}

async function signOut() {
  if (appLoaded && !(await saveProject())) {
    const discard = window.confirm("Some changes have not been saved. Sign out anyway and lose them?");
    if (!discard) return;
  }
  sync.dirty = false;
  try {
    if (session.mode === "builtin" && session.token) {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } else if (session.mode === "supabase" && session.supabase) {
      await session.supabase.auth.signOut();
    }
  } catch (error) {
    console.error(error);
  }
  writeStorage(STORAGE_KEYS.token, null);
  writeStorage(STORAGE_KEYS.staticEmail, null);
  // Reloading removes this person's project from the page; the next visitor starts fresh.
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Browser storage (IndexedDB): projects of visitors who have not signed in,
// and the browser-only profiles of the static demo.
// ---------------------------------------------------------------------------

function openStaticAuthDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("novel-architect-auth", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("users")) database.createObjectStore("users", { keyPath: "email" });
      if (!database.objectStoreNames.contains("projects")) database.createObjectStore("projects", { keyPath: "ownerId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function staticDatabaseRequest(database, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStaticDatabase(work) {
  const database = await openStaticAuthDatabase();
  try {
    return await work(database);
  } finally {
    database.close();
  }
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function hashStaticPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, key, 256);
  return bytesToBase64(bits);
}

async function staticRegister(email, password) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a valid email address.");
  if (password.length < 8 || password.length > 200) throw new Error("Password must be between 8 and 200 characters.");
  return withStaticDatabase(async (database) => {
    const existing = await staticDatabaseRequest(database, "users", "readonly", (store) => store.get(normalized));
    if (existing) throw new Error("A profile with this email already exists in this browser.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const user = {
      email: normalized,
      id: newId(),
      salt: bytesToBase64(salt),
      passwordHash: await hashStaticPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    await staticDatabaseRequest(database, "users", "readwrite", (store) => store.add(user));
    return user;
  });
}

async function staticLogin(email, password) {
  const normalized = email.trim().toLowerCase();
  return withStaticDatabase(async (database) => {
    const user = await staticDatabaseRequest(database, "users", "readonly", (store) => store.get(normalized));
    if (!user) throw new Error("Invalid email or password.");
    const candidate = await hashStaticPassword(password, base64ToBytes(user.salt));
    if (candidate !== user.passwordHash) throw new Error("Invalid email or password.");
    return user;
  });
}

async function loadStaticAuthSession() {
  const email = readStorage(STORAGE_KEYS.staticEmail);
  if (!email) return null;
  const user = await withStaticDatabase((database) => staticDatabaseRequest(database, "users", "readonly", (store) => store.get(email)));
  return user || null;
}

async function loadBrowserProject(ownerId) {
  const record = await withStaticDatabase((database) => staticDatabaseRequest(database, "projects", "readonly", (store) => store.get(ownerId)));
  if (!record) return null;
  return { ...record.data, revision: record.revision || 1, saved_at: record.updatedAt || null };
}

async function deleteBrowserProject(ownerId) {
  await withStaticDatabase((database) => staticDatabaseRequest(database, "projects", "readwrite", (store) => store.delete(ownerId)));
}

/* Store a project in IndexedDB, refusing the write if another tab saved first. */
async function saveBrowserProject(ownerId, project) {
  const email = session.staticUser && session.staticUser.id === ownerId ? session.staticUser.email : null;
  return withStaticDatabase((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    let saved = null;
    const read = store.get(ownerId);
    read.onsuccess = () => {
      const existing = read.result;
      const currentRevision = existing ? existing.revision || 1 : 0;
      if (Number.isInteger(project.revision) && project.revision !== currentRevision) {
        const current = existing ? { ...existing.data, revision: currentRevision, saved_at: existing.updatedAt || null } : Logic.emptyProject();
        transaction.abort();
        reject(Object.assign(new Error("conflict"), { conflict: true, current }));
        return;
      }
      const data = { ...project };
      delete data.revision;
      delete data.saved_at;
      const updatedAt = new Date().toISOString();
      saved = { ...data, revision: currentRevision + 1, saved_at: updatedAt };
      store.put({ ownerId, email, data, revision: currentRevision + 1, updatedAt });
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onerror = () => reject(transaction.error);
  }));
}

/*
 * The first version of the demo kept one project in localStorage. It becomes
 * the project of a visitor who has not signed in (a backup copy is kept).
 */
async function importLegacyIntoGuest() {
  const legacy = readStorage(STORAGE_KEYS.legacyProject);
  if (!legacy) return null;
  let project;
  try {
    project = JSON.parse(legacy);
  } catch {
    return null;
  }
  if (!project || typeof project !== "object") return null;
  replaceProject({ ...project, revision: 0 });
  const saved = await saveBrowserProject(GUEST_OWNER, projectPayload());
  writeStorage(STORAGE_KEYS.migratedProject, legacy);
  writeStorage(STORAGE_KEYS.legacyProject, null);
  return saved;
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

async function fetchJson(url) {
  const response = await apiFetch(url);
  if (!response.ok) throw Object.assign(new Error(`${url} returned ${response.status}`), { status: response.status });
  return response.json();
}

let applicationLoading = null;

/* Load questions, stages, and (for accounts and the local server) the project, then render. */
function loadApplication() {
  if (!applicationLoading) {
    applicationLoading = loadApplicationOnce().finally(() => { applicationLoading = null; });
  }
  return applicationLoading;
}

async function loadApplicationOnce() {
  if (appLoaded) return;
  const staticFiles = session.mode === "indexeddb";
  const fromServer = session.target === "account" || session.target === "local";
  const [questions, stageList, project] = await Promise.all([
    fetchJson(staticFiles ? "./questions.json" : "/api/questions"),
    fetchJson(staticFiles ? "./stages.json" : "/api/stages"),
    fromServer ? fetchJson("/api/project") : Promise.resolve(null),
  ]);
  questionBank = questions;
  stages = stageList;
  if (project) replaceProject(project);
  appLoaded = true;
  sync.dirty = false;
  activeStage = -1;
  renderAll();
  renderAccountControls();
  setStatus(savedLabel());
}

async function detectMode() {
  let response;
  try {
    response = await fetch("/api/config", { cache: "no-store" });
  } catch {
    return { mode: "unreachable" };
  }
  // Static hosting has no API: /api/config is missing (or answered with a page).
  if (response.status === 404) return { mode: "indexeddb" };
  if (!response.ok) return { mode: "unreachable" };
  let config;
  try {
    config = await response.json();
  } catch {
    return { mode: "indexeddb" };
  }
  const mode = config.auth_mode || (config.supabase_configured ? "supabase" : "local");
  return { mode, config };
}

/* Not signed in: plan right away, with the project kept in this browser. */
async function startGuestSession(notice) {
  session.target = "guest";
  let project = null;
  try {
    project = (await loadBrowserProject(GUEST_OWNER)) || (await importLegacyIntoGuest());
  } catch (error) {
    console.error(error);
    session.target = "memory";
  }
  replaceProject(project || Logic.emptyProject());
  await loadApplication();
  if (session.target === "memory") blockStorage();
  else if (notice) toast(notice);
}

async function startAccountSession() {
  session.target = "account";
  try {
    await loadApplication();
  } catch (error) {
    if (error.status !== 401) throw error;
    session.token = "";
    writeStorage(STORAGE_KEYS.token, null);
    await startGuestSession("Your session expired, so you're working without signing in. Sign in to open your account's project.");
    return;
  }
  await adoptStoredGuestWork();
  renderAccountControls();
}

/* A browser-only profile (static demo): at start-up, or right after signing in. */
async function startProfileSession(user, { atStartup = false } = {}) {
  session.staticUser = user;
  writeStorage(STORAGE_KEYS.staticEmail, user.email);
  if (!atStartup) {
    await completeSignIn({ id: user.id, email: user.email });
    return;
  }
  session.target = "profile";
  session.user = { id: user.id, email: user.email };
  replaceProject((await loadBrowserProject(user.id)) || Logic.emptyProject());
  await loadApplication();
  await adoptStoredGuestWork();
  renderAccountControls();
}

async function initializeBuiltin() {
  session.token = readStorage(STORAGE_KEYS.token) || "";
  if (!session.token) {
    await startGuestSession();
    return;
  }
  try {
    await loadCurrentUser();
  } catch (error) {
    if (error.status === 401) {
      session.token = "";
      writeStorage(STORAGE_KEYS.token, null);
      await startGuestSession("Your session expired, so you're working without signing in. Sign in to open your account's project.");
    } else {
      setStatus("Server unavailable", "error");
      toast("Your account could not be checked right now. Refresh the page in a moment.");
    }
    return;
  }
  await startAccountSession();
}

async function initializeSupabase(config) {
  session.authRedirectUrl = config.public_app_url || `${window.location.origin}${window.location.pathname}`;
  const providers = String(config.oauth_providers || "").split(",").map((provider) => provider.trim()).filter(Boolean);
  document.querySelectorAll("[data-provider]").forEach((button) => {
    button.hidden = !providers.includes(button.dataset.provider);
  });
  try {
    if (!window.supabase) await loadScript(SUPABASE_SDK);
  } catch (error) {
    // Planning still works; signing in waits until the library can load.
    console.error(error);
    await startGuestSession();
    return;
  }
  session.supabase = window.supabase.createClient(config.supabase_url, config.supabase_anon_key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data } = await session.supabase.auth.getSession();
  session.token = (data.session && data.session.access_token) || "";
  session.supabase.auth.onAuthStateChange((event, authSession) => {
    session.token = (authSession && authSession.access_token) || "";
    if (event === "SIGNED_OUT") {
      if (appLoaded && isSignedIn()) window.location.reload();
      return;
    }
    if (authSession && event === "SIGNED_IN" && !isSignedIn() && appLoaded) {
      // Defer so Supabase finishes its own bookkeeping before we call the API.
      setTimeout(() => completeSignIn({ id: authSession.user.id, email: authSession.user.email }), 0);
    }
  });
  if (!session.token) {
    await startGuestSession();
    return;
  }
  session.user = { id: data.session.user.id, email: data.session.user.email };
  await startAccountSession();
}

async function initializeStatic() {
  $("#export-pdf").textContent = "↓  Print or save as PDF";
  let user = null;
  try {
    user = await loadStaticAuthSession();
  } catch (error) {
    console.error(error);
  }
  if (user) await startProfileSession(user, { atStartup: true });
  else await startGuestSession();
}

function bindUi() {
  renderStatusLegend();
  $("#project-title").addEventListener("input", () => {
    state.title = $("#project-title").value;
    markDirty();
  });
  $("#project-title").addEventListener("blur", () => {
    if (!state.title.trim()) {
      state.title = Logic.UNTITLED_TITLE;
      $("#project-title").value = state.title;
      markDirty();
    }
  });
  $("#add-idea").addEventListener("click", addIdea);
  $("#idea-text").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") addIdea();
  });
  $("#add-material").addEventListener("click", () => {
    const textarea = $("#idea-text");
    if (!textarea.value.trim()) {
      textarea.focus();
      toast("Paste some material before importing it.");
      return;
    }
    const result = importMaterial(textarea.value, "Pasted material");
    if (result.added) textarea.value = "";
    toast(importSummary(result.added, result.problem ? [result.problem] : []));
  });
  $("#material-file").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await importFiles(files);
  });
  $("#overview-button").addEventListener("click", showOverview);
  $("#admin-button").addEventListener("click", showAdmin);
  $("#refresh-admin").addEventListener("click", loadAdminProjects);
  $("#theme-select").addEventListener("change", (event) => {
    state.theme = event.target.value;
    applyTheme();
    markDirty();
  });
  $("#overview-search").addEventListener("input", renderOverview);
  $("#overview-filter").addEventListener("change", renderOverview);
  $("#export-markdown").addEventListener("click", (event) => {
    event.preventDefault();
    exportPlan("markdown");
  });
  $("#export-pdf").addEventListener("click", (event) => {
    event.preventDefault();
    exportPlan("pdf");
  });
  $("#previous-stage").addEventListener("click", () => showStage(Math.max(0, activeStage - 1)));
  $("#next-stage").addEventListener("click", () => (activeStage === stages.length - 1 ? showInbox() : showStage(activeStage + 1)));
  $("#continue-planning").addEventListener("click", continuePlanning);
  $("#stage-readiness-link").addEventListener("click", () => showOverview({ focusReadiness: true }));
  $("#conflict-load").addEventListener("click", () => resolveConflict(false));
  $("#conflict-keep").addEventListener("click", () => resolveConflict(true));

  $("#login-button").addEventListener("click", () => showAuthPage(""));
  $("#account-prompt-signin").addEventListener("click", () => showAuthPage(""));
  $("#account-prompt-dismiss").addEventListener("click", dismissAccountPrompt);
  $("#auth-form").addEventListener("submit", handleSignIn);
  $("#sign-up").addEventListener("click", handleRegister);
  $("#magic-link").addEventListener("click", handleMagicLink);
  $("#auth-continue").addEventListener("click", hideAuthPage);
  $("#auth-close").addEventListener("click", hideAuthPage);
  $("#auth-dialog").addEventListener("close", onAuthDialogClosed);
  document.querySelectorAll("[data-provider]").forEach((button) => button.addEventListener("click", () => handleOAuth(button)));
  $("#sign-out").addEventListener("click", signOut);

  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedWork()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function initialize() {
  const storedTheme = readStorage(STORAGE_KEYS.theme);
  if (Logic.THEMES.includes(storedTheme)) {
    state.theme = storedTheme;
    document.documentElement.dataset.theme = storedTheme;
  }
  bindUi();
  setStatus("Loading project…", "pending");
  const { mode, config } = await detectMode();
  if (mode === "unreachable") {
    setStatus("Server unavailable", "error");
    toast("The server could not be reached. Check your connection and refresh the page.");
    return;
  }
  session.mode = mode;
  document.documentElement.dataset.storage = mode;
  renderAccountControls();
  try {
    if (mode === "indexeddb") await initializeStatic();
    else if (mode === "builtin") await initializeBuiltin();
    else if (mode === "supabase") await initializeSupabase(config);
    else {
      session.target = "local";
      await loadApplication();
    }
  } catch (error) {
    console.error(error);
    setStatus("Could not load project", "error");
    toast("The project could not be loaded. Check your connection and refresh the page.");
  }
}

initialize();
