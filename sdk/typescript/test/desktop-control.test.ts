import { describe, expect, it } from "vitest"
import { makeClient } from "../src/client.js"

const endpoint = { type: "ready", url: "http://127.0.0.1:1234", token: "private", apiVersion: "2", pid: 1 } as const

describe("desktop control", () => {
  it("carries microphone discovery and numeric history deletion without requiring capture", async () => {
    const commands: unknown[] = []
    const client = makeClient(endpoint, (async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      commands.push(request)
      return Response.json(request.command === "microphone-list"
        ? { version: 4, status: "microphones", names: ["USB Mic"], system_default: null, system_default_available: true, off_with_lid_closed: null }
        : { version: 4, status: "done", changed: true, message: "Deleted dictation" })
    }) as typeof fetch, new AbortController().signal)
    expect((await client.control({ command: "microphone-list" })).names).toEqual(["USB Mic"])
    expect((await client.control({ command: "history-delete", id: 42 })).changed).toBe(true)
    expect(commands).toEqual([{ version: 4, command: "microphone-list" }, { version: 4, command: "history-delete", id: 42 }])
  })

  it("uses the authenticated existing control protocol", async () => {
    let request: RequestInit | undefined
    const client = makeClient(endpoint, (async (_url, init) => {
      request = init
      return Response.json({ version: 4, status: "status", listener: { running: true } })
    }) as typeof fetch, new AbortController().signal)
    const reply = await client.control({ command: "status" })
    expect(reply.status).toBe("status")
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer private")
    expect(JSON.parse(String(request?.body))).toEqual({ version: 4, command: "status" })
  })
  it("rejects protocol mismatches and carries native validation errors", async () => {
    for (const [value, code] of [
      [{ version: 3, status: "done" }, "invalid-response"],
      [{ version: 4, status: "error", code: "invalid-setting", message: "unsupported shortcut" }, "request-failed"],
    ] as const) {
      const client = makeClient(endpoint, (async () => Response.json(value)) as typeof fetch, new AbortController().signal)
      await expect(client.control({ command: "status" })).rejects.toMatchObject({ code })
    }
  })
})
