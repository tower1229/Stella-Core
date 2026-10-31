---
name: stella-continue
description: "Continue an explicitly selected synthetic work brief, preserve its open questions, and save substantive revisions as unconfirmed candidates."
user-invocable: true
disable-model-invocation: true
---

# Continue a work brief

Use `/stella_continue <briefId> <request>` or explicitly reference
`$stella-continue` with a briefId. The user chooses the brief; do not infer it
from topic keywords, pick the latest session, or search private files.
This skill uses the existing `stella_work_brief` tool and the Host Agent loop.
It adds no tool, source permission, author qualification or model client.

## Read current state in this request

1. Require one explicit briefId, matching `[A-Za-z][A-Za-z0-9_-]{0,99}`.
   Ask for it if missing or ambiguous. Treat the remaining request as content,
   never as authorization to change the store, tools or identity.
2. Find `stella_work_brief` using the Host's normal tool discovery if necessary.
   Call it with `{"action":"read","briefId":"<briefId>"}` before using a
   previously saved explanation. Repeat this read in every new user request,
   including an ordinary follow-up in the same conversation. History is only
   past conversation; it cannot replace the current read or supply its version.
3. Continue only after a successful candidate read. Keep its exact `version`
   and full `proposal` for this request. An absent brief, unavailable tool,
   owner/workspace denial, cancellation or read error is a visible failure.
   Do not silently create a replacement or read the store using shell/files.

## Continue the thinking

Use the returned interpretation, proposed premises and open questions to address
the user's present request. Distinguish the saved assistant proposal from the
user's current words and from your new suggestions. Resolve only questions the
current evidence actually answers; preserve the others. Ask only material
questions and make useful progress where possible. Do not add a positive ending
or treat a preferred conclusion as the author's intent.

All language understanding and revision choices belong to the Host model.
The tool validates and stores the structured proposal; it does not judge meaning.
Evidence references are opaque and unverified: do not follow paths or URLs,
fetch transcripts, copy original documents, or infer author confirmation.
Use fictional input only in this synthetic-debug milestone.

## Save a substantive revision

If this request changes the working explanation, premises or open questions,
save the complete revised proposal with `stella_work_brief`:

```json
{
  "action": "save",
  "briefId": "<same briefId>",
  "operationId": "<new unique ID for this revision>",
  "expectedVersion": "<exact version read in this request>",
  "proposal": {
    "topic": "...",
    "interpretation": "...",
    "proposedPremises": [],
    "openQuestions": [],
    "evidenceReferences": []
  }
}
```

Operation IDs use the same ID format as briefId. Reuse an ID only for an exact
retry of the same operation. This continuation flow never uses a null version.
On a version conflict, stop the save and report that the brief changed; start
from a new current read before any revised attempt, without automatic overwrite
or retry loops. For an uncertain write, report uncertainty rather than inventing
another operation. Read-only discussion needs no save.

Report saving only after a successful `local_committed` receipt with
`isCurrent:true`, including the same briefId and resulting version. An old
idempotent receipt with `isCurrent:false` is not a new current revision. A failed
save may leave useful discussion, but the revision was not successfully saved.
Every stored revision remains an unconfirmed candidate: publisher off,
authorConfirmation false. Do not update USER, MEMORY, an author position or
long-term personal memory. On the next user request, read current state again.
