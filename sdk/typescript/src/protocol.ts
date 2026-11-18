import { HexError } from "./errors.js"
import type {
  Capabilities,
  DictationLevel,
  Health,
  ModelId,
  StreamEvent,
  StreamResult,
  StreamSampleFormat,
  StreamSegment,
  ModelInfo,
  ModelProgress,
  TimedText,
  TimestampGranularity,
  TranscriptionResult,
} from "./types.js"
import { MODEL_IDS } from "./types.js"

export interface EmbeddedEndpoint {
  readonly type: "ready"
  readonly url: string
  readonly token: string
  readonly apiVersion: "2"
  readonly pid: number
}

const MODEL_ID_SET: ReadonlySet<string> = new Set(MODEL_IDS)

const CUSTOM_MODEL_ID = /^custom-[0-9a-f]{16}$/

const isModelId = (value: string): value is ModelId =>
  MODEL_ID_SET.has(value) || CUSTOM_MODEL_ID.test(value)

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const boolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const invalid = (description: string): never => {
  throw new HexError("invalid-response", `HEX returned an invalid ${description}`)
}

const incompatibleApi = (apiVersion: unknown): never => {
  throw new HexError(
    "incompatible-api",
    `HEX local API ${String(apiVersion ?? "unknown")} is incompatible with client API 2; install a matching HEX app`,
  )
}

export const decodeEndpoint = (line: string): EmbeddedEndpoint => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new HexError("invalid-handshake", "HEX returned malformed startup JSON", { cause })
  }
  return decodeEndpointValue(value)
}

