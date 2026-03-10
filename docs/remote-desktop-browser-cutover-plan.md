# Remote Desktop Browser Cutover Plan

Last updated: 2026-03-10

Purpose:
- Land first-class in-browser remote desktop for both `rdp` and `vnc`.
- Keep the user-facing surface entirely inside Steward.
- Reuse Steward's existing chat/tool screenshot pipeline so the agent can navigate the remote desktop without inventing a second automation system.
- Make launch one-click by supervising prerequisites and bridge services from existing Docker and launcher flows.

## Architecture Decision

Steward will ship a unified browser remote desktop surface backed by the Guacamole protocol stack:
- `guacd` performs protocol translation for `rdp` and `vnc`.
- Steward starts a governed Guacamole-compatible WebSocket bridge in-process.
- Steward renders the remote surface in-browser using `guacamole-common-js`.
- Steward's agent uses Playwright against Steward's own remote viewer page for screenshots and input automation.

This keeps the UI browser-native while making RDP and VNC look like one product surface.

## Non-Negotiables

- No runtime/product behavior may depend on `.env` configuration.
- Any new tunables must live in DB-backed Steward settings.
- Stored connection credentials must continue to live only in the encrypted vault.
- Remote desktop bridge startup must be part of one-click launch paths.
- Human operators and the agent must use the same canonical viewer surface.

## Cutover Scope

### 1. Protocol and State Foundation

- Add `vnc` across protocol catalog, discovery hints, access-method synthesis, and credential onboarding.
- Extend protocol session records so `rdp` and `vnc` are first-class governed session protocols.
- Persist remote session metadata in `configJson` only; secrets remain in vault references.
- Add session lifecycle updates for `idle`, `connecting`, `connected`, `error`, and `stopped`.

### 2. Remote Desktop Bridge

- Start an in-process Guacamole-compatible WebSocket bridge from Steward's Node runtime.
- Auto-detect `guacd` on the compose network first, then localhost for host-mode launch.
- Generate and persist the bridge crypto key in the vault on first startup.
- Track bridge connect/disconnect events back into protocol-session state and audit trails.

### 3. Browser Viewer

- Add a dedicated remote desktop viewer page in Steward.
- Render the remote surface via `guacamole-common-js` with a stable DOM contract for automation.
- Provide a device-detail panel for launching or reusing remote sessions.
- Expose a viewer URL per session so chat results and device pages can deep-link to the same surface.

### 4. Agentic Control

- Add a `steward_remote_desktop` tool.
- The tool will create or reuse a governed `rdp`/`vnc` session, open Steward's own viewer page in Playwright, and execute atomic actions:
  - `snapshot`
  - `click`
  - `double_click`
  - `drag`
  - `type`
  - `press`
  - `scroll`
  - `wait`
- The tool returns screenshot-rich output compatible with the existing inline chat preview pattern.

### 5. Chat UX

- Add a specialized remote desktop tool preview card with:
  - protocol badge
  - session state
  - last screenshot
  - step timeline
  - deep link to the live viewer
- Persist chat screenshots under a dedicated remote desktop artifact namespace.

### 6. One-Click Launch

- Docker compose must bring up `guacd` automatically.
- Host launcher scripts must start or repair a local `guacd` runtime automatically.
- Steward startup must validate bridge prerequisites and degrade with a clear operator error if repair fails.

## Build Order

1. Protocol catalog + session/state model updates
2. Remote bridge service and `guacd` bootstrap
3. Remote desktop APIs and session token issuance
4. Browser viewer page + device panel
5. Chat preview + screenshot artifact plumbing
6. `steward_remote_desktop` Playwright tool
7. Build/lint validation and launcher cutover

## Acceptance Criteria

- A device exposing `rdp` or `vnc` can be opened inside Steward with no external UI.
- Steward can create, list, inspect, and reuse governed remote desktop sessions.
- The agent can capture screenshots and perform coordinate-based actions through `steward_remote_desktop`.
- Chat shows inline remote desktop screenshots comparable to the browser tool preview.
- `docker compose up` brings up all remote desktop prerequisites.
- `scripts/run-prod.ps1` launches Steward with remote desktop prerequisites in one flow.
- `npm run build` and `npm run lint` pass after cutover.

## Follow-On Work

- Add direct noVNC optimization for VNC-specific transport if it clearly beats the unified Guacamole surface.
- Add spectator/read-only joins and shared-session arbitration.
- Add higher-fidelity region zoom, OCR, and grounding overlays for desktop-target localization.
- Add recording/export for incident evidence bundles.
