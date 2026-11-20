"use strict";

/*
 * Novel Architect browser application.
 *
 * Storage modes (chosen from GET /api/config):
 *   local     web_app.py: one project in a JSON file, no accounts
 *   builtin   app.py with its own accounts (SQLite)
 *   supabase  app.py with Supabase Auth and Postgres
 *   indexeddb static hosting (GitHub Pages): profiles and projects stay in this browser
 */

const Logic = window.PlannerLogic;
const { LIMITS } = Logic;

const SUPABASE_SDK = Object.freeze({
  src: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js",
  integrity: "sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK",
});
const STORAGE_KEYS = Object.freeze({
  token: "novel-architect-auth-token",
  staticEmail: "novel-architect-auth-email",
  legacyProject: "novel-architect-project",
  migratedProject: "novel-architect-project-migrated",
  theme: "novel-architect-theme",
});
const AUTH_COPY = Object.freeze({
  account: "Log in to keep your project private and available wherever you sign in.",
  indexeddb: "This public demo keeps your profile and project in this browser only. Nothing is uploaded, "
    + "nothing syncs to other devices, and clearing this site's data deletes it, so export your plan regularly.",
});
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
  return session.mode === "indexeddb" ? "Saved in this browser" : "All changes saved";
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
  if (session.mode === "indexeddb") {
    try {
      return { ok: true, project: await saveStaticProject(payload) };
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
    sync.blocked = { kind: "auth", message: "Session expired" };
    setStatus("Not saved — log in again", "error");
    showAuthPage("Your session has expired. Log in again to save your changes — they are still in this window.", { error: true });
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
      edit.addEventListener("click", () => {
        const question = questionById(entry.questionId);
        showStage(stages.findIndex((stage) => stage.title === question.section), entry.questionId);
      });
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

function showOverview() {
  activeStage = -2;
  setActiveSection("overview-page");
  $("#current-breadcrumb").textContent = "PROJECT OVERVIEW";
  renderOverview();
  renderNavigation();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
    const block = document.createElement("div");
    block.className = "guide-block";
    const tag = document.createElement("span");
    tag.className = "guide-label";
    tag.textContent = label;
    const copy = document.createElement("p");
    copy.textContent = text;
    block.append(tag, copy);
    guide.append(block);
  });
  $("#stage-output").textContent = stage.output;
  $("#stage-completion").textContent = stage.completion;
  $("#stage-criteria").textContent = stage.criteria;
  $("#stage-watch").textContent = stage.watch_for;
  const container = $("#question-list");
  container.replaceChildren();
  const promptsById = new Map(questionBank.map((item) => [item.question_id, item.prompt]));
  let focusTarget = null;

  questionsForStage(stage.title).forEach((question) => {
    const blocked = Logic.blockedDependencies(question, state.answers).length > 0;
    const card = document.createElement("article");
    card.className = `question-card ${blocked ? "question-locked" : ""}`;
    card.dataset.questionId = question.question_id;
    const heading = document.createElement("h3");
    heading.textContent = question.prompt;
    const description = document.createElement("p");
    description.className = "question-meta";
    description.textContent = [question.definition, question.purpose].filter(Boolean).join(" ");

    const controls = document.createElement("div");
    controls.className = "answer-controls";
    const importance = document.createElement("select");
    importance.setAttribute("aria-label", `Planning status for ${question.prompt}`);
    [
      ["essential", "Essential"],
      ["important", "Important"],
      ["optional", "Optional"],
      ["deferred", "Deferred"],
      ["intentionally_unknown", "Intentionally unknown"],
    ].forEach(([value, label]) => importance.append(option(value, label)));
    const decision = document.createElement("select");
    decision.setAttribute("aria-label", `Decision state for ${question.prompt}`);
    [
      ["needs_work", "Needs development"],
      ["provisional", "Provisional"],
      ["settled", "Settled for now"],
    ].forEach(([value, label]) => decision.append(option(value, label)));
    const current = Logic.effectiveState(question, state.question_states);
    importance.value = current.planning_level;
    decision.value = current.certainty;
    importance.disabled = blocked;
    decision.disabled = blocked;
    const updateQuestionState = () => {
      state.question_states[question.question_id] = {
        planning_level: importance.value,
        certainty: decision.value,
      };
      markDirty();
      renderProgress();
    };
    importance.addEventListener("change", updateQuestionState);
    decision.addEventListener("change", updateQuestionState);
    [["PLANNING STATUS", importance], ["DECISION STATE", decision]].forEach(([labelText, select]) => {
      const wrap = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, select);
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
    card.append(heading, description, controls, textarea);
    if (blocked) {
      const dependencyMessage = document.createElement("p");
      dependencyMessage.className = "question-dependencies";
      dependencyMessage.textContent = "Answer the prerequisite questions before developing this decision.";
      card.append(dependencyMessage);
    }
    if (question.affects) {
      const affects = document.createElement("p");
      affects.className = "question-affects";
      affects.textContent = `This connects to: ${question.affects}`;
      card.append(affects);
    }
    if (question.dependencies && question.dependencies.length) {
      const dependencies = document.createElement("p");
      dependencies.className = "question-dependencies";
      dependencies.textContent = `Builds on: ${question.dependencies.map((id) => promptsById.get(id) || id).join(" · ")}`;
      card.append(dependencies);
    }
    if (question.guidance || question.examples) {
      const hint = document.createElement("p");
      hint.className = "question-hint";
      hint.textContent = [question.guidance, question.examples ? `For example: ${question.examples}` : ""].filter(Boolean).join(" ");
      card.append(hint);
    }
    container.append(card);
    if (question.question_id === focusQuestionId) focusTarget = { card, textarea };
  });

  $("#previous-stage").disabled = index === 0;
  $("#previous-stage").style.visibility = index === 0 ? "hidden" : "visible";
  $("#next-stage").textContent = index === stages.length - 1 ? "Back to idea inbox" : "Next section →";
  renderNavigation();
  if (focusTarget) {
    focusTarget.card.scrollIntoView({ block: "center" });
    if (!focusTarget.textarea.disabled) focusTarget.textarea.focus({ preventScroll: true });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
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
  if (!(await saveProject())) {
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
    return;
  }
  const response = await apiFetch(kind === "pdf" ? "/api/export/pdf" : "/api/export");
  if (!response.ok) {
    toast(await responseDetail(response, "The export could not be generated."));
    return;
  }
  downloadBlob(await response.blob(), kind === "pdf" ? "novel-writing-plan.pdf" : "novel-writing-plan.md");
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
    }
    questionsForStage(stage.title).forEach((question) => {
      const decision = Logic.effectiveState(question, state.question_states);
      add("h3", question.prompt);
      add("p", `${Logic.planningLabel(decision.planning_level)} · ${Logic.planningLabel(decision.certainty)}`, "print-status");
      add("p", Logic.answerText(state.answers, question.question_id) || "Not yet answered", "print-answer");
    });
  });
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
// Accounts
// ---------------------------------------------------------------------------

