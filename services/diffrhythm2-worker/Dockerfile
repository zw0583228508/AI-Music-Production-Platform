# Isolated only: never share this runtime with any existing music provider.
FROM nvidia/cuda@sha256:59e0e4376a0f16d10b03d3a14344b80a866a1674cb4948cb318291387ac05010
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ffmpeg espeak-ng python3.11 python3.11-dev python3.11-venv && rm -rf /var/lib/apt/lists/*
RUN ffmpeg -hide_banner -encoders 2>&1 | grep -q libmp3lame && \
    ffmpeg -hide_banner -encoders 2>&1 | grep -qE '(^|[[:space:]])aac([[:space:]]|$)' && \
    ffmpeg -hide_banner -encoders 2>&1 | grep -q libopus
RUN python3.11 -m venv /opt/diffrhythm2-venv
RUN ln -s /opt/diffrhythm2-venv/bin/python /usr/local/bin/python && \
    ln -s /opt/diffrhythm2-venv/bin/python /usr/local/bin/python3 && \
    ln -s /opt/diffrhythm2-venv/bin/python /usr/local/bin/python3.11 && \
    /usr/local/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 11), sys.version'
COPY services/diffrhythm2-worker/requirements.txt /tmp/requirements.txt
RUN /opt/diffrhythm2-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt && \
    /opt/diffrhythm2-venv/bin/pip install --no-cache-dir \
      torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0
RUN set -eux; \
    git clone https://github.com/xiaomi-research/diffrhythm2.git /opt/diffrhythm2; \
    git -C /opt/diffrhythm2 checkout --detach 13a7b091f45124f611e36ee674973234f38d55b6; \
    actual_revision="$(git -C /opt/diffrhythm2 rev-parse HEAD)"; \
    echo "DiffRhythm2 checked-out revision: ${actual_revision}"; \
    test "${actual_revision}" = "13a7b091f45124f611e36ee674973234f38d55b6"; \
    test -s /opt/diffrhythm2/requirements.txt; \
    echo "Pinned DiffRhythm2 upstream requirements:"; \
    cat /opt/diffrhythm2/requirements.txt; \
    /opt/diffrhythm2-venv/bin/pip install --no-cache-dir -r /opt/diffrhythm2/requirements.txt
# The pinned source imports this in its English G2P path but omits it from
# requirements.txt. Keep the corrected transitive dependency explicit.
RUN /opt/diffrhythm2-venv/bin/pip install --no-cache-dir inflect==7.5.0 && \
    /opt/diffrhythm2-venv/bin/python -c 'import inflect; assert inflect.engine()'
# Comparison memory is regression-tested against these exact native-library
# versions. Any upgrade must pass the mono/stereo/surround peak-RSS contract.
RUN /opt/diffrhythm2-venv/bin/pip install --no-cache-dir numpy==1.26.4 scipy==1.17.1 && \
    /opt/diffrhythm2-venv/bin/python -c 'import numpy, scipy; assert numpy.__version__ == "1.26.4"; assert scipy.__version__ == "1.17.1"'
COPY services/diffrhythm2-worker /app
RUN cd /app && /opt/diffrhythm2-venv/bin/python codec_threshold_corpus.py
RUN useradd --system diffrhythm2 && mkdir -p /var/lib/diffrhythm2/{models,artifacts} && chown -R diffrhythm2:diffrhythm2 /app /var/lib/diffrhythm2
USER diffrhythm2
WORKDIR /app
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
CMD ["/opt/diffrhythm2-venv/bin/python","-m","uvicorn","app:app","--host","0.0.0.0","--port","8016"]