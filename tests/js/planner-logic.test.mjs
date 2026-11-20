// Unit tests for web/planner-logic.js (pure functions used by the browser app).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const Logic = require("../../web/planner-logic.js");
const questions = JSON.parse(readFileSync(new URL("../../web/questions.json", import.meta.url), "utf8"));
const stages = JSON.parse(readFileSync(new URL("../../web/stages.json", import.meta.url), "utf8"));
const essential = questions.filter((question) => question.required);

test("progress counts settled essential decisions", () => {
  const empty = Logic.progress(questions, {}, {});
  assert.equal(empty.total, essential.length);
  assert.equal(empty.percent, 0);

  const [first] = essential;
  const answers = { [first.question_id]: "An answer" };
  const states = { [first.question_id]: { planning_level: "essential", certainty: "settled" } };
  const one = Logic.progress(questions, answers, states);
  assert.equal(one.settled, 1);
  assert.equal(one.percent, Math.round(100 / essential.length));

  // Settled requires an answer unless the decision is intentionally unknown.
  assert.equal(Logic.progress(questions, {}, states).settled, 0);
});

test("downgrading or deferring an essential question removes it from the target", () => {
  // Regression: a deferred essential question stayed in the denominator forever,
  // so 100% was unreachable.
  const [first, second] = essential;
  const states = {
    [first.question_id]: { planning_level: "deferred", certainty: "needs_work" },
    [second.question_id]: { planning_level: "optional", certainty: "needs_work" },
  };
  assert.equal(Logic.progress(questions, {}, states).total, essential.length - 2);
});

test("an essential question kept intentionally unknown counts once confirmed", () => {
  const [first] = essential;
  const states = { [first.question_id]: { planning_level: "intentionally_unknown", certainty: "settled" } };
  const result = Logic.progress(questions, {}, states);
  assert.equal(result.total, essential.length);
  assert.equal(result.settled, 1);
});

test("a stage is complete when all of its counted decisions are settled", () => {
  const stageQuestions = questions.filter((question) => question.section === stages[0].title);
  const answers = {};
  const states = {};
  stageQuestions.filter((question) => question.required).forEach((question) => {
    answers[question.question_id] = "Answer";
    states[question.question_id] = { planning_level: "essential", certainty: "settled" };
  });
  assert.equal(Logic.stageComplete(stageQuestions, answers, states), true);
  assert.equal(Logic.stageComplete(stageQuestions, {}, {}), false);
});

test("open decisions include unresolved essentials, unsettled answers, and deferrals", () => {
  const [essentialQuestion] = essential;
  const optional = questions.find((question) => !question.required);
  assert.equal(Logic.isOpenDecision(essentialQuestion, {}, {}), true);
  assert.equal(Logic.isOpenDecision(optional, {}, {}), false);
  assert.equal(Logic.isOpenDecision(optional, { [optional.question_id]: "draft" }, {}), true);
  assert.equal(
    Logic.isOpenDecision(optional, { [optional.question_id]: "done" }, { [optional.question_id]: { planning_level: "optional", certainty: "settled" } }),
    false,
  );
  assert.equal(Logic.isOpenDecision(optional, {}, { [optional.question_id]: { planning_level: "deferred" } }), true);
  assert.equal(Logic.isOpenMaterial({ status: "imported" }), true);
  assert.equal(Logic.isOpenMaterial({ status: "approved" }), false);
});

test("splitText respects the limit, prefers paragraph breaks, and keeps surrogate pairs whole", () => {
  const paragraph = "word ".repeat(40).trim();
  const text = Array.from({ length: 30 }, () => paragraph).join("\n\n");
  const parts = Logic.splitText(text, 1000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 1000));
  assert.ok(parts.every((part) => part.startsWith("word") && part.endsWith("word")));
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));

  const emoji = "😀".repeat(1000); // 2000 UTF-16 code units, no break opportunities
  const emojiParts = Logic.splitText(emoji, 333);
  assert.ok(emojiParts.every((part) => part.length <= 333));
  assert.ok(emojiParts.every((part) => !/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part)));
  assert.equal(emojiParts.join(""), emoji);
});

test("validationError mirrors the server limits", () => {
  const project = Logic.emptyProject();
  assert.equal(Logic.validationError(project), null);
  assert.match(Logic.validationError({ ...project, title: "x".repeat(201) }), /at most 200/);
  assert.match(Logic.validationError({ ...project, answers: { story_seed: "x".repeat(100001) } }), /longer than 100,000/);
  assert.match(Logic.validationError({ ...project, ideas: [{ id: "a", text: " ", category: "Story" }] }), /empty/);
  assert.match(Logic.validationError({ ...project, materials: [{ id: "m", text: "x".repeat(100001) }] }), /at most 100,000/);
});

test("normalizeTitle and planningLabel", () => {
  assert.equal(Logic.normalizeTitle("  The   Quiet  Archive "), "The Quiet Archive");
  assert.equal(Logic.normalizeTitle("   "), "Untitled novel");
  assert.equal(Logic.planningLabel("intentionally_unknown"), "Intentionally Unknown");
  assert.equal(Logic.planningLabel("needs_work"), "Needs Work");
});

test("buildMarkdown keeps multi-line answers inside their list item", () => {
  const markdown = Logic.buildMarkdown({ ...Logic.emptyProject(), answers: { story_identity: "One\nTwo" } }, questions, stages);
  assert.ok(markdown.includes("  - One\n    Two\n"));
  assert.ok(markdown.startsWith("# My Novel\n"));
  assert.ok(markdown.includes("### Stage J — Continuity & Readiness"));
});
