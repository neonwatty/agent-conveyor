# Manager Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document and expose first-draft Agent Conveyor manager recipes, setup confirmations, example Dispatcher conversations, and database reporting value.

**Architecture:** Add one canonical recipe guide and a small CLI metadata surface, link both from existing user-facing docs, include the guide in the npm package, and update the shipped skill guidance so setup resolves to a named recipe or explicit custom mode before supervision begins.

**Tech Stack:** Python CLI metadata module, Markdown docs, npm `files` manifest, existing `manage-codex-workers` skill assets.

---

### Task 1: Canonical Recipe Guide

**Files:**
- Create: `docs/manager-recipes.md`

- [x] **Step 1: Create the guide**

Create `docs/manager-recipes.md` with recipe cards for GoalBuddy Conveyor, Test Coverage Loop, UX Polish Loop, Nudge / What's Next Manager, and PR/CI/Merge Ralph Loop. Each card includes manager settings, evidence gates, cleanup behavior, and a compact Manager -> Dispatch -> Worker interaction.

- [x] **Step 2: Include support patterns**

Add Inbox / No-Tmux App Loop and Recovery / Resume / Handoff as setup/support patterns that apply across recipes.

- [x] **Step 3: Document database reporting**

Add a database section naming the tables that make recipe behavior auditable and explaining how those records help users report issues and maintainers improve the system.

### Task 2: Link User-Facing Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/qa/README.md`
- Modify: `package.json`

- [x] **Step 1: Link the guide from install/setup docs**

Add a short README paragraph that points users at manager recipes after install and before setting a manager loose.

- [x] **Step 2: Link the guide from QA docs**

Add the guide to `docs/qa/README.md` so QA/dogfood runs can choose a recipe before selecting a scenario.

- [x] **Step 3: Include the guide in npm package files**

Add `docs/manager-recipes.md` to the package `files` list.

### Task 3: Add CLI Recipe Metadata

**Files:**
- Create: `workerctl/manager_recipes.py`
- Modify: `workerctl/commands.py`
- Modify: `workerctl/cli.py`
- Modify: `tests/test_workerctl.py`

- [x] **Step 1: Add recipe metadata module**

Create a small `ManagerRecipe` model plus the five first-draft recipe records,
aliases, suggested `manager-config` command generation, and locked summary
template rendering.

- [x] **Step 2: Add CLI command**

Add `conveyor manager-recipes --list|--show RECIPE [--json]` with stable JSON
output and compact text output.

- [x] **Step 3: Add focused tests**

Cover recipe metadata, unknown recipe rejection, CLI list output, and CLI show
output for `goalbuddy-conveyor`.

### Task 4: Update Skill Guidance

**Files:**
- Modify: `skills/manage-codex-workers/SKILL.md`
- Modify: `workerctl/assets/skills/manage-codex-workers/SKILL.md`

- [x] **Step 1: Add recipe setup rule**

Tell managers to resolve freeform setup into a named recipe or explicit custom mode, then show a locked summary before saving `manager-config`.

- [x] **Step 2: Name the first recipes**

List the five recipe names plus the two support patterns so installed skills and repository skills stay aligned.

### Task 5: Verification

**Files:**
- Inspect: changed files

- [x] **Step 1: Run targeted text checks**

Run `rg` against the changed docs and skill assets for all recipe names, `manager_configs`, `routed_notifications`, and setup confirmation language.

- [x] **Step 2: Inspect package manifest**

Verify `package.json` includes `docs/manager-recipes.md`.