export const decodeEndpointValue = (value: unknown): EmbeddedEndpoint => {
  const input = record(value)
  const url = input && string(input.url)
  const token = input && string(input.token)
  const pid = input && number(input.pid)
  if (input?.apiVersion !== undefined && input.apiVersion !== "2") {
    incompatibleApi(input.apiVersion)
  }
  if (
    input?.type !== "ready"
    || input.apiVersion !== "2"
    || url === undefined
    || token === undefined
    || pid === undefined
    || !Number.isInteger(pid)
    || pid <= 0
  ) {
    throw new HexError("invalid-handshake", "HEX returned an invalid startup handshake")
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (cause) {
    throw new HexError("invalid-handshake", "HEX returned an invalid service URL", { cause })
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new HexError("invalid-handshake", "HEX service URL is not an authenticated loopback endpoint")
  }
  return { type: "ready", url, token, apiVersion: "2", pid }
}

export const decodeHealth = (value: unknown): Health => {
  const input = record(value)
  const version = input && string(input.version)
  if (input?.apiVersion !== "2") {
    incompatibleApi(input?.apiVersion)
  }
  if (version === undefined) return invalid("health response")
  return { version, apiVersion: "2" }
}

const optionalBoolean = (
  input: Record<string, unknown>,
  key: string,
): { readonly ok: boolean; readonly value?: boolean } => {
  if (input[key] === undefined) return { ok: true }
  const value = boolean(input[key])
  return value === undefined ? { ok: false } : { ok: true, value }
}

export const decodeCapabilities = (value: unknown): Capabilities => {
  const input = record(value)
  if (
    !Array.isArray(input?.audioFormats)
    || input.audioFormats.length !== 1
    || input.audioFormats[0] !== "audio/wav"
    || input.partialTranscripts !== false
    || typeof input.serviceCapture !== "boolean"
  ) return invalid("capabilities response")
  // Optional fields arrived after the first release; an older host omits them.
  const optional: Record<string, boolean> = {}
  for (const key of ["outputProcessing", "streams", "dictationPartials"] as const) {
    const field = optionalBoolean(input, key)
    if (!field.ok) return invalid("capabilities response")
    if (field.value !== undefined) optional[key] = field.value
  }
  return {
    audioFormats: ["audio/wav"],
    partialTranscripts: false,
    serviceCapture: input.serviceCapture,
    ...optional,
  }
}

export const decodeDictationStart = (value: unknown): {
  readonly id: number
  readonly ownerToken: string
  readonly sampleRate: number
} => {
  const input = record(value)
  const id = input && number(input.id)
  const ownerToken = input && string(input.ownerToken)
  const sampleRate = input && number(input.sampleRate)
  if (
    id === undefined
    || !Number.isInteger(id)
    || id <= 0
    || ownerToken === undefined
    || ownerToken.length < 32
    || sampleRate === undefined
    || !Number.isInteger(sampleRate)
    || sampleRate <= 0
  ) return invalid("dictation start response")
  return { id, ownerToken, sampleRate }
}

export const decodeDictationLevel = (value: unknown): DictationLevel => {
  const input = record(value)
  const rmsDb = input && number(input.rmsDb)
  const peakDb = input && number(input.peakDb)
  if (rmsDb === undefined || peakDb === undefined) return invalid("dictation level event")
  return { rmsDb, peakDb }
}

export const decodeModels = (value: unknown): readonly ModelInfo[] => {
  if (!Array.isArray(value)) return invalid("model catalog")
  return value.map((item) => {
    const input = record(item)
    const id = input && string(input.id)
    const name = input && string(input.name)
    const installed = input && boolean(input.installed)
    const verified = input && boolean(input.verified)
    const managed = input && boolean(input.managed)
    const downloadBytes = input?.downloadBytes === null ? null : number(input?.downloadBytes)
    const languages = input?.languages
    const supportsLanguageDetection = input?.supportsLanguageDetection
    const source = input?.source === undefined ? null : string(input.source)
    if (
      id === undefined
      || !isModelId(id)
      || name === undefined
      || installed === undefined
      || verified === undefined
      || managed === undefined
      || downloadBytes === undefined
      || !Array.isArray(languages)
      || !languages.every((language) => typeof language === "string")
      || typeof supportsLanguageDetection !== "boolean"
      || source === undefined
    ) return invalid("model catalog entry")
    return {
      id,
      name,
      installed,
      verified,
      managed,
      downloadBytes,
      languages,
      supportsLanguageDetection,
      source,
    }
  })
}

const decodeTimedText = (value: unknown): TimedText | undefined => {
  const input = record(value)
  const text = input && string(input.text)
  const startMs = input && number(input.startMs)
  const endMs = input && number(input.endMs)
  if (
    text === undefined
    || startMs === undefined
    || endMs === undefined
    || startMs < 0
    || endMs < startMs
  ) {
    return undefined
  }
  return { text, startMs, endMs }
}

const decodeTimedTextList = (value: unknown): readonly TimedText[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const spans: TimedText[] = []
  for (const span of value) {
    const decoded = decodeTimedText(span)
    if (decoded === undefined) return undefined
    spans.push(decoded)
  }
  return spans
}

const decodeGranularity = (value: unknown): TimestampGranularity | undefined =>
  value === "segment" || value === "word" ? value : undefined

export const decodeTranscription = (value: unknown): TranscriptionResult => {
  const input = record(value)
  const transcript = input && string(input.transcript)
  const durationMs = input && number(input.durationMs)
  const processed = input && (input.processed === undefined ? undefined : string(input.processed))
  const granularity = input && (
    input.timestampGranularity === undefined
      ? undefined
      : decodeGranularity(input.timestampGranularity)
  )
  const segments = input && (input.segments === undefined ? undefined : decodeTimedTextList(input.segments))
  const words = input && (input.words === undefined ? undefined : decodeTimedTextList(input.words))
  if (
    transcript === undefined
    || durationMs === undefined
    || durationMs < 0
    || (input?.processed !== undefined && processed === undefined)
    || (input?.timestampGranularity !== undefined && granularity === undefined)
    || (input?.segments !== undefined && segments === undefined)
    || (input?.words !== undefined && words === undefined)
    || (granularity !== undefined && segments === undefined)
    || (segments !== undefined && granularity === undefined)
    || (words !== undefined && granularity !== "word")
    || (granularity === "word" && words === undefined)
  ) {
    return invalid("transcription response")
  }
  return {
    transcript,
    durationMs,
    ...(processed === undefined ? {} : { processed }),
    ...(granularity === undefined ? {} : { timestampGranularity: granularity }),
    ...(segments === undefined ? {} : { segments }),
    ...(words === undefined ? {} : { words }),
  }
}

export const decodeProgress = (value: unknown): ModelProgress | "ok" => {
  const input = record(value)
  switch (input?.type) {
    case "downloading": {
      const downloadedBytes = number(input.downloadedBytes)
      const totalBytes = number(input.totalBytes)
      if (downloadedBytes === undefined || totalBytes === undefined) return invalid("model progress event")
      return { type: "downloading", downloadedBytes, totalBytes }
    }
    case "verifying":
      return { type: "verifying" }
    case "loading":
      return { type: "loading" }
    case "ok":
      return "ok"
    case "error": {
      const error = record(input.error)
      const code = error && string(error.code)
      const message = error && string(error.message)
      throw new HexError("model-prepare-failed", message ?? "HEX could not prepare the model", {
        ...(code === undefined ? {} : { remoteCode: code }),
      })
    }
    default:
      return invalid("model progress event")
  }
}

const decodeSampleFormat = (value: unknown): StreamSampleFormat | undefined =>
  value === "f32le" || value === "s16le" ? value : undefined

const nonNegativeInteger = (value: unknown): number | undefined => {
  const decoded = number(value)
  return decoded !== undefined && Number.isInteger(decoded) && decoded >= 0 ? decoded : undefined
}

const decodeModelId = (value: unknown): ModelId | undefined => {
  const id = string(value)
  return id !== undefined && isModelId(id) ? id : undefined
}

export interface StreamStart {
  readonly id: number
  readonly ownerToken: string
  readonly model: ModelId
  readonly language: string
  readonly sampleFormat: StreamSampleFormat
  readonly partials: boolean
  readonly leaseMs: number
}

export const decodeStreamStart = (value: unknown): StreamStart => {
  const input = record(value)
  const id = input && nonNegativeInteger(input.id)
  const ownerToken = input && string(input.ownerToken)
  const model = input && decodeModelId(input.model)
  const language = input && string(input.language)
  const sampleFormat = input && decodeSampleFormat(input.sampleFormat)
  const partials = input && boolean(input.partials)
  const leaseMs = input && nonNegativeInteger(input.leaseMs)
  if (
    id === undefined
    || id <= 0
    || ownerToken === undefined
    || ownerToken.length < 32
    || model === undefined
    || language === undefined
    || input?.sampleRate !== 16_000
    || sampleFormat === undefined
    || partials === undefined
    || leaseMs === undefined
    || leaseMs === 0
  ) return invalid("stream create response")
  return { id, ownerToken, model, language, sampleFormat, partials, leaseMs }
}

const decodeStreamSegment = (value: unknown): StreamSegment | undefined => {
  const input = record(value)
  const segment = input && nonNegativeInteger(input.segment)
  const startMs = input && nonNegativeInteger(input.startMs)
  const endMs = input && nonNegativeInteger(input.endMs)
  const text = input && string(input.text)
  if (segment === undefined || startMs === undefined || endMs === undefined || endMs < startMs || text === undefined) {
    return undefined
  }
  return { segment, startMs, endMs, text }
}

const decodeStreamSegments = (value: unknown): readonly StreamSegment[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const segments: StreamSegment[] = []
  for (const item of value) {
    const segment = decodeStreamSegment(item)
    if (segment === undefined) return undefined
    segments.push(segment)
  }
  return segments
}

export const decodeStreamResult = (value: unknown): StreamResult => {
  const input = record(value)
  const text = input && string(input.text)
  const segments = input && decodeStreamSegments(input.segments)
  const durationMs = input && nonNegativeInteger(input.durationMs)
  const processed = input && (input.processed === undefined ? undefined : string(input.processed))
  if (
    text === undefined
    || segments === undefined
    || durationMs === undefined
    || (input?.processed !== undefined && processed === undefined)
  ) return invalid("stream finish response")
  return { text, segments, durationMs, ...(processed === undefined ? {} : { processed }) }
}

export const decodeStreamEvent = (value: unknown): StreamEvent => {
  const input = record(value)
  switch (input?.type) {
    case "ready": {
      const id = nonNegativeInteger(input.id)
      const model = decodeModelId(input.model)
      const language = string(input.language)
      const sampleFormat = decodeSampleFormat(input.sampleFormat)
      const partials = boolean(input.partials)
      if (
        id === undefined
        || model === undefined
        || language === undefined
        || sampleFormat === undefined
        || partials === undefined
      ) break
      return { type: "ready", id, model, language, sampleFormat, partials }
    }
    case "partial": {
      const segment = nonNegativeInteger(input.segment)
      const stable = string(input.stable)
      const tentative = string(input.tentative)
      if (segment === undefined || stable === undefined || tentative === undefined) break
      return { type: "partial", segment, stable, tentative }
    }
    case "segment": {
      const segment = decodeStreamSegment(input)
      if (segment === undefined) break
      return { type: "segment", ...segment }
    }
    case "final": {
      const text = string(input.text)
      const segments = decodeStreamSegments(input.segments)
      const durationMs = nonNegativeInteger(input.durationMs)
      if (text === undefined || segments === undefined || durationMs === undefined) break
      return { type: "final", text, segments, durationMs }
    }
    case "error": {
      const code = string(input.code)
      const message = string(input.message)
      if (code === undefined || message === undefined) break
      return { type: "error", code, message }
    }
    case "cancelled":
      return { type: "cancelled" }
  }
  return invalid("stream event")
}
