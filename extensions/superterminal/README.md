# DSH SuperTerminal for OpenBot Host API v1

This optional package registers terminal commands and a terminal panel through
the desktop manifest. Feature code runs in its own process; command-history
search/filter lives here and can update independently. The host owns BOT
workspace identity, approvals, PTY ABI, launcher credentials, terminal writer
leases, sequence checks, bounded transcripts and native cleanup.

Requires the new compatible OpenBot Host API v1 host; delivered OpenBot 0.14.4
does not yet load this package. The package is distributed through the signed desktop plugin catalog.
Install/enable does not replay commands or automatically open a terminal. Active
terminals must be explicitly stopped before update/rollback. Command transcripts
are display data; rerun remains a separate approved, lease-fenced operation.

Version 0.2.1 normalizes equivalent full-width/half-width Unicode text during
command-history search. This feature executes in the plugin, without changing
the host PTY ABI. Install/update/rollback is available in Desktop plugins settings.
