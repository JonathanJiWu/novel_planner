let stages = [];
const state = { title: "My Novel", answers: {}, question_states: {}, ideas: [], materials: [], theme: "dark", saved_at: null };
let saveTimer;
let toastTimer;
let activeStage = -1;
let projectDirty = false;
let saveInFlight = null;
let authClient = null;
let authSession = null;
let staticMode = false;
let currentUser = null;
let authRedirectUrl = "";
let oauthProviders = ["google", "github", "apple", "facebook"];

const $ = (selector) => document.querySelector(selector);
const nav = $("#stage-nav");

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (authSession && authSession.access_token) {
    headers.set("Authorization", `Bearer ${authSession.access_token}`);
  }
  return fetch(url, { ...options, headers });
}

function showStatus(message, failed = false) {
  const status = $("#save-state");
  status.textContent = message;
  status.classList.toggle("error", failed);
  const dot = document.createElement("span");
  dot.className = "save-dot";
  status.prepend(dot);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2300);
}

async function saveProject() {
  clearTimeout(saveTimer);
  if (staticMode) {
    if (!projectDirty) return true;
    projectDirty = false;
    state.saved_at = new Date().toISOString();
    localStorage.setItem("novel-architect-project", JSON.stringify(state));
    showStatus("All changes saved locally");
    renderProgress();
    return true;
  }
  if (saveInFlight) {
    await saveInFlight;
    return !projectDirty;
  }
  if (!projectDirty) return true;

  saveInFlight = (async () => {
    while (projectDirty) {
      projectDirty = false;
      showStatus("Saving…");
      const response = await apiFetch("/api/project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save project.");
      state.saved_at = result.saved_at;
    }
  })();

  try {
    await saveInFlight;
    showStatus("All changes saved");
    renderProgress();
    return true;
  } catch (error) {
    projectDirty = true;
    showStatus("Save failed — retry your change", true);
    console.error(error);
    return false;
  } finally {
    saveInFlight = null;
    if (projectDirty) saveTimer = setTimeout(saveProject, 1000);
  }
}

function scheduleSave() {
  projectDirty = true;
  showStatus("Unsaved changes");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 350);
}

function renderNavigation() {
  nav.replaceChildren();
  const inbox = document.createElement("button");
  inbox.className = `nav-item ${activeStage === -1 ? "active" : ""}`;
  inbox.innerHTML = '<span class="nav-number">✳</span><span>Idea inbox</span>';
  inbox.addEventListener("click", showInbox);
  nav.append(inbox);

  stages.forEach((stage, index) => {
    const button = document.createElement("button");
    const stageQuestions = questionsForStage(stage.title);
    const essentialQuestions = stageQuestions.filter(isEssentialQuestion);
    const complete = essentialQuestions.length > 0 && essentialQuestions.every(isQuestionSettled);
    button.className = `nav-item ${activeStage === index ? "active" : ""} ${complete ? "done" : ""}`;
    button.innerHTML = `<span class="nav-number">${complete ? "✓" : String(index + 1).padStart(2, "0")}</span><span>${escapeHtml(stage.label)}</span>`;
    button.addEventListener("click", () => showStage(index));
    nav.append(button);
  });
  const overview = $("#overview-button");
  if (overview) overview.classList.toggle("active", activeStage === -2);
  const admin = $("#admin-button");
  if (admin) admin.classList.toggle("active", activeStage === -3);
}

function questionsForStage(stageTitle) {
  return (window.questionBank || []).filter((question) => question.section === stageTitle);
}

function isEssentialQuestion(question) {
  const saved = state.question_states[question.question_id] || {};
  return question.required || question.planning_level === "essential" || saved.planning_level === "essential";
}

function isQuestionSettled(question) {
  const answer = (state.answers[question.question_id] || "").trim();
  const questionState = getQuestionState(question);
  return answer && questionState.certainty === "settled"
    && ["essential", "intentionally_unknown"].includes(questionState.planning_level);
}

