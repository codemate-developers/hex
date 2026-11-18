import { afterEach, describe, expect, it, vi } from "vitest"
import { makeClient } from "../src/client.js"
import type { HexError, StreamEvent } from "../src/index.js"
import { fixtureEndpoint } from "./support.js"

const ownerToken = `hex_${"0".repeat(64)}`

const started = (overrides: Record<string, unknown> = {}) => Response.json({
  id: 3,
  ownerToken,
  model: "parakeet_v3",
  language: "auto",
  sampleRate: 16_000,
  sampleFormat: "f32le",
  partials: true,
  leaseMs: 10_000,
  ...overrides,
}, { status: 201 })

const sse = (events: readonly unknown[]) => new Response(
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
)

const final = {
  text: "So the plan for today is the release.",
  segments: [{ segment: 0, startMs: 0, endMs: 7_420, text: "So the plan for today is the release." }],
  durationMs: 7_500,
}

const path = (input: unknown) => new URL(String(input)).pathname + new URL(String(input)).search

const collect = async (events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const seen: StreamEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

describe("streams", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("creates, pushes little-endian audio in bounded requests, reads events, and finishes once", async () => {
    const lifetime = new AbortController()
    const bodies: Array<{ path: string; body: ArrayBuffer; headers: Headers }> = []
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = path(input)
      bodies.push({ path: url, body: init?.body as ArrayBuffer, headers: new Headers(init?.headers) })
      if (url === "/streams") return started()
      if (url === "/streams/3/events") {
        return sse([
          { type: "ready", id: 3, model: "parakeet_v3", language: "auto", sampleFormat: "f32le", partials: true },
          { type: "partial", segment: 0, stable: "so the plan for", tentative: " today" },
          { type: "segment", ...final.segments[0] },
          { type: "final", ...final },
          { type: "segment", segment: 9, startMs: 0, endMs: 1, text: "after the end" },
        ])
      }
      if (url === "/streams/3/finish") return Response.json(final)
      return new Response(null, { status: 204 })
    })
    const client = makeClient(fixtureEndpoint, transport, lifetime.signal)
    try {
      const stream = await client.streams.create({ language: "auto" })
      expect(stream).toMatchObject({ id: 3, model: "parakeet_v3", sampleRate: 16_000, partials: true, leaseMs: 10_000 })
      expect(JSON.parse(String(bodies[0]?.body))).toEqual({ sampleFormat: "f32le", sampleRate: 16_000, language: "auto" })

      // 70 000 samples are 280 000 bytes: two requests under the 256 KiB limit.
      const samples = new Float32Array(70_000)
      samples[0] = 0.5
      samples[69_999] = -0.25
      await stream.push(samples)
      const audio = bodies.filter((request) => request.path === "/streams/3/audio")
      expect(audio.map((request) => request.body.byteLength)).toEqual([262_144, 17_856])
      expect(audio[0]?.headers.get("x-hex-stream-token")).toBe(ownerToken)
      expect(audio[0]?.headers.get("content-type")).toBe("application/octet-stream")
      expect(new DataView(audio[0]!.body).getFloat32(0, true)).toBe(0.5)
      expect(new DataView(audio[1]!.body).getFloat32(17_852, true)).toBe(-0.25)

      await expect(stream.push(new Int16Array(4))).rejects.toMatchObject({ code: "request-failed" })

      expect((await collect(stream.events)).map((event) => event.type))
        .toEqual(["ready", "partial", "segment", "final"])

      expect(await stream.finish()).toEqual(final)
      expect(await stream.finish()).toEqual(final)
      expect(bodies.filter((request) => request.path === "/streams/3/finish")).toHaveLength(1)
      await stream.cancel()
      expect(bodies.some((request) => request.path === "/streams/3/cancel")).toBe(false)
      await expect(stream.push(new Float32Array(1))).rejects.toMatchObject({ code: "request-failed" })
    } finally {
      lifetime.abort()
    }
  })

  it("sends exactly a pooled Node Buffer's bytes, not its shared pool", async () => {
    const lifetime = new AbortController()
    const bodies: ArrayBuffer[] = []
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      if (path(input) === "/streams") return started({ sampleFormat: "s16le" })
      bodies.push(init?.body as ArrayBuffer)
      return new Response(null, { status: 204 })
    })
    const client = makeClient(fixtureEndpoint, transport, lifetime.signal)
    try {
      const stream = await client.streams.create({ sampleFormat: "s16le" })
      // Small Buffers share Node's 8 KiB pool, so byteOffset is usually nonzero.
      const pooled = Buffer.from([1, 0, 2, 0, 3, 0])
      expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength)
      await stream.push(pooled)
      expect(bodies).toHaveLength(1)
      expect(Array.from(new Uint8Array(bodies[0]!))).toEqual([1, 0, 2, 0, 3, 0])
    } finally {
      lifetime.abort()
    }
  })

  it("asks for processing and decodes the processed text", async () => {
    const lifetime = new AbortController()
    const transport = vi.fn<typeof fetch>(async (input) => path(input) === "/streams"
      ? started()
      : Response.json({ ...final, processed: "So the plan is the release." }))
    const client = makeClient(fixtureEndpoint, transport, lifetime.signal)
    try {
      const stream = await client.streams.create()
      expect(await stream.finish({ process: "global" })).toMatchObject({ processed: "So the plan is the release." })
      expect(path(transport.mock.calls[1]?.[0])).toBe("/streams/3/finish?process=global")
    } finally {
      lifetime.abort()
    }
  })

  it("keeps the stream and its heartbeat after a finish timeout, then finishes", async () => {
    vi.useFakeTimers()
    const lifetime = new AbortController()
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(Response.json({ code: "stream-finish-timeout" }, { status: 504 }))
      .mockImplementation(async (input) => path(input).endsWith("/finish")
        ? Response.json(final)
        : new Response(null, { status: 204 }))
    const client = makeClient(fixtureEndpoint, transport, lifetime.signal)
    try {
      const stream = await client.streams.create()
      await expect(stream.finish()).rejects.toMatchObject({ status: 504, remoteCode: "stream-finish-timeout" })
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(3_333)
      expect(path(transport.mock.calls[2]?.[0])).toBe("/streams/3/heartbeat")
      await expect(stream.finish()).resolves.toEqual(final)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      lifetime.abort()
    }
  })

  it.each([
    { status: 409, code: "stream-ended" },
    { status: 404, code: "stream-not-found" },
    { status: 401, code: "unauthorized" },
  ])("stops heartbeats after terminal heartbeat error $code", async ({ status, code }) => {
    vi.useFakeTimers()
    const lifetime = new AbortController()
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(started())
      .mockImplementation(async () => Response.json({ code }, { status }))
    const client = makeClient(fixtureEndpoint, transport, lifetime.signal)
    try {
      const stream = await client.streams.create()
      await vi.advanceTimersByTimeAsync(3_333)
      expect(vi.getTimerCount()).toBe(0)
      await expect(stream.push(new Float32Array(1))).rejects.toMatchObject({ code: "request-failed" })
      expect(transport).toHaveBeenCalledTimes(2)
    } finally {
      lifetime.abort()
    }
  })

  it("cancels once and stops its heartbeat", async () => {
    vi.useFakeTimers()
    const lifetime = new AbortController()
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(started({ sampleFormat: "s16le", partials: false }))
      .mockImplementation(async () => new Response(null, { status: 204 }))
    const client = makeClient(fixtureEndpoint, transport, lifetime.signal)
    try {
      const stream = await client.streams.create({ sampleFormat: "s16le" })
      expect(stream.partials).toBe(false)
      await stream.push(Int16Array.of(1, -2))
      const body = transport.mock.calls[1]?.[1]?.body as ArrayBuffer
      expect(new DataView(body).getInt16(2, true)).toBe(-2)
      await expect(stream.push(new Float32Array(1))).rejects.toMatchObject({ code: "request-failed" })
      await expect(stream.push(new Uint8Array(3))).rejects.toMatchObject({ code: "request-failed" })
      await Promise.all([stream.cancel(), stream.cancel()])
      await stream.cancel()
      expect(transport.mock.calls.filter(([input]) => path(input).endsWith("/cancel"))).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      await expect(stream.finish()).rejects.toMatchObject({ code: "request-failed" })
    } finally {
      lifetime.abort()
    }
  })

  it("surfaces an embedded helper without an engine as a remote code", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ code: "engine-unavailable" }, { status: 503 }),
    )
    const client = makeClient(fixtureEndpoint, transport, new AbortController().signal)
    await expect(client.streams.create()).rejects.toMatchObject({
      code: "request-failed",
      status: 503,
      remoteCode: "engine-unavailable",
    } satisfies Partial<HexError>)
  })

  it("drops the oldest partials before committed text when the event buffer is full", async () => {
    const lifetime = new AbortController()
    const partials = Array.from({ length: 400 }, (_, index) => ({
      type: "partial", segment: 0, stable: "", tentative: String(index),
    }))
    const transport = vi.fn<typeof fetch>(async (input) => path(input) === "/streams"
      ? started()
      : sse([
        { type: "segment", segment: 0, startMs: 0, endMs: 10, text: "kept" },
        ...partials,
        { type: "final", ...final },
      ]))
    const client = makeClient(fixtureEndpoint, transport, lifetime.signal)
    try {
      const stream = await client.streams.create()
      const iterator = stream.events[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.value).toMatchObject({ type: "segment", text: "kept" })
      // Let the whole body arrive into the bounded buffer before draining it.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const rest: StreamEvent[] = []
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value)
      expect(rest).toHaveLength(256)
      expect(rest.at(-1)?.type).toBe("final")
      expect(rest[0]).toMatchObject({ type: "partial", tentative: "145" })
    } finally {
      lifetime.abort()
    }
  })

  it("rejects a malformed create response", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(started({ sampleRate: 48_000 }))
    const client = makeClient(fixtureEndpoint, transport, new AbortController().signal)
    await expect(client.streams.create()).rejects.toMatchObject({ code: "invalid-response" })
  })
})
