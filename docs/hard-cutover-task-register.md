# Steward Hard-Cutover Task Register

Last validated: 2026-03-05

## Program Statement

Steward completed hard cutover from `Plugin` semantics to `Adapter` semantics and policy-first adapter execution. This cutover remains intentionally non-backward-compatible: no fallback routes, no alias APIs, and no runtime compatibility shims.

## Hard Constraints

- No runtime/product configuration via environment variables.
- No `/plugins` routes or plugin-named API contracts.
- No plugin-named execution symbols in runtime code paths.
- Mutating actions flow through adapter-level execution contracts.

## Work Packages

| ID | Scope | Status | Definition of Done |
|---|---|---|---|
| HC-001 | Rename runtime domain model (`Plugin*` -> `Adapter*`) in core types/loader/registry | DONE | `src/lib/adapters/*` exports adapter-named contracts/APIs |
| HC-002 | Remove env-driven adapter directory override | DONE | No `STEWARD_PLUGINS_DIR` or adapter dir env override in runtime |
| HC-003 | Hard DB schema cutover (`plugins` table -> `adapters` table) | DONE | Runtime reads/writes only `adapters` table |
| HC-004 | API cutover (`/api/plugins/*` -> `/api/adapters/*`) | DONE | Active endpoints exist only under `/api/adapters` |
| HC-005 | UI/navigation cutover (`/plugins` page -> `/adapters`) | DONE | Nav/page/actions use adapter naming |
| HC-006 | Remove compatibility aliases and shim logic | DONE | No plugin-named imports/symbols/routes in runtime |
| HC-007 | Build-time verification | DONE | `npm run build` passes |
| HC-008 | Lint gate verification | DONE | `npm run lint` has zero errors |
| HC-009 | Adapter execution kernel: typed `OperationSpec` as only mutation path | DONE | Playbook runtime executes typed operations through kernel |
| HC-010 | Four safety gates for mutating actions | DONE | Schema/type + OCC hash + policy/lane + dry-run gates before dispatch |
| HC-011 | Policy engine lane decisions (`ALLOW_AUTO`, `REQUIRE_APPROVAL`, `DENY`) | DONE | Decisions include lane/blast-radius/criticality/failure signals |
| HC-012 | Mandatory preflight -> execute -> postflight -> rollback/quarantine lifecycle | DONE | Runtime enforces lifecycle and quarantine thresholds |
| HC-013 | Network lockout protection for network mutations | DONE | `network.config` mutation requires confirmed revert mechanism |
| HC-014 | Capability broker with short-lived scoped per-action tokens | DONE | Per-operation scoped token issue/validate in kernel |
| HC-015 | Two-DB durability split (`steward_state.db`, `steward_audit.db`) with replay | DONE | Durable split with WAL + claim/complete/fail job APIs |
| HC-016 | Prompt firewall and tainted-context policy for untrusted telemetry | DONE | Discovery advisory path sanitizes telemetry and tracks taint |
| HC-017 | Lane model enforcement: A deterministic default, B gated IR, C read-only in prod | DONE | Lane B/C runtime enforcement active |
| HC-018 | Adaptive-to-deterministic promotion loop (ARR-driven) | DONE | Successful Lane B runs emit deterministic promotion recommendations |
| HC-019 | Remove env-based API guard and move to DB-backed auth settings | DONE | API guard token uses `auth.*` SQLite settings + `/api/settings/auth-token` |
| HC-020 | Versioned settings with `effective_from` + `asOf` reads | DONE | `settings_history` table + runtime/system/auth history APIs |
| HC-021 | DB-driven digest scheduler in system settings domain | DONE | Daily digest scheduler runs from `system.*` settings (timezone + local schedule) |
| HC-022 | RBAC + session auth + OIDC/LDAP auth surfaces | DONE | `/api/auth/*` surface, role-gated route permissions, and `/access` management page |

## Validation Gates

| Gate | Target | Current |
|---|---|---|
| Build | `npm run build` succeeds on main branch | PASS |
| Lint | `npm run lint` has no errors or warnings | PASS |
| Schema | Runtime SQL references only `adapters` for adapter inventory | PASS |
| Route Surface | No `/plugins` endpoints/pages remain | PASS |
| Security | No env-based runtime tunables in `src/` | PASS |

## Immediate Hardening Milestones

1. Backfill integration tests for settings history (`asOf`) and digest scheduler edge cases.
2. Extend deterministic graph query intents and add citation links to UI entities.
3. Add signed/tamper-evident audit chain semantics.
4. Add SAML/SCIM follow-on to complement OIDC/LDAP baseline.
5. Add CVE and anomaly pipelines (DNS/traffic) with bounded false-positive controls.
