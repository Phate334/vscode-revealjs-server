from fastapi import FastAPI

app = FastAPI(title="vscode-revealjs-server")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
