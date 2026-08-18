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
# The Energy folder carries canonical current modules plus preserved version-shadow files.
COPY src/Liber.Revex.Revit/Engineering/Energy /opt/revex/energy
ENV REVEX_APPROVED_ENVELOPE_REFERENCE=/opt/revex/energy/References/79_WINTHROP_APPROVED_PROPOSED.osm
COPY src/Liber.Revex.Revit/Engineering/Gbxml /opt/revex/Gbxml
COPY server/revex-energy-worker/app.py /opt/revex/server/app.py
COPY server/revex-energy-worker/app_entry.py /opt/revex/server/app_entry.py
COPY server/revex-energy-worker/durable_execution.py /opt/revex/server/durable_execution.py
COPY server/revex-energy-worker/revex_energy_pipeline_current.py /opt/revex/server/revex_energy_pipeline_current.py
# Versioned guards remain packaged as shadow mechanics for compatibility/regression only.
COPY server/revex-energy-worker/revex_energy_pipeline_guard.py /opt/revex/server/revex_energy_pipeline_guard.py
COPY server/revex-energy-worker/revex_energy_pipeline_guard_r116.py /opt/revex/server/revex_energy_pipeline_guard_r116.py
COPY server/revex-energy-worker/revex_energy_pipeline_guard_r118.py /opt/revex/server/revex_energy_pipeline_guard_r118.py
COPY server/revex-energy-worker/revex_reference_envelope_projection_r118.py /opt/revex/server/revex_reference_envelope_projection_r118.py
COPY server/revex-energy-worker/revex_energy_identity_normalizer.py /opt/revex/server/revex_energy_identity_normalizer.py
COPY server/revex-energy-worker/revex_identity_content_agent.py /opt/revex/server/revex_identity_content_agent.py
COPY server/revex-energy-worker/revex_cloud_project.py /opt/revex/server/revex_cloud_project.py
COPY server/revex-energy-worker/revex_user_identity_en1.py /opt/revex/server/revex_user_identity_en1.py
COPY server/revex-energy-worker/revex_en1_print_contract.py /opt/revex/server/revex_en1_print_contract.py
COPY server/revex-energy-worker/revex_energy_pipeline_r69.py /opt/revex/server/revex_energy_pipeline_r69.py
COPY server/revex-energy-worker/revex_comcheck_evidence.py /opt/revex/server/revex_comcheck_evidence.py
COPY server/revex-energy-worker/revex_comcheck_evidence_r116.py /opt/revex/server/revex_comcheck_evidence_r116.py
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
COPY server/revex-energy-worker/verify_final_comcheck_recovery_r116.py /opt/revex/server/verify_final_comcheck_recovery_r116.py
COPY server/revex-energy-worker/verify_reference_envelope_r118.py /opt/revex/server/verify_reference_envelope_r118.py
COPY server/revex-energy-worker/verify_energy_agent.py /opt/revex/server/verify_energy_agent.py
COPY server/firebase-functions/index.js /opt/revex/firebase-functions/index.js
COPY server/revex-energy-worker/run_revex_r49_release_acceptance.py /opt/revex/server/run_revex_r49_release_acceptance.py
COPY server/revex-energy-worker/verify_revex_r49_worker.py /opt/revex/server/verify_revex_r49_worker.py
COPY server/revex-energy-worker/requirements-server.txt /opt/revex/server/requirements-server.txt
# Historical deploy scripts are retained as shadow files; the current controller never calls them.
COPY server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1 /opt/revex/server/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1
COPY server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1 /opt/revex/server/DEPLOY_ENERGY_CURRENT.ps1

# Preserve GeometryCo 4.3.4 byte-for-byte as the core. Current source-evidence resolver
# calls back into that core and never enables allow_ambiguous or lowers the 75% floor.
RUN mv /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py \
       /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py \
 && cp /opt/revex/server/revex_geometryco_source_condition.py \
       /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py

