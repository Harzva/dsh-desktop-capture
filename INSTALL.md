# Install

This release supports Apple Silicon Macs running macOS 15 or newer. Camera overlays are not included.

## OpenBot

Use an OpenBot build that includes the optional desktop capture plugin manager. Open the capture menu next to the chat input, choose **Download and install**, wait for the verified installation, then choose **Enable**. Installing does not start capture or grant macOS permissions. The host must have the required screen recording and microphone permissions before recording.

Choose OpenBot itself, an application window, or a display, then capture or record. Recordings include system-wide audio and microphone audio. The same installed capability is available to permitted Bots. The plugin is installed but disabled after restarting OpenBot; enable it again when needed.

The menu also supports **Install from file** using the exact released `.tgz`. Disabling or uninstalling keeps existing chat screenshots and recordings.

## Release files

[Download v0.1.0](https://github.com/Harzva/dsh-desktop-capture/releases/tag/v0.1.0). Verify the archive against `SHA256SUMS` before using a separate host. The supplied helper is ad-hoc signed, not notarized. `release.json` contains the package, admitted bundle, and native-helper SHA256 pins used by OpenBot.

## Other DSH hosts

Follow the service and attachment-store contract in README.md and examples/host.mjs. A plain CLI without a desktop host and its permissions cannot acquire an application window.
