# Ordinary package retirement and CangHai handoff — 2026-11-04

The installable package now excludes the retired plugin, private Host bridges,
SQL reader, context replacement, completion runtime and old activation guides.
Three shared data types and the unchanged source-metadata check were separated
from the old runtime. This is the first distribution/dependency retirement stage,
not a claim that the entire old source/test tree has been deleted.

The existing ten extracted-package suites passed **141/141** on local SDK10.9,
including two new synthetic branch/next-generation cases. Build/test compilation
and nine schemas passed. Initial missing ambient declaration, stale compiled test
run and wrong synthetic TMPDIR invocation are preserved separately; they are not
hidden or added to passing counts. Previous BOM commit24551ff6 CI passed; current
candidate10.8 CI, real Host and model semantics have not run.

The like-for-like tarball comparison is **551→145 members** (175→42 compiled
source modules). The retained prepared directory has2753 files, including2202
dependency files; that installed-directory count is not the tarball denominator. The ordinary static runtime closure is
32 modules /37 with types. The same metadata authorization function body moved
unchanged. Source scope, policy judgment, cancellation, freshness and transactions
were not relaxed. No compatibility re-export or new execution framework was added.

The first section of docs/CORE-CANGHAI-COORDINATION.md now states the **full-repository
new-format branch and synchronization** goal. The old97/362 snapshot and synthetic
warehouse branch are not completion evidence. Core accepts explicit clean root,
manifest path and full revision; manifest/profile/catalog paths are not tied to
migration-v1. The synthetic tests prove relocation and fail-closed version/cursor/
removed-source behavior, not automatic synchronization or actual private migration.

Next dependencies: CangHai writer hands off the new branch/worktree/SHA and
complete source/attachment/change map; Core then connects version advancement and
new-format synchronization. Independently, remove the old entry/Host bridge graph
and sole-use scripts/tests after preserving shared parsers and effective assertions.
The old loading delegation remains unknown and was not replayed. No main config,
Host, private payload, model, permissions or CangHai files were changed.

Review boundary: CODE-MANIFEST.json and CHANGES.patch pin38 files; original unrelated
dirty files are excluded. Independent review accepted the code/package boundary and replayed the same
141/141 suite. Its P2 count-denominator correction is applied here; code hashes,
patch and test receipts remain unchanged. No tests were rerun for this wording fix. Reports preserve the
non-clean workspace identity. The new package was tested, not installed.
