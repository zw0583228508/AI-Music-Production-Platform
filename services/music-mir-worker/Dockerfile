FROM python:3.11.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 MIR_ASSET_ROOT=/var/lib/music-mir/assets
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /usr/local/bin/uv
WORKDIR /app
COPY services/music-mir-worker/requirements-py311.txt /tmp/requirements.txt
RUN uv venv /opt/mir-venv --python 3.11.11 && \
    uv pip install --python /opt/mir-venv/bin/python -r /tmp/requirements.txt
ENV PATH="/opt/mir-venv/bin:$PATH" MIR_ENABLED_PROVIDERS="MADMOM,TORCHCREPE,PYLOUDNORM"
COPY services/music-mir-worker /app
RUN groupadd --system mir && useradd --system --gid mir --home /app mir && \
    mkdir -p /var/lib/music-mir/assets && chown -R mir:mir /app /var/lib/music-mir
USER mir
EXPOSE 8010
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010"]