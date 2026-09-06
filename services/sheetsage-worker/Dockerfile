# Dedicated SheetSage image. Do not merge this environment with music-ai-worker.
FROM python:3.11.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SHEETSAGE_ASSET_ROOT=/var/lib/sheetsage/assets \
    SHEETSAGE_CACHE_DIR=/var/lib/sheetsage/assets \
    XDG_CACHE_HOME=/var/lib/sheetsage/assets \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 NO_PROXY="*"
WORKDIR /app
COPY services/sheetsage-worker/requirements.txt /tmp/requirements.txt
# uv, rather than a host pip invocation, is used only inside this isolated image.
COPY --from=ghcr.io/astral-sh/uv:0.6.1 /uv /uvx /bin/
RUN uv pip install --system -r /tmp/requirements.txt
COPY services/sheetsage-worker/model_manifest.json services/sheetsage-worker/bootstrap_assets.py /app/
COPY services/sheetsage-worker/app.py services/sheetsage-worker/inference.py /app/
RUN useradd --system --home /app sheetsage \
    && mkdir -p /var/lib/sheetsage/assets /var/lib/sheetsage/smoke \
    && chown -R sheetsage:sheetsage /app /var/lib/sheetsage
USER sheetsage
EXPOSE 8012
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8012"]