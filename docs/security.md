# Security

## Configuration model

Steward does not use environment variables for product behavior.

- runtime settings are persisted in SQLite
- system settings are persisted in SQLite
- auth settings are persisted in SQLite
- provider metadata is persisted in SQLite
- secrets are stored in the encrypted vault

## Secrets and vault

Steward stores device credentials, OAuth tokens, and provider secrets in the vault.

- encrypted at rest with AES-256-GCM
- wrapped by a locally derived key
- not rendered back to operators after storage

## Identity and access

Steward supports:

- local bootstrap and local users
- session auth
- API token auth
- OIDC
- LDAP

RBAC is enforced across the application and APIs.

## Auditability

Steward records:

- append-only audit events
- durable job state
- playbook evidence and gate results
- settings history with effective timestamps

All mutations should be attributable and reviewable.

## Execution safety

Mutation work is guarded by:

- policy evaluation
- action classes
- approval TTLs and escalation
- safety gates
- verification steps
- rollback steps
- repeated-failure quarantine

## Network posture

Steward is designed to run inside the managed network.

- no cloud dependency is required for core operation
- remote access relay behavior is optional
- credentials are scoped to the devices Steward should manage

## Release checklist

Before public release:

- run `npm run lint`
- run `npm run test`
- run `npm run build`
- verify vault initialization and auth bootstrap flows
- verify durable job workers and playbook approval handoff
- verify pack signing and verification flows if distributing managed packs
