# 🔧 AutoForge

AutoForge is an autonomous platform that uses an LLM (**OpenAI or Anthropic — your choice**) to find real-world developer problems, build Node.js apps to solve them, and ship them to GitHub — creating the repo, opening issues, writing code, committing **under your name**, and merging pull requests, all without manual intervention. When it gets stuck, it emails you a specific question and pauses until you reply.

A dark, dependency-free dashboard shows the live run log (via Server-Sent Events), current status, and past runs.

## Work modes

Choose in **Settings → Work mode**:

| Mode | What it does | Merges? |
|---|---|---|
| **New idea** | Invents a brand-new project (from trending sources), creates the repo + issues, and builds it. | Yes (own repo) |
| **Fix repo** | Clones an existing repo **you can push to**, analyzes the code + open issues, and ships fixes/improvements as PRs. | Yes (own repo) |
| **Open source** | Forks any public repo, picks an open issue (or proposes a fix), implements it on the fork, and opens a **PR upstream**. | No — left open for the maintainer |

`Fix repo` / `Open source` need a **Target repo** (`owner/name` or URL). All three run the same self-correcting verify loop.

> **Human-authored footprint**: commits use your name/email, and nothing AutoForge produces (commits, PRs, issues, code, README, emails) references Claude, AI, or AutoForge — the GitHub trail reads as your own work. (The dashboard's private activity log is for you and is not pushed anywhere.)

## Audit trail

Every run is recorded. The dashboard's **Past Runs** table links to a **Run detail** page (`/run?id=…`) showing, per task: status, the exact **files changed** (each linking to the file on its branch), the **branch**, and the **pull request** (clickable). The full activity log is shown too. Nothing is hidden — you can review and redirect straight to any commit/PR/file on GitHub.

## Features

- **Autonomous loop**: pick work (new idea / your repo / open source) → analyze → generate code → **verify & self-correct** → branch → PR → (merge if you own it) → close issue.
- **Self-correcting code generation**: each issue's code is written to a local per-run workspace, then `node --check`'d and (if there's a `package.json`) `npm install`'d and `npm test`/`npm run build`'d. On failure, the error is fed back to Claude to fix — up to N attempts — before anything is committed. Each issue also gets the **full content** of previously-built files as context, so multi-file projects stay coherent.
- **Commits as you**: files are committed via the GitHub Contents API with your `name`/`email`, never "Claude".
- **Stuck → email**: after 3 failed code-generation attempts, AutoForge emails you and resumes when you reply (polled over IMAP every 5 minutes).
- **Provider + Model + Priority control**: choose **OpenAI** or **Anthropic** in Settings, then pick a default model and per-stage overrides, plus a global priority tier (fast / balanced / max). For Anthropic the tier also maps to `effort`; for OpenAI it selects the tier's model. Default provider is OpenAI (`gpt-4o`); switch to Anthropic (`claude-opus-4-8`) anytime.
- **Scheduler**: daily / twice-daily / weekly via cron, plus a "Run Now" button.

## Tech stack

Node.js 20+ · Express · MongoDB (Mongoose) · `@anthropic-ai/sdk` (adaptive thinking + effort) · `@octokit/rest` · Nodemailer + ImapFlow · `node-cron`. Plain HTML/CSS/vanilla-JS frontend (no build step).

## Prerequisites

- **Node.js 20+**
- **MongoDB** — local (`brew install mongodb-community` then `brew services start mongodb-community`) or a MongoDB Atlas cluster.
- A **Gmail account with an App Password** (for sending queries and reading replies).
- A **GitHub Personal Access Token**.
- An **OpenAI API key** *or* an **Anthropic API key** (whichever provider you select in Settings).

## Installation

```bash
git clone <your-fork> autoforge && cd autoforge
npm install
cp .env.example .env        # then edit SECRET_KEY and MONGODB_URI
npm start
```

Open http://localhost:3000 and go to **Settings** to enter your keys. Everything except `SECRET_KEY`, `PORT`, and `MONGODB_URI` is configured through the UI and stored encrypted in MongoDB.

### `.env`

```env
SECRET_KEY=<random 32+ char string used to encrypt stored secrets>
PORT=3000
MONGODB_URI=mongodb://localhost:27017/autoforge
```

## Getting a Gmail App Password

1. Enable 2-Step Verification on your Google account.
2. Go to **Google Account → Security → 2-Step Verification → App passwords**.
3. Create a new app password (e.g. "AutoForge"); Google shows a 16-character code.
4. Paste it into Settings → **Gmail app password** (and your Gmail address as the sender).

## Getting a GitHub Personal Access Token

1. GitHub → **Settings → Developer settings → Personal access tokens**.
2. Create a token with **`repo`** scope (and **`workflow`** if your generated projects use Actions).
3. Paste it into Settings → **GitHub token**, and set your GitHub username + the email you want on commits.

## How the email query system works

When Claude can't produce valid code for an issue after 3 attempts, AutoForge:

1. Records a pending query in MongoDB and emails `user_email`. The subject contains a short run id (e.g. `[a1b2c3d4]`).
2. Sets the run status to `waiting_for_reply` (the dashboard shows a ⏸ banner).
3. Polls your inbox over IMAP every 5 minutes for a reply whose subject still contains that id.
4. On finding your reply, stores the answer, sends a confirmation, and resumes — feeding your guidance back into Claude's next attempt.

> Keep the subject line intact when you reply so AutoForge can match it.

## Dashboard

- **Current Run** card + live SSE log (color-coded: green=success, yellow=info/warn, red=error, auto-scrolling).
- **Run Now** starts a run immediately (disabled while one is active).
- **Past Runs** table with links to each repo.
- Optional **dashboard password** (set in Settings) gates access via a login page.

## ⚠️ Security note (verify loop)

When the **self-correcting verify loop** is enabled (Settings → "Self-correcting verify loop = On", the default), AutoForge **executes AI-generated code on the host machine** — including running `npm install`, which downloads and runs whatever packages the generated `package.json` lists. This is arbitrary code execution and a supply-chain surface (a hallucinated/typosquatted package name could install something malicious).

Mitigations:
- Run AutoForge in a **disposable/sandboxed environment** (a container or VM), not your primary machine, when the verify loop is on.
- Code is written to `data/workspaces/<runId>/` and cleaned up after each run.
- To disable execution entirely, set **Self-correcting verify loop = Off** — code is then committed exactly as generated (untested), with no local execution.

## Troubleshooting

- **"Anthropic/GitHub token not configured"** — fill it in Settings and click the Test button. The picker defaults to `claude-opus-4-8`.
- **MongoDB connection error on startup** — confirm `MONGODB_URI` and that MongoDB is running (`brew services list`). Atlas users: whitelist your IP.
- **Test Email fails** — you must use a Gmail **App Password**, not your normal password, and have 2-Step Verification enabled.
- **Commits show the wrong author** — set both `github_username` and `github_email` in Settings; the email must be one attached to your GitHub account for it to link to your profile.
- **Run stuck on `waiting_for_reply`** — check the email it sent; reply keeping the subject line. IMAP must be enabled in Gmail settings.
