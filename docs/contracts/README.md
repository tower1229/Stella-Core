# Core Data Contracts

Stella 3.0 Alpha intentionally begins with only three durable semantic contracts:

1. **Twin Hypothesis** — a testable model of how the owner tends to operate under a scope/context.
2. **Framework IR** — an executable representation compiled from an owner-authored framework source.
3. **Praxis Episode** — one real-world situation from recommendation/prediction through action and outcome.

The contracts are logical first. Serialization and exact CangHai paths may evolve without changing their meaning.

The current recommended serialization strategy is:

- Twin Hypothesis: human-inspectable Markdown with structured frontmatter in CangHai;
- Praxis Episode: human-inspectable Markdown with structured frontmatter/managed sections in CangHai;
- Framework source: Markdown in CangHai;
- Framework IR: rebuildable JSON/runtime artifact compiled from the source.

These three contracts are sufficient to bootstrap learning without introducing a large ontology.
