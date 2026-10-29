# Authorization-code OAuth test plan

This plan belongs to the loopback authorization-code alternative. Prior device-flow results are separate evidence. A contract pass uses fixture Vercel responses; only a live pass establishes behavior against the real OAuth app and AI Gateway.

## Automated contracts

The Vercel provider suite passed **44 tests and 246 assertions** on macOS on 2026-10-29. Sign-in cases use actual loopback listeners and fixture upstream HTTP responses.

| Contract                                                                                                      | Result |
| ------------------------------------------------------------------------------------------------------------- | ------ |
| Authorization URL uses code grant, scopes, PKCE S256, state, and loopback redirect                            | Pass   |
| Exchange uses matching verifier and redirect, with no client secret                                           | Pass   |
| Wrong/missing state, wrong issuer, path, or method cannot exchange a code; valid callback still succeeds      | Pass   |
| Denial and missing code fail without saving credentials or echoing provider details                           | Pass   |
| Cancellation closes the listener, makes no token request, and preserves prior connection and active selection | Pass   |
| Concurrent attempts have independent state and PKCE; reverse-order callbacks retain their labels              | Pass   |
| A callback replay cannot cause a second exchange; completed attempts release their listeners                  | Pass   |
| Team pagination excludes limited teams and requires explicit confirmation                                     | Pass   |
| Invalid team selection retains pending setup without saving credentials                                       | Pass   |
| Native inference uses the OAuth bearer token and selected team; no API-key creation                           | Pass   |
| Refresh rotates both tokens while preserving credential ID, label, metadata, and original client              | Pass   |
| Invalid exchange/refresh bodies and failures expose no tokens and preserve saved credentials                  | Pass   |

The shared integration tests own attempt expiry, post-consent cancellation, and setup persistence. The existing CLI, TUI, and browser suites own their setup prompts. Verification passed 190 distinct tests: 44 provider, 99 related core, 16 CLI, 14 TUI, 4 client-contract, and 13 browser-provider cases. All 35 repository checks and the official core TypeScript check passed. The browser keeper also proves that authorization-code instructions are not displayed as a device code while real device codes remain visible.

## Live execution

Use a fresh isolated profile and the real test app. Do not copy a rotating OAuth grant between profiles. Preserve the existing device-flow test profile and the installed daily app.

| Check                                                                                                     | Result                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register the loopback callback on the public test app                                                     | Pass: Vercel accepted `http://127.0.0.1/oauth/callback`                                                                                                                                                       |
| Authorize with an ephemeral port and complete the real token exchange                                     | Pass: real browser consent and callback on an available port                                                                                                                                                  |
| Confirm a real billing team and persist access/refresh credentials                                        | Pass: personal team `philippcomans-1463`; both tokens saved                                                                                                                                                   |
| Run native Gateway inference with the saved connection                                                    | Pass: HTTP 200 and `703` for `37 × 19`, with no Gateway environment connection                                                                                                                                |
| Add a second connection while preserving the first                                                        | Pending: requested Internal Playground connection needs an admin installation                                                                                                                                 |
| Cancel before callback and verify listener and credential cleanup                                         | Pass through the real server API: wrong-state callback 400, cancelled attempt 404, listener closed, saved values and active selection unchanged                                                               |
| Cancel after consent at the billing-team step; preserve saved connections                                 | Pending                                                                                                                                                                                                       |
| Exercise the real CLI browser flow and billing-team prompt                                                | Pending                                                                                                                                                                                                       |
| Verify natural near-expiry renewal of an authorization-code grant without browser consent, then inference | Pass live: 23 consecutive HTTP 200 checks; both tokens rotated about 4m15s before expiry; same connection and team; desktop returned `574`                                                                    |
| Capture the built desktop team picker and successful inference                                            | Pass: personal billing team; desktop GPT 5.4 Nano returned `391` for `17 × 23`                                                                                                                                |
| Select Internal Playground and run inference billed there                                                 | Blocked: the app is not installed there; CLI installation returned 403. A direct diagnostic request with the OAuth token and Playground selector returned 401. No successful Playground inference is claimed. |

The refresh run used the original expiry without changing timestamps or manually exchanging a refresh token. Vercel introspection reported the old access and refresh tokens inactive immediately after rotation and the replacement tokens active. Gateway expiry enforcement has an unresolved timing observation: the first direct old-token request returned HTTP 200 about five seconds after nominal expiry (the response body was not retained); a retry about 82 seconds after expiry returned HTTP 401. Invalid-token and current-token controls returned HTTP 401 and HTTP 200 / `527`, respectively. Normal OpenCode inference continued across the original expiry time. The exact Gateway rejection cutoff and reason for the delay remain unverified; the successful refresh result does not establish immediate revocation or expiry enforcement.

The live test app requires team installation with Team Read and AI Gateway Use. Although the user selected Internal Playground during browser authorization, the app remained installed only on the personal team. The OAuth team-list API returned only that personal team, which was the only choice in OpenCode. A Playground admin must install the test app before a fresh connection can verify the requested billing team. The diagnostic Gateway call was separate from the OpenCode inference path and failed authorization.

Release checks also include the maintainer-owned client configuration, Windows/Linux behavior, headless/remote callback reachability, and cross-team/SSO/MFA consent. They are not established by this macOS personal-team test.
