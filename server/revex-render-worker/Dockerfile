FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/tmp/revex-hf-cache \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_XET_HIGH_PERFORMANCE=1 \
    HF_ENABLE_PARALLEL_LOADING=YES \
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
# Cloud Build uses the classic Dockerfile parser, so keep build-time manifest QA in a
# single shell instruction rather than Dockerfile heredoc syntax.
RUN python -m py_compile app.py \
 && python -c "import json; m=json.load(open('model-manifest.json', encoding='utf-8')); assert m['model']=='Qwen/Qwen-Image-Edit-2511'; assert m['revision']=='6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'; assert m['authentication']=='none-public-repository'; assert m['integrity']['allowMovingMain'] is False; assert m['integrity']['allowHuggingFaceTokenRequirement'] is False"

# The upstream weights are intentionally not copied into GitHub or the image.
# Default runtime resolves the exact immutable public revision tokenlessly.
# REVEX_MODEL_PATH is an optional future private immutable cache mount; it is
# never required for normal use and never changes the approved model identity.
CMD ["gunicorn","--bind","0.0.0.0:8080","--workers","1","--threads","4","--timeout","3600","app:APP"]
