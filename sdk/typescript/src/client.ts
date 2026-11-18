import { HexError } from "./errors.js"
import { consumeSse } from "./sse.js"
import {
  decodeCapabilities,
  decodeDictationLevel,
  decodeDictationStart,
  decodeHealth,
  decodeModels,
  decodeProgress,
  decodeStreamEvent,
  decodeStreamResult,
  decodeStreamStart,
  decodeTranscription,
  type EmbeddedEndpoint,
} from "./protocol.js"
import type {
  HexClient,
  DictationLevel,
  ListModelsOptions,
  ModelId,
  PrepareModelOptions,
  RequestOptions,
  StreamCreateOptions,
  StreamEvent,
  StreamFinishOptions,
  StreamHandle,
  StreamResult,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types.js"

interface ResponseContext {
  readonly response: Response
  readonly signal: AbortSignal
}

const abortError = (signal: AbortSignal): HexError => {
  if (signal.reason instanceof HexError) return signal.reason
  return new HexError("cancelled", "HEX operation was cancelled", { cause: signal.reason })
}

const boundaryError = (
  cause: unknown,
  signal: AbortSignal,
  code: "request-failed" | "invalid-response",
  message: string,
): HexError => {
  if (cause instanceof HexError) return cause
  if (signal.aborted) return abortError(signal)
  return new HexError(code, message, { cause })
}

const rejection = async (
  response: Response,
  signal: AbortSignal,
): Promise<{ readonly message: string; readonly remoteCode?: string }> => {
  try {
    const body: unknown = await response.json()
    if (typeof body === "object" && body !== null && "code" in body && typeof body.code === "string") {
      return { message: body.code, remoteCode: body.code }
    }
  } catch (cause) {
    if (signal.aborted) throw abortError(signal)
    if (cause instanceof HexError) throw cause
  }
  return { message: `HTTP ${response.status}` }
}

const json = async ({ response, signal }: ResponseContext): Promise<unknown> => {
  try {
    return await response.json()
  } catch (cause) {
    throw boundaryError(cause, signal, "invalid-response", "HEX returned malformed JSON")
  }
}

const combineSignals = (first: AbortSignal, second?: AbortSignal): AbortSignal => {
  if (second === undefined) return first
  if (first.aborted) return first
  if (second.aborted) return second
  return AbortSignal.any([first, second])
}

const languageSuffix = (language?: string): string =>
  language === undefined ? "" : `?${new URLSearchParams({ language })}`

/** The host's per-request audio limit (`MAX_AUDIO_BYTES` in `local_api/streams.rs`). */
const MAX_STREAM_AUDIO_BYTES = 256 * 1024

/** The bytes of one push, copied out of any larger buffer the view shares. */
const streamBytes = (
  samples: Float32Array | Int16Array | Uint8Array,
  sampleFormat: "f32le" | "s16le",
): Uint8Array => {
  if (samples instanceof Float32Array && sampleFormat !== "f32le") {
    throw new HexError("request-failed", "Float32Array audio needs an f32le stream")
  }
  if (samples instanceof Int16Array && sampleFormat !== "s16le") {
    throw new HexError("request-failed", "Int16Array audio needs an s16le stream")
  }
  const sampleBytes = sampleFormat === "f32le" ? 4 : 2
  if (samples.byteLength % sampleBytes !== 0) {
    throw new HexError("request-failed", "HEX stream audio must hold whole samples")
  }
  if (samples instanceof Float32Array) {
    // Typed arrays use the platform byte order; the host reads little-endian.
    const bytes = new Uint8Array(samples.byteLength)
    const view = new DataView(bytes.buffer)
    samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true))
    return bytes
  }
  if (samples instanceof Int16Array) {
    const bytes = new Uint8Array(samples.byteLength)
    const view = new DataView(bytes.buffer)
    samples.forEach((sample, index) => view.setInt16(index * 2, sample, true))
    return bytes
  }
  return samples
}

