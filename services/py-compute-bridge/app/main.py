from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="EmaAgent Compute Bridge")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


# TODO: 实现 /embed /rerank /narrative/query /memory/* 等接口
