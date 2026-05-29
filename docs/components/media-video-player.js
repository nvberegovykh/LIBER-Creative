(function(){
  if (window.LiberVideoPlayer) return;

  const state = {
    open: false,
    items: [],
    index: 0,
    source: 'app',
    overlay: null,
    shell: null,
    playerHost: null,
    recList: null,
    titleEl: null,
    authorEl: null,
    descEl: null,
    likeBtn: null,
    commentsBtn: null,
    authorBtn: null,
    authorRailBtn: null,
    shareBtn: null,
    viewsBtn: null,
    mobileMeta: null,
    theaterBtn: null,
    hideBtn: null,
    restoreBtn: null,
    uiHidden: false,
    holdTimer: null,
    touchStartTs: 0,
    verticalStartY: 0,
    verticalStartX: 0,
    verticalTouching: false,
    horizontalSwipe: null,
    swipeDeltaY: 0
  };
  const authorAvatarCache = new Map();
  const authorInfoCache = new Map();

  function clamp(v, min, max){
    return Math.max(min, Math.min(max, v));
  }

  function isMobile(){
    return window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
  }

  function normalizeItem(item){
    if (!item || !item.url) return null;
    return {
      id: String(item.id || item.url),
      type: 'video',
      url: String(item.url),
      title: String(item.title || item.alt || 'Video'),
      author: String(item.author || item.by || item.authorName || ''),
      description: String(item.description || ''),
      poster: String(item.poster || item.cover || item.thumbnailUrl || ''),
      sourceId: String(item.sourceId || item.id || ''),
      sourceType: String(item.sourceType || 'video'),
      likesCount: Number(item.likesCount || item.likes || 0) || 0,
      commentsCount: Number(item.commentsCount || item.comments || 0) || 0,
      viewsCount: Number(item.viewsCount || item.viewCount || 0) || 0,
      authorId: String(item.authorId || ''),
      authorAvatar: String(item.authorAvatar || item.avatarUrl || item.authorPhoto || '')
    };
  }

  function createEl(tag, className){
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  function close(){
    if (!state.open && !state.overlay?.classList.contains('minimized')) return;
    try{
      if (document.fullscreenElement || document.webkitFullscreenElement){
        document.exitFullscreen?.().catch?.(()=>{});
      }
    }catch(_){ }
    const v = getCurrentVideoNode();
    if (v){
      try{ v.pause(); }catch(_){ }
      try{ v.currentTime = 0; }catch(_){ }
    }
    if (state.playerHost) state.playerHost.innerHTML = '';
    if (state.restoreBtn) state.restoreBtn.remove();
    state.restoreBtn = null;
    state.open = false;
    if (state.overlay) state.overlay.classList.remove('minimized');
    if (state.overlay) state.overlay.classList.remove('open');
    if (state.overlay) state.overlay.classList.remove('lvp-native-fullscreen');
    if (state.overlay) state.overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lvp-open');
    syncFullscreenUi();
  }

  function hideToBackground(){
    if (!state.open || !state.overlay) return;
    state.open = false;
    state.overlay.classList.remove('open');
    state.overlay.classList.add('minimized');
    state.overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lvp-open');
    if (!state.restoreBtn){
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lvp-restore-btn';
      b.innerHTML = '<i class="fas fa-play"></i>';
      b.title = 'Show player';
      b.setAttribute('aria-label', 'Show player');
      b.addEventListener('click', ()=>{
        if (!state.overlay) return;
        state.overlay.classList.remove('minimized');
        state.overlay.classList.add('open');
        state.overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('lvp-open');
        state.open = true;
      });
      document.body.appendChild(b);
      state.restoreBtn = b;
    }
  }

  async function fetchRecommendations(current){
    try{
      if (!window.firebaseService || typeof window.firebaseService.getVideoRecommendations !== 'function') return [];
      const list = await window.firebaseService.getVideoRecommendations({
        source: state.source,
        sourceId: current?.sourceId || '',
        limit: 30
      });
      return Array.isArray(list) ? list.map(normalizeItem).filter(Boolean) : [];
    }catch(_){
      return [];
    }
  }

  function getCurrentVideoNode(){
    return state.playerHost ? state.playerHost.querySelector('video.lvp-video') : null;
  }

  function buildVideoNode(item){
    const v = document.createElement('video');
    v.className = 'lvp-video';
    v.src = item.url;
    if (item.poster) v.poster = item.poster;
    // Desktop: keep native controls. Mobile rail handles controls.
    v.controls = !isMobile();
    v.playsInline = true;
    v.autoplay = true;
    v.preload = 'metadata';
    v.addEventListener('error', ()=> {
      const host = v.closest('.lvp-video-host') || v.parentElement;
      if (host && v.parentElement === host) {
        const msg = document.createElement('div');
        msg.className = 'lvp-video-error';
        msg.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:rgba(255,255,255,.6);font-size:14px;text-align:center;padding:16px';
        msg.textContent = 'Video unavailable';
        host.replaceChild(msg, v);
      }
    });
    v.addEventListener('play', ()=> {
      try{
        window.firebaseService?.trackVideoInteraction?.({
          action: 'play',
          source: state.source,
          sourceId: item.sourceId,
          videoId: item.id
        });
      }catch(_){ }
    });
    v.addEventListener('timeupdate', ()=>{
      const pct = v.duration > 0 ? (v.currentTime / v.duration) : 0;
      try{
        window.firebaseService?.trackVideoInteraction?.({
          action: 'progress',
          source: state.source,
          sourceId: item.sourceId,
          videoId: item.id,
          watchRatio: Number(pct.toFixed(4))
        });
      }catch(_){ }
      const p = state.shell ? state.shell.querySelector('.lvp-progress-fill') : null;
      if (p) p.style.width = `${clamp(pct * 100, 0, 100)}%`;
    });
    return v;
  }

  function renderRecommendations(activeId){
    if (!state.recList) return;
    state.recList.innerHTML = '';
    state.items.forEach((item, idx)=>{
      const row = createEl('button', `lvp-rec-item${item.id === activeId ? ' active' : ''}`);
      row.type = 'button';
      const thumb = String(item.poster || '').trim();
      const thumbHtml = thumb ? `<img class="lvp-rec-thumb" src="${thumb.replace(/"/g,'&quot;')}" alt="">` : '<span class="lvp-rec-thumb lvp-rec-thumb-fallback"><i class="fas fa-play"></i></span>';
      row.innerHTML = `${thumbHtml}<span class="lvp-rec-meta"><span class="lvp-rec-title">${item.title.replace(/</g,'&lt;')}</span><span class="lvp-rec-author">${item.author.replace(/</g,'&lt;')}</span></span>`;
      row.addEventListener('click', ()=>{
        if (!state.open) return;
        setIndex(idx);
      });
      state.recList.appendChild(row);
    });
  }

  function escapeAttr(v){
    return String(v || '').replace(/"/g, '&quot;');
  }

  async function resolveAuthorAvatar(item){
    try{
      if (!item) return '';
      const own = String(item.authorAvatar || '').trim();
      if (own) return own;
      const uid = String(item.authorId || '').trim();
      if (!uid) return '';
      if (authorAvatarCache.has(uid)) return String(authorAvatarCache.get(uid) || '');
      const data = await window.firebaseService?.getUserData?.(uid);
      const url = String(data?.avatarUrl || '').trim();
      authorAvatarCache.set(uid, url);
      return url;
    }catch(_){
      return '';
    }
  }

  async function resolveAuthorInfo(item){
    try{
      if (!item) return { uid: '', avatar: '', name: String(item?.author || '') };
      const directUid = String(item.authorId || '').trim();
      const sourceId = String(item.sourceId || '').trim();
      const normUrl = String(item.url || '').trim();
      const cacheKey = directUid ? `uid:${directUid}` : (sourceId ? `sid:${sourceId}` : (normUrl ? `url:${normUrl}` : ''));
      if (cacheKey && authorInfoCache.has(cacheKey)) return authorInfoCache.get(cacheKey);
      const out = { uid: directUid, avatar: String(item.authorAvatar || '').trim(), name: String(item.author || '').trim() };
      if (out.uid && (!out.avatar || !out.name)){
        try{
          const u = await window.firebaseService?.getUserData?.(out.uid);
          out.avatar = out.avatar || String(u?.avatarUrl || '').trim();
          out.name = out.name || String(u?.username || u?.displayName || '').trim();
        }catch(_){ }
      }
      if (!out.uid && sourceId && window.firebaseService?.db){
        try{
          const readById = async (collectionName)=>{
            const snap = await firebase.getDoc(firebase.doc(window.firebaseService.db, collectionName, sourceId));
            if (!snap.exists()) return false;
            const v = snap.data() || {};
            out.uid = String(v.authorId || v.owner || v.originalAuthorId || v.ownerId || '').trim();
            out.avatar = out.avatar || String(v.authorAvatar || v.avatarUrl || '').trim();
            out.name = out.name || String(v.authorName || '').trim();
            return !!out.uid;
          };
          if (!(await readById('videos'))){
            await readById('wave');
          }
        }catch(_){ }
      }
      if (!out.uid && normUrl && window.firebaseService?.db){
        try{
          const readByUrl = async (collectionName)=>{
            const q = firebase.query(
              firebase.collection(window.firebaseService.db, collectionName),
              firebase.where('url', '==', normUrl),
              firebase.limit(1)
            );
            const s = await firebase.getDocs(q);
            if (s.empty) return false;
            const v = s.docs[0].data() || {};
            out.uid = String(v.authorId || v.owner || v.originalAuthorId || v.ownerId || '').trim();
            out.avatar = out.avatar || String(v.authorAvatar || v.avatarUrl || '').trim();
            out.name = out.name || String(v.authorName || '').trim();
            return !!out.uid;
          };
          if (!(await readByUrl('videos'))){
            await readByUrl('wave');
          }
        }catch(_){ }
      }
      if (out.uid && (!out.avatar || !out.name)){
        try{
          const u = await window.firebaseService?.getUserData?.(out.uid);
          out.avatar = out.avatar || String(u?.avatarUrl || '').trim();
          out.name = out.name || String(u?.username || u?.displayName || '').trim();
        }catch(_){ }
      }
      if (!out.avatar) out.avatar = await resolveAuthorAvatar({ ...item, authorId: out.uid || item.authorId, authorAvatar: out.avatar || item.authorAvatar });
      if (!out.name) out.name = String(item.author || '').trim();
      if (cacheKey) authorInfoCache.set(cacheKey, out);
      return out;
    }catch(_){
      return { uid: String(item?.authorId || '').trim(), avatar: String(item?.authorAvatar || '').trim(), name: String(item?.author || '').trim() };
    }
  }

  async function updateAuthorButtons(item){
    try{
      const info = await resolveAuthorInfo(item);
      const avatar = String(info?.avatar || '').trim();
      const title = String(info?.name || item?.author || 'Author').trim() || 'Author';
      if (item){
        item.authorId = String(info?.uid || item.authorId || '').trim();
        item.authorAvatar = avatar || String(item.authorAvatar || '');
        item.author = title || String(item.author || '');
      }
      const btnHtml = avatar
        ? `<img src="${escapeAttr(avatar)}" alt="${escapeAttr(title)}" class="lvp-author-avatar">`
        : '<i class="fas fa-user-circle"></i>';
      if (state.authorBtn){
        state.authorBtn.innerHTML = btnHtml;
        state.authorBtn.title = title;
        state.authorBtn.setAttribute('aria-label', title);
      }
      if (state.authorRailBtn){
        const iconHost = state.authorRailBtn.querySelector('i, img.lvp-author-avatar');
        if (iconHost){
          if (avatar){
            iconHost.outerHTML = `<img src="${escapeAttr(avatar)}" alt="${escapeAttr(title)}" class="lvp-author-avatar">`;
          }else{
            iconHost.outerHTML = '<i class="fas fa-user-circle"></i>';
          }
        }else{
          state.authorRailBtn.insertAdjacentHTML('afterbegin', btnHtml);
        }
        state.authorRailBtn.title = title;
        state.authorRailBtn.setAttribute('aria-label', title);
      }
    }catch(_){ }
  }

  function buildFallbackShareLink(current){
    try{
      const base = new URL(window.location.href);
      base.hash = '';
      base.search = '';
      if (!/\/[^/]+\.[a-z0-9]+$/i.test(base.pathname || '')){
        const clean = String(base.pathname || '').replace(/\/$/, '');
        base.pathname = `${clean || '/'}${clean ? '/' : ''}index.html`;
      }
      base.searchParams.set('open', 'wave');
      base.searchParams.set('type', 'video');
      const sid = String(current?.sourceId || current?.id || '').trim();
      const href = String(current?.url || '').trim();
      if (sid) base.searchParams.set('id', sid);
      if (!sid && href) base.searchParams.set('u', href);
      return base.toString();
    }catch(_){
      return String(current?.url || '').trim();
    }
  }

  async function shareExternally(current){
    const shareUrl = buildFallbackShareLink(current);
    const shareData = { title: current.title || 'Video', text: current.description || '', url: shareUrl };
    try{
      if (navigator.share) await navigator.share(shareData);
      else await navigator.clipboard?.writeText(shareUrl);
    }catch(_){ }
  }

  function openShareMenu(current){
    try{
      const old = document.getElementById('lvp-share-menu');
      if (old) old.remove();
      const layer = document.createElement('div');
      layer.id = 'lvp-share-menu';
      layer.style.cssText = 'position:fixed;inset:0;z-index:22080;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;padding:14px';
      layer.innerHTML = `
        <div style="width:min(96vw,440px);background:#0f1724;border:1px solid rgba(255,255,255,.16);border-radius:14px;padding:10px;display:grid;gap:8px">
          <div style="font-size:13px;opacity:.86;padding:2px 2px 4px">Share video</div>
          <button type="button" class="btn btn-secondary" data-share-chat><i class="fas fa-comments"></i> Share to chat</button>
          <button type="button" class="btn btn-secondary" data-share-external><i class="fas fa-arrow-up-right-from-square"></i> Share externally</button>
          <button type="button" class="btn btn-secondary" data-share-copy><i class="fas fa-link"></i> Copy link</button>
          <button type="button" class="btn btn-secondary" data-share-cancel>Cancel</button>
        </div>`;
      document.body.appendChild(layer);
      const close = ()=>{ try{ layer.remove(); }catch(_){ } };
      layer.addEventListener('click', (e)=>{ if (e.target === layer) close(); });
      layer.querySelector('[data-share-cancel]')?.addEventListener('click', close);
      layer.querySelector('[data-share-chat]')?.addEventListener('click', ()=>{
        try { window.dispatchEvent(new CustomEvent('liber-video-share-chat', { detail: current })); } catch (_) { }
        close();
      });
      layer.querySelector('[data-share-external]')?.addEventListener('click', async ()=>{
        const detail = (current && typeof current === 'object') ? current : {};
        try { window.dispatchEvent(new CustomEvent('liber-video-share-external', { detail })); } catch (_) { }
        if (!detail.__liberShareHandled) await shareExternally(current);
        close();
      });
      layer.querySelector('[data-share-copy]')?.addEventListener('click', async ()=>{
        const detail = (current && typeof current === 'object') ? current : {};
        try { window.dispatchEvent(new CustomEvent('liber-video-copy-link', { detail })); } catch (_) { }
        if (!detail.__liberShareHandled){
          try{ await navigator.clipboard?.writeText(String(buildFallbackShareLink(current) || '')); }catch(_){ }
        }
        close();
      });
    }catch(_){ }
  }

  function updateMeta(item){
    if (state.titleEl) state.titleEl.textContent = item.title || 'Video';
    if (state.authorEl) state.authorEl.textContent = item.author ? `by ${item.author}` : '';
    if (state.descEl) state.descEl.textContent = item.description || '';
    if (state.mobileMeta) {
      const t = state.mobileMeta.querySelector('.lvp-mobile-title');
      const a = state.mobileMeta.querySelector('.lvp-mobile-author');
      const d = state.mobileMeta.querySelector('.lvp-mobile-desc');
      if (t) t.textContent = item.title || 'Video';
      if (a) a.textContent = item.author ? `@${item.author}` : '';
      if (d) d.textContent = item.description || '';
    }
    updateAuthorButtons(item);
  }

  function getCurrentItem(){
    return state.items[state.index] || null;
  }

  async function refreshCurrentEngagementStats(){
    try{
      const current = getCurrentItem();
      if (!current) return;
      const dm = window.dashboardManager || window.top?.dashboardManager || window.parent?.dashboardManager;
      let likes = Number(current.likesCount || 0) || 0;
      let comments = Number(current.commentsCount || 0) || 0;
      let views = Number(current.viewsCount || 0) || 0;
      if (dm && typeof dm.getAssetAggregatedLikeCount === 'function'){
        try{ likes = Number(await dm.getAssetAggregatedLikeCount('video', current.url)) || likes; }catch(_){ }
      }
      if (dm && typeof dm.resolveAssetPostId === 'function' && window.firebaseService?.getPostStats){
        try{
          const pid = await dm.resolveAssetPostId({ kind: 'video', url: current.url, sourceId: current.sourceId, title: current.title });
          if (pid){
            const st = await window.firebaseService.getPostStats(pid);
            comments = Number(st?.comments || 0) || comments;
            views = Number(st?.views || st?.viewCount || 0) || views;
          }
        }catch(_){ }
      }
      current.likesCount = likes;
      current.commentsCount = comments;
      current.viewsCount = views;
      if (state.viewsBtn){
        const c = state.viewsBtn.querySelector('.lvp-action-count');
        if (c) c.textContent = String(Math.max(0, Number(views || 0) || 0));
      }
      if (state.likeBtn){
        const c = state.likeBtn.querySelector('.lvp-action-count');
        if (c) c.textContent = String(Math.max(0, Number(likes || 0) || 0));
      }
      if (state.commentsBtn){
        const c = state.commentsBtn.querySelector('.lvp-action-count');
        if (c) c.textContent = String(Math.max(0, Number(comments || 0) || 0));
      }
      if (state.overlay){
        const railLike = state.overlay.querySelector('.lvp-mobile-rail .lvp-like .lvp-rail-count');
        const railComments = state.overlay.querySelector('.lvp-mobile-rail .lvp-comments .lvp-rail-count');
        if (railLike) railLike.textContent = String(Math.max(0, Number(likes || 0) || 0));
        if (railComments) railComments.textContent = String(Math.max(0, Number(comments || 0) || 0));
      }
      try{
        window.dispatchEvent(new CustomEvent('liber-video-engagement-sync', {
          detail: {
            kind: 'video',
            url: String(current.url || ''),
            sourceId: String(current.sourceId || ''),
            likesCount: Number(likes || 0) || 0,
            commentsCount: Number(comments || 0) || 0,
            viewsCount: Number(views || 0) || 0
          }
        }));
      }catch(_){ }
    }catch(_){ }
  }

  async function toggleCurrentLike(){
    try{
      const current = getCurrentItem();
      if (!current || !current.url) return;
      const dm = window.dashboardManager || window.top?.dashboardManager || window.parent?.dashboardManager;
      if (!dm || typeof dm.getAssetLikeKeys !== 'function' || !window.firebaseService?.db){
        return;
      }
      const me = await (window.firebaseService?.getCurrentUser?.() || Promise.resolve(window.firebaseService?.auth?.currentUser || null));
      if (!me || !me.uid) return;
      const keys = dm.getAssetLikeKeys('video', current.url) || [];
      const primary = keys[0];
      const refs = Array.from(new Set([primary, ...keys].filter(Boolean))).map((k)=> firebase.doc(window.firebaseService.db, 'assetLikes', k, 'likes', me.uid));
      if (!refs.length) return;
      let hasLike = false;
      for (const ref of refs){
        try{
          const s = await firebase.getDoc(ref);
          if (s.exists()){ hasLike = true; break; }
        }catch(_){ }
      }
      if (hasLike){
        await Promise.all(refs.map(async (ref)=>{ try{ await firebase.deleteDoc(ref); }catch(_){ } }));
        current.likesCount = Math.max(0, (Number(current.likesCount || 0) || 0) - 1);
      } else {
        await firebase.setDoc(refs[0], { uid: me.uid, createdAt: new Date().toISOString(), kind: 'video', url: current.url });
        current.likesCount = Math.max(0, (Number(current.likesCount || 0) || 0) + 1);
      }
      try{
        window.dispatchEvent(new CustomEvent('liber-video-engagement-sync', {
          detail: {
            kind: 'video',
            url: String(current.url || ''),
            sourceId: String(current.sourceId || ''),
            likesCount: Number(current.likesCount || 0) || 0,
            commentsCount: Number(current.commentsCount || 0) || 0,
            viewsCount: Number(current.viewsCount || 0) || 0
          }
        }));
      }catch(_){ }
      await refreshCurrentEngagementStats();
    }catch(_){ }
  }

  function toggleVideoFullscreen(){
    try{
      const v = getCurrentVideoNode();
      if (!v) return;
      if (document.fullscreenElement){
        document.exitFullscreen?.().catch?.(()=>{});
        return;
      }
      if (v.requestFullscreen){
        v.requestFullscreen().catch(()=>{});
      } else if (v.webkitEnterFullscreen){
        try{ v.webkitEnterFullscreen(); }catch(_){ }
      } else if (state.shell?.requestFullscreen){
        state.shell.requestFullscreen().catch(()=>{});
      }
    }catch(_){ }
  }

  function syncFullscreenUi(){
    try{
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
      const active = !!fsEl;
      if (state.overlay) state.overlay.classList.toggle('lvp-native-fullscreen', active);
      const rail = state.overlay?.querySelector('.lvp-mobile-rail .lvp-fullscreen');
      if (rail){
        rail.title = active ? 'Exit fullscreen' : 'Fullscreen';
        rail.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen');
      }
    }catch(_){ }
  }

  function animateSwipeTransition(nextItem, direction){
    return new Promise((resolve)=>{
      try{
        if (!state.playerHost) return resolve(false);
        const current = getCurrentVideoNode();
        if (!current) return resolve(false);
        const incoming = buildVideoNode(nextItem);
        incoming.controls = !isMobile();
        state.playerHost.style.position = 'relative';
        state.playerHost.style.overflow = 'hidden';
        current.style.position = 'absolute';
        current.style.inset = '0';
        incoming.style.position = 'absolute';
        incoming.style.inset = '0';
        const from = direction > 0 ? '100%' : '-100%';
        const out = direction > 0 ? '-100%' : '100%';
        incoming.style.transform = `translate3d(0, ${from}, 0)`;
        incoming.style.opacity = '1';
        incoming.style.transition = 'none';
        current.style.transition = 'none';
        state.playerHost.appendChild(incoming);
        requestAnimationFrame(()=>{
          const easing = 'cubic-bezier(.22,.75,.14,1)';
          incoming.style.transition = `transform .28s ${easing}`;
          current.style.transition = `transform .28s ${easing}, opacity .22s ease`;
          incoming.style.transform = 'translate3d(0,0,0)';
          current.style.transform = `translate3d(0, ${out}, 0)`;
          current.style.opacity = '.88';
          let finished = false;
          const done = ()=>{
            if (finished) return;
            finished = true;
            try{ current.pause(); }catch(_){ }
            try{ current.remove(); }catch(_){ }
            incoming.style.position = '';
            incoming.style.inset = '';
            incoming.style.transform = '';
            incoming.style.transition = '';
            incoming.style.opacity = '';
            resolve(true);
          };
          incoming.addEventListener('transitionend', done, { once: true });
          setTimeout(done, 360);
        });
      }catch(_){ resolve(false); }
    });
  }

  async function setIndex(next, opts = {}){
    if (!state.items.length) return;
    const prevIndex = Number(state.index || 0);
    state.index = clamp(next, 0, state.items.length - 1);
    const item = state.items[state.index];
    if (!item) return;
    if (state.playerHost){
      const current = getCurrentVideoNode();
      const directionRaw = Number(opts?.direction || 0);
      const direction = directionRaw || (state.index > prevIndex ? 1 : -1);
      const shouldSwipeAnimate = !!opts?.swipe && isMobile() && current && state.index !== prevIndex;
      if (shouldSwipeAnimate){
        current.style.transform = '';
        current.style.transition = '';
        await animateSwipeTransition(item, direction);
      } else {
        if (current){
          try{ current.pause(); }catch(_){ }
        }
        const nextVideo = buildVideoNode(item);
        nextVideo.controls = !isMobile();
        nextVideo.style.opacity = '0';
        nextVideo.style.transition = 'opacity .22s ease';
        state.playerHost.innerHTML = '';
        state.playerHost.appendChild(nextVideo);
        requestAnimationFrame(()=>{
          nextVideo.style.opacity = '1';
        });
      }
    }
    try{
      window.firebaseService?.trackVideoInteraction?.({
        action: 'open',
        source: state.source,
        sourceId: item.sourceId,
        videoId: item.id
      });
    }catch(_){ }
    item.viewsCount = Math.max(0, (Number(item.viewsCount || 0) || 0) + 1);
    try{
      window.dispatchEvent(new CustomEvent('liber-video-engagement-sync', {
        detail: {
          kind: 'video',
          url: String(item.url || ''),
          sourceId: String(item.sourceId || ''),
          likesCount: Number(item.likesCount || 0) || 0,
          commentsCount: Number(item.commentsCount || 0) || 0,
          viewsCount: Number(item.viewsCount || 0) || 0
        }
      }));
    }catch(_){ }
    updateMeta(item);
    if (state.likeBtn){
      const c = state.likeBtn.querySelector('.lvp-action-count');
      if (c) c.textContent = String(Math.max(0, Number(item.likesCount || 0) || 0));
    }
    if (state.commentsBtn){
      const c = state.commentsBtn.querySelector('.lvp-action-count');
      if (c) c.textContent = String(Math.max(0, Number(item.commentsCount || 0) || 0));
    }
    if (state.overlay){
      const railLike = state.overlay.querySelector('.lvp-mobile-rail .lvp-like .lvp-rail-count');
      const railComments = state.overlay.querySelector('.lvp-mobile-rail .lvp-comments .lvp-rail-count');
      if (railLike) railLike.textContent = String(Math.max(0, Number(item.likesCount || 0) || 0));
      if (railComments) railComments.textContent = String(Math.max(0, Number(item.commentsCount || 0) || 0));
    }
    if (state.viewsBtn){
      const c = state.viewsBtn.querySelector('.lvp-action-count');
      if (c) c.textContent = String(Math.max(0, Number(item.viewsCount || 0) || 0));
    }
    renderRecommendations(item.id);
    try{
      const recs = await fetchRecommendations(item);
      if (recs.length){
        const merged = [item].concat(recs.filter((r)=> r.id !== item.id));
        state.items = merged.slice(0, 50);
        renderRecommendations(item.id);
      }
    }catch(_){ }
    refreshCurrentEngagementStats();
  }

  function onWheel(e){
    if (!state.open || !isMobile()) return;
    if (Math.abs(e.deltaY) < 14) return;
    e.preventDefault();
    if (e.deltaY > 0) setIndex(state.index + 1, { swipe: true, direction: 1 });
    else setIndex(state.index - 1, { swipe: true, direction: -1 });
  }

  function onTouchStart(e){
    if (!state.open || !e.touches || !e.touches[0]) return;
    const t = e.touches[0];
    state.touchStartTs = Date.now();
    state.verticalStartY = t.clientY;
    state.verticalStartX = t.clientX;
    state.verticalTouching = true;
    state.horizontalSwipe = null;
    state.swipeDeltaY = 0;
    clearTimeout(state.holdTimer);
    state.holdTimer = setTimeout(()=>{
      state.uiHidden = true;
      if (state.shell) state.shell.classList.add('ui-hidden');
    }, 380);
  }

  function onTouchMove(e){
    if (!state.open || !state.verticalTouching || !e.touches || !e.touches[0]) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - state.verticalStartX);
    const dy = Math.abs(t.clientY - state.verticalStartY);
    if (state.horizontalSwipe === null) state.horizontalSwipe = dy > (dx * 1.2);
    if (state.horizontalSwipe){
      e.preventDefault();
      const delta = t.clientY - state.verticalStartY;
      state.swipeDeltaY = delta;
      const v = getCurrentVideoNode();
      if (v){
        v.style.transition = 'none';
        v.style.transform = `translate3d(0, ${Math.round(delta)}px, 0)`;
      }
    }
  }

  function onTouchEnd(e){
    clearTimeout(state.holdTimer);
    if (state.uiHidden){
      state.uiHidden = false;
      if (state.shell) state.shell.classList.remove('ui-hidden');
      state.verticalTouching = false;
      return;
    }
    if (!state.open || !state.verticalTouching || !e.changedTouches || !e.changedTouches[0]) return;
    const end = e.changedTouches[0];
    const dx = Math.abs(end.clientX - state.verticalStartX);
    const dy = Math.abs(end.clientY - state.verticalStartY);
    const dt = Math.max(0, Date.now() - Number(state.touchStartTs || 0));
    const deltaY = state.verticalStartY - end.clientY;

    // Vertical swipe switches video.
    if (Math.abs(deltaY) > 50){
      if (deltaY > 0) setIndex(state.index + 1, { swipe: true, direction: 1 });
      else setIndex(state.index - 1, { swipe: true, direction: -1 });
    } else {
      // Simple tap on the video area toggles play/pause on mobile.
      const target = e.target instanceof Element ? e.target : null;
      const tapLike = dx <= 12 && dy <= 12 && dt <= 320;
      const touchedVideoArea = !!target?.closest('.lvp-video-host,video.lvp-video');
      if (tapLike && touchedVideoArea){
        const v = getCurrentVideoNode();
        if (v){
          if (v.paused) v.play().catch(()=>{});
          else v.pause();
        }
      }
    }
    const v = getCurrentVideoNode();
    if (v){
      v.style.transition = 'transform .18s ease';
      v.style.transform = 'translate3d(0,0,0)';
    }
    state.verticalTouching = false;
    state.swipeDeltaY = 0;
  }

  function ensureDom(){
    if (state.overlay) return;
    const overlay = createEl('div', 'lvp-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="lvp-shell" role="dialog" aria-modal="true" aria-label="Video player">
        <button class="lvp-close" type="button" aria-label="Close">×</button>
        <button class="lvp-hide" type="button" aria-label="Hide player"><i class="fas fa-chevron-down"></i></button>
        <div class="lvp-grid">
          <aside class="lvp-recommendations">
            <div class="lvp-rec-head">Recommended</div>
            <div class="lvp-rec-list"></div>
          </aside>
          <section class="lvp-main">
            <div class="lvp-video-host"></div>
            <div class="lvp-progress"><span class="lvp-progress-fill"></span></div>
            <div class="lvp-meta">
              <h3 class="lvp-title"></h3>
              <div class="lvp-author"></div>
              <p class="lvp-desc"></p>
            </div>
            <div class="lvp-actions">
              <button type="button" class="lvp-action lvp-like has-count" title="Like" aria-label="Like"><i class="fas fa-heart"></i><span class="lvp-action-count">0</span></button>
              <button type="button" class="lvp-action lvp-comments has-count" title="Comments" aria-label="Comments"><i class="fas fa-comment-dots"></i><span class="lvp-action-count">0</span></button>
              <button type="button" class="lvp-action lvp-views has-count" disabled title="Views" aria-label="Views"><i class="fas fa-eye"></i><span class="lvp-action-count">0</span></button>
              <button type="button" class="lvp-action lvp-author" title="Author" aria-label="Author"><i class="fas fa-user-circle"></i></button>
              <button type="button" class="lvp-action lvp-share" title="Share" aria-label="Share"><i class="fas fa-paper-plane"></i></button>
              <button type="button" class="lvp-action lvp-theater" title="Theater mode" aria-label="Theater mode"><i class="fas fa-expand"></i></button>
            </div>
          </section>
        </div>
        <div class="lvp-mobile-rail">
          <button type="button" class="lvp-rail-btn lvp-like"><i class="fas fa-heart"></i><span class="lvp-rail-count"></span></button>
          <button type="button" class="lvp-rail-btn lvp-comments"><i class="fas fa-comment-dots"></i><span class="lvp-rail-count"></span></button>
          <button type="button" class="lvp-rail-btn lvp-author"><i class="fas fa-user-circle"></i><span class="lvp-rail-count"></span></button>
          <button type="button" class="lvp-rail-btn lvp-share"><i class="fas fa-paper-plane"></i><span class="lvp-rail-count"></span></button>
          <button type="button" class="lvp-rail-btn lvp-fullscreen"><i class="fas fa-expand"></i><span class="lvp-rail-count"></span></button>
        </div>
        <div class="lvp-mobile-meta">
          <div class="lvp-mobile-author"></div>
          <div class="lvp-mobile-title"></div>
          <div class="lvp-mobile-desc"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.shell = overlay.querySelector('.lvp-shell');
    state.playerHost = overlay.querySelector('.lvp-video-host');
    state.recList = overlay.querySelector('.lvp-rec-list');
    state.titleEl = overlay.querySelector('.lvp-title');
    state.authorEl = overlay.querySelector('.lvp-meta .lvp-author');
    state.descEl = overlay.querySelector('.lvp-desc');
    state.likeBtn = overlay.querySelector('.lvp-like');
    state.commentsBtn = overlay.querySelector('.lvp-comments');
    state.authorBtn = overlay.querySelector('.lvp-actions .lvp-author');
    state.authorRailBtn = overlay.querySelector('.lvp-mobile-rail .lvp-author');
    state.shareBtn = overlay.querySelector('.lvp-share');
    state.viewsBtn = overlay.querySelector('.lvp-views');
    state.theaterBtn = overlay.querySelector('.lvp-theater');
    state.hideBtn = overlay.querySelector('.lvp-hide');
    state.mobileMeta = overlay.querySelector('.lvp-mobile-meta');

    const closeBtn = overlay.querySelector('.lvp-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (state.hideBtn) state.hideBtn.addEventListener('click', hideToBackground);
    overlay.addEventListener('click', (e)=>{
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.lvp-main,.lvp-recommendations,.lvp-mobile-meta,.lvp-mobile-rail,.lvp-close,.lvp-hide')) return;
      close();
    });
    state.shareBtn?.addEventListener('click', async ()=>{
      const current = state.items[state.index];
      if (!current) return;
      openShareMenu(current);
    });
    state.commentsBtn?.addEventListener('click', ()=>{
      // Placeholder comment sheet integration point for both app and landing.
      try { window.dispatchEvent(new CustomEvent('liber-video-comments-open', { detail: state.items[state.index] || null })); } catch (_) { }
    });
    state.authorBtn?.addEventListener('click', async ()=>{
      const current = state.items[state.index] || null;
      try{
        const info = await resolveAuthorInfo(current || {});
        const uid = String(info?.uid || current?.authorId || '').trim();
        const dm = window.dashboardManager || window.top?.dashboardManager || window.parent?.dashboardManager;
        if (uid && dm && typeof dm.showUserPreviewModal === 'function'){
          dm.showUserPreviewModal(uid);
          return;
        }
      }catch(_){ }
      try { window.dispatchEvent(new CustomEvent('liber-video-author-open', { detail: current })); } catch (_) { }
    });
    state.likeBtn?.addEventListener('click', ()=>{
      const current = state.items[state.index];
      if (!current) return;
      try{
        window.firebaseService?.trackVideoInteraction?.({
          action: 'like_click',
          source: state.source,
          sourceId: current.sourceId,
          videoId: current.id
        });
      }catch(_){ }
      toggleCurrentLike();
    });
    document.addEventListener('fullscreenchange', syncFullscreenUi);
    document.addEventListener('webkitfullscreenchange', syncFullscreenUi);
    state.theaterBtn?.addEventListener('click', ()=>{
      const next = !state.shell.classList.contains('theater');
      state.shell.classList.toggle('theater', next);
      const icon = state.theaterBtn.querySelector('i');
      if (icon) icon.className = `fas ${next ? 'fa-compress' : 'fa-expand'}`;
      state.theaterBtn.title = next ? 'Default mode' : 'Theater mode';
      state.theaterBtn.setAttribute('aria-label', next ? 'Default mode' : 'Theater mode');
    });
    const bindTapAction = (btn, action)=>{
      if (!btn || typeof action !== 'function') return;
      let touchHandled = false;
      btn.addEventListener('touchend', (e)=>{
        touchHandled = true;
        try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
        action();
      }, { passive: false });
      btn.addEventListener('click', (e)=>{
        if (touchHandled){
          touchHandled = false;
          return;
        }
        try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
        action();
      });
    };
    overlay.querySelectorAll('.lvp-mobile-rail .lvp-like').forEach((b)=> bindTapAction(b, ()=> state.likeBtn?.click()));
    overlay.querySelectorAll('.lvp-mobile-rail .lvp-comments').forEach((b)=> bindTapAction(b, ()=> state.commentsBtn?.click()));
    overlay.querySelectorAll('.lvp-mobile-rail .lvp-author').forEach((b)=> bindTapAction(b, ()=>{
      if (state.authorBtn) state.authorBtn.click();
      else{
        try { window.dispatchEvent(new CustomEvent('liber-video-author-open', { detail: state.items[state.index] || null })); } catch (_) { }
      }
    }));
    overlay.querySelectorAll('.lvp-mobile-rail .lvp-share').forEach((b)=> bindTapAction(b, ()=> state.shareBtn?.click()));
    overlay.querySelectorAll('.lvp-mobile-rail .lvp-fullscreen').forEach((b)=> bindTapAction(b, toggleVideoFullscreen));

    const progress = overlay.querySelector('.lvp-progress');
    if (progress){
      const seekTo = (clientX)=>{
        const v = getCurrentVideoNode();
        if (!v || !(v.duration > 0)) return;
        const rect = progress.getBoundingClientRect();
        const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        v.currentTime = ratio * v.duration;
      };
      progress.addEventListener('click', (e)=> seekTo(e.clientX));
      let dragging = false;
      progress.addEventListener('pointerdown', (e)=>{
        dragging = true;
        try{ progress.setPointerCapture(e.pointerId); }catch(_){ }
        seekTo(e.clientX);
      });
      progress.addEventListener('pointermove', (e)=>{ if (dragging) seekTo(e.clientX); });
      progress.addEventListener('pointerup', (e)=>{
        dragging = false;
        try{ progress.releasePointerCapture(e.pointerId); }catch(_){ }
      });
      progress.addEventListener('pointercancel', ()=>{ dragging = false; });
    }

    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('touchstart', onTouchStart, { passive: true });
    overlay.addEventListener('touchmove', onTouchMove, { passive: false });
    overlay.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('resize', ()=>{
      const v = getCurrentVideoNode();
      if (v) v.controls = !isMobile();
    });
    document.addEventListener('keydown', (e)=>{
      if (!state.open) return;
      if (e.key === 'Escape') close();
      if (!isMobile() && e.key === 'ArrowDown') setIndex(state.index + 1);
      if (!isMobile() && e.key === 'ArrowUp') setIndex(state.index - 1);
    });
  }

  async function open(payload){
    ensureDom();
    const items = (Array.isArray(payload?.items) ? payload.items : []).map(normalizeItem).filter(Boolean);
    if (!items.length) return false;
    if (state.restoreBtn){
      try{ state.restoreBtn.remove(); }catch(_){ }
      state.restoreBtn = null;
    }
    state.items = items;
    state.index = clamp(Number(payload?.startIndex) || 0, 0, items.length - 1);
    state.source = String(payload?.source || 'app');
    state.overlay.classList.remove('minimized');
    state.overlay.classList.add('open');
    state.overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lvp-open');
    state.open = true;
    syncFullscreenUi();
    await setIndex(state.index);
    return true;
  }

  window.LiberVideoPlayer = {
    open,
    close,
    isOpen: function(){ return !!state.open; }
  };
})();
