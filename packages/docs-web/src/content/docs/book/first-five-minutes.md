---
title: Your First Five Minutes
description: Get your first Smelter workflow running in under five minutes against your own codebase.
category: book
part: orientation
audience: [user]
sidebar:
  order: 2
---

Let's skip the theory and get you to a win. By the end of this chapter, you'll have run two real Smelter workflows against your own codebase.

---

## Prerequisites

Before you start, make sure you have:

- [ ] **Git** installed (`git --version` should work)
- [ ] **Bun** installed — get it at [bun.sh](https://bun.sh) if you don't have it (`bun --version`)
- [ ] **Claude Code** installed and authenticated — run `claude /login` if you haven't
- [ ] **A git repository** to run workflows against — any project works

> **Already using Claude Code?** You're already authenticated. No API keys or extra setup needed — Smelter uses the same credentials.

---

## Install Smelter (60 seconds)

```bash
# Clone and install
git clone https://github.com/coleam00/Smelter.git
cd Smelter
bun install

# Register the smelter command globally
cd packages/cli && bun link && cd ../..

# Verify it worked
smelter version
```

You should see something like `smelter v0.2.12`. That's it — Smelter is installed.

> **If `smelter` isn't found after `bun link`:** Your shell may need to reload. Run `source ~/.zshrc` (or `~/.bashrc`), then try again. Alternatively, use `bun run cli` from inside the `Smelter` directory for this session.

---

## Your First Win: Ask a Question (90 seconds)

Navigate to any git repository on your machine, then run:

```bash
cd /path/to/your/project

smelter workflow run smelter-assist "What's the entry point for this application?"
```

Smelter will analyze your codebase and answer the question with full context. You'll see it thinking through your files in real time, streamed to your terminal.

**You just ran your first Smelter workflow.** It's a single-step workflow — one command, one AI call, one answer. Simple, but useful.

> **Tip:** `smelter-assist` works for any question. "How does auth work?", "Where is the database configured?", "What does this function do?" — it's your always-available codebase expert.

---

## Your Second Win: Fix an Issue (2 minutes)

If your repository has a GitHub issue open, try this:

```bash
smelter workflow run smelter-fix-github-issue --branch fix/my-first-run "Fix #<issue-number>"
```

Replace `<issue-number>` with a real issue number from your repo. Then watch what happens:

1. **Investigate** — Smelter reads the issue, explores relevant code, and documents its findings
2. **Implement** — It makes the fix based on the investigation
3. **Validate** — It runs your tests to confirm nothing broke
4. **Create PR** — It opens a pull request with a full description

**You just ran a four-step automated workflow.** Each step ran a separate command, passing artifacts to the next step. The PR is ready for your review.

> **No GitHub issues handy?** Try `smelter workflow run smelter-feature-development --branch feat/test "Add a simple hello world endpoint"` on any web project — it'll implement and create a PR.

---

## What Just Happened?

Those two commands did more than they appeared to. Smelter loaded a workflow definition, created an isolated git workspace, ran multiple AI steps in sequence, and connected them through files called **artifacts**.

In [Chapter 3: How Smelter Actually Works →](/book/how-it-works/), we'll trace exactly what happened — step by step, file by file — so you understand the system you're working with.
