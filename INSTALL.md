# Install

This release supports Apple Silicon Macs running macOS 15 or newer. Camera overlays are not included.

## OpenBot

Use an OpenBot build that includes the optional desktop capture plugin manager. Open the capture menu next to the chat input, choose **Download and install**, wait for the verified installation, then choose **Enable**. Installing does not start capture or grant macOS permissions. The host must have the required screen recording and microphone permissions before recording.

Choose OpenBot itself, an application window, or a display, then capture or record. Recordings include system-wide audio and microphone audio. The same installed capability is available to permitted Bots. The plugin is installed but disabled after restarting OpenBot; enable it again when needed.

The menu also supports **Install from file** using the exact released `.tgz`. Disabling or uninstalling keeps existing chat screenshots and recordings.

## Release files

[Download v0.2.0](https://github.com/Harzva/dsh-desktop-capture/releases/tag/v0.2.0). Verify the archive against `SHA256SUMS` before using a separate host. The supplied helpers are ad-hoc signed, not notarized. `release.json` contains the package, admitted bundle, and both native-helper SHA256 pins used by a compatible OpenBot build. An older host pinned to v0.1.1 continues to use that release; this plugin does not upgrade the host automatically.

Version 0.2.0 adds optional application-demonstration components for a compatible trusted host: exact-window AX control, a frozen approved plan, recording, macOS voice narration and MP4/SRT export. Installing the package alone does not add these tools to a plain DSH CLI or an older OpenBot build. See README.md for the host lifecycle and additional Accessibility, voice and media-tool requirements.

Recording is currently single-session, with a 15 fps capture interval and a maximum long edge of 1920 pixels. Multiple simultaneous videos, selectable frame rates/resolutions and camera overlays are not included in this release.

## Other DSH hosts

Follow the service and attachment-store contract in README.md and examples/host.mjs. A plain CLI without a desktop host and its permissions cannot acquire an application window.
