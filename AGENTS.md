# Engineering principles

Lazy senior developer: efficient, not careless.

1. Do we need it?
2. Can existing code / stdlib / platform already do it?
3. Can an existing dependency do it?
4. Otherwise write the minimum correct code.

Trace the affected flow before changing code; optimize for the smallest correct root-cause fix. Fix the root cause and inspect all callers of the changed behavior.

Avoid speculative abstractions, dependencies, boilerplate, and files; prefer deletion and existing simple patterns. Minimum code must still be correct at trust boundaries and edge cases.

Do not trade away correctness, security, data integrity, or explicit requirements for smaller code.

Leave no dead code, unused dependencies, placeholder stubs, duplicate paths, or superseded implementations.

Mark intentional PoC shortcuts with a `ponytail:` comment naming the ceiling and upgrade path.

# Scope

- Implement only the requested / current GitHub Milestone (or explicitly requested) scope. Do not implement later phases "while you're here."
- MVP non-goals in `docs/non-goals.md` stay out of scope unless the user overrides.

# Repo constraints

- Python tooling: use `uv`; do not use `pip` or manually edit dependencies when `uv` provides the operation.
- Prefer `src/vscode_revealjs_server/` over inventing parallel apps or packages.

# Verification

- Do not add or maintain unit tests. Verify through Docker Compose and real VS Code Extension Development Host behavior.
- Server acceptance / integration checks must run against the Docker Compose published endpoint, not a host-side uvicorn.
- Collaboration acceptance requires two real VS Code Extension Development Host instances.

# Git

- Do not invent or change the local git author identity.
- Do not commit development plans, progress logs, milestone checklists, open decisions, roadmaps, or todos. Those belong in GitHub Issues and Milestones (or local gitignored notes under `docs/archived/`, `docs/milestones/`, `docs/improvement-roadmap.md`, etc.), not in the tracked tree.
- Product docs that describe behavior (`README`, `docs/non-goals.md`, architecture / product specs) may stay in git; strip process diary and acceptance checklists from them when editing.

# Releases

- Canonical version is `pyproject.toml` `[project].version` (e.g. `0.1.0`).
- To cut a release: bump that version first, keep `compose.yaml` `image:` tag on the same `X.Y.Z`, commit, push `main`, then create and push git tag `vX.Y.Z` (must match exactly). Do not push a release tag before the version bump is on the commit being tagged.
- Tag `v*` triggers `.github/workflows/release.yml` (VSIX on GitHub Release + multi-arch image to `ghcr.io/phate334/vscode-revealjs-server`).
- Do not invent ad-hoc version numbers in the extension or image tags that diverge from `pyproject.toml`.

## Release candidates

- `uv version X.Y.ZrcN --no-sync` updates the canonical Python version and lockfile.
- Compose and git tags retain the full canonical version (`X.Y.ZrcN`, `vX.Y.ZrcN`).
- VS Code requires a numeric `X.Y.Z` manifest version. Derive it from the canonical version; package RC builds with `vsce --pre-release`. Keep the RC suffix in the VSIX filename and GitHub Release tag.
- RC releases are marked prerelease and must not move the stable image's `latest` tag.
- A feature-branch version bump does not authorize creating a release tag or publishing a release.
