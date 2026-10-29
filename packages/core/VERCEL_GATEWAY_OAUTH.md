# Vercel AI Gateway with OAuth

OpenCode's inference-only Vercel integration signs users in with Vercel and sends the resulting app access token directly to AI Gateway. It saves OAuth credentials and refreshes them before they expire, using the existing integration credential store and refresh lock. It does not create AI Gateway API keys.

## OpenCode-owned app registration

OpenCode uses a shared Sign in with Vercel app owned by its maintainers. Individual OpenCode users authorize that shared app; they do not register their own apps. An OpenCode-owned app has been registered, but its required grants and API permission still need Vercel-side activation.

- Configure the app as a **public client**, with client authentication set to **`none`**. Do not distribute a client secret with the desktop app or CLI.
- Enable the **AI Gateway → Use** permission (`use:ai-gateway`). This integration does not require Team Read, AI Gateway API Keys Read and Write, or budget-management permissions.
- Enable the `openid` and `offline_access` scopes. The authorization request sends these identity/token-lifecycle scopes; the AI Gateway resource permission is configured on the app.
- Confirm with Vercel that the OpenCode-owned public client can use the device authorization grant and refresh tokens. Public Sign in with Vercel documentation describes authorization-code and refresh grants; it does not establish third-party device-grant eligibility.
- Set `OPENCODE_VERCEL_CLIENT_ID` in the **OpenCode server's environment**, or replace the default `REPLACE_ME` client ID before release. No borrowed client ID is included.

**Private-beta access is still a release requirement unless Vercel confirms otherwise.** Vercel currently lists AI Gateway → Use in the API permissions section marked private beta. The narrower permission does not, by itself, establish general availability.

## Connection and refresh

1. Choose Vercel AI Gateway and **Sign in with Vercel**.
2. Open the Vercel authorization link and enter the displayed device code if requested.
3. Grant the app AI Gateway access in Vercel and return to OpenCode.
4. Select a Gateway model. OpenCode uses the app access token as a bearer token for inference.

There are no team-listing, key-naming, key-expiration, or key-replacement steps. The Vercel authorization grant determines the resources the app can use; OpenCode does not request additional permissions to enumerate teams or manage keys. Confirm the intended team and billing behavior with Vercel when validating the registered app.

Vercel documents one-hour access tokens and rotating, single-use refresh tokens. OpenCode refreshes credentials within five minutes of access-token expiry and saves both newly returned tokens on the same connection. The original app client ID and token endpoint remain attached to that credential, so a later environment change does not send its refresh token under a different client ID.

If the refresh token expires or is revoked, sign in with Vercel again. Failed refreshes do not delete the existing credential. Token exchange and decoding errors do not include token response bodies in user-facing errors.

Manual API-key entry and environment-variable credentials remain available for users who prefer them.

## Verification

From `packages/core`:

```sh
bun run script/test.ts test/plugin/provider-vercel.test.ts
```

The tests use fixture HTTP responses, the real integration state machine and credential store, a controlled clock, and the native Gateway request path. They cover sign-in, bearer-token inference, refresh rotation, client binding, cancellation, polling delays, denied authorization, expired codes, and missing refresh tokens. They do not sign in to Vercel or make real model requests.

Before release, validate the registered app end to end: consent and billed-team selection, a real inference request with the app token, refresh-token rotation, and reauthentication after revocation. The fixture tests cannot establish permission eligibility, device-grant availability, or live Gateway acceptance for a new app.

Confirm with Vercel whether beta enablement is needed only for the app owner's team or also for teams authorizing the app. A public sign-in setting does not establish API-permission eligibility for every user's team.

## References

- [Sign in with Vercel app registration](https://vercel.com/docs/sign-in-with-vercel/manage-from-dashboard)
- [Scopes and API permissions](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions)
- [Access and refresh tokens](https://vercel.com/docs/sign-in-with-vercel/tokens)
- [Authorization server API](https://vercel.com/docs/sign-in-with-vercel/authorization-server-api)
