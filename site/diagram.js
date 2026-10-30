(() => {
  const canvas = document.querySelector('#diagramCanvas');
  const dialog = document.querySelector('#diagramDetail');
  if (!canvas || !dialog || typeof dialog.showModal !== 'function') return;

  // Coordinates follow the unchanged 1280 × 604 architecture SVG.
  const tiles = [
    {
      id: 'setup', title: 'Set up IntentOS', group: 'People · Repository owner', rect: [132, 78, 128, 64],
      what: 'A Codex skill called intentos-setup: written instructions that guide Codex through the local IntentOS tools.',
      does: 'Checks the local setup, onboards the repository, mines candidate rules, and helps run a first ticket.',
      why: 'An agent needs context about the codebase before it starts changing it. Setup gathers that context and gives the team a first workflow to inspect.'
    },
    {
      id: 'policy-review', title: 'Review the rules', group: 'People · Optional policy review', rect: [416, 78, 128, 64],
      what: 'An optional local web screen for reviewing proposed rules, their sources, and their tests.',
      does: 'Lets a person edit, approve, reject, or combine rules before they guide future changes. The automatic path can also admit candidates that pass its checks.',
      why: 'A passing test confirms current behavior, but the team may want that behavior to change. Human review helps resolve that business decision.'
    },
    {
      id: 'ticket', title: 'Clarify the ticket', group: 'People · Current requirements', rect: [558, 78, 128, 64],
      what: 'The team’s change request, with a clarification step for missing or conflicting requirements.',
      does: 'Fills gaps from repository evidence where possible and asks a person about unresolved business decisions. Blocking questions pause implementation.',
      why: 'The codebase describes what exists today; a ticket may ask for something different. Resolving that difference early avoids building the wrong change.'
    },
    {
      id: 'approvers', title: 'Approve this exact change', group: 'People · Merge review', rect: [984, 78, 128, 64],
      what: 'Human review decisions recorded against an exact Git commit.',
      does: 'Requires zero, one, or two independent reviewers according to policy. Any new commit invalidates the previous approvals.',
      why: 'A reviewer’s approval should apply to the code they actually saw. This prevents an older approval from covering later, unreviewed edits.'
    },
    {
      id: 'undo-pr', title: 'Review a validated undo PR', group: 'People · Recovery', rect: [1126, 78, 128, 64],
      what: 'A proposed revert PR, prepared by the guardian and tested against current main.',
      does: 'Offers a way to undo the change identified as the cause of a repeatable failure. It still needs to pass the review gate before merging.',
      why: 'When main breaks, the team needs a checked recovery option quickly. A tested undo can restore working code while the team decides on a lasting fix.'
    },
    {
      id: 'onboard', title: 'Onboard', group: 'IntentOS · Learn the repository', rect: [132, 226, 128, 100],
      what: 'A repository setup command implemented in TypeScript with Python helpers.',
      does: 'Detects the project structure, prepares its test environment, and records an initial test run. It creates a repository index and a draft policy, ready for business rules to be added.',
      why: 'Agents need a map of what already exists, and reviewers need to know the starting state. Onboarding records both at a specific commit.'
    },
    {
      id: 'mine', title: 'Mine repository intent', group: 'IntentOS · Learn the repository', rect: [274, 226, 128, 100],
      what: 'A rule-mining workflow: a Codex skill plus code that validates the model’s proposals.',
      does: 'Reads tests, commits, documentation, and past tickets to propose rules with sources and tests. IntentOS checks those references and runs the tests before admitting a rule.',
      why: 'Important constraints are often scattered across old fixes and tests. Mining makes them explicit so agents and reviewers can use them in the next change.'
    },
    {
      id: 'policy', title: 'Establish the policy', group: 'IntentOS · Rules for future changes', rect: [416, 226, 128, 100],
      what: 'A policy-loading and validation step in TypeScript. Its rules live in a YAML file the team can inspect.',
      does: 'Makes applicable business and architecture rules binding in the change contract. The same rules tell the verifier what to check.',
      why: 'A rule should still apply when the planning model overlooks it. A shared policy keeps planning and verification aligned on what the change must preserve.'
    },
    {
      id: 'contract', title: 'Compile the change contract', group: 'IntentOS · Every ticket', rect: [558, 226, 128, 100],
      what: 'A JSON change contract, proposed by a planning model and validated by TypeScript code.',
      does: 'Defines the requirements, relevant evidence, files the agent may change, and checks it must pass. The compiler adds required policy rules and stops unresolved business questions from reaching implementation.',
      why: 'The ticket alone may leave scope and expectations unclear. An explicit contract gives the coding agent and reviewer the same definition of the requested change.'
    },
    {
      id: 'implement', title: 'Implement with context', group: 'IntentOS · Every ticket', rect: [700, 226, 128, 100],
      what: 'A coding session in a Git worktree, a separate working copy of the repository, with coordination hooks.',
      does: 'Gives the agent the validated contract and reports relevant changes that reach main while it works. A final check can require it to sync before finishing.',
      why: 'Parallel changes can make an agent’s assumptions stale mid-task. Keeping it aware of main helps it adapt; unfinished work on other branches is outside this view.'
    },
    {
      id: 'verify', title: 'Verify independently', group: 'IntentOS · Every ticket', rect: [842, 226, 128, 100],
      what: 'A TypeScript verification function, separate from the coding agent. It produces a JSON report of executed checks and their results.',
      does: 'Runs project tests, separate tests for the ticket and business rules, and checks scope and architecture. Blocking failures return to the agent for up to two repairs.',
      why: 'Project tests can pass while a business rule breaks. Reviewers need the independent results, links to the rules, and a clear account of what remains unchecked.'
    },
    {
      id: 'merge', title: 'Verify the merged result', group: 'IntentOS · Main', rect: [984, 226, 128, 100],
      what: 'A merge gate implemented in TypeScript and Python, using a temporary Git worktree to test the combined code.',
      does: 'Checks approvals and combines the proposed change with current main. It runs the required checks on that result and blocks the merge if they fail.',
      why: 'Two changes can pass on their own and fail together. Testing their combination catches problems that checking each branch separately misses.'
    },
    {
      id: 'guard', title: 'Investigate and recover', group: 'IntentOS · Main', rect: [1126, 226, 128, 100],
      what: 'A recovery routine written in Python that uses tests and Git history to investigate broken main.',
      does: 'Confirms the failure, searches for the commit or interaction that caused it, and tests a proposed undo PR. It records the incident and leaves the undo for review.',
      why: 'Failures can escape the checks before merge. The team needs evidence of what broke and a tested recovery option without retracing every recent change by hand.'
    },
    {
      id: 'mining-model', title: 'The mining model', group: 'Models · Propose rules', rect: [274, 396, 128, 76],
      what: 'A separate, read-only Codex session following the intentos-policy-mining skill, with a model chosen by the user.',
      does: 'Reads repository evidence and proposes business rules with source references and tests. IntentOS code validates each proposal before it can enter the policy.',
      why: 'Interpreting old fixes and documentation needs reasoning about their purpose. A separate model can provide another reading, while the proposals remain open to checks and human review.'
    },
    {
      id: 'planner', title: 'Triage and planning', group: 'Models · Read-only threads', rect: [558, 396, 128, 76],
      what: 'Read-only Codex sessions for clarifying a ticket and proposing its JSON change contract.',
      does: 'Uses relevant code, rules, tests, and past tickets to fill gaps and plan the work. It returns questions when the team needs to make a decision.',
      why: 'An unclear request can lead to unnecessary or incorrect code. Planning first gives the team a chance to resolve intent before implementation starts.'
    },
    {
      id: 'implementer', title: 'The implementer', group: 'Models · Write the change', rect: [700, 396, 128, 76],
      what: 'A Codex coding agent with write access to the task’s working copy of the repository.',
      does: 'Implements the contract using the supplied context, tests its edits, and responds to independent verification findings. Coordination notes keep it aware of relevant changes on main.',
      why: 'The coding agent needs business context and clear boundaries to produce the intended change. Keeping verification separate gives reviewers evidence beyond its own assessment.'
    },
    {
      id: 'deterministic', title: 'Checks decide the result', group: 'Verification, merge, and recovery', rect: [842, 396, 412, 76],
      what: 'The verification, merge, and recovery stages are TypeScript and Python routines that run without a model.',
      does: 'Apply configured tests and policy rules to decide whether a change passes, needs review, or fails. Recovery uses repeated tests and Git history to investigate failures.',
      why: 'Review decisions need reproducible checks with recorded results. Those results establish only what the configured checks cover.'
    },
    {
      id: 'trusted-state', title: 'Trusted state', group: 'Stored outside the target repository', rect: [124, 494, 1148, 24],
      what: 'A SQLite database and supporting YAML, JSON, and test files stored outside the coding agent’s worktree.',
      does: 'Keeps the repository index, rules, independent tests, past decisions, and merge history available across tasks. Each stage reads the context it needs.',
      why: 'A new ticket should not start from an empty memory. Shared records also let reviewers trace which rules and evidence guided a change.'
    },
    {
      id: 'repository-model', title: 'Repository model at a commit', group: 'Trusted state · Repository knowledge', rect: [138, 522, 176, 20],
      what: 'A SQLite index of code, tests, documents, and their relationships, tied to a specific Git commit.',
      does: 'Finds relevant components, rules, and past decisions for a ticket, with references back to their sources.',
      why: 'Agents and reviewers need to find relevant context without rediscovering the whole codebase. Tying it to a commit makes clear which version the evidence describes.'
    },
    {
      id: 'policy-data', title: 'Policy rules and decisions', group: 'Trusted state · Policy YAML', rect: [322, 522, 359, 20],
      what: 'A YAML configuration file containing business rules, architecture constraints, decisions, and allowed checks.',
      does: 'Links rules to their sources and tells planning and verification which expectations are binding. Source conflicts can be surfaced for a person to resolve.',
      why: 'Rules buried in documents and old fixes are easy to miss. A shared, inspectable file makes those expectations explicit for both agents and reviewers.'
    },
    {
      id: 'hidden-tests', title: 'Independent tests', group: 'Trusted state · Hidden tests', rect: [689, 522, 91, 20],
      what: 'Executable test files for the ticket and existing business rules, stored outside the coding worktree. Separate storage alone does not guarantee the agent cannot read them.',
      does: 'Run against a copy of the candidate code to check the requested behavior and the rules it must preserve. Failures become specific findings for repair and review.',
      why: 'The project suite may not cover the business behavior at risk. Separate tests add checks that the implementer does not choose for itself.'
    },
    {
      id: 'precedents', title: 'Past tickets and their fixes', group: 'Trusted state · Precedents', rect: [788, 522, 176, 20],
      what: 'JSON records of resolved tickets and their merged PRs, linked into the repository index.',
      does: 'Connects each resolution to the code and tests it changed, then retrieves relevant examples for new tickets. History that no longer matches the code is marked stale.',
      why: 'Similar work may already be solved, or an old fix may explain a surprising constraint. This history helps avoid repeating work while leaving today’s requirements open to change.'
    },
    {
      id: 'ledger', title: 'The merge ledger', group: 'Trusted state · Integration history', rect: [972, 522, 91, 20],
      what: 'A JSONL event log: one JSON record per line, recording merges, coordination events, and incidents.',
      does: 'Links events to commits and affected files so later runs can use them. Repeated failures can raise a folder’s review requirements; lowering them needs a person.',
      why: 'Parallel work is harder to understand when its history is scattered across agent sessions. A shared log helps trace failures and carry lessons into later reviews.'
    }
  ];

  const image = canvas.querySelector('.diagram-image');
  const spotlight = image.cloneNode();
  spotlight.className = 'diagram-spotlight';
  spotlight.alt = '';
  spotlight.setAttribute('aria-hidden', 'true');
  canvas.append(spotlight);

  const hotspots = document.createElement('div');
  hotspots.className = 'diagram-hotspots';
  hotspots.setAttribute('role', 'group');
  hotspots.setAttribute('aria-label', 'Explore each architecture tile');
  canvas.append(hotspots);

  const title = dialog.querySelector('#diagramDetailTitle');
  const group = dialog.querySelector('#diagramDetailGroup');
  const body = dialog.querySelector('#diagramDetailBody');
  const closeButton = dialog.querySelector('.diagram-close');
  let selectedButton = null;
  let pointerStartedOutside = false;

  function positionDialog() {
    if (!dialog.open || !selectedButton) return;
    const target = selectedButton.getBoundingClientRect();
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    const margin = 16;
    const gap = 20;
    let left = (window.innerWidth - width) / 2;
    let top = (window.innerHeight - height) / 2;
    if (window.innerWidth > 640) {
      if (target.right + gap + width <= window.innerWidth - margin) left = target.right + gap;
      else if (target.left - gap - width >= margin) left = target.left - gap - width;
      top = target.top + target.height / 2 - height / 2;
    }
    dialog.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`;
    dialog.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
  }

  function openDetail(tile, button) {
    selectedButton = button;
    title.textContent = tile.title;
    group.textContent = tile.group;
    body.replaceChildren();
    for (const [key, label] of [['what', 'What it is'], ['does', 'What it does'], ['why', 'Why we need it']]) {
      const box = document.createElement('section');
      box.className = `diagram-detail-box diagram-detail-box--${key}`;
      const heading = document.createElement('h3');
      heading.textContent = label;
      const copy = document.createElement('p');
      copy.textContent = tile[key];
      if (key === 'what') copy.id = 'diagramDetailWhat';
      box.append(heading, copy);
      body.append(box);
    }

    const [x, y, width, height] = tile.rect;
    canvas.style.setProperty('--diagram-spotlight', `inset(${y / 604 * 100}% ${(1280 - x - width) / 1280 * 100}% ${(604 - y - height) / 604 * 100}% ${x / 1280 * 100}% round 6px)`);
    canvas.classList.add('is-inspecting');
    button.classList.add('is-active');
    button.setAttribute('aria-expanded', 'true');
    document.body.classList.add('diagram-detail-open');
    dialog.showModal();
    body.scrollTop = 0;
    positionDialog();
    closeButton.focus({ preventScroll: true });
  }

  for (const tile of tiles) {
    const [x, y, width, height] = tile.rect;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diagram-hotspot';
    if (height <= 24) button.classList.add('diagram-hotspot--small');
    button.dataset.tile = tile.id;
    button.setAttribute('aria-label', `${tile.title}: details`);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', dialog.id);
    button.setAttribute('aria-expanded', 'false');
    button.title = `${tile.title} — click for details`;
    Object.assign(button.style, { left: `${x / 1280 * 100}%`, top: `${y / 604 * 100}%`, width: `${width / 1280 * 100}%`, height: `${height / 604 * 100}%` });
    button.addEventListener('click', () => openDetail(tile, button));
    hotspots.append(button);
  }

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('diagram-detail-open');
    canvas.classList.remove('is-inspecting');
    if (selectedButton) {
      selectedButton.classList.remove('is-active');
      selectedButton.setAttribute('aria-expanded', 'false');
      selectedButton.focus({ preventScroll: true });
    }
    selectedButton = null;
    pointerStartedOutside = false;
  });

  function outsideDialog(event) {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  dialog.addEventListener('pointerdown', event => { pointerStartedOutside = event.target === dialog && outsideDialog(event); });
  dialog.addEventListener('pointerup', event => {
    if (pointerStartedOutside && event.target === dialog && outsideDialog(event)) dialog.close();
    pointerStartedOutside = false;
  });
  dialog.addEventListener('pointercancel', () => { pointerStartedOutside = false; });
  window.addEventListener('resize', positionDialog);
  window.visualViewport?.addEventListener('resize', positionDialog);
  document.querySelector('#diagramInteractionHint').hidden = false;
})();
