import { describe, expect } from "bun:test"
import { Cause, Clock, Effect, Exit, Fiber, Layer, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { LLM } from "@opencode/ai/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { VercelPlugin } from "@opencode/core/plugin/provider/vercel"
import { Provider } from "@opencode/core/provider"
import { withEnv } from "../fixture/env"
import { advance } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("vercel")
const methodID = Integration.MethodID.make("gateway-oauth")
const tokenEndpoint = "https://api.vercel.com/login/oauth/token"
const team = { id: "team_work", slug: "work", name: "Work" }
const token = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 }
const invalidTokens = [
  { name: "missing refresh token", body: { ...token, refresh_token: undefined } },
  { name: "empty access token", body: { ...token, access_token: "" } },
  { name: "malformed token body", body: null },
  {
    name: "malformed token JSON",
    body: `{"access_token":"${token.access_token}","refresh_token":"${token.refresh_token}",`,
  },
  { name: "missing token lifetime", body: { ...token, expires_in: undefined } },
  { name: "string token lifetime", body: { ...token, expires_in: "3600" } },
  { name: "zero token lifetime", body: { ...token, expires_in: 0 } },
  { name: "negative token lifetime", body: { ...token, expires_in: -1 } },
  { name: "fractional token lifetime", body: { ...token, expires_in: 0.5 } },
].map((scenario) => ({ ...scenario, status: 200, message: "invalid OAuth response" }))

function backend() {
  const requests: {
    method: string
    url: string
    body: string
    authorization: string | null
    team: string | null
    time: number
  }[] = []
  const replies = {
    device: {
      device_code: "test-device",
      user_code: "TEST-CODE",
      verification_uri: "https://vercel.com/oauth/device",
      verification_uri_complete: "https://vercel.com/oauth/device?user_code=TEST-CODE",
      expires_in: 300,
      interval: 1,
    },
    tokens: [{ status: 200, body: token }] as { status: number; body: unknown }[],
    teams: [{ status: 200, body: { teams: [team], pagination: { next: null } } }] as {
      status: number
      body: unknown
    }[],
  }
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const body = yield* Effect.promise(() => web.text())
      requests.push({
        method: web.method,
        url: web.url,
        body,
        authorization: web.headers.get("authorization"),
        team: web.headers.get("x-vercel-ai-gateway-team"),
        time: yield* Clock.currentTimeMillis,
      })
      const response = (() => {
        if (web.url === "https://vercel.com/.well-known/openid-configuration") {
          return Response.json({
            device_authorization_endpoint: "https://api.vercel.com/login/oauth/device-authorization",
            token_endpoint: tokenEndpoint,
          })
        }
        if (web.url.endsWith("/device-authorization")) return Response.json(replies.device)
        if (web.url === tokenEndpoint) {
          const reply = replies.tokens.shift()
          if (!reply) return new Response(null, { status: 500 })
          // String fixtures provide raw response bodies for JSON decoding failures.
          return typeof reply.body === "string"
            ? new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } })
            : Response.json(reply.body, { status: reply.status })
        }
        if (web.url.startsWith("https://api.vercel.com/v2/teams?")) {
          const reply = replies.teams.shift()
          return reply ? Response.json(reply.body, { status: reply.status }) : new Response(null, { status: 500 })
        }
        if (web.url === "https://ai-gateway.vercel.sh/v1/responses") {
          return new Response('data: {"type":"response.completed","response":{"id":"resp_fixture"}}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
        }
        return new Response(null, { status: 404 })
      })()
      return HttpClientResponse.fromWeb(request, response)
    }),
  )
  return { requests, replies, client }
}

const register = Effect.fn(function* (client: HttpClient.HttpClient) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* VercelPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, client))
  return yield* Integration.Service
})

