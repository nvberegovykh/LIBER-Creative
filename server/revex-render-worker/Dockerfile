FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/tmp/revex-hf-cache \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_XET_HIGH_PERFORMANCE=1 \
    HF_ENABLE_PARALLEL_LOADING=YES \
    HF_HUB_ETAG_TIMEOUT=120 \
    HF_HUB_DOWNLOAD_TIMEOUT=900 \
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
COPY server/revex-render-worker/render_r115.py ./render_r115.py
COPY server/revex-render-worker/render_r119.py ./render_r119.py
COPY server/revex-render-worker/model-manifest.json ./model-manifest.json
RUN python -m py_compile app.py render_r115.py render_r119.py \
 && python -c "import json; m=json.load(open('model-manifest.json', encoding='utf-8')); assert m['model']=='Qwen/Qwen-Image-Edit-2511'; assert m['revision']=='6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'; assert m['authentication']=='none-public-repository'; assert m['integrity']['allowMovingMain'] is False; assert m['integrity']['allowHuggingFaceTokenRequirement'] is False"

# r119 resolves the exact public model/revision into a persistent mounted local_dir.
# The 57.7 GB model is not copied into GitHub or baked into the image.
CMD ["gunicorn","--bind","0.0.0.0:8080","--workers","1","--threads","4","--timeout","3600","render_r119:APP"]
