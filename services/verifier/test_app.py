import numpy as np
from fastapi.testclient import TestClient

import app as verifier


def test_mean_pool_ignores_padding():
    emb = np.array([[[1.0, 1.0], [3.0, 3.0], [100.0, 100.0]]], dtype=np.float32)
    mask = np.array([[1, 1, 0]])
    assert np.allclose(verifier.mean_pool(emb, mask), [[2.0, 2.0]])


def test_l2_normalize_unit_length():
    v = verifier.l2_normalize(np.array([[3.0, 4.0], [0.0, 0.0]]))
    assert np.allclose(v[0], [0.6, 0.8])
    assert np.allclose(v[1], [0.0, 0.0])


def test_auth_required(monkeypatch):
    monkeypatch.setenv("VERIFIER_TOKEN", "secret-token")
    client = TestClient(verifier.app)
    assert client.get("/health").status_code == 200
    assert client.post("/embed", json={"texts": ["a"]}).status_code == 401
    assert client.post("/embed", json={"texts": ["a"]}, headers={"authorization": "Bearer wrong"}).status_code == 401


def test_embed_with_fake_model(monkeypatch):
    monkeypatch.setenv("VERIFIER_TOKEN", "t")

    class Fake:
        model_sha256 = "ab" * 32
        def embed(self, texts):
            return verifier.l2_normalize(np.ones((len(texts), 384)))
        def count(self, texts):
            return [len(t.split()) + 2 for t in texts]

    monkeypatch.setattr(verifier, "_embedder", Fake())
    client = TestClient(verifier.app)
    r = client.post("/embed", json={"texts": ["x", "y"]}, headers={"authorization": "Bearer t"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["vectors"]) == 2 and len(body["vectors"][0]) == 384
    assert abs(np.linalg.norm(body["vectors"][0]) - 1) < 1e-9
    assert client.post("/tokenize", json={"texts": ["a b c"]}, headers={"authorization": "Bearer t"}).json() == {"counts": [5]}