RUN test -f /opt/revex/server/run_revex_r49_release_acceptance.py \
 && test -f /opt/revex/server/revex_energy_pipeline_current.py \
 && test -f /opt/revex/server/revex_en1_print_contract.py \
 && test -f /opt/revex/server/verify_energy_agent.py \
 && test -f /opt/revex/energy/revex_final_touchups.py \
 && test -f /opt/revex/energy/revex_energy_contracts.py \
 && test -f /opt/revex/energy/revex_pipeline_runner.py \
 && test -f /opt/revex/energy/revex_energy_agent.py \
 && test -f /opt/revex/energy/revex_energy_agent_evidence.py \
 && test -f /opt/revex/energy/revex_energy_agent_filing.py \
 && test -f /opt/revex/energy/revex_energy_agent_context.py \
 && test -f /opt/revex/energy/revex_energy_maintainer.py \
 && test -f /opt/revex/Gbxml/LIBER_gbXML_Preflight_and_Export.py \
 && test -f /opt/revex/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn \
 && test -f /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py \
 && test -f "$REVEX_APPROVED_ENVELOPE_REFERENCE" \
 && test -f /opt/revex/firebase-functions/index.js \
 && python3 -m py_compile \
      /opt/revex/server/app.py \
      /opt/revex/server/app_entry.py \
      /opt/revex/server/durable_execution.py \
      /opt/revex/server/revex_energy_pipeline_current.py \
      /opt/revex/server/revex_energy_pipeline_guard.py \
      /opt/revex/server/revex_energy_pipeline_guard_r116.py \
      /opt/revex/server/revex_energy_pipeline_guard_r118.py \
      /opt/revex/server/revex_reference_envelope_projection_r118.py \
      /opt/revex/server/revex_energy_identity_normalizer.py \
      /opt/revex/server/revex_identity_content_agent.py \
      /opt/revex/server/revex_cloud_project.py \
      /opt/revex/server/revex_user_identity_en1.py \
      /opt/revex/server/revex_en1_print_contract.py \
      /opt/revex/server/revex_energy_pipeline_r69.py \
      /opt/revex/server/revex_comcheck_evidence.py \
      /opt/revex/server/revex_comcheck_evidence_r116.py \
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
      /opt/revex/server/verify_final_comcheck_recovery_r116.py \
      /opt/revex/server/verify_reference_envelope_r118.py \
      /opt/revex/server/verify_energy_agent.py \
      /opt/revex/server/run_revex_r49_release_acceptance.py \
      /opt/revex/server/verify_revex_r49_worker.py \
      /opt/revex/energy/revex_final_touchups.py \
      /opt/revex/energy/revex_energy_contracts.py \
      /opt/revex/energy/revex_pipeline_runner.py \
      /opt/revex/energy/revex_energy_agent.py \
      /opt/revex/energy/revex_energy_agent_evidence.py \
      /opt/revex/energy/revex_energy_agent_filing.py \
      /opt/revex/energy/revex_energy_agent_context.py \
      /opt/revex/energy/revex_energy_maintainer.py \
      /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py \
      /opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py

RUN cd /opt/revex/server \
 && python3 -c "import os; from pathlib import Path; import revex_reference_envelope_projection_r118 as r; expected=Path(os.environ['REVEX_APPROVED_ENVELOPE_REFERENCE']); actual=r._reference_path(); assert actual==expected,(actual,expected); assert actual.is_file(),actual; print('REVEX_R118_PACKAGED_REFERENCE_PATH=PASSED', actual)"

RUN python3 -m pip install --no-cache-dir \
    -r /opt/revex/energy/requirements.txt \
    -r /opt/revex/energy/GeometryCo/requirements.txt \
    -r /opt/revex/server/requirements-server.txt

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
 && python3 /opt/revex/server/verify_geometryco_source_condition_r91.py \
 && python3 /opt/revex/server/verify_final_comcheck_recovery_r116.py \
 && cd /opt/revex/server && python3 verify_reference_envelope_r118.py \
 && python3 verify_energy_agent.py

# Historical verifier shadow markers only; current runtime is the ENV directly below.
# REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard.py
# REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard_r118.py
ENV REVEX_HEADLESS=1 \
    REVEX_CHROME_BINARY=/usr/bin/google-chrome \
    REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_current.py \
    REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py \
    REVEX_ENERGY_TIMEOUT_SECONDS=3500 \
    PORT=8080
CMD ["gunicorn","--bind","0.0.0.0:8080","--workers","1","--threads","4","--timeout","3600","app_entry:APP","--chdir","/opt/revex/server"]
