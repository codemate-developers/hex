export const MODEL_IDS = [
  "parakeet_unified_en",
  "parakeet_v2",
  "parakeet_v3",
  "orukeet",
  "whisper_large_v3_turbo",
  "qwen3_asr06_b",
  "qwencleo_asr_1_7b",
  "ivrit_whisper_large_v3_turbo",
  "sense_voice_small",
  "cohere_transcribe",
  "underdog_bark_3_pro",
  "underdog_bark_3_clean",
  "parakeet_ultra",
  "nemotron_3_5_asr",
  "gigaam_v3",
  "nb_whisper_medium",
  "granite_speech_5",
  "apple_speech",
] as const

/** A model imported from a file, or found on this computer and used where it is. */
export type CustomModelId = `custom-${string}`

export type ModelId = typeof MODEL_IDS[number] | CustomModelId

export interface Health {
  readonly version: string
  readonly apiVersion: "2"
}

export interface Capabilities {
  readonly audioFormats: readonly ["audio/wav"]
  readonly partialTranscripts: false
  readonly serviceCapture: boolean
  /**
   * Whether `process: "global"` would run on the running app (Labs › Process
   * API transcripts). Absent from hosts older than this field.
   */
  readonly outputProcessing?: boolean
  /** Whether `/streams` live transcription exists. Absent from older hosts. */
  readonly streams?: boolean
  /**
   * Whether a desktop capture can stream its text so far. Absent from older
   * hosts; false on macOS and in the embedded helper.
   */
  readonly dictationPartials?: boolean
}

export interface ModelInfo {
  readonly id: ModelId
  readonly name: string
  readonly installed: boolean
  readonly verified: boolean
  readonly managed: boolean
  readonly downloadBytes: number | null
  readonly languages: readonly string[]
  readonly supportsLanguageDetection: boolean
  /**
   * Where the file is or comes from: `download`, `hex`, `imported`, or
   * `found: owner/name@abcdef1` (another app's Hugging Face download, used
   * where it is). `null` from hosts older than this field.
   */
  readonly source: string | null
}

export type ModelProgress =
  | { readonly type: "downloading"; readonly downloadedBytes: number; readonly totalBytes: number }
  | { readonly type: "verifying" }
  | { readonly type: "loading" }

export interface RequestOptions {
  readonly signal?: AbortSignal
}

export interface PrepareModelOptions extends RequestOptions {
  readonly language?: string
  readonly onProgress?: (progress: ModelProgress) => void
}

export interface ListModelsOptions extends RequestOptions {
  readonly language?: string
}

export interface AudioClip {
  readonly data: ArrayBuffer | Uint8Array
  readonly contentType: "audio/wav"
}

export interface TranscriptionRequest extends RequestOptions {
  readonly audio: AudioClip
  readonly model: ModelId
  readonly language?: string
  /**
   * Ask the running desktop app for the text after its Global mode's output
   * processing (Labs › Process API transcripts). Absent, the transcript is
   * raw as before.
   */
  readonly process?: "global"
  /**
   * Ask for the speech model's own timings (Labs › Timestamps in API
   * transcripts). `segment` adds `segments`; `word` adds `segments` and
   * `words`. `none` and absent ask for none. A model without that level
   * answers `unsupported-timestamps`, and the timings are never estimated.
   */
  readonly timestamps?: "none" | TimestampGranularity
}

/** One timed span: `text` from `startMs` to `endMs`, from the audio's start. */
export interface TimedText {
  readonly text: string
  readonly startMs: number
  readonly endMs: number
}

export type TimestampGranularity = "segment" | "word"

export interface TranscriptionResult {
  readonly transcript: string
  readonly durationMs: number
  /** Present only when the request asked for `process: "global"`. */
  readonly processed?: string
  /** Present only when the request asked for timings. */
  readonly timestampGranularity?: TimestampGranularity
  /** Native segments, in order; present with `segment` and `word`. */
  readonly segments?: readonly TimedText[]
  /** Native word timings; present with `word` only. */
  readonly words?: readonly TimedText[]
}

export interface DictationStartOptions {
  readonly source: string
}

export interface DictationLevel {
  readonly rmsDb: number
  readonly peakDb: number
}

export interface DictationHandle {
  readonly id: number
  /** Unguessable owner credential required by every operation on this capture. */
  readonly ownerToken: string
  /** Source sample rate for the optional mono Float32 PCM audio tap. */
  readonly sampleRate: number
  readonly levels: AsyncIterable<DictationLevel>
  /** Best-effort raw mono PCM from HEX's capture; no work occurs until iterated. */
  readonly audio: AsyncIterable<Float32Array>
  finish(): Promise<TranscriptionResult>
  cancel(): Promise<void>
}

export type StreamSampleFormat = "f32le" | "s16le"

export interface StreamCreateOptions extends RequestOptions {
  /** Defaults to `f32le`. Samples are 16 kHz mono, little-endian. */
  readonly sampleFormat?: StreamSampleFormat
  /** When given, must match the model the host holds, or creation answers `model-mismatch`. */
  readonly model?: ModelId
  readonly language?: string
}

