# Desktop Capture 0.2.2

Optional screenshot and recording plugin for OpenBot 0.14.4 and compatible trusted DSH desktop hosts. Supports the host application, a selected application window and a display; recording includes system audio with an optional microphone. Adds explicit system-only audio, owned-window selection and recording startup/finalization fixes. Approved application demonstrations retain private partial recordings when their target disappears.

Download `openbot-dsh-desktop-capture-0.2.2.tgz` and verify `SHA256SUMS`. OpenBot 0.14.4 pins this exact asset and offers Download and install, followed by Enable. Installation does not start recording. Apple Silicon, macOS 15+, ad-hoc signed helpers, not notarized.

## Current limits

- One recording at a time, 15 fps, maximum long edge 1920 pixels. Camera overlays and selectable recording rates/resolutions are not implemented.
- System sound is system-wide, not per-application audio isolation. Microphone capture requires its separate system permission.
- The optional narrated demonstration exporter has a known duration-validation failure in the latest Calculator demonstration. The successful host-app narration run does not establish that every external application can export narration.
- A completed real target-window-close acceptance was not obtained. Further App acceptance was explicitly waived for this release; incomplete or failed checks are not reported as passed.
- The plugin is disabled after host restart and must be enabled when needed. It does not add desktop capabilities to an ordinary CLI without a compatible host.

The 79 plugin tests passed before release. See CANDIDATE-VERIFICATION.json for the bounded historical evidence. No additional functional acceptance was performed for publication.