function getQuestionState(question) {
  const saved = state.question_states[question.question_id] || {};
  return {
    planning_level: saved.planning_level || question.planning_level || (question.required ? "essential" : "important"),
    certainty: saved.certainty || "needs_work",
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function renderProgress() {
  const essential = (window.questionBank || []).filter(isEssentialQuestion);
  const completed = essential.filter(isQuestionSettled).length;
  const percent = essential.length ? Math.round((completed / essential.length) * 100) : 0;
  $("#progress-value").textContent = `${percent}%`;
  $("#progress-bar").style.width = `${percent}%`;
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
    const tag = document.createElement("span");
    tag.className = "idea-tag";
    tag.textContent = idea.category;
    meta.append(tag);
    content.append(text, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-idea";
    remove.setAttribute("aria-label", "Remove idea");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.ideas = state.ideas.filter((item) => item.id !== idea.id);
      renderIdeas();
      scheduleSave();
    });
    card.append(content, remove);
    list.append(card);
  });
}

function applyTheme() {
  const theme = ["dark", "light", "paper"].includes(state.theme) ? state.theme : "dark";
  document.documentElement.dataset.theme = theme;
  const selector = $("#theme-select");
  if (selector) selector.value = theme;
}

function renderOverview() {
  const list = $("#overview-list");
  if (!list) return;
  const query = ($("#overview-search").value || "").trim().toLowerCase();
  const filter = $("#overview-filter").value;
  const entries = [];
  Object.entries(state.answers).forEach(([questionId, answer]) => {
    const question = (window.questionBank || []).find((item) => item.question_id === questionId);
    if (!question || !answer.trim()) return;
    const decision = getQuestionState(question);
    entries.push({
      type: "answers",
      title: question.prompt,
      text: answer,
      meta: `${question.section} · ${decision.planning_level.replaceAll("_", " ")} · ${decision.certainty.replaceAll("_", " ")}`,
    });
  });
  state.ideas.forEach((idea) => entries.push({
    type: "ideas", title: idea.category, text: idea.text, meta: "Idea inbox · author note",
  }));
  (state.materials || []).forEach((material) => entries.push({
    type: "materials", title: material.category, text: material.text,
    meta: `${material.status.replaceAll("_", " ")} · ${material.source}`, id: material.id,
  }));
  const filtered = entries.filter((entry) => {
    if (filter !== "all" && filter !== "open" && entry.type !== filter) return false;
    if (filter === "open" && !/needs work|provisional|deferred|unknown/i.test(entry.meta)) return false;
    return !query || `${entry.title} ${entry.text} ${entry.meta}`.toLowerCase().includes(query);
  });
  const completed = (window.questionBank || []).filter(isQuestionSettled).length;
  $("#overview-summary").textContent =
    `${completed} essential decisions settled · ${state.ideas.length} ideas · ${(state.materials || []).length} original materials`;
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "overview-empty";
    empty.textContent = "Nothing matches this view yet.";
    list.append(empty);
    return;
  }
  filtered.forEach((entry) => {
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
    if (entry.type === "materials") {
      const material = state.materials.find((item) => item.id === entry.id);
      if (material) {
        const controls = document.createElement("div");
        controls.className = "overview-controls";
        const status = document.createElement("select");
        status.setAttribute("aria-label", `Review status for ${entry.title}`);
        [
          ["imported", "Imported — review"],
          ["approved", "Approved"],
          ["tentative", "Tentative"],
          ["deferred", "Deferred"],
          ["intentionally_unknown", "Intentionally unknown"],
          ["archived", "Archived"],
        ].forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          status.append(option);
        });
        status.value = material.status;
        status.addEventListener("change", () => {
          material.status = status.value;
          scheduleSave();
          renderOverview();
        });
        const category = document.createElement("select");
        category.setAttribute("aria-label", `Category for ${entry.title}`);
        ["Unsorted", "Story", "Character", "World", "Plot", "Theme", "Tone & style", "Scene"]
          .forEach((value) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            category.append(option);
          });
        category.value = material.category;
        category.addEventListener("change", () => {
          material.category = category.value;
          scheduleSave();
          renderOverview();
        });
        controls.append(status, category);
        card.append(controls);
      }
    }
    list.append(card);
  });
}

function showInbox() {
  activeStage = -1;
  $("#idea-inbox").classList.add("active");
  $("#question-page").classList.remove("active");
  $("#overview-page").classList.remove("active");
  $("#admin-page").classList.remove("active");
  $("#current-breadcrumb").textContent = "IDEA INBOX";
  renderNavigation();
}

