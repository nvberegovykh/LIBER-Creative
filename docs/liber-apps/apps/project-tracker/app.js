(function () {
  'use strict';

  const BASE_FOLDERS = ['docs', 'images', 'video'];
  function getRecordInFolderByFile(file) {
    const t = String(file.type || '').toLowerCase();
    const n = String(file.name || '').toLowerCase();
    if (t.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif|ico)$/.test(n)) return 'record_in/images';
    if (t.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv|m4v|wmv|flv)$/.test(n)) return 'record_in/video';
    return 'record_in/docs';
  }
  const STATUS_COLORS = {
    submitted: '#2196F3',
    initializing: '#9C27B0',
    in_progress: '#FF9800',
    review: '#9C27B0',
    completed: '#4CAF50',
    on_hold: '#607D8B'
  };

  const MAX_FORM_FILES = 10;
  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  const state = { projects: [], selectedProject: null, library: [], members: [], isAdmin: false, trackerAddCommentFiles: [] };

  function byId(id) {
    return document.getElementById(id);
  }

  function getFirebaseService() {
    try {
      // A frame owns the SDK/service pair that creates its Firestore/Auth objects.
      // Wait for that local service instead of racing a parent-realm constructor.
      if (window.firebaseService)
        return window.firebaseService;
      if (window.self !== window.top) {
        for (const w of [window.parent, window.top].filter(Boolean)) {
          if (w !== window && w.firebaseService && w.firebaseService.isInitialized)
            return w.firebaseService;
        }
      }
    } catch (_) {}
    return window.firebaseService;
  }

  // Must use the same Firebase SDK that created fs.db - never mix instances (fails in iframe)
  function getFirebaseApi(fs) {
    fs = fs || getFirebaseService();
    if (fs?.firebase && typeof fs.firebase.collection === 'function') return fs.firebase;
    try {
      if (window.self !== window.top && window.parent?.firebaseService === fs && window.parent?.firebase?.collection) return window.parent.firebase;
      if (window.firebaseService === fs && window.firebase?.collection) return window.firebase;
    } catch (_) {}
    return null;
  }

  function getChatUrl(connId) {
    try {
      const loc = window.location;
      const path = loc.pathname.replace(/project-tracker\/[^?]*/, 'secure-chat/index.html');
      return loc.origin + path + '?connId=' + encodeURIComponent(connId);
    } catch (_) {}
    return '#';
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function showMain() {
    byId('tracker-detail').classList.add('hidden');
    byId('tracker-main').classList.remove('hidden');
    byId('tracker-loading').classList.add('hidden');
  }

  function showDetail() {
    byId('tracker-main').classList.add('hidden');
    byId('tracker-detail').classList.remove('hidden');
    byId('tracker-loading').classList.add('hidden');
  }

  function showLoading() {
    byId('tracker-main').classList.add('hidden');
    byId('tracker-detail').classList.add('hidden');
    byId('tracker-loading').classList.remove('hidden');
  }

  const STATUS_TIMELINE = ['submitted', 'initializing', 'in_progress', 'review', 'completed'];

  function renderStatusBadge(status, color) {
    const c = color || STATUS_COLORS[status] || '#6b7280';
    return `<span class="status-badge" style="background:${c}33;border:1px solid ${c}"><span style="background:${c};width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0"></span> ${escapeHtml(String(status || 'unknown').replace(/_/g, ' '))}</span>`;
  }

  function renderProgressBar(currentStatus) {
    const container = byId('tracker-progress-bar');
    const track = byId('progress-track');
    if (!container || !track) return;
    const steps = container.querySelectorAll('.progress-step');
    const currentIndex = STATUS_TIMELINE.indexOf(currentStatus);
    const isOnHold = currentStatus === 'on_hold';
    const isLastStep = currentIndex === STATUS_TIMELINE.length - 1;
    const fillPct = isOnHold || currentIndex < 0 ? 0 : isLastStep ? 100 : ((currentIndex + 0.5) / STATUS_TIMELINE.length) * 100;
    track.style.setProperty('--progress-fill', fillPct + '%');
    track.classList.toggle('is-completed', !isOnHold && isLastStep);
    steps.forEach((step) => {
      const stepStatus = step.dataset.step;
      const stepIndex = STATUS_TIMELINE.indexOf(stepStatus);
      const isPast = !isOnHold && stepIndex < currentIndex;
      const isCurrent = !isOnHold && stepIndex === currentIndex;
      step.classList.remove('past', 'current', 'future');
      if (isOnHold) {
        step.classList.add('future');
      } else if (isPast) {
        step.classList.add('past');
      } else if (isCurrent) {
        step.classList.add('current');
      } else {
        step.classList.add('future');
      }
    });
    container.classList.toggle('is-on-hold', isOnHold);
  }

  function renderProjects() {
    const grid = byId('projects-grid');
    const empty = byId('projects-empty');
    if (!grid) return;

    if (!state.projects.length) {
      grid.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }

    if (empty) empty.classList.add('hidden');
    grid.innerHTML = state.projects
      .map(
        (p) => `
      <div class="project-card" data-project-id="${escapeHtml(p.id)}">
        <h3>${escapeHtml(p.name || 'Untitled')}</h3>
        ${renderStatusBadge(p.status, p.statusColor)}
        ${p.description ? `<div class="project-desc">${escapeHtml(p.description.slice(0, 120))}${p.description.length > 120 ? '…' : ''}</div>` : ''}
      </div>`
      )
      .join('');

    grid.querySelectorAll('.project-card').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-project-id');
        openProject(id);
      });
    });
  }

  async function openProject(projectId) {
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;

    state.selectedProject = project;
    showDetail();

    byId('detail-title').textContent = project.name || 'Project';
    byId('detail-status').outerHTML = renderStatusBadge(project.status, project.statusColor);
    byId('detail-updated').textContent = project.updatedAt
      ? 'Updated ' + new Date(project.updatedAt).toLocaleDateString()
      : '';
    byId('detail-description').textContent = project.description || 'No description.';

    const chatLink = byId('detail-chat-link');
    chatLink.style.display = '';
    chatLink.href = '#';
    chatLink.onclick = async (e) => {
      e.preventDefault();
      const fs = getFirebaseService();
      if (!fs) return;
      try {
        const res = await fs.callFunction('ensureProjectChat', { projectId });
        const connId = res?.connId;
        if (!connId) { notify('Could not open project chat', 'error'); return; }
        const chatUrl = getChatUrl(connId);
        const host = window.parent && window.parent !== window ? window.parent : window.top || window;
        if (host?.appsManager && typeof host.appsManager.openAppInShell === 'function') {
          host.appsManager.openAppInShell({ id: 'secure-chat', name: 'Connections' }, chatUrl);
        } else {
          window.open(chatUrl, '_blank');
        }
        if (res?.repaired) state.projects.find((p) => p.id === projectId).chatConnId = connId;
      } catch (err) {
        notify(err?.message || 'Failed to open chat', 'error');
      }
    };

    const respondSec = byId('tracker-respond-section');
    const approveSec = byId('tracker-approve-section');
    const reviewSec = byId('tracker-review-section');
    if (respondSec) respondSec.classList.toggle('hidden', project.status !== 'submitted');
    if (approveSec) approveSec.classList.add('hidden');
    if (reviewSec) reviewSec.classList.toggle('hidden', project.status !== 'completed');

    renderProgressBar(project.status);

    const fs = getFirebaseService();
    const isOwner = fs?.auth?.currentUser?.uid === project.ownerId;
    const approveReviewEl = byId('tracker-approve-review-section');
    const awaitingOwner = project.status === 'in_progress' || project.status === 'review' || project.status === 'initializing';
    if (approveReviewEl) approveReviewEl.classList.toggle('hidden', !awaitingOwner || !isOwner);
    const membersSection = byId('members-section');
    if (membersSection) {
      if (isOwner) {
        membersSection.classList.remove('hidden');
        await loadMembers(projectId);
        renderMembers();
        bindMemberActions(projectId);
      } else {
        membersSection.classList.add('hidden');
      }
    }

    await loadLibrary(projectId);
    const activeFolder = byId('library-tabs')?.querySelector('.lib-tab.active')?.dataset?.folder || 'record_in';
    renderLibrary(activeFolder);
    const uploadWrap = byId('library-upload-wrap');
    if (uploadWrap) {
      uploadWrap.classList.toggle('hidden', state.isAdmin || activeFolder !== 'record_in');
    }
  }

  function notify(msg, type) {
    try {
      if (window.parent?.dashboardManager?.showNotification) {
        window.parent.dashboardManager.showNotification(msg, type || 'success');
      } else {
        alert(msg);
      }
    } catch (_) {
      alert(msg);
    }
  }

  async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function renderTrackerAddCommentFileList() {
    const list = byId('tracker-add-comment-file-list');
    if (!list) return;
    list.innerHTML = state.trackerAddCommentFiles.map((f, i) =>
      `<div class="project-form-file-item"><span>${escapeHtml(f.name)} (${(f.size / 1024).toFixed(1)} KB)</span><button type="button" class="project-form-file-item-remove" data-i="${i}" title="Remove">&times;</button></div>`
    ).join('');
    list.querySelectorAll('.project-form-file-item-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.trackerAddCommentFiles.splice(parseInt(btn.dataset.i, 10), 1);
        renderTrackerAddCommentFileList();
      });
    });
  }

  async function loadTrackerResponses(projectId) {
    const fs = getFirebaseService();
    const fb = getFirebaseApi();
    if (!fs?.db || !projectId || !fb?.collection) return [];
    try {
      const snap = await fb.getDocs(fb.collection(fs.db, 'projects', projectId, 'responses'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } catch (e) {
      console.warn('[Project Tracker] loadResponses failed', e);
      return [];
    }
  }

  function renderTrackerResponses(responses) {
    const list = byId('tracker-responses-list');
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
        const fb = getFirebaseApi();
        if (!fs?.storage || !fb?.ref) { notify('Storage not available', 'error'); return; }
        const fileName = (a.textContent || '').trim() || 'file';
        try {
          const r = fb.ref(fs.storage, path);
          const url = await fb.getDownloadURL(r);
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

  async function loadMembers(projectId) {
    const fs = getFirebaseService();
    if (!fs?.callFunction) {
      state.members = [];
      return;
    }
    try {
      const res = await fs.callFunction('getProjectMembers', { projectId });
      state.members = res?.members || [];
    } catch (e) {
      console.warn('[Project Tracker] loadMembers failed', e);
      state.members = [];
    }
  }

  function renderMembers() {
    const list = byId('members-list');
    if (!list) return;
    if (!state.members.length) {
      list.innerHTML = '<p class="members-empty-hint">No members yet. Enter an email above to add an existing user or invite a new one (they will receive an email with login details).</p>';
      return;
    }
    list.innerHTML = state.members
      .map(
        (m) => `
      <div class="member-row" data-uid="${escapeHtml(m.id)}">
        <span class="${m.isVerified ? 'verified-badge' : 'unverified-badge'}">${m.isVerified ? 'Verified' : 'Unverified'}</span>
        <span class="member-name">${escapeHtml(m.username || m.email || m.id)}</span>
        ${m.isOwner ? '<span class="owner-tag">(owner)</span>' : ''}
        ${m.isOwner ? '' : `<button type="button" class="member-remove" data-uid="${escapeHtml(m.id)}" title="Remove">Remove</button>`}
      </div>
    `
      )
      .join('');
  }

  function bindMemberActions(projectId) {
    const addBtn = byId('add-member-btn');
    const emailInput = byId('member-email');
    if (addBtn && emailInput) {
      addBtn.onclick = async () => {
        const email = (emailInput.value || '').trim();
        if (!email) return;
        addBtn.disabled = true;
        try {
          const fs = getFirebaseService();
          const res = await fs.callFunction('inviteProjectMemberByEmail', { projectId, email });
          if (res?.ok) {
            await loadMembers(projectId);
            renderMembers();
            emailInput.value = '';
            if (res.invited) {
              notify('Invitation sent. They will receive an email to join the project.');
            } else {
              notify(res.added ? 'Member added.' : 'User already a member.');
            }
          }
        } catch (e) {
          notify(e?.message || 'Failed to add member', 'error');
        } finally {
          addBtn.disabled = false;
        }
      };
    }
    byId('members-list')?.querySelectorAll('.member-remove').forEach((btn) => {
      btn.onclick = async () => {
        const uid = btn.getAttribute('data-uid');
        if (!uid) return;
        if (!confirm('Remove this member from the project?')) return;
        btn.disabled = true;
        try {
          const fs = getFirebaseService();
          const res = await fs.callFunction('removeProjectMember', { projectId, userId: uid });
          if (res?.ok) {
            await loadMembers(projectId);
            renderMembers();
            bindMemberActions(projectId);
            notify('Member removed.');
          }
        } catch (e) {
          notify(e?.message || 'Failed to remove member', 'error');
        } finally {
          btn.disabled = false;
        }
      };
    });
  }

  async function loadLibrary(projectId) {
    const fs = getFirebaseService();
    const fb = getFirebaseApi();
    if (!fs || !fs.db || !fb?.collection) {
      state.library = [];
      return;
    }

    try {
      const db = (fb.firestore && fs?.app) ? fb.firestore(fs.app) : fs.db;
      const libRef = fb.collection(db, 'projects', projectId, 'library');
      let snap;
      try {
        const q = fb.query ? fb.query(libRef, fb.orderBy('createdAt', 'desc')) : libRef;
        snap = await fb.getDocs(q);
      } catch (orderErr) {
        snap = await fb.getDocs(libRef);
      }
      const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.library = raw.sort((a, b) => {
        const ta = a?.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const tb = b?.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return tb - ta;
      });
    } catch (e) {
      console.warn('[Project Tracker] loadLibrary failed', e);
      state.library = [];
    }
  }

  function renderLibrary(folderPrefix) {
    const content = byId('library-content');
    const empty = byId('library-empty');
    if (!content) return;

    const files = state.library.filter((f) => {
      if (f.type !== 'file') return false;
      const fp = f.folderPath || (folderPrefix === 'record_in' ? 'record_in/docs' : 'record_out/docs');
      return fp.startsWith(folderPrefix);
    });
    const bySub = {};
    for (const f of files) {
      const fp = f.folderPath || (folderPrefix === 'record_in' ? 'record_in/docs' : 'record_out/docs');
      const sub = fp.replace(folderPrefix + '/', '').split('/')[0] || 'docs';
      if (!bySub[sub]) bySub[sub] = [];
      bySub[sub].push(f);
    }

    const subs = BASE_FOLDERS.filter((s) => bySub[s] && bySub[s].length);
    if (subs.length === 0 && Object.keys(bySub).length === 0) {
      content.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }

    if (empty) empty.classList.add('hidden');
    let html = '';
    const sortByCreatedAt = (a, b) => {
      const ts = (x) => x?.createdAt?.toMillis ? x.createdAt.toMillis() : (x.createdAt ? new Date(x.createdAt).getTime() : 0);
      return ts(b) - ts(a);
    };
    for (const sub of BASE_FOLDERS) {
      const list = (bySub[sub] || []).sort(sortByCreatedAt);
      const other = Object.entries(bySub).filter(([k]) => !BASE_FOLDERS.includes(k));
      const extras = sub === 'docs' ? other.flatMap(([, v]) => v).sort(sortByCreatedAt) : [];
      const all = [...list, ...extras];
      if (all.length === 0) continue;
      html += `<div class="lib-subfolder"><div class="lib-folder-label">${escapeHtml(sub)}</div>`;
      for (const f of all) {
        html += `<div class="lib-file-row"><i class="fas fa-file"></i><a href="#" data-storage-path="${escapeHtml(f.storagePath || '')}" target="_blank" rel="noopener">${escapeHtml(f.name || 'file')}</a></div>`;
      }
      html += '</div>';
    }
    content.innerHTML = html || '';

    content.querySelectorAll('a[data-storage-path]').forEach((a) => {
      const path = a.getAttribute('data-storage-path');
      if (!path) return;
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        const fs = getFirebaseService();
        const fb = getFirebaseApi();
        if (!fs || !fs.storage || !fb?.ref) return;
        try {
          const r = fb.ref(fs.storage, path);
          const url = await fb.getDownloadURL(r);
          window.open(url, '_blank', 'noopener');
        } catch (err) {
          console.warn('[Project Tracker] getDownloadURL failed', err);
        }
      });
    });
  }

  async function checkIsAdmin() {
    const fs = getFirebaseService();
    const fb = getFirebaseApi();
    const me = fs?.auth?.currentUser;
    if (!me || !fs?.db || !fb?.doc) return false;
    try {
      const userDoc = await fb.getDoc(fb.doc(fs.db, 'users', me.uid));
      return (userDoc?.data?.()?.role || '').toLowerCase() === 'admin';
    } catch (_) {}
    return false;
  }

  async function uploadToRecordIn(projectId, file) {
    const fs = getFirebaseService();
    const fb = getFirebaseApi();
    if (!fs?.storage || !fs?.db || !fb?.collection || !projectId || !file) return;
    const folder = getRecordInFolderByFile(file);
    const fname = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
    const storagePath = `projects/${projectId}/library/${folder}/${Date.now()}_${fname}`;
    const r = fb.ref(fs.storage, storagePath);
    await fb.uploadBytes(r, file, { contentType: file.type || 'application/octet-stream' });
    const libData = JSON.parse(JSON.stringify({
      folderPath: folder,
      name: fname,
      storagePath,
      type: 'file',
      createdAt: new Date().toISOString(),
      createdBy: fs.auth?.currentUser?.uid
    }));
    await fb.addDoc(fb.collection(fs.db, 'projects', projectId, 'library'), libData);
  }

  const LOAD_RETRY_MAX = 50;
  let _loadProjectsSeq = 0;

  async function loadProjects(retryCount = 0) {
    const loadSeq = ++_loadProjectsSeq;
    const fs = getFirebaseService();
    if (!fs || !fs.isInitialized || !fs.db) {
      showLoading();
      if (retryCount >= LOAD_RETRY_MAX) {
        const el = byId('tracker-loading');
        if (el) el.innerHTML = '<p>Firebase not ready. Please refresh the page or check your connection.</p>';
        return;
      }
      setTimeout(() => loadProjects(retryCount + 1), 300);
      return;
    }

    state.isAdmin = await checkIsAdmin();
    const user = fs.auth?.currentUser;
    if (!user) {
      const base = (window.location.pathname || '').replace(/\/apps\/project-tracker\/.*$/, '').replace(/\/$/, '') || '';
      let loginUrl = window.location.origin + (base ? base + '/' : '/') + 'index.html';
      try {
        const params = new URLSearchParams(window.location.search);
        const pid = params.get('projectId');
        if (pid) {
          sessionStorage.setItem('liber_return_project_id', pid);
          loginUrl += '?returnTo=tracker';
        }
      } catch (_) {}
      byId('tracker-loading').innerHTML = '<p>Please log in to view your projects.</p><p><a href="' + loginUrl + '" style="color:#3b82f6">Go to Login</a></p>';
      return;
    }

    const firebaseApi = getFirebaseApi(fs);
    if (!firebaseApi || typeof firebaseApi.collection !== 'function') {
      if (retryCount >= LOAD_RETRY_MAX) {
        byId('tracker-loading').innerHTML = '<p>Firebase SDK not ready. Please refresh the page.</p>';
        return;
      }
      setTimeout(() => loadProjects(retryCount + 1), 300);
      return;
    }
    const db = (firebaseApi.firestore && fs?.app) ? firebaseApi.firestore(fs.app) : fs.db;
    if (!db) {
      if (retryCount >= LOAD_RETRY_MAX) {
        byId('tracker-loading').innerHTML = '<p>Firebase not ready. Please refresh the page.</p>';
        return;
      }
      setTimeout(() => loadProjects(retryCount + 1), 300);
      return;
    }
    const projectsById = new Map();
    try {
      try {
        const qOwner = firebaseApi.query(
          firebaseApi.collection(db, 'projects'),
          firebaseApi.where('ownerId', '==', user.uid),
          firebaseApi.orderBy('updatedAt', 'desc'),
          firebaseApi.limit(50)
        );
        const snapOwner = await firebaseApi.getDocs(qOwner);
        snapOwner.docs.forEach((d) => projectsById.set(d.id, { id: d.id, ...d.data() }));
      } catch (e1) {
        console.warn('[Project Tracker] owner query failed', e1?.message || e1);
      }
      try {
        const qMember = firebaseApi.query(
          firebaseApi.collection(db, 'projects'),
          firebaseApi.where('memberIds', 'array-contains', user.uid),
          firebaseApi.orderBy('updatedAt', 'desc'),
          firebaseApi.limit(50)
        );
        const snapMember = await firebaseApi.getDocs(qMember);
        snapMember.docs.forEach((d) => projectsById.set(d.id, { id: d.id, ...d.data() }));
      } catch (e2) {
        console.warn('[Project Tracker] memberIds query failed', e2?.message || e2);
      }
      if (loadSeq !== _loadProjectsSeq) return;
      state.projects = Array.from(projectsById.values()).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      showMain();
      renderProjects();
      let projectToOpen = sessionStorage.getItem('liber_verify_project_id');
      if (projectToOpen) sessionStorage.removeItem('liber_verify_project_id');
      if (!projectToOpen) {
        try {
          const params = new URLSearchParams(window.location.search);
          projectToOpen = params.get('projectId') || null;
        } catch (_) {}
      }
      if (projectToOpen) {
        const hasProject = state.projects.some((p) => p.id === projectToOpen);
        if (hasProject) {
          setTimeout(() => openProject(projectToOpen), 300);
        }
      }
    } catch (e) {
      if (loadSeq !== _loadProjectsSeq) return;
      console.error('[Project Tracker] loadProjects failed', e);
      byId('tracker-loading').innerHTML = '<p>Failed to load projects. ' + (e?.message || '') + '</p>';
    }
  }

  function init() {
    const openQuiz = () => {
      if (typeof window.openRequestQuiz === 'function') {
        window.openRequestQuiz({ existingUser: true });
      } else {
        console.warn('[Project Tracker] openRequestQuiz not loaded');
      }
    };
    const makeRequestBtn = byId('make-request-btn');
    if (makeRequestBtn) makeRequestBtn.addEventListener('click', openQuiz);
    const makeRequestPanelBtn = byId('make-request-panel-btn');
    if (makeRequestPanelBtn) makeRequestPanelBtn.addEventListener('click', openQuiz);
    window.addEventListener('requestQuizSuccess', () => {
      if (state.projects !== null) loadProjects(0);
    });
    const backBtn = byId('back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (state.selectedProject) {
          state.selectedProject = null;
          showMain();
        } else {
          try {
            if (window.parent && window.parent !== window) {
              window.parent.postMessage({ type: 'liber:close-app-shell' }, '*');
            } else {
              const path = window.location.pathname || '';
              const base = path.replace(/\/apps\/project-tracker\/.*$/, '').replace(/\/$/, '') || '';
              window.location.href = window.location.origin + base + (base ? '/' : '') + 'index.html';
            }
          } catch (_) {}
        }
      });
    }

    byId('library-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.lib-tab');
      if (!tab) return;
      byId('library-tabs').querySelectorAll('.lib-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const folder = tab.dataset.folder;
      renderLibrary(folder);
      const uploadWrap = byId('library-upload-wrap');
      if (uploadWrap) uploadWrap.classList.toggle('hidden', state.isAdmin || folder !== 'record_in');
    });

    const libUploadZone = byId('library-upload-zone');
    const libUploadInput = byId('library-upload-input');
    if (libUploadZone && libUploadInput) {
      libUploadZone.addEventListener('dragover', (e) => { e.preventDefault(); libUploadZone.classList.add('dragover'); });
      libUploadZone.addEventListener('dragleave', () => libUploadZone.classList.remove('dragover'));
      libUploadZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        libUploadZone.classList.remove('dragover');
        const projectId = state.selectedProject?.id;
        if (!projectId || state.isAdmin) return;
        const flist = Array.from(e.dataTransfer?.files || []);
        for (const f of flist.slice(0, 10)) {
          try {
            await uploadToRecordIn(projectId, f);
            notify('Added ' + f.name);
          } catch (err) {
            notify('Failed: ' + f.name, 'error');
          }
        }
        await loadLibrary(projectId);
        renderLibrary(byId('library-tabs')?.querySelector('.lib-tab.active')?.dataset?.folder || 'record_in');
      });
      libUploadInput.addEventListener('change', async (e) => {
        const projectId = state.selectedProject?.id;
        if (!projectId || state.isAdmin) return;
        const flist = Array.from(e.target.files || []);
        e.target.value = '';
        for (const f of flist.slice(0, 10)) {
          try {
            await uploadToRecordIn(projectId, f);
            notify('Added ' + f.name);
          } catch (err) {
            notify('Failed: ' + f.name, 'error');
          }
        }
        await loadLibrary(projectId);
        renderLibrary(byId('library-tabs')?.querySelector('.lib-tab.active')?.dataset?.folder || 'record_in');
      });
    }

    byId('tracker-responses-toggle')?.addEventListener('click', async () => {
      const list = byId('tracker-responses-list');
      const icon = byId('tracker-responses-toggle')?.querySelector('i');
      if (list?.classList.toggle('hidden')) {
        if (icon) icon.className = 'fas fa-chevron-right';
      } else {
        if (icon) icon.className = 'fas fa-chevron-down';
        const projectId = state.selectedProject?.id;
        if (projectId) {
          const responses = await loadTrackerResponses(projectId);
          renderTrackerResponses(responses);
        }
      }
    });
    byId('tracker-approve-review-btn')?.addEventListener('click', async () => {
      const projectId = state.selectedProject?.id;
      if (!projectId) return;
      const fs = getFirebaseService();
      if (!fs) return;
      try {
        const res = await fs.callFunction('approveProject', { projectId });
        if (res === null || (res && res.ok !== true)) throw new Error('Approval failed');
        notify('Project completed.');
        await loadProjects();
        openProject(projectId);
      } catch (err) { notify(err?.message || 'Failed', 'error'); }
    });
    const addCommentUpload = byId('tracker-add-comment-upload');
    const addCommentFileInput = byId('tracker-add-comment-files');
    if (addCommentUpload && addCommentFileInput) {
      addCommentFileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        for (const f of files) {
          if (state.trackerAddCommentFiles.length >= MAX_FORM_FILES) break;
          if (f.size > MAX_FILE_SIZE) continue;
          const dup = state.trackerAddCommentFiles.some((x) => x.name === f.name && x.size === f.size);
          if (!dup) state.trackerAddCommentFiles.push(f);
        }
        renderTrackerAddCommentFileList();
      });
    }
    byId('tracker-add-comment-btn')?.addEventListener('click', async () => {
      const projectId = state.selectedProject?.id;
      if (!projectId) return;
      const fs = getFirebaseService();
      const me = fs?.auth?.currentUser?.uid;
      if (!me) return;
      const message = (byId('tracker-add-comment-message')?.value || '').trim();
      const base64Files = [];
      for (let i = 0; i < Math.min(state.trackerAddCommentFiles.length, MAX_FORM_FILES); i++) {
        const f = state.trackerAddCommentFiles[i];
        const b64 = await fileToBase64(f);
        base64Files.push({ name: f.name, data: b64, type: f.type });
      }
      if (!message && base64Files.length === 0) {
        notify('Enter a message or attach files', 'error');
        return;
      }
      try {
        const res = await fs.callFunction('sendProjectRespondEmail', { projectId, message, base64Files });
        if (res === null) throw new Error('Failed to add comment (401 or network error). Are you logged in?');
        if (res && res.ok !== true) throw new Error(res?.message || 'Add comment failed');
        notify('Comment added. Admin will respond.');
        state.trackerAddCommentFiles = [];
        renderTrackerAddCommentFileList();
        byId('tracker-add-comment-message').value = '';
        await loadProjects();
        openProject(projectId);
        const responses = await loadTrackerResponses(projectId);
        renderTrackerResponses(responses);
      } catch (err) { notify(err?.message || 'Failed', 'error'); }
    });
    byId('tracker-review-submit')?.addEventListener('click', async () => {
      const projectId = state.selectedProject?.id;
      if (!projectId) return;
      const fs = getFirebaseService();
      const me = fs?.auth?.currentUser?.uid;
      const text = (byId('tracker-review-input')?.value || '').trim();
      if (!me || !text) return;
      try {
        let userName = 'User';
        if (fs.getUserData) {
          try {
            const ud = await fs.getUserData(me);
            userName = String(ud?.username || ud?.email || '').trim() || 'User';
          } catch (_) {}
        }
        if (typeof fs.callFunction === 'function') {
          await fs.callFunction('submitProjectReview', { projectId, text, userName });
        } else {
          const fb = getFirebaseApi();
          if (!fb?.addDoc) return;
          const reviewData = { projectId: String(projectId), userId: String(me), userName: String(userName), text: String(text), createdAt: new Date().toISOString() };
          const reviewsCol = fb.collection(fs.db, 'projects', projectId, 'reviews');
          const projectReviewsCol = fb.collection(fs.db, 'projectReviews');
          await fb.addDoc(reviewsCol, reviewData);
          await fb.addDoc(projectReviewsCol, reviewData);
        }
        notify('Thank you for your review! Refresh the main page to see it.');
        const inp = byId('tracker-review-input');
        if (inp) inp.value = '';
      } catch (err) { notify(err?.message || 'Failed to submit', 'error'); }
    });

    const TRYLOAD_MAX = 100;
    let tryLoadCount = 0;
    const tryLoad = () => {
      const fs = getFirebaseService();
      if (fs && fs.isInitialized) {
        loadProjects();
      } else if (tryLoadCount >= TRYLOAD_MAX) {
        const el = byId('tracker-loading');
        if (el) el.innerHTML = '<p>Firebase not ready. Please refresh the page or check your connection.</p>';
      } else {
        tryLoadCount++;
        setTimeout(tryLoad, 200);
      }
    };
    tryLoad();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
