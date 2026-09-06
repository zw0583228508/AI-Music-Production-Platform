FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3.10 python3-pip git ffmpeg libsndfile1 ca-certificates \
    && ln -sf /usr/bin/python3.10 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.10 /usr/local/bin/python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python3.10 -m pip install --no-cache-dir -r requirements.txt
COPY . /app
RUN useradd --system --create-home songformer && mkdir -p /var/lib/songformer/assets && chown -R songformer:songformer /app /var/lib/songformer
USER songformer
CMD ["python3.10", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010"]