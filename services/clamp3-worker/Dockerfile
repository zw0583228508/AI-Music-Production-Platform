FROM python:3.11.11-slim-bookworm

ARG CLAMP3_SOURCE_REVISION=9016d2b0c8d12d1aa79c2e0ab201e6822bdc83a8
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /worker
COPY requirements.lock .
RUN pip install --no-cache-dir --requirement requirements.lock
# This dangling link is resolved only against the pre-provisioned, offline
# model volume at runtime; it lets the unprivileged worker keep the pinned
# source tree read-only.
RUN git clone https://github.com/sanderwood/clamp3.git /opt/clamp3 \
    && git -C /opt/clamp3 checkout --detach "${CLAMP3_SOURCE_REVISION}" \
    && test "$(git -C /opt/clamp3 rev-parse HEAD)" = "${CLAMP3_SOURCE_REVISION}" \
    && rm -rf /opt/clamp3/.git \
    && ln -s /models/clamp3/hf/models--sander-wood--clamp3/snapshots/355625cc1c6f73726bbcd0eb9276ac7152d56426/weights_clamp3_saas_h_size_768_t_model_FacebookAI_xlm-roberta-base_t_length_128_a_size_768_a_layers_12_a_length_128_s_size_768_s_layers_12_p_size_64_p_length_512.pth /opt/clamp3/code/weights_clamp3_saas_h_size_768_t_model_FacebookAI_xlm-roberta-base_t_length_128_a_size_768_a_layers_12_a_length_128_s_size_768_s_layers_12_p_size_64_p_length_512.pth

COPY . /worker
RUN groupadd --system --gid 10001 clamp3 \
    && useradd --system --uid 10001 --gid clamp3 --home-dir /nonexistent --shell /usr/sbin/nologin clamp3 \
    && install -d --owner=clamp3 --group=clamp3 --mode=0700 \
        /var/tmp/clamp3 /var/tmp/clamp3/audio-logs /var/tmp/clamp3/midi-logs \
    && ln -s /var/tmp/clamp3/audio-logs /opt/clamp3/preprocessing/audio/logs \
    && ln -s /var/tmp/clamp3/midi-logs /opt/clamp3/preprocessing/midi/logs \
    && chown -R root:root /worker /opt/clamp3 \
    && chmod -R a-w /worker /opt/clamp3 \
    && chmod 0755 /tmp /var/tmp
ENV CLAMP3_ASSET_ROOT=/models/clamp3 \
    CLAMP3_SOURCE_ROOT=/opt/clamp3 \
    CLAMP3_SCRATCH_ROOT=/var/tmp/clamp3 \
    HOME=/nonexistent \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    TMPDIR=/var/tmp/clamp3 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER clamp3:clamp3
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]