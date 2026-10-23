## Working in a git worktree

Run `git worktree add ../ultimate-preview -b preview`, then `cd ../ultimate-preview`, `pnpm install`, and `pnpm start --no-open` to run that worktree's code. Each project path gets its own default state home (a hash of the path), storage and supervisor locks, first free port from 4747, and Vite cache inside its home; explicit home or port overrides must remain distinct. The global `ultimate` command runs the clone it was linked from, so use `pnpm start` inside the worktree instead.

Start a subagent with `isolate: "worktree"` (the worker default) to give its tools a separate checkout; verify its commits, then `land` them or `discard` the checkout while keeping its branch. For Ultimate itself, `instance start` with `subagent: <child id>` previews that child's code on a free port with a separate temporary home; stop the preview afterwards.

### Main-agent final integration

Coordinator branches started by @ultimate are isolated in their own worktrees by default.
`workspace status` shows its tip and the original checkout's tip.
Read worker reports and diffs; rerun checks only for missing or thin evidence, reported failures, changes crossing
workers, `server/` or `shared/` changes, or surprises in the diff, then land and call `workspace submit`.
The lander is the final gate: it runs every configured check (here `pnpm check`, then `pnpm test`, then `pnpm test:e2e`, sequentially) on the merged result
and reports back, landed or not, with findings.
It fixes small failures when the project configures it to; on success it fast-forwards the branch.
Automatic push stays disabled here (`lander.push` is unset); a push is a separate, explicitly authorized step.
Its progress shows live on the submit tool card, with expandable steps, and its report as an outcome card, both in
the submitting conversation; the source's @lander conversation, pinned in the sidebar's agents group, keeps
the full log and shows as working in the Agents tab while it lands. It runs the `lander` agent
definition: here `.ultimate/agents/lander.md` with `onFailure: fix`, so a conflict or a twice-failing check is
resolved and committed by its model, every check runs again, and only then does it land and push. Talk to it in its
conversation about the queue and recent landings.
`workspace land` is the synchronous alternative: it only fast-forwards, refuses moved or diverged targets, and never
rebases or pushes. Unrelated dirty files in the original checkout block neither.
For `server/` or `shared/` changes, an authorized `restart` works once the running clone is clean at the landed commit.

### Standing permission to push this repository

The top-level agent may commit verified changes and land them, but there is no standing permission to push.
Each push needs the user's explicit authorization for the remote, branch and commits; approval does not cover
future pushes. Permission to edit, commit, merge or land is not permission to push. If a push is needed and not
already explicitly requested, ask through a decision card first.

Push only to this fork's `origin` (`gebeer/ultimate`); never push to `upstream` (`HazAT/ultimate`). Keep automatic
lander push disabled (`lander.push` unset), and do not enable a deployment handoff for a one-time approval.
Land locally, then perform only the approved push separately (for example,
`git -C /home/gbr/work/ai/ultimate push origin main`). `workspace land` never pushes.
Subagents commit and report; only the top-level agent performs an authorized push after verification and integration.

Use normal, non-force pushes only. Remote advancement or a non-fast-forward rejection is normal: fetch, inspect the
incoming log and diff, and merge non-destructively in an isolated workspace, preserving both histories. Rerun checks,
then land locally. Push only if the user's specific authorization covers the resulting range; otherwise ask again. Stop and report ambiguous conflicts,
failing checks, security concerns, or a situation requiring a force push or history rewrite—not ordinary remote
advancement. Do not push secrets or unrelated unverified work.
Push approval does not authorize releases, publishing, deployments, or GitHub issue/PR changes.
