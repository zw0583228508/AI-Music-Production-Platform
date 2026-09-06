# This linux/amd64 CUDA 12.8 / Python 3.12 image is exclusively for MOSS-Music.
FROM nvidia/cuda@sha256:ea73ae92d1ab9453de0910d342b005aaec8fa2388d3f8913694a6de69392c6ab
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 PATH=/opt/moss-ffmpeg/bin:${PATH} LD_LIBRARY_PATH=/opt/moss-ffmpeg/lib
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 git libsndfile1 python3.12 python3.12-venv \
    && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/bin/python3.12 /usr/local/bin/python \
    && python --version | grep -E '^Python 3\.12\.'
RUN curl -fsSL https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /usr/local/bin --strip-components=1 bin/micromamba \
    && micromamba create -y -p /opt/moss-ffmpeg -c conda-forge "ffmpeg=7.1.1" \
    && test -x /opt/moss-ffmpeg/bin/ffmpeg && test -d /opt/moss-ffmpeg/lib \
    && /opt/moss-ffmpeg/bin/ffmpeg -version | head -1 | grep -E '^ffmpeg version 7\.1\.1'
WORKDIR /app
RUN python3.12 -m venv /opt/moss-venv
COPY services/moss-music-worker/requirements.txt /tmp/requirements.txt
RUN /opt/moss-venv/bin/pip install --upgrade pip \
    && /opt/moss-venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cu128 \
       torch==2.9.1+cu128 torchaudio==2.9.1+cu128 \
       transformers==4.57.1 accelerate==1.12.0 \
    && /opt/moss-venv/bin/pip install \
       "https://files.pythonhosted.org/packages/f6/fd/eec92c82545038a90ffd24e3626bb3a85f7d51577b04819c1c753d380a9b/torchcodec-0.8.0-cp312-cp312-manylinux_2_28_x86_64.whl#sha256=2ec2e874dfb6fbf9bbeb792bea56317529636e78db175f56aad1e4efd6e12502" \
    && /opt/moss-venv/bin/pip install -r /tmp/requirements.txt
# Detached source is an immutable build input, never a serving download. Install
# the base package, not MOSS-Music's local torch-runtime extra: that extra pins
# TorchCodec 0.9.*, while the official moss-audio SGLang branch pins 0.8.0.
RUN git clone https://github.com/OpenMOSS/MOSS-Music.git /opt/moss-music \
    && git -C /opt/moss-music checkout --detach ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e \
    && test "$(git -C /opt/moss-music rev-parse HEAD)" = "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e" \
    && /opt/moss-venv/bin/pip install -e /opt/moss-music
# Follow the pinned MOSS SGLang guide's python[all] install. TorchCodec 0.8.0
# is the branch's declared dependency and Meta's official compatibility table
# pairs TorchCodec 0.8 with Torch 2.9. Keep Torch's transitive cuDNN 9.10.2.21:
# force-installing the guide's separately suggested 9.16 wheel breaks pip check.
RUN git clone https://github.com/OpenMOSS/sglang.git /opt/moss-sglang \
    && git -C /opt/moss-sglang checkout --detach c28a945853c7fee357f55d976b8abce51874bd94 \
    && test "$(git -C /opt/moss-sglang rev-parse HEAD)" = "c28a945853c7fee357f55d976b8abce51874bd94" \
    && /opt/moss-venv/bin/pip install -e "/opt/moss-sglang/python[all]" \
    && /opt/moss-venv/bin/pip check \
    && /opt/moss-venv/bin/python -c "import torch, torchaudio; import importlib.metadata as m; assert torch.__version__ == '2.9.1+cu128'; assert torchaudio.__version__ == '2.9.1+cu128'; assert m.version('torchcodec') == '0.8.0'; assert m.version('transformers') == '4.57.1'; assert m.version('huggingface-hub') == '0.36.2'; assert m.version('gradio') == '5.44.1'; assert m.version('pydantic') == '2.11.10'; assert m.version('fastapi') == '0.115.12'; assert m.version('nvidia-cudnn-cu12') == '9.10.2.21'"
COPY services/moss-music-worker/*.py /app/
COPY services/moss-music-worker/model_manifest.json services/moss-music-worker/license_manifest.json /app/
COPY services/moss-music-worker/Dockerfile services/moss-music-worker/requirements.txt /app/
RUN useradd --system --home /app mossmusic \
    && mkdir -p /var/lib/moss-music/models /var/lib/moss-music/smoke /var/lib/moss-music/artifacts \
    && chown -R mossmusic:mossmusic /app /var/lib/moss-music
USER mossmusic
EXPOSE 8016
CMD ["/opt/moss-venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8016"]