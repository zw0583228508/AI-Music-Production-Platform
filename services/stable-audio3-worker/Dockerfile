FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04
ARG SOURCE_REVISION=779434a908193105335fd8d833418603625b2859
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git python3.10 python3.10-venv ffmpeg && rm -rf /var/lib/apt/lists/*
RUN python3.10 -m venv /opt/stable-audio3-venv && /opt/stable-audio3-venv/bin/pip install --no-cache-dir uv
RUN git clone https://github.com/Stability-AI/stable-audio-3.git /opt/stable-audio-3-source && git -C /opt/stable-audio-3-source checkout --detach ${SOURCE_REVISION} && test "$(git -C /opt/stable-audio-3-source rev-parse HEAD)" = "${SOURCE_REVISION}"
RUN cd /opt/stable-audio-3-source && VIRTUAL_ENV=/opt/stable-audio3-venv /opt/stable-audio3-venv/bin/uv sync --frozen --active
COPY services/stable-audio3-worker /app
WORKDIR /app