function showOverview() {
  activeStage = -2;
  $("#idea-inbox").classList.remove("active");
  $("#question-page").classList.remove("active");
  $("#overview-page").classList.add("active");
  $("#admin-page").classList.remove("active");
  $("#current-breadcrumb").textContent = "PROJECT OVERVIEW";
  renderOverview();
  renderNavigation();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showStage(index) {
  activeStage = index;
  const stage = stages[index];
  $("#idea-inbox").classList.remove("active");
  $("#question-page").classList.add("active");
  $("#overview-page").classList.remove("active");
  $("#admin-page").classList.remove("active");
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

  questionsForStage(stage.title).forEach((question) => {
    const blockedDependencies = (question.dependencies || []).filter(
      (dependency) => !(state.answers[dependency] || "").trim(),
    );
    const blocked = blockedDependencies.length > 0;
    const card = document.createElement("article");
    card.className = `question-card ${blocked ? "question-locked" : ""}`;
    const heading = document.createElement("h3");
    heading.textContent = question.prompt;
    const description = document.createElement("p");
    description.className = "question-meta";
    description.textContent = [question.definition, question.purpose].filter(Boolean).join(" ");
    const textarea = document.createElement("textarea");
    textarea.value = state.answers[question.question_id] || "";
    textarea.disabled = blocked;
    textarea.placeholder = "Capture your thoughts…";
    textarea.setAttribute("aria-label", question.prompt);
    textarea.addEventListener("input", () => {
      state.answers[question.question_id] = textarea.value;
      const currentDecision = state.question_states[question.question_id];
      if (currentDecision && currentDecision.certainty === "settled") {
        currentDecision.certainty = "provisional";
        decision.value = "provisional";
      }
      scheduleSave();
      renderProgress();
    });
    const controls = document.createElement("div");
    controls.className = "answer-controls";
    const importanceLabel = document.createElement("label");
    importanceLabel.textContent = "PLANNING STATUS";
    const importance = document.createElement("select");
    importance.setAttribute("aria-label", `Planning status for ${question.prompt}`);
    [
      ["essential", "Essential"],
      ["important", "Important"],
      ["optional", "Optional"],
      ["deferred", "Deferred"],
      ["intentionally_unknown", "Intentionally unknown"],
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      importance.append(option);
    });
    const decisionLabel = document.createElement("label");
    decisionLabel.textContent = "DECISION STATE";
    const decision = document.createElement("select");
    decision.setAttribute("aria-label", `Decision state for ${question.prompt}`);
    [
      ["needs_work", "Needs development"],
      ["provisional", "Provisional"],
      ["settled", "Settled for now"],
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      decision.append(option);
    });
    const currentState = getQuestionState(question);
    importance.value = currentState.planning_level;
    decision.value = currentState.certainty;
    importance.disabled = blocked;
    decision.disabled = blocked;
    const updateQuestionState = () => {
      state.question_states[question.question_id] = {
        planning_level: importance.value,
        certainty: decision.value,
      };
      scheduleSave();
      renderProgress();
    };
    importance.addEventListener("change", updateQuestionState);
    decision.addEventListener("change", updateQuestionState);
    const importanceWrap = document.createElement("div");
    importanceWrap.append(importanceLabel, importance);
    const decisionWrap = document.createElement("div");
    decisionWrap.append(decisionLabel, decision);
    controls.append(importanceWrap, decisionWrap);
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
      const promptsById = new Map((window.questionBank || []).map((item) => [item.question_id, item.prompt]));
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
  });

  $("#previous-stage").disabled = index === 0;
  $("#previous-stage").style.visibility = index === 0 ? "hidden" : "visible";
  $("#next-stage").textContent = index === stages.length - 1 ? "Back to idea inbox" : "Next section →";
  renderNavigation();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function addIdea() {
  const textarea = $("#idea-text");
  const text = textarea.value.trim();
  if (!text) {
    textarea.focus();
    toast("Write a thought or fragment before saving it.");
    return;
  }
  state.ideas.unshift({
    id: crypto.randomUUID(),
    text,
    category: $("#idea-category").value,
  });
  textarea.value = "";
  renderIdeas();
  scheduleSave();
  toast("Idea added to your shelf.");
}

function addImportedMaterial(text, source) {
  state.materials = state.materials || [];
  state.materials.unshift({
    id: crypto.randomUUID(),
    text: text.trim(),
    category: "Unsorted",
    status: "imported",
    source,
  });
  scheduleSave();
  renderOverview();
  toast("Material imported for review.");
}

