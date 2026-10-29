# Authorization-code OAuth test plan

This plan belongs to the loopback authorization-code alternative. Prior device-flow results are separate evidence. A contract pass uses fixture Vercel responses; only a live pass establishes behavior against the real OAuth app and AI Gateway.

## Automated contracts

The Vercel provider suite passed **44 tests and 246 assertions** on macOS on 2026-10-29. Sign-in cases use actual loopback listeners and fixture upstream HTTP responses.

| Contract | Result |
| --- | --- |
| Authorization URL uses code grant, scopes, PKCE S256, state, and loopback redirect | Pass |
| Exchange uses matching verifier and redirect, with no client secret | Pass |
| Wrong/missing state, wrong issuer, path, or method cannot exchange a code; valid callback still succeeds | Pass |
| Denial and missing code fail without saving credentials or echoing provider details | Pass |
| Cancellation closes the listener, makes no token request, and preserves prior connection and active selection | Pass |
| Concurrent attempts have independent state and PKCE; reverse-order callbacks retain their labels | Pass |
| A callback replay cannot cause a second exchange; completed attempts release their listeners | Pass |
| Team pagination excludes limited teams and requires explicit confirmation | Pass |
| Invalid team selection retains pending setup without saving credentials | Pass |
| Native inference uses the OAuth bearer token and selected team; no API-key creation | Pass |
| Refresh rotates both tokens while preserving credential ID, label, metadata, and original client | Pass |
| Invalid exchange/refresh bodies and failures expose no tokens and preserve saved credentials | Pass |

The shared integration tests own attempt expiry, post-consent cancellation, and setup persistence. The existing CLI, TUI, and browser suites own their setup prompts. Regression verification against the new branch is in progress.

## Live execution

Use a fresh isolated profile and the real test app. Do not copy a rotating OAuth grant between profiles. Preserve the existing device-flow test profile and the installed daily app.

| Check | Result |
| --- | --- |
| Register the loopback callback on the public test app | Pass: Vercel accepted `http://127.0.0.1/oauth/callback` |
| Authorize with an ephemeral port and complete the real token exchange | Pending |
| Confirm a real billing team and persist access/refresh credentials | Pending |
| Run native Gateway inference with the saved connection | Pending |
| Add a second connection while preserving the first | Pending |
| Cancel before callback and verify listener and credential cleanup | Pending |
| Cancel after consent at the billing-team step; preserve saved connections | Pending |
| Exercise the real CLI browser flow and billing-team prompt | Pending |
| Verify natural near-expiry renewal of an authorization-code grant without browser consent, then inference | Pending |
| Capture the built desktop team picker and successful inference | Pending |

Release checks also include the maintainer-owned client configuration, Windows/Linux behavior, headless/remote callback reachability, and cross-team/SSO/MFA consent. They are not established by this macOS personal-team test.
