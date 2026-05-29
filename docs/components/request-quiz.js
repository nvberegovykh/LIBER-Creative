(function () {
  'use strict';

  const MAX_FILES = 10;
  const MAX_FILE_SIZE = 5 * 1024 * 1024;

  let overlay = null;
  let files = [];
  let existingUserMode = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function createOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'request-quiz-overlay';
    overlay.innerHTML = `
      <div class="request-quiz-modal">
        <div class="request-quiz-header">
          <h2>Make a Request</h2>
          <button type="button" class="request-quiz-close" aria-label="Close">&times;</button>
        </div>
        <div class="request-quiz-body">
          <form id="request-quiz-form">
            <div class="rq-field">
              <label for="rq-description">Describe your project *</label>
              <textarea id="rq-description" required placeholder="Tell us about your project..."></textarea>
            </div>
            <div class="rq-field">
              <label>Upload files</label>
              <div class="rq-upload-zone" id="rq-upload-zone" tabindex="0">
                <input type="file" id="rq-file-input" multiple accept="image/*,video/*,application/pdf,text/*,.doc,.docx,.xls,.xlsx,.csv" />
                <div class="rq-upload-icon">📁</div>
                <div>Drag & drop files here or click to browse</div>
                <div style="font-size:12px;margin-top:4px;opacity:0.8">Paste (Ctrl+V) to add images</div>
              </div>
              <div class="rq-file-list" id="rq-file-list"></div>
            </div>
            <div class="rq-field rq-field-name">
              <label for="rq-name">Name *</label>
              <input type="text" id="rq-name" required placeholder="Your name" />
            </div>
            <div class="rq-field">
              <label for="rq-phone">Phone number (optional)</label>
              <input type="tel" id="rq-phone" placeholder="+1 234 567 8900" />
            </div>
            <div class="rq-field rq-field-email">
              <label for="rq-email">Email *</label>
              <input type="email" id="rq-email" required placeholder="your@email.com" />
              <div class="rq-note rq-note-email">Liber Apps account will be created using this email. Please check your inbox to log in. The letter may appear in your spam folder.</div>
            </div>
            <button type="submit" class="request-quiz-submit" id="rq-submit">Submit Request</button>
          </form>
          <div id="rq-success" class="rq-success" style="display:none">
            <div class="rq-success-icon">✓</div>
            <p><strong>Request submitted!</strong></p>
            <p>Check your email for a link to log in and access your project tracker. The letter may appear in your spam folder.</p>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.request-quiz-close').addEventListener('click', closeQuiz);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeQuiz(); });

    const zone = overlay.querySelector('#rq-upload-zone');
    const input = overlay.querySelector('#rq-file-input');
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      addFiles(Array.from(e.dataTransfer.files || []));
    });
    document.addEventListener('paste', onPaste);
    input.addEventListener('change', (e) => {
      addFiles(Array.from(e.target.files || []));
      e.target.value = '';
    });

    overlay.querySelector('#request-quiz-form').addEventListener('submit', onSubmit);
    return overlay;
  }

  function onPaste(e) {
    if (!overlay || !overlay.querySelector('.request-quiz-modal')?.parentElement?.isConnected) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const toAdd = [];
    for (let i = 0; i < items.length; i++) {
      if ((items[i].type || '').indexOf('image') !== -1) {
        const f = items[i].getAsFile();
        if (f) toAdd.push(f);
      }
    }
    if (toAdd.length) {
      e.preventDefault();
      addFiles(toAdd);
    }
  }

  function addFiles(newFiles) {
    for (const f of newFiles) {
      if (files.length >= MAX_FILES) break;
      if (f.size > MAX_FILE_SIZE) continue;
      const dup = files.some((x) => x.name === f.name && x.size === f.size);
      if (!dup) files.push(f);
    }
    renderFileList();
  }

  function renderFileList() {
    const list = overlay?.querySelector('#rq-file-list');
    if (!list) return;
    list.innerHTML = files.map((f, i) => `<div class="rq-file-item"><span>${escapeHtml(f.name)} (${(f.size/1024).toFixed(1)} KB)</span><button type="button" class="rq-file-item-remove" data-i="${i}">&times;</button></div>`).join('');
    list.querySelectorAll('.rq-file-item-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        files.splice(parseInt(btn.dataset.i, 10), 1);
        renderFileList();
      });
    });
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function closeQuiz() {
    document.removeEventListener('paste', onPaste);
    if (overlay) overlay.remove();
    overlay = null;
    files = [];
  }

  async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = overlay.querySelector('#request-quiz-form');
    const submitBtn = overlay.querySelector('#rq-submit');
    let name = overlay.querySelector('#rq-name').value.trim();
    let email = overlay.querySelector('#rq-email').value.trim();
    const phone = overlay.querySelector('#rq-phone').value.trim();
    const description = overlay.querySelector('#rq-description').value.trim();

    if (existingUserMode) {
      const fs = window.firebaseService || (window.parent && window.parent.firebaseService);
      const user = fs?.auth?.currentUser;
      if (!user || !user.email) {
        alert('You must be signed in to submit a request.');
        return;
      }
      email = (user.email || '').trim().toLowerCase();
      if (!name) {
        try {
          const data = (fs?.getUserData && await fs.getUserData(user.uid)) || {};
          name = data?.username || user.displayName || email.split('@')[0] || 'User';
        } catch (_) {
          name = user.displayName || email.split('@')[0] || 'User';
        }
      }
    }

    if (!name || !email || !description) {
      alert('Please fill in all required fields.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      const filesToConvert = Array.from(files).slice(0, MAX_FILES);
      const base64Results = await Promise.all(filesToConvert.map((f) => fileToBase64(f)));
      const base64Files = base64Results.map((b64, i) => ({
        name: filesToConvert[i].name,
        data: b64,
        type: filesToConvert[i].type
      }));

      const fs = window.firebaseService || window.parent?.firebaseService;
      const callFn = fs?.callFunction?.bind(fs);

      // Direct HTTP fallback when firebaseService is not available (e.g. opened from contact.html directly)
      async function submitDirect(data) {
        const regions = ['europe-west1', 'us-central1'];
        let lastErr;
        for (const region of regions) {
          try {
            const res = await fetch(`https://${region}-liber-apps-cca20.cloudfunctions.net/submitProjectRequestHttp`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json?.error || json?.message || 'Submission failed');
            return json;
          } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('Submission failed. Please try again or email us directly.');
      }

      const result = callFn
        ? await callFn('submitProjectRequest', {
            name, email, phone, description, base64Files
          })
        : await submitDirect({ name, email, phone, description, base64Files });

      const data = result?.data ?? result;
      if (data?.ok) {
        form.style.display = 'none';
        const successEl = overlay.querySelector('#rq-success');
        const successP = successEl?.querySelector('p:last-of-type');
        if (existingUserMode) {
          if (successP) successP.textContent = 'Request submitted. Your new project will appear in the list.';
          if (successEl) successEl.style.display = '';
          try {
            window.dispatchEvent(new CustomEvent('requestQuizSuccess'));
            if (window.parent && window.parent !== window) window.parent.dispatchEvent(new CustomEvent('requestQuizSuccess'));
          } catch (_) {}
        } else if (data.existingUser) {
          if (successP) successP.textContent = 'Check your email for a link to sign in and open your project tracker. The letter may appear in your spam folder.';
          if (successEl) successEl.style.display = '';
        } else {
          if (successP) successP.textContent = 'Check your email for a link to log in and access your project tracker. The letter may appear in your spam folder.';
          if (successEl) successEl.style.display = '';
        }
      } else {
        throw new Error(data?.message || 'Submission failed');
      }
    } catch (err) {
      if (window.__devLog) window.__devLog('[Request Quiz] Submission failed:', err);
      alert(err?.message || 'Failed to submit. Please try again or email us directly.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Request';
    }
  }

  function openQuiz(opts) {
    existingUserMode = !!(opts && opts.existingUser);
    createOverlay();
    files = [];
    overlay.querySelector('#request-quiz-form').style.display = '';
    overlay.querySelector('#rq-success').style.display = 'none';
    overlay.querySelector('#rq-name').value = '';
    overlay.querySelector('#rq-email').value = '';
    overlay.querySelector('#rq-phone').value = '';
    overlay.querySelector('#rq-description').value = '';
    const nameField = overlay.querySelector('.rq-field-name');
    const emailField = overlay.querySelector('.rq-field-email');
    if (nameField) nameField.style.display = existingUserMode ? 'none' : '';
    if (emailField) emailField.style.display = existingUserMode ? 'none' : '';
    if (existingUserMode) {
      overlay.querySelector('#rq-name').removeAttribute('required');
      overlay.querySelector('#rq-email').removeAttribute('required');
    } else {
      overlay.querySelector('#rq-name').setAttribute('required', 'required');
      overlay.querySelector('#rq-email').setAttribute('required', 'required');
    }
    renderFileList();
  }

  window.openRequestQuiz = openQuiz;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="open-request-quiz"]');
    if (btn) {
      e.preventDefault();
      openQuiz();
    }
  });
})();
