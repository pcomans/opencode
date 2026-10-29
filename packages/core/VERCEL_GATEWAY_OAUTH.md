# Vercel AI Gateway with OAuth

OpenCode opens Vercel sign-in in the user's browser, receives an authorization code through a temporary loopback listener, and exchanges it using PKCE. After the user confirms a billing team, OpenCode saves the app's access and refresh tokens. Inference uses the access token directly with that team's selector. No AI Gateway API key is created.

## App registration

OpenCode users authorize one maintainer-owned Sign in with Vercel app; they do not create individual OAuth apps.

- Configure a public client with client authentication set to `none`. Never bundle a client secret in the CLI or desktop app.
- Enable the `authorization_code` and `refresh_token` grants, plus `openid` and `offline_access` scopes.
- Register `http://127.0.0.1/oauth/callback` as an authorization callback URL. OpenCode binds an available port before opening sign-in and includes that port in the redirect URI. Confirm Vercel accepts an ephemeral port for the release app.
- Enable **Team → Read** (`read:team`) and **AI Gateway → Use** (`use:ai-gateway`). Install the app on the intended billing team with both permissions if the app requires installation. No API-key management permission is needed.
- Set `OPENCODE_VERCEL_CLIENT_ID` in the OpenCode server's environment. Replace the source default `REPLACE_ME` with the maintainer-owned client ID before release.
- Verify the release app's permission eligibility, installation policy, and permission display in the consent screen with Vercel.

The loopback listener follows the existing OpenCode browser-provider pattern. It requires neither a custom URL-scheme registration nor a publicly hosted callback service. Authorization and token requests to Vercel use HTTPS; the HTTP callback targets only `127.0.0.1`. See [Vercel's authorization-server API](https://vercel.com/docs/sign-in-with-vercel/authorization-server-api) and [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3).

## Sign-in and billing

1. Choose Vercel AI Gateway, then **Sign in with Vercel**.
2. Complete browser sign-in and consent. Vercel redirects the browser to the waiting local listener; no device code is entered.
3. Return to OpenCode and confirm an authorized billing team. A single available team still requires confirmation.
4. Select a Gateway model and send a prompt.

The callback validates a per-attempt `state` and the issuer when supplied. The token exchange includes the matching PKCE verifier and exact redirect URI, with no client secret. Unrelated callbacks do not consume the attempt. The listener closes when the attempt completes, fails, expires, or is cancelled.

OpenCode lists authorized teams with paginated `GET /v2/teams`, excluding limited-access teams. Access and refresh tokens stay on the server while the user chooses a team; attempt status exposes only form fields. Cancelling before confirmation saves no new credential and preserves existing connections.

Each saved connection includes the billing team and original OAuth client ID. Native Gateway requests use the OAuth bearer token and `x-vercel-ai-gateway-team`. Switching connections switches both values. To choose a different team, add another connection. Manual API keys and environment credentials remain available.

The browser must be able to reach the machine running the OpenCode server's loopback listener. Local CLI, TUI, and desktop sessions use the same flow. A remote server needs an explicit callback tunnel or a browser on that machine; this alternative does not add a device-flow fallback.

## Silent refresh

When a saved connection is used within five minutes of access-token expiry, OpenCode refreshes it on the server without opening the browser. This is renewal on use, not a timer that refreshes idle connections indefinitely.

OpenCode saves both returned tokens on the same credential ID and preserves its label, billing team, and original client binding. The existing credential lock coordinates refresh. A refresh failure preserves the saved connection; an expired or revoked refresh token requires sign-in again. User-facing exchange and decoding errors exclude token response bodies.

Both device and authorization-code grants produce the same credential shape and use this refresh path. A prior device-grant live test demonstrated natural near-expiry rotation and successful inference without browser consent. That result does not by itself verify authorization-code sign-in or a new grant's refresh behavior.

## Verification

See the [execution plan](VERCEL_GATEWAY_OAUTH_TEST_PLAN.md) for live and automated coverage, including unverified checks.

From `packages/core`:

```sh
bun run script/test.ts test/plugin/provider-vercel.test.ts
```

The provider tests exercise real loopback sockets, the integration state machine, credential storage, and native Gateway request construction, with fixture responses for Vercel. They cover PKCE, callback validation, denial, missing code, cancellation, concurrent attempts, replay, team selection, token-response failures, and refresh rotation. They do not constitute real Vercel sign-in or model inference.
