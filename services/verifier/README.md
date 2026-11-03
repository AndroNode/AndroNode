# AndroNode reference verifier

Trusted recomputation for the `minilm-l6-v2/onnx-cpu-fp32/r0` testnet profile (whitepaper §9.1).

- `app.py`: FastAPI service. `POST /embed` returns L2-normalised 384-dim vectors (mean pooling, max 256 tokens, no truncation). `POST /tokenize` returns token counts. Both need `Authorization: Bearer $VERIFIER_TOKEN`.
- `Dockerfile`: downloads the ONNX model and tokenizer at build time. Set `MODEL_REVISION` and `MODEL_SHA256` to pin exact artifacts before any paid use.
- `src/index.ts` + `wrangler.jsonc`: deploys the image as a Cloudflare Container behind a Worker, with internet access disabled.

Use it from the API by setting `VERIFIER_MODE=container`, `VERIFIER_URL` (this Worker's URL) and the same `VERIFIER_TOKEN` secret on both Workers.

Local tests: `python -m pytest test_app.py` (uses a fake model; the real model is exercised in CI after the image builds).
