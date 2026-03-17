# Packs SDK

Steward packs are signed, installable operational bundles.

## What packs can contain

- subagents
- mission templates
- workload templates
- assurance templates
- finding templates
- investigation heuristics
- playbooks
- report templates
- briefing templates
- gateway templates
- adapters
- tools
- replay labs
- conformance fixtures

## Why packs matter

Packs are the main open extension surface for Steward:

- they let operators share operational knowledge without forking the product
- they make deterministic playbooks and policies portable
- they provide a validation path through replay labs and conformance fixtures
- they support signed distribution for community and managed ecosystems

## Signing and verification

Steward supports signer registration and pack verification with Ed25519 signatures.

- unsigned packs can be installed when policy allows
- verified packs retain signer identity and verification status
- compatibility checks run before install

## Authoring workflow

1. Define pack metadata and compatibility.
2. Add the resources the pack contributes.
3. Include replay labs for realistic execution traces where useful.
4. Include conformance fixtures for deterministic validation.
5. Sign the pack if you are distributing it beyond local development.

## Runtime behavior

Pack install and upgrade are materialized into Steward state.

- resources are tracked after install
- enable, disable, upgrade, and remove are API-level operations
- pack lifecycle stays DB-backed and auditable

## Public ecosystem direction

The public ecosystem should optimize for:

- reproducible operations
- signed community packs
- replayable failure scenarios
- conformance-driven compatibility

Steward intentionally prioritizes replay labs and fixtures over seeded demo content.
