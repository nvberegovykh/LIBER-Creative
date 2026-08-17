FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    ca-certificates curl gnupg python3 python3-pip python3-tk ruby libgl1 libglib2.0-0 \
    libreoffice-core libreoffice-calc fonts-liberation fontconfig \
 && rm -rf /var/lib/apt/lists/*

# Official COMcheck legacy file upload is disabled; REVEX forms a clean project through COMcheck's own browser model.
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends google-chrome-stable \
 && google-chrome --version \
 && rm -rf /var/lib/apt/lists/*

# Controlled simulation runtime: REVEX does not use a workstation OpenStudio installation.
RUN curl -fL --retry 4 "https://github.com/NatLabRockies/OpenStudio/releases/download/v3.10.0/OpenStudio-3.10.0%2B86d7e215a1-Ubuntu-22.04-x86_64.deb" -o /tmp/openstudio.deb \
 && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y /tmp/openstudio.deb \
 && rm -f /tmp/openstudio.deb && rm -rf /var/lib/apt/lists/* \
 && OSCLI="$(find /usr /opt -type f -name openstudio -perm -111 2>/dev/null | head -1)" \
 && test -n "$OSCLI" && ln -sf "$OSCLI" /usr/local/bin/openstudio \
 && /usr/local/bin/openstudio openstudio_version \
 && /usr/local/bin/openstudio energyplus_version \
 && /usr/local/bin/openstudio ruby_version \
 && soffice --version

WORKDIR /opt/revex
COPY src/Liber.Revex.Revit/Engineering/Energy /opt/revex/energy
# Energy QA imports the exact authoritative gbXML exporter beside Energy via HERE.parent/Gbxml.
# Keep both the .py and .dyn in the worker image so the identity regression test runs in Cloud Build.
COPY src/Liber.Revex.Revit/Engineering/Gbxml /opt/revex/Gbxml
COPY server/revex-energy-worker/app.py /opt/revex/server/app.py
COPY server/revex-energy-worker/app_entry.py /opt/revex/server/app_entry.py
COPY server/revex-energy-worker/durable_execution.py /opt/revex/server/durable_execution.py
COPY server/revex-energy-worker/revex_energy_pipeline_guard.py /opt/revex/server/revex_energy_pipeline_guard.py
COPY server/revex-energy-worker/revex_energy_identity_normalizer.py /opt/revex/server/revex_energy_identity_normalizer.py
COPY server/revex-energy-worker/revex_identity_content_agent.py /opt/revex/server/revex_identity_content_agent.py
COPY server/revex-energy-worker/revex_cloud_project.py /opt/revex/server/revex_cloud_project.py
COPY server/revex-energy-worker/revex_user_identity_en1.py /opt/revex/server/revex_user_identity_en1.py
COPY server/revex-energy-worker/revex_energy_pipeline_r69.py /opt/revex/server/revex_energy_pipeline_r69.py
COPY server/revex-energy-worker/revex_comcheck_evidence.py /opt/revex/server/revex_comcheck_evidence.py
COPY server/revex-energy-worker/revex_structured_schedule_facts.py /opt/revex/server/revex_structured_schedule_facts.py
COPY server/revex-energy-worker/revex_structured_schedule_projection.py /opt/revex/server/revex_structured_schedule_projection.py
COPY server/revex-energy-worker/revex_geometryco_source_condition.py /opt/revex/server/revex_geometryco_source_condition.py
COPY server/revex-energy-worker/verify_failure_evidence_r55.py /opt/revex/server/verify_failure_evidence_r55.py
COPY server/revex-energy-worker/verify_identity_normalizer.py /opt/revex/server/verify_identity_normalizer.py
COPY server/revex-energy-worker/verify_identity_content_agent.py /opt/revex/server/verify_identity_content_agent.py
COPY server/revex-energy-worker/verify_user_identity_en1_r89.py /opt/revex/server/verify_user_identity_en1_r89.py
COPY server/revex-energy-worker/verify_vertex_project_binding_r98.py /opt/revex/server/verify_vertex_project_binding_r98.py
COPY server/revex-energy-worker/verify_comcheck_evidence_r100.py /opt/revex/server/verify_comcheck_evidence_r100.py
COPY server/revex-energy-worker/verify_structured_schedule_evidence_r101.py /opt/revex/server/verify_structured_schedule_evidence_r101.py
COPY server/revex-energy-worker/verify_geometryco_source_condition_r91.py /opt/revex/server/verify_geometryco_source_condition_r91.py
COPY server/revex-energy-worker/run_revex_r49_release_acceptance.py /opt/revex/server/run_revex_r49_release_acceptance.py
COPY server/revex-energy-worker/verify_revex_r49_worker.py /opt/revex/server/verify_revex_r49_worker.py
COPY server/revex-energy-worker/requirements-server.txt /opt/revex/server/requirements-server.txt
COPY server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1 /opt/revex/server/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1
COPY server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1 /opt/revex/server/DEPLOY_ENERGY_CURRENT.ps1

# Preserve GeometryCo 4.3.4 byte-for-byte as the core. The installed entrypoint
# is a source-evidence resolver that calls back into that core and never enables
# allow_ambiguous or lowers the 75% confidence floor.
RUN mv /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py \
       /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py \
 && cp /opt/revex/server/revex_geometryco_source_condition.py \
       /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py

RUN test -f /opt/revex/server/run_revex_r49_release_acceptance.py \
 && test -f /opt/revex/Gbxml/LIBER_gbXML_Preflight_and_Export.py \
 && test -f /opt/revex/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn \
 && test -f /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py \
 && python3 -m py_compile \
      /opt/revex/server/app.py \
      /opt/revex/server/app_entry.py \
      /opt/revex/server/durable_execution.py \
      /opt/revex/server/revex_energy_pipeline_guard.py \
      /opt/revex/server/revex_energy_identity_normalizer.py \
      /opt/revex/server/revex_identity_content_agent.py \
      /opt/revex/server/revex_cloud_project.py \
      /opt/revex/server/revex_user_identity_en1.py \
      /opt/revex/server/revex_energy_pipeline_r69.py \
      /opt/revex/server/revex_comcheck_evidence.py \
      /opt/revex/server/revex_structured_schedule_facts.py \
      /opt/revex/server/revex_structured_schedule_projection.py \
      /opt/revex/server/revex_geometryco_source_condition.py \
      /opt/revex/server/verify_failure_evidence_r55.py \
      /opt/revex/server/verify_identity_normalizer.py \
      /opt/revex/server/verify_identity_content_agent.py \
      /opt/revex/server/verify_user_identity_en1_r89.py \
      /opt/revex/server/verify_vertex_project_binding_r98.py \
      /opt/revex/server/verify_comcheck_evidence_r100.py \
      /opt/revex/server/verify_structured_schedule_evidence_r101.py \
      /opt/revex/server/verify_geometryco_source_condition_r91.py \
      /opt/revex/server/run_revex_r49_release_acceptance.py \
      /opt/revex/server/verify_revex_r49_worker.py \
      /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py \
      /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py
RUN python3 -m pip install --no-cache-dir \
    -r /opt/revex/energy/requirements.txt \
    -r /opt/revex/energy/GeometryCo/requirements.txt \
    -r /opt/revex/server/requirements-server.txt
# Execute the exact production import path under the explicit deployment binding.
# This catches missing imports/startup coupling before Cloud Run receives the image.
RUN cd /opt/revex/server \
 && REVEX_VERTEX_PROJECT=liber-apps-cca20 REVEX_VERTEX_LOCATION=global python3 -c "import os, app_entry; assert app_entry.APP is not None; assert os.environ['REVEX_VERTEX_PROJECT']=='liber-apps-cca20'; assert os.environ['REVEX_VERTEX_LOCATION']=='global'"
RUN python3 -c "from selenium import webdriver; o=webdriver.ChromeOptions(); o.binary_location='/usr/bin/google-chrome'; o.add_argument('--headless=new'); o.add_argument('--no-sandbox'); o.add_argument('--disable-dev-shm-usage'); d=webdriver.Chrome(options=o); d.get('data:text/plain,REVEX-COMCHECK-DRIVER-READY'); d.quit()"
RUN python3 /opt/revex/energy/verify_revex_r49_energy.py \
 && python3 /opt/revex/server/verify_revex_r49_worker.py \
 && python3 /opt/revex/server/verify_failure_evidence_r55.py \
 && python3 /opt/revex/server/verify_identity_normalizer.py \
 && python3 /opt/revex/server/verify_identity_content_agent.py \
 && python3 /opt/revex/server/verify_user_identity_en1_r89.py \
 && python3 /opt/revex/server/verify_vertex_project_binding_r98.py \
 && python3 /opt/revex/server/verify_comcheck_evidence_r100.py \
 && python3 /opt/revex/server/verify_structured_schedule_evidence_r101.py \
 && python3 /opt/revex/server/verify_geometryco_source_condition_r91.py

ENV REVEX_HEADLESS=1 \
    REVEX_CHROME_BINARY=/usr/bin/google-chrome \
    REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard.py \
    REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py \
    REVEX_ENERGY_TIMEOUT_SECONDS=3500 \
    PORT=8080
# Bind Google Cloud/Vertex routing before app.py can ever see the REVEX application
# project id as a fallback. Canonical deployment supplies REVEX_VERTEX_PROJECT;
# ADC is a fail-closed defense for future deployment paths.
CMD ["gunicorn","--bind","0.0.0.0:8080","--workers","1","--threads","4","--timeout","3600","app_entry:APP","--chdir","/opt/revex/server"]
