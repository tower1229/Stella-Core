# Stella Core Local Development Integration

## Goal

Run Stella 3.0 locally against the exact Alpha acceptance Host, OpenClaw 2026.8.2, using:

- a local Stella-Core checkout loaded as a linked OpenClaw plugin;
- an isolated OpenClaw development state directory;
- a local CangHai checkout based on the reviewed Stella 3.0 rebuild branch;
- no dependency on production OpenClaw sessions or machine-local runtime state.

The first acceptance target is a read-only consciousness bootstrap. The second target is a local-write Praxis vertical slice.

## Development topology

```text
OpenClaw 2026.8.2 (isolated dev state)
        |
        v
Stella-Core local checkout --linked plugin
        |
        v
CangHai local checkout
  base: dev-stella-3-rebuild
  local working branch: local/stella-alpha
        |
        +-- legacy 1.0 evidence (read)
        +-- Stella 3.0 managed data (read/write in phase 2)
```

## Important Git semantics

`sourceBaseline` / bootstrap baseline records the immutable CangHai revision used to derive the initial Stella 3.0 managed artifacts. It is provenance, not the forever-current CangHai HEAD.

A production recovery point is the explicit CangHai Git revision selected for restore. Normal Stella learning is expected to create later revisions.

Therefore:

- runtime must never require current HEAD to equal the original bootstrap commit forever;
- derived artifacts must retain source blob pins so source drift can invalidate/rebuild only the affected artifact;
- one explicitly selected CangHai Git revision remains the coherence boundary for restore;
- local development writes must not silently push to the durable remote repository.

This distinction must be reflected in the final restore validator before write-enabled Alpha testing is declared complete.

## Phase 0 — Prepare local repositories

Recommended layout:

```text
~/dev/Stella-Core
~/dev/CangHai-Stella-Dev
~/.openclaw-stella-dev
```

CangHai:

```bash
git clone git@github.com:tower1229/CangHai.git ~/dev/CangHai-Stella-Dev
cd ~/dev/CangHai-Stella-Dev
git fetch origin
git switch dev-stella-3-rebuild
git switch -c local/stella-alpha
# Keep test writes local unless explicitly promoted.
git config --local push.default nothing
```

Stella-Core:

```bash
git clone git@github.com:tower1229/Stella-Core.git ~/dev/Stella-Core
cd ~/dev/Stella-Core
npm install
npm run check
npm run build
npm test
```

## Phase 1 — Isolate OpenClaw development state

Do not use the normal OpenClaw state for initial plugin development.

```bash
export OPENCLAW_STATE_DIR="$HOME/.openclaw-stella-dev"
```

Create/configure a dedicated Stella agent in this isolated state. A typical dedicated workspace is:

```text
~/.openclaw-stella-dev/workspace-stella
```

The runtime must have a working model/provider route before Stella behavior can be tested.

## Phase 2 — Link Stella-Core into OpenClaw

Local plugin development should use a linked install so edits remain connected to the checkout:

```bash
cd ~/dev/Stella-Core
openclaw plugins install --link "$PWD"
```

If OpenClaw requests explicit trust confirmation for the local source, review the source and accept it; non-interactive setup may require the corresponding force/trust flag.

Configure Stella-Core:

```bash
openclaw config set plugins.entries.stella-core.config.canghaiRoot "$HOME/dev/CangHai-Stella-Dev"
openclaw config set plugins.entries.stella-core.config.manifestPath "50_PersonalAgent/stella/manifest.yaml"
openclaw config set plugins.entries.stella-core.config.agentId "stella"
openclaw config set plugins.entries.stella-core.config.recoveryRevision "$(git -C "$HOME/dev/CangHai-Stella-Dev" rev-parse HEAD)"
openclaw config set plugins.entries.stella-core.config.dataMode read_only
openclaw config set plugins.entries.stella-core.hooks.allowConversationAccess true
openclaw config set plugins.entries.stella-core.enabled true
openclaw config validate
openclaw gateway restart
```

Verify the runtime plugin surface:

```bash
openclaw plugins inspect stella-core --runtime --json
openclaw gateway status --deep --require-rpc
```