/** A finished window's final text. */
export interface StreamSegment {
  readonly segment: number
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

export type StreamEvent =
  | {
    readonly type: "ready"
    readonly id: number
    readonly model: ModelId
    readonly language: string
    readonly sampleFormat: StreamSampleFormat
    readonly partials: boolean
  }
  /** `stable` is committed; `tentative` may still change. Replaces the previous partial for `segment`. */
  | { readonly type: "partial"; readonly segment: number; readonly stable: string; readonly tentative: string }
  | ({ readonly type: "segment" } & StreamSegment)
  | {
    readonly type: "final"
    readonly text: string
    readonly segments: readonly StreamSegment[]
    readonly durationMs: number
  }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "cancelled" }

export interface StreamResult {
  readonly text: string
  readonly segments: readonly StreamSegment[]
  readonly durationMs: number
  /** Present only when finish asked for `process: "global"`. */
  readonly processed?: string
}

export interface StreamFinishOptions extends RequestOptions {
  readonly process?: "global"
}

export interface StreamHandle {
  readonly id: number
  /** Unguessable owner credential required by every operation on this stream. */
  readonly ownerToken: string
  readonly model: ModelId
  readonly language: string
  readonly sampleRate: 16000
  readonly sampleFormat: StreamSampleFormat
  /** Whether `partial` events will arrive; false when the model cannot stream on its device. */
  readonly partials: boolean
  readonly leaseMs: number
  /**
   * Every segment from the start, live events, then the terminal event. One
   * consumer; when the buffer is full the oldest partial is dropped first.
   */
  readonly events: AsyncIterable<StreamEvent>
  /**
   * Queues samples in the declared format: `Float32Array` for `f32le`,
   * `Int16Array` for `s16le`, or raw little-endian bytes. Large pushes are
   * split into requests within the host's limit.
   */
  push(samples: Float32Array | Int16Array | Uint8Array, options?: RequestOptions): Promise<void>
  /** Transcribes what is left. A `stream-finish-timeout` rejection leaves the stream running; call again. */
  finish(options?: StreamFinishOptions): Promise<StreamResult>
  cancel(): Promise<void>
}

export type DesktopCommand =
  | { readonly command: "status" }
  | { readonly command: "model-install"; readonly model: string; readonly language?: string }
  | { readonly command: "settings-apply"; readonly values: Readonly<Record<string, unknown>> }
  | { readonly command: "dictation"; readonly action: "start" | "stop" | "toggle" | "cancel" }

export interface DesktopReply {
  readonly version: number
  readonly status: string
  readonly [key: string]: unknown
}

export interface HexClient {
  /** Hex desktop control; available in an app or an opted-in Toolbox desktop helper. */
  control(command: DesktopCommand, options?: RequestOptions): Promise<DesktopReply>
  health(options?: RequestOptions): Promise<Health>
  capabilities(options?: RequestOptions): Promise<Capabilities>
  readonly models: {
    list(options?: ListModelsOptions): Promise<readonly ModelInfo[]>
    prepare(id: ModelId, options?: PrepareModelOptions): Promise<void>
  }
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
  readonly dictation: {
    start(options: DictationStartOptions): Promise<DictationHandle>
  }
  /** Live transcription of caller-supplied audio on the host's loaded model. */
  readonly streams: {
    create(options?: StreamCreateOptions): Promise<StreamHandle>
  }
}

export interface CreateOptions {
  /** Omit the model for the low-level host. */
  readonly model?: never
  /** Required until bundled native helper packages are published. */
  readonly command?: readonly [executable: string, ...arguments: readonly string[]]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly signal?: AbortSignal
  /** Platform transport override, primarily for tests and Electron adapters. */
  readonly fetch?: typeof globalThis.fetch
}

/** Creates a ready, model-bound transcriber. Preparation may download the model. */
export interface TranscriberOptions extends Omit<CreateOptions, "model"> {
  readonly model: ModelId
  /** Defaults to English, independently of the desktop app's settings. */
  readonly language?: string
  readonly onProgress?: (progress: ModelProgress) => void
}

export interface Transcriber {
  readonly pid: number
  readonly model: ModelId
  readonly language: string
  /** PCM WAV bytes. Cancelling in-flight work closes this transcriber before rejecting. */
  transcribe(audio: ArrayBuffer | Uint8Array, options?: RequestOptions): Promise<TranscriptionResult>
  /** Opens a live stream bound to this transcriber's model and language. */
  stream(options?: Omit<StreamCreateOptions, "model" | "language">): Promise<StreamHandle>
  close(): Promise<void>
}

export interface ConnectOptions extends RequestOptions {
  /** Advanced discovery override for tests or isolated application instances. */
  readonly discoveryPath?: string
  /** Platform transport override, primarily for tests and Electron adapters. */
  readonly fetch?: typeof globalThis.fetch
}

export interface HexHost {
  readonly pid: number
  readonly client: HexClient
  close(): Promise<void>
}
