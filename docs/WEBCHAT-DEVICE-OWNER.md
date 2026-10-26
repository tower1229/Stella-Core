# Explicit WebChat device owner (experimental)

The default WebChat identity is still a Host-authenticated human profile selected
by `webchatOwnerProfileId`. Token/device authentication alone does not create that
profile in OpenClaw 2026.8.2. Repeating `stella.identity {}` cannot create one.

For a single-owner development Gateway, checkpoint `fresh_tools` configuration may
instead select `webchatOwnerDeviceId`: the exact 64-character lowercase hex device
ID returned by the current connection's read-only diagnostic. The two owner fields
are mutually exclusive. No binding is enabled automatically.

`stella.identity` requires the existing `operator.admin` scope and accepts only
`{}`. It reports profile/device presence and non-secret identifiers, with source
and conversation authorization explicitly `not_checked`. Missing profile is a
diagnostic result, not a reason to send a chat or manufacture a human identity.

Device mode admits only current direct WebChat ingress carrying Host owner/admin
authorization, operator provenance without a profile actor, and the exact selected
device ID. Stock Host publishes its connection device as
`ApprovalReviewerDeviceId`; Core does not accept that identity in tool arguments.
The principal is `openclaw-device:<id>`, distinct from profiles and Telegram.
The source must declare an existing `source_access_context` processing grant that
explicitly includes this principal. All model, purpose and source policy checks
continue to apply. Missing or other-principal grants block Agent admission and
retained-memory consumption. If local input archiving is enabled, the current
authenticated owner's input may already have been committed before retrieval is
refused; this is not a zero-write guarantee.

Existing run/session/tool permits remain authoritative. Same-device subsequent
user requests receive fresh checkpoint and permission checks; already-authorized
tool continuations belong to their original request. Unknown old conversation
history is not adopted. Start one new conversation for an unowned prior session;
ordinary bound conversations do not need a reset each turn.

This mode trusts the holder of that device identity with Gateway admin authority.
It cannot distinguish people sharing the same browser identity. Clearing browser
storage or using another device requires explicit rebinding. A present different
profile is refused rather than falling back to device ownership. Use the profile
mode for person-level separation; no multi-person isolation claim is made here.

Actual enablement requires approval of the concrete device ID, the exact source
processing-grant change, and package loading/restart. It does not authorize model
API calls, new credentials, source-purpose expansion, or adoption of old history.
The current development batch tests synthetic identities and loopback only; it
does not change the real main Gateway or its grants. `full_memory` remains separate.
