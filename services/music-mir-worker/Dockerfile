FROM python:3.11.11-slim-bookworm@sha256:081075da77b2b55c23c088251026fb69a7b2bf92471e491ff5fd75c192fd38e5

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 MIR_ASSET_ROOT=/var/lib/music-mir/assets
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv@sha256:5713fa8217f92b80223bc83aac7db36ec80a84437dbc0d04bbc659cae030d8c9 /uv /usr/local/bin/uv
WORKDIR /app
COPY services/music-mir-worker/requirements-py311.txt /tmp/requirements.in
RUN uv venv /opt/mir-venv --python 3.11.11 && \
    uv pip compile /tmp/requirements.in --output-file /tmp/requirements.lock \
      --generate-hashes --python-version 3.11.11 \
      --python-platform x86_64-manylinux_2_28 --only-binary :all: \
      --prerelease allow --no-annotate --no-header && \
    echo "210354042a315551890099c011b375f2ad7df7b5261f9527a16b5176cf2ec2ff  /tmp/requirements.lock" | sha256sum -c - && \
    uv pip install --python /opt/mir-venv/bin/python \
      --require-hashes --only-binary :all: -r /tmp/requirements.lock && \
    install -m 0444 /tmp/requirements.lock /opt/mir-venv/requirements.lock
ENV PATH="/opt/mir-venv/bin:$PATH" MIR_ENABLED_PROVIDERS="MADMOM,TORCHCREPE,PYLOUDNORM"
COPY services/music-mir-worker /app
RUN groupadd --system mir && useradd --system --gid mir --home /app mir && \
    mkdir -p /var/lib/music-mir/assets && chown -R mir:mir /app /var/lib/music-mir
USER mir
EXPOSE 8010
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010"]