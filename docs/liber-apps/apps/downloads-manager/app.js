(function () {
  'use strict';

  const COLLECTION = 'downloads';
  const PLATFORM_ORDER = ['windows', 'macos', 'android', 'ios', 'linux', 'web', 'other'];
  const state = { editId: '' };

  function byId(id) {
    return document.getElementById(id);
  }

  function notify(msg, type) {
    if (window.parent && window.parent.dashboardManager) {
      window.parent.dashboardManager.showNotification(msg, type || 'success');
    } else {
      alert(msg);
    }
  }

  function getFirebaseService() {
    if (window.firebaseService && window.firebaseService.isInitialized) return window.firebaseService;
    try {
      for (const w of [window.parent, window.top].filter(Boolean)) {
        if (w !== window && w.firebaseService && w.firebaseService.isInitialized) return w.firebaseService;
      }
    } catch (_) {}
    return window.firebaseService;
  }

  function fb() {
    const fs = getFirebaseService();
    return (fs && fs.firebase) ? fs.firebase : (typeof firebase !== 'undefined' ? firebase : window.firebase);
  }

  function normalizePlatform(v) {
    const p = String(v || '').trim().toLowerCase();
    if (PLATFORM_ORDER.includes(p)) return p;
    return 'other';
  }

  function detectPlatform(url, fileName) {
    const hay = `${String(url || '').toLowerCase()} ${String(fileName || '').toLowerCase()}`;
    if (/\bwindows\b|\.exe\b|\.msi\b/.test(hay)) return 'windows';
    if (/\bmac\b|macos|osx|\.dmg\b|\.pkg\b/.test(hay)) return 'macos';
    if (/\bandroid\b|\.apk\b|play\.google\.com/.test(hay)) return 'android';
    if (/\bios\b|iphone|ipad|apps\.apple\.com/.test(hay)) return 'ios';
    if (/\blinux\b|\.deb\b|\.rpm\b|\.appimage\b|\.tar\.gz\b/.test(hay)) return 'linux';
    if (/chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com/.test(hay)) return 'web';
    return 'other';
  }

  function parseDownloadMeta(rawUrl) {
    const url = String(rawUrl || '').trim();
    let host = '';
    let path = '';
    let tag = '';
    let fileName = '';
    let versionNumber = '';
    let versionName = '';

    try {
      const u = new URL(url);
      host = String(u.hostname || '').toLowerCase();
      path = String(u.pathname || '');
      const segments = path.split('/').filter(Boolean);
      fileName = decodeURIComponent(segments[segments.length - 1] || '');


      const match = /(?:^|[^a-z0-9])(v?\d+\.\d+\.\d+(?:[-._][a-z0-9]+)*)/i.exec(`${fileName} ${tag} ${path}`);
      versionNumber = match ? match[1].replace(/_/g, '.') : '';
      if (fileName) {
        versionName = fileName.replace(/\.[a-z0-9]{1,6}$/i, '');
      } else if (tag) {
        versionName = tag;
      } else if (versionNumber) {
        versionName = `Release ${versionNumber}`;
      } else {
        versionName = host || 'Download';
      }
    } catch (_) {
      fileName = '';
      versionName = 'Download';
    }

    const source = host.includes('play.google.com')
      ? 'Google Play'
      : host.includes('apps.apple.com')
      ? 'App Store'
      : host
      ? host.replace(/^www\./, '')
      : 'External';

    const platform = detectPlatform(url, fileName);
    return { versionName, versionNumber, tag, fileName, source, platform };
  }


  function isApprovedCloudDownloadUrl(rawUrl) {
    try {
      const u = new URL(String(rawUrl || '').trim());
      if (u.protocol !== 'https:') return false;
      const host = String(u.hostname || '').toLowerCase();
      return host === 'liberpict.com'
        || host.endsWith('.liberpict.com')
        || host === 'storage.googleapis.com'
        || host === 'firebasestorage.googleapis.com'
        || host === 'play.google.com'
        || host === 'apps.apple.com';
    } catch (_) { return false; }
  }

  function isLegacyReleaseAuthorityUrl(rawUrl) {
    try {
      const host = String(new URL(String(rawUrl || '').trim()).hostname || '').toLowerCase();
      return host.includes('github') || host === ['g', 'hcr.io'].join('');
    } catch (_) { return false; }
  }

  function isLegacyReleaseAuthorityRow(row) {
    const source = String(row?.source || '').trim().toLowerCase();
    const repo = String(row?.githubRepo || '').trim();
    return Boolean(repo) || source === 'github' || isLegacyReleaseAuthorityUrl(row?.directUrl);
  }

  function extractVersionNumber(input) {
    const m = /(?:^|[^a-z0-9])(v?\d+(?:\.\d+){1,3}(?:[-._][a-z0-9]+)*)/i.exec(String(input || ''));
    return m ? m[1].replace(/_/g, '.') : '';
  }

  function decodeBase64Utf8(b64) {
    try {
      const normalized = String(b64 || '').replace(/\s/g, '');
      const bin = atob(normalized);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (_) {
      return '';
    }
  }

  function stripMarkdown(md) {
    const s = String(md || '');
    return s
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\r/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }


  async function maybeAutoRefreshGithubRows(rows) {
    const all = Array.isArray(rows) ? rows : [];
    return all.filter((row) => !isLegacyReleaseAuthorityRow(row));
  }

  // Raw load without auto-refresh to avoid recursion
  async function loadRowsRaw() {
    const fs = getFirebaseService();
    if (!fs?.db) return [];
    try {
      const q = fb().query(
        fb().collection(fs.db, COLLECTION),
        fb().orderBy('updatedAt', 'desc'),
        fb().limit(400)
      );
      const snap = await fb().getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) {
      const snap = await fb().getDocs(fb().collection(fs.db, COLLECTION));
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    }
  }

  async function ensureAdmin() {
    try {
      const parent = window.parent || window.top;
      // Wait briefly for parent dashboard to finish its updateNavigation()
      if (parent && parent !== window) {
        let waited = 0;
        while (waited < 4000) {
          if (parent.dashboardManager?._isAdminSession === true) return true;
          await new Promise((r) => setTimeout(r, 100));
          waited += 100;
        }
        // updateNavigation may have set it to false (non-admin user) — respect that
        if (parent.dashboardManager && '_isAdminSession' in parent.dashboardManager) {
          if (parent.dashboardManager._isAdminSession === true) return true;
        }
        if (parent.authManager?.isAdmin?.()) return true;
      }
    } catch (_) {}
    // Fallback: use parent's Firebase service if available (avoids re-init in iframe)
    const fs = getFirebaseService();
    const me = fs?.auth?.currentUser;
    if (!me || !fs?.db) return false;
    try {
      const userDoc = await fb().getDoc(fb().doc(fs.db, 'users', me.uid));
      const docExists = typeof userDoc?.exists === 'function' ? userDoc.exists() : !!userDoc?.exists;
      const role = docExists ? (userDoc.data()?.role || 'user') : 'user';
      return String(role).toLowerCase() === 'admin';
    } catch (_) {
      return false;
    }
  }

  function formatDate(v) {
    const d = v?.toDate ? v.toDate() : new Date(v || Date.now());
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString();
  }

  function platformLabel(platform) {
    const p = normalizePlatform(platform);
    if (p === 'macos') return 'Mac OS';
    if (p === 'ios') return 'iOS';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  async function loadRows() {
    const rows = await loadRowsRaw();
    return maybeAutoRefreshGithubRows(rows);
  }

  function composeDescription(row, source, fileName) {
    const value = String(row?.description || row?.readmeDescription || row?.repoDescription || row?.releaseDescription || '').trim();
    if (value) return value;
    const repo = String(row?.githubRepo || '').trim();
    if (repo) return `Latest release from ${repo}`;
    return `${source || 'Direct'} download item: ${fileName || 'file'}`;
  }

  function renderRows(rows) {
    const empty = byId('downloads-empty');
    const wrap = byId('downloads-table-wrap');
    const body = byId('downloads-table-body');
    const cardsWrap = byId('downloads-cards-wrap');
    if (!body || !empty || !wrap || !cardsWrap) return;
    if (!rows.length) {
      empty.classList.remove('hidden');
      wrap.classList.add('hidden');
      cardsWrap.classList.add('hidden');
      body.innerHTML = '';
      cardsWrap.innerHTML = '';
      return;
    }
    empty.classList.add('hidden');
    wrap.classList.remove('hidden');
    cardsWrap.classList.remove('hidden');

    const viewRows = rows
      .map((r) => {
        const meta = parseDownloadMeta(r.directUrl || '');
        const versionName = String(r.versionName || meta.versionName || '-');
        const version = String(r.version || r.tag || meta.tag || r.versionNumber || meta.versionNumber || '-');
        const source = String(r.source || meta.source || '-');
        const fileName = String(r.fileName || meta.fileName || '-');
        const description = composeDescription(r, source, fileName);
        const platform = normalizePlatform(r.platform || meta.platform);
        const updated = formatDate(r.updatedAt || r.createdAt);
        return { r, versionName, version, source, fileName, description, platform, updated };
      });

    body.innerHTML = viewRows
      .map((r) => {
        return `
          <tr class="download-main-row">
            <td>${escapeHtml(r.versionName)}</td>
            <td>${escapeHtml(r.version)}</td>
            <td><span class="platform-pill">${escapeHtml(platformLabel(r.platform))}</span></td>
            <td>${escapeHtml(r.source)}</td>
            <td class="filename-cell" title="${escapeHtml(r.fileName)}">${escapeHtml(r.fileName)}</td>
            <td>${escapeHtml(r.updated)}</td>
            <td class="row-actions">
              <button type="button" class="icon-btn" data-open="${escapeHtml(r.r.directUrl || '')}" data-file="${escapeHtml(r.fileName)}" title="Download"><i class="fas fa-download"></i></button>
              <button type="button" class="icon-btn" data-edit="${escapeHtml(r.r.id)}" title="Edit"><i class="fas fa-pen"></i></button>
              <button type="button" class="icon-btn" data-delete="${escapeHtml(r.r.id)}" title="Delete"><i class="fas fa-trash"></i></button>
            </td>
          </tr>
          <tr class="download-sub-row">
            <td colspan="7">
              <div class="download-subline">
                <span class="download-sub-label">Description</span>
                <span class="download-sub-value">${escapeHtml(r.description)}</span>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    cardsWrap.innerHTML = viewRows.map((row) => `
      <article class="download-card">
        <div class="download-card-head">
          <h4 title="${escapeHtml(row.versionName)}">${escapeHtml(row.versionName)}</h4>
          <span class="platform-pill">${escapeHtml(platformLabel(row.platform))}</span>
        </div>
        <div class="download-card-grid">
          <div><span>Version</span><strong>${escapeHtml(row.version)}</strong></div>
          <div><span>Source</span><strong>${escapeHtml(row.source)}</strong></div>
          <div><span>Filename</span><strong title="${escapeHtml(row.fileName)}">${escapeHtml(row.fileName)}</strong></div>
          <div><span>Updated</span><strong>${escapeHtml(row.updated)}</strong></div>
        </div>
        <p class="download-card-description">${escapeHtml(row.description)}</p>
        <div class="download-card-actions">
          <button type="button" class="icon-btn" data-open="${escapeHtml(row.r.directUrl || '')}" data-file="${escapeHtml(row.fileName)}" title="Download"><i class="fas fa-download"></i></button>
          <button type="button" class="icon-btn" data-edit="${escapeHtml(row.r.id)}" title="Edit"><i class="fas fa-pen"></i></button>
          <button type="button" class="icon-btn" data-delete="${escapeHtml(row.r.id)}" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </article>
    `).join('');

    document.querySelectorAll('#downloads-table-body [data-open], #downloads-cards-wrap [data-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-open');
        const fileName = btn.getAttribute('data-file') || 'download';
        if (url) triggerDirectDownload(url, fileName);
      });
    });
    document.querySelectorAll('#downloads-table-body [data-delete], #downloads-cards-wrap [data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete');
        if (!id) return;
        if (!confirm('Delete this download link?')) return;
        try {
          const fs = getFirebaseService();
          await fb().deleteDoc(fb().doc(fs.db, COLLECTION, id));
          notify('Link removed');
          renderRows(await loadRows());
        } catch (e) {
          notify(e?.message || 'Failed to delete', 'error');
        }
      });
    });
    document.querySelectorAll('#downloads-table-body [data-edit], #downloads-cards-wrap [data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-edit');
        const row = rows.find((x) => String(x.id) === String(id));
        if (!row) return;
        setEditMode(row);
        byId('download-url')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        byId('download-url')?.focus();
      });
    });
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s || '');
    return d.innerHTML;
  }

  function triggerDirectDownload(url, fileName) {
    const a = document.createElement('a');
    a.href = String(url || '');
    a.download = String(fileName || 'download').trim() || 'download';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function setEditMode(row) {
    const submitBtn = byId('download-submit-btn');
    const cancelBtn = byId('download-cancel-edit');
    if (!submitBtn || !cancelBtn) return;
    if (!row) {
      state.editId = '';
      submitBtn.innerHTML = '<i class="fas fa-plus"></i> Add link';
      cancelBtn.classList.add('hidden');
      return;
    }
    state.editId = String(row.id || '');
    byId('download-url').value = String(row.directUrl || '');
    byId('download-name').value = String(row.versionName || '');
    byId('download-platform').value = normalizePlatform(row.platform || 'auto');
    submitBtn.innerHTML = '<i class="fas fa-save"></i> Save changes';
    cancelBtn.classList.remove('hidden');
  }

  async function addDownload(e) {
    e.preventDefault();
    const fs = getFirebaseService();
    if (!fs?.db) return;
    const me = fs.auth?.currentUser;
    if (!me) return notify('Please log in', 'error');

    const url = String(byId('download-url')?.value || '').trim();
    const platformInput = String(byId('download-platform')?.value || 'auto').trim();
    const customName = String(byId('download-name')?.value || '').trim();
    if (!url) return notify('Direct link is required', 'error');
    if (!isApprovedCloudDownloadUrl(url)) return notify('Cloud recovery accepts only LIBER/GCP or approved app-store download hosts.', 'error');

    const meta = parseDownloadMeta(url);
    const platform = platformInput === 'auto' ? meta.platform : normalizePlatform(platformInput);
    const now = new Date().toISOString();

    if (state.editId) {
      try {
        const updatePayload = {
          directUrl: url,
          platform,
          versionName: customName || meta.versionName || '',
          versionNumber: meta.versionNumber || '',
          version: meta.tag || meta.versionNumber || '',
          tag: meta.tag || '',
          fileName: meta.fileName || '',
          source: meta.source || '',
          updatedAt: now
        };
        await fb().updateDoc(fb().doc(fs.db, COLLECTION, state.editId), updatePayload);
        byId('download-form')?.reset();
        setEditMode(null);
        notify('Download link updated');
        renderRows(await loadRows());
        return;
      } catch (err) {
        notify(err?.message || 'Failed to update download', 'error');
        return;
      }
    }

    const payload = {
      directUrl: url,
      platform,
      versionName: customName || meta.versionName || '',
      versionNumber: meta.versionNumber || '',
      version: meta.tag || meta.versionNumber || '',
      tag: meta.tag || '',
      fileName: meta.fileName || '',
      source: meta.source || '',
      repoDescription: '',
      releaseDescription: '',
      description: '',
      createdAt: now,
      updatedAt: now,
      createdBy: me.uid
    };

    try {
      await fb().addDoc(fb().collection(fs.db, COLLECTION), payload);
      byId('download-form')?.reset();
      setEditMode(null);
      notify('Download link added');
      renderRows(await loadRows());
    } catch (err) {
      notify(err?.message || 'Failed to add download', 'error');
    }
  }

  function showDenied(message) {
    const app = document.querySelector('.downloads-manager-app');
    if (!app) return;
    app.innerHTML = `
      <header class="downloads-header">
        <h1><i class="fas fa-download"></i> Downloads Manager</h1>
      </header>
      <section class="panel">
        <p style="color:#ef4444;margin:0 0 12px 0">${escapeHtml(message)}</p>
        <button id="back-btn" class="btn btn-secondary"><i class="fas fa-arrow-left"></i> Back</button>
      </section>
    `;
    byId('back-btn')?.addEventListener('click', backToDashboard);
  }

  function backToDashboard() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'liber:close-app-shell' }, '*');
      }
    } catch (_) {}
  }

  async function ensureFirebaseReady() {
    let attempts = 0;
    while (attempts < 150) {
      const svc = getFirebaseService();
      if (svc && svc.isInitialized) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts += 1;
    }
    throw new Error('Firebase failed to initialize in time');
  }

  async function init() {
    byId('back-btn')?.addEventListener('click', backToDashboard);
    try {
      await ensureFirebaseReady();
    } catch (e) {
      showDenied('Could not connect to the database. Please refresh and try again.');
      return;
    }
    const ok = await ensureAdmin();
    if (!ok) {
      showDenied('Downloads Manager is for administrators only.');
      return;
    }
    byId('download-form')?.addEventListener('submit', addDownload);
    byId('download-cancel-edit')?.addEventListener('click', () => {
      byId('download-form')?.reset();
      setEditMode(null);
    });
    setEditMode(null);
    renderRows(await loadRows());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
