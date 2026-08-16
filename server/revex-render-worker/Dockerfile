FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/tmp/revex-hf-cache \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TOKENIZERS_PARALLELISM=false \
    PORT=8080

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/revex-render
COPY server/revex-render-worker/requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip==25.2 \
 && python -m pip install -r requirements.txt

COPY server/revex-render-worker/app.py ./app.py
COPY server/revex-render-worker/model-manifest.json ./model-manifest.json
RUN python -m py_compile app.py \
 && python - <<'PY'
import json
m=json.load(open('model-manifest.json', encoding='utf-8'))
assert m['model']=='Qwen/Qwen-Image-Edit-2511'
assert m['revision']=='6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'
assert m['authentication']=='none-public-repository'
PY

# The 57.7 GB upstream is intentionally NOT baked into Artifact Registry.
# The exact public revision is fetched on first worker use and cached only on
# the private Cloud Run instance. This keeps model storage free and immutable.
CMD ["gunicorn","--bind","0.0.0.0:8080","--workers","1","--threads","4","--timeout","3600","app:APP"]
