# Multi-stage: uv resolves deps; slim runtime keeps only the venv.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    COLLAB_DATA_DIR=/app/.data/collaboration
EXPOSE 8000
# Bind 0.0.0.0 so published compose port is reachable.
CMD ["uvicorn", "vscode_revealjs_server.app:app", "--host", "0.0.0.0", "--port", "8000"]
