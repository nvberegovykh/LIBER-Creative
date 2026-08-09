(function (root) {
  'use strict';

  const Store = root.RevexStore;
  if (!Store) return;

  const BUILD = '20260809r7';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const iso = () => new Date().toISOString();

  const originalInit = Store.init.bind(Store);
  const originalCreateProject = Store.createProject.bind(Store);

  function firestoreValue(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    }
    if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
    if (typeof value === 'object') return { mapValue: { fields: firestoreFields(value) } };
    return { stringValue: String(value) };
  }

  function firestoreFields(data) {
    const fields = {};
    Object.entries(data || {}).forEach(([key, value]) => { fields[key] = firestoreValue(value); });
    return fields;
  }

  async function firestoreRest(path, data, updateMask = []) {
    const fs = root.firebaseService && root.firebaseService.isInitialized ? root.firebaseService : Store.fs;
    const user = fs?.auth?.currentUser || Store.user;
    const firebaseProjectId = fs?.app?.options?.projectId || 'liber-apps-cca20';
    if (!user?.getIdToken) throw new Error('Sign in before creating a REVEX project.');
    const token = await user.getIdToken();
    const docPath = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    let url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/${docPath}`;
    if (updateMask.length) {
      url += '?' + updateMask.map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join('&');
    }
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields: firestoreFields(data) })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = json?.error?.message || json?.message || `Firestore REST ${response.status}`;
      throw new Error(message);
    }
    return json;
  }

  async function firestoreDelete(path) {
    try {
      const fs = root.firebaseService && root.firebaseService.isInitialized ? root.firebaseService : Store.fs;
      const user = fs?.auth?.currentUser || Store.user;
      const firebaseProjectId = fs?.app?.options?.projectId || 'liber-apps-cca20';
      if (!user?.getIdToken) return;
      const token = await user.getIdToken();
      const docPath = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
      const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/${docPath}`;
      await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    } catch (_) {}
  }

  Store.init = async function initRevexRuntime() {
    const local = root.firebaseService || null;
    if (local) {
      for (let i = 0; i < 80; i += 1) {
        const api = local.firebase || root.firebase || null;
        if (local.isInitialized && local.db && api?.collection && api?.getDocs) {
          this.fs = local;
          this.api = api;
          this.db = local.db;
          this.user = local.auth?.currentUser || null;
          if (!this.user && api.onAuthStateChanged && local.auth) {
            await new Promise((resolve) => {
              let done = false;
              const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 2500);
              try {
                api.onAuthStateChanged(local.auth, (user) => {
                  this.user = user || null;
                  if (!done) { done = true; clearTimeout(timer); resolve(); }
                });
              } catch (_) { clearTimeout(timer); resolve(); }
            });
          }
          this.mode = this.user ? 'cloud' : 'local';
          console.log(`[REVEX] runtime ${BUILD}`, { localFirebase: true, cloud: this.mode === 'cloud', sdk: api.SDK_VERSION || null, projectWrites: 'rest', chatLayer: true });
          return this.mode;
        }
        await wait(150);
      }
    }

    const mode = await originalInit();
    if (this.fs?.db) this.db = this.fs.db;
    if (this.fs?.firebase?.collection) this.api = this.fs.firebase;
    console.log(`[REVEX] runtime ${BUILD}`, { localFirebase: this.fs === root.firebaseService, cloud: mode === 'cloud', fallback: true, projectWrites: 'rest', chatLayer: true });
    return mode;
  };

  Store.createProject = async function createProjectSafe({ name, code, description, driveFileId }) {
    if (!this.isCloud()) return originalCreateProject({ name, code, description, driveFileId });

    const title = String(name || '').trim();
    if (!title) throw new Error('Enter a project name.');

    const fs = root.firebaseService && root.firebaseService.isInitialized ? root.firebaseService : this.fs;
    this.fs = fs;
    this.api = fs?.firebase || this.api || root.firebase;
    this.db = fs?.db || this.db;
    this.user = fs?.auth?.currentUser || this.user;
    if (!this.user?.uid) throw new Error('Sign in before creating a REVEX project.');

    const at = iso();
    const uid = String(this.user.uid);
    const suffix = (root.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const projectId = `revex_${Date.now().toString(36)}_${suffix}`;
    const specProjectId = `spec_${projectId}`;
    const projectData = {
      name: title,
      code: String(code || '').trim(),
      description: String(description || '').trim(),
      status: 'in_progress',
      statusColor: '#FF9800',
      ownerId: uid,
      memberIds: [uid],
      driveFileId: String(driveFileId || '').trim() || null,
      createdAt: at,
      updatedAt: at,
      requestData: null,
      revexProject: true,
      revexSpecProjectId: specProjectId
    };
    const specData = {
      id: specProjectId,
      name: `${title} — Spec Book`,
      code: String(code || '').trim(),
      linkedProjectId: projectId,
      linkedProjectName: title,
      ownerId: uid,
      memberIds: [uid],
      settings: { divisionPerSchedule: true, showEmptyArticles: false },
      createdAt: at,
      updatedAt: at,
      managedByRevex: true
    };

    console.log('[REVEX] creating project through Firestore REST', projectId);
    await firestoreRest(`projects/${projectId}`, projectData);
    try {
      await firestoreRest(`specProjects/${specProjectId}`, specData);
    } catch (error) {
      await firestoreDelete(`projects/${projectId}`);
      throw error;
    }

    const project = { id: projectId, ...projectData };
    try {
      const chat = await this.ensureProjectChat(projectId);
      if (chat?.connId) {
        project.chatConnId = String(chat.connId);
        await firestoreRest(`projects/${projectId}`, {
          chatConnId: project.chatConnId,
          updatedAt: iso()
        }, ['chatConnId', 'updatedAt']);
      }
    } catch (error) {
      console.warn('[REVEX] project chat will be created when first opened', error);
    }

    setTimeout(setInviteEnabled, 300);
    return { ...project, specProjectId };
  };

  function projectId() {
    return String(document.getElementById('project-select')?.value || '').trim();
  }

  function projectName() {
    const select = document.getElementById('project-select');
    return select?.selectedOptions?.[0]?.textContent?.trim() || 'this REVEX project';
  }

  function setSync(label, tone = 'quiet') {
    const text = document.getElementById('sync-label');
    const indicator = document.getElementById('sync-indicator');
    if (text) text.textContent = label;
    if (indicator) indicator.dataset.tone = tone;
  }

  function notify(message, type = 'success') {
    if (root.parent?.dashboardManager?.showNotification) root.parent.dashboardManager.showNotification(message, type);
    else if (root.dashboardManager?.showNotification) root.dashboardManager.showNotification(message, type);
    else if (type === 'error') console.error(message);
    else console.log(message);
  }

  function assertActionLabels() {
    const labels = {
      'new-project-button': 'New',
      'invite-project-button': 'Invite',
      'sync-button': 'Import sync',
      'render-button': 'Render'
    };
    Object.entries(labels).forEach(([id, label]) => {
      const button = document.getElementById(id);
      if (!button) return;
      if (button.textContent.trim() !== label) button.textContent = label;
    });
    const invite = document.getElementById('invite-project-button');
    if (invite) {
      invite.setAttribute('aria-label', 'Invite people to the active REVEX project');
      invite.title = 'Project access';
      invite.hidden = false;
    }
  }

  function setInviteEnabled() {
    assertActionLabels();
    const button = document.getElementById('invite-project-button');
    if (button) button.disabled = !projectId();
  }

  function openInvite() {
    const id = projectId();
    if (!id) return;
    const dialog = document.getElementById('invite-dialog');
    const label = document.getElementById('invite-project-label');
    const email = document.getElementById('invite-email');
    if (!dialog || !email) return;
    if (label) label.textContent = `Invite to ${projectName()}. The email link signs them in and opens this REVEX project directly.`;
    email.value = '';
    dialog.hidden = false;
    setTimeout(() => email.focus(), 0);
  }

  function closeInvite() {
    const dialog = document.getElementById('invite-dialog');
    if (dialog) dialog.hidden = true;
  }

  async function submitInvite(event) {
    event.preventDefault();
    const id = projectId();
    const input = document.getElementById('invite-email');
    const submit = document.getElementById('invite-send');
    const email = String(input?.value || '').trim().toLowerCase();
    if (!id || !email || !submit) return;
    const fs = root.firebaseService;
    if (!fs?.callFunction) return notify('Project invitations are not available in this session.', 'error');

    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const result = await fs.callFunction('inviteProjectMemberByEmail', {
        projectId: id,
        email,
        source: 'revex',
        returnTo: 'revex'
      });
      if (!result?.ok) throw new Error(result?.message || 'Invitation could not be sent.');
      closeInvite();
      const msg = result.invited
        ? 'REVEX invite sent. The link will sign them in and open this project.'
        : result.added
          ? 'Member added to this REVEX project.'
          : 'This user already has access to the project.';
      notify(msg, 'success');
    } catch (error) {
      notify(error?.message || 'Could not send the invitation.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Send invite';
    }
  }

  function ensureChatLayer() {
    let layer = document.getElementById('revex-chat-layer');
    if (layer) return layer;
    layer = document.createElement('section');
    layer.id = 'revex-chat-layer';
    layer.className = 'revex-chat-layer';
    layer.hidden = true;
    layer.setAttribute('aria-label', 'Project Chat');
    layer.innerHTML = `
      <div class="revex-chat-layer-shell">
        <header class="revex-chat-layer-head">
          <div><strong>Project Chat</strong><span id="revex-chat-layer-project"></span></div>
          <button type="button" id="revex-chat-layer-close" class="sp-icon-btn" aria-label="Close Project Chat">×</button>
        </header>
        <iframe id="revex-chat-layer-frame" title="Project Chat" allow="camera; microphone; display-capture; clipboard-read; clipboard-write"></iframe>
      </div>`;
    document.body.appendChild(layer);
    document.getElementById('revex-chat-layer-close')?.addEventListener('click', closeChatLayer);
    document.getElementById('revex-chat-layer-frame')?.addEventListener('load', hydrateChatDraft);
    return layer;
  }

  function closeChatLayer() {
    const layer = document.getElementById('revex-chat-layer');
    if (layer) layer.hidden = true;
    document.body.classList.remove('revex-chat-open');
  }

  function chatContextFor(button) {
    const id = button?.id || '';
    const project = projectName();
    if (id === 'element-chat') {
      const inspector = document.getElementById('bim-inspector');
      const title = inspector?.querySelector('h2')?.textContent?.trim() || 'Selected BIM element';
      const ref = inspector?.querySelector('.eyebrow')?.textContent?.trim() || 'REVIT ELEMENT';
      const props = [...(inspector?.querySelectorAll('.property') || [])].map((row) => {
        const key = row.querySelector('span')?.textContent?.trim() || '';
        const value = row.textContent.replace(row.querySelector('span')?.textContent || '', '').trim();
        return key && value ? `${key}: ${value}` : '';
      }).filter(Boolean).slice(0, 6);
      return [`[REVEX · BIM]`, `Project: ${project}`, `${ref}: ${title}`, ...props].join('\n');
    }
    if (id === 'design-chat') {
      const inspector = document.getElementById('design-inspector');
      const title = inspector?.querySelector('h2')?.textContent?.trim() || 'Selected Design Book position';
      const chapter = inspector?.querySelector('.eyebrow')?.textContent?.trim() || 'DESIGN BOOK';
      const status = document.getElementById('design-status')?.value || '';
      return [`[REVEX · Design Book]`, `Project: ${project}`, `${chapter}: ${title}`, status ? `Status: ${status}` : ''].filter(Boolean).join('\n');
    }
    const existing = document.getElementById('chat-context')?.textContent?.trim() || '';
    if (existing && !/select a bim element|no item context selected/i.test(existing)) return existing;
    return '';
  }

  function hydrateChatDraft() {
    const frame = document.getElementById('revex-chat-layer-frame');
    const draft = String(sessionStorage.getItem('liber_revex_chat_draft') || '').trim();
    if (!frame || !draft) return;
    const apply = () => {
      try {
        const input = frame.contentDocument?.getElementById('message-input');
        if (!input) return false;
        if (!String(input.value || '').trim()) {
          input.value = draft;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      } catch (_) { return false; }
    };
    if (apply()) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (apply() || attempts > 20) clearInterval(timer);
    }, 150);
  }

  async function openProjectChatLayer(context = '') {
    const id = projectId();
    if (!id) return notify('Choose a project first.', 'error');
    try {
      setSync('Opening project chat…', 'busy');
      const result = await Store.ensureProjectChat(id);
      if (!result?.connId) throw new Error('No project connection was returned.');
      if (context) sessionStorage.setItem('liber_revex_chat_draft', context);
      else sessionStorage.removeItem('liber_revex_chat_draft');

      const layer = ensureChatLayer();
      const frame = document.getElementById('revex-chat-layer-frame');
      const projectLabel = document.getElementById('revex-chat-layer-project');
      if (projectLabel) projectLabel.textContent = projectName();
      const url = new URL('../secure-chat/index.html', location.href);
      url.searchParams.set('connId', String(result.connId));
      url.searchParams.set('inShell', '1');
      url.searchParams.set('revexLayer', '1');
      if (frame && frame.dataset.connId !== String(result.connId)) {
        frame.dataset.connId = String(result.connId);
        frame.src = url.href;
      } else {
        hydrateChatDraft();
      }
      layer.hidden = false;
      document.body.classList.add('revex-chat-open');
      setSync('Project chat connected', 'good');
    } catch (error) {
      setSync('Chat unavailable', 'bad');
      notify(error?.message || 'Could not open Project Chat.', 'error');
    }
  }

  function bind() {
    assertActionLabels();
    const select = document.getElementById('project-select');
    const open = document.getElementById('invite-project-button');
    const close = document.getElementById('invite-close');
    const cancel = document.getElementById('invite-cancel');
    const form = document.getElementById('invite-form');
    const dialog = document.getElementById('invite-dialog');

    if (select && !select.dataset.revexInviteBound) {
      select.dataset.revexInviteBound = '1';
      select.addEventListener('change', setInviteEnabled);
    }
    if (open && !open.dataset.revexInviteBound) { open.dataset.revexInviteBound = '1'; open.addEventListener('click', openInvite); }
    if (close && !close.dataset.revexInviteBound) { close.dataset.revexInviteBound = '1'; close.addEventListener('click', closeInvite); }
    if (cancel && !cancel.dataset.revexInviteBound) { cancel.dataset.revexInviteBound = '1'; cancel.addEventListener('click', closeInvite); }
    if (form && !form.dataset.revexInviteBound) { form.dataset.revexInviteBound = '1'; form.addEventListener('submit', submitInvite); }
    if (dialog && !dialog.dataset.revexInviteBound) {
      dialog.dataset.revexInviteBound = '1';
      dialog.addEventListener('click', (event) => { if (event.target === dialog) closeInvite(); });
    }

    const syncLabel = document.getElementById('sync-label');
    if (syncLabel && !syncLabel.dataset.revexActionObserver) {
      syncLabel.dataset.revexActionObserver = '1';
      new MutationObserver(setInviteEnabled).observe(syncLabel, { childList: true, characterData: true, subtree: true });
    }

    ensureChatLayer();
    setInviteEnabled();
  }

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('#open-chat, #element-chat, #design-chat');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openProjectChatLayer(chatContextFor(button));
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const chat = document.getElementById('revex-chat-layer');
    const invite = document.getElementById('invite-dialog');
    if (chat && !chat.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeChatLayer();
    } else if (invite && !invite.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeInvite();
    }
  }, true);

  root.addEventListener('message', (event) => {
    const frame = document.getElementById('revex-chat-layer-frame');
    if (event.source !== frame?.contentWindow) return;
    if (event.data?.type === 'liber:close-app-shell') closeChatLayer();
  });

  bind();
})(window);