# Dedicated HAFM runtime; no shared model environment.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ffmpeg libsndfile1 python3.10 python3.10-venv && rm -rf /var/lib/apt/lists/*
RUN python3.10 -m venv /opt/hafm-venv
# Modal's control runtime discovers Python through the standard system paths;
# point every expected name at this worker's isolated interpreter.
RUN ln -sf /opt/hafm-venv/bin/python /usr/local/bin/python \
 && ln -sf /opt/hafm-venv/bin/python3 /usr/local/bin/python3 \
 && ln -sf /opt/hafm-venv/bin/python3.10 /usr/local/bin/python3.10 \
 && python --version | grep -E '^Python 3\.10\.'
COPY services/hafm-worker/requirements.txt /tmp/requirements.txt
RUN /opt/hafm-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
# This exact upstream tree declares inference through README.md and contains no
# Python package metadata or requirements file. Keep it as source; production
# runtime dependencies are pinned in this worker's requirements.txt above.
RUN git clone https://github.com/HackerHyper/HAFM.git /opt/hafm \
 && git -C /opt/hafm checkout --detach d9aa19a5820a4c1563ab405d437933480f71d5b9 \
 && test "$(git -C /opt/hafm rev-parse HEAD)" = "d9aa19a5820a4c1563ab405d437933480f71d5b9" \
 && test -f /opt/hafm/README.md \
 && test -f /opt/hafm/infer.py \
 && test ! -e /opt/hafm/requirements.txt \
 && grep -F "python infer_simple.py" /opt/hafm/README.md
WORKDIR /app
COPY services/hafm-worker/*.py /app/
COPY services/hafm-worker/model_manifest.json services/hafm-worker/license_manifest.json services/hafm-worker/fixture-authorization.json /app/
COPY services/hafm-worker/Dockerfile services/hafm-worker/requirements.txt /app/
RUN useradd --system hafm && mkdir -p /var/lib/hafm/{models,smoke,artifacts} && chown -R hafm:hafm /app /var/lib/hafm
USER hafm
CMD ["/opt/hafm-venv/bin/python","-m","uvicorn","app:app","--host","0.0.0.0","--port","8018"]