const ready = Effect.fn(function* (integrations: Integration.Interface, attemptID: Integration.AttemptID) {
  const state = { status: yield* integrations.oauth.status({ integrationID, attemptID }) }
  const polling = yield* integrations.oauth.status({ integrationID, attemptID }).pipe(
    Effect.repeat({
      while: (value) => value.status === "pending" && !value.experimental?.setup,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.tap((value) =>
      Effect.sync(() => {
        state.status = value
      }),
    ),
    Effect.forkChild({ startImmediately: true }),
  )
  yield* advance(() => state.status.status !== "pending" || !!state.status.experimental?.setup)
  return yield* Fiber.join(polling)
})

const terminal = Effect.fn(function* (integrations: Integration.Interface, attemptID: Integration.AttemptID) {
  const status = yield* ready(integrations, attemptID)
  if (status.status !== "pending") return status
  yield* integrations.oauth.complete({ integrationID, attemptID, experimental: { answer: { teamID: team.id } } })
  return yield* integrations.oauth.status({ integrationID, attemptID })
})

describe("Vercel OAuth", () => {
  it.effect("registers sign-in alongside existing key and environment credentials", () =>
    Effect.gen(function* () {
      const server = backend()
      const integrations = yield* Integration.Service
      yield* integrations.transform((editor) => {
        editor.method.update({ integrationID, method: { type: "env", names: ["AI_GATEWAY_API_KEY"] } })
      })
      yield* register(server.client)
      const integration = yield* integrations.get(integrationID)
      expect(integration?.methods).toContainEqual({ id: methodID, type: "oauth", label: "Sign in with Vercel" })
      expect(integration?.methods).toContainEqual({ type: "key", label: "Use an existing API key" })
      expect(
        integration?.methods.some((method) => method.type === "env" && method.names.includes("AI_GATEWAY_API_KEY")),
      ).toBe(true)
      expect(server.requests).toEqual([])
    }),
  )

  it.effect("stores refreshable app tokens and uses the access token directly for inference", () =>
    withEnv({ OPENCODE_VERCEL_CLIENT_ID: "test-opencode-app", AI_GATEWAY_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const server = backend()
        const integrations = yield* register(server.client)
        const credentials = yield* Credential.Service
        const attempt = yield* integrations.oauth.connect({ integrationID, methodID, label: "Work" })
        expect(attempt.url).toBe(server.replies.device.verification_uri_complete)
        expect(attempt.instructions).toContain("TEST-CODE")
        expect(new URLSearchParams(server.requests[1]?.body)).toEqual(
          new URLSearchParams({ client_id: "test-opencode-app", scope: "openid offline_access" }),
        )
        const setup = yield* ready(integrations, attempt.attemptID)
        expect(setup).toMatchObject({ status: "pending", experimental: { setup: [{ options: [{ value: team.id }] }] } })
        expect(yield* credentials.list(integrationID)).toEqual([])
        expect(JSON.stringify(setup)).not.toContain(token.access_token)
        const invalid = yield* integrations.oauth
          .complete({
            integrationID,
            attemptID: attempt.attemptID,
            experimental: { answer: { teamID: "team_unauthorized" } },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(invalid)).toBe(true)
        const status = yield* terminal(integrations, attempt.attemptID)
        expect(status.status).toBe("complete")
        const stored = (yield* credentials.list(integrationID))[0]
        expect(stored?.label).toBe("Work")
        expect(stored?.value).toMatchObject({
          type: "oauth",
          methodID,
          access: token.access_token,
          refresh: token.refresh_token,
          metadata: { clientID: "test-opencode-app", tokenEndpoint, teamID: team.id, teamSlug: team.slug },
        })
        expect(JSON.stringify(status)).not.toContain(token.access_token)
        expect(JSON.stringify(status)).not.toContain(token.refresh_token)
        const selected = Model.Info.make({
          ...Model.Info.default(Provider.ID.make("vercel"), Model.ID.make("openai/gpt-fixture")),
          package: "@opencode/ai/providers/vercel-ai-gateway",
        })
        const resolved = yield* ModelResolver.resolveModel(selected, undefined, stored?.value)
        yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
          Stream.runDrain,
          Effect.provide(
            Layer.fresh(
              LLMClient.layer.pipe(
                Layer.provide(RequestExecutor.layer),
                Layer.provide(Layer.succeed(HttpClient.HttpClient, server.client)),
              ),
            ),
          ),
        )
        expect(server.requests.at(-1)?.authorization).toBe(`Bearer ${token.access_token}`)
        expect(server.requests.at(-1)?.team).toBe(team.id)
        expect(server.requests.some((request) => /\/api-keys/.test(request.url))).toBe(false)
        expect(server.requests.find((request) => request.url.includes("/v2/teams"))?.authorization).toBe(
          `Bearer ${token.access_token}`,
        )
      }),
    ),
  )

  it.effect("rotates refresh tokens while preserving the connection ID, label, and original OAuth client", () =>
    withEnv({ OPENCODE_VERCEL_CLIENT_ID: "a-different-current-app" }, () =>
      Effect.gen(function* () {
        const server = backend()
        const credentials = yield* Credential.Service
        const stored = yield* credentials.create({
          integrationID,
          label: "Work",
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "expired-access",
            refresh: "single-use-refresh",
            expires: 0,
            metadata: { clientID: "original-app", tokenEndpoint, custom: "keep", teamID: team.id, teamSlug: team.slug },
          }),
        })
        const integrations = yield* register(server.client)
        const connection = yield* integrations.connection.active(integrationID)
        if (!connection) throw new Error("Expected stored connection")
        const value = yield* integrations.connection.resolve(connection)
        expect(new URLSearchParams(server.requests[0]?.body)).toEqual(
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "original-app",
            refresh_token: "single-use-refresh",
          }),
        )
        expect(value).toMatchObject({ type: "oauth", access: token.access_token, refresh: token.refresh_token })
        expect(yield* credentials.get(stored.id)).toMatchObject({
          id: stored.id,
          label: "Work",
          value: {
            ...value,
            metadata: { clientID: "original-app", tokenEndpoint, custom: "keep", teamID: team.id, teamSlug: team.slug },
          },
        })
        expect(yield* integrations.connection.resolve(connection)).toEqual(value)
        expect(server.requests).toHaveLength(1)
      }),
    ),
  )
  ;[
    {
      name: "revoked refresh token",
      status: 400,
      body: { error: "invalid_grant" },
      message: "Sign in with Vercel again",
    },
    {
      name: "OAuth error",
      status: 400,
      body: { error: "invalid_client", error_description: `${token.access_token} ${token.refresh_token}` },
      message: "Vercel authorization failed (400)",
    },
    {
      name: "server error",
      status: 500,
      body: { error: "server_error" },
      message: "Vercel authorization failed (500)",
    },
    {
      name: "malformed OAuth error",
      status: 400,
      body: { error: 123, access_token: token.access_token, refresh_token: token.refresh_token },
      message: "invalid OAuth response",
    },
    ...invalidTokens,
  ].forEach((scenario) =>
    it.effect(`rejects ${scenario.name} during refresh without changing the saved connection`, () =>
      Effect.gen(function* () {
        const server = backend()
        server.replies.tokens = [scenario]
        const credentials = yield* Credential.Service
        const stored = yield* credentials.create({
          integrationID,
          label: "Saved work connection",
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "expired-access",
            refresh: "saved-refresh",
            expires: 0,
            metadata: { clientID: "original-app", tokenEndpoint, teamID: team.id, teamSlug: team.slug },
          }),
        })
        const integrations = yield* register(server.client)
        const connection = yield* integrations.connection.active(integrationID)
        if (!connection) throw new Error("Expected stored connection")
        const result = yield* integrations.connection.resolve(connection).pipe(Effect.exit)
        if (Exit.isSuccess(result)) throw new Error("Expected refresh to fail")
        const message = Cause.pretty(result.cause)
        expect(message).toContain(scenario.message)
        expect(message).not.toContain(token.access_token)
        expect(message).not.toContain(token.refresh_token)
        expect(message).not.toContain("expired-access")
        expect(message).not.toContain("saved-refresh")
        expect(yield* credentials.list(integrationID)).toEqual([stored])
        expect(yield* integrations.connection.active(integrationID)).toEqual(connection)
      }),
    ),
  )

  it.effect("honors pending and slow-down replies before storing a credential", () =>
    Effect.gen(function* () {
      const server = backend()
      server.replies.tokens.unshift(
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down" } },
      )
      const integrations = yield* register(server.client)
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
      expect((yield* terminal(integrations, attempt.attemptID)).status).toBe("complete")
      const polls = server.requests.filter((request) => request.url === tokenEndpoint)
      expect(polls).toHaveLength(3)
      expect(polls[2]!.time - polls[1]!.time).toBeGreaterThanOrEqual(6000)
    }),
  )

  it.effect("cancels device polling without creating credentials", () =>
    Effect.gen(function* () {
      const server = backend()
      const integrations = yield* register(server.client)
      const credentials = yield* Credential.Service
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
      yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
      yield* TestClock.adjust("10 seconds")
      expect(server.requests.filter((request) => request.url === tokenEndpoint)).toEqual([])
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("paginates authorized teams and requires an explicit choice when several are available", () =>
    Effect.gen(function* () {
      const server = backend()
      server.replies.teams = [
        {
          status: 200,
          body: {
            teams: [team, { id: "team_sso", slug: "sso", name: "SSO", limited: true }],
            pagination: { next: 123 },
          },
        },
        {
          status: 200,
          body: { teams: [{ id: "team_other", slug: "other", name: "Other" }], pagination: { next: null } },
        },
      ]
      const integrations = yield* register(server.client)
      const credentials = yield* Credential.Service
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
      const status = yield* ready(integrations, attempt.attemptID)
      if (status.status !== "pending") throw new Error("Expected team choice")
      expect(status.experimental?.setup).toEqual([
        expect.objectContaining({
          options: [
            { value: team.id, label: team.name, description: team.slug },
            { value: "team_other", label: "Other", description: "other" },
          ],
        }),
      ])
      expect(status.experimental?.setup[0]).not.toHaveProperty("default")
      expect(server.requests.some((request) => request.url.includes("until=123"))).toBe(true)
      yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )
  ;[
    { name: "missing team permission", status: 403, body: {}, message: "Team Read" },
    {
      name: "no authorized teams",
      status: 200,
      body: { teams: [], pagination: { next: null } },
      message: "No authorized",
    },
    {
      name: "only limited teams",
      status: 200,
      body: { teams: [{ ...team, limited: true }], pagination: { next: null } },
      message: "No authorized",
    },
    {
      name: "malformed team response",
      status: 200,
      body: { teams: [{ ...team, id: 123 }], pagination: { next: null } },
      message: "invalid OAuth response",
    },
    {
      name: "missing team pagination",
      status: 200,
      body: { teams: [team] },
      message: "invalid OAuth response",
    },
  ].forEach((scenario) =>
    it.effect(`rejects ${scenario.name} without saving credentials`, () =>
      Effect.gen(function* () {
        const server = backend()
        server.replies.teams = [scenario]
        const integrations = yield* register(server.client)
        const credentials = yield* Credential.Service
        const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
        expect(yield* terminal(integrations, attempt.attemptID)).toMatchObject({
          status: "failed",
          message: expect.stringContaining(scenario.message),
        })
        expect(yield* credentials.list(integrationID)).toEqual([])
      }),
    ),
  )

  const failures = [
    { name: "denied sign-in", status: 400, body: { error: "access_denied" }, message: "denied" },
    { name: "expired device code", status: 400, body: { error: "expired_token" }, message: "expired" },
    {
      name: "generic OAuth error",
      status: 400,
      body: { error: "invalid_client", error_description: `${token.access_token} ${token.refresh_token}` },
      message: "Vercel sign-in failed",
    },
    {
      name: "token server error",
      status: 500,
      body: { error: "server_error" },
      message: "Vercel sign-in failed",
    },
    {
      name: "malformed OAuth error",
      status: 400,
      body: { error: 123, access_token: token.access_token, refresh_token: token.refresh_token },
      message: "invalid OAuth response",
    },
    ...invalidTokens,
  ]
  failures.forEach((scenario) =>
    it.effect(`rejects ${scenario.name} without saving a partial credential`, () =>
      Effect.gen(function* () {
        const server = backend()
        server.replies.tokens = [scenario]
        const integrations = yield* register(server.client)
        const credentials = yield* Credential.Service
        const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
        const status = yield* terminal(integrations, attempt.attemptID)
        expect(status).toMatchObject({
          status: "failed",
          message: expect.stringContaining(scenario.message),
        })
        expect(JSON.stringify(status)).not.toContain(token.access_token)
        expect(JSON.stringify(status)).not.toContain(token.refresh_token)
        expect(yield* credentials.list(integrationID)).toEqual([])
      }),
    ),
  )
})
