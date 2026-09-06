# Dedicated SheetSage image. Do not merge this environment with music-ai-worker.
FROM python:3.11.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    XDG_CACHE_HOME=/tmp/sheetsage-build-cache \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 NO_PROXY="*"
WORKDIR /app
COPY services/sheetsage-worker/requirements.txt /tmp/requirements.txt
# uv, rather than a host pip invocation, is used only inside this isolated image.
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /uvx /bin/
RUN uv pip install --system -r /tmp/requirements.txt
COPY services/sheetsage-worker/model_manifest.json services/sheetsage-worker/bootstrap_assets.py services/sheetsage-worker/modal_config.py /app/
COPY services/sheetsage-worker/app.py services/sheetsage-worker/inference.py services/sheetsage-worker/smoke.py /app/
RUN useradd --system --home /app sheetsage \
    && mkdir -p /var/lib/sheetsage/assets /var/lib/sheetsage/smoke \
    && chown -R sheetsage:sheetsage /app /var/lib/sheetsage
USER sheetsage
EXPOSE 8012
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8012"]