FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    BEAT_THIS_ASSET_ROOT=/var/lib/beat-this
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /uvx /bin/
RUN uv python install 3.11.11 && uv venv --python 3.11.11 /opt/beat-this
ENV PATH="/opt/beat-this/bin:${PATH}"
RUN uv pip install --python /opt/beat-this/bin/python \
    torch==2.5.1+cu124 torchvision==0.20.1+cu124 torchaudio==2.5.1+cu124 \
    --index-url https://download.pytorch.org/whl/cu124
WORKDIR /app
COPY services/beat-this-worker/fixtures/real-audio-source.mp3 /tmp/beat-this-smoke-source.mp3
RUN echo "ae58781b9d3ac4b6e57aaf94a146cb04565ea1b4cc58cc99cdc41cb507274749  /tmp/beat-this-smoke-source.mp3" | sha256sum -c - && \
    mkdir -p /app/_smoke && \
    ffmpeg -v error -ss 30 -t 30 -i /tmp/beat-this-smoke-source.mp3 \
      -map_metadata -1 -vn -ac 1 -ar 22050 -c:a pcm_s16le /app/_smoke/real-audio.wav && \
    printf '%s\n' '{"sourceSha256":"ae58781b9d3ac4b6e57aaf94a146cb04565ea1b4cc58cc99cdc41cb507274749"}' \
      > /app/_smoke/source-evidence.json && \
    rm /tmp/beat-this-smoke-source.mp3
COPY services/beat-this-worker/requirements.txt /tmp/requirements.txt
# Torch and torchaudio were reviewed/installed as one exact CUDA pair. Prevent
# beat-this's broad metadata from allowing the resolver to replace either.
RUN grep -v '^beat-this==' /tmp/requirements.txt > /tmp/support.txt && \
    uv pip install --python /opt/beat-this/bin/python -r /tmp/support.txt && \
    uv pip install --python /opt/beat-this/bin/python beat-this==1.1.0 --no-deps
COPY services/beat-this-worker /app
RUN useradd --system --create-home beat-this && mkdir -p /var/lib/beat-this && chown -R beat-this:beat-this /app /var/lib/beat-this
USER beat-this
EXPOSE 8012
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8012"]