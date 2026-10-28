# IntentOS agent skills and settings — approved design

## Intent and scope

The local dashboard should let a repository lead inspect and change the instructions IntentOS gives its own Codex threads. The page should make clear that IntentOS starts four role-specific SDK threads: a read-only planner, a worktree-writing implementer, a read-only policy miner, and a read-only acceptance-test author. The two shipped Codex host skills (`intentos-setup` and `intentos-policy-mining`) are a separate mechanism; the page may show them, but must not imply that the implementer automatically reads them.

## Approaches

1. **Edit installed host Codex skills.** Small change, but it does not configure the SDK threads started by `intentos run`. It also changes skills outside the selected IntentOS home. This does not meet the requested workflow.
2. **IntentOS-managed role skills and agent settings (recommended).** Store text instructions and role assignments in the selected `INTENTOS_HOME`. IntentOS explicitly includes enabled instructions when it starts each role and records their versions with the run. More implementation work, but the UI controls the agents users actually see.

## Proposed behavior

- Add **Skills** to the dashboard sidebar. Show four role cards with purpose, sandbox mode, model, reasoning effort, and assigned skills. Sandbox mode is informational and cannot be relaxed from this page.
- Show shipped host skills in a separate read-only section with their source and purpose. Do not edit the plugin installation from the dashboard.
- Let the user create, edit, enable, disable, and assign local text skills. A skill has a unique slug, title, description, and Markdown instructions. It contains instructions, not executable code or shell hooks.
- Let the user set the model and reasoning effort for each role. Defaults inherit the current IntentOS environment; the demo remains on `gpt-6-luna` unless explicitly changed. The miner and acceptance-test author must use a model other than the implementer.
- Changes apply to new jobs. Each run records the effective role settings, skill text hashes, and enabled skill names before the first thread starts. A resumed run uses that frozen configuration.
- Existing contracts, protected paths, verifier checks, merge approvals, network restrictions, and repair limits remain authoritative. A skill may guide the agent's work but cannot change these controls.

## Storage and integration

- Store a validated versioned JSON configuration under `INTENTOS_HOME`, plus local Markdown skill files under `INTENTOS_HOME/agent-skills/`. Use atomic writes and reject path traversal, duplicate slugs, oversized text, and invalid role/model settings.
- Preserve the agent configuration and local skills when the disposable demo snapshot is restored; resetting runs must not erase user preferences.
- Expose same-origin local dashboard APIs for listing and editing these settings. The current dashboard's localhost and POST guards apply.
- Load and freeze settings at job creation. The planner, implementer, miner, and acceptance prompt builders append only their assigned skill instructions in a clearly labelled trusted section. Separate role settings select the SDK model and reasoning effort. Explicit CLI options take precedence where those commands already offer them.
- Show the effective configuration in run details so a reviewer can tell which model and skill versions produced an artifact.

## Non-goals and risks

- This page does not install arbitrary third-party skills, run user-supplied scripts, edit global Codex settings, or create new agent roles.
- Custom instructions can change model behavior, including policy-mining output. Tests and policy validation still gate outputs. The page should say that newly configured skills affect future runs only.
- There is no hosted multi-user access or permission model; the dashboard stays bound to localhost.

## Verification

- Unit checks for schema, storage, role assignment, path and size validation, and precedence.
- Integration checks that each role receives only its assigned skill text, separate models are used, and a resumed run retains its frozen configuration after an edit.
- Local dashboard check for creating a skill, assigning it, changing a role setting, and seeing the effective configuration on a new run without spending model tokens.
