(function () {
  'use strict';

  const STATUS_COLORS = { submitted: '#2196F3', initializing: '#9C27B0', in_progress: '#FF9800', review: '#9C27B0', completed: '#4CAF50', on_hold: '#607D8B' };
  const BASE_FOLDERS = ['record_in/docs', 'record_in/images', 'record_in/video', 'record_out/docs', 'record_out/images', 'record_out/video'];
  function getRecordInFolderByFile(file) {
    const t = String(file.type || '').toLowerCase();
    const n = String(file.name || '').toLowerCase();
    if (t.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/.test(n)) return 'record_in/images';
    if (t.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv)$/.test(n)) return 'record_in/video';
    return 'record_in/docs';
  }

  const MAX_FORM_FILES = 10;
  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const state = { projects: [], users: [], selectedProjectId: null, projectFormFiles: [], projectRespondFiles: [], responses: [] };

  function byId(id) {
    return document.getElementById(id);
  }

  function getFirebaseService() {
    // Use our own Firebase when in iframe to avoid "custom Object" addDoc/setDoc errors
    // (parent's Firestore rejects objects from iframe's realm)
    if (window.firebaseService && window.firebaseService.isInitialized)
      return window.firebaseService;
    try {
      for (const w of [window.parent, window.top].filter(Boolean)) {
        if (w !== window && w.firebaseService && w.firebaseService.isInitialized)
          return w.firebaseService;
      }
    } catch (_) {}
    return window.firebaseService;
  }

  function fb() {
    const fs = getFirebaseService();
    return (fs && fs.firebase) ? fs.firebase : (typeof firebase !== 'undefined' ? firebase : window.firebase);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function notify(msg, type) {
    if (window.parent && window.parent.dashboardManager) {
      window.parent.dashboardManager.showNotification(msg, type || 'success');
    } else {
      alert(msg);
    }
  }

  async function loadUsers() {
    const fs = getFirebaseService();
    if (!fs || !fs.db) return;
    try {
      const q = fb().query(fb().collection(fs.db, 'users'), fb().limit(200));
      const snap = await fb().getDocs(q);
      state.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.warn('[Project Manager] loadUsers failed', e);
    }
  }

  function renderOwnerSelect(selectedId) {
    const sel = byId('project-owner');
    if (!sel) return;
    const memberIds = getProjectMemberIds();
    const isNewProject = !byId('project-id')?.value?.trim();
    const ids = isNewProject && memberIds.length === 0 ? state.users.map((u) => u.id) : memberIds;
    sel.innerHTML = '<option value="">-- Choose owner --</option>' +
      ids.map((uid) => {
        const u = getUserById(uid);
        const label = u ? (u.username || u.email || uid) : uid;
        return `<option value="${escapeHtml(uid)}" ${uid === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('');
  }

  function filterUsers(search, excludeIds) {
    const q = (search || '').toLowerCase().trim();
    const exclude = new Set(excludeIds || []);
    let list = state.users.filter((u) => !exclude.has(u.id));
    if (q) {
      list = list.filter((u) =>
        (u.email || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        (u.id || '').toLowerCase().includes(q)
      );
    }
    return list.slice(0, 30);
  }

  function showAddUserDropdown() {
    const input = byId('project-add-user-search');
    const dd = byId('project-add-user-dropdown');
    if (!input || !dd) return;
    const exclude = getProjectMemberIds();
    const list = filterUsers(input.value.trim(), exclude);
    if (list.length === 0 && !state.users.length) {
      dd.innerHTML = '<div class="user-dropdown-item user-dropdown-empty">No users loaded yet.</div>';
      dd.classList.remove('hidden');
    } else if (list.length === 0) {
      dd.innerHTML = '<div class="user-dropdown-item user-dropdown-empty">No matching users or all already added.</div>';
      dd.classList.remove('hidden');
    } else {
      dd.innerHTML = list.map((u) => `<div class="user-dropdown-item" data-uid="${escapeHtml(u.id)}">${escapeHtml(u.username || u.email || u.id)}${u.email ? ` <span class="user-email">(${escapeHtml(u.email)})</span>` : ''}</div>`).join('');
      dd.classList.remove('hidden');
    }
    dd.querySelectorAll('.user-dropdown-item').forEach((el) => {
      el.addEventListener('click', () => {
        const uid = el.getAttribute('data-uid');
        addProjectMember(uid);
        input.value = '';
        dd.classList.add('hidden');
        showAddUserDropdown();
      });
    });
  }

  function getUserById(uid) {
    return state.users.find((u) => u.id === uid) || null;
  }

  function renderProjectMembers(memberIds, ownerId) {
    const list = byId('project-members-list');
    if (!list) return;
    const ids = Array.isArray(memberIds) ? [...memberIds] : ownerId ? [ownerId] : [];
    const seen = new Set();
    const rows = [];
    if (ownerId && !seen.has(ownerId)) {
      seen.add(ownerId);
      const u = getUserById(ownerId);
      const verified = !!(u?.isVerified);
      rows.push({ uid: ownerId, name: u?.username || u?.email || 'User', verified, isOwner: true });
    }
    ids.forEach((uid) => {
      if (seen.has(uid) || uid === ownerId) return;
      seen.add(uid);
      const u = getUserById(uid);
      rows.push({ uid, name: u?.username || u?.email || 'User', verified: !!(u?.isVerified), isOwner: false });
    });
    list.innerHTML = rows.map((r) => `
      <div class="member-row" data-uid="${escapeHtml(r.uid)}">
        <span class="${r.verified ? 'verified-badge' : 'unverified-badge'}">${r.verified ? 'Verified' : 'Unverified'}</span>
        <span class="member-name">${escapeHtml(r.name)}</span>
        ${r.isOwner ? '<span class="owner-tag">(owner)</span>' : ''}
        ${r.isOwner ? '' : `<button type="button" class="member-remove" data-uid="${escapeHtml(r.uid)}" title="Remove">Remove</button>`}
      </div>
    `).join('');
    list.querySelectorAll('.member-remove').forEach((btn) => {
      btn.addEventListener('click', () => removeProjectMember(btn.dataset.uid));
    });
  }

  function renderAddUserSelect(excludeIds) {
    const input = byId('project-add-user-search');
    if (input) input.value = '';
    const dd = byId('project-add-user-dropdown');
    if (dd) dd.classList.add('hidden');
  }

  function getProjectMemberIds() {
    const list = byId('project-members-list');
    if (!list) return [];
    return Array.from(list.querySelectorAll('.member-row')).map((r) => r.dataset.uid).filter(Boolean);
  }

  function removeProjectMember(uid) {
    const rows = byId('project-members-list')?.querySelectorAll('.member-row');
    if (!rows) return;
    const row = Array.from(rows).find((r) => r.dataset.uid === uid);
    if (row) row.remove();
    const ownerId = byId('project-owner')?.value?.trim();
    if (ownerId === uid) byId('project-owner').value = '';
    renderOwnerSelect(byId('project-owner')?.value || '');
    renderAddUserSelect(getProjectMemberIds());
  }

  function addProjectMember(uid) {
    if (!uid) return;
    const current = getProjectMemberIds();
    if (current.includes(uid)) return;
    const u = getUserById(uid);
    if (!u) return;
    const list = byId('project-members-list');
    if (!list) return;
    const div = document.createElement('div');
    div.className = 'member-row';
    div.dataset.uid = uid;
    div.innerHTML = `
      <span class="${u.isVerified ? 'verified-badge' : 'unverified-badge'}">${u.isVerified ? 'Verified' : 'Unverified'}</span>
      <span class="member-name">${escapeHtml(u.username || u.email || 'User')}</span>
      <button type="button" class="member-remove" data-uid="${escapeHtml(uid)}" title="Remove">Remove</button>
    `;
    div.querySelector('.member-remove').addEventListener('click', () => removeProjectMember(uid));
    list.appendChild(div);
    const sel = byId('project-owner');
    if (sel && !sel.value) sel.value = uid;
    const ownerId = sel?.value?.trim() || uid;
    const ids = getProjectMemberIds();
    const ordered = ownerId ? [ownerId, ...ids.filter((id) => id !== ownerId)] : ids;
    renderProjectMembers(ordered, ownerId || undefined);
    renderOwnerSelect(ownerId || '');
    renderAddUserSelect(getProjectMemberIds());
  }

  async function loadProjects() {
    const fs = getFirebaseService();
    if (!fs || !fs.isInitialized) return;
    const me = fs.auth?.currentUser;
    if (!me) return;
    try {
      const q = fb().query(
        fb().collection(fs.db, 'projects'),
        fb().orderBy('updatedAt', 'desc'),
        fb().limit(100)
      );
      const snap = await fb().getDocs(q);
      state.projects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error('[Project Manager] loadProjects failed', e);
      state.projects = [];
    }
  }

  function renderProjects() {
    const list = byId('projects-list');
    if (!list) return;
    const search = (byId('project-search')?.value || '').toLowerCase();
    const statusFilter = byId('status-filter')?.value || '';
    let filtered = state.projects;
    if (search) filtered = filtered.filter((p) => (p.name || '').toLowerCase().includes(search) || (p.description || '').toLowerCase().includes(search));
    if (statusFilter) filtered = filtered.filter((p) => (p.status || '') === statusFilter);

    list.innerHTML = filtered.map((p) => {
      const color = p.statusColor || STATUS_COLORS[p.status] || '#6b7280';
      const owner = getUserById(p.ownerId);
      const ownerVerified = !!(owner?.isVerified);
      const ownerLabel = owner ? (owner.username || owner.email || 'User') : '—';
      const verifiedBadge = owner ? `<span class="owner-${ownerVerified ? 'verified' : 'unverified'}">${ownerVerified ? 'verified' : 'unverified'}</span>` : '';
      return `<div class="project-row" data-project-id="${escapeHtml(p.id)}">
        <span class="status-badge" style="background:${color}33;border:1px solid ${color}"><span style="background:${color};width:8px;height:8px;border-radius:50%;display:inline-block"></span> ${escapeHtml(String(p.status || 'unknown').replace(/_/g, ' '))}</span>
        <div class="project-name">${escapeHtml(p.name || 'Untitled')}</div>
        <div class="project-meta">${escapeHtml(ownerLabel)} ${verifiedBadge} · ${p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : ''}</div>
        <div class="project-actions">
          <button class="btn-icon" data-action="edit" data-project-id="${escapeHtml(p.id)}" title="Edit"><i class="fas fa-pencil-alt"></i></button>
          <button class="btn-icon" data-action="library" data-project-id="${escapeHtml(p.id)}" title="Library"><i class="fas fa-folder"></i></button>
          <a href="#" class="btn-icon" data-action="chat" data-project-id="${escapeHtml(p.id)}" title="Chat"><i class="fas fa-comments"></i></a>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-action="edit"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-project-id');
        const p = state.projects.find((pr) => pr.id === id);
        if (p) showProjectForm(p);
      });
    });
    list.querySelectorAll('[data-action="library"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-project-id');
        const p = state.projects.find((pr) => pr.id === id);
        if (p) showLibrary(p);
      });
    });
    list.querySelectorAll('[data-action="chat"]').forEach((a) => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        const projectId = a.getAttribute('data-project-id');
        if (!projectId) return;
        const fs = getFirebaseService();
        if (!fs) return;
        try {
          const res = await fs.callFunction('ensureProjectChat', { projectId });
          const connId = res?.connId;
          if (!connId) { notify('Could not open project chat', 'error'); return; }
          const path = window.location.pathname.replace(/project-manager\/[^?]*/, 'secure-chat/index.html');
          const full = window.location.origin + path + '?connId=' + encodeURIComponent(connId);
          const host = window.parent && window.parent !== window ? window.parent : window.top || window;
          if (host?.appsManager && typeof host.appsManager.openAppInShell === 'function') {
            host.appsManager.openAppInShell({ id: 'secure-chat', name: 'Connections' }, full);
          } else {
            window.open(full, '_blank');
          }
          const p = state.projects.find((pr) => pr.id === projectId);
          if (p && res?.repaired) p.chatConnId = connId;
        } catch (err) {
          notify(err?.message || 'Failed to open chat', 'error');
        }
      });
    });
  }

  async function showProjectForm(project) {
    const formPanel = byId('project-form-panel');
    const mainPanel = byId('manager-main');
    const libPanel = byId('library-panel');
    if (!formPanel || !mainPanel) return;
    state.selectedProjectId = project ? project.id : null;
    state.projectFormFiles = [];
    formPanel.style.display = '';
    mainPanel.style.display = 'none';
    if (libPanel) libPanel.style.display = 'none';
    const formTitle = byId('project-form-title');
    const projId = byId('project-id');
    const projName = byId('project-name');
    const projDesc = byId('project-description');
    const projStatus = byId('project-status');
    const projColor = byId('project-status-color');
    if (formTitle) formTitle.textContent = project ? 'Edit Project' : 'New Project';
    if (projId) projId.value = project ? project.id : '';
    if (projName) projName.value = project ? (project.name || '') : '';
    if (projDesc) projDesc.value = project ? (project.description || '') : '';
    if (projStatus) projStatus.value = project ? (project.status || 'submitted') : 'submitted';
    const colorOpts = ['#ef4444', '#f97316', '#22c55e'];
    const savedColor = project?.statusColor || STATUS_COLORS[project?.status] || '#f97316';
    if (projColor) projColor.value = colorOpts.includes(savedColor) ? savedColor : '#f97316';
    const attWrap = byId('project-attachments-wrap');
    if (attWrap) attWrap.style.display = project ? 'none' : '';
    if (!state.users.length) await loadUsers();
    const memberIds = project?.memberIds ? [...project.memberIds] : (project?.ownerId ? [project.ownerId] : []);
    const ownerId = project ? project.ownerId : '';
    renderProjectMembers(memberIds.length ? memberIds : [], ownerId || undefined);
    renderOwnerSelect(ownerId || '');
    renderAddUserSelect(memberIds.length ? memberIds : []);
    renderProjectFormFileList();
    state.projectRespondFiles = [];
    renderProjectRespondFileList();
    byId('project-respond-message').value = '';
    updateProjectActionSections(project);
    if (project && (project.status === 'submitted' || project.status === 'in_progress')) {
      const me = getFirebaseService()?.auth?.currentUser?.uid;
      if (me) loadMyInvoices(me).then((inv) => renderInvoiceAttachSelect(inv));
    }
    if (project?.id) {
      loadResponses(project.id).then((responses) => renderResponses(responses));
      loadReviews(project.id).then((reviews) => renderReviews(reviews, project.id));
    } else {
      byId('project-responses-list').innerHTML = '';
      byId('project-responses-list').classList.add('hidden');
      byId('project-reviews-list').innerHTML = '';
      byId('project-reviews-list').classList.add('hidden');
    }
  }

  async function loadMyInvoices(uid) {
    const fs = getFirebaseService();
    if (!fs?.db || !uid) return [];
    try {
      const snap = await fb().getDocs(fb().collection(fs.db, 'users', uid, 'invoices'));
      const invoices = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return invoices.filter((inv) => inv.pdfPath || inv.pdfUrl).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } catch (e) {
      console.warn('[Project Manager] loadMyInvoices failed', e);
      return [];
    }
  }

  async function addInvoiceAsAttachment(invoice) {
    const fs = getFirebaseService();
    const me = fs?.auth?.currentUser?.uid;
    if (!fs?.storage || !me || !invoice) return;
    let url = invoice.pdfUrl;
    if (!url && invoice.pdfPath) {
      try {
        const r = fb().ref(fs.storage, invoice.pdfPath);
        url = await fb().getDownloadURL(r);
      } catch (e) {
        console.warn('[Project Manager] getDownloadURL for invoice failed', e);
        notify('Could not load invoice PDF', 'error');
        return;
      }
    }
    if (!url) {
      notify('Invoice has no PDF attached', 'error');
      return;
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Fetch failed');
      const blob = await resp.blob();
      const fileName = (invoice.invoiceId || invoice.id || 'invoice') + '.pdf';
      const file = new File([blob], fileName, { type: 'application/pdf' });
      addProjectRespondFiles([file]);
      notify(`Attached ${fileName}`);
    } catch (e) {
      console.warn('[Project Manager] fetch invoice PDF failed', e);
      notify('Could not attach invoice', 'error');
    }
  }

  function renderInvoiceAttachSelect(invoices) {
    const sel = byId('project-respond-invoice');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">— Attach from my invoices —</option>' +
      invoices.slice(0, 30).map((inv) => {
        const label = inv.invoiceId || inv.id || inv.clientName || 'Invoice';
        const date = inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '';
        return `<option value="${escapeHtml(inv.id)}" data-invoice-id="${escapeHtml(inv.id)}">${escapeHtml(label)}${date ? ' (' + date + ')' : ''}</option>`;
      }).join('');
    sel.value = '';
  }

  function updateProjectActionSections(project) {
    const status = project?.status || 'submitted';
    const respondSec = byId('project-respond-section');
    const approveSec = byId('project-approve-section');
    const requestReviewSec = byId('project-request-review-section');
    const approveReviewSec = byId('project-approve-review-section');
    if (respondSec) respondSec.classList.toggle('hidden', !project || (status !== 'in_progress' && status !== 'submitted'));
    if (approveSec) approveSec.classList.add('hidden');
    if (requestReviewSec) requestReviewSec.classList.toggle('hidden', !project || status !== 'in_progress');
    const awaitingOwner = status === 'in_progress' || status === 'review' || status === 'initializing';
    if (approveReviewSec) approveReviewSec.classList.toggle('hidden', !project || !awaitingOwner);
  }

  function hideProjectForm() {
    byId('project-form-panel').style.display = 'none';
    byId('manager-main').style.display = '';
    state.projectFormFiles = [];
    state.projectRespondFiles = [];
  }

  function addProjectRespondFiles(newFiles) {
    for (const f of newFiles) {
      if (state.projectRespondFiles.length >= MAX_FORM_FILES) break;
      if (f.size > MAX_FILE_SIZE) continue;
      const dup = state.projectRespondFiles.some((x) => x.name === f.name && x.size === f.size);
      if (!dup) state.projectRespondFiles.push(f);
    }
    renderProjectRespondFileList();
  }

  function renderProjectRespondFileList() {
    const list = byId('project-respond-file-list');
    if (!list) return;
    list.innerHTML = state.projectRespondFiles.map((f, i) =>
      `<div class="project-form-file-item"><span>${escapeHtml(f.name)} (${(f.size / 1024).toFixed(1)} KB)</span><button type="button" class="project-form-file-item-remove" data-i="${i}" title="Remove">&times;</button></div>`
    ).join('');
    list.querySelectorAll('.project-form-file-item-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.projectRespondFiles.splice(parseInt(btn.dataset.i, 10), 1);
        renderProjectRespondFileList();
      });
    });
  }

  async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function loadResponses(projectId) {
    const fs = getFirebaseService();
    if (!fs?.db || !projectId) return [];
    try {
      const snap = await fb().getDocs(fb().collection(fs.db, 'projects', projectId, 'responses'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } catch (e) {
      console.warn('[Project Manager] loadResponses failed', e);
      return [];
    }
  }

  async function loadReviews(projectId) {
    const fs = getFirebaseService();
    if (!fs?.db || !projectId) return [];
    try {
      const snap = await fb().getDocs(fb().collection(fs.db, 'projects', projectId, 'reviews'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } catch (e) {
      console.warn('[Project Manager] loadReviews failed', e);
      return [];
    }
  }

  function renderReviews(reviews, projectId) {
    const list = byId('project-reviews-list');
    const toggleBtn = byId('project-reviews-toggle');
    if (!list) return;
    const pid = projectId || state.selectedProjectId || byId('project-id')?.value?.trim() || '';
    if (!reviews.length) {
      list.innerHTML = '<p class="responses-empty">No reviews yet.</p>';
      list.classList.remove('hidden');
      return;
    }
    list.classList.remove('hidden');
    if (toggleBtn && toggleBtn.querySelector('i')) toggleBtn.querySelector('i').className = 'fas fa-chevron-down';
    list.innerHTML = reviews.map((r) => {
      const text = (r.text || '').trim();
      const userName = (r.userName || 'User').trim();
      const date = r.createdAt ? new Date(r.createdAt).toLocaleString() : '';
      return `<div class="response-item review-item" data-review-id="${escapeHtml(r.id)}">
        <div class="response-meta">${escapeHtml(userName)} · ${escapeHtml(date)}</div>
        <div class="response-message">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
        <button type="button" class="btn-icon review-remove" data-project-id="${escapeHtml(pid)}" data-review-id="${escapeHtml(r.id)}" title="Remove review"><i class="fas fa-trash"></i></button>
      </div>`;
    }).join('');
    list.querySelectorAll('.review-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const projectId = btn.getAttribute('data-project-id');
        const reviewId = btn.getAttribute('data-review-id');
        if (!projectId || !reviewId) return;
        if (!confirm('Remove this review? It will also be removed from the main page.')) return;
        const fs = getFirebaseService();
        try {
          await fs.callFunction('deleteProjectReview', { projectId, reviewId });
          notify('Review removed');
          const reviews = await loadReviews(projectId);
          renderReviews(reviews, projectId);
        } catch (err) {
          notify(err?.message || 'Failed to remove review', 'error');
        }
      });
    });
    list.classList.remove('hidden');
  }

  function renderResponses(responses) {
    const list = byId('project-responses-list');
    if (!list) return;
    if (!responses.length) {
      list.innerHTML = '<p class="responses-empty">No responses yet.</p>';
      list.classList.remove('hidden');
      return;
    }
    list.innerHTML = responses.map((r) => {
      const msg = (r.message || '').trim();
      const files = (r.fileRefs || []).map((f) =>
        f.storagePath
          ? `<a href="#" class="response-file" data-path="${escapeHtml(f.storagePath)}" title="Download">${escapeHtml(f.name || 'file')}</a>`
          : `<span class="response-file">${escapeHtml(f.name || 'file')}</span>`
      ).join('');
      const date = r.createdAt ? new Date(r.createdAt).toLocaleString() : '';
      return `<div class="response-item">
        <div class="response-meta">${escapeHtml(date)}</div>
        ${msg ? `<div class="response-message">${escapeHtml(msg).replace(/\n/g, '<br>')}</div>` : ''}
        ${files ? `<div class="response-files">${files}</div>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.response-file[data-path]').forEach((a) => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        const path = a.getAttribute('data-path');
        if (!path) return;
        const fs = getFirebaseService();
        if (!fs?.storage) { notify('Storage not available', 'error'); return; }
        const fileName = (a.textContent || '').trim() || 'file';
        try {
          const r = fb().ref(fs.storage, path);
          const url = await fb().getDownloadURL(r);
          try {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error('Fetch failed');
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(blobUrl);
          } catch (_) {
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          }
        } catch (err) { notify(err?.message || 'Download failed', 'error'); }
      });
    });
    list.classList.remove('hidden');
  }

  function addProjectFormFiles(newFiles) {
    for (const f of newFiles) {
      if (state.projectFormFiles.length >= MAX_FORM_FILES) break;
      if (f.size > MAX_FILE_SIZE) continue;
      const dup = state.projectFormFiles.some((x) => x.name === f.name && x.size === f.size);
      if (!dup) state.projectFormFiles.push(f);
    }
    renderProjectFormFileList();
  }

  function renderProjectFormFileList() {
    const list = byId('project-form-file-list');
    if (!list) return;
    list.innerHTML = state.projectFormFiles.map((f, i) =>
      `<div class="project-form-file-item"><span>${escapeHtml(f.name)} (${(f.size / 1024).toFixed(1)} KB)</span><button type="button" class="project-form-file-item-remove" data-i="${i}" title="Remove">&times;</button></div>`
    ).join('');
    list.querySelectorAll('.project-form-file-item-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.projectFormFiles.splice(parseInt(btn.dataset.i, 10), 1);
        renderProjectFormFileList();
      });
    });
  }

  async function onSaveProject(e) {
    e.preventDefault();
    const fs = getFirebaseService();
    const me = fs?.auth?.currentUser;
    if (!me) {
      notify('Please log in', 'error');
      return;
    }
    const id = byId('project-id').value.trim();
    const name = byId('project-name').value.trim();
    const description = byId('project-description').value.trim();
    const status = byId('project-status').value;
    const statusColor = byId('project-status-color').value.trim();
    const ownerId = byId('project-owner').value.trim();
    const allMemberIds = getProjectMemberIds();
    const memberIds = [ownerId].filter(Boolean);
    allMemberIds.forEach((uid) => { if (uid !== ownerId && !memberIds.includes(uid)) memberIds.push(uid); });
    const projectForDisplayName = (oId, excludeId) => {
      const matches = state.projects.filter((p) => p.ownerId === oId && p.id !== excludeId && (!(p.name || '').trim() || /^Project\s*#\d+$/i.test((p.name || '').trim())));
      return `Project #${matches.length + 1}`;
    };
    const displayName = name.trim() || projectForDisplayName(ownerId, id || '');
    if (!ownerId) {
      notify('Please add members and select an owner', 'error');
      return;
    }
    const now = new Date().toISOString();
    try {
      if (id) {
        const proj = state.projects.find((p) => p.id === id);
        if (status === 'on_hold' || proj?.status === 'on_hold') {
          const userDoc = await fb().getDoc(fb().doc(fs.db, 'users', me.uid));
          const role = (userDoc?.data?.()?.role || '').toLowerCase();
          if (role !== 'admin') {
            notify('Only admins can set or change On hold status.', 'error');
            return;
          }
        }
        const ref = fb().doc(fs.db, 'projects', id);
        await fb().updateDoc(ref, { name: displayName, description, status, statusColor: statusColor || null, memberIds, updatedAt: now });
        try {
          await fs.callFunction('ensureProjectChat', { projectId: id });
        } catch (chatError) {
          console.error('[Project Manager] Chat membership synchronization failed', chatError);
          notify('Project saved; Chat membership will repair when reopened.', 'warning');
        }
        notify('Project updated');
      } else {
        const finalOwnerId = ownerId || me.uid;
        const finalMemberIds = memberIds.length ? memberIds : [finalOwnerId];
        const projectData = JSON.parse(JSON.stringify({
          name: displayName,
          description,
          status,
          statusColor: statusColor || STATUS_COLORS[status] || null,
          ownerId: finalOwnerId,
          memberIds: finalMemberIds,
          createdAt: now,
          updatedAt: now,
          requestData: null
        }));
        const projectRef = await fb().addDoc(fb().collection(fs.db, 'projects'), projectData);
        const projectId = projectRef.id;
        try {
          const chat = await fs.callFunction('ensureProjectChat', { projectId });
          if (chat?.connId) projectData.chatConnId = chat.connId;
        } catch (chatError) {
          console.error('[Project Manager] Project Chat creation deferred', chatError);
          notify('Project created; Chat will initialize when first opened.', 'warning');
        }
        for (let i = 0; i < Math.min(state.projectFormFiles.length, MAX_FORM_FILES); i++) {
          const file = state.projectFormFiles[i];
          try {
            const folder = getRecordInFolderByFile(file);
            const fname = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
            const storagePath = `projects/${projectId}/library/${folder}/${Date.now()}_${fname}`;
            const ref = fb().ref(fs.storage, storagePath);
            await fb().uploadBytes(ref, file, { contentType: file.type || 'application/octet-stream' });
            const libData = JSON.parse(JSON.stringify({
              folderPath: folder,
              name: fname,
              storagePath,
              type: 'file',
              createdAt: now,
              createdBy: me.uid
            }));
            await fb().addDoc(fb().collection(fs.db, 'projects', projectId, 'library'), libData);
          } catch (upErr) {
            console.warn('[Project Manager] attachment upload failed', file.name, upErr);
          }
        }
        state.projectFormFiles = [];
        notify('Project created');
      }
      hideProjectForm();
      await loadProjects();
      renderProjects();
    } catch (err) {
      notify(err?.message || 'Failed to save', 'error');
    }
  }

  function showLibrary(project) {
    state.selectedProjectId = project.id;
    byId('manager-main').style.display = 'none';
    byId('project-form-panel').style.display = 'none';
    byId('library-panel').style.display = '';
    byId('library-project-name').textContent = project.name || 'Project';
    loadLibraryContent();
  }

  async function loadLibraryContent() {
    const fs = getFirebaseService();
    const folder = byId('library-folder')?.value || 'record_out/docs';
    const content = byId('library-content');
    if (!content || !state.selectedProjectId || !fs?.db) return;
    try {
      const q = fb().query(
        fb().collection(fs.db, 'projects', state.selectedProjectId, 'library'),
        fb().where('folderPath', '==', folder)
      );
      const snap = await fb().getDocs(q);
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      content.innerHTML = items
        .filter((i) => i.type === 'file')
        .map((i) => `<div class="lib-item"><i class="fas fa-file"></i><span class="lib-name">${escapeHtml(i.name || 'file')}</span><a href="#" data-path="${escapeHtml(i.storagePath || '')}">Download</a></div>`)
        .join('');
      content.querySelectorAll('a[data-path]').forEach((a) => {
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          const path = a.getAttribute('data-path');
          if (!path) return;
          try {
            const r = fb().ref(fs.storage, path);
            const url = await fb().getDownloadURL(r);
            window.open(url, '_blank');
          } catch (err) {
            notify('Download failed', 'error');
          }
        });
      });
    } catch (e) {
      content.innerHTML = '<p>Failed to load library</p>';
    }
  }

  async function uploadToLibrary(file) {
    const fs = getFirebaseService();
    const projectId = state.selectedProjectId;
    const folder = byId('library-folder')?.value || 'record_out/docs';
    if (!fs?.storage || !projectId || !file) return;
    const fname = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const storagePath = `projects/${projectId}/library/${folder}/${Date.now()}_${fname}`;
    const ref = fb().ref(fs.storage, storagePath);
    await fb().uploadBytes(ref, file, { contentType: file.type || 'application/octet-stream' });
    const libData = JSON.parse(JSON.stringify({
      folderPath: folder,
      name: fname,
      storagePath,
      type: 'file',
      createdAt: new Date().toISOString(),
      createdBy: fs.auth?.currentUser?.uid
    }));
    await fb().addDoc(fb().collection(fs.db, 'projects', projectId, 'library'), libData);
  }

  async function createSubfolder(name) {
    const fs = getFirebaseService();
    const projectId = state.selectedProjectId;
    const base = byId('library-folder')?.value || 'record_in/docs';
    if (!name || !projectId || !fs?.db) return;
    const folderPath = base + '/' + name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const folderData = JSON.parse(JSON.stringify({
      folderPath,
      name,
      type: 'folder',
      createdAt: new Date().toISOString(),
      createdBy: fs.auth?.currentUser?.uid
    }));
    await fb().addDoc(fb().collection(fs.db, 'projects', projectId, 'library'), folderData);
    notify('Folder created');
    loadLibraryContent();
  }

  function init() {
    byId('back-btn')?.addEventListener('click', () => {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'liber:close-app-shell' }, '*');
        }
      } catch (_) {}
    });

    const appRoot = document.querySelector('.manager-app');
    if (appRoot) {
      appRoot.addEventListener('click', (e) => {
        if (e.target?.closest?.('#project-add-btn')) {
          e.preventDefault();
          try { showProjectForm(null); } catch (err) { console.error('[Project Manager] showProjectForm', err); }
        }
      });
    }
    byId('project-cancel')?.addEventListener('click', () => hideProjectForm());
    byId('project-form')?.addEventListener('submit', onSaveProject);
    const respondUpload = byId('project-respond-upload');
    const respondFileInput = byId('project-respond-files');
    if (respondUpload && respondFileInput) {
      respondFileInput.addEventListener('change', (e) => {
        addProjectRespondFiles(Array.from(e.target.files || []));
        e.target.value = '';
      });
    }
    byId('project-respond-invoice')?.addEventListener('change', async (e) => {
      const sel = e.target;
      const val = sel?.value?.trim();
      if (!val) return;
      const fs = getFirebaseService();
      const me = fs?.auth?.currentUser?.uid;
      if (!me) return;
      try {
        const invSnap = await fb().getDoc(fb().doc(fs.db, 'users', me, 'invoices', val));
        const inv = invSnap.exists ? { id: invSnap.id, ...invSnap.data() } : null;
        sel.value = '';
        if (inv) await addInvoiceAsAttachment(inv);
      } catch (err) {
        console.warn('[Project Manager] addInvoiceAsAttachment failed', err);
        sel.value = '';
      }
    });
    byId('project-responses-toggle')?.addEventListener('click', () => {
      const list = byId('project-responses-list');
      const icon = byId('project-responses-toggle')?.querySelector('i');
      if (list?.classList.toggle('hidden')) {
        if (icon) icon.className = 'fas fa-chevron-right';
      } else {
        if (icon) icon.className = 'fas fa-chevron-down';
        const id = byId('project-id')?.value?.trim();
        if (id) loadResponses(id).then((r) => renderResponses(r));
      }
    });
    byId('project-reviews-toggle')?.addEventListener('click', () => {
      const list = byId('project-reviews-list');
      const icon = byId('project-reviews-toggle')?.querySelector('i');
      if (list?.classList.toggle('hidden')) {
        if (icon) icon.className = 'fas fa-chevron-right';
      } else {
        if (icon) icon.className = 'fas fa-chevron-down';
        const id = byId('project-id')?.value?.trim();
        if (id) loadReviews(id).then((r) => renderReviews(r, id));
      }
    });
    byId('project-respond-btn')?.addEventListener('click', async () => {
      const id = byId('project-id')?.value?.trim();
      if (!id) return;
      const fs = getFirebaseService();
      const me = fs?.auth?.currentUser?.uid;
      if (!me) return;
      const message = (byId('project-respond-message')?.value || '').trim();
      const base64Files = [];
      for (let i = 0; i < Math.min(state.projectRespondFiles.length, MAX_FORM_FILES); i++) {
        const f = state.projectRespondFiles[i];
        const b64 = await fileToBase64(f);
        base64Files.push({ name: f.name, data: b64, type: f.type });
      }
      try {
        const res = await fs.callFunction('sendProjectRespondEmail', { projectId: id, message, base64Files });
        if (res === null) throw new Error('Failed to send response (401 or network error). Are you logged in?');
        if (res && res.ok !== true && res.sent !== true) throw new Error(res?.message || 'Response failed');
        notify('Response sent.');
        state.projectRespondFiles = [];
        renderProjectRespondFileList();
        byId('project-respond-message').value = '';
        await loadProjects();
        const p = state.projects.find((pr) => pr.id === id);
        if (p) {
          showProjectForm({ ...p, status: 'in_progress' });
          loadResponses(id).then((r) => renderResponses(r));
        }
      } catch (err) { notify(err?.message || 'Failed', 'error'); }
    });
    byId('project-request-review-btn')?.addEventListener('click', async () => {
      const id = byId('project-id')?.value?.trim();
      if (!id) return;
      const fs = getFirebaseService();
      try {
        const now = new Date().toISOString();
        await fb().updateDoc(fb().doc(fs.db, 'projects', id), {
          status: 'review',
          reviewRequestedAt: now,
          updatedAt: now
        });
        notify('Review requested. Project under review.');
        await loadProjects();
        const p = state.projects.find((pr) => pr.id === id);
        if (p) showProjectForm({ ...p, status: 'review' });
      } catch (err) { notify(err?.message || 'Failed', 'error'); }
    });
    const formUploadZone = byId('project-form-upload-zone');
    const formFileInput = byId('project-form-file-input');
    if (formUploadZone && formFileInput) {
      formUploadZone.addEventListener('dragover', (e) => { e.preventDefault(); formUploadZone.classList.add('dragover'); });
      formUploadZone.addEventListener('dragleave', () => formUploadZone.classList.remove('dragover'));
      formUploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        formUploadZone.classList.remove('dragover');
        addProjectFormFiles(Array.from(e.dataTransfer?.files || []));
      });
      formFileInput.addEventListener('change', (e) => {
        addProjectFormFiles(Array.from(e.target.files || []));
        e.target.value = '';
      });
      document.addEventListener('paste', (e) => {
        if (!byId('project-attachments-wrap')?.offsetParent) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        const toAdd = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].type?.indexOf('image') !== -1) {
            const f = items[i].getAsFile();
            if (f) toAdd.push(f);
          }
        }
        if (toAdd.length) { e.preventDefault(); addProjectFormFiles(toAdd); }
      });
    }

    byId('project-add-member-btn')?.addEventListener('click', () => { byId('project-add-user-search')?.focus(); showAddUserDropdown(); });
    byId('project-owner')?.addEventListener('change', () => {
      const ownerId = byId('project-owner')?.value?.trim();
      const others = getProjectMemberIds().filter((id) => id !== ownerId);
      renderProjectMembers(ownerId ? [ownerId, ...others] : others, ownerId || undefined);
    });
    byId('project-add-user-search')?.addEventListener('input', () => showAddUserDropdown());
    byId('project-add-user-search')?.addEventListener('focus', () => showAddUserDropdown());
    byId('project-add-user-search')?.addEventListener('blur', () => setTimeout(() => byId('project-add-user-dropdown')?.classList.add('hidden'), 150));

    byId('project-search')?.addEventListener('input', () => renderProjects());
    byId('status-filter')?.addEventListener('change', () => renderProjects());

    byId('library-back')?.addEventListener('click', () => {
      byId('library-panel').style.display = 'none';
      byId('manager-main').style.display = '';
    });
    byId('library-folder')?.addEventListener('change', () => loadLibraryContent());

    byId('library-create-folder')?.addEventListener('click', () => {
      const name = prompt('Subfolder name:');
      if (name) createSubfolder(name);
    });

    const uploadZone = byId('library-upload-zone');
    const uploadInput = byId('library-upload-input');
    if (uploadZone && uploadInput) {
      uploadZone.addEventListener('click', (e) => { e.preventDefault(); setTimeout(() => uploadInput.click(), 0); });
      uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
      uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
      uploadZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer?.files || []);
        for (const f of files) {
          try {
            await uploadToLibrary(f);
            notify('Uploaded ' + f.name);
          } catch (err) {
            notify('Failed: ' + f.name, 'error');
          }
        }
        loadLibraryContent();
      });
      uploadInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        for (const f of files) {
          try {
            await uploadToLibrary(f);
            notify('Uploaded ' + f.name);
          } catch (err) {
            notify('Failed: ' + f.name, 'error');
          }
        }
        loadLibraryContent();
      });
    }

    async function isCurrentUserAdmin() {
      try {
        const parent = window.parent || window.top;
        if (parent && parent.dashboardManager?._isAdminSession) return true;
        if (parent && parent.authManager?.isAdmin?.()) return true;
      } catch (_) {}
      const fs = getFirebaseService();
      const me = fs?.auth?.currentUser;
      if (!me || !fs?.db) return false;
      const userDoc = await fb().getDoc(fb().doc(fs.db, 'users', me.uid));
      const role = userDoc?.exists ? (userDoc.data()?.role || 'user') : 'user';
      return String(role).toLowerCase() === 'admin';
    }

    const tryInit = async () => {
      if (!window.firebase || !window.firebaseService?.isInitialized) {
        setTimeout(tryInit, 200);
        return;
      }
      const fs = getFirebaseService();
      if (!fs?.auth?.currentUser) {
        notify('Please log in first', 'error');
        showAccessDenied('Please log in to access Project Manager.');
        return;
      }
      const isAdmin = await isCurrentUserAdmin();
      if (!isAdmin) {
        showAccessDenied('Project Manager is for administrators only. Use Project Tracker to view your projects.');
        return;
      }
      await loadUsers();
      await loadProjects();
      renderProjects();
    };

    function showAccessDenied(message) {
      const app = document.querySelector('.manager-app');
      if (!app) return;
      app.innerHTML = `
        <header class="manager-header">
          <h1><i class="fas fa-cogs"></i> Project Manager</h1>
        </header>
        <div class="panel" style="text-align:center;padding:2rem;">
          <p style="color:var(--error-color,#c62828);margin:1rem 0;">${escapeHtml(message)}</p>
          <button id="back-btn" class="btn btn-secondary"><i class="fas fa-arrow-left"></i> Back</button>
        </div>
      `;
      const backBtn = document.getElementById('back-btn');
      if (backBtn) backBtn.addEventListener('click', () => { try { if (window.parent?.history) window.parent.history.back(); else window.history.back(); } catch(_) { window.location.href = '../'; } });
    }
    tryInit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
