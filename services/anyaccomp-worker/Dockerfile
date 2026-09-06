# Isolated Python 3.9 AnyAccomp image. No provider environment is shared.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libsndfile1 python3.9 python3.9-venv && rm -rf /var/lib/apt/lists/*
RUN python3.9 -m venv /opt/anyaccomp-venv
COPY services/anyaccomp-worker/requirements.txt /tmp/requirements.txt
RUN /opt/anyaccomp-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt && /opt/anyaccomp-venv/bin/pip install --no-cache-dir torch==2.3.1 torchaudio==2.3.1 torchvision==0.18.1 transformers==4.47.1 accelerate==1.6.0
WORKDIR /app
COPY services/anyaccomp-worker/ /app/
RUN useradd --system anyaccomp && mkdir -p /var/lib/anyaccomp/models /var/lib/anyaccomp/artifacts && chown -R anyaccomp:anyaccomp /app /var/lib/anyaccomp
USER anyaccomp
CMD ["/opt/anyaccomp-venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]