function setAuthMessage(message, failed = false) {
  const messageElement = $("#auth-message");
  messageElement.textContent = message;
  messageElement.classList.toggle("error", failed);
}

function showAuthPage(show) {
  $("#auth-page").hidden = !show;
  ["idea-inbox", "overview-page", "question-page"].forEach((id) => {
    $(`#${id}`).classList.toggle("active", !show && id === "idea-inbox");
  });
  $("#sign-out").hidden = show || !authClient;
  $("#login-button").hidden = !authClient || Boolean(authSession);
  $("#register-button").hidden = !authClient || Boolean(authSession);
  $("#admin-page").classList.toggle("active", false);
  if (show) $("#admin-button").hidden = true;
}

async function loadCurrentUser() {
  if (!authSession) {
    currentUser = null;
    $("#admin-button").hidden = true;
    return;
  }
  const response = await apiFetch("/api/me");
  if (!response.ok) throw new Error("Could not verify the current account.");
  currentUser = await response.json();
  $("#admin-button").hidden = !currentUser.is_admin;
}

async function showAdmin() {
  activeStage = -3;
  document.querySelectorAll(".page-section").forEach((section) => section.classList.remove("active"));
  $("#admin-page").classList.add("active");
  renderNavigation();
  await loadAdminProjects();
}

async function loadAdminProjects() {
  const list = $("#admin-project-list");
  list.textContent = "Loading projects…";
  const response = await apiFetch("/api/admin/projects");
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    list.textContent = result.detail || "Administrator access is not available.";
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
    meta.textContent = `${project.owner_id} · Updated ${project.updated_at || "unknown"}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary-button";
    remove.textContent = "Delete project";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete the project owned by ${project.owner_id}?`)) return;
      const deleteResponse = await apiFetch(`/api/admin/projects/${encodeURIComponent(project.owner_id)}`, { method: "DELETE" });
      if (!deleteResponse.ok) {
        toast("The project could not be deleted.");
        return;
      }
      toast("Project deleted.");
      await loadAdminProjects();
    });
    card.append(heading, meta, remove);
    list.append(card);
  });
}

function setupAuthHandlers() {
  $("#login-button").addEventListener("click", () => {
    showAuthPage(true);
    setAuthMessage("Enter your email and password to log in.");
    $("#auth-email").focus();
  });
  $("#register-button").addEventListener("click", () => {
    showAuthPage(true);
    setAuthMessage("Enter an email and a password of at least 8 characters.");
    $("#auth-email").focus();
  });
  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    if (!authClient) {
      setAuthMessage("Authentication is not configured on this deployment.", true);
      return;
    }
    if (!email || password.length < 8) {
      setAuthMessage("Enter an email and a password of at least 8 characters.", true);
      return;
    }
    setAuthMessage("Signing in…");
    try {
      const { error } = await authClient.auth.signInWithPassword({ email, password });
      if (error) setAuthMessage(error.message, true);
    } catch (error) {
      setAuthMessage(error.message || "Could not sign in.", true);
    }
  });
  $("#sign-up").addEventListener("click", async () => {
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    if (!authClient) {
      setAuthMessage("Authentication is not configured on this deployment.", true);
      return;
    }
    if (!email || password.length < 8) {
      setAuthMessage("Enter an email and a password of at least 8 characters.", true);
      return;
    }
    setAuthMessage("Creating your account…");
    try {
      const { error } = await authClient.auth.signUp({ email, password });
      setAuthMessage(error ? error.message : "Account created. Check your email to confirm it.");
    } catch (error) {
      setAuthMessage(error.message || "Could not create the account.", true);
    }
  });
  $("#magic-link").addEventListener("click", async () => {
    const email = $("#auth-email").value.trim();
    if (!email) {
      setAuthMessage("Enter your email first.", true);
      return;
    }
    try {
      const { error } = await authClient.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: authRedirectUrl },
      });
      setAuthMessage(error ? error.message : "Magic link sent. Check your email.");
    } catch (error) {
      setAuthMessage(error.message || "Could not send the magic link.", true);
    }
  });
  document.querySelectorAll("[data-provider]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!authClient) {
        setAuthMessage("Authentication is not configured on this deployment.", true);
        return;
      }
      setAuthMessage(`Opening ${button.textContent.trim()} sign-in…`);
      try {
        const { error } = await authClient.auth.signInWithOAuth({
          provider: button.dataset.provider,
          options: { redirectTo: authRedirectUrl, skipBrowserRedirect: false },
        });
        if (error) setAuthMessage(error.message, true);
      } catch (error) {
        setAuthMessage(error.message || `${button.textContent.trim()} sign-in could not start.`, true);
      }
    });
  });
  $("#sign-out").addEventListener("click", async () => {
    const { error } = await authClient.auth.signOut();
    if (error) toast(error.message);
  });
}

