# gitq: the road from 7 to 10 — full campaign

## Context

Matt asked what gitq would need to become a 10 ("essential — without it we'd
be lost") and chose to build everything feasible. Today's rating was a 7: the
core model (blame-based absorb, leased cascades, the pause protocol) proved
itself on a 19-branch stack, but the tool broke on its own use case
(out-of-band rewrite desyncing sync), failed *silently* (diagnose reported
healthy), and recovery required reading the implementation.

A capability survey of the codebase (2026-08-22) turned the intuition into
facts, including one large one: **the merge lifecycle is dead code**. Nothing
in a shipped path ever sets `status: 'merged'` — `populateNodeData`,
`syncStack`, `newlyMerged`, `detectDeletedBranches`, and the tombstone
`cascadeRebase` all have zero production callers, so the drift-reconciliation
machinery the sync cascade carries for merged parents can never fire. The
whole point of stacked MRs is the merge cycle; gitq currently handles it as
three manual steps with its best machinery unreachable.

Organizing principle for "10": (a) never lie about state, (b) no failure ever
requires expert knowledge to recover, (c) own the full stacked-MR lifecycle
end to end, so losing the tool would mean rebuilding a workflow.

Already shipped today (counts toward the 10, listed so nobody re-plans it):
out-of-band rewrite recovery + skip-time head refresh (`a5ea9da`), paused-lease
conflict detail + diagnose dead-stack collapse (`b42ae32`), scoped
`absorb --at <branch>:<glob>` (`06bfe3b`).

All paths below are in `/Users/matt/Documents/GitHub/gitq` unless noted.

## Cross-cutting constraint: forge access goes rt-daemon-first (Matt, 2026-08-22)

Every forge call routes through the rt daemon when it can answer, and falls
back to direct glance (`@mattstack/glance`) when it cannot. The pattern
already exists in exactly one place — `fetchMrsByBranch` in
`src/server/data.ts:218-249`: rt's project-mrs store first (rt-client
`readMrsByBranch`, keyed by `repoNameForPath`), and a **memoized provider
thunk** for the glance fallback so a repo the store fully answers never
builds a forge client or reads a token. Not-ok from the store (grant error,
daemon unreachable, malformed) falls through undistinguished.

Apply it campaign-wide:
- **Promote the pattern to core.** Move `fetchMrsByBranch` + `resolveRtRepo`
  out of `src/server/data.ts` into a new `src/core/forge-read.ts`; the board
  imports it from there. Phase B's sync reconciliation, A3's forge-aware
  diagnose, and C3's doctor mrIid checks all consume this one function —
  none of them builds its own provider directly.
- **Reads**: rt daemon first, glance fallback — the daemon caches and
  multiplexes forge data across Matt's concurrent agents, so daemon-first
  also keeps a herd of syncing agents from hammering the GitLab API.
- **Writes** (publish create/update/retarget): rt-client exposes no write
  surface (`readProjectMRs`/`readDiscussions`/`readMrsByBranch`/
  `resolveForgeToken` only), so writes stay direct glance — but the token
  keeps resolving daemon-first via `resolveForgeToken`
  (`src/core/secrets.ts:1`), which is already the shipped behavior.
- **Offline discipline is unchanged**: `--no-fetch` skips both the daemon
  read and the glance fallback; daemon-down plus no-token degrades to
  today's behavior with one warning line.

---

## Phase B — Wire the merge lifecycle (the indispensability gap; do first)

**Why first:** it's the difference between "helps me restack" and "owns the
workflow". Everything needed already exists as prototype code; the work is
wiring, hardening, and testing it.

**Matt's rulings (2026-08-22):**
- Reconciliation lives **inside `gitq sync`**, riding the fetch it already
  does. `--no-fetch` skips forge contact entirely; a new `--no-forge` skips
  only the API phase (git fetch yes, forge no — the exact GitLab-IP-block
  scenario). No token / forge failure degrades to today's behavior with one
  warning line.
