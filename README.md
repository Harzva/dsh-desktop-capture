# DSH Desktop Capture · Host API 1

Optional screenshot, screen recording and narrated demonstration features for
OpenBot's independent desktop plugin host. Version 0.3.1 requires Host API ^1.0.0,
bundled Node 22, macOS 15+ and Apple Silicon. OpenBot 0.14.4's legacy loader is not
compatible; use 0.2.2 with that older host.

Install from Settings → App connections → Desktop plugins. Installation starts
disabled. Enable explicitly, then use the existing camera/recording controls or
the BOT's `app_observe` and `app_demo` tools. macOS screen recording, microphone
and accessibility permissions remain required for the operations that use them.
Installing a plugin does not grant permission or start capture.

Supported sources are OpenBot, one selected application window, and the display.
Compatible hosts also provide public game-room spectator capture and browser
playback recording. A lost/closed source fails without switching to another app.
Browser recording cannot unlock inaccessible or protected players. Window video
can include system-wide audio and optional microphone; it is not app-only sound.
The existing backend supports one recording at a time, a 15 fps capture interval,
a maximum 1920-pixel long edge, and bounded durations/files. Camera picture-in-
picture, simultaneous recordings and selectable fps/resolution are not included.
Existing external-app narrated export and close-window evidence limitations are
retained; this host update does not claim they were fixed.

0.3.1 improves application search for equivalent full-width/half-width Unicode
text, without changing native capture behavior. Host API 1 packages update and
roll back independently after explicit approval. Stop active recording before
changing versions. A failed update keeps the prior version; original settings and
recordings are retained. Legacy 0.2.x installation metadata is not a signature.

The signed manifest describes a separate Node worker. No downloaded `host.cjs`,
Electron platform classes, or approval/director runtime is loaded into the host.
OpenBot owns BOT identity, authorization, native handles and private media paths.
Narration/encoder composition runs in an owned helper process; immutable bundle
and helper hashes are checked before execution. Node process separation provides
fault isolation for trusted publishers, not an OS sandbox against malicious code.

## Maintainers

Run `npm run build:native` and `npm run build:demo-native` only when changing native
helper source, then `npm run build:desktop-manifest`. Xcode is a build dependency,
not an end-user requirement. `npm pack` refreshes helper pins. Sign exact archives
and manifests through the Host API 1 catalog; never rewrite a published version.
Source files for the older injection interface remain for regression/reference;
`LEGACY-0.2.md` describes that historical API and is not a v1 installation guide.

MIT licensed.
