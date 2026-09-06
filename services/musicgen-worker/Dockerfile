# Dedicated MusicGen image. Never combine this runtime with ACE-Step or another provider.
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates ffmpeg git libsndfile1 pkg-config python3 \
    libavcodec-dev libavdevice-dev libavfilter-dev libavformat-dev \
    libavutil-dev libswresample-dev libswscale-dev \
    && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
    && ln -sf /usr/bin/python3 /usr/local/bin/python3
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /uvx /bin/
RUN uv python install 3.9.19 && uv venv --python 3.9.19 /opt/musicgen-venv
RUN uv pip install --python /opt/musicgen-venv/bin/python \
    torch==2.1.0+cu118 torchaudio==2.1.0+cu118 --index-url https://download.pytorch.org/whl/cu118
WORKDIR /app
COPY services/musicgen-worker/requirements.txt /tmp/requirements.txt
RUN uv pip install --python /opt/musicgen-venv/bin/python -r /tmp/requirements.txt
# Checkout is verified before installation: no floating branch is ever used.
RUN git clone https://github.com/facebookresearch/audiocraft.git /opt/audiocraft \
    && git -C /opt/audiocraft checkout --detach 896ec7c47f5e5d1e5aa1e4b260c4405328bf009d \
    && test "$(git -C /opt/audiocraft rev-parse HEAD)" = "896ec7c47f5e5d1e5aa1e4b260c4405328bf009d" \
    && uv pip install --python /opt/musicgen-venv/bin/python -e /opt/audiocraft
COPY services/musicgen-worker/app.py services/musicgen-worker/bootstrap_assets.py \
     services/musicgen-worker/smoke.py services/musicgen-worker/modal_app.py \
     services/musicgen-worker/modal_provision.py services/musicgen-worker/modal_config.py \
     services/musicgen-worker/workload_entrypoint.py services/musicgen-worker/model_manifest.json /app/
COPY services/musicgen-worker/Dockerfile services/musicgen-worker/requirements.txt /app/
RUN useradd --system --home /app musicgen \
    && mkdir -p /var/lib/musicgen/models /var/lib/musicgen/smoke /var/lib/musicgen/artifacts \
    && chown -R musicgen:musicgen /app /var/lib/musicgen
USER musicgen
EXPOSE 8015
CMD ["/opt/musicgen-venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8015"]