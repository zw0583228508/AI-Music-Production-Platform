# Isolated AnyAccomp runtime. Source and checkpoints are mounted read-only in practice.
FROM nvidia/cuda@sha256:f4d8e1264366940438f0353da6f289c7bef069d993d111f8106086ccd18c4a30
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg g++ libsndfile1 python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir uv==0.9.26 \
 && uv python install 3.10.12 \
 && uv venv --seed --python 3.10.12 /opt/anyaccomp-venv \
 && /opt/anyaccomp-venv/bin/python -c 'import sys; assert sys.version_info[:3] == (3, 10, 12), sys.version'
COPY services/anyaccomp-worker/runtime-requirements.txt /tmp/runtime-requirements.txt
RUN /opt/anyaccomp-venv/bin/pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cu121 \
      torch==2.3.1 torchaudio==2.3.1 torchvision==0.18.1 \
 && /opt/anyaccomp-venv/bin/pip install --no-cache-dir -r /tmp/runtime-requirements.txt \
 && /opt/anyaccomp-venv/bin/pip check
RUN ln -sf /opt/anyaccomp-venv/bin/python /usr/local/bin/python \
 && ln -sf /opt/anyaccomp-venv/bin/python3 /usr/local/bin/python3 \
 && ln -sf /opt/anyaccomp-venv/bin/python3.10 /usr/local/bin/python3.10
ARG SOURCE_IMAGE_DIGEST
RUN echo "${SOURCE_IMAGE_DIGEST}" | grep -Eq '^sha256:[a-f0-9]{64}$'
ENV MUSIC_GPU_CONTAINER_DIGEST=${SOURCE_IMAGE_DIGEST}
WORKDIR /app
COPY services/anyaccomp-worker/app.py \
     services/anyaccomp-worker/fixture.py \
     services/anyaccomp-worker/inference.py \
     services/anyaccomp-worker/license_manifest.json \
     services/anyaccomp-worker/model_manifest.json \
     services/anyaccomp-worker/runner.py \
     services/anyaccomp-worker/smoke.py \
     /app/
RUN useradd --system anyaccomp \
 && mkdir -p /var/lib/anyaccomp/models /var/lib/anyaccomp/artifacts \
 && chown -R anyaccomp:anyaccomp /app /var/lib/anyaccomp
USER anyaccomp
CMD ["/opt/anyaccomp-venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]