/** Drops the oldest partial first, so a full buffer never loses committed text. */
const evictStreamEvent = (events: Array<StreamEvent>) => {
  const partial = events.findIndex((event) => event.type === "partial")
  events.splice(partial >= 0 ? partial : 0, 1)
}

export const makeClient = (
  endpoint: EmbeddedEndpoint,
  transport: typeof globalThis.fetch,
  lifetime: AbortSignal,
): HexClient => {
  const request = async (
    path: string,
    init: RequestInit = {},
    callerSignal?: AbortSignal,
  ): Promise<ResponseContext> => {
    const signal = combineSignals(lifetime, callerSignal)
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${endpoint.token}`)
    let response: Response
    try {
      response = await transport(`${endpoint.url}${path}`, {
        ...init,
        headers,
        signal,
      })
    } catch (cause) {
      throw boundaryError(cause, signal, "request-failed", "Could not reach the embedded HEX service")
    }
    if (!response.ok) {
      const remote = await rejection(response, signal)
      throw new HexError("request-failed", `HEX rejected the request: ${remote.message}`, {
        status: response.status,
        ...(remote.remoteCode === undefined ? {} : { remoteCode: remote.remoteCode }),
      })
    }
    return { response, signal }
  }

  const health = async (options?: RequestOptions) =>
    decodeHealth(await json(await request("/health", {}, options?.signal)))

  const capabilities = async (options?: RequestOptions) =>
    decodeCapabilities(await json(await request("/capabilities", {}, options?.signal)))

  const list = async (options?: ListModelsOptions) =>
    decodeModels(await json(await request(`/models${languageSuffix(options?.language)}`, {}, options?.signal)))

  const prepare = async (id: ModelId, options?: PrepareModelOptions): Promise<void> => {
    const context = await request(
      `/models/${id}/prepare${languageSuffix(options?.language)}`,
      { method: "POST" },
      options?.signal,
    )
    const { response, signal } = context
    let completed = false
    const dispatch = (data: string) => {
      let value: unknown
      try {
        value = JSON.parse(data)
      } catch (cause) {
        throw new HexError("invalid-response", "HEX returned malformed model progress", { cause })
      }
      const progress = decodeProgress(value)
      if (progress === "ok") {
        completed = true
        return true
      }
      try {
        options?.onProgress?.(progress)
      } catch (cause) {
        throw new HexError("request-failed", "The model progress callback failed", { cause })
      }
      if (signal.aborted) throw abortError(signal)
    }

    try {
      await consumeSse(response, signal, "model progress", dispatch)
    } catch (cause) {
      throw boundaryError(cause, signal, "invalid-response", "HEX model progress stream failed")
    }
    if (!completed) throw new HexError("model-prepare-failed", "HEX model preparation ended without a result")
  }

  const transcribe = async (input: TranscriptionRequest) => {
    const query = new URLSearchParams({ model: input.model })
    if (input.language !== undefined) query.set("language", input.language)
    if (input.process !== undefined) query.set("process", input.process)
    if (input.timestamps !== undefined && input.timestamps !== "none") {
      query.set("timestamps", input.timestamps)
    }
    let body: ArrayBuffer
    if (input.audio.data instanceof ArrayBuffer) {
      body = input.audio.data
    } else if (
      input.audio.data.buffer instanceof ArrayBuffer
      && input.audio.data.byteOffset === 0
      && input.audio.data.byteLength === input.audio.data.buffer.byteLength
    ) {
      body = input.audio.data.buffer
    } else {
      const copy = new Uint8Array(input.audio.data.byteLength)
      copy.set(input.audio.data)
      body = copy.buffer
    }
    const response = await request(`/transcriptions?${query}`, {
      method: "POST",
      headers: { "content-type": input.audio.contentType },
      body,
    }, input.signal)
    return decodeTranscription(await json(response))
  }

  const boundedStream = <A>(
    bufferSize: number,
    failureMessage: string,
    consume: (push: (value: A) => void, signal: AbortSignal) => Promise<void>,
    evict: (values: Array<A>) => void = (values) => void values.shift(),
  ): AsyncIterable<A> => {
    const values: Array<A> = []
    const controller = new AbortController()
    let pending: {
      resolve: (result: IteratorResult<A>) => void
      reject: (error: unknown) => void
    } | undefined
    let iterated = false
    let ended = false
    let stopped = false
    let failure: unknown
    let running: Promise<void> | undefined
    const finish = (error?: unknown) => {
      if (ended) return
      ended = true
      failure = error
      const waiter = pending
      pending = undefined
      if (waiter !== undefined) {
        if (error === undefined) waiter.resolve({ value: undefined, done: true })
        else waiter.reject(error)
      }
    }
    const push = (value: A) => {
      if (stopped || ended) return
      if (pending !== undefined) {
        const waiter = pending
        pending = undefined
        waiter.resolve({ value, done: false })
        return
      }
      if (values.length >= bufferSize) evict(values)
      values.push(value)
    }
    const start = () => {
      running ??= consume(push, controller.signal).then(
        () => finish(),
        (cause) => finish(stopped ? undefined : boundaryError(
          cause,
          combineSignals(lifetime, controller.signal),
          "invalid-response",
          failureMessage,
        )),
      )
    }
    return {
      [Symbol.asyncIterator]: () => {
        if (iterated) throw new HexError("request-failed", "HEX observation streams support one consumer")
        iterated = true
        start()
        return {
          next: async () => {
            const value = values.shift()
            if (value !== undefined) return { value, done: false }
            if (failure !== undefined) throw failure
            if (ended) return { value: undefined, done: true }
            if (pending !== undefined) {
              throw new HexError("request-failed", "Concurrent stream reads are not supported")
            }
            return new Promise<IteratorResult<A>>((resolve, reject) => {
              pending = { resolve, reject }
            })
          },
          return: async () => {
            stopped = true
            values.length = 0
            controller.abort("iterator closed")
            finish()
            await running
            return { value: undefined, done: true }
          },
        }
      },
    }
  }

  const dictationHeaders = (ownerToken: string) => ({ "x-hex-dictation-token": ownerToken })

  const levelStream = (id: number, ownerToken: string): AsyncIterable<DictationLevel> =>
    boundedStream(32, "HEX dictation level stream failed", async (push, streamSignal) => {
      const { response, signal } = await request(
        `/dictations/${id}/levels`,
        { headers: dictationHeaders(ownerToken) },
        streamSignal,
      )
      await consumeSse(response, signal, "dictation level", (data) => {
        if (data !== "") push(decodeDictationLevel(JSON.parse(data)))
      })
    })

  const audioStream = (id: number, ownerToken: string): AsyncIterable<Float32Array> =>
    boundedStream(8, "HEX dictation audio stream failed", async (push, streamSignal) => {
      const { response, signal } = await request(
        `/dictations/${id}/audio`,
        { headers: dictationHeaders(ownerToken) },
        streamSignal,
      )
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/octet-stream")) {
        throw new HexError("invalid-response", "HEX returned an invalid dictation audio content type")
      }
      if (response.body === null) throw new HexError("invalid-response", "HEX returned no dictation audio stream")
      const reader = response.body.getReader()
      let pending = new Uint8Array(0)
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (signal.aborted) throw abortError(signal)
          const bytes = new Uint8Array(pending.length + chunk.value.length)
          bytes.set(pending)
          bytes.set(chunk.value, pending.length)
          const sampleBytes = bytes.length - bytes.length % 4
          if (sampleBytes > 0) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, sampleBytes)
            const samples = new Float32Array(sampleBytes / 4)
            for (let index = 0; index < samples.length; index++) {
              samples[index] = view.getFloat32(index * 4, true)
            }
            push(samples)
          }
          pending = bytes.slice(sampleBytes)
        }
        if (pending.length !== 0) {
          throw new HexError("invalid-response", "HEX returned an incomplete Float32 audio sample")
        }
      } finally {
        if (signal.aborted) await reader.cancel(signal.reason).catch(() => {})
        reader.releaseLock()
      }
    })

  const startDictation = async (options: { readonly source: string }) => {
    const { id, ownerToken, sampleRate } = decodeDictationStart(await json(await request("/dictations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: options.source }),
    })))
    const levels = levelStream(id, ownerToken)
    const audio = audioStream(id, ownerToken)
    const headers = dictationHeaders(ownerToken)
    let finished: TranscriptionResult | undefined
    let cancelled = false
    let finishInFlight: Promise<TranscriptionResult> | undefined
    let cancelInFlight: Promise<void> | undefined
    const heartbeat = setInterval(() => {
      void request(`/dictations/${id}/heartbeat`, { method: "POST", headers }).catch(stopHeartbeatOnTerminalError)
    }, 3_000)
    const stopHeartbeat = () => {
      clearInterval(heartbeat)
      lifetime.removeEventListener("abort", stopHeartbeat)
    }
    const stopHeartbeatOnTerminalError = (error: unknown) => {
      // These responses cannot renew this capture; transport and server failures can be retried.
      if (error instanceof HexError && (error.status === 401 || error.status === 404 || error.status === 409)) {
        stopHeartbeat()
      }
    }
    lifetime.addEventListener("abort", stopHeartbeat, { once: true })
    if (lifetime.aborted) stopHeartbeat()
    return {
      id,
      ownerToken,
      sampleRate,
      levels,
      audio,
      finish: () => {
        if (finished !== undefined) return Promise.resolve(finished)
        if (cancelled) return Promise.reject(new HexError("request-failed", "HEX dictation was cancelled"))
        finishInFlight ??= (async () => {
          const result = decodeTranscription(await json(await request(
            `/dictations/${id}/finish`,
            { method: "POST", headers },
          )))
          finished = result
          stopHeartbeat()
          return result
        })().catch((error: unknown) => {
          stopHeartbeatOnTerminalError(error)
          throw error
        }).finally(() => {
          finishInFlight = undefined
        })
        return finishInFlight
      },
      cancel: () => {
        if (cancelled || finished !== undefined) return Promise.resolve()
        cancelInFlight ??= request(
          `/dictations/${id}/cancel`,
          { method: "POST", headers },
        ).then(() => {
          cancelled = true
          stopHeartbeat()
        }).catch((error: unknown) => {
          stopHeartbeatOnTerminalError(error)
          throw error
        }).finally(() => {
          cancelInFlight = undefined
        })
        return cancelInFlight
      },
    }
  }

  const streamHeaders = (ownerToken: string) => ({ "x-hex-stream-token": ownerToken })

  const createStream = async (options: StreamCreateOptions = {}): Promise<StreamHandle> => {
    const sampleFormat = options.sampleFormat ?? "f32le"
    const start = decodeStreamStart(await json(await request("/streams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sampleFormat,
        sampleRate: 16_000,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.language === undefined ? {} : { language: options.language }),
      }),
    }, options.signal)))
    const { id, ownerToken } = start
    const headers = streamHeaders(ownerToken)
    const events = boundedStream<StreamEvent>(256, "HEX stream event stream failed", async (push, streamSignal) => {
      const { response, signal } = await request(`/streams/${id}/events`, { headers }, streamSignal)
      await consumeSse(response, signal, "stream", (data) => {
        if (data === "") return
        let value: unknown
        try {
          value = JSON.parse(data)
        } catch (cause) {
          throw new HexError("invalid-response", "HEX returned a malformed stream event", { cause })
        }
        const event = decodeStreamEvent(value)
        push(event)
        return event.type === "final" || event.type === "error" || event.type === "cancelled"
      })
    }, evictStreamEvent)
    let ended = false
    let result: StreamResult | undefined
    let finishInFlight: Promise<StreamResult> | undefined
    let cancelInFlight: Promise<void> | undefined
    // Audio renews the lease too; the heartbeat covers a paused recorder.
    const heartbeat = setInterval(() => {
      void request(`/streams/${id}/heartbeat`, { method: "POST", headers }).catch(stopOnTerminalError)
    }, Math.max(1_000, Math.floor(start.leaseMs / 3)))
    const stopHeartbeat = () => {
      clearInterval(heartbeat)
      lifetime.removeEventListener("abort", stopHeartbeat)
    }
    const end = () => {
      ended = true
      stopHeartbeat()
    }
    const stopOnTerminalError = (error: unknown) => {
      // 409 ended/failed/cancelled, 404 unknown, 401 revoked: nothing to renew.
      // 504 finish timeout and transport failures leave the stream running.
      if (error instanceof HexError && (error.status === 401 || error.status === 404 || error.status === 409)) end()
    }
    lifetime.addEventListener("abort", stopHeartbeat, { once: true })
    if (lifetime.aborted) stopHeartbeat()

    const pushAudio = async (
      samples: Float32Array | Int16Array | Uint8Array,
      pushOptions?: RequestOptions,
    ): Promise<void> => {
      if (ended) throw new HexError("request-failed", "HEX stream has ended")
      const bytes = streamBytes(samples, start.sampleFormat)
      const sampleBytes = start.sampleFormat === "f32le" ? 4 : 2
      const limit = MAX_STREAM_AUDIO_BYTES - MAX_STREAM_AUDIO_BYTES % sampleBytes
      for (let offset = 0; offset < bytes.byteLength; offset += limit) {
        // Copy into an exact buffer: a Node Buffer's slice() is a view into
        // a shared pool, whose .buffer would send the whole pool.
        const chunk = new Uint8Array(bytes.subarray(offset, Math.min(offset + limit, bytes.byteLength)))
        await request(`/streams/${id}/audio`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/octet-stream" },
          body: chunk.buffer,
        }, pushOptions?.signal).catch((error: unknown) => {
          stopOnTerminalError(error)
          throw error
        })
      }
    }

    return {
      id,
      ownerToken,
      model: start.model,
      language: start.language,
      sampleRate: 16_000,
      sampleFormat: start.sampleFormat,
      partials: start.partials,
      leaseMs: start.leaseMs,
      events,
      push: pushAudio,
      finish: (finishOptions: StreamFinishOptions = {}) => {
        if (result !== undefined) return Promise.resolve(result)
        if (ended) return Promise.reject(new HexError("request-failed", "HEX stream has ended"))
        const query = finishOptions.process === undefined ? "" : `?${new URLSearchParams({ process: finishOptions.process })}`
        finishInFlight ??= (async () => {
          const finished = decodeStreamResult(await json(await request(
            `/streams/${id}/finish${query}`,
            { method: "POST", headers },
            finishOptions.signal,
          )))
          result = finished
          end()
          return finished
        })().catch((error: unknown) => {
          stopOnTerminalError(error)
          throw error
        }).finally(() => {
          finishInFlight = undefined
        })
        return finishInFlight
      },
      cancel: () => {
        if (ended) return Promise.resolve()
        cancelInFlight ??= request(`/streams/${id}/cancel`, { method: "POST", headers }).then(end, (error: unknown) => {
          stopOnTerminalError(error)
          throw error
        }).finally(() => {
          cancelInFlight = undefined
        })
        return cancelInFlight
      },
    }
  }

  return {
    async control(command, options) {
      const value = await json(await request("/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, version: 4 }),
      }, options?.signal))
      if (typeof value !== "object" || value === null ||
          (value as Record<string, unknown>).version !== 4 ||
          typeof (value as Record<string, unknown>).status !== "string") {
        throw new HexError("invalid-response", "HEX returned an invalid desktop control response")
      }
      const reply = value as import("./types.js").DesktopReply
      if (reply.status === "error") {
        throw new HexError("request-failed", String(reply.message), {
          remoteCode: String(reply.code),
        })
      }
      return reply
    },
    health,
    capabilities,
    models: { list, prepare },
    transcribe,
    dictation: { start: startDictation },
    streams: { create: createStream },
  }
}
