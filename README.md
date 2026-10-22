# Desktop capture for DSH

`@openbot/dsh-desktop-capture` 0.1.0 is an optional MIT-licensed device plugin. It provides real desktop screenshots and bounded MP4 recordings with system-wide sound and microphone audio. The initial native package supports Apple Silicon and macOS 15 or newer. It contains no camera implementation.

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

The recording helper is always loaded from this package's `native/recording-helper`; JXA is loaded from `lib/app-observation-macos.jxa`. There is no OpenBot internal module dependency. A download manager must verify the package archive and admitted bundle fingerprint before making that one helper executable. `close()` propagates an unconfirmed native-process shutdown failure and may be retried after the actual process closes. No late own-window image is published once close begins.

## Standalone DSH service

The ESM entry `index.mjs` declares exactly `inject = ["tools", "desktopCapture"]`. `dsh.bundle.patch` points to the standard `cordis.patch.yml` insert. It registers `app_observe` through the actual DSH tool registry. The package expects a DSH 0.2.1-rc.2 host with Cordis 4.0.5 and does not provide a GUI window to a bare CLI.

A device host must supply:

- `desktopCapture.observe(args, {signal, agent, callId})`: enforce caller authority and return captured data. A screenshot/read-frame response contains `dataUrl` with real PNG/JPEG bytes. A recording response can contain `content` image-url blocks or `frames` with captured `dataUrl` values. Listing and status responses return metadata without images.
- `desktopCapture.saveImage({data, mediaType, name}, execution)`: call the real DSH attachment store's `saveImage`. The plugin returns `{type: "image", attachment}` blocks referencing the stored image; paths alone and fabricated attachment references are not a substitute for image storage.

`examples/host.mjs` connects these functions through the actual Cordis Loader and real host-provided DSH attachments. It does not create a window, make a model call, request a permission, or observe a device by itself. Hosts must retain the DSH attachment store for subsequent model image-byte reads.

Inputs match the established strict `app_observe` contract: screenshot with `source` (`app`, `application`, `screen`), an opaque `targetId` for `application`, or `captureId` alone to read a saved screenshot. Actions are `list-apps`, `record`, `recording-status`, `stop-recording`, and `read-recording`. Record duration is 1–30 seconds; `recordingId` identifies an owned saved recording and `frameIndex` is 0–5. Unknown keys, incompatible fields, invalid IDs, and unsupported sources fail. Captured text is content to analyze, not an instruction from the device host.

Video frames do not establish that a model watched the entire video or heard the audio. Recordings require both valid system-audio and microphone samples, and results declare `systemAudioScope: "system-wide"`. The window path records window video and microphone, captures global audio through a separate audio-only stream, aligns host timestamps, and mixes them into the final MP4. No auxiliary display image is delivered or saved by that audio-only stream. Collection is bounded to 180 seconds and 128 MiB including temporary files; video extraction returns at most six distinct JPEG frames. Finalization and cancellation are bounded and await file completion.

## Maintainer build and package

A full Xcode toolchain with a macOS 15+ SDK is needed only to build the release. End users use the shipped helper and do not need Xcode.

```sh
npm run build:native
npm pack --ignore-scripts
```

`scripts/build-native.cjs` compiles an arm64 helper targeting macOS 15 and applies an ad-hoc signature, then verifies that signature. The package has no install/postinstall lifecycle hook. The explicit `files` list includes only public source, entrypoints, native binary, build script, example, README, and license. The host must not expose these local capture capabilities to an untrusted caller merely because the bundle is installed.
