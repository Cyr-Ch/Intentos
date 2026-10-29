---
name: intentos-setup
description: Set up IntentOS for a repository from inside Codex, step by step with checks: connect the IntentOS MCP server, onboard the repository (venv, draft policy, suite, index), mine its business rules with a different model and write them into the policy, load its ticket precedents, and confirm a first run can start. Use when asked to set up, install, connect or onboard IntentOS, or to bring a new repository under it. Not for implementing tickets (use the IntentOS `run` tool) or for mining rules by hand (use intentos-policy-mining).
---

# IntentOS setup

You walk the user through connecting IntentOS to this Codex installation and bringing one repository under it. Do the
checks yourself, ask the user only for what you cannot know, and stop at the first failing step with what to fix.
Say what each step changes before you run it. Never edit `~/.codex/config.toml` by hand: registration goes through
`codex mcp add`.

## What IntentOS is, in one paragraph

IntentOS is a verification and coordination layer for Codex. It indexes a repository into a versioned repository model (symbols,
tests, documents, approved business rules), turns a ticket into a compiled change contract, runs the implementer in
an isolated worktree with coordination hooks, verifies the result independently with hidden tests and invariants, and
merges it through a gate that re-verifies the branch against the main of right now. After setup, the MCP tools
`explain`, `run`, `merge`, `guard`, `status` and `policy` are available in every Codex session.

## What you need from the user

1. The absolute path of the IntentOS checkout (where `bin/intentos.js` and `package.json` are). If unknown, look for
   it (`~/intentos` is the usual place) and confirm.
2. The absolute path of the repository to onboard (a Git checkout with a Python project).
3. The model for mining the rules: one the account can run and **other than the model of this session**, for example
   `gpt-5.6-terra`. Explain why: the model that finds the rules should not be the one that later implements under them.
4. Optional: a GitHub `owner/name` whose closed issues and merged pull requests are the repository's ticket history
   (precedents), and the model Codex should implement with (`INTENTOS_CODEX_MODEL`).

## Steps

### 1. Check the installation

Run, in the IntentOS checkout:

```bash
node --version                      # 22.6 or later (the sources run without a build step)
git --version
npm run -s typecheck                 # clean when the checkout is healthy
ls .intentos/venv/bin/python || npm run setup:python   # creates the venv with pytest and the in-tree mergeguard package
node --disable-warning=ExperimentalWarning bin/intentos.js coordination   # "on: mergeguard at …" means merges and hooks are available
```

If `coordination` says off, run `npm run setup:python` again and show the user the reason it prints.

### 2. Connect the MCP server

```bash
node --disable-warning=ExperimentalWarning bin/intentos.js mcp --print-codex-config
```

It prints one `codex mcp add intentos -- <absolute node> … bin/intentos.js mcp` line. Run it. Then `codex mcp list`
must show `intentos`. The server reads the IntentOS checkout it was started from; a second checkout needs a second
registration under another name. Tell the user the tools become visible in the **next** Codex session and that the
server logs to `.intentos/mcp.log`.

If this session already has the IntentOS tools (`status` answers), skip the registration and say so.

### 3. Onboard the repository

With the tools available: call `status` with the repository path. If it says "not onboarded", call `onboard`
(`install=true`, `run_tests=true`). It creates `.intentos/venvs/<repo-id>` with pytest and the repository's declared
dependencies (never the package itself), writes a **draft** policy `policies/<policy-id>.yaml` with the project's
commands and protected paths, runs the suite once at the base revision, indexes the repository, and mines the raw
candidate list. Poll `status` about every 20 seconds until phase is "done". Report the suite result: if it is red at
base, tell the user which tests fail before anything else is built on it, and that the policy's `pytest_project`
command can `--deselect` a test known to fail at base.

Without the tools (the server was just registered), the same from the shell:

```bash
node --disable-warning=ExperimentalWarning bin/intentos.js onboard <repo>
```

### 4. Mine the business rules with another model and write them into the policy

Call `mine` with the model the user named. IntentOS runs the mining skill in a separate read-only thread with that
model, checks every reference against the repository, runs every test, sends rejections back once, and then writes the
accepted rules straight into the policy file and the hidden tests, as `approved_by: auto:<model>`. Poll `status` until
done. Then tell the user, in these words or close to them: how many rules were written, the policy file path, that any
rule can be edited or removed there, and that an approved rule carries blocking authority on every future run in its
scope. Candidates without a test are left pending; name them.

From the shell: `node --disable-warning=ExperimentalWarning bin/intentos.js mine <repo> --model <slug> --approve`.

### 5. Load the ticket history (optional)

If the user gave a GitHub repository for issues:

```bash
node --disable-warning=ExperimentalWarning bin/intentos.js precedents sync <repo> --issues <owner/name> [--pulls <owner/name>]
node --disable-warning=ExperimentalWarning bin/intentos.js index <repo>
```

It needs the `gh` CLI logged in and the merge commits in the local history. Precedents are evidence, never policy.

### 6. Confirm a first run can start

Call `explain` with a one-sentence task the user suggests; show the evidence pack's reusable symbols, bound invariants
and precedents. Then say that `run` implements a ticket, `status` reports its verification, `merge` lands it with the
approver names the user gives, and `guard` handles a red main. Do not start a run unless the user asks.

Set the implementer model for future sessions if the user named one: tell them to export `INTENTOS_CODEX_MODEL=<slug>`
in the shell that starts Codex (or in the MCP server's environment); never write it into their config files yourself.

## Checklist to report at the end

- IntentOS checkout path, node version, `coordination` on or off
- MCP server registered as `intentos` (or already present)
- repository onboarded: policy file, suite result at base, index revision
- rules written: count, file, pending-without-test names
- precedents loaded: count, or skipped
- what the user does next: `run` a ticket, or edit the policy
