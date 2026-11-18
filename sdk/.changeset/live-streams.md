---
"@kitlangton/hex": minor
---

`client.streams.create()` opens a live `/streams` transcription of the host's own 16 kHz mono audio on the loaded model, and a model-bound transcriber gets the same as `transcriber.stream()`. The handle pushes `Float32Array` (`f32le`, the default), `Int16Array` (`s16le`), or raw little-endian bytes, split into requests within the host's 256 KiB limit; renews its lease while open; and yields `ready`, `partial` (`stable` and `tentative` text), `segment`, and one terminal `final`, `error`, or `cancelled` event from `events`, dropping the oldest partials first when its buffer is full. `finish()` is idempotent, takes `process: "global"`, and leaves the stream running after `stream-finish-timeout` so it can be called again; `cancel()` is idempotent. `capabilities()` now also returns `streams` and `dictationPartials` when the host reports them.
