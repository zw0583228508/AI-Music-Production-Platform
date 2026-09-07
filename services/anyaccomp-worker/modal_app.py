"""Dedicated AnyAccomp provisioning, smoke and bearer-only endpoint."""
from __future__ import annotations

import asyncio
import http.client
import os
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import modal

APP_NAME = "anyaccomp-worker"
ENDPOINT_LABEL = "anyaccomp-rename-drill"
ALLOWED_SOURCE_ORIGINS = "https://storage.googleapis.com"
MODEL_VOLUME_NAME = "anyaccomp-models-private-v1"
ARTIFACT_VOLUME_NAME = "anyaccomp-artifacts-private-v1"
MODEL_MOUNT = "/var/lib/anyaccomp/models"
ARTIFACT_MOUNT = "/var/lib/anyaccomp/artifacts"
RUNTIME_SECRET_NAME = "anyaccomp-runtime-v1"
PROMOTION_SECRET_NAME = "anyaccomp-promotion-identity-v1"
WORKER_ROOT = Path(__file__).resolve().parent
PINNED_PYTHON = "/opt/anyaccomp-venv/bin/python"
PINNED_SERVER_HOST = "127.0.0.1"
PINNED_SERVER_PORT = 8000
MAX_PROXY_REQUEST_BYTES = 20 * 1024 * 1024
MAX_PROXY_RESPONSE_BYTES = 256 * 1024 * 1024
HOP_BY_HOP_HEADERS = {
    b"connection",
    b"keep-alive",
    b"proxy-authenticate",
    b"proxy-authorization",
    b"te",
    b"trailer",
    b"transfer-encoding",
    b"upgrade",
}


def _canonical_origin(value: str) -> str:
    parsed = urlsplit(value.strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("AnyAccomp public origin is not a valid HTTPS origin")
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )


def _start_pinned_server(environment: dict[str, str]) -> subprocess.Popen:
    public_origin = _canonical_origin(
        environment.get("ANYACCOMP_PUBLIC_ORIGIN", "")
    )
    promoted_origin = _canonical_origin(
        environment.get("MUSIC_GPU_PROMOTION_ENDPOINT_ORIGIN", "")
    )
    if public_origin != promoted_origin:
        raise RuntimeError(
            "AnyAccomp public origin differs from promoted endpoint origin"
        )
    process = subprocess.Popen(
        [
            PINNED_PYTHON,
            "-m",
            "uvicorn",
            "app:app",
            "--host",
            PINNED_SERVER_HOST,
            "--port",
            str(PINNED_SERVER_PORT),
        ],
        cwd="/app",
        env=environment,
    )
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                "AnyAccomp pinned Python web workload exited during startup"
            )
        try:
            with socket.create_connection(
                (PINNED_SERVER_HOST, PINNED_SERVER_PORT),
                timeout=0.25,
            ):
                return process
        except OSError:
            time.sleep(0.25)
    process.terminate()
    process.wait(timeout=30)
    raise RuntimeError("AnyAccomp pinned Python web workload did not start")


def _proxy_request(
    method: str,
    path: str,
    headers: list[tuple[bytes, bytes]],
    body: bytes,
) -> tuple[int, list[tuple[bytes, bytes]], bytes]:
    connection = http.client.HTTPConnection(
        PINNED_SERVER_HOST,
        PINNED_SERVER_PORT,
        timeout=1800,
    )
    try:
        connection.putrequest(
            method,
            path,
            skip_host=True,
            skip_accept_encoding=True,
        )
        connection.putheader("Host", f"{PINNED_SERVER_HOST}:{PINNED_SERVER_PORT}")
        for name, value in headers:
            lowered = name.lower()
            if (
                lowered not in HOP_BY_HOP_HEADERS
                and lowered not in {b"host", b"content-length"}
            ):
                connection.putheader(
                    name.decode("latin-1"),
                    value.decode("latin-1"),
                )
        connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        payload = response.read(MAX_PROXY_RESPONSE_BYTES + 1)
        if len(payload) > MAX_PROXY_RESPONSE_BYTES:
            raise RuntimeError("AnyAccomp proxied response exceeds size limit")
        response_headers = [
            (name.encode("latin-1"), value.encode("latin-1"))
            for name, value in response.getheaders()
            if name.lower().encode("latin-1") not in HOP_BY_HOP_HEADERS
        ]
        return response.status, response_headers, payload
    finally:
        connection.close()


