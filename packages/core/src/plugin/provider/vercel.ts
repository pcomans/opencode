import { Clock, Deferred, Effect, Schema } from "effect"
import type { Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { ServerResponse } from "node:http"
import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"

const methodID = Integration.MethodID.make("gateway-oauth")
const issuer = "https://vercel.com"
const Discovery = Schema.Struct({
  authorization_endpoint: Schema.NonEmptyString,
  token_endpoint: Schema.NonEmptyString,
})
const PositiveSeconds = Schema.Int.check(Schema.isGreaterThan(0))
const Token = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: PositiveSeconds,
})
const OAuthError = Schema.Struct({ error: Schema.String })
const Context = Schema.Struct({ clientID: Schema.NonEmptyString, tokenEndpoint: Schema.NonEmptyString })
const Team = Schema.Struct({
  id: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  limited: Schema.optional(Schema.Boolean),
})
const Teams = Schema.Struct({
  teams: Schema.Array(Team),
  pagination: Schema.Struct({ next: Schema.NullOr(Schema.Number) }),
})

export const VercelPlugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "opencode.provider.vercel",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: "vercel",
        method: { id: methodID, type: "oauth", label: "Sign in with Vercel" },
        authorize: () =>
          Effect.gen(function* () {
            const clientID = process.env.OPENCODE_VERCEL_CLIENT_ID ?? "REPLACE_ME"
            const discovery = yield* send(
              http,
              HttpClientRequest.get("https://vercel.com/.well-known/openid-configuration"),
            ).pipe(
              Effect.flatMap(success),
              Effect.flatMap((response) => decode(response, Discovery)),
            )
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const challenge = Buffer.from(
              yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
            ).toString("base64url")
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const callback = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
            const { createServer } = yield* Effect.promise(() => import("node:http"))
            const { EventEmitter } = yield* Effect.promise(() => import("node:events"))
            const server = createServer((request, response) => {
              const url = new URL(request.url ?? "/", "http://127.0.0.1")
              if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
                response.writeHead(404).end()
                return
              }
              if (
                url.searchParams.get("state") !== state ||
                (url.searchParams.has("iss") && url.searchParams.get("iss") !== issuer)
              ) {
                response.writeHead(400).end("Invalid OAuth callback")
                return
              }
              const error = url.searchParams.has("error")
                ? "Vercel sign-in was denied. Start sign-in again when ready."
                : !url.searchParams.get("code")?.trim()
                  ? "Vercel did not return an authorization code. Start sign-in again."
                  : undefined
              if (error) {
                response
                  .writeHead(400, { "Content-Type": "text/html" })
                  .end(OauthCallbackPage.error(error, { provider: "Vercel" }))
                Effect.runSync(Deferred.fail(callback, new Error(error)))
                return
              }
              if (!Effect.runSync(Deferred.succeed(callback, { code: url.searchParams.get("code") ?? "", response })))
                response.writeHead(409).end("OAuth callback already received")
            })
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                server.close()
                server.closeAllConnections()
              }),
            )
            yield* Effect.tryPromise({
              try: () => EventEmitter.once(server.listen(0, "127.0.0.1"), "listening"),
              catch: () => new Error("Could not start the local Vercel sign-in callback. Try signing in again."),
            })
            const address = server.address()
            if (!address || typeof address === "string")
              return yield* Effect.fail(new Error("Missing Vercel OAuth callback port"))
            const redirect = `http://127.0.0.1:${address.port}/oauth/callback`
            const context = { clientID, tokenEndpoint: discovery.token_endpoint }
            return {
              mode: "auto" as const,
              url: `${discovery.authorization_endpoint}?${new URLSearchParams({
                response_type: "code",
                client_id: clientID,
                redirect_uri: redirect,
                // AI Gateway → Use is configured on the app; offline_access requests refresh tokens.
                scope: "openid offline_access",
                code_challenge: challenge,
                code_challenge_method: "S256",
                state,
              })}`,
              instructions:
                "Sign in to Vercel in your browser. Then return to OpenCode to choose the team billed for AI Gateway usage.",
              callback: Effect.gen(function* () {
                const request = yield* Deferred.await(callback)
                return yield* form(http, context.tokenEndpoint, {
                  grant_type: "authorization_code",
                  client_id: clientID,
                  code: request.code,
                  redirect_uri: redirect,
                  code_verifier: verifier,
                }).pipe(
                  Effect.flatMap(success),
                  Effect.flatMap((response) => decode(response, Token)),
                  Effect.flatMap((token) => credential(token, context)),
                  // Authorization is finished; saving still requires billing-team confirmation in OpenCode.
                  Effect.tap(() =>
                    Effect.sync(() =>
                      request.response.writeHead(200, { "Content-Type": "text/html" }).end(OauthCallbackPage.success()),
                    ),
                  ),
                  Effect.tapError((error) =>
                    Effect.sync(() =>
                      request.response
                        .writeHead(400, { "Content-Type": "text/html" })
                        .end(OauthCallbackPage.error(error.message, { provider: "Vercel" })),
                    ),
                  ),
                  Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
                )
              }),
            }
          }),
        experimental: {
          setup: (value) =>
            Effect.gen(function* () {
              const teams = (yield* listTeams(http, value.access)).filter((team) => !team.limited)
              if (!teams.length)
                return yield* Effect.fail(
                  new Error(
                    "No authorized Vercel teams are available. Sign in again and authorize a team with Team Read and AI Gateway Use access.",
                  ),
                )
              return {
                fields: [
                  {
                    key: "teamID",
                    type: "string" as const,
                    title: "Choose a billing team",
                    description: "AI Gateway usage will be billed to this Vercel team.",
                    required: true,
                    ...(teams.length === 1 ? { default: teams[0].id } : {}),
                    options: teams.map((team) => ({ value: team.id, label: team.name, description: team.slug })),
                  },
                ] as const,
                complete: (answer: Form.Answer) => {
                  const team = teams.find((team) => team.id === answer.teamID)
                  if (!team) return Effect.fail(new Error("Choose an authorized Vercel billing team."))
                  return Effect.succeed(
                    Credential.OAuth.make({
                      ...value,
                      metadata: { ...value.metadata, teamID: team.id, teamSlug: team.slug, teamName: team.name },
                    }),
                  )
                },
              }
            }),
        },
        label: (value) => (typeof value.metadata?.teamName === "string" ? value.metadata.teamName : undefined),
        refresh: (value) =>
          Effect.gen(function* () {
            const context = yield* Schema.decodeUnknownEffect(Context)(value.metadata)
            const response = yield* form(http, context.tokenEndpoint, {
              grant_type: "refresh_token",
              client_id: context.clientID,
              refresh_token: value.refresh,
            })
            if (response.status < 200 || response.status >= 300) {
              const error = yield* decode(response, OAuthError)
              if (error.error === "invalid_grant") {
                return yield* Effect.fail(
                  new Error("Vercel sign-in expired or was revoked. Sign in with Vercel again."),
                )
              }
              return yield* Effect.fail(
                new Error(`Vercel authorization failed (${response.status}). Check the app configuration.`),
              )
            }
            const token = yield* decode(response, Token)
            return yield* credential(token, { ...value.metadata, ...context })
          }),
      })
      editor.method.update({ integrationID: "vercel", method: { type: "key", label: "Use an existing API key" } })
    })
  }),
})

