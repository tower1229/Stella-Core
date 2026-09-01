# Tests

Runtime unit/integration tests will be added with implementation.

Important boundaries to test from the start:

- ordinary turns bypass unnecessary Cortex work;
- predictions are persisted before outcomes;
- Framework IR is reproducible from source + compiler version;
- private CangHai content never appears in public logs/fixtures;
- external research subagents receive only a bounded situation brief;
- Praxis Episode outcome updates preserve prior prediction history.