async function downloadExport(url) {
  if (staticMode) {
    if (url.endsWith("/pdf")) {
      window.print();
      return;
    }
    const sections = [];
    sections.push(`# ${state.title || "My Novel"}`);
    sections.push("");
    for (const idea of state.ideas || []) {
      sections.push(`## Idea — ${idea.category}`, "", idea.text, "");
    }
    for (const material of state.materials || []) {
      sections.push(`## Material — ${material.category}`, "", `Source: ${material.source}`, "", material.text, "");
    }
    for (const [questionId, answer] of Object.entries(state.answers || {})) {
      const question = (window.questionBank || []).find((item) => item.question_id === questionId);
      if (!question || !answer.trim()) continue;
      const decision = state.question_states[questionId] || {};
      sections.push(`## ${question.prompt}`, "", answer.trim(), "", `Planning level: ${decision.planning_level || question.planning_level}`, `Certainty: ${decision.certainty || "needs_work"}`, "");
    }
    const blob = new Blob([sections.join("\n")], { type: "text/markdown;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = "novel-writing-plan.md";
    link.click();
    URL.revokeObjectURL(blobUrl);
    return;
  }
  const response = await apiFetch(url);
  if (!response.ok) {
    toast("The export could not be generated.");
    return;
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = url.endsWith("/pdf") ? "novel-writing-plan.pdf" : "novel-writing-plan.md";
  link.click();
  URL.revokeObjectURL(blobUrl);
}

async function loadApplication() {
  try {
    const [projectResponse, questionResponse, stageResponse] = await Promise.all([
      apiFetch("/api/project"),
      apiFetch("/api/questions"),
      apiFetch("/api/stages"),
    ]);
    if (!projectResponse.ok || !questionResponse.ok || !stageResponse.ok) throw new Error("Could not load the project.");
    Object.assign(state, await projectResponse.json());
    state.materials = state.materials || [];
    state.theme = state.theme || "dark";
    window.questionBank = await questionResponse.json();
    stages = await stageResponse.json();
    applyTheme();
    $("#project-title").value = state.title;
    $("#project-title").addEventListener("input", () => {
      state.title = $("#project-title").value;
      scheduleSave();
    });
    $("#add-idea").addEventListener("click", addIdea);
    $("#add-material").addEventListener("click", () => {
      const textarea = $("#idea-text");
      const text = textarea.value.trim();
      if (!text) {
        textarea.focus();
        toast("Paste some material before importing it.");
        return;
      }
      addImportedMaterial(text, "Pasted material");
      textarea.value = "";
    });
    $("#overview-button").addEventListener("click", showOverview);
    $("#admin-button").addEventListener("click", showAdmin);
    $("#refresh-admin").addEventListener("click", loadAdminProjects);
    $("#theme-select").addEventListener("change", (event) => {
      state.theme = event.target.value;
      applyTheme();
      scheduleSave();
    });
    $("#overview-search").addEventListener("input", renderOverview);
    $("#overview-filter").addEventListener("change", renderOverview);
    $("#material-file").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        addImportedMaterial(await file.text(), file.name);
      } catch (error) {
        toast("That file could not be read.");
        console.error(error);
      } finally {
        event.target.value = "";
      }
    });
    document.querySelectorAll(".export-link").forEach((exportLink) => exportLink.addEventListener("click", async (event) => {
      event.preventDefault();
      const exportUrl = event.currentTarget.href;
      if (await saveProject()) {
        await downloadExport(exportUrl);
      } else {
        toast("Your changes could not be saved. Try exporting again.");
      }
    }));
    $("#idea-text").addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") addIdea();
    });
    $("#previous-stage").addEventListener("click", () => showStage(Math.max(0, activeStage - 1)));
    $("#next-stage").addEventListener("click", () => activeStage === stages.length - 1 ? showInbox() : showStage(activeStage + 1));
    document.querySelectorAll("[data-open-stage]").forEach((button) => {
      button.addEventListener("click", () => showStage(stages.findIndex((stage) => stage.title === button.dataset.openStage)));
    });
    renderIdeas();
    renderProgress();
    showInbox();
    showStatus("All changes saved");
  } catch (error) {
    showStatus("Could not load project", true);
    console.error(error);
    toast("The project could not be loaded. Check the server and refresh.");
  }
}