function accountsEnabled() {
  return session.mode !== "local";
}

function isSignedIn() {
  if (session.mode === "indexeddb") return Boolean(session.staticUser);
  if (session.mode === "builtin") return Boolean(session.token);
  if (session.mode === "supabase") return Boolean(session.token);
  return false;
}

function renderAccountControls() {
  const signedIn = isSignedIn();
  $("#login-button").hidden = !accountsEnabled() || signedIn;
  $("#register-button").hidden = !accountsEnabled() || signedIn;
  $("#sign-out").hidden = !accountsEnabled() || !signedIn;
  const email = session.user && session.user.email;
  $("#account-email").hidden = !(signedIn && email);
  $("#account-email").textContent = email || "";
  $("#admin-button").hidden = !(signedIn && session.user && session.user.is_admin);
  const passwordless = session.mode === "supabase";
  $("#magic-link").hidden = !passwordless;
  document.querySelector(".oauth-actions").hidden = !passwordless;
}

function setAuthMessage(message, failed = false) {
  const element = $("#auth-message");
  element.textContent = message;
  element.classList.toggle("error", failed);
}

function showAuthPage(message, { error = false } = {}) {
  $("#auth-page").hidden = false;
  document.querySelectorAll(".page-section").forEach((section) => section.classList.remove("active"));
  $("#auth-intro").textContent = session.mode === "indexeddb" ? AUTH_COPY.indexeddb : AUTH_COPY.account;
  if (message) setAuthMessage(message, error);
  renderAccountControls();
  $("#auth-email").focus();
}

