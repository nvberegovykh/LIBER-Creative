(function () {
  const ROTATION_MS = 20000;
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function visualItems(items) {
    return (items || []).filter((item) => item && (item.type === 'image' || item.type === 'video') && item.url);
  }

  function visualItemsForRotation(items) {
    return visualItems(items).filter((item) => !item.hideInPreview);
  }

  function textItems(items) {
    return (items || []).filter((item) => item && item.type === 'text' && item.text);
  }

  function suppressClickBriefly(ms) {
    const duration = Math.max(120, Number(ms) || 350);
    window.__gcSuppressClickUntil = Date.now() + duration;
  }

  function isClickSuppressed() {
    return Number(window.__gcSuppressClickUntil || 0) > Date.now();
  }

  async function loadFirebase() {
    if (window.__galleryFirebaseCtx) return window.__galleryFirebaseCtx;
    const [{ initializeApp }, firestoreMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js')
    ]);
    const { getFirestore, collection, getDocs, query, where, orderBy } = firestoreMod;
    let cfg = window.LIBER_FIREBASE_CONFIG || null;
    if (!cfg && window.secureKeyManager && typeof window.secureKeyManager.getKeys === 'function') {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const keys = await window.secureKeyManager.getKeys();
          cfg = keys && keys.firebase ? keys.firebase : null;
          if (cfg) break;
        } catch (_) {
          if (attempt === 2) cfg = null;
          else await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    if (!cfg || !cfg.apiKey || !cfg.projectId) {
      throw new Error('Gallery config unavailable');
    }
    const app = initializeApp(cfg, 'landing-gallery');
    const db = getFirestore(app);
    window.__galleryFirebaseCtx = { db, collection, getDocs, query, where, orderBy };
    return window.__galleryFirebaseCtx;
  }

  async function loadProjects() {
    const { db, collection, getDocs, query, where, orderBy } = await loadFirebase();
    const projectsCol = collection(db, 'galleryProjects');
    let projectSnap;
    try {
      projectSnap = await getDocs(query(projectsCol, where('isPublished', '==', true), orderBy('updatedAtTS', 'desc')));
    } catch (e) {
      try {
        projectSnap = await getDocs(query(projectsCol, where('isPublished', '==', true)));
      } catch (_) {
        throw e;
      }
    }

    const projects = [];
    for (const doc of projectSnap.docs) {
      const project = { id: doc.id, ...doc.data(), items: [] };
      let itemSnap;
      try {
        itemSnap = await getDocs(query(collection(db, 'galleryProjects', doc.id, 'items'), where('isPublished', '==', true), orderBy('sortOrder', 'asc')));
      } catch (_) {
        itemSnap = await getDocs(query(collection(db, 'galleryProjects', doc.id, 'items'), where('isPublished', '==', true)));
      }
      project.items = itemSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
      projects.push(project);
    }
    projects.sort((a, b) => {
      const at = (a.updatedAtTS && a.updatedAtTS.toMillis) ? a.updatedAtTS.toMillis() : new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bt = (b.updatedAtTS && b.updatedAtTS.toMillis) ? b.updatedAtTS.toMillis() : new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bt - at;
    });
    const withMedia = projects.filter((p) => {
      const v = visualItems(p.items || []);
      return v.length > 0;
    });
    if (withMedia.length < projects.length && projects.length > 0) {
      console.warn('[Gallery] Some projects have no published items with media:', projects.map((p) => ({ id: p.id, title: p.title, itemCount: (p.items || []).length, withUrl: (p.items || []).filter((i) => i && i.url).length })));
    }
    return withMedia;
  }

  function createMediaElement(item, mutedVideo) {
    if (!item || !item.url) return '';
    if (item.type === 'video') {
      return `<video src="${item.url}" data-fullscreen-media="1" ${mutedVideo ? 'muted autoplay loop playsinline' : 'controls playsinline'}></video>`;
    }
    return `<img src="${item.url}" data-fullscreen-image="1" alt="${item.caption || 'Gallery item'}" loading="lazy" />`;
  }

  function openVisualsFullscreen(visuals, startIndex) {
    const items = (visuals || []).map((v) => ({
      type: String(v && v.type || '').toLowerCase() === 'video' ? 'video' : 'image',
      url: String(v && v.url || ''),
      alt: String(v && (v.caption || v.title) || ''),
      title: String(v && (v.title || v.caption) || '')
    })).filter((v) => v.url);
    if (!items.length) return false;
    const idx = Math.max(0, Math.min((items.length - 1), Number(startIndex) || 0));
    const selected = items[idx] || items[0];
    if (selected && selected.type === 'video'){
      const player = window.LiberVideoPlayer;
      if (player && typeof player.open === 'function'){
        const videos = items.filter((it) => it.type === 'video');
        const vIdx = Math.max(0, videos.findIndex((it) => it.url === selected.url));
        const opened = player.open({ items: videos, startIndex: vIdx, source: 'landing' });
        if (opened && typeof opened.then === 'function'){
          opened.catch(()=>{});
          return true;
        }
        return opened === true;
      }
    }
    const viewer = window.LiberMediaFullscreenViewer;
    if (!viewer || typeof viewer.open !== 'function') return false;
    const images = items.filter((it)=> it.type !== 'video');
    if (!images.length) return false;
    const iIdx = Math.max(0, images.findIndex((it)=> it.url === selected.url));
    const opened = viewer.open({ items: images, startIndex: iIdx >= 0 ? iIdx : 0 });
    if (opened && typeof opened.then === 'function'){
      opened.catch(()=>{});
      return true;
    }
    return opened === true;
  }

  const SUBTYPES_BY_TYPE = {
    Architecture: ['Residential', 'Commercial', 'Manufacturing', 'Renovation'],
    'Web Development': ['Business', 'App'],
    Products: []
  };

  function buildCard(project, modeClass) {
    const forRotation = visualItemsForRotation(project.items);
    const first = forRotation[0] || visualItems(project.items)[0];
    if (!first) return '';
    const typeLabel = project.projectType ? (project.projectSubtype ? `${project.projectType} / ${project.projectSubtype}` : project.projectType) : '';
    const typeHtml = typeLabel ? `<span class="gc-card-type">${typeLabel}</span>` : '';
    return (
      `<article class="gc-card ${modeClass}" data-project-id="${project.id}" tabindex="0">` +
      `<div class="gc-media" data-rotation-index="0">${createMediaElement(first, true)}</div>` +
      `<div class="gc-overlay"><div>${typeHtml}<h3>${project.title || 'Project'}</h3><p>${project.year || ''}</p></div></div>` +
      '</article>'
    );
  }

  const INTRO_MS = 3000;
  function wireCardIntro(container) {
    const cards = Array.from(container.querySelectorAll('.gc-card[data-project-id]:not([data-gc-intro-done])'));
    if (!cards.length || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const card = entry.target;
          observer.unobserve(card);
          card.dataset.gcIntroDone = '1';
          card.classList.add('gc-intro');
          window.setTimeout(() => card.classList.remove('gc-intro'), INTRO_MS);
        });
      },
      { threshold: 0.1, rootMargin: '20px' }
    );
    cards.forEach((card) => observer.observe(card));
  }

  function wireRotations(container, projectById) {
    const cards = Array.from(container.querySelectorAll('.gc-card[data-project-id]:not([data-gc-rotation-wired])'));
    cards.forEach((card) => {
      card.dataset.gcRotationWired = '1';
      const id = card.getAttribute('data-project-id');
      const project = projectById.get(id);
      if (!project) return;
      const visuals = visualItemsForRotation(project.items);
      if (visuals.length < 2 || reducedMotion) return;
      let idx = 0;
      let timer = null;
      const mediaEl = card.querySelector('.gc-media');
      const rotate = () => {
        idx = (idx + 1) % visuals.length;
        card.classList.add('fade-swap');
        window.setTimeout(() => {
          mediaEl.innerHTML = createMediaElement(visuals[idx], true);
          mediaEl.setAttribute('data-rotation-index', String(idx));
          card.classList.remove('fade-swap');
          mediaEl.classList.add('gc-new-media');
          requestAnimationFrame(() => {
            requestAnimationFrame(() => mediaEl.classList.remove('gc-new-media'));
          });
        }, 320);
      };
      const start = () => {
        if (timer) return;
        timer = window.setInterval(rotate, ROTATION_MS);
      };
      const stop = () => {
        if (!timer) return;
        window.clearInterval(timer);
        timer = null;
      };
      card.addEventListener('mouseenter', stop);
      card.addEventListener('mouseleave', start);
      window.setTimeout(start, 400);
    });
  }

  function openPopup(project, allProjects, projectById) {
    let popup = document.getElementById('gc-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'gc-popup';
      popup.className = 'gc-popup';
      document.body.appendChild(popup);
    }
    const visuals = visualItems(project.items);
    const texts = textItems(project.items);
    let idx = 0;
    const dotsHtml = visuals.length > 1
      ? `<div class="gc-popup-dots" role="tablist">${visuals.map((_, i) => `<button type="button" class="gc-dot" data-gc-idx="${i}" aria-label="Slide ${i + 1}"></button>`).join('')}</div>`
      : '';
    const textsHtml = texts.map((t) => `<p>${t.text}</p>`).join('');
    const seeMoreProjects = pickRandomFromOtherSubtypes(project, allProjects || [], 6);
    const seeMoreHtml = seeMoreProjects.length > 0
      ? `<div class="gc-popup-seemore"><p class="gc-seemore-label">See More...</p><div class="gc-seemore-grid">${seeMoreProjects.map((p) => `<div class="gc-seemore-card" data-project-id="${p.id}" tabindex="0">${visualItems(p.items || [])[0] ? createMediaElement(visualItems(p.items || [])[0], true) : ''}<span>${p.title || 'Project'}</span></div>`).join('')}</div></div>`
      : '';
    const bodyHtml = `<div class="gc-popup-body"><h3>${project.title || 'Project'} ${project.year || ''}</h3><p>${project.description || ''}</p><div>${textsHtml}</div>${seeMoreHtml}</div>`;
    const slidesHtml = visuals.map((v) => `<div class="gc-popup-slide">${createMediaElement(v, false)}</div>`).join('');
    const isDesktop = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(min-width: 768px)').matches;
    const navBtnsHtml = (isDesktop && visuals.length > 1) ? `<button type="button" class="gc-popup-nav-btn gc-popup-prev" aria-label="Previous slide">` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>` +
      `<button type="button" class="gc-popup-nav-btn gc-popup-next" aria-label="Next slide">` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>` : '';
    popup.innerHTML =
      `<div class="gc-popup-card" role="dialog" aria-modal="true">` +
      `<div class="gc-popup-media">` +
      `<button class="gc-slider-btn gc-popup-close" data-gc-close="1">Close</button>` +
      navBtnsHtml +
      `<div class="gc-popup-track">${slidesHtml}</div>` +
      dotsHtml +
      `</div>` + bodyHtml + `</div>`;
    const mediaEl = popup.querySelector('.gc-popup-media');
    const track = popup.querySelector('.gc-popup-track');
    const dots = popup.querySelectorAll('.gc-popup-dots .gc-dot');
    const setIdx = (i) => {
      idx = Math.max(0, Math.min(i, visuals.length - 1));
      if (track) track.style.transform = `translateX(-${idx * 100}%)`;
      dots.forEach((d, j) => { d.classList.toggle('active', j === idx); d.setAttribute('aria-selected', j === idx); });
    };
    setIdx(0);
    const goPrev = () => setIdx(idx - 1);
    const goNext = () => setIdx(idx + 1);
    if (mediaEl && track && visuals.length > 1) {
      let startX = 0;
      let startY = 0;
      let startTs = 0;
      let lastX = 0;
      let lastT = 0;
      let startIdx = 0;
      let isHorizontalSwipe = null; /* null=undecided, true=swipe, false=scroll */
      const SLOPE = 0.5; /* vertical wins: |dx| > SLOPE*|dy| => horizontal, else scroll */
      const MOMENTUM_THRESHOLD = 0.4; /* px/ms - fast swipe overrides position threshold */
      const onStart = (x, y) => { startX = x; startY = y; startTs = Date.now(); lastX = x; lastT = startTs; startIdx = idx; isHorizontalSwipe = null; };
      const onMove = (x) => {
        lastX = x;
        lastT = Date.now();
        const w = mediaEl.offsetWidth || 400;
        const delta = (startX - x) / w;
        const raw = startIdx + delta;
        const clamped = Math.max(-0.2, Math.min(visuals.length - 1 + 0.2, raw));
        track.style.transition = 'none';
        track.style.transform = `translateX(-${clamped * 100}%)`;
      };
      const onEnd = (x) => {
        track.style.transition = 'transform 0.28s cubic-bezier(0.25, 0.1, 0.25, 1)';
        const w = mediaEl.offsetWidth || 400;
        const delta = startX - x;
        const dt = Math.max(10, Date.now() - startTs);
        const velocity = (x - lastX) / Math.max(10, Date.now() - lastT);
        let targetIdx = idx;
        if (Math.abs(velocity) > MOMENTUM_THRESHOLD) {
          targetIdx = velocity < 0 ? idx + 1 : idx - 1;
        } else if (Math.abs(delta) > w * 0.15) {
          targetIdx = delta > 0 ? idx + 1 : idx - 1;
        }
        setIdx(targetIdx);
      };
      mediaEl.addEventListener('mousedown', (e) => {
        onStart(e.clientX, e.clientY);
        const m = (ev) => onMove(ev.clientX);
        const cleanup = () => {
          document.removeEventListener('mousemove', m);
          document.removeEventListener('mouseup', u);
          window.removeEventListener('blur', cancelDrag);
          document.removeEventListener('visibilitychange', onVisibilityAbort);
        };
        const cancelDrag = () => {
          cleanup();
          setIdx(idx);
        };
        const onVisibilityAbort = () => {
          if (document.visibilityState === 'hidden') cancelDrag();
        };
        const u = (ev) => { cleanup(); onEnd(ev.clientX); };
        document.addEventListener('mousemove', m);
        document.addEventListener('mouseup', u);
        window.addEventListener('blur', cancelDrag);
        document.addEventListener('visibilitychange', onVisibilityAbort);
      });
      let touching = false;
      mediaEl.addEventListener('touchstart', (e) => {
        touching = true;
        const t = e.touches[0];
        onStart(t ? t.clientX : 0, t ? t.clientY : 0);
      }, { passive: true });
      mediaEl.addEventListener('touchmove', (e) => {
        if (!touching || !e.touches[0]) return;
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (isHorizontalSwipe === null) {
          isHorizontalSwipe = dx > SLOPE * dy;
        }
        if (isHorizontalSwipe) {
          onMove(t.clientX);
          e.preventDefault();
        }
      }, { passive: false });
      mediaEl.addEventListener('touchend', (e) => {
        if (touching && e.changedTouches && e.changedTouches[0]) {
          if (isHorizontalSwipe) onEnd(e.changedTouches[0].clientX);
          touching = false;
        }
      }, { passive: true });
      mediaEl.addEventListener('touchcancel', () => { touching = false; }, { passive: true });
    }
    dots.forEach((dot, i) => dot.addEventListener('click', (e) => { e.stopPropagation(); setIdx(i); }));
    popup.querySelectorAll('.gc-popup-slide img, .gc-popup-slide video').forEach((node, i) => {
      node.addEventListener('click', (e) => {
        if ((node instanceof HTMLVideoElement) && node.controls && node.getAttribute('data-fullscreen-media') !== '1') return;
        e.preventDefault();
        e.stopPropagation();
        openVisualsFullscreen(visuals, i);
      });
    });
    const prevBtn = popup.querySelector('.gc-popup-prev');
    const nextBtn = popup.querySelector('.gc-popup-next');
    if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); goPrev(); });
    if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); goNext(); });
    const keyHandler = (e) => {
      if (!popup || !popup.classList.contains('open')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', keyHandler);
    popup.querySelectorAll('.gc-seemore-card[data-project-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.getAttribute('data-project-id');
        const p = (projectById && projectById.get(id)) || (allProjects && allProjects.find((x) => x.id === id));
        if (p) openPopup(p, allProjects || [], projectById);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.click();
        }
      });
    });
    popup.classList.add('open');
    document.body.classList.add('gc-popup-open');
    const close = () => {
      document.removeEventListener('keydown', keyHandler);
      popup.classList.remove('open');
      document.body.classList.remove('gc-popup-open');
      popup.removeEventListener('click', handler);
    };
    const handler = (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.gcClose || target === popup) close();
    };
    popup.addEventListener('click', handler);
  }

  function wirePopupOpener(container, projectById, allProjects) {
    const openForProject = (project) => {
      if (project) openPopup(project, allProjects || [], projectById);
    };
    container.addEventListener('click', (e) => {
      if (isClickSuppressed()) return;
      const card = e.target.closest('.gc-card[data-project-id]');
      if (!card || !container.contains(card)) return;
      const id = card.getAttribute('data-project-id');
      const project = projectById.get(id);
      if (!project) return;
      e.preventDefault();
      e.stopPropagation();
      openForProject(project);
    });
    container.addEventListener('keydown', (e) => {
      const card = e.target.closest('.gc-card[data-project-id]');
      if (!card || !container.contains(card)) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const id = card.getAttribute('data-project-id');
      const project = projectById.get(id);
      if (!project) return;
      e.preventDefault();
      openForProject(project);
    });
  }

  function pickProjects(source, count) {
    const byId = new Map();
    source.forEach((p) => {
      if (visualItems(p.items || []).length > 0) byId.set(p.id, p);
    });
    if (!byId.size || count <= 0) return [];
    return shuffle([...byId.values()]).slice(0, count);
  }

  function projectsByType(projects) {
    const withMedia = projects.filter((p) => visualItems(p.items || []).length > 0);
    const byType = new Map();
    for (const p of withMedia) {
      const t = (p.projectType || '').trim() || 'Other';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(p);
    }
    return byType;
  }

  function projectsArchitectureOnly(projects) {
    return projects.filter((p) => (p.projectType || '').trim() === 'Architecture' && visualItems(p.items || []).length > 0);
  }

  function pickRandomFromOtherSubtypes(currentProject, allProjects, count) {
    const type = (currentProject.projectType || '').trim();
    const mySubtype = (currentProject.projectSubtype || '').trim();
    const subs = SUBTYPES_BY_TYPE[type] || [];
    if (!type || subs.length < 2) return pickProjects(allProjects.filter((p) => p.id !== currentProject.id), count);
    const sameType = allProjects.filter((p) => (p.projectType || '').trim() === type && p.id !== currentProject.id && visualItems(p.items || []).length > 0);
    const bySub = new Map();
    for (const p of sameType) {
      const s = (p.projectSubtype || '').trim() || '—';
      if (!bySub.has(s)) bySub.set(s, []);
      bySub.get(s).push(p);
    }
    const result = [];
    const otherSubs = subs.filter((s) => s !== mySubtype);
    let attempts = 0;
    while (result.length < count && attempts < 20) {
      for (const sub of shuffle(otherSubs)) {
        const arr = bySub.get(sub) || [];
        if (arr.length > 0) {
          const pick = arr[Math.floor(Math.random() * arr.length)];
          if (!result.find((r) => r.id === pick.id)) {
            result.push(pick);
            if (result.length >= count) break;
          }
        }
      }
      attempts++;
    }
    return result.slice(0, count);
  }

  function projectsByYear(projects) {
    const withMedia = projects.filter((p) => visualItems(p.items || []).length > 0);
    withMedia.sort((a, b) => {
      const ay = Number(a.year) || 0;
      const by = Number(b.year) || 0;
      return by - ay;
    });
    const groups = [];
    let lastYear = null;
    for (const p of withMedia) {
      const y = p.year != null && p.year !== '' ? String(p.year) : null;
      if (y !== lastYear) {
        lastYear = y;
        groups.push({ year: y || '—', projects: [] });
      }
      groups[groups.length - 1].projects.push(p);
    }
    return groups;
  }

  function mountTiles(host, projects, projectById) {
    const count = Number(host.dataset.cardCount || 999);
    const typeOrder = ['Architecture', 'Web Development', 'Products', 'Other'];
    const byType = projectsByType(projects);
    const typesWithCards = typeOrder.filter((t) => (byType.get(t) || []).length > 0);
    if (!typesWithCards.length) {
      host.innerHTML = '<div class="gc-template"><p class="gc-empty">No published gallery projects yet.</p></div>';
      return;
    }
    let activeType = typesWithCards[0];
    let activeSubtype = '';
    const getSubsForType = (t) => SUBTYPES_BY_TYPE[t] || [];
    const getProjectsForTab = (t, sub) => {
      const arr = byType.get(t) || [];
      if (!sub) return arr;
      return arr.filter((p) => (p.projectSubtype || '').trim() === sub);
    };
    let activeYear = null;
    let yearObserver = null;
    const renderGrid = () => {
      let projs = getProjectsForTab(activeType, activeSubtype);
      const searchQ = (host.querySelector('.gc-tile-search') || {}).value || '';
      if (searchQ.trim()) {
        const q = searchQ.trim().toLowerCase();
        projs = projs.filter((p) => {
          const title = (p.title || '').toLowerCase();
          const type = (p.projectType || '').toLowerCase();
          const sub = (p.projectSubtype || '').toLowerCase();
          return title.includes(q) || type.includes(q) || sub.includes(q);
        });
      }
      projs = projs.slice(0, count);
      const byYear = projectsByYear(projs);
      const selectedIds = new Set(projs.map((p) => p.id));
      const groupsLimited = byYear
        .map((g) => ({ year: g.year, projects: g.projects.filter((p) => selectedIds.has(p.id)) }))
        .filter((g) => g.projects.length > 0);
      const yearIds = groupsLimited.map((g, i) => `gc-year-${i}-${String(g.year).replace(/[^a-z0-9-]/gi, '_')}`);
      const html = groupsLimited
        .map(
          (g, i) =>
            `<div class="gc-year-sep" id="${yearIds[i]}" data-year="${g.year}" aria-hidden="true">${g.year}</div>` +
            g.projects.map((p) => buildCard(p, '')).join('')
        )
        .join('');
      const grid = host.querySelector('.gc-tile-grid');
      if (grid) grid.innerHTML = html || '<p class="gc-empty">No projects match.</p>';
      wireRotations(host, projectById);
      wireCardIntro(host);
      const years = groupsLimited.map((g) => g.year);
      if (years.length && (!activeYear || !years.includes(activeYear))) activeYear = years[0];
      updateYearDots(years);
      wireYearObserver();
    };
    const updateYearDots = (years) => {
      const wrapEl = host.querySelector('.gc-year-dots-wrap');
      const dotsEl = host.querySelector('.gc-year-dots');
      if (!wrapEl || !dotsEl) return;
      wrapEl.style.display = years.length > 1 ? '' : 'none';
      dotsEl.innerHTML = years.length > 0
        ? years.map((y) => {
            const isActive = y === activeYear;
            return `<div class="gc-year-dot-row"><span class="gc-year-current${isActive ? ' active' : ''}" data-year="${y}">${isActive ? y : ''}</span><button type="button" class="gc-year-dot ${isActive ? 'active' : ''}" data-year="${y}" aria-label="Scroll to ${y}"></button></div>`;
          }).join('')
        : '';
      dotsEl.querySelectorAll('.gc-year-dot').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const y = btn.getAttribute('data-year');
          activeYear = y;
          host.querySelectorAll('.gc-year-dot').forEach((d) => d.classList.toggle('active', d.getAttribute('data-year') === y));
          host.querySelectorAll('.gc-year-current').forEach((span) => {
            const yr = span.getAttribute('data-year');
            const isActive = yr === y;
            span.classList.toggle('active', isActive);
            span.textContent = isActive ? y : '';
          });
          const el = host.querySelector(`.gc-year-sep[data-year="${y}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
    };
    let syncYearDebounce = null;
    const syncYearDotsActive = () => {
      const seps = host.querySelectorAll('.gc-year-sep');
      if (!seps.length) return;
      const vh = window.innerHeight;
      const centerY = vh * 0.5;
      const candidates = Array.from(seps)
        .map((el) => {
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > vh) return null;
          const mid = (r.top + r.bottom) / 2;
          const dist = Math.abs(mid - centerY);
          return { year: el.getAttribute('data-year'), dist };
        })
        .filter((x) => x && x.year);
      if (!candidates.length) return;
      const best = candidates.reduce((a, b) => (a.dist <= b.dist ? a : b));
      const y = best.year;
      if (y === activeYear) return;
      activeYear = y;
      host.querySelectorAll('.gc-year-dot').forEach((d) => d.classList.toggle('active', d.getAttribute('data-year') === y));
      host.querySelectorAll('.gc-year-current').forEach((span) => {
        const yr = span.getAttribute('data-year');
        const isActive = yr === y;
        span.classList.toggle('active', isActive);
        span.textContent = isActive ? y : '';
      });
    };
    const scheduleSyncYear = () => {
      if (syncYearDebounce) clearTimeout(syncYearDebounce);
      syncYearDebounce = setTimeout(() => {
        syncYearDebounce = null;
        syncYearDotsActive();
      }, 120);
    };
    const wireYearObserver = () => {
      if (host._gcScrollCleanup) { host._gcScrollCleanup(); host._gcScrollCleanup = null; }
      if (yearObserver) { yearObserver.disconnect(); yearObserver = null; }
      const seps = host.querySelectorAll('.gc-year-sep');
      if (!seps.length || !('IntersectionObserver' in window)) return;
      yearObserver = new IntersectionObserver(scheduleSyncYear, { root: null, rootMargin: '0px', threshold: [0, 0.25, 0.5, 0.75, 1] });
      seps.forEach((s) => yearObserver.observe(s));
      const scrollEl = document.scrollingElement || document.documentElement;
      scrollEl.addEventListener('scroll', scheduleSyncYear, { passive: true });
      host._gcScrollCleanup = () => scrollEl.removeEventListener('scroll', scheduleSyncYear);
      requestAnimationFrame(() => syncYearDotsActive());
    };
    const subs = getSubsForType(activeType);
    const subsWithCards = subs.filter((s) => getProjectsForTab(activeType, s).length > 0);
    const showSubTabs = subsWithCards.length > 0;
    const typeTabsHtml = typesWithCards
      .map((t) => `<button type="button" class="gc-tab ${t === activeType ? 'active' : ''}" data-type="${t}">${t}</button>`)
      .join('');
    const subTabsHtml = `<div class="gc-subtabs" style="display:${showSubTabs ? '' : 'none'}">${showSubTabs ? `<button type="button" class="gc-subtab ${activeSubtype === '' ? 'active' : ''}" data-subtype="">All</button>` + subsWithCards.map((s) => `<button type="button" class="gc-subtab ${s === activeSubtype ? 'active' : ''}" data-subtype="${s}">${s}</button>`).join('') : ''}</div>`;
    const searchHtml = `<div class="gc-tile-search-wrap"><input type="text" class="gc-tile-search" placeholder="Search by name, type, subtype..." /></div>`;
    const yearDotsHtml = `<div class="gc-year-dots-wrap"><div class="gc-year-dots" aria-label="Year navigation"></div></div>`;
    let projs = getProjectsForTab(activeType, activeSubtype);
    const byYear = projectsByYear(projs.slice(0, count));
    const selectedIds = new Set(projs.slice(0, count).map((p) => p.id));
    const groupsLimited = byYear
      .map((g) => ({ year: g.year, projects: g.projects.filter((p) => selectedIds.has(p.id)) }))
      .filter((g) => g.projects.length > 0);
    const yearIds = groupsLimited.map((g, i) => `gc-year-${i}-${String(g.year).replace(/[^a-z0-9-]/gi, '_')}`);
    const gridHtml = groupsLimited
      .map(
        (g, i) =>
          `<div class="gc-year-sep" id="${yearIds[i]}" data-year="${g.year}" aria-hidden="true">${g.year}</div>` +
          g.projects.map((p) => buildCard(p, '')).join('')
      )
      .join('');
    host.innerHTML =
      `<div class="gc-template gc-tile-gallery">` +
      `<div class="gc-tile-gallery-inner">` +
      searchHtml +
      `<div class="gc-tabs">${typeTabsHtml}</div>` +
      subTabsHtml +
      `<div class="gc-tile-grid gc-grid">${gridHtml}</div>` +
      `</div>` +
      yearDotsHtml +
      `</div>`;
    host.querySelector('.gc-tile-search').addEventListener('input', () => renderGrid());
    host.querySelector('.gc-tile-search').addEventListener('keyup', (e) => { if (e.key === 'Enter') renderGrid(); });
    host.querySelectorAll('.gc-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeType = btn.getAttribute('data-type');
        activeSubtype = '';
        const subs2 = getSubsForType(activeType);
        const subsWithCards2 = subs2.filter((s) => getProjectsForTab(activeType, s).length > 0);
        const subTabsEl = host.querySelector('.gc-subtabs');
        if (subTabsEl) {
          subTabsEl.innerHTML = subsWithCards2.length > 0
            ? `<button type="button" class="gc-subtab active" data-subtype="">All</button>` + subsWithCards2.map((s) => `<button type="button" class="gc-subtab" data-subtype="${s}">${s}</button>`).join('')
            : '';
          subTabsEl.style.display = subsWithCards2.length > 0 ? '' : 'none';
          subTabsEl.querySelectorAll('.gc-subtab').forEach((b) => {
            b.addEventListener('click', () => {
              activeSubtype = b.getAttribute('data-subtype');
              subTabsEl.querySelectorAll('.gc-subtab').forEach((x) => x.classList.toggle('active', x === b));
              renderGrid();
            });
          });
        }
        host.querySelectorAll('.gc-tab').forEach((x) => x.classList.toggle('active', x === btn));
        renderGrid();
      });
    });
    host.querySelectorAll('.gc-subtab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeSubtype = btn.getAttribute('data-subtype');
        host.querySelectorAll('.gc-subtab').forEach((x) => x.classList.toggle('active', x === btn));
        renderGrid();
      });
    });
    const initialYears = groupsLimited.map((g) => g.year);
    if (initialYears.length) activeYear = initialYears[0];
    updateYearDots(initialYears);
    wireYearObserver();
    wireRotations(host, projectById);
    wireCardIntro(host);
    wirePopupOpener(host, projectById, projects);
  }

  const SINGLE_SLIDER_AUTO_MS = 30000;

  function mountSingleSlider(host, projects, projectById) {
    const archOnly = projectsArchitectureOnly(projects);
    const count = Number(host.dataset.cardCount || 9);
    let selected = pickProjects(archOnly, count);
    if (!selected.length) {
      host.innerHTML = '<div class="gc-template"><p class="gc-empty">No published gallery projects yet.</p></div>';
      return;
    }
    const renderTrack = (projs) => projs.map((p) => `<div class="gc-slide"><div class="gc-slide-inner">${buildCard(p, 'gc-card--slider')}</div></div>`).join('');
    host.innerHTML =
      `<div class="gc-template gc-single-slider">` +
      `<div class="gc-slider-shell gc-single-shell"><div class="gc-slider-track gc-single-track">${renderTrack(selected)}</div></div>` +
      `</div>`;
    const shell = host.querySelector('.gc-single-shell');
    const track = host.querySelector('.gc-single-track');
    let page = 0;
    let startX = 0;
    let startPage = 0;
    let didDrag = false;
    let autoTimer = null;
    const MAX_SLIDE_WIDTH = 2200;
    const appendQueue = () => {
      const more = pickProjects(archOnly, count);
      if (!more.length) return;
      selected = selected.concat(more);
      track.insertAdjacentHTML('beforeend', renderTrack(more));
      wireRotations(host, projectById);
      wireCardIntro(host);
    };
    const ensureQueueAhead = () => {
      if (page >= selected.length - 2) appendQueue();
    };
    const update = () => {
      page = Math.max(0, Math.min(page, selected.length - 1));
      const rawWidth = shell && shell.offsetWidth > 0 ? shell.offsetWidth : (typeof window !== 'undefined' ? Math.min(900, window.innerWidth || 900) : 600);
      const slideWidth = Math.min(MAX_SLIDE_WIDTH, rawWidth);
      track.style.width = `${selected.length * slideWidth}px`;
      track.querySelectorAll('.gc-slide').forEach((s) => { s.style.flex = `0 0 ${slideWidth}px`; s.style.minWidth = `${slideWidth}px`; s.style.maxWidth = `${slideWidth}px`; });
      track.style.transform = `translateX(-${page * slideWidth}px)`;
    };
    let startTs = 0;
    let lastX = 0;
    let lastT = 0;
    const MOMENTUM_THRESHOLD = 0.4;
    const onStart = (x) => { didDrag = false; startX = x; startTs = Date.now(); lastX = x; lastT = startTs; startPage = page; stopAutoAdvance(); };
    const onMove = (x) => {
      lastX = x;
      lastT = Date.now();
      if (Math.abs(x - startX) > 5) { didDrag = true; suppressClickBriefly(420); }
      const slideWidth = shell ? shell.offsetWidth : 400;
      const delta = startX - x;
      const pageOffset = delta / slideWidth;
      track.style.transition = 'none';
      track.style.transform = `translateX(-${(startPage + pageOffset) * slideWidth}px)`;
    };
    const startAutoAdvance = () => {
      stopAutoAdvance();
      autoTimer = setInterval(() => {
        ensureQueueAhead();
        page = Math.min(page + 1, selected.length - 1);
        update();
      }, SINGLE_SLIDER_AUTO_MS);
    };
    const stopAutoAdvance = () => {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    };
    const onEnd = (x) => {
      track.style.transition = 'transform 0.28s cubic-bezier(0.25, 0.1, 0.25, 1)';
      const slideWidth = shell ? shell.offsetWidth : 400;
      const delta = startX - x;
      const velocity = (x - lastX) / Math.max(10, Date.now() - lastT);
      let targetPage = startPage;
      if (Math.abs(velocity) > MOMENTUM_THRESHOLD) {
        targetPage = velocity < 0 ? startPage + 1 : startPage - 1;
      } else if (Math.abs(delta) > slideWidth * 0.2) {
        targetPage = delta > 0 ? startPage + 1 : startPage - 1;
      }
      if (targetPage > startPage) ensureQueueAhead();
      page = Math.max(0, Math.min(targetPage, selected.length - 1));
      update();
      startAutoAdvance();
    };
    let isHorizontalSwipe = null;
    const SLOPE = 0.5; /* vertical scroll wins over horizontal swipe */
    let startY = 0;
    const addDrag = (el) => {
      el.addEventListener('mousedown', (e) => {
        onStart(e.clientX);
        const m = (ev) => onMove(ev.clientX);
        const cleanup = () => {
          document.removeEventListener('mousemove', m);
          document.removeEventListener('mouseup', u);
          window.removeEventListener('blur', cancelDrag);
          document.removeEventListener('visibilitychange', onVisibilityAbort);
        };
        const cancelDrag = () => {
          cleanup();
          onEnd(startX);
        };
        const onVisibilityAbort = () => {
          if (document.visibilityState === 'hidden') cancelDrag();
        };
        const u = (ev) => { cleanup(); onEnd(ev.clientX); };
        document.addEventListener('mousemove', m);
        document.addEventListener('mouseup', u);
        window.addEventListener('blur', cancelDrag);
        document.addEventListener('visibilitychange', onVisibilityAbort);
      });
      let touched = false;
      el.addEventListener('touchstart', (e) => {
        touched = true;
        const t = e.touches[0];
        if (t) { startY = t.clientY; onStart(t.clientX); }
        isHorizontalSwipe = null;
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        if (!touched || !e.touches[0]) return;
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (isHorizontalSwipe === null) isHorizontalSwipe = dx > SLOPE * dy;
        if (isHorizontalSwipe) {
          onMove(t.clientX);
          e.preventDefault();
        }
      }, { passive: false });
      el.addEventListener('touchend', (e) => {
        if (touched && e.changedTouches && e.changedTouches[0]) {
          if (isHorizontalSwipe) onEnd(e.changedTouches[0].clientX);
          else startAutoAdvance();
          touched = false;
        }
      }, { passive: true });
      el.addEventListener('touchcancel', () => { touched = false; }, { passive: true });
    };
    addDrag(shell);
    const ro = new ResizeObserver(update);
    if (shell) ro.observe(shell);
    update();
    requestAnimationFrame(() => requestAnimationFrame(update));
    startAutoAdvance();
    wireRotations(host, projectById);
    wireCardIntro(host);
    wirePopupOpener(host, projectById, projects);
  }

  function mountFullWidth(host, projects, projectById) {
    const archOnly = projectsArchitectureOnly(projects);
    const count = Number(host.dataset.cardCount || 10) || 999;
    const selected = pickProjects(archOnly, count);
    if (!selected.length) {
      host.innerHTML = '<div class="gc-template"><p class="gc-empty">No published gallery projects yet.</p></div>';
      return;
    }
    const noDuplicates = host.dataset.noDuplicates === 'true' || host.dataset.noDuplicates === '';
    const gap = 18;
    const cardWidth = 420 + gap;
    const MAX_CARDS = 28;
    const SHIFT_SIZE = 7;
    const pool = shuffle(selected.slice());
    let poolIndex = 0;
    const getVisibleCards = () => {
      const n = Math.min(MAX_CARDS, pool.length);
      const out = [];
      for (let i = 0; i < n; i++) out.push(pool[(poolIndex + i) % pool.length]);
      return out;
    };
    const renderTrack = () => getVisibleCards().map((p) => buildCard(p, 'gc-card--full')).join('');
    host.innerHTML = `<div class="gc-template gc-fullwrap"><div class="gc-full-track">${renderTrack()}</div></div>`;
    const wrap = host.querySelector('.gc-fullwrap');
    const track = host.querySelector('.gc-full-track');
    let offset = 0;
    let startX = 0;
    let startOffset = 0;
    let autoScrollId = null;
    const setWidth = () => Math.min(MAX_CARDS, pool.length) * cardWidth;
    const shiftRight = () => {
      if (pool.length <= MAX_CARDS) return;
      track.style.transition = 'none';
      poolIndex = (poolIndex + SHIFT_SIZE) % pool.length;
      offset = Math.max(0, offset - SHIFT_SIZE * cardWidth);
      track.innerHTML = renderTrack();
      wireRotations(host, projectById);
      wireCardIntro(host);
      requestAnimationFrame(() => { track.style.transition = ''; });
    };
    const shiftLeft = () => {
      if (pool.length <= MAX_CARDS) return;
      track.style.transition = 'none';
      poolIndex = (poolIndex - SHIFT_SIZE + pool.length * 2) % pool.length;
      offset += SHIFT_SIZE * cardWidth;
      track.innerHTML = renderTrack();
      wireRotations(host, projectById);
      wireCardIntro(host);
      requestAnimationFrame(() => { track.style.transition = ''; });
    };
    const cycleReset = () => {
      track.style.transition = 'none';
      poolIndex = 0;
      offset = 0;
      const shuffled = shuffle(pool.slice());
      pool.length = 0;
      pool.push(...shuffled);
      track.innerHTML = renderTrack();
      wireRotations(host, projectById);
      wireCardIntro(host);
      requestAnimationFrame(() => { track.style.transition = ''; });
    };
    const getViewW = () => wrap.offsetWidth || (typeof window !== 'undefined' ? window.innerWidth : 1200);
    const update = () => {
      const totalW = track.offsetWidth || setWidth();
      const viewW = getViewW();
      const maxO = Math.max(0, totalW - viewW);
      const shiftW = SHIFT_SIZE * cardWidth;
      const canShift = pool.length > MAX_CARDS;
      if (canShift && offset > maxO) shiftRight();
      else if (canShift && offset < 0) shiftLeft();
      else offset = Math.max(0, Math.min(offset, maxO));
      track.style.transform = `translateX(-${offset}px)`;
    };
    const onStart = (x) => {
      startX = x;
      startOffset = offset;
      if (autoScrollId) { cancelAnimationFrame(autoScrollId); autoScrollId = null; }
      track.style.transition = 'none';
    };
    const onMove = (x) => {
      if (Math.abs(x - startX) > 5) suppressClickBriefly(420);
      offset = startOffset + (startX - x);
      update();
    };
    const onEndRestoreTransition = () => { track.style.transition = ''; };
    const onEnd = () => { onEndRestoreTransition(); if (autoScrollId) return; startAutoScroll(); };
    let startY = 0;
    let isHorizontalSwipe = null;
    const SWIPE_SLOPE = 0.5; /* vertical scroll wins over horizontal swipe */
    const addDrag = (el) => {
      el.addEventListener('mousedown', (e) => {
        onStart(e.clientX);
        const m = (ev) => onMove(ev.clientX);
        const cleanup = () => {
          document.removeEventListener('mousemove', m);
          document.removeEventListener('mouseup', u);
          window.removeEventListener('blur', cancelDrag);
          document.removeEventListener('visibilitychange', onVisibilityAbort);
        };
        const cancelDrag = () => {
          cleanup();
          onEndRestoreTransition();
          if (!autoScrollId) startAutoScroll();
        };
        const onVisibilityAbort = () => {
          if (document.visibilityState === 'hidden') cancelDrag();
        };
        const u = () => { cleanup(); onEnd(); };
        document.addEventListener('mousemove', m);
        document.addEventListener('mouseup', u);
        window.addEventListener('blur', cancelDrag);
        document.addEventListener('visibilitychange', onVisibilityAbort);
      });
      let touching = false;
      el.addEventListener('touchstart', (e) => {
        touching = true;
        const t = e.touches[0];
        if (t) { startY = t.clientY; onStart(t.clientX); }
        isHorizontalSwipe = null;
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        if (!touching || !e.touches[0]) return;
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (isHorizontalSwipe === null) isHorizontalSwipe = dx > SWIPE_SLOPE * dy;
        if (isHorizontalSwipe) {
          onMove(t.clientX);
          e.preventDefault();
        }
      }, { passive: false });
      el.addEventListener('touchend', (e) => {
        if (touching && e.changedTouches && e.changedTouches[0]) {
          if (isHorizontalSwipe) onEnd();
          touching = false;
        }
      }, { passive: true });
      el.addEventListener('touchcancel', () => { touching = false; }, { passive: true });
    };
    addDrag(wrap);
    wrap.addEventListener('click', (e) => { if (e.target.closest('.gc-card')) return; e.preventDefault(); });
    const AUTO_PX_PER_MS = 0.016;
    const startAutoScroll = () => {
      let lastT = 0;
      const tick = (t) => {
        const viewW = getViewW();
        if (viewW > 0) {
          const dt = lastT ? Math.min(t - lastT, 100) : 16;
          lastT = t;
          const totalW = track.offsetWidth || setWidth();
          const maxO = Math.max(0, totalW - viewW);
          offset += AUTO_PX_PER_MS * dt;
          if (noDuplicates && maxO > 0 && offset >= maxO) cycleReset();
        }
        update();
        autoScrollId = requestAnimationFrame(tick);
      };
      autoScrollId = requestAnimationFrame(tick);
    };
    startAutoScroll();
    wireRotations(host, projectById);
    wireCardIntro(host);
    wirePopupOpener(host, projectById, projects);
    requestAnimationFrame(update);
    const ro = new ResizeObserver(() => update());
    ro.observe(wrap);
  }

  async function boot(opts) {
    const onGalleryMount = opts && typeof opts.onGalleryMount === 'function' ? opts.onGalleryMount : null;
    const hosts = Array.from(document.querySelectorAll('[data-gallery-template]'));
    if (!hosts.length) return;
    // Show skeleton loader while Firebase/Firestore loads
    hosts.forEach((host) => {
      if (!host.innerHTML.trim()) {
        host.innerHTML = '<div class="gc-skeleton-loader" aria-hidden="true">' +
          '<div class="gc-sk-row">' +
          '<div class="gc-sk-card"></div><div class="gc-sk-card"></div><div class="gc-sk-card"></div>' +
          '</div></div>';
      }
    });
    if (!document.getElementById('gc-skeleton-styles')) {
      const s = document.createElement('style');
      s.id = 'gc-skeleton-styles';
      s.textContent = '.gc-skeleton-loader{padding:24px 0}.gc-sk-row{display:flex;gap:16px;flex-wrap:wrap}.gc-sk-card{flex:1;min-width:220px;height:260px;border-radius:8px;background:linear-gradient(90deg,#1a1a1a 25%,#2a2a2a 50%,#1a1a1a 75%);background-size:200% 100%;animation:gc-shimmer 1.4s infinite}@keyframes gc-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}';
      document.head.appendChild(s);
    }
    try {
      const projects = await loadProjects();
      if (!projects.length) {
        console.warn('[Gallery] No published projects with media found. In Gallery Control: ensure the project has "Published" checked, each item has media (image/video with URL), and if you published after adding items, re-open the project in Edit mode and click Save to sync visibility to items.');
        hosts.forEach((host) => { host.innerHTML = '<div class="gc-template"><p class="gc-empty">No published gallery projects yet.</p></div>'; });
        return;
      }
      const projectById = new Map(projects.map((p) => [p.id, p]));
      hosts.forEach((host, index) => {
        const kind = host.getAttribute('data-gallery-template');
        if (kind === 'tile') mountTiles(host, projects, projectById);
        else if (kind === 'single-slider') mountSingleSlider(host, projects, projectById);
        else if (kind === 'full-width-slider') mountFullWidth(host, projects, projectById);
        if (onGalleryMount) onGalleryMount(index, kind);
      });
    } catch (err) {
      hosts.forEach((host) => { host.innerHTML = '<div class="gc-template">Gallery is temporarily unavailable.</div>'; });
      console.error(err);
    }
  }

  window.__gcBoot = boot;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
