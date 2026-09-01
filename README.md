# Stella Core

Stella Core is the cognitive runtime and architecture for Stella 3.0: a personal digital twin and high-dimensional self built on OpenClaw, with CangHai as the portable personal data plane.

## Core goal

Stella exists to become a progressively better digital counterpart of its owner and to extend that person with broader memory, real-world experience, simulation, and praxis capability.

The design centers on four cooperating systems:

1. **Personal Twin** — models how the owner tends to perceive, decide, express, and act.
2. **Framework Compiler** — turns the owner's explicit thinking frameworks into executable cognitive operators.
3. **Reality / Social Intelligence** — supplies real-world and social experience that the owner may not personally possess.
4. **Praxis Loop** — combines Twin, Framework, and Reality into concrete action, observes outcomes, and learns from them.

## Repository boundary

This repository contains **runtime code, schemas, architecture, and evaluation logic only**.

Long-lived personal data belongs in the private CangHai repository. Runtime caches, indexes, embeddings, and other rebuildable OpenClaw state do not need to be committed here or to CangHai unless they become portable personal learning assets.

## Status

Architecture initialization. The current design baseline is documented under `docs/`.
