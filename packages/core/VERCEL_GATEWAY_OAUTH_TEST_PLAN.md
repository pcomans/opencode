# Vercel OAuth end-to-end test plan

Created 2026-10-29. Scope: OAuth PR #5 and companion documentation PR #6. Existing AI Gateway setup PRs are outside this plan.

## Evidence rules

- **Live** means the packaged OpenCode app/server uses real Vercel consent, tokens, team APIs, and Gateway inference.
- **Fixture** means production code runs against isolated deterministic inputs. It establishes implementation behavior, not Vercel deployment readiness.
- **Inspection** is explicitly not an executed pass.
- No fabricated expiry, manual refresh exchange, borrowed token, or manual team-header override can count as live automatic-refresh evidence.
- Capture build commit/version, connection IDs, selected team, result, sanitized logs and screenshots. Never record token values.
- Preserve the existing connection. Destructive credential tests target only an additional test connection; app-wide token revocation is excluded from this run.

## Live environment

This macOS run used runtime revision `1ed41e37d8`, packaged frontend and bundled server, and a public personal test app. A new isolated profile received a SQLite backup of the previous test profile, including its existing saved OAuth connections. The installed OpenCode service and previous test server were left running. The working test instance uses explicit port 54746. Later commits extend tests only.

For a repeat run, use the maintainer-owned client in the server environment, preserve an existing connection, and create a disposable additional connection for revocation and deletion. Keep Gateway API-key and OIDC environment credentials unset and remove manual provider-header overrides so inference actually exercises OAuth. Stop before any revocation action that would affect all app sessions.

## A. Real desktop and Vercel service

| ID  | Action and acceptance criteria                                                                                                                            | Result                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01 | Verify packaged frontend and bundled server are the reviewed revision, with the configured public test client                                             | Pass live: 1ed41e37d8 runtime, isolated instance on port 54746; initial port-collision launch recorded separately                                                 |
| L02 | Baseline both saved connection IDs and active selection; verify existing active token by real inference                                                   | Pass live: original active connection returned HTTP 200 / 43                                                                                                      |
| L03 | Start Add account, then cancel before browser approval; no connection saved and original remains active                                                   | Pass live: fresh device form closed before consent; 3 saved IDs and original selection retained                                                                   |
| L04 | Add account while an existing connection is present; Vercel device flow opens with a fresh code                                                           | Pass live: Add account opened real Vercel device flow alongside existing connection                                                                               |
| L05 | Complete real device consent using the v2 team-installation configuration                                                                                 | Pass live: real device authorization reached billing-team setup using v2 installation config                                                                      |
| L06 | Before team confirmation, no new credential is persisted and the original remains active                                                                  | Pass live: exactly the two baseline IDs remained before team confirmation                                                                                         |
| L07 | Explicitly confirm the personal billing team; new connection has a distinct ID and token pair                                                             | Pass live: confirmed personal team; third credential has a distinct ID, access and refresh tokens                                                                 |
| L08 | Original connection remains saved and unchanged; new connection is active                                                                                 | Pass live: original IDs retained, original value digest unchanged, added connection active                                                                        |
| L09 | Both accounts are visible; rename them distinctly and verify labels persist                                                                               | Pass live: original and additional labels renamed through desktop and persisted in API                                                                            |
| L10 | Run real desktop inference through the new connection; numeric result correct and session succeeds                                                        | Pass live: packaged desktop chat through added connection returned 71 for 23 + 48                                                                                 |
| L11 | Switch to original connection; verify selection and successful inference                                                                                  | Pass live: desktop selected original; server inference returned HTTP 200 / 53                                                                                     |
| L12 | Switch back; verify new connection is used and succeeds                                                                                                   | Pass live: desktop selected additional; server inference returned HTTP 200 / 53                                                                                   |
| L13 | Cancel an additional attempt after reaching team setup; neither saved connection changes                                                                  | Pass live: approved real device consent, reached team form, closed it; 3 saved IDs and original selection retained                                                |
| L14 | Let original access token age naturally, then send concurrent inference requests in its refresh window                                                    | Waiting until original token eligible                                                                                                                             |
| L15 | Verify same connection/team, changed access AND refresh tokens, advanced expiry, new access active, old refresh inactive                                  | Queued after L14                                                                                                                                                  |
| L16 | Next inference succeeds without another refresh or browser approval                                                                                       | Queued after L15                                                                                                                                                  |
| L17 | Revoke only the extra test connection; confirm invalid tokens and eventual authentication failure without deleting saved entry                            | Pass live: targeted revocation marked extra pair inactive; Gateway 401 observed after ~89 seconds; desktop displayed authentication failure; saved entry retained |
| L18 | Original connection continues inference after extra connection is revoked                                                                                 | Pass live: original token remained active; original inference returned HTTP 200 / 53 after extra revocation                                                       |
| L19 | Reauthenticate the revoked account through real device consent and team confirmation                                                                      | Pass live: real CLI device consent and visible personal-team prompt; Enter required before save                                                                   |
| L20 | Verify original remains usable and recovered connection has a fresh token pair and successful inference                                                   | Pass live: new recovered credential/tokens, same billing team; all old IDs and original value retained; HTTP 200 / 76                                             |
| L21 | Delete the inactive extra test connection by explicit ID with the production CLI; active original remains usable (TUI confirmation is covered separately) | Pass live: CLI switched original, removed only revoked extra ID, original inference HTTP 200 / 53                                                                 |
| L22 | Capture final account list, final successful inference, and sanitized evidence                                                                            | Queued                                                                                                                                                            |

