/* REVEX Render Agent
 * One workspace: real Rendair surface + WALLT side/bottom chat.
 * Native Revit WebView2 executes the render plan; browser mode remains API-ready.
 */
(function (root) {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const history = [];
  let initialized = false;
  let statusLast = '';

  const nativeAutomation = () => Boolean(root.chrome?.webview?.postMessage);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function addMessage(role, text, meta = '') {
    const host = $('#render-agent-messages');
    if (!host || !String(text || '').trim()) return;
    const row = document.createElement('div');
    row.className = `render-agent-message ${role}`;
    row.innerHTML = `<div class="render-agent-message-body">${escapeHtml(text).replace(/\n/g, '<br>')}</div>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}`;
    host.appendChild(row);
    host.scrollTop = host.scrollHeight;
    if (role === 'user' || role === 'assistant') {
      history.push({ role, content: String(text) });
      if (history.length > 24) history.splice(0, history.length - 24);
    }
    return row;
  }

  function setThinking(on) {
    const old = $('#render-agent-thinking');
    if (old) old.remove();
    if (!on) return;
    const host = $('#render-agent-messages');
    if (!host) return;
    const row = document.createElement('div');
    row.id = 'render-agent-thinking';
    row.className = 'render-agent-message assistant thinking';
    row.innerHTML = '<div class="render-agent-message-body">WALLT is reading the Revit + project context…</div>';
    host.appendChild(row);
    host.scrollTop = host.scrollHeight;
  }

  function selectedContext() {
    const bim = $('#bim-inspector');
    const design = $('#design-inspector');
    const visibleBim = $('#view-bim') && !$('#view-bim').hidden;
    const visibleDesign = $('#view-design') && !$('#view-design').hidden;
    const readInspector = (node) => {
      if (!node) return null;
      return {
        eyebrow: node.querySelector('.eyebrow')?.textContent?.trim() || '',
        title: node.querySelector('h2')?.textContent?.trim() || '',
        text: node.innerText?.trim().slice(0, 3500) || ''
      };
    };
    if (visibleBim) return { kind: 'bim', ...readInspector(bim) };
    if (visibleDesign) return { kind: 'design', ...readInspector(design) };
    const renderContext = $('#render-context')?.textContent?.trim() || '';
    return { kind: 'view', title: renderContext };
  }

  function projectContext() {
    const select = $('#project-select');
    return {
      id: select?.value || '',
      name: select?.selectedOptions?.[0]?.textContent?.trim() || '',
      sync: $('#sync-label')?.textContent?.trim() || '',
      renderContext: $('#render-context')?.textContent?.trim() || '',
      designChapter: $('#render-chapter')?.selectedOptions?.[0]?.textContent?.trim() || ''
    };
  }

  function fullContext() {
    return {
      project: projectContext(),
      selection: selectedContext(),
      capabilities: {
        nativeAutomation: nativeAutomation(),
        revitCapture: nativeAutomation(),
        rendairEmbedded: true,
        rendairPartnerApi: Boolean(root.REVEX_RENDAIR_API_AVAILABLE),
        browserCrossOriginControl: false
      }
    };
  }

  function updateCapabilityChip() {
    const chip = $('#render-agent-capability');
    if (!chip) return;
    if (nativeAutomation()) {
      chip.textContent = 'Revit → Rendair automation';
      chip.dataset.tone = 'good';
    } else if (root.REVEX_RENDAIR_API_AVAILABLE) {
      chip.textContent = 'Rendair API automation';
      chip.dataset.tone = 'good';
    } else {
      chip.textContent = 'Companion · assisted Rendair';
      chip.dataset.tone = 'quiet';
    }
  }

  function ensureRendair() {
    const frame = $('#render-frame');
    if (!frame) return;
    const target = 'https://rendair.ai/tools/3d-model-to-render';
    if (!frame.src || frame.src === 'about:blank') frame.src = target;
    const empty = $('#render-frame-empty');
    if (empty) empty.textContent = 'Loading the Rendair workspace…';
  }

  function applyPlan(plan) {
    const r = plan?.rendair || {};
    if (r.prompt) $('#render-prompt').value = r.prompt;
    const set = (id, value) => {
      const node = $(id);
      if (!node || !value) return;
      const match = [...node.options].find((o) => o.value === value || o.textContent.trim() === value);
      if (match) node.value = match.value;
    };
    set('#render-environment', r.environment);
    set('#render-staging', r.staging);
    set('#render-people', r.people);
  }

  function executePlan(plan) {
    const action = plan?.rendair?.action || 'none';
    if (action !== 'prepare' && action !== 'refine') return;
    applyPlan(plan);
    ensureRendair();
    const form = $('#render-form');
    if (!form) return;
    // Existing REVEX render pipeline creates the render job and sends the capture request.
    // The Revit host now performs capture → attach → prompt → submit automatically.
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    if (!nativeAutomation() && !root.REVEX_RENDAIR_API_AVAILABLE) {
      addMessage('tool', 'Rendair is open with the project prompt prepared. Browser security prevents direct control of a cross-origin Rendair page; native REVEX performs this step automatically, and the Companion adapter is ready for Rendair partner API credentials.', 'execution boundary');
    }
  }

  async function sendAgent(event) {
    event?.preventDefault?.();
    const input = $('#render-agent-input');
    const send = $('#render-agent-send');
    const message = String(input?.value || '').trim();
    if (!message) return;
    input.value = '';
    input.style.height = '';
    addMessage('user', message);
    setThinking(true);
    if (send) send.disabled = true;
    try {
      if (!root.walltAgent?.planRender) throw new Error('WALLT is still initializing.');
      const plan = await root.walltAgent.planRender({ message, context: fullContext(), history });
      setThinking(false);
      addMessage('assistant', plan?.assistant || 'I prepared the render workflow.');
      executePlan(plan);
    } catch (error) {
      setThinking(false);
      addMessage('tool error', error?.message || 'WALLT could not prepare this render.', 'agent error');
    } finally {
      if (send) send.disabled = false;
      input?.focus?.();
    }
  }

  function watchStatus() {
    const status = $('#render-status');
    if (!status) return;
    const publish = () => {
      const text = status.textContent?.trim() || '';
      if (!text || text === statusLast) return;
      statusLast = text;
      if (/capture|attach|prompt|render|ready|failed|error|workspace/i.test(text)) {
        addMessage('tool', text, nativeAutomation() ? 'REVEX bridge' : 'REVEX');
      }
    };
    new MutationObserver(publish).observe(status, { childList: true, subtree: true, characterData: true });
  }

  function toggleMobilePanel() {
    const panel = $('#render-agent-panel');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    $('#render-agent-collapse')?.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
  }

  function openAgentWorkspace() {
    ensureRendair();
    updateCapabilityChip();
    const host = $('#render-agent-messages');
    if (host && !host.dataset.welcome) {
      host.dataset.welcome = '1';
      addMessage('assistant', nativeAutomation()
        ? 'Tell me what you want. I can use the active Revit view and project context, prepare the Rendair instruction, attach the capture and start the render.'
        : 'Tell me what you want to render. I will build the Rendair instruction from the REVEX project context and keep the Rendair workspace beside this chat.');
    }
  }

  function init() {
    if (initialized) return;
    const layout = $('.render-layout');
    const controls = $('.render-controls');
    const workspace = $('.render-workspace');
    if (!layout || !controls || !workspace) return setTimeout(init, 120);
    initialized = true;
    $('#render-dialog')?.classList.add('agentized');
    layout.classList.add('agentized');
    controls.classList.add('render-controls-hidden');
    controls.setAttribute('aria-hidden', 'true');

    const panel = document.createElement('aside');
    panel.id = 'render-agent-panel';
    panel.className = 'render-agent-panel';
    panel.innerHTML = `
      <header class="render-agent-head">
        <div><strong>WALLT</strong><span>REVEX render agent</span></div>
        <div class="render-agent-head-actions"><span id="render-agent-capability" class="render-agent-chip" data-tone="quiet"></span><button id="render-agent-collapse" type="button" aria-label="Expand or collapse render chat" aria-expanded="true">⌄</button></div>
      </header>
      <div id="render-agent-messages" class="render-agent-messages"></div>
      <div id="render-agent-status-slot" class="render-agent-status-slot"></div>
      <form id="render-agent-form" class="render-agent-form">
        <textarea id="render-agent-input" rows="2" placeholder="Describe the result. WALLT will operate the Revit → Rendair workflow…"></textarea>
        <button id="render-agent-send" type="submit" aria-label="Send to WALLT">↑</button>
      </form>
      <div id="render-agent-tools" class="render-agent-tools"></div>`;
    layout.appendChild(panel);

    const status = $('#render-status');
    if (status) $('#render-agent-status-slot').appendChild(status);
    const chapterLabel = $('#render-chapter')?.closest('label');
    if (chapterLabel) {
      chapterLabel.classList.add('render-agent-chapter');
      $('#render-agent-tools').appendChild(chapterLabel);
    }
    const resultUpload = $('#render-result-upload')?.closest('label');
    if (resultUpload) {
      resultUpload.classList.add('render-agent-result');
      $('#render-agent-tools').appendChild(resultUpload);
    }

    $('#render-agent-form').addEventListener('submit', sendAgent);
    $('#render-agent-collapse').addEventListener('click', toggleMobilePanel);
    $('#render-agent-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendAgent(event); }
    });
    $('#render-agent-input').addEventListener('input', (event) => {
      const t = event.currentTarget;
      t.style.height = 'auto';
      t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
    });
    $('#render-button')?.addEventListener('click', () => setTimeout(openAgentWorkspace, 0));
    watchStatus();
    updateCapabilityChip();

    const renderDialog = $('#render-dialog');
    if (renderDialog) {
      new MutationObserver(() => { if (!renderDialog.hidden) openAgentWorkspace(); }).observe(renderDialog, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
