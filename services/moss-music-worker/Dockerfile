# This CUDA 12.8 / Python 3.12 image is exclusively for MOSS-Music.
FROM nvidia/cuda:12.8.0-cudnn-devel-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 PATH=/opt/moss-ffmpeg/bin:${PATH} LD_LIBRARY_PATH=/opt/moss-ffmpeg/lib
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 git libsndfile1 python3.12 python3.12-venv \
    && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/bin/python3.12 /usr/local/bin/python \
    && python --version | grep -E '^Python 3\.12\.'
RUN curl -fsSL https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /usr/local/bin --strip-components=1 bin/micromamba \
    && micromamba create -y -p /opt/moss-ffmpeg -c conda-forge "ffmpeg=7" \
    && test -x /opt/moss-ffmpeg/bin/ffmpeg && test -d /opt/moss-ffmpeg/lib \
    && /opt/moss-ffmpeg/bin/ffmpeg -version | head -1
WORKDIR /app
RUN python3.12 -m venv /opt/moss-venv
COPY services/moss-music-worker/requirements.txt /tmp/requirements.txt
RUN /opt/moss-venv/bin/pip install --upgrade pip \
    && /opt/moss-venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cu128 torch==2.9.1+cu128 torchaudio==2.9.1+cu128 \
    && /opt/moss-venv/bin/pip install -r /tmp/requirements.txt
# Detached source and its submodules are immutable build inputs, never a serving download.
RUN git clone https://github.com/OpenMOSS/MOSS-Music.git /opt/moss-music \
    && git -C /opt/moss-music checkout --detach ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e \
    && git -C /opt/moss-music submodule update --init --recursive \
    && test "$(git -C /opt/moss-music rev-parse HEAD)" = "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e" \
    && /opt/moss-venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cu128 -e "/opt/moss-music[torch-runtime]"
# The pinned MOSS guide recommends cuDNN 9.16.0.29, but its pip resolver
# conflicts with torch 2.9.1+cu128, whose wheel requires 9.10.2.21. Keep the
# wheel's transitive cuDNN and install the exact moss-audio SGLang source; its
# pyproject pins torch but declares no cuDNN dependency.
RUN git clone https://github.com/OpenMOSS/sglang.git /opt/moss-sglang \
    && git -C /opt/moss-sglang checkout --detach c28a945853c7fee357f55d976b8abce51874bd94 \
    && test "$(git -C /opt/moss-sglang rev-parse HEAD)" = "c28a945853c7fee357f55d976b8abce51874bd94" \
    && /opt/moss-venv/bin/pip install -e "/opt/moss-sglang/python[all]" \
    && /opt/moss-venv/bin/pip check \
    && /opt/moss-venv/bin/python -c "import torch; assert torch.__version__ == '2.9.1+cu128'; import importlib.metadata as m; assert m.version('nvidia-cudnn-cu12') == '9.10.2.21'"
COPY services/moss-music-worker/ /app/
RUN /opt/moss-venv/bin/python /app/preflight.py
RUN useradd --system --home /app mossmusic \
    && mkdir -p /var/lib/moss-music/models /var/lib/moss-music/smoke /var/lib/moss-music/artifacts \
    && chown -R mossmusic:mossmusic /app /var/lib/moss-music
USER mossmusic
EXPOSE 8016
CMD ["/opt/moss-venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8016"]