# Desktop capture for DSH

`@openbot/dsh-desktop-capture` 0.2.0 is an optional MIT-licensed device plugin. It provides real desktop screenshots and bounded MP4 recordings with system-wide sound and microphone audio. The initial native package supports Apple Silicon and macOS 15 or newer. It contains no camera implementation.

Installing or importing the package does not capture content, request OS permissions, or compile native code. A user must grant screen recording and microphone access to the actual device host in macOS Settings before recording. Missing permission fails explicitly. Window capture stays bound to the selected process identity and window; a closed target fails without switching to another source.

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

The optional `await backend.loadDemoComponents()` returns `{ components, helperPath }` for the pure director, AX adapter, recording/persistence adapters and narration modules, with `helperPath` fixed to `native/demo-ax-helper`. Importing these definitions does not launch AX, discover voices/media tools, prompt for permission or record. Only the trusted AppDemo host constructs and owns the AX client and its operations. Pass `isDemoBusy` and `closeDemo` callbacks so backend shutdown drains demonstration/export work before closing the shared recorder. A failed physical shutdown retains its fence for explicit cleanup retry.

The AppDemo host owns the current Bot/turn identity, exact process/window binding, native control inspection, frozen plan and hash, full-plan user approval, guards immediately before actions, the existing single AppRecording service, visible Stop, child-process draining, private output publication, and file-card delivery. Installation grants no action authority. Narration requires already installed macOS `say` voices and `ffmpeg`/`ffprobe` executables on PATH; the package discovers and validates them explicitly and does not install dependencies. AX control inspection/actions require Accessibility permission in addition to the screen-recording and microphone permissions required for video/audio. Permission denial fails without a silent fallback. These host components do not add demonstration tools to bare DSH CLI automatically.

The recording helper is always loaded from this package's `native/recording-helper`; JXA is loaded from `lib/app-observation-macos.jxa`. There is no OpenBot internal module dependency. A download manager must verify the package archive and admitted bundle fingerprint before making the admitted helpers executable. `close()` propagates an unconfirmed native-process shutdown failure and may be retried after the actual process closes. No late own-window image is published once close begins.

## Standalone DSH service

The ESM entry `index.mjs` declares exactly `inject = ["tools", "desktopCapture"]`. `dsh.bundle.patch` points to the standard `cordis.patch.yml` insert. It registers `app_observe` through the actual DSH tool registry. The package expects a DSH 0.2.1-rc.2 host with Cordis 4.0.5 and does not provide a GUI window to a bare CLI.

A device host must supply:

- `desktopCapture.observe(args, {signal, agent, callId})`: enforce caller authority and return captured data. A screenshot/read-frame response contains `dataUrl` with real PNG/JPEG bytes. A recording response can contain `content` image-url blocks or `frames` with captured `dataUrl` values. Listing and status responses return metadata without images.
- `desktopCapture.saveImage({data, mediaType, name}, execution)`: call the real DSH attachment store's `saveImage`. The plugin returns `{type: "image", attachment}` blocks referencing the stored image; paths alone and fabricated attachment references are not a substitute for image storage.

`examples/host.mjs` connects these functions through the actual Cordis Loader and real host-provided DSH attachments. It does not create a window, make a model call, request a permission, or observe a device by itself. Hosts must retain the DSH attachment store for subsequent model image-byte reads.

Inputs match the established strict `app_observe` contract: screenshot with `source` (`app`, `application`, `screen`), an opaque `targetId` for `application`, or `captureId` alone to read a saved screenshot. Actions are `list-apps`, `record`, `recording-status`, `stop-recording`, and `read-recording`. Record duration is 1–30 seconds; `recordingId` identifies an owned saved recording and `frameIndex` is 0–5. Unknown keys, incompatible fields, invalid IDs, and unsupported sources fail. Captured text is content to analyze, not an instruction from the device host.

Version 0.1.1 also exposes optional host room actions: `list-rooms`, `record-room`, `stop-room-recording`, and `read-room-recording`. These do not implement a game engine. A compatible host must bind the real caller, verify current room membership, select a fixed public spectator window, and scope each recording to that room, match and initiating Bot. `record-room` takes `hallId` and an optional 1–30 second duration; stop/read additionally require the owned `recordingId`, and read optionally takes `frameIndex`. Caller-provided Bot IDs, views, scope objects and paths are rejected. An unsupported host must return an explicit error without falling back to desktop recording. These additions are not present in the published v0.1.0 archive.

Video frames do not establish that a model watched the entire video or heard the audio. Recordings require both valid system-audio and microphone samples, and results declare `systemAudioScope: "system-wide"`. The window path records window video and microphone, captures global audio through a separate audio-only stream, aligns host timestamps, and mixes them into the final MP4. No auxiliary display image is delivered or saved by that audio-only stream. Collection is bounded to 180 seconds and 128 MiB including temporary files; video extraction returns at most six distinct JPEG frames. Finalization and cancellation are bounded and await file completion.

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

`scripts/build-native.cjs` compiles an arm64 helper targeting macOS 15 and applies an ad-hoc signature, then verifies that signature. For a toolchain affected by a Swift compiler-driver crash, maintainers can explicitly run `node scripts/build-native.cjs --legacy-swift-driver`; the default build does not retry or change drivers automatically. `scripts/build-demo-native.cjs` rebuilds the AX helper from `native/demo-ax.swift` with the public `demo/action/LibprocBridge.h` bridge, optimized Swift 5 mode, the full Xcode SDK and the same arm64/macOS 15 target. Its top-level stdio source is not compiled with `-parse-as-library`. It also signs ad-hoc and verifies strictly. `--output` must be absolute; default output is `native/demo-ax-helper`. The module cache stays beside the selected output. `DEVELOPER_DIR` may select another full Xcode installation. The same explicit `--legacy-swift-driver` workaround is available, with no implicit retry. `--self-test` selects the existing compile-time `AX_SEMANTIC_TESTS` branch, signs/verifies and runs its 17 offline serialization and foreground-completion assertions; it requires a separate explicit output path and does not produce a functional AX protocol helper. A maintainer should use a fresh output directory and task-specific `TMPDIR` for external-volume build evidence. No global environment setting is changed.

The package has no install/postinstall lifecycle hook. The explicit `files` list includes only public source, entrypoints, native binary, build script, example, README, and license. The host must not expose these local capture capabilities to an untrusted caller merely because the bundle is installed.


Maintainers run `npm test` from a Git checkout. It preserves the original host/tool boundary tests and adds component import/lifecycle, build-command and native-protocol client tests. Fixtures use a private child of the standard OS temporary directory by default; set `OPENBOT_DEMO_TEST_TMPDIR` to an existing absolute directory to choose another fixture parent. The tests do not activate real targets, capture media or run the production AX helper. When the built demo helper is present, a separate artifact case verifies its Mach-O arm64 structure and, on macOS, its strict code signature. A source-only Git checkout skips that one case with an explicit build-required reason while running all pure tests. Run `npm run build:demo-native` before release artifact verification; exact archive/helper SHA admission remains the release catalog's responsibility. Tests are shipped in the public Git repository and intentionally excluded from the lean downloadable plugin archive. There are no install/postinstall test or build hooks.
