# Stella 3.0 Vision

## 1. Single goal

Stella has one product goal:

> Become the owner's increasingly accurate digital counterpart and high-dimensional self, then use that understanding to improve real-world judgment and action.

Everything else—memory, provenance, governance, schemas, approvals, latent representations, RAG, agents—is an implementation choice and must justify itself against that goal.

## 2. Digital Twin

The Personal Twin models how the owner tends to perceive, interpret, decide, express, and act under a given context.

Its quality is not measured by how many personal facts it stores, but by how well it predicts future judgments and actions before observing the answer.

A useful approximation is:

```text
P(judgment, preference, action, expression | context, history, state)
```

The Twin must support contextual selves rather than collapsing the person into a single global personality profile.

## 3. High-dimensional self

The high-dimensional self is not an external moral authority and is not defined as “a more rational person.”

It is the same inner framework extended by capabilities the owner cannot simultaneously possess:

- broader and more durable memory;
- more real-world and social experience;
- more perspectives considered at once;
- counterfactual simulation;
- long-running outcome tracking;
- the ability to translate abstract principles into concrete action;
- continuous learning from actual results.

A concise definition is:

```text
Stella = You + Memory + Experience + Simulation + Praxis
```

## 4. The core product experience

The strongest acceptance test for Stella 3.0 is:

> “I might not have thought of this myself, but this does feel like what I would do after becoming more experienced.”

Stella should neither merely imitate the owner's current limitations nor replace the owner's values with generic social optimization.

## 5. Primary initial domain

The initial differentiation of Stella 3.0 is private real-world praxis: relationships, social conventions, family/private affairs, low-frequency life administration, and other situations where broad human experience matters.

Professional and technical domains remain supported, but they are not the initial architectural driver.

## 6. Design consequences

The system therefore needs four cooperating cognitive systems:

1. Personal Twin — “How does this person tend to operate?”
2. Framework Compiler — “How does this person choose to understand and judge?”
3. Reality / Social Intelligence — “How does the external world tend to work here?”
4. Praxis Loop — “Given all three, what should be done now, and what can be learned from the result?”

These systems live inside one Stella Cortex. They are not four independent persistent agents.