async function initialize() {
  setupAuthHandlers();
  try {
    const configResponse = await fetch("/api/config");
    const config = configResponse.ok
      ? await configResponse.json()
      : { supabase_configured: false };
    if (!configResponse.ok) {
      staticMode = true;
      const savedProject = localStorage.getItem("novel-architect-project");
      if (savedProject) {
        try {
          Object.assign(state, JSON.parse(savedProject));
        } catch (error) {
          console.warn("Ignoring invalid local project data.", error);
        }
      }
      const [questionResponse, stageResponse] = await Promise.all([
        fetch("./questions.json"),
        fetch("./stages.json"),
      ]);
      if (!questionResponse.ok || !stageResponse.ok) {
        throw new Error("Static application data could not be loaded.");
      }
      window.questionBank = await questionResponse.json();
      stages = await stageResponse.json();
      state.materials = state.materials || [];
      applyTheme();
      $("#project-title").value = state.title;
      $("#project-title").addEventListener("input", () => {
        state.title = $("#project-title").value;
        scheduleSave();
      });
      $("#add-idea").addEventListener("click", addIdea);
      $("#add-material").addEventListener("click", () => {
        const text = $("#idea-text").value.trim();
        if (!text) {
          $("#idea-text").focus();
          toast("Paste some material before importing it.");
          return;
        }
        addImportedMaterial(text, "Pasted material");
        $("#idea-text").value = "";
      });
      $("#overview-button").addEventListener("click", showOverview);
      $("#theme-select").addEventListener("change", (event) => {
        state.theme = event.target.value;
        applyTheme();
        scheduleSave();
      });
      $("#overview-search").addEventListener("input", renderOverview);
      $("#overview-filter").addEventListener("change", renderOverview);
      $("#material-file").addEventListener("change", async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
          addImportedMaterial(await file.text(), file.name);
        } catch (error) {
          toast("That file could not be read.");
          console.error(error);
        } finally {
          event.target.value = "";
        }
      });
      $("#idea-text").addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") addIdea();
      });
      $("#previous-stage").addEventListener("click", () => showStage(Math.max(0, activeStage - 1)));
      $("#next-stage").addEventListener("click", () => activeStage === stages.length - 1 ? showInbox() : showStage(activeStage + 1));
      document.querySelectorAll("[data-open-stage]").forEach((button) => {
        button.addEventListener("click", () => showStage(stages.findIndex((stage) => stage.title === button.dataset.openStage)));
      });
      document.querySelectorAll(".export-link").forEach((exportLink) => exportLink.addEventListener("click", async (event) => {
        event.preventDefault();
        if (await saveProject()) await downloadExport(event.currentTarget.pathname);
      }));
      renderIdeas();
      renderProgress();
      showInbox();
      showStatus("Saved locally");
      return;
    }
    authRedirectUrl = config.public_app_url
      ? config.public_app_url
      : `${window.location.origin}${window.location.pathname}`;
    oauthProviders = (config.oauth_providers || "google,github,apple,facebook")
      .split(",")
      .map((provider) => provider.trim())
      .filter(Boolean);
    document.querySelectorAll("[data-provider]").forEach((button) => {
      button.hidden = !oauthProviders.includes(button.dataset.provider);
    });
    if (config.supabase_configured && window.supabase) {
      authClient = window.supabase.createClient(config.supabase_url, config.supabase_anon_key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
      const { data } = await authClient.auth.getSession();
      authSession = data.session;
      authClient.auth.onAuthStateChange((_event, session) => {
        const hadUser = Boolean(authSession && authSession.user);
        authSession = session;
        if (session) {
          showAuthPage(false);
          if (!hadUser) {
            loadApplication();
            loadCurrentUser().catch((error) => console.error(error));
          }
        } else {
          showAuthPage(true);
        }
      });
      if (!authSession) {
        showAuthPage(true);
        return;
      }
      await loadCurrentUser();
    }
    await loadApplication();
  } catch (error) {
    showStatus("Could not load configuration", true);
    console.error(error);
    toast("The application could not be initialized.");
  }
}

initialize();
