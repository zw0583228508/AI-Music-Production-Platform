ARG CUDA_IMAGE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
FROM ${CUDA_IMAGE}
ARG PROVIDER_REQUIREMENTS=""
ARG CUDA_RUNTIME=12.4.1
ARG PYTORCH_SPEC=torch==2.5.1+cu124
ARG TORCHVISION_SPEC=torchvision==0.20.1+cu124
ARG TORCHAUDIO_SPEC=torchaudio==2.5.1+cu124
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124
ARG TRANSFORMERS_SPEC=transformers==4.48.3
ARG ACCELERATE_SPEC=accelerate==1.3.0

# Keep source-build identity out of Docker build arguments. Modal includes
# build-argument values in its image cache identity, while source identity is
# supplied as runtime provenance by modal_config.worker_environment().
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MUSIC_GPU_CHECKPOINT_ROOT=/var/lib/music-ai-gpu/models \
    MUSIC_GPU_CUDA_VERSION=${CUDA_RUNTIME}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /uvx /bin/
RUN uv python install 3.11.11
RUN uv venv --python 3.11.11 /opt/music-ai-venv
ENV PATH="/opt/music-ai-venv/bin:${PATH}"
RUN uv pip install --python /opt/music-ai-venv/bin/python \
    "${PYTORCH_SPEC}" "${TORCHVISION_SPEC}" "${TORCHAUDIO_SPEC}" \
    --index-url "${TORCH_INDEX_URL}"
RUN uv pip install --python /opt/music-ai-venv/bin/python \
    fastapi==0.141.1 uvicorn==0.52.4 pydantic==2.13.5 \
    "${TRANSFORMERS_SPEC}" "${ACCELERATE_SPEC}"

WORKDIR /app
COPY services/music-ai-gpu-worker/runners/requirements-*.txt /tmp/runner-requirements/
RUN test -z "$PROVIDER_REQUIREMENTS" || \
    uv pip install --python /opt/music-ai-venv/bin/python \
      -r "/tmp/runner-requirements/${PROVIDER_REQUIREMENTS}"
COPY services/music-ai-gpu-worker /app
RUN groupadd --system music-ai && useradd --system --gid music-ai --home /app music-ai \
    && mkdir -p /var/lib/music-ai-gpu/models \
    && chown -R music-ai:music-ai /app /var/lib/music-ai-gpu
EXPOSE 8009
USER music-ai
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8009"]