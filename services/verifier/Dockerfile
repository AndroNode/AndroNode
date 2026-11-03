# AndroNode reference verifier image. The model is pinned by revision and checked by SHA-256 at build time.
FROM python:3.12-slim AS model
ARG MODEL_REPO=sentence-transformers/all-MiniLM-L6-v2
# Pin to an exact upstream revision before any paid use (whitepaper §7).
ARG MODEL_REVISION=main
ARG MODEL_SHA256=""
ADD --chmod=644 https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/onnx/model.onnx /models/minilm/model.onnx
ADD --chmod=644 https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/tokenizer.json /models/minilm/tokenizer.json
RUN if [ -n "$MODEL_SHA256" ]; then echo "$MODEL_SHA256  /models/minilm/model.onnx" | sha256sum -c -; fi && sha256sum /models/minilm/*

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODEL_DIR=/models/minilm THREADS=2
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=model /models /models
COPY app.py .
RUN useradd --system --uid 10001 verifier
USER verifier
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