Live cross-team billing, SSO/MFA organization policies, denied browser consent, and installation authorization by another user require additional eligible Vercel accounts/teams or human actions. Do not claim these passed from same-team testing; corresponding implementation behavior is checked below where fixtures support it.

## B. Device grant and team discovery

| ID  | Contract                                                                                                 | Execution/evidence                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| O01 | OAuth appears alongside existing key and environment methods                                             | Pass fixture: provider/core matrix, 106 tests                                                                   |
| O02 | Public client requests identity/refresh scopes without a client secret                                   | Pass fixture: provider request assertions, 106-test matrix                                                      |
| O03 | Pending and slow_down respect polling intervals                                                          | Pass fixture: TestClock pending + slow_down case                                                                |
| O04 | Denied consent, expired code and unknown OAuth errors fail clearly without persistence                   | Pass fixture: expanded device/token rejection table                                                             |
| O05 | Malformed token bodies, missing refresh token, invalid token lifetime fail without exposing token bodies | Pass fixture: provider/core matrix 106/106                                                                      |
| O06 | Cancel polling before consent stops further token requests                                               | Pass fixture: polling cancellation case; live desktop close also exercised                                      |
| O07 | Team pagination includes later pages and filters limited teams                                           | Pass fixture: paginated team choice + limited-team cases                                                        |
| O08 | Multiple teams require explicit selection; single team still requires confirmation                       | Pass fixture: provider multi-team and built-browser single-team confirmation; live desktop and CLI confirmation |
| O09 | Unknown team answer is rejected without saving a partial connection                                      | Pass fixture: invalid team answer leaves setup open and saves nothing                                           |
| O10 | Missing Team Read, empty/all-limited teams, malformed team responses fail without persistence            | Pass fixture: Team Read/empty/all-limited/malformed response table                                              |
| O11 | Status exposes form fields and never OAuth token values                                                  | Pass fixture: pending status contains fields, no OAuth secrets                                                  |

## C. Lifecycle, concurrency and credentials

| ID  | Contract                                                                                   | Execution/evidence                                                                                        |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| C01 | Automatic and code-mode setup can be cancelled during discovery; no resurrection           | Pass fixture: automatic/code preparation cancel table                                                     |
| C02 | Automatic and code-mode setup can expire during discovery; resources close                 | Pass fixture: automatic/code preparation expiry table                                                     |
| C03 | Persistence failure closes the attempt and reports failure                                 | Pass fixture: persistence transform failure closes resources                                              |
| C04 | Missing code leaves code-mode attempt usable; completion persists once                     | Pass fixture: code completion idempotence and missing-code cases                                          |
| C05 | Refresh preserves credential ID, label, client binding, team and custom metadata           | Pass fixture: provider rotation and lifecycle matrix                                                      |
| C06 | Refresh returns and saves both rotated tokens; subsequent resolution reuses them           | Pass fixture: provider rotation and cross-Location refresh tests; live natural refresh pending            |
| C07 | Concurrent resolution shares a refresh; process/location locks prevent duplicate refreshes | Partial: same-process cross-Location coalescing passed; cross-process full refresh composition unverified |
| C08 | Revoked, failed or malformed refresh retains the saved connection                          | Pass fixture: expanded refresh rejection table retains stored credential                                  |
| C09 | New account selection, activating older account, rename and deletion obey credential rules | Pass fixture: credential/TUI/browser management tests; live OAuth switching and rename also passed        |
| C10 | Native OAuth inference sends the selected connection's bearer token and team together      | Pass fixture: provider native request assertions; live OAuth inference passed without header overrides    |
| C11 | Existing API-key/environment credentials and other providers retain their behavior         | Pass fixture: existing key/env registrations and model-resolver regression suite                          |