## Phase 3 — Read-only consciousness bootstrap acceptance

Before implementing any durable write path, prove:

1. OpenClaw starts with Stella-Core enabled.
2. `before_agent_run` does not block only when the local CangHai checkout is clean at the configured recovery SHA, compatible, and `runtimeState.activationStatus: active`.
3. `before_prompt_build` injects the Stella bootstrap context only for the configured Stella agent.
4. `migration_required`, `degraded`, incompatible versions, dirty/mismatched recovery revisions, invalid records, and breaking/removing the manifest cause Stella to fail closed with a stable category.
5. Restoring the manifest makes Stella usable again without restoring any old OpenClaw session.
6. Ordinary questions remain ordinary; loading Stella Core alone must not force every turn into Praxis analysis.

Recommended smoke probes:

```text
A. 普通事实/技术问题：不应触发 Praxis 深层分析。
B. “你是谁，你和普通 OpenClaw Agent 有什么区别？”：应体现 Stella identity/bootstrap。
C. 一个关系或私人现实问题：此阶段只确认意识数据可读，不要求完整 Praxis Loop。
```

## Phase 4 — Implement first Praxis vertical slice in shadow/read-only mode

Implement in this order:

```text
Turn Router
-> Situation Builder
-> Twin Context Builder
-> Framework Selector
-> Reality Need Check
-> Praxis Context Packet
-> main model answer
```

At first, log/inspect the generated packet but do not persist episodes.

Acceptance criteria:

- ordinary lane adds near-zero personal context;
- Praxis lane returns a bounded Twin context rather than a full personality profile;
- Framework Selector chooses 0-2 active operators;
- Reality Need Check distinguishes model-base social knowledge from cases requiring external research;
- the final answer gives one concrete next action when the user asks what to do.

## Phase 5 — Enable local CangHai writes

Before this phase, Stella-Core should add an explicit data write mode, recommended values:

```text
read_only
local_write
managed_durable_write
```

Local Alpha uses `local_write`:

- may create/update managed Stella 3.0 files in the local CangHai checkout;
- must not git push;
- should not auto-edit legacy `30_RAG` source documents;
- all generated writes must be schema validated before replace/commit.

First persisted object: a pre-outcome Praxis Episode.

Required ordering:

```text
prediction persisted
-> recommendation/action
-> later actual action/outcome
-> append outcome
-> compute prediction error
-> update at least one Twin Hypothesis
```

Never rewrite the original prediction after the outcome is known.

## Phase 6 — Local recovery drill

After at least one learned Praxis outcome exists:

1. commit the local CangHai test branch;
2. stop the isolated OpenClaw Gateway;
3. remove/recreate the isolated OpenClaw state directory (or use a second clean dev state);
4. reinstall/link Stella-Core;
5. point it to the same explicit CangHai recovery revision;
6. create a fresh Stella agent/session;
7. rebuild disposable runtime indexes;
8. run continuity checks.

Acceptance condition:

The new runtime can recover the identity, active Framework IR, Twin state, and learned Praxis outcome without the old session database.

After local-only development, `managed_durable_write` is a separate, explicit phase. It additionally
requires `durabilityRemote` and `durabilityBranch` in plugin configuration and a manifest durability
policy. Critical open/high-value state returns success only after commit and push. Normal closed
learning commits immediately, schedules a push within `maxNormalRpoSeconds`, and exposes pending or
breached RPO diagnostics. Do not point this mode at a real remote unless that external write has been
authorized.

## Immediate implementation sequence

```text
P0  Local build/test and packed clean-install against exact OpenClaw 2026.8.2
P1  Linked plugin + isolated OpenClaw state
P2  Read-only consciousness bootstrap smoke test
P3  Correct bootstrap-baseline vs recovery-revision semantics in validator/contracts
P4  Turn Router
P5  Situation Builder + Twin Context Builder
P6  Framework Selector + Reality Need Check
P7  Praxis Context Packet
P8  local_write CangHaiStore + Praxis Episode
P9  Outcome association + prediction-error update
P10 clean-runtime recovery drill
```

Do not begin broad CangHai migration, fine-tuning, social graph construction, or autonomous action work before P10 passes.
