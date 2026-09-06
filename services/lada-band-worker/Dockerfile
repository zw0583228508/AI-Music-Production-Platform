# Dedicated LaDA-Band research runtime; it is never shared with ACE-Step.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04
COPY services/lada-band-worker/license_manifest.json /tmp/lada-band-license-manifest.json
COPY services/lada-band-worker/release-evidence/license-review.json /tmp/lada-band-license-review.json
# Fail before apt, git clone, or dependency downloads. Future authorization must
# update retained evidence and the machine-readable manifest together.
RUN grep -Fq '"license_status": "RESEARCH_ONLY_AUTHORIZED"' /tmp/lada-band-license-manifest.json \
 && grep -Fq '"routing_status": "RESEARCH_READY_CANDIDATE"' /tmp/lada-band-license-manifest.json \
 && grep -Fq '"researchUseAuthorized": true' /tmp/lada-band-license-review.json \
 && grep -Fq '"runtimeBuildAuthorized": true' /tmp/lada-band-license-review.json \
 || (echo 'BLOCKED_LICENSE: LaDA-Band image build refused before upstream download' >&2; exit 1)
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 python3.10 python3.10-venv && rm -rf /var/lib/apt/lists/*
RUN python3.10 -m venv /opt/lada-band-venv
COPY services/lada-band-worker/requirements.txt /tmp/requirements.txt
RUN /opt/lada-band-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
RUN git clone https://github.com/Duoluoluos/TME-LaDA-Band.git /opt/lada-band && git -C /opt/lada-band checkout --detach e4ff7918454d96912b366ef8e12e792b0066c1c6 && test "$(git -C /opt/lada-band rev-parse HEAD)" = "e4ff7918454d96912b366ef8e12e792b0066c1c6" && /opt/lada-band-venv/bin/pip install -r /opt/lada-band/requirements.txt
WORKDIR /app
COPY services/lada-band-worker/ /app/
RUN useradd --system lada && mkdir -p /var/lib/lada-band/{models,smoke,artifacts} && chown -R lada:lada /app /var/lib/lada-band
USER lada
CMD ["/opt/lada-band-venv/bin/python","-m","uvicorn","app:app","--host","0.0.0.0","--port","8017"]