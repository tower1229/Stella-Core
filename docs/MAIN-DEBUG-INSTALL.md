# Ordinary-plugin main debug build

The default package entry is `dist/src/ordinary-plugin.js`. It contributes two
ordinary tools and the authenticated `/stella-status` command. OpenClaw owns its
memory, context and Agent loop. No Core provider, context replacement, background
consolidation, private source reader or writer is registered by this entry.

Use `{ "agentId": "main", "publisher": false }` as the plugin configuration.
Legacy checkpoint configuration is rejected explicitly. Historical implementation
and its manifest remain in `src/plugin.ts` and `legacy/openclaw.plugin.json`;
the package entry does not import them. Existing source repositories, checkpoints
and user files are not migrated or removed.

`stella_author_intent_candidate` accepts a structured proposal from the Host's
model: topic, interpretation, proposed premises, open questions and evidence
references. It validates structure only, preserves unresolved questions and
returns an **unconfirmed, unsaved candidate**. References supplied in arguments
are unverified. The tool cannot confirm the author, publish an asset or save
memory. Natural-language interpretation remains the model's responsibility.

`stella_status` and `/stella-status` show the active contract without a model
call. The existing main Gateway can invoke the tool directly:

```sh
openclaw gateway call tools.invoke \
  --params '{"name":"stella_status","agentId":"main","args":{}}' --json
```

This checks real tool execution, not model understanding or personal-source
admission. Normal conversations can discover the tools through the `coding`
profile and OpenClaw's existing Tool Search. No Tool Search configuration change
is required for this install.

For local debug installation, build and pack the repository, unpack into a new
artifact directory and retain the previous artifact. Runtime dependencies must
be inside the package boundary; a `node_modules` symlink to the workspace is
rejected by OpenClaw's install scan. Use the existing Host's public SDK rather
than bundling another Host. No dependency download is needed when reusing the
already installed runtime dependencies; record their actual versions separately
from the lockfile.

Before changing the current main configuration, save its exact bytes privately
with mode `0600`. Replace only the old Core load path and Core entry with the new
artifact/configuration, then validate it with `openclaw config validate --json`.
The official local link install records package ownership and applies the running
generation:

```sh
openclaw plugins install --link /absolute/path/to/unpacked/package --force --no-enable
openclaw plugins inspect stella-core --runtime --json
```

Here `--force` confirms this reviewed local build. `--no-enable` preserves the
existing activation/allowlist/slot policy. Do not add capability-consent or safety
override flags to make an install succeed. Preserve failures before fixing the
actual package defect.

Rollback retains both artifacts and the private config backup. If the current
config changed since installation, restore only the two Core fields after
comparing the changes; never overwrite intervening user edits. If removing the
new link's official install record, use `plugins uninstall stella-core
--keep-files --force` before restoring the old entry/path. Verify the restored
runtime separately; a restored file is not proof of a loaded generation.

This debug milestone does not enable confirmed publication, connect private
sources, migrate old state, call paid models or establish `full_memory`.
The previously exhausted isolated Host batch remains historical and is not
reused by the main-instance installation.
