# World-Class Capability Cutover Task Register

## Objective

Deliver a production-ready capability cutover for unknown-device onboarding and deep network intelligence with clean DB-backed configuration, no environment-variable product tunables, and deterministic tooling pathways.

## Hard Requirements

- No runtime/product behavior controlled by environment variables.
- All new tunables persisted in SQLite runtime settings and exposed via API/UI flows.
- Discovery enhancements must degrade safely when optional binaries (`nmap`, `tshark`, `playwright`) are unavailable.
- Tooling must prioritize deterministic evidence collection before user escalation.

## Task Register

| ID | Task | Status | Deliverable |
|---|---|---|---|
| WC-001 | Extend runtime settings model for deep nmap, packet intel, browser observation, DHCP lease intel | DONE | `RuntimeSettings` + defaults + DB metadata read/write + settings API validation |
| WC-002 | Add discovery evidence types for deep scripts, packet profiles, browser evidence, favicon signatures | DONE | New evidence enums and weighting/TTL policy in discovery evidence fusion |
| WC-003 | Implement deep nmap fingerprint module (NSE scripts + service/version enrichment) | DONE | `src/lib/discovery/nmap-deep.ts` integrated into discovery engine |
| WC-004 | Implement Wireshark-style passive packet intelligence collector | DONE | `src/lib/discovery/packet-intel.ts` with tshark parsing and host-level telemetry |
| WC-005 | Implement browser-observation module with Playwright-first + HTTP fallback behavior | DONE | `src/lib/discovery/browser-observer.ts` with optional screenshot capture and favicon hashing |
| WC-006 | Integrate advanced modules into discovery loop with runtime gates and target caps | DONE | `src/lib/discovery/engine.ts` phases for nmap, browser, packet-intel application |
| WC-007 | Fix HTTP tool default behavior (port-aware; avoid implicit 443 bias) | DONE | `src/lib/assistant/tool-skills.ts` smarter HTTP endpoint selection |
| WC-008 | Allow pre-adoption diagnostics during onboarding sessions | DONE | Tool readiness gating adjusted for onboarding-mode diagnostic calls |
| WC-009 | Add deterministic deep-probe assistant tool for unknown-device onboarding | DONE | `steward_deep_probe` tool combines fingerprint/nmap/browser/packet paths |
| WC-010 | Add first-party adapter packs for advanced intel and router lease operations | DONE | New managed built-ins in `src/lib/adapters/starter-pack.ts` |
| WC-011 | Expose new runtime controls in Settings UI | DONE | Discovery settings controls for all new tunables/toggles |
| WC-012 | Provide formal cutover artifact for implementation traceability | DONE | This task register document |

## Cutover Notes

- `steward_deep_probe` is now the canonical attached-device deep investigation entrypoint for onboarding workflows.
- Packet intelligence and browser observation are optional at runtime and gated by settings; absence of supporting binaries fails soft.
- Router lease intelligence is surfaced via first-party adapter capabilities/skills and can be bound per-device.
