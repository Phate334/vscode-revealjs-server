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

- Implement only the requested / current milestone scope. Do not implement later phases "while you're here."
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
- Do not commit local-only progress / process files if they exist and are gitignored (e.g. milestone progress trackers).
