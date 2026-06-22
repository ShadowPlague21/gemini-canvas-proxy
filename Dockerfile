# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────────────
# Gemini Canvas Proxy — native host container
# ──────────────────────────────────────────────────────────────────────────────
# Single-purpose image: runs the Python native host that speaks the Chrome
# native messaging protocol on stdio AND serves the OpenAI-compatible HTTP API
# on :8765. The browser + extension + Canvas tab still live on the host (or in
# a separate browser container); this image only needs to expose the HTTP API.
#
# The Python host uses stdlib only — no pip install required. The slim variant
# keeps the image under ~50 MB.
# ──────────────────────────────────────────────────────────────────────────────

FROM python:3.12-slim AS runtime

# OCI labels (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
LABEL org.opencontainers.image.title="gemini-canvas-proxy"
LABEL org.opencontainers.image.description="Native messaging host + OpenAI-compatible HTTP API backed by Gemini Canvas"
LABEL org.opencontainers.image.source="https://github.com/pranrichh/gemini-canvas-proxy"
LABEL org.opencontainers.image.licenses="MIT"

# Run as a non-root user — the native host reads/writes only its own state,
# no privileged ops needed.
RUN groupadd --system --gid 1000 proxy \
    && useradd  --system --uid 1000 --gid proxy --home-dir /app --shell /usr/sbin/nologin proxy \
    && mkdir -p /app/native_host \
    && chown -R proxy:proxy /app

WORKDIR /app

# Copy just the native host directory first (the only thing this image runs).
COPY --chown=proxy:proxy native_host/ /app/native_host/

USER proxy

EXPOSE 8765

# Health check pings the same /health endpoint the README documents.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python3 -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3).status == 200 else 1)"

# Default env: bind to all interfaces INSIDE the container. Compose overrides
# this to 127.0.0.1 for host-loopback safety (see docker-compose.yml). On VPS
# setups where Tailscale reaches the proxy via its tailnet IP, flip to
# 0.0.0.0 with the `docker-compose.vps.yml` override.
ENV PROXY_BIND=0.0.0.0 \
    PROXY_PORT=8765 \
    PYTHONUNBUFFERED=1

# The Chrome extension launches the host via stdio (native messaging). When
# launched that way, Python ignores argv[0] subcommands and goes straight to
# `main()`; the HTTP server starts in a background thread and the foreground
# thread blocks on stdin. Docker only ever runs the HTTP path, but this entry
# works for both.
ENTRYPOINT ["python3", "/app/native_host/gemini_proxy.py"]
CMD []