function hideAuthPage() {
  $("#auth-page").hidden = true;
  setAuthMessage("");
  $("#auth-password").value = "";
  renderAccountControls();
  if (appLoaded) renderAll();
}

/* Called after any successful sign-in, in every account mode. */
async function onSignedIn(user) {
  const previous = session.user;
  if (appLoaded && previous && user && previous.id && user.id && previous.id !== user.id) {
    // A different person signed in on this page: start from a clean slate.
    window.location.reload();
    return;
  }
  session.user = { ...(previous || {}), ...(user || {}) };
  if (session.mode !== "indexeddb") {
    try {
      await loadCurrentUser();
    } catch (error) {
      console.error(error);
    }
  }
  const authPageWasOpen = !$("#auth-page").hidden;
  if (!appLoaded) {
    await loadApplication();
  } else if (authPageWasOpen) {
    hideAuthPage();
  }
  if (sync.blocked && sync.blocked.kind === "auth") {
    sync.blocked = null;
    if (sync.dirty) await saveProject({ force: true });
  }
  renderAccountControls();
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

async function handleSignIn(event) {
  event.preventDefault();
  const { email, password } = credentials();
  if (!email || password.length < 8) {
    setAuthMessage("Enter your email and a password of at least 8 characters.", true);
    return;
  }
  setAuthMessage("Signing in…");
  try {
    if (session.mode === "indexeddb") {
      const user = await staticLogin(email, password);
      await startStaticSession(user);
    } else if (session.mode === "builtin") {
      await onSignedIn(await builtinAuth("/api/auth/login", { email, password }));
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
  setAuthMessage("Creating your account…");
  try {
    if (session.mode === "indexeddb") {
      const user = await staticRegister(email, password);
      await startStaticSession(user);
      toast("Profile created in this browser.");
    } else if (session.mode === "builtin") {
      await onSignedIn(await builtinAuth("/api/auth/register", { email, password }));
      toast("Account created and signed in.");
    } else if (session.mode === "supabase") {
      const { error } = await session.supabase.auth.signUp({ email, password, options: { emailRedirectTo: session.authRedirectUrl } });
      setAuthMessage(error ? error.message : "Account created. Check your email to confirm it.", Boolean(error));
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
  try {
    const { error } = await session.supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: session.authRedirectUrl } });
    setAuthMessage(error ? error.message : "Magic link sent. Check your email.", Boolean(error));
  } catch (error) {
    setAuthMessage(error.message || "Could not send the magic link.", true);
  }
}

async function handleOAuth(button) {
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
  // Reloading clears this person's project from memory and from the page.
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Browser-only profiles (static hosting such as GitHub Pages)
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

async function loadStaticProject(ownerId) {
  const record = await withStaticDatabase((database) => staticDatabaseRequest(database, "projects", "readonly", (store) => store.get(ownerId)));
  if (!record) return null;
  return { ...record.data, revision: record.revision || 1, saved_at: record.updatedAt || null };
}

/* Store the project in IndexedDB, refusing the write if another tab saved first. */
async function saveStaticProject(project) {
  if (!session.staticUser) throw new Error("No profile is signed in.");
  const owner = session.staticUser;
  return withStaticDatabase((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    let saved = null;
    const read = store.get(owner.id);
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
      store.put({ ownerId: owner.id, email: owner.email, data, revision: currentRevision + 1, updatedAt });
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onerror = () => reject(transaction.error);
  }));
}

/*
 * Before profiles existed, the demo kept one project in localStorage. Give it
 * to the first profile that signs in without a project of its own, and keep a
 * copy so nothing is lost if something goes wrong.
 */
async function migrateLegacyProject() {
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
  const saved = await saveStaticProject(projectPayload());
  writeStorage(STORAGE_KEYS.migratedProject, legacy);
  writeStorage(STORAGE_KEYS.legacyProject, null);
  return saved;
}

async function startStaticSession(user) {
  session.staticUser = user;
  session.user = { id: user.id, email: user.email };
  writeStorage(STORAGE_KEYS.staticEmail, user.email);
  let project = await loadStaticProject(user.id);
  let migrated = false;
  if (!project) {
    project = await migrateLegacyProject();
    migrated = Boolean(project);
  }
  replaceProject(project || Logic.emptyProject());
  await onSignedIn(session.user);
  if (migrated) toast("Restored the project you started in this browser earlier.");
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

/* Load questions, stages, and (in server modes) the project, then render. */
function loadApplication() {
  if (!applicationLoading) {
    applicationLoading = loadApplicationOnce().finally(() => { applicationLoading = null; });
  }
  return applicationLoading;
}

async function loadApplicationOnce() {
  if (appLoaded) return;
  try {
    const staticFiles = session.mode === "indexeddb";
    const [questions, stageList, project] = await Promise.all([
      fetchJson(staticFiles ? "./questions.json" : "/api/questions"),
      fetchJson(staticFiles ? "./stages.json" : "/api/stages"),
      staticFiles ? Promise.resolve(null) : fetchJson("/api/project"),
    ]);
    questionBank = questions;
    stages = stageList;
    if (project) replaceProject(project);
    appLoaded = true;
    sync.dirty = false;
    activeStage = -1;
    $("#auth-page").hidden = true;
    renderAll();
    renderAccountControls();
    setStatus(savedLabel());
  } catch (error) {
    console.error(error);
    if (error.status === 401 && accountsEnabled()) {
      session.token = "";
      writeStorage(STORAGE_KEYS.token, null);
      showAuthPage("Your session has expired. Please log in again.", { error: true });
      return;
    }
    setStatus("Could not load project", "error");
    toast("The project could not be loaded. Check your connection and refresh the page.");
  }
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

async function initializeBuiltin() {
  session.token = readStorage(STORAGE_KEYS.token) || "";
  if (!session.token) {
    showAuthPage("Log in or create an account to start planning.");
    return;
  }
  try {
    await loadCurrentUser();
  } catch (error) {
    if (error.status === 401) {
      session.token = "";
      writeStorage(STORAGE_KEYS.token, null);
      showAuthPage("Your session has expired. Please log in again.", { error: true });
    } else {
      setStatus("Server unavailable", "error");
      toast("Your account could not be checked right now. Refresh the page in a moment.");
    }
    return;
  }
  await loadApplication();
  renderAccountControls();
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
    console.error(error);
    showAuthPage("Sign-in is unavailable because the authentication library could not be loaded. Check your connection and refresh.", { error: true });
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
      if (appLoaded) window.location.reload();
      return;
    }
    if (authSession && event === "SIGNED_IN") {
      // Defer so Supabase finishes its own bookkeeping before we call the API.
      setTimeout(() => onSignedIn({ id: authSession.user.id, email: authSession.user.email }), 0);
    }
  });
  if (!session.token) {
    showAuthPage("Log in or create an account to start planning.");
    return;
  }
  await onSignedIn({ id: data.session.user.id, email: data.session.user.email });
}

async function initializeStatic() {
  $("#export-pdf").textContent = "↓  Print or save as PDF";
  let user = null;
  try {
    user = await loadStaticAuthSession();
  } catch (error) {
    console.error(error);
    showAuthPage("This browser is blocking local storage, so the demo cannot keep your work. Allow site data for this page and refresh.", { error: true });
    return;
  }
  if (!user) {
    showAuthPage("Create a local profile or log in to start planning.");
    return;
  }
  try {
    await startStaticSession(user);
  } catch (error) {
    console.error(error);
    setStatus("Could not load project", "error");
    toast("The project stored in this browser could not be loaded.");
  }
}

function bindUi() {
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
  document.querySelectorAll("[data-open-stage]").forEach((button) => {
    button.addEventListener("click", () => showStage(stages.findIndex((stage) => stage.title === button.dataset.openStage)));
  });
  $("#conflict-load").addEventListener("click", () => resolveConflict(false));
  $("#conflict-keep").addEventListener("click", () => resolveConflict(true));

  $("#login-button").addEventListener("click", () => showAuthPage("Enter your email and password to log in."));
  $("#register-button").addEventListener("click", () => showAuthPage("Choose an email and a password of at least 8 characters, then select Create account."));
  $("#auth-form").addEventListener("submit", handleSignIn);
  $("#sign-up").addEventListener("click", handleRegister);
  $("#magic-link").addEventListener("click", handleMagicLink);
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
    else await loadApplication();
  } catch (error) {
    console.error(error);
    setStatus("Could not start", "error");
    toast("The application could not be initialized. Refresh the page to try again.");
  }
}

initialize();
