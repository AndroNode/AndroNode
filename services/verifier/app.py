"""AndroNode reference verifier: trusted recomputation for the MiniLM embedding profile (§9.1).

Runs all-MiniLM-L6-v2 (ONNX, CPU, FP32) with the same tokenizer, mean pooling and L2 normalisation
the Android client must use. The coordinator compares device vectors against these references.
No outbound network access is needed at runtime; the model is baked into the image.
"""
from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

MODEL_DIR = Path(os.environ.get("MODEL_DIR", "/models/minilm"))
MAX_TOKENS = 256
MAX_TEXTS = 64
VERIFIER_ID = "minilm-l6-v2/onnx-cpu-fp32/verifier-r0"


def mean_pool(token_embeddings: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    mask = attention_mask[..., None].astype(np.float32)
    summed = (token_embeddings * mask).sum(axis=1)
    counts = np.clip(mask.sum(axis=1), 1e-9, None)
    return summed / counts


def l2_normalize(v: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.clip(norms, 1e-12, None)


class Embedder:
    def __init__(self, model_dir: Path):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.environ.get("THREADS", "2"))
        self.session = ort.InferenceSession(str(model_dir / "model.onnx"), sess_options=opts, providers=["CPUExecutionProvider"])
        self.input_names = {i.name for i in self.session.get_inputs()}
        self.tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.model_sha256 = hashlib.sha256((model_dir / "model.onnx").read_bytes()).hexdigest()

    def count(self, texts: list[str]) -> list[int]:
        return [len(e.ids) for e in self.tokenizer.encode_batch(texts)]

    def embed(self, texts: list[str]) -> np.ndarray:
        enc = self.tokenizer.encode_batch(texts)
        too_long = [i for i, e in enumerate(enc) if len(e.ids) > MAX_TOKENS]
        if too_long:
            raise HTTPException(422, f"records over {MAX_TOKENS} tokens: {too_long}")
        width = max(len(e.ids) for e in enc)
        ids = np.zeros((len(enc), width), dtype=np.int64)
        mask = np.zeros((len(enc), width), dtype=np.int64)
        for i, e in enumerate(enc):
            ids[i, : len(e.ids)] = e.ids
            mask[i, : len(e.ids)] = 1
        feeds = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            feeds["token_type_ids"] = np.zeros_like(ids)
        out = self.session.run(None, feeds)[0]
        return l2_normalize(mean_pool(out.astype(np.float32), mask))


app = FastAPI(title="AndroNode verifier", docs_url=None, redoc_url=None)
_embedder: Embedder | None = None


def embedder() -> Embedder:
    global _embedder
    if _embedder is None:
        _embedder = Embedder(MODEL_DIR)
    return _embedder


def require_token(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("VERIFIER_TOKEN", "")
    given = authorization.removeprefix("Bearer ").strip()
    if not expected or not hmac.compare_digest(given, expected):
        raise HTTPException(401, "unauthorized")


class Texts(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_TEXTS)


class CountTexts(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=10_000)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "verifier": VERIFIER_ID}


@app.post("/embed", dependencies=[Depends(require_token)])
def embed(req: Texts) -> dict:
    e = embedder()
    vectors = e.embed(req.texts)
    return {"verifier": f"{VERIFIER_ID}#{e.model_sha256[:16]}", "vectors": vectors.astype(float).tolist()}


@app.post("/tokenize", dependencies=[Depends(require_token)])
def tokenize(req: CountTexts) -> dict:
    return {"counts": embedder().count(req.texts)}
