# Vercel AI Gateway with OAuth

OpenCode signs users in with Vercel, asks them to choose an authorized billing team, and sends the app access token directly to AI Gateway with that team's selector. It saves OAuth credentials and refreshes them before they expire, using the existing integration credential store and refresh lock. It does not create AI Gateway API keys.

## OpenCode-owned app registration

OpenCode uses a shared Sign in with Vercel app owned by its maintainers. Individual OpenCode users authorize that shared app; they do not register their own apps. The maintainer-owned client must have the required grants and API permissions activated by Vercel before release.

- Configure the app as a **public client**, with client authentication set to **`none`**. Do not distribute a client secret with the desktop app or CLI.
- Enable **AI Gateway → Use** (`use:ai-gateway`) and **Team → Read** (`read:team`). Team Read lets the app list teams available to the signed-in user. No API-key management or budget-management permissions are needed.
- Enable the `openid` and `offline_access` scopes. The authorization request sends these identity/token-lifecycle scopes; the AI Gateway resource permission is configured on the app.
- Confirm with Vercel that the OpenCode-owned public client can use the device authorization grant and refresh tokens. Public Sign in with Vercel documentation describes authorization-code and refresh grants; it does not establish third-party device-grant eligibility.
- Set `OPENCODE_VERCEL_CLIENT_ID` in the **OpenCode server's environment**, or replace the default `REPLACE_ME` client ID before release. No borrowed client ID is included.

**Private-beta access is still a release requirement unless Vercel confirms otherwise.** Vercel currently lists AI Gateway → Use in the API permissions section marked private beta. The narrower permission does not, by itself, establish general availability.

## Connection and refresh

1. Choose Vercel AI Gateway and **Sign in with Vercel**.
2. Open the Vercel authorization link and enter the displayed device code if requested.
3. Authorize the teams you want to use in Vercel and return to OpenCode.
4. Choose **a billing team** from the authorized teams. Even a single available team requires confirmation.
5. Select a Gateway model and send a prompt. OpenCode sends the app access token as a bearer token and the selected team ID in `x-vercel-ai-gateway-team`.

OpenCode lists teams with the new app token using the paginated `GET /v2/teams` API, excludes limited-access teams, and saves no credential until setup completes. If Team Read is missing or no authorized team is available, sign in again after fixing the app permissions or team authorization. Changing app permissions requires fresh consent.

The billing team belongs to the saved OAuth connection, alongside its original client ID. Switching connections switches both the token and team. To use a different team, add a connection and choose that team during setup. No global provider-header configuration or API-key creation is required.

The post-sign-in form is an experimental integration setup API, supported by desktop, TUI, and interactive CLI. Attempt status exposes only form fields; access and refresh tokens stay on the server. Cancelling or letting setup expire discards the pending credential.

Vercel documents one-hour access tokens and rotating, single-use refresh tokens. OpenCode refreshes credentials within five minutes of access-token expiry and saves both newly returned tokens on the same connection. The original app client ID and token endpoint remain attached to that credential, so a later environment change does not send its refresh token under a different client ID.

If the refresh token expires or is revoked, sign in with Vercel again. Failed refreshes do not delete the existing credential. Token exchange and decoding errors do not include token response bodies in user-facing errors.

Manual API-key entry and environment-variable credentials remain available for users who prefer them.

## Verification

From `packages/core`:

```sh
bun run script/test.ts test/plugin/provider-vercel.test.ts
```

The tests use fixture HTTP responses, the real integration state machine and credential store, a controlled clock, and the native Gateway request path. They cover sign-in, bearer-token inference, refresh rotation, client and team binding, team pagination, explicit choice, limited-team filtering, cancellation before and after consent, missing Team Read, empty team lists, polling delays, denied authorization, expired codes, and missing refresh tokens. They do not sign in to Vercel or make real model requests.

A personal test app completed real device sign-in and inference on 2026-10-29. The initial inference failed without a team selector; adding `x-vercel-ai-gateway-team` for an authorized team made both direct Gateway inference and the packaged OpenCode session succeed. This established the need for explicit team selection. It did not validate the new picker, the maintainer-owned release client, live refresh rotation, or live revocation.

Before release, validate the updated flow end to end: fresh consent with both permissions, the billing-team picker, a real inference request without a manually configured team header, refresh-token rotation, and reauthentication after revocation. The fixture tests cannot establish permission eligibility, device-grant availability, or live Gateway acceptance for a new app.

Confirm with Vercel whether beta enablement is needed only for the app owner's team or also for teams authorizing the app. A public sign-in setting does not establish API-permission eligibility for every user's team.

## References

- [Sign in with Vercel app registration](https://vercel.com/docs/sign-in-with-vercel/manage-from-dashboard)
- [Scopes and API permissions](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions)
- [Access and refresh tokens](https://vercel.com/docs/sign-in-with-vercel/tokens)
- [Authorization server API](https://vercel.com/docs/sign-in-with-vercel/authorization-server-api)