function listTeams(
  http: HttpClient.HttpClient,
  access: string,
  until?: number,
): Effect.Effect<ReadonlyArray<typeof Team.Type>, unknown> {
  return Effect.gen(function* () {
    const response = yield* send(
      http,
      HttpClientRequest.get("https://api.vercel.com/v2/teams").pipe(
        HttpClientRequest.bearerToken(access),
        HttpClientRequest.setUrlParams({ limit: "100", ...(until === undefined ? {} : { until: String(until) }) }),
      ),
    )
    if (response.status === 403)
      return yield* Effect.fail(
        new Error("Vercel team discovery requires Team Read permission. Update the OAuth app and sign in again."),
      )
    const page = yield* success(response).pipe(Effect.flatMap((response) => decode(response, Teams)))
    if (page.pagination.next === null) return page.teams
    return [...page.teams, ...(yield* listTeams(http, access, page.pagination.next))]
  })
}

function credential(token: typeof Token.Type, metadata: Readonly<Record<string, unknown>>) {
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) =>
      Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: token.access_token,
        refresh: token.refresh_token,
        expires: now + token.expires_in * 1000,
        metadata,
      }),
    ),
  )
}

function form(http: HttpClient.HttpClient, url: string, params: Record<string, string>) {
  return send(http, HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(params)))
}

function send(http: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest) {
  return http.execute(request).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(() => new Error("Could not reach Vercel. Check your connection and retry.")),
  )
}

function success(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<HttpClientResponse.HttpClientResponse, Error> {
  return response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(new Error(`Vercel authorization failed (${response.status}). Check the app configuration.`))
}

function decode<S extends Schema.Decoder<unknown>>(response: HttpClientResponse.HttpClientResponse, schema: S) {
  return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    // Schema errors include the rejected input, which can contain access or refresh tokens.
    Effect.mapError(
      () => new Error("Vercel returned an invalid OAuth response. Check the app's permissions and retry."),
    ),
  )
}
