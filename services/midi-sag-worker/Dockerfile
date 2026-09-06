FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3.9 python3.9-venv git ffmpeg cmake portaudio19-dev libsndfile1 && rm -rf /var/lib/apt/lists/*
RUN python3.9 -m venv /opt/midi-sag-venv
COPY services/midi-sag-worker/requirements.lock /tmp/requirements.lock
RUN /opt/midi-sag-venv/bin/pip install --upgrade 'pip<24.1' && /opt/midi-sag-venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cu124 -r /tmp/requirements.lock
RUN git clone https://github.com/fundwotsai2001/MIDI-SAG.git /opt/midi-sag && git -C /opt/midi-sag checkout --detach b79839ed0cdd0b5e5f39d4cc4a80fcc90002d32f && git -C /opt/midi-sag submodule update --init --recursive && test "$(git -C /opt/midi-sag rev-parse HEAD)" = "b79839ed0cdd0b5e5f39d4cc4a80fcc90002d32f"
WORKDIR /app
COPY services/midi-sag-worker/ /app/
RUN useradd --system midsag && mkdir -p /var/lib/midi-sag/models && chown -R midsag:midsag /app /var/lib/midi-sag
USER midsag
EXPOSE 8019
CMD ["/opt/midi-sag-venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8019"]