def _asgi_proxy(process: subprocess.Popen):
    async def proxy(scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=30)
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > MAX_PROXY_REQUEST_BYTES:
                await send(
                    {
                        "type": "http.response.start",
                        "status": 413,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send(
                    {
                        "type": "http.response.body",
                        "body": b'{"detail":"request body too large"}',
                    }
                )
                return
            if not message.get("more_body", False):
                break
        raw_path = scope.get("raw_path", scope["path"].encode("utf-8"))
        path = raw_path.decode("ascii")
        query = scope.get("query_string", b"")
        if query:
            path += "?" + query.decode("ascii")
        try:
            status, headers, payload = await asyncio.to_thread(
                _proxy_request,
                scope["method"],
                path,
                scope.get("headers", []),
                bytes(body),
            )
        except Exception:
            status = 502
            headers = [(b"content-type", b"application/json")]
            payload = b'{"detail":"pinned worker proxy failure"}'
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": headers,
            }
        )
        await send({"type": "http.response.body", "body": payload})

    return proxy

app = modal.App(APP_NAME)
SOURCE_IMAGE_DIGEST = "sha256:ebee9112737753c4f6aaa9001e6ef8397d097c6b365253cc639a3f2cc8ff62ff"
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile",
    context_dir=WORKER_ROOT.parent.parent,
    build_args={"SOURCE_IMAGE_DIGEST": SOURCE_IMAGE_DIGEST},
)
provision_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install("huggingface-hub==0.34.4")
    .add_local_dir(WORKER_ROOT, remote_path="/app")
)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
artifacts = modal.Volume.from_name(ARTIFACT_VOLUME_NAME, create_if_missing=False)
secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
promotion_secret = modal.Secret.from_name(PROMOTION_SECRET_NAME)


@app.function(
    image=provision_image,
    volumes={MODEL_MOUNT: models},
    timeout=7200,
)
def provision_assets() -> dict:
    os.environ["ANYACCOMP_ASSET_ROOT"] = MODEL_MOUNT
    sys.path.insert(0, "/app")
    from bootstrap_assets import main

    result = main()
    models.commit()
    return result


@app.function(
    image=image,
    gpu="L40S",
    volumes={MODEL_MOUNT: models},
    timeout=1800,
)
def smoke_fixture(fixture_path: str) -> dict:
    expected_fixture = (
        f"{MODEL_MOUNT}/fixtures/authorized-procedural-vocal.wav"
    )
    if fixture_path != expected_fixture:
        raise RuntimeError("AnyAccomp smoke fixture path is not authorized")
    environment = {**os.environ, "ANYACCOMP_ASSET_ROOT": MODEL_MOUNT}
    subprocess.run(
        [
            PINNED_PYTHON,
            "-c",
            (
                "from pathlib import Path; "
                "from smoke import main; "
                f"main(Path({fixture_path!r}))"
            ),
        ],
        cwd="/app",
        env=environment,
        check=True,
    )
    result = json.loads(
        Path(f"{MODEL_MOUNT}/smoke-proof.json").read_text()
    )
    models.commit()
    return result


@app.function(
    image=image,
    gpu="L40S",
    volumes={MODEL_MOUNT: models},
    timeout=900,
)
def runtime_identity() -> dict:
    script = """
import accelerate, json, sys, torch, torchaudio, torchvision, transformers
print(json.dumps({
    "pythonVersion": ".".join(map(str, sys.version_info[:3])),
    "torchVersion": torch.__version__,
    "torchaudioVersion": torchaudio.__version__,
    "torchvisionVersion": torchvision.__version__,
    "transformersVersion": transformers.__version__,
    "accelerateVersion": accelerate.__version__,
    "cudaAvailable": torch.cuda.is_available(),
    "cudaVersion": torch.version.cuda,
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
}, sort_keys=True))
"""
    return json.loads(
        subprocess.check_output(
            [PINNED_PYTHON, "-c", script],
            cwd="/app",
            text=True,
        )
    )


@app.cls(
    image=image,
    gpu="L40S",
    secrets=[secret, promotion_secret],
    volumes={MODEL_MOUNT: models, ARTIFACT_MOUNT: artifacts},
    timeout=1800,
    max_containers=1,
)
class AnyAccompWorker:
    @modal.asgi_app(label=ENDPOINT_LABEL)
    def endpoint(self):
        environment = {
            **os.environ,
            "ANYACCOMP_ASSET_ROOT": MODEL_MOUNT,
            "ANYACCOMP_ARTIFACT_ROOT": ARTIFACT_MOUNT,
            "ANYACCOMP_ALLOWED_SOURCE_ORIGINS": ALLOWED_SOURCE_ORIGINS,
        }
        return _asgi_proxy(_start_pinned_server(environment))