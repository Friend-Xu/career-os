<div align="center">

# Career OS

**The most expensive part of a job search isn't sending resumes. It's picking the wrong direction.**

Describe your situation in one sentence. Get an executable, data-backed career decision —
from direction exploration to resume writing, covering the full decision chain.

[![License](https://img.shields.io/badge/License-GPLv3-blue)](LICENSE)
![Version](https://img.shields.io/badge/version-1.1.0--beta.3-blue)

[English](README.en.md) | [中文](README.md)

</div>

---

## What You Get

| Scenario | What the system does | What you get |
|----------|----------------------|--------------|
| Build a career profile | Resume / interview intake — AI extracts candidate facts, you confirm, they become profile data | A career profile: skills / goals / direction / evidence status at a glance |
| Know the next step | Profile-state-driven Next Actions + guidance cards + nav badges | Clear action entry points — never lost |
| Explore career directions | Decision Agent analyzes candidate directions from your profile, output lands in decision records | A direction decision, traceable on the workbench timeline |
| Analyze a JD / vet a company | Agent breaks down requirements, scores fit, researches the company | Decision records + info-pool graph nodes |
| Tailor a resume | JD-driven derivation + select-to-rewrite + version management | Resume versions ready to submit |
| Track applications | Application board + follow-up priority | Application status under control |

The workbench (:5288) projects all of the above as visual assets: career profile / decision timeline / info-pool graph / resume center / application board. The "Decision Agent" panel collaborates with a real LLM (streaming replies / question cards / permission dialogs).

## A Completed Decision Chain

**Li Ming, 28, non-standard automation mechanical engineer (Changzhou), wants to move into robotics after a 10-month grad-school gap.** (A **virtual test user** demonstrating the full pipeline — not a real case; companies are pseudonyms.)
Walked the full chain in Career OS: transition feasibility (44% skill overlap → bridge path: non-standard automation → mechatronics → robotics, close the gap while employed, no quitting cold) → city evaluation (Suzhou 8.2/10, robotics industry density 9/10) → company screening → due diligence → final conclusion.

→ Read the full decision-chain record: [docs/case-studies/2026-07-李明-非标自动化转机器人.md](docs/case-studies/2026-07-李明-非标自动化转机器人.md) (Chinese, virtual test user)

## Screenshots

<table>
<tr>
<td><img src="docs/screenshots/01-workbench.png" alt="Workbench" width="100%"/><br/><sub>Workbench: decision timeline + next action</sub></td>
<td><img src="docs/screenshots/Agent.png" alt="Decision Agent" width="100%"/><br/><sub>Decision Agent: real LLM chat (streaming / question cards / permission dialogs)</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/信息池.png" alt="Info Pool" width="100%"/><br/><sub>Info pool: decisions / companies / directions / cities graph</sub></td>
<td><img src="docs/screenshots/公司地图.png" alt="Companies" width="100%"/><br/><sub>Company explorer: map view + target company list</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/公司背调.png" alt="Due Diligence" width="100%"/><br/><sub>Company due diligence: career-value score + risk signals</sub></td>
<td><img src="docs/screenshots/JD.png" alt="JD Workspace" width="100%"/><br/><sub>JD workspace: gate matching + engine match score + decision zone</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/投递状态管理.png" alt="Applications" width="100%"/><br/><sub>Applications: application progress board</sub></td>
<td><img src="docs/screenshots/简历编辑.png" alt="Resumes" width="100%"/><br/><sub>Resume center: version workspace + selection AI rewrite</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/方向探索.png" alt="Direction View" width="100%"/><br/><sub>Direction view: decisions grouped by direction + recommended directions</sub></td>
<td><img src="docs/screenshots/职业方向探索.png" alt="Direction Exploration" width="100%"/><br/><sub>Direction exploration: direction decisions and match rates</sub></td>
</tr>
<tr>
<td colspan="2" align="center"><img src="docs/screenshots/基于JD优化简历.png" alt="JD-driven Resume Optimization" width="60%"/><br/><sub>JD-driven resume optimization: gap-driven derivation proposals</sub></td>
</tr>
</table>

## Quick Start

**Option 1: Local workbench (recommended)**

```bash
git clone https://github.com/Friend-Xu/career-os.git
cd career-os
node runtime/supervisor.mjs     # Windows: double-click StartWebUI.bat (bundled portable node is a required runtime dependency; missing it fails fast with install instructions)
```
Stop: `node runtime/stop-all.mjs` or double-click stop-all.bat · Diagnose: `node runtime/doctor.mjs`.

Open **http://localhost:5288**: decision chains, info-pool graph, company due diligence and application boards, all visualized. The "Decision Agent" panel chats with a real LLM (engine connects directly to your configured provider — streaming replies, question cards, permission dialogs, thinking process).

The `workspace/` directory is created automatically on first run. No setup required. Full workflow: [ARCHITECTURE.md](ARCHITECTURE.md).

## Runtime & Process Lifecycle (Runtime Safety Layer)

The engine and frontend are supervised by `runtime/supervisor.mjs` — solving "processes left behind on close / can't start next time":

| Action | Command |
|--------|---------|
| Start | `StartWebUI.bat` (or `node runtime/supervisor.mjs`) |
| Stop | `stop-all.bat` (or `node runtime/stop-all.mjs`) — closing the window directly leaves processes behind, use this entry |
| Diagnose | `node runtime/doctor.mjs` — first step when the app won't open |

Guarantees:

- **Duplicate instance**: second start is refused with a clear message
- **Crash recovery**: orphans from a previous crash (force-kill / blue screen / window close) are cleaned up on next start — only processes verified to belong to this project are touched
- **Port conflict**: if :5288/:5289 is held by an external program, startup fails with an explicit error (port + PID + command line) — no silent port switching, no EADDRINUSE crash
- **Unified shutdown**: Ctrl+C / Ctrl+Break / window close all trigger the same cleanup sequence; deletion of `runtime.json` marks a clean shutdown

> Process ownership is decided by command-line verification (PID alive + belongs to this project). Ports are symptoms, never the basis for killing.

## What We Believe

Career decisions are low-frequency, high-impact events — so quality rules are built into every module:

- **No comfort, no false hope** — hard is hard; give "how to start," not "you can do it"
- **Human in the loop** — AI analyzes, you decide; a "don't switch yet" verdict keeps warning in every output, never bypassed
- **Financial constraints are the hardest** — with less than 3 months of runway and family obligations, no quitting without a job
- **If we can't find it, we say so** — every data point carries a source and year; inferences are labeled `[inference]`

Full principles: [docs/PRINCIPLES.md](docs/PRINCIPLES.md).

## Use with Other AI CLIs

All career-advisor skills are plain Markdown, so they can be copied to any CLI that supports agent skills:

```bash
bash scripts/install-to-cli.sh --codex   # copy to Codex skills directory
```

Search-tool support varies by CLI — see the [CLI compatibility matrix](docs/CLI-COMPATIBILITY.md).

## Privacy Notice

Career OS strictly separates **system assets** from **personal career data**:

- **The repository contains**: schemas, templates, workflows, agent definitions, engine and workbench code
- **Your workspace contains** (`workspace/`, gitignored): career history, achievements, evidence, personal decisions, salary goals, interview records

**Never commit your `workspace/` to public repositories.** Your career records are private digital assets that belong only to you, locally. Full data-boundary definition: [ARCHITECTURE.md](ARCHITECTURE.md).

## License

[GNU GPL v3](LICENSE)
