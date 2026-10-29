import { Clock, Effect, Schema } from "effect"
import type { Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"

const methodID = Integration.MethodID.make("gateway-oauth")
const Discovery = Schema.Struct({
  device_authorization_endpoint: Schema.NonEmptyString,
  token_endpoint: Schema.NonEmptyString,
})
const PositiveSeconds = Schema.Int.check(Schema.isGreaterThan(0))
const Device = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
  verification_uri_complete: Schema.optional(Schema.NonEmptyString),
  expires_in: PositiveSeconds,
  interval: Schema.optional(PositiveSeconds),
})
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
            const clientID = process.env.OPENCODE_VERCEL_CLIENT_ID ?? "cl_EcnZcQYlrTXOllm0dj3nqEWQDE5FSLcd"
            const discovery = yield* send(
              http,
              HttpClientRequest.get("https://vercel.com/.well-known/openid-configuration"),
            ).pipe(
              Effect.flatMap(success),
              Effect.flatMap((response) => decode(response, Discovery)),
            )
            const device = yield* form(http, discovery.device_authorization_endpoint, {
              client_id: clientID,
              // AI Gateway → Use is configured on the app; offline_access requests refresh tokens.
              scope: "openid offline_access",
            }).pipe(
              Effect.flatMap(success),
              Effect.flatMap((response) => decode(response, Device)),
            )
            const context = { clientID, tokenEndpoint: discovery.token_endpoint }
            const expiresAt = (yield* Clock.currentTimeMillis) + device.expires_in * 1000
            return {
              mode: "auto" as const,
              url: device.verification_uri_complete ?? device.verification_uri,
              instructions: `Sign in to Vercel and enter code ${device.user_code}. Then return to OpenCode to choose the team billed for AI Gateway usage.`,
              expiresAt,
              callback: poll(http, device.device_code, context, expiresAt, (device.interval ?? 5) * 1000).pipe(
                Effect.flatMap((token) => credential(token, context)),
              ),
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

function poll(
  http: HttpClient.HttpClient,
  deviceCode: string,
  context: typeof Context.Type,
  expiresAt: number,
  interval: number,
): Effect.Effect<typeof Token.Type, unknown> {
  return Effect.gen(function* () {
    yield* Effect.sleep(interval)
    if ((yield* Clock.currentTimeMillis) >= expiresAt) {
      return yield* Effect.fail(new Error("Vercel sign-in expired. Start sign-in again."))
    }
    const response = yield* form(http, context.tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: context.clientID,
      device_code: deviceCode,
    })
    if (response.status >= 200 && response.status < 300) return yield* decode(response, Token)
    const error = yield* decode(response, OAuthError)
    if (error.error === "authorization_pending") return yield* poll(http, deviceCode, context, expiresAt, interval)
    if (error.error === "slow_down") return yield* poll(http, deviceCode, context, expiresAt, interval + 5000)
    return yield* Effect.fail(
      new Error(
        error.error === "access_denied"
          ? "Vercel sign-in was denied. Start sign-in again when ready."
          : error.error === "expired_token"
            ? "Vercel sign-in expired. Start sign-in again."
            : "Vercel sign-in failed. Try again.",
      ),
    )
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