- Merged tombstone nodes are **auto-removed after a clean cascade**.
  Mechanically this is a splice, not a bare remove: `StackManager.removeNode`
  (`stack-manager.ts:111-128`) refuses nodes with children, and a tombstone
  is mid-stack by definition — so sync reparents the children onto the
  tombstone's parent in the store, then removes the node. Safe because it
  runs only after a clean cascade, when every child is already rebased onto
  `resolveLiveTarget` (which skips merged nodes), so the store splice matches
  what git already looks like. A paused/failed cascade leaves the tombstone
  in place (its ref is still needed for drift reconciliation). The removal
  is reported in sync's output and recorded in the operation log.
- Retargeting (design ruling): **sync retargets child MRs itself**, reusing
  `retargetMR`, but ONLY when the MR's current forge target is a node now
  `merged` in this stack — that case is never a deliberate restructure.
  General drift stays with `gitq publish`. Runs after the cascade completes
  cleanly; failures are warnings, never exit-code changes; the rule is
  idempotent so a pause→continue run that skipped it is repaired by the
  next sync. Retargeting must precede the tombstone splice (the stale-target
  rule reads merged nodes; splice them first and the rule can't see them).

**B-extra: publish must not clobber hand-written MR descriptions.**
Survey §2: with `--mr-meta` naming a branch, publish blindly overwrites the
forge description; there is no hand-edit detection and no stored body. Store
a hash of the last body gitq itself published on the node
(`src/core/types.ts` StackNode + `forge-sync.ts:395-522`); before updating,
read the current forge body — if it differs from the last-published hash,
refuse with the diff pointer unless `--force-meta`. Closes the standing
memory rule "never gitq publish over hand-written MR descriptions" at the
tool level instead of by agent discipline.

**Prototype defects to fix while wiring** (found by design review; each gets a
regression test):
1. `syncStack`'s fetch is wrong-shaped (`forge-sync.ts:623`): instance-wide
   involved-MR listing, client-filtered — unbounded on GitLab "merged".
   Replace with scoped calls: iid fetch for nodes with `mrIid`, by-branch
   fetch for adoption.
2. `syncStack` never passes `cwd` to `populateNodeData` (`forge-sync.ts:628`),
   so tombstone `lastKnownHead` can only come from `pr.sha`, never the local
   branch head the cascade prefers.
3. `populateNodeData` computes drift against the raw parent
   (`forge-sync.ts:252-254`): a child whose MR the forge auto-retargeted to
   main after its parent merged gets misclassified `drift`. Compare against
   `resolveLiveTarget` (mirror publish `:513`) and iterate in toposort order
   so a parent's just-written `merged` is visible to its child.
4. No closed-MR guard and no iid↔sourceBranch cross-check in
   `populateNodeData` (publish has one at `:503-511`). Add both.
5. `detectSyncChanges` reports vanished MRs only for `synced` nodes
   (`forge-sync.ts:755`); widen to `synced | drift`.
6. Merged parent with deleted local branch and null `lastKnownHead`:
   `resolveBase` falls to `getBranchHead(parent)` → throws → silent skip.
   Populate storing `pr.sha` mostly prevents it; the residual case must fail
   per-branch with a named error, never silently.
7. `cascadeRebase` (`rebase-engine.ts:995`): mark `@deprecated` pointing at
   `syncLocalStack`; its resolvers subsume it.

**Step list** (adapted from the design to the rt-daemon-first constraint):

1. **Core read path**: promote `fetchMrsByBranch`/`resolveRtRepo` from
   `src/server/data.ts` to `src/core/forge-read.ts` (cross-cutting
   constraint above). Reconciliation reads through it: rt daemon
   `readMrsByBranch` over all node branches first; any node with an `mrIid`
   still unresolved (branch deleted after merge — the daemon's by-branch view
   can miss it) gets a supplemental glance iid fetch; full glance fallback
   (byBranches + iids, project-scoped) when the daemon is unreachable.
2. **Core**: replace dead `syncStack` with `ForgeSync.reconcileStack(provider,
   stack, scope, cwd)` returning `{ updatedStack, newlyMerged, adopted,
   deletedBranches, pipelineChanges, staleTargets }`. Pure read of the forge;
   returns, never persists. Keep `populateNodeData` as the shared populate
   pass with defects 2-4 fixed (import uses it too).
3. **Core**: `retargetStaleTargets(provider, stack, staleTargets,
   projectPath)` — loops `retargetMR`, collects per-branch failures instead
   of throwing.
4. **CLI** (`src/cli/commands/cascade.ts` syncCommand, inside the existing
   lease + op-log wrappers): reconcile → **persist reconciled stack via
   `updateStore` BEFORE the cascade** (merged statuses describe forge
   reality and must survive a pause/abort; the cascade's `resolveBase` reads
   them from the stack passed in) → `syncLocalStack` → `finishCascade` → on
   clean completion: retarget staleTargets, then tombstone splice+remove,
   `updateStore` again, report. JSON output extended additively only
   (`forge: { newlyMerged, adopted, deletedBranches, retargeted, pruned,
   warnings } | null`) — the sync skill and board parse existing keys.
5. **CLI surface** (`src/cli/main.ts`): register `no-fetch` and `no-forge`
   as explicit booleans (today `--no-fetch` only parses because
   `strict: false`); update usage line; docs (`sync.mdx` flags + degradation
   matrix, `concepts/cascade.mdx` drops the "3 manual steps" narrative).
6. **`gitq continue`** stays offline-safe by design (no provider in hand);
   deferred retarget/prune is repaired by the next sync — document.
7. **Tests**: unit (extend `mockProvider` for scoped fetches; adoption,
   merged-by-iid transition, closed-MR guard, iid↔branch guard, defect-3
   regression, tombstone local-head-vs-pr.sha, staleTargets merged-only
   rule, vanished-MR for drift nodes) and integration (sandbox remote +
   provider mocked at the `src/cli/provider.ts` seam with module-restore
   hygiene): full lifecycle squash-merge → sync → child rebased over
   tombstone → store merged → MR retargeted → tombstone spliced; merge-commit
   and rebase-merge variants; merged+branch-deleted; no-token degradation
   (exit 0, restack runs, provider never constructed under
   `--no-fetch`/`--no-forge`); pause-after-reconcile → continue → second
   sync repairs retarget.
8. **Compat**: store schema unchanged; board keeps its read-time overlay and
   converges faster; `SyncResult`/`syncStack` removal is internal (no
   production callers); live-forge tests migrate to `reconcileStack`.

**Failure-mode matrix** (acceptance contract): no token → warn + local
restack, exit unchanged; forge 5xx/timeout → same; `--no-fetch` → no daemon
read, no glance; MR merged + branch deleted → merged via iid, tombstone from
`pr.sha`, unfetchable sha fails per-branch by name; closed-unmerged MR never
upgrades status; squash/merge-commit/rebase-merge all replay via tombstone
`--onto` with patch-id drops; retarget write failure → warning + listed,
publish is the backstop.

Known facts the implementation must respect:
- `populateNodeData` (`forge-sync.ts:243-278`) writes `mrIid` by
  source-branch match and sets `merged` — treat as prototype, verify against
  current `StackNode` types before wiring.
- `gitq import` fetches OPEN MRs only (`forge-sync.ts:323-336`), so it can
  never produce `merged` either; that gap closes with this phase.
- The board already detects merges read-time via `liveMrStates`
  (`src/server/data.ts:380-387`); after this phase the CLI and store agree
  with what the board shows.
- This also fixes the standing memory item "gitq: adopting existing MRs —
  backfill mrIid by hand": source-branch adoption becomes a shipped path.

## Phase A — Never lie about state (trust)

**A1. A `store-desynced` situation in diagnose.**
`Situation` union (`src/core/stack-diagnostics.ts:39-52`) has no "store
disagrees with git" member. Add one: when a node's `lastKnownHead` is set,
resolvable, and differs from the live branch head, report
`store-desynced` (badge `Stale record`, primary action `sync-stack` — sync
now heals it via the skip-time catch-up at `rebase-engine.ts:580-590`).
Priority: below `rebase-in-progress`, above `behind-parent`. This is exactly
the situation that cost an hour on 2026-08-22 while diagnose said healthy.
- Files: `src/core/stack-diagnostics.ts` (situation, classification,
  priority order), `src/cli/commands/diagnose.ts` (no change needed to
  render), `website/docs/getting-started/reading-the-tree.mdx` (the
  situations table), tests in `tests/integration/stack-diagnostics.test.ts`.

**A2. Sync narrates its silent repairs.**
The skip-time head catch-up and the `rewrittenParentHead` recovery
(`rebase-engine.ts:400-425, 580-590`) currently happen silently. Surface one
line per event in the cascade output ("caught up recorded head for <branch>",
"recovered fork point for <branch> from its recorded head") so the human
learns the store had drifted. Plumb through `CascadeResult` (add a
`repairs: string[]`), print in `finishCascade` (`src/cli/commands/cascade.ts`).

**A3. Forge-aware diagnose.**
`diagnoseCommand` calls `diagnoseStack(snapshot, stack)` with no
`liveMrStates` (`src/cli/commands/diagnose.ts:14`), so the CLI cannot see a
merged MR the board can. Add best-effort forge fetch (reuse the board's
`fetchMrsByBranch`, `src/server/data.ts:220-247` — move it to core), behind
graceful offline degradation: no token / network failure → current behavior
plus one stderr note. Depends on Phase B landing first (shared fetch path).

**A4. Store read/write integrity.**
`loadStore` is unlocked and its legacy-migration path writes outside any lock
(`src/core/persistence.ts:52-91`). Take the same `withFileLock` for reads
that migrate, and make plain reads retry-on-parse-error (a read racing the
tmp+rename write can't see a torn file, but the migration write can race
another process). Small, surgical.

## Phase C — No expert-mode recovery (resilience)

**C1. Write-ahead operation log.**
`absorb`/`split`/`fold`/`rename` log only on exit 0 (`src/cli/op-log.ts:43`),
so a failed absorb whose commit phase already landed leaves NO record and no
undo — documented as a known hazard (`website/docs/reference/other/undo.mdx:34`).
Restructure: write the entry (with branch snapshots) BEFORE the mutation,
mark it completed/failed after. Undo can then restore a half-landed absorb.
- Files: `src/cli/op-log.ts`, `src/core/operation-log.ts` (entry status
  field), `src/cli/commands/undo.ts` (accept failed entries), migration for
  existing log files (additive field, old entries read as completed).

**C2. Undo coverage for the refused verbs.**
`split`, `fold`, `rename` are logged but `canUndo` refuses them
(`src/cli/commands/undo.ts:44`; `REVERSIBLE_OPERATIONS`,
`src/core/undo.ts:17-22`). Each needs an inverse rather than blind snapshot
restore:
- `rename`: rename back (snapshot has the old name; the new branch exists).
- `split`: delete the created branch, restore the source tip from snapshot.
- `fold`: recreate the folded branch at its snapshot SHA, restore the parent.
Also: `reset`, `track/untrack/add/remove` are never logged at all
(`src/cli/commands/crud.ts` has no OperationLog import) — log them for the
audit trail even where undo stays unsupported; `publish`/`push` get
audit-only entries (undoing a forge write is out of scope).

**C3. `gitq doctor`.**
One command that checks every invariant the store can violate against git and
the forge, reports each violation with its concrete heal, and applies them
under `--fix`: stale `lastKnownHead` (heal: refresh), node branch missing
locally (heal: mark or remove), mrIid pointing at a closed/missing MR (heal:
re-adopt by source branch — Phase B's machinery), forkPoint GC'd (heal:
clear), orphaned leases/pause files (heal: release). Doctor is the "I don't
know what's wrong" front door that would have replaced hand-driving
`rebase --onto` from the state file.
- New `src/cli/commands/doctor.ts`, checks live in `src/core/` next to the
  state they verify; reuse `validateTombstone`, `pausedDetail`, lease listing.

## Phase D — Single-shot visibility: `gitq status`

No command answers "where am I and what should I do": pause state is
invisible outside `continue`/`abort` failures, dirty files are booleans only,
suggested actions exist only in `diagnose --json` (`primaryAction`,
`src/core/stack-diagnostics.ts:62-63`). Add `gitq status`:
current worktree + branch + owning stack; any parked/running lease with the
pause detail (reuse `pausedDetail`, `src/cli/slots.ts:29`); dirty file list;
per-node one-liner with the primaryAction verb; one "next:" line. Compose
from existing pieces (`collectSnapshot`, `diagnoseStack`, `listLeases`,
`readPause`) — no new state.
- New `src/cli/commands/status.ts`, register in `src/cli/main.ts` COMMANDS,
  docs page, docs-coverage test will enforce the page exists.

## Phase E — Multi-writer and agent safety

**E1. Lease coverage for store-mutating crud.**
`requireStackFree` guards cascade/surgery verbs but `add`/`remove`/`track`/
`untrack` mutate the store unguarded. Add the same guard (they're cheap
metadata writes, but a remove racing a cascade's updateStore is last-write-
wins on the stack subtree — survey §6).

**E2. Ref-fence on store writes.**
Record per-node live head at store write time (already `lastKnownHead` for
cascades; extend to crud writes). With A1's `store-desynced` situation this
turns any raw-git mutation into a visible, diagnosable event instead of a
latent trap. (No git hooks, no watching — just honest bookkeeping.)

## Phase F — Conflict ergonomics

**F1. `gitq preflight --verbose`: show predicted conflict content.**
Prediction keeps only `{file, type}` (`rebase-engine.ts:180-189`) though
`mergeTreeDryRun` has the full merge-tree output. Under `--verbose`, print
the conflicted hunks per predicted file so resolution can be planned before
the cascade starts.

**F2. Pause output points at content.**
On pause, print the first N conflict-marker lines per file (bounded), and
under `--json` include ours/theirs blob SHAs. The agent skills already read
markers themselves; this makes the human path equally direct.

---

## Sequencing and sessions

1. **Session 1 — Phase B** (merge lifecycle). Largest, highest leverage,
   unlocks A3 and part of C3.
2. **Session 2 — Phase A** (A1, A2, A4 independent of B; A3 after B).
3. **Session 3 — Phase C** (C1 WAL first, then C2 inverses, then C3 doctor —
   doctor reuses A1's checks and B's adoption).
4. **Session 4 — Phases D + F** (status; conflict verbosity).
5. **Session 5 — Phase E** + final dogfood pass.

Each session: TDD against the integration harness
(`tests/integration/helpers.ts` — `createSandboxRepoWithRemote` gives a real
bare remote; `runCli` drives the real binary), `bun run check-types`,
full `bun run test` (NOT bare `bun test` — 5s default timeout, bunfig
ignored on bun 1.3.13), docs updated in the same commit (docs-coverage test
enforces command pages), push to main.

## Verification (end-to-end, per phase and final)

- Unit/integration: every new behavior gets a test witnessed red first.
- Dogfood on the real 19-branch stack (`cv-2841-cvi-data-seam` in
  hogwarts/.worktrees/hedwig): doctor and status against live state;
  store-desynced by deliberately amending a tracked branch out-of-band.
- Merge-lifecycle end-to-end needs GitLab access: when the stack publishes
  (Matt's existing plan), the first real bottom-MR merge is the acceptance
  test for Phase B — reconcile, cascade over the tombstone, retarget, report.
  Until then, the sandbox-remote + mocked-forge integration tests carry it.

## Explicitly out of scope

- Undoing forge writes (closing/reopening MRs).
- Editor/mergetool integration for conflict resolution (agent skills own
  resolution; F1/F2 only improve what's visible).
- Board UI expansion beyond what wiring B makes consistent automatically.