## D. Desktop, CLI, TUI and public contracts

| ID  | Contract                                                                         | Execution/evidence                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| U01 | Desktop team picker waits for selection and sends the selected ID                | Pass fixture: built-browser OAuth keeper; live personal-team selection passed                                                           |
| U02 | Desktop required hidden defaults reach setup completion                          | Pass fixture: same built-browser keeper submits required hidden default                                                                 |
| U03 | TUI completion handles complete, failed and expired status without false success | Pass fixture: 14 TUI tests include complete/failed/expired statuses                                                                     |
| U04 | TUI account activation, rename, delete confirmation and location behavior        | Pass fixture: 14 TUI tests include switching, rename, confirmation and location behavior                                                |
| U05 | CLI forms, defaults, auth choices and account management                         | Pass fixture: 31 CLI tests; live OAuth CLI consent and visible team confirmation passed. Visible-prompt cancellation remains unverified |
| U06 | Public FormFields1 export remains present; OAuth timestamps remain numeric       | Pass: 4 client contract tests + official compiler                                                                                       |
| U07 | Generated clients are reproducible from the public schema                        | Pass: bun run check:generated, no generated diff                                                                                        |
| U08 | Full repository lint/type checks and official core compiler                      | Pass: root check 35/35; official core and CLI TypeScript compilers                                                                      |

## Release checks beyond this local run

- Maintainer-owned client rather than the personal test app.
- Vercel confirmation of device-grant/private-beta eligibility for release users and teams.
- Vercel fix/verification for missing API-permission display on the beta device-consent screen.
- Supported release platforms and browser/SSO policies. A macOS run does not establish Windows or Linux desktop behavior.

## Reproducing the fixture checks

Run commands from the indicated package directory, never `bun test` from the repository root.

```sh
# packages/core
bun run script/test.ts test/plugin/provider-vercel.test.ts test/integration.test.ts test/model-resolver.test.ts
bun run script/test.ts test/credential.test.ts test/credential-lock.test.ts test/integration-refresh.test.ts
bun run typecheck:tsc

# packages/cli
bun test --timeout 30000 test/auth-form.test.ts test/auth-login-choices.test.ts test/auth.test.ts
bun run typecheck:tsc

# packages/tui
bun test --timeout 30000 test/cli/tui/dialog-integration.test.tsx

# packages/client
bun test test/contract-identity.test.ts
bun run check:generated

# packages/app
bun run test:e2e:built e2e/regression/settings.spec.ts -g "providers:" --workers=1 --retries=0

# repository root
bun run check
```

## Results

Executed 178 distinct fixture tests: 106 provider/integration/model-resolution, 10 credential lifecycle/refresh, 31 CLI, 14 TUI, 4 client contract, and 13 built-browser provider tests. All passed. Root checks passed 35/35; official core/CLI compiler, generated consistency and changed-file formatting passed.

Live sign-in, adding alongside existing credentials, both desktop cancellation stages, switching, inference, connection-specific revocation, isolation, real CLI recovery and team confirmation, desktop recovery, and inactive extra deletion passed. Natural refresh and final screenshots remain in progress.

The first separate test instance collided with the installed managed service on port 49374. The working isolated instance uses explicit port 54746. The installed service and earlier test server were not restarted.

Limits: full cross-process refresh composition, live cross-team billing, CLI cancellation at a visible team prompt, Windows/Linux desktop, and maintainer-owned client readiness remain unverified. The existing credential lock tests exercise mutual exclusion, and refresh tests exercise same-process cross-Location coalescing; they do not establish the complete cross-process composition. Live refresh is tracked separately above.
