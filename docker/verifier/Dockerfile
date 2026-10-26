# IntentOS verification container: runs the trusted pytest commands against a read-only snapshot.
# Nothing TypeScript runs inside; the orchestrator stays on the host and only mounts the snapshot and a results dir.
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
FROM ${PYTHON_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
# Keep in sync with the host venv (`.intentos/venv/bin/python -m pytest --version`).
RUN pip install --no-cache-dir pytest==9.1.1
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 LANG=C.UTF-8
RUN useradd -m -u 1000 verifier
USER verifier
WORKDIR /work/snapshot
