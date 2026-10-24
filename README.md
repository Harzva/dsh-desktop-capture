# Desktop capture for DSH

`@openbot/dsh-desktop-capture` 0.2.2 is an optional MIT-licensed device plugin. It provides real desktop screenshots and bounded MP4 recordings with system-wide sound and optional microphone audio. The initial native package supports Apple Silicon and macOS 15 or newer. It contains no camera implementation.

Installing or importing the package does not capture content, request OS permissions, or compile native code. A user must grant screen recording access to the actual device host in macOS Settings before recording. The default `audioMode: "system-and-microphone"` also requires microphone access; explicit `audioMode: "system"` neither requests nor opens the microphone. Missing permission fails explicitly. Window capture stays bound to the selected process identity and window; a closed target fails without switching to another source.

## OpenBot device host

```js
const { createHostCapture } = require('@openbot/dsh-desktop-capture/host');
const backend = createHostCapture({ electron, getWindow: () => mainWindow });
// backend.capture: MacAppCapture; backend.recording: MacRecordingBackend
// backend.captureSelf(window, { signal }): guarded own-window capturePage
// backend.busy: own-window capture, external capture, or recording in progress
// await backend.close(): wait for owned operations and confirmed process shutdown
```

This entry initializes platform objects only. The application host owns Bot identity, permission policy, trusted tool transport, private attachments, output directories, retention, and lifecycle. OpenBot uses this entry behind its existing trusted tool bridge; it does not register another copy of `app_observe` from the DSH entry.

Hosts recording an independent spectator window may additionally pass `getRecordingWindow`. It defaults to `getWindow`; when provided, only native self-window recording uses it. Own-window screenshots continue to validate against `getWindow`, so a concurrent screenshot cannot switch the recorder's target. The host must keep the recording getter bound to the exact authorized window for the full recording lifecycle, including finalization, and must keep that window rendering while it is covered by another window. There is still only one recording backend and one recording at a time. Video uses a 15 fps capture interval and scales down to a maximum long edge of 1920 pixels; achieved frame rate depends on the source and system. Simultaneous multi-source/multi-track video capture is not delivered, and camera capture is not included.

Trusted Electron hosts can call `backend.recording.startOwnedWindow(window, options)` to record an exact BrowserWindow through the same single recording engine. `backend.capture.resolveOwnedWindow(window, { signal, guard })` resolves its Electron media-source ID and verifies the normal window against the host process PID, bundle and microsecond process birth. The backend keeps checking that immutable native identity and the same visible, non-minimized BrowserWindow and media ID throughout the session. The host must retain a lifecycle lease and guard for the exact authorized window until physical recording shutdown is confirmed. This host-only method rejects caller target/source/identity overrides; unknown or lost windows fail without display fallback. Own-process windows remain excluded from external `list-apps` results. Installing the package does not grant a model permission to choose an owned window.

The optional `await backend.loadDemoComponents()` returns `{ components, helperPath }` for the pure director, AX adapter, recording/persistence adapters and narration modules, with `helperPath` fixed to `native/demo-ax-helper`. Importing these definitions does not launch AX, discover voices/media tools, prompt for permission or record. Only the trusted AppDemo host constructs and owns the AX client and its operations. Pass `isDemoBusy` and `closeDemo` callbacks so backend shutdown drains demonstration/export work before closing the shared recorder. A failed physical shutdown retains its fence for explicit cleanup retry.

The AppDemo host owns the current Bot/turn identity, exact process/window binding, native control inspection, frozen plan and hash, full-plan user approval, guards immediately before actions, the existing single AppRecording service, visible Stop, child-process draining, private output publication, and file-card delivery. Installation grants no action authority. Narration requires already installed macOS `say` voices and `ffmpeg`/`ffprobe` executables on PATH; the package discovers and validates them explicitly and does not install dependencies. AX control inspection/actions require Accessibility permission in addition to screen-recording permission and microphone permission when microphone audio is selected. Permission denial fails without a silent fallback. These host components do not add demonstration tools to bare DSH CLI automatically.

The recording helper is always loaded from this package's `native/recording-helper`; JXA is loaded from `lib/app-observation-macos.jxa`. There is no OpenBot internal module dependency. A download manager must verify the package archive and admitted bundle fingerprint before making the admitted helpers executable. `close()` propagates an unconfirmed native-process shutdown failure and may be retried after the actual process closes. No late own-window image is published once close begins.

## Standalone DSH service

The ESM entry `index.mjs` declares exactly `inject = ["tools", "desktopCapture"]`. `dsh.bundle.patch` points to the standard `cordis.patch.yml` insert. It registers `app_observe` through the actual DSH tool registry. The package expects a DSH 0.2.1-rc.2 host with Cordis 4.0.5 and does not provide a GUI window to a bare CLI.

A device host must supply:

- `desktopCapture.observe(args, {signal, agent, callId})`: enforce caller authority and return captured data. A screenshot/read-frame response contains `dataUrl` with real PNG/JPEG bytes. A recording response can contain `content` image-url blocks or `frames` with captured `dataUrl` values. Listing and status responses return metadata without images.
- `desktopCapture.saveImage({data, mediaType, name}, execution)`: call the real DSH attachment store's `saveImage`. The plugin returns `{type: "image", attachment}` blocks referencing the stored image; paths alone and fabricated attachment references are not a substitute for image storage.

`examples/host.mjs` connects these functions through the actual Cordis Loader and real host-provided DSH attachments. It does not create a window, make a model call, request a permission, or observe a device by itself. Hosts must retain the DSH attachment store for subsequent model image-byte reads.

Inputs match the established strict `app_observe` contract: screenshot with `source` (`app`, `application`, `screen`), an opaque `targetId` for `application`, or `captureId` alone to read a saved screenshot. Actions are `list-apps`, `record`, `start-browser-recording`, `recording-status`, `stop-recording`, and `read-recording`. `record` accepts optional `audioMode` (default `system-and-microphone`). Record duration is 1–30 seconds; `recordingId` identifies an owned saved recording and `frameIndex` is 0–5. Unknown keys, incompatible fields, invalid IDs, and unsupported sources fail. Captured text is content to analyze, not an instruction from the device host.

Version 0.1.1 also exposes optional host room actions: `list-rooms`, `record-room`, `stop-room-recording`, and `read-room-recording`. These do not implement a game engine. A compatible host must bind the real caller, verify current room membership, select a fixed public spectator window, and scope each recording to that room, match and initiating Bot. `record-room` takes `hallId` and an optional 1–30 second duration; stop/read additionally require the owned `recordingId`, and read optionally takes `frameIndex`. Caller-provided Bot IDs, views, scope objects and paths are rejected. An unsupported host must return an explicit error without falling back to desktop recording. These additions are not present in the published v0.1.0 archive.

Video frames do not establish that a model watched the entire video or heard the audio. Native host recording accepts `audioMode: "system"` or `"system-and-microphone"`; omitting it preserves the system-and-microphone default. Both modes require valid system-audio samples. The latter also requires valid microphone samples, while system-only records no microphone samples or track. Results declare the selected `audioMode` and `systemAudioScope: "system-wide"`; the sound is global system audio, not tab-only audio. The window path captures window video and, when selected, microphone audio, captures global audio through a separate audio-only stream, aligns host timestamps, and combines the selected tracks into the final MP4. The standalone tool validates audio selection for `record` and `start-browser-recording`; room recording retains its existing both-inputs contract. No auxiliary display image is delivered or saved by that audio-only stream. Collection is bounded to 180 seconds and 128 MiB including temporary files; video extraction returns at most six distinct JPEG frames. Finalization and cancellation are bounded and await file completion.

## Browser playback recording (compatible host required)

`start-browser-recording` accepts only `audioMode` and `maxDurationSeconds` (integer 1–180, default 180). It starts the already open current browser page, defaults to system-only audio, and returns an owned `recordingId` immediately. The trusted host supplies the exact window, Bot and current turn; caller-supplied URLs, window IDs, paths and identities are rejected. A bare DSH host without this capability must return an explicit unsupported error.

Observe the actual player and prepare the desired start position before recording. Start capture, use the existing authorized browser actions to play/unmute, then stop with the returned ID. Check the resulting duration, stop reason and real video bytes before exporting; a time- or size-limited clip is only an excerpt. Recording does not unlock a login wall, QR handoff or protected player. If the page is inaccessible, report that outcome instead of claiming a video was saved.

The host keeps capture bound to the same page and ownership generation. Navigation, tab changes, takeover or window closure invalidates capture. Tool-request cancellation stops a pending start, while the enclosing turn governs continued capture; turn completion must drain any unfinished recording before releasing the window. Manual host controls may separately own a recording beyond a Bot turn. Both paths use the existing single native recorder and visible Stop; recording the video of one window still records system-wide sound.

## Maintainer build and package

A full Xcode toolchain with a macOS 15+ SDK is needed only to build the release. End users use the shipped helper and do not need Xcode.

```sh
npm run build:native
npm run build:demo-native
# Keep review builds outside the shipped native directory:
node scripts/build-demo-native.cjs --output /absolute/review/demo-ax-helper
# Offline semantic assertions: separate executable, no AX queries or permission probing:
node scripts/build-demo-native.cjs --self-test --output /absolute/review/demo-ax-semantic-tests
npm pack --ignore-scripts
```

`scripts/build-native.cjs` compiles an arm64 helper targeting macOS 15 and applies an ad-hoc signature, then verifies that signature. For a toolchain affected by a Swift compiler-driver crash, maintainers can explicitly run `node scripts/build-native.cjs --legacy-swift-driver`; the default build does not retry or change drivers automatically. `scripts/build-demo-native.cjs` rebuilds the AX helper from `native/demo-ax.swift` with the public `demo/action/LibprocBridge.h` bridge, optimized Swift 5 mode, the full Xcode SDK and the same arm64/macOS 15 target. Its top-level stdio source is not compiled with `-parse-as-library`. It also signs ad-hoc and verifies strictly. `--output` must be absolute; default output is `native/demo-ax-helper`. Both build scripts keep their module caches beside the selected output. `DEVELOPER_DIR` may select another full Xcode installation. The same explicit `--legacy-swift-driver` workaround is available, with no implicit retry. `--self-test` selects the existing compile-time `AX_SEMANTIC_TESTS` branch, signs/verifies and runs its 17 offline serialization and foreground-completion assertions; it requires a separate explicit output path and does not produce a functional AX protocol helper. A maintainer should use a fresh output directory and task-specific `TMPDIR` for external-volume build evidence. No global environment setting is changed.

The package has no install/postinstall lifecycle hook. The explicit `files` list includes only public source, entrypoints, native binary, build script, example, README, and license. The host must not expose these local capture capabilities to an untrusted caller merely because the bundle is installed.


Maintainers run `npm test` from a Git checkout. It preserves the original host/tool boundary tests and adds component import/lifecycle, build-command and native-protocol client tests. Fixtures use a private child of the standard OS temporary directory by default; set `OPENBOT_DEMO_TEST_TMPDIR` to an existing absolute directory to choose another fixture parent. The tests do not activate real targets, capture media or run the production AX helper. When the built demo helper is present, a separate artifact case verifies its Mach-O arm64 structure and, on macOS, its strict code signature. A source-only Git checkout skips that one case with an explicit build-required reason while running all pure tests. Run `npm run build:demo-native` before release artifact verification; exact archive/helper SHA admission remains the release catalog's responsibility. Tests are shipped in the public Git repository and intentionally excluded from the lean downloadable plugin archive. There are no install/postinstall test or build hooks.

## Interrupted target recordings

A verified original window disappearing may preserve private, incomplete media after confirmed process exit. The backend rejects with `APP_RECORDING_TARGET_LOST`; its `partialMedia` describes verified files and explicitly sets `publishable: false`. The host must independently verify and keep this evidence separate from completed recordings. A playable partial requires successful finalization and a decoded preview; other retained evidence is `unusable`. Unknown closure remains fenced. Permissions, process/window identity changes and cancellation do not qualify. No automatic source switch or completed film is produced.
