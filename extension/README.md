# RevealJS Collaboration

A VS Code client for the collaborative presentation server. Work in real local folders while collaborative text merges through Yjs and persists across restarts.

- Configure `presentation.serverUrl`, then run **Presentation: Create Presentation** or **Open Presentation**. Sign-in resumes the original action.
- Create/Open always create a dedicated child inside the parent you select; existing children are refused.
- Open Presentation includes owned and shared presentations. Accept Invitation opens the joined presentation directly.
- Edit text with Auto Save on or off. Disconnect keeps local editing and persistence active. Filesystem operations and binary updates are journaled and replayed through HTTP.
- Open Preview creates a private ten-minute session. Publish creates an immutable public release.
- The status bar shows Synced, Syncing, Offline or Conflict. Use Synchronization Details, Retry Synchronization and Resolve Conflict as needed.

Keep `.presentation/`: it contains the local Yjs state, saved-disk baselines, pending journal and recovery copies. Git metadata, VS Code preferences and node_modules are excluded from synchronization. Legacy local differences are preserved for explicit conflict resolution.

Server and extension must both support protocol v2. The stable release version is `0.1.2` for both components.

See the repository `docs/workspace-architecture.md` for protocol and recovery behavior.
