FROM nvidia/cuda:12.4.1-cudnn9-runtime-ubuntu22.04
ARG PROVIDER_REQUIREMENTS=""
ARG MUSIC_GPU_SOURCE_IMAGE_DIGEST=""

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MUSIC_GPU_CHECKPOINT_ROOT=/var/lib/music-ai-gpu/models \
    MUSIC_GPU_CUDA_VERSION=12.4.1 \
    MUSIC_GPU_CONTAINER_DIGEST=${MUSIC_GPU_SOURCE_IMAGE_DIGEST}

COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /uvx /bin/
RUN uv python install 3.11.11
RUN uv pip install --python 3.11.11 \
    torch==2.5.1+cu124 --index-url https://download.pytorch.org/whl/cu124
RUN uv pip install --python 3.11.11 \
    fastapi==0.141.1 uvicorn==0.52.4 pydantic==2.13.5 \
    transformers==4.48.3 accelerate==1.3.0

WORKDIR /app
COPY services/music-ai-gpu-worker /app
RUN test -z "$PROVIDER_REQUIREMENTS" || \
    uv pip install --python 3.11.11 -r "/app/runners/${PROVIDER_REQUIREMENTS}"
RUN groupadd --system music-ai && useradd --system --gid music-ai --home /app music-ai \
    && mkdir -p /var/lib/music-ai-gpu/models \
    && chown -R music-ai:music-ai /app /var/lib/music-ai-gpu
VOLUME ["/var/lib/music-ai-gpu/models"]
EXPOSE 8009
USER music-ai
CMD ["uv", "run", "--python", "3.11.11", "--no-project", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8009"]