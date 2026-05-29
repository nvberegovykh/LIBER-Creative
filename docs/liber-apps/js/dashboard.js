/**
 * Dashboard Module for Liber Apps Control Panel
 * Handles navigation, overview, and dashboard functionality
 */

class DashboardManager {
    constructor() {
        this.currentSection = 'apps';
        this._dashboardSuspended = false;
        this._playQueue = [];
        this._playQueueIndex = -1;
        this._miniTitleTicker = null;
        this._repeatMode = 'off';
        this._audioWaveCache = new Map();
        this._audioWaveCtx = null;
        this._waveLibraryVisible = 5;
        this._playlistsVisible = 5;
        this._videoLibraryVisible = 5;
        this._videoSuggestionsVisible = 5;
        this._userPreviewCache = new Map();
        this._spacePostAttachments = [];
        this._waveMetaByUrl = new Map();
        this._waveMetaPendingByUrl = new Map();
        this._videoMetaByUrl = new Map();
        this._videoMetaPendingByUrl = new Map();
        this._waveMainTab = 'audio';
        this._waveSubTabByMain = { audio: 'home', video: 'home', pictures: 'home' };
        this._pendingWaveUploadTags = { audio: [], video: [], pictures: [] };
        this._waveFollowingNotificationPref = new Map();
        this._postLibrarySyncState = new Map();
        this._realtimeFeedUnsubs = new Map();
        this._realtimeFeedTimers = new Map();
        this._resumeBySrc = new Map();
        this._isAdminSession = false;
        this._pendingRequestUnsub = null;
        try{
            const savedRepeat = localStorage.getItem('liber_mini_repeat_mode');
            if (savedRepeat === 'all' || savedRepeat === 'one' || savedRepeat === 'off') this._repeatMode = savedRepeat;
        }catch(_){ }
        this.init();
    }

    async resolveCurrentUser(){
        try{
            const u = await window.firebaseService.getCurrentUser();
            if (u && u.uid) return u;
        }catch(_){ }
        try{
            const u2 = window.firebaseService?.auth?.currentUser;
            if (u2 && u2.uid) return u2;
        }catch(_){ }
        try{
            const am = window.authManager?.currentUser;
            if (am && am.id) return { uid: am.id, email: am.email || '' };
        }catch(_){ }
        return null;
    }

    async resolveCurrentUserWithRetry(maxWaitMs = 2500){
        const start = Date.now();
        let user = await this.resolveCurrentUser();
        while ((!user || !user.uid) && (Date.now() - start) < maxWaitMs){
            await new Promise((r)=> setTimeout(r, 180));
            user = await this.resolveCurrentUser();
        }
        return user;
    }

    isPublicContentRecord(row){
        const visibility = String(row?.visibility || '').trim().toLowerCase();
        if (visibility === 'public' || visibility === 'pub') return true;
        if (row?.isPublic === true || row?.public === true) return true;
        if (String(row?.privacy || '').trim().toLowerCase() === 'public') return true;
        return false;
    }

    getShareBaseUrl(){
        try{
            const u = new URL(window.location.href);
            u.hash = '';
            u.search = '';
            if (!/\/[^/]+\.[a-z0-9]+$/i.test(u.pathname || '')){
                const clean = String(u.pathname || '').replace(/\/$/, '');
                u.pathname = `${clean || '/'}${clean ? '/' : ''}index.html`;
            }
            return u.toString();
        }catch(_){
            return `${window.location.origin}${window.location.pathname}`;
        }
    }

    buildPublicShareLink(target = {}, extras = {}){
        try{
            const base = new URL(this.getShareBaseUrl());
            const kind = String(target?.kind || '').trim().toLowerCase();
            if (kind === 'post'){
                const id = String(target?.id || target?.postId || '').trim();
                if (id){
                    base.searchParams.set('open', 'post');
                    base.searchParams.set('id', id);
                }
            } else if (kind === 'wave'){
                const type = String(target?.type || '').trim().toLowerCase();
                const id = String(target?.id || '').trim();
                const url = String(target?.url || '').trim();
                base.searchParams.set('open', 'wave');
                if (type) base.searchParams.set('type', type);
                if (id) base.searchParams.set('id', id);
                if (!id && url) base.searchParams.set('u', url);
            } else if (kind === 'chat'){
                const connId = String(target?.connId || '').trim();
                if (connId){
                    base.searchParams.set('open', 'chat');
                    base.searchParams.set('connId', connId);
                }
            }
            Object.entries(extras || {}).forEach(([k, v])=>{
                const key = String(k || '').trim();
                if (!key) return;
                const val = String(v ?? '').trim();
                if (!val) return;
                base.searchParams.set(key, val);
            });
            return base.toString();
        }catch(_){
            return this.getShareBaseUrl();
        }
    }

    async copyShareLinkToClipboard(url, okMsg = 'Link copied'){
        try{
            const next = String(url || '').trim();
            if (!next) return false;
            await navigator.clipboard.writeText(next);
            this.showSuccess(okMsg);
            return true;
        }catch(_){
            this.showError('Failed to copy');
            return false;
        }
    }

    async shareOrCopyLink(url, { title = '', text = '', copiedMsg = 'Link copied' } = {}){
        const next = String(url || '').trim();
        if (!next) return false;
        if (navigator.share){
            try{
                await navigator.share({
                    title: String(title || '').trim(),
                    text: String(text || '').trim(),
                    url: next
                });
                return true;
            }catch(_){ }
        }
        return this.copyShareLinkToClipboard(next, copiedMsg);
    }

    async focusPostCardInFeeds(postId, maxAttempts = 8){
        const id = String(postId || '').trim();
        if (!id) return false;
        for (let i = 0; i < maxAttempts; i++){
            const sel = `.post-item[data-post-id="${id.replace(/"/g,'\\"')}"]`;
            const card = document.querySelector(`#global-feed ${sel}`) || document.querySelector(`#space-feed ${sel}`) || document.querySelector(sel);
            if (card){
                try{ card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); }catch(_){ card.scrollIntoView(); }
                try{
                    const prev = card.style.boxShadow;
                    card.style.boxShadow = '0 0 0 2px rgba(107,158,255,.9)';
                    setTimeout(()=>{ try{ card.style.boxShadow = prev || ''; }catch(_){ } }, 1400);
                }catch(_){ }
                return true;
            }
            await new Promise((r)=> setTimeout(r, 220));
        }
        return false;
    }

    async openSharedPostLink(postId){
        const id = String(postId || '').trim();
        if (!id) return;
        try{
            const snap = await firebase.getDoc(firebase.doc(window.firebaseService.db, 'posts', id));
            if (!snap.exists()){
                this.showError('This content is private.');
                return;
            }
            const row = snap.data() || {};
            if (!this.isPublicContentRecord(row)){
                this.showError('This content is private.');
                return;
            }
        }catch(_){
            this.showError('This content is private.');
            return;
        }
        this.switchSection('feed');
        try{ await this.loadGlobalFeed(this._wallSearchTerm || ''); }catch(_){ }
        await this.focusPostCardInFeeds(id, 10);
    }

    async openSharedWaveLink({ type = '', id = '', url = '' } = {}){
        const kind = String(type || '').trim().toLowerCase();
        const sourceId = String(id || '').trim();
        const href = String(url || '').trim();
        this.switchSection('waveconnect');
        if (kind === 'audio') this.setWaveMainTab('audio');
        else if (kind === 'video') this.setWaveMainTab('video');
        else if (kind === 'picture' || kind === 'image') this.setWaveMainTab('pictures');
        this.setWaveSubtab('home');
        await new Promise((r)=> setTimeout(r, 260));
        const match = ()=>{
            const byId = sourceId
                ? document.querySelector(`[data-asset-id="${sourceId.replace(/"/g,'\\"')}"]`)
                : null;
            if (byId) return byId;
            if (!href) return null;
            const all = Array.from(document.querySelectorAll('[data-asset-url]'));
            const normHref = this.normalizeMediaUrl(href);
            return all.find((el)=> this.urlsLikelySame(String(el.getAttribute('data-asset-url') || ''), normHref)) || null;
        };
        const openTargetPopup = (host)=>{
            if (!host) return false;
            try{
                const vid = host.querySelector('.liber-lib-video');
                if (vid){
                    const src = String(vid.currentSrc || vid.src || '').trim();
                    if (src){
                        this.openFullscreenMedia([{
                            type: 'video',
                            url: src,
                            title: String(vid.dataset.title || host.querySelector('.video-item-title')?.textContent || 'Video').trim(),
                            by: String(vid.dataset.by || '').trim(),
                            cover: String(vid.dataset.cover || '').trim(),
                            sourceId: String(vid.dataset.sourceId || sourceId || '').trim()
                        }], 0);
                        return true;
                    }
                }
                const img = host.querySelector('img[data-fullscreen-image="1"]');
                if (img){
                    const src = String(img.currentSrc || img.src || '').trim();
                    if (src){
                        this.openFullscreenImage(src, String(img.alt || 'Picture'));
                        return true;
                    }
                }
            }catch(_){ }
            return false;
        };
        for (let i = 0; i < 12; i++){
            const el = match();
            if (el){
                try{ el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); }catch(_){ el.scrollIntoView(); }
                const expectedKind = kind || this.inferMediaKindFromUrl(String(href || ''));
                if (expectedKind === 'video' || expectedKind === 'image' || expectedKind === 'picture'){
                    setTimeout(()=> openTargetPopup(el), 80);
                }
                return;
            }
            await new Promise((r)=> setTimeout(r, 240));
        }
    }

    async handleIncomingShareIntent(){
        try{
            const params = new URLSearchParams(window.location.search || '');
            const fromTarget = String(params.get('share_target') || '').trim() === '1';
            if (!fromTarget) return;
            const sharedUrl = String(params.get('url') || '').trim();
            const title = String(params.get('title') || '').trim();
            const text = String(params.get('text') || '').trim();
            if (!sharedUrl && !title && !text) return;
            await this.openShareToChatSheet({
                type: 'external-link',
                asset: {
                    kind: 'link',
                    url: sharedUrl,
                    title: title || sharedUrl || 'Shared link',
                    text
                }
            });
        }catch(_){ }
    }

    async handleIncomingDeepLink(){
        try{
            const params = new URLSearchParams(window.location.search || '');
            const hash = String(window.location.hash || '').replace(/^#/, '').trim();
            let open = String(params.get('open') || '').trim().toLowerCase();
            if (!open && /^post[-_:]/i.test(hash)) open = 'post';
            if (open === 'post'){
                const id = String(params.get('id') || params.get('postId') || hash.replace(/^post[-_:]/i, '') || '').trim();
                if (id) await this.openSharedPostLink(id);
                return;
            }
            if (open === 'wave'){
                await this.openSharedWaveLink({
                    type: String(params.get('type') || '').trim().toLowerCase(),
                    id: String(params.get('id') || '').trim(),
                    url: String(params.get('u') || params.get('url') || '').trim()
                });
                return;
            }
            if (open === 'chat'){
                const connId = String(params.get('connId') || '').trim();
                const me = await this.resolveCurrentUser();
                if (!me || !me.uid){
                    this.showError('This chat content is private. Please log in.');
                    try{
                        if (window.authManager && typeof window.authManager.showAuthScreen === 'function'){
                            window.authManager.showAuthScreen();
                        }
                    }catch(_){ }
                    return;
                }
                if (connId && window.appsManager && typeof window.appsManager.openAppInShell === 'function'){
                    const q = new URLSearchParams({ connId });
                    const full = new URL(`apps/secure-chat/index.html?${q.toString()}`, window.location.href).href;
                    window.appsManager.openAppInShell({ id: 'secure-chat', name: 'Connections' }, full);
                }
            }
        }catch(_){ }
    }

    openFullscreenMedia(items, startIndex = 0){
        try{
            const normalized = (Array.isArray(items) ? items : [])
                .map((it)=>{
                    if (!it || !it.url) return null;
                    return {
                        type: String(it.type || '').toLowerCase() === 'video' ? 'video' : 'image',
                        url: String(it.url || ''),
                        alt: String(it.alt || it.title || ''),
                        poster: String(it.poster || it.cover || ''),
                        title: String(it.title || '')
                    };
                })
                .filter(Boolean);
            if (!normalized.length) return false;
            const start = Math.max(0, Math.min((normalized.length - 1), Number(startIndex) || 0));
            const selected = normalized[start] || normalized[0];
            if (selected && selected.type === 'video'){
                const player = window.LiberVideoPlayer;
                if (player && typeof player.open === 'function'){
                    const videoItems = normalized.filter((it)=> it.type === 'video');
                    const vidIdx = Math.max(0, videoItems.findIndex((it)=> it.url === selected.url));
                    return player.open({ items: videoItems, startIndex: vidIdx, source: 'app' });
                }
            }
            const viewer = window.LiberMediaFullscreenViewer;
            if (!viewer || typeof viewer.open !== 'function') return false;
            const imageItems = normalized.filter((it)=> it.type !== 'video');
            if (!imageItems.length) return false;
            const imgIdx = Math.max(0, imageItems.findIndex((it)=> it.url === selected.url));
            return viewer.open({ items: imageItems, startIndex: imgIdx >= 0 ? imgIdx : 0 });
        }catch(_){ return false; }
    }

    openFullscreenImage(src, alt = 'image'){
        try{
            const url = String(src || '').trim();
            if (!url) return;
            const opened = this.openFullscreenMedia([{ type: 'image', url, alt: String(alt || 'image') }], 0);
            if (opened) return;
            const existing = document.getElementById('liber-image-lightbox');
            if (existing) existing.remove();
            const overlay = document.createElement('div');
            overlay.id = 'liber-image-lightbox';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;padding:16px';
            overlay.innerHTML = `<button type="button" aria-label="Close" style="position:fixed;top:12px;right:12px;background:rgba(16,20,28,.92);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:10px;padding:8px 10px;cursor:pointer;z-index:1"><i class="fas fa-xmark"></i></button><img src="${url.replace(/"/g,'&quot;')}" alt="${String(alt || 'image').replace(/"/g,'&quot;')}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:10px">`;
            const close = ()=>{ try{ overlay.remove(); }catch(_){ } };
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay) close(); });
            const closeBtn = overlay.querySelector('button');
            if (closeBtn) closeBtn.addEventListener('click', close);
            document.body.appendChild(overlay);
        }catch(_){ }
    }

    extractFullscreenMediaFromElement(el){
        try{
            if (!(el instanceof HTMLElement)) return null;
            if (el instanceof HTMLImageElement){
                const src = String(el.currentSrc || el.src || '').trim();
                if (!src) return null;
                return { type: 'image', url: src, alt: String(el.alt || 'image') };
            }
            if (el instanceof HTMLVideoElement){
                const src = String(el.currentSrc || el.src || '').trim();
                if (!src) return null;
                const explicit = el.getAttribute('data-fullscreen-media') === '1';
                const allowControlledVideo =
                    explicit
                    || el.classList.contains('post-media-video')
                    || el.classList.contains('player-media')
                    || !!el.closest('.post-media-visual-item,.post-item,.wave-item,.video-item,.file-preview,[data-media-collection]');
                if (el.controls && !allowControlledVideo) return null;
                return { type: 'video', url: src, poster: String(el.poster || ''), title: String(el.getAttribute('data-title') || 'Video') };
            }
            return null;
        }catch(_){ return null; }
    }

    collectFullscreenMediaContext(targetMedia){
        try{
            if (!(targetMedia instanceof HTMLElement)) return { items: [], startIndex: 0 };
            const contextRoot = targetMedia.closest('[data-media-collection],.preview-visual-grid,.post-media-visual-slider,.space-post-preview-card,#preview-pictures,#preview-video,#preview-videos,.file-preview')
                || targetMedia.parentElement
                || document.body;
            const nodes = Array.from(contextRoot.querySelectorAll('img,video'));
            const items = nodes
                .map((node)=> this.extractFullscreenMediaFromElement(node))
                .filter(Boolean);
            if (!items.length){
                const one = this.extractFullscreenMediaFromElement(targetMedia);
                return one ? { items: [one], startIndex: 0 } : { items: [], startIndex: 0 };
            }
            const targetSrc = String((targetMedia.currentSrc || targetMedia.src || targetMedia.getAttribute('src') || '')).trim();
            const startIndex = Math.max(0, items.findIndex((it)=> String(it.url || '').trim() === targetSrc));
            return { items, startIndex: startIndex >= 0 ? startIndex : 0 };
        }catch(_){ return { items: [], startIndex: 0 }; }
    }

    clearRealtimeFeedSubscription(key){
        try{
            const k = String(key || '').trim();
            if (!k) return;
            const unsub = this._realtimeFeedUnsubs.get(k);
            if (typeof unsub === 'function'){
                try{ unsub(); }catch(_){ }
            }
            this._realtimeFeedUnsubs.delete(k);
            const t = this._realtimeFeedTimers.get(k);
            if (t) clearTimeout(t);
            this._realtimeFeedTimers.delete(k);
        }catch(_){ }
    }

    subscribeRealtimeFeed(key, queryFactory, onChange){
        try{
            if (!firebase || typeof firebase.onSnapshot !== 'function') return;
            const k = String(key || '').trim();
            if (!k || typeof queryFactory !== 'function' || typeof onChange !== 'function') return;
            const q = queryFactory();
            if (!q) return;
            this.clearRealtimeFeedSubscription(k);
            const trigger = (payload = null)=>{
                const prev = this._realtimeFeedTimers.get(k);
                if (prev) clearTimeout(prev);
                const t = setTimeout(()=>{ Promise.resolve(onChange(payload)).catch(()=>{}); }, 240);
                this._realtimeFeedTimers.set(k, t);
            };
            let initialDelivered = false;
            const unsub = firebase.onSnapshot(
                q,
                (snap)=>{
                    if (!initialDelivered){ initialDelivered = true; return; }
                    trigger({ snapshot: snap, key: k });
                },
                (error)=> trigger({ error, key: k })
            );
            this._realtimeFeedUnsubs.set(k, unsub);
        }catch(_){ }
    }

    getPostCreatedTs(post){
        try{
            return Number(post?.createdAtTS?.toMillis?.() || 0) || Number(new Date(post?.createdAt || 0).getTime() || 0) || 0;
        }catch(_){ return Number(new Date(post?.createdAt || 0).getTime() || 0) || 0; }
    }

    _isEmailLike(value){
        const s = String(value || '').trim();
        if (!s) return false;
        return /@/.test(s) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
    }

    _safeUsername(value, fallback = 'User'){
        const s = String(value || '').trim();
        if (!s) return fallback;
        if (this._isEmailLike(s)) return fallback;
        return s;
    }

    _resolveAuthorName(post = {}, authorProfile = null, opts = {}){
        const profileName = this._safeUsername(authorProfile?.username || '', '');
        const postName = this._safeUsername(post?.authorName || '', '');
        const optName = this._safeUsername(opts?.displayName || '', '');
        return profileName || postName || optName || 'User';
    }

    async buildRealtimeFeedPostElement(post, opts = {}){
        const p = post || {};
        const div = document.createElement('div');
        div.className = 'post-item';
        div.dataset.postId = String(p.id || '');
        div.dataset.postCreatedTs = String(this.getPostCreatedTs(p));
        div.style.cssText = 'border:1px solid var(--border-color);border-radius:12px;padding:12px;margin:10px 0;background:var(--secondary-bg)';
        const authorProfile = await this.getUserPreviewData(p.authorId || '');
        const authorName = this._resolveAuthorName(p, authorProfile, opts);
        const authorAvatar = String(authorProfile?.avatarUrl || p.coverUrl || p.thumbnailUrl || 'images/default-bird.png');
        const postTime = this.formatDateTime(p.createdAt);
        const editedBadge = this.isEdited(p) ? '<span style="font-size:11px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 6px">edited</span>' : '';
        const media = (p.media || p.mediaUrl) ? this.renderPostMedia(p.media || p.mediaUrl, { defaultBy: p.authorName || '', defaultCover: p.coverUrl || p.thumbnailUrl || '', authorId: p.authorId || '' }) : '';
        const postText = this.getPostDisplayText(p);
        const postTextHtml = postText ? `<div class="post-text">${postText.replace(/</g,'&lt;')}</div>` : '';
        const includeVisibility = opts.includeVisibility === true;
        const visibilityBtn = includeVisibility ? `<button class="btn btn-secondary visibility-btn">${p.visibility==='public'?'Make Private':'Make Public'}</button>` : '';
        div.innerHTML = `<div class="post-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
            <button type="button" data-user-preview="${String(p.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:8px;background:none;border:none;color:inherit;padding:0">
              <img src="${authorAvatar}" alt="author" style="width:22px;height:22px;border-radius:50%;object-fit:cover">
              <span style="font-size:12px;color:#aaa">${authorName.replace(/</g,'&lt;')}</span>
            </button>
            <span class="post-head-meta" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;opacity:.74">${postTime}${editedBadge}</span>
          </div>${media}${postTextHtml}
          <div class="post-actions" data-post-id="${String(p.id || '').replace(/"/g,'&quot;')}" data-author="${String(p.authorId || '').replace(/"/g,'&quot;')}" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:14px;align-items:center">
            <i class="fas fa-heart like-btn" title="Like" style="cursor:pointer"></i>
            <span class="likes-count"></span>
            <i class="fas fa-comment comment-btn" title="Comments" style="cursor:pointer"></i>
            <span class="comments-count"></span>
            <i class="fas fa-retweet repost-btn" title="Repost" style="cursor:pointer"></i>
            <span class="reposts-count"></span>
            <i class="fas fa-ellipsis-h post-menu" title="More" style="cursor:pointer"></i>
            <i class="fas fa-edit edit-post-btn" title="Edit" style="cursor:pointer"></i>
            <i class="fas fa-trash delete-post-btn" title="Delete" style="cursor:pointer"></i>
            ${visibilityBtn}
          </div>
          <div class="comment-tree" id="comments-${String(p.id || '').replace(/"/g,'&quot;')}" style="display:none"></div>`;
        return div;
    }

    sortFeedPostCards(container){
        try{
            if (!container) return;
            const cards = Array.from(container.querySelectorAll(':scope > .post-item[data-post-id]'));
            cards.sort((a,b)=> Number(b.dataset.postCreatedTs || 0) - Number(a.dataset.postCreatedTs || 0));
            cards.forEach((el)=> container.appendChild(el));
        }catch(_){ }
    }

    async applyRealtimePostChanges(container, payload, opts = {}){
        try{
            if (!container || !payload || !payload.snapshot || typeof payload.snapshot.docChanges !== 'function') return false;
            const changes = payload.snapshot.docChanges() || [];
            if (!changes.length) return true;
            const term = String(opts.searchTerm || '').trim().toLowerCase();
            const includeVisibility = opts.includeVisibility === true;
            const matches = (p)=>{
                if (!term) return true;
                const text = String(p?.text || '').toLowerCase();
                const author = String(p?.authorName || '').toLowerCase();
                return text.includes(term) || author.includes(term);
            };
            for (const ch of changes){
                const id = String(ch?.doc?.id || '').trim();
                if (!id) continue;
                if (ch.type === 'removed'){
                    const ex = container.querySelector(`.post-item[data-post-id="${id}"]`);
                    if (ex) ex.remove();
                    continue;
                }
                const p = { ...(ch.doc.data() || {}), id };
                if (!matches(p)){
                    const ex = container.querySelector(`.post-item[data-post-id="${id}"]`);
                    if (ex) ex.remove();
                    continue;
                }
                await this.primeWaveMetaForMedia(p?.media || p?.mediaUrl);
                const nextEl = await this.buildRealtimeFeedPostElement(p, { includeVisibility, displayName: opts.displayName || '' });
                const existing = container.querySelector(`.post-item[data-post-id="${id}"]`);
                if (existing) existing.replaceWith(nextEl);
                else container.appendChild(nextEl);
            }
            this.sortFeedPostCards(container);
            this.bindUserPreviewTriggers(container);
            this.activatePlayers(container);
            this.clearPostActionListeners(container);
            this.activatePostActions(container);
            this.applyHorizontalMasonryOrder(container);
            return true;
        }catch(_){ return false; }
    }

    ensurePreviewAddButtonStyles(){
        if (document.getElementById('preview-add-my-styles')) return;
        const style = document.createElement('style');
        style.id = 'preview-add-my-styles';
        style.textContent = `
        .preview-visual-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
        .preview-visual-card{border:1px solid var(--border-color);border-radius:12px;padding:10px;background:var(--secondary-bg)}
        .preview-visual-media{position:relative;border-radius:10px;overflow:hidden;background:#000}
        .preview-add-my-btn{position:absolute;right:10px;bottom:10px;transform:none;border:1px solid rgba(255,255,255,.35);background:rgba(8,12,18,.72);color:#fff;border-radius:999px;width:78px;height:36px;padding:0 10px;font-weight:700;font-size:16px;line-height:1;cursor:pointer;backdrop-filter:blur(2px);transition:background-color .2s ease,border-color .2s ease,opacity .2s ease}
        .preview-add-my-btn:hover{opacity:.95}
        .preview-add-my-btn.saved{font-size:12px;letter-spacing:.2px;background:rgba(24,120,62,.86);border-color:rgba(110,255,162,.55)}
        `;
        document.head.appendChild(style);
    }

    hashStringShort(input){
        try{
            const str = String(input || '');
            let h1 = 2166136261 >>> 0;
            let h2 = 2166136261 >>> 0;
            for (let i = 0; i < str.length; i++){
                const c = str.charCodeAt(i);
                h1 ^= c;
                h1 = Math.imul(h1, 16777619) >>> 0;
                h2 ^= (c + ((i * 13) & 255));
                h2 = Math.imul(h2, 16777619) >>> 0;
            }
            return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
        }catch(_){ return '0000000000000000'; }
    }

    makeAssetLikeKey(kind, url){
        const normalizedUrl = this.normalizeMediaUrl(url) || String(url || '').trim();
        const digest = this.hashStringShort(normalizedUrl);
        return `ak2_u_${digest}`;
    }

    getAssetLikeKeys(kind, url){
        const keys = [];
        const k1 = this.makeAssetLikeKey(kind, url);
        if (k1) keys.push(k1);
        const rawUrl = String(url || '').trim();
        const normUrl = this.normalizeMediaUrl(rawUrl) || rawUrl;
        const kinds = Array.from(new Set([
            String(kind || 'asset').toLowerCase(),
            'asset', 'audio', 'video', 'image', 'picture', 'file'
        ]));
        for (const k of kinds){
            for (const u of [rawUrl, normUrl]){
                if (!u) continue;
                try{
                    const legacyBase = `${k}|${u}`;
                    const legacy = `ak_${btoa(unescape(encodeURIComponent(legacyBase))).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_')}`;
                    if (legacy && !keys.includes(legacy)) keys.push(legacy);
                }catch(_){ }
            }
        }
        return keys;
    }

    normalizeMediaUrl(url){
        try{
            const raw = String(url || '').trim();
            if (!raw) return '';
            let decoded = raw;
            try{ decoded = decodeURIComponent(raw); }catch(_){ decoded = raw; }
            let out = decoded.toLowerCase();
            out = out.replace(/^https?:\/\//, '');
            out = out.replace(/^www\./, '');
            const cut = out.split('?')[0].split('#')[0];
            return cut.replace(/\/+$/, '');
        }catch(_){ return String(url || '').trim().toLowerCase(); }
    }

    urlsLikelySame(a, b){
        const x = this.normalizeMediaUrl(a);
        const y = this.normalizeMediaUrl(b);
        if (!x || !y) return false;
        if (x === y) return true;
        return x.endsWith(y) || y.endsWith(x);
    }

    async getAssetAggregatedLikeCount(kind, url){
        try{
            const href = String(url || '').trim();
            if (!href) return 0;
            const normHref = this.normalizeMediaUrl(href);
            let total = 0;
            const assetLikeUsers = new Set();
            const countedPostIds = new Set();
            const keys = this.getAssetLikeKeys(kind, href);
            for (const key of keys){
                try{
                    const likesSnap = await firebase.getDocs(firebase.collection(window.firebaseService.db, 'assetLikes', key, 'likes'));
                    (likesSnap.docs || []).forEach((d)=>{
                        const row = d.data() || {};
                        const uid = String(row.uid || d.id || '').trim();
                        if (uid) assetLikeUsers.add(uid);
                    });
                }catch(_){ }
            }
            total += assetLikeUsers.size;
            try{
                const qWaveByUrl = firebase.query(
                    firebase.collection(window.firebaseService.db,'wave'),
                    firebase.where('url','==', href),
                    firebase.limit(50)
                );
                const sWave = await firebase.getDocs(qWaveByUrl);
                for (const d of (sWave.docs || [])){
                    const w = d.data() || {};
                    const pid = String(w.sourcePostId || '').trim();
                    if (!pid) continue;
                    if (countedPostIds.has(pid)) continue;
                    try{
                        const likes = await firebase.getDocs(firebase.collection(window.firebaseService.db, 'posts', pid, 'likes'));
                        total += Number(likes.size || 0);
                        countedPostIds.add(pid);
                    }catch(_){ }
                }
            }catch(_){ }
            try{
                const postRows = [];
                try{
                    const q = firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.where('mediaUrl','==', href), firebase.limit(120));
                    const s = await firebase.getDocs(q);
                    s.forEach((d)=> postRows.push({ id: d.id, ...(d.data() || {}) }));
                }catch(_){ }
                try{
                    const qAll = firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.limit(500));
                    const sAll = await firebase.getDocs(qAll);
                    sAll.forEach((d)=>{
                        const p = d.data() || {};
                        if (postRows.some((x)=> x.id === d.id)) return;
                        const media = Array.isArray(p.media) ? p.media : [];
                        const mediaUrl = String(p.mediaUrl || '').trim();
                        const hasMediaUrl = mediaUrl && this.urlsLikelySame(mediaUrl, normHref);
                        const hasUrl = media.some((m)=> this.urlsLikelySame(String((m && (m.url || m.mediaUrl)) || '').trim(), normHref));
                        if (hasUrl || hasMediaUrl) postRows.push({ id: d.id, ...p });
                    });
                }catch(_){ }
                for (const p of postRows.slice(0, 120)){
                    try{
                        const pid = String(p.id || '').trim();
                        if (!pid || countedPostIds.has(pid)) continue;
                        const likes = await firebase.getDocs(firebase.collection(window.firebaseService.db, 'posts', pid, 'likes'));
                        total += Number(likes.size || 0);
                        countedPostIds.add(pid);
                    }catch(_){ }
                }
            }catch(_){ }
            return total;
        }catch(_){ return 0; }
    }

    async openShareToChatSheet(payload){
        try{
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid) return;
            let rows = [];
            try{
                const seen = new Set();
                const push = (d)=>{
                    const id = String(d?.id || '').trim();
                    if (!id || seen.has(id)) return;
                    seen.add(id);
                    rows.push({ id, ...(d?.data?.() || {}) });
                };
                const q1 = firebase.query(firebase.collection(window.firebaseService.db,'chatConnections'), firebase.where('participants','array-contains', me.uid), firebase.limit(220));
                const s1 = await firebase.getDocs(q1);
                s1.forEach(push);
                try{
                    const q2 = firebase.query(firebase.collection(window.firebaseService.db,'chatConnections'), firebase.where('users','array-contains', me.uid), firebase.limit(220));
                    const s2 = await firebase.getDocs(q2);
                    s2.forEach(push);
                }catch(_){ }
                try{
                    const q3 = firebase.query(firebase.collection(window.firebaseService.db,'chatConnections'), firebase.where('memberIds','array-contains', me.uid), firebase.limit(220));
                    const s3 = await firebase.getDocs(q3);
                    s3.forEach(push);
                }catch(_){ }
                // Legacy docs fallback: key-only rows without participant arrays.
                try{
                    let allSnap;
                    try{
                        const qAll = firebase.query(
                            firebase.collection(window.firebaseService.db,'chatConnections'),
                            firebase.orderBy('updatedAt','desc'),
                            firebase.limit(700)
                        );
                        allSnap = await firebase.getDocs(qAll);
                    }catch(_){
                        allSnap = await firebase.getDocs(firebase.collection(window.firebaseService.db,'chatConnections'));
                    }
                    allSnap.forEach((d)=>{
                        const c = d.data() || {};
                        const key = String(c.key || '');
                        if (!key) return;
                        const keyParts = key.split('|').filter(Boolean);
                        if (keyParts.includes(me.uid)) push(d);
                    });
                }catch(_){ }
            }catch(_){
                const s2 = await firebase.getDocs(firebase.collection(window.firebaseService.db,'chatConnections'));
                s2.forEach((d)=>{
                    const c = d.data() || {};
                    const parts = Array.isArray(c.participants) ? c.participants : (Array.isArray(c.users) ? c.users : (Array.isArray(c.memberIds) ? c.memberIds : []));
                    const keyParts = String(c.key || '').split('|').filter(Boolean);
                    if (parts.includes(me.uid) || keyParts.includes(me.uid)) rows.push({ id: d.id, ...c });
                });
            }
            if (!rows.length){ this.showError('No existing chats found'); return; }
            const getParticipants = (c)=>{
                const p = Array.isArray(c?.participants) ? c.participants : (Array.isArray(c?.users) ? c.users : (Array.isArray(c?.memberIds) ? c.memberIds : []));
                return p.filter(Boolean);
            };
            const byKey = new Map();
            rows.forEach((c)=>{
                if (!c || !c.id) return;
                const parts = getParticipants(c);
                const isGroup = parts.length > 2 || !!String(c.groupName || '').trim() || !!String(c.groupCoverUrl || '').trim();
                const dmKey = (parts.length >= 2) ? parts.slice().sort().join('|') : `id:${String(c.id || '')}`;
                const key = isGroup ? `group:${c.id}` : `dm:${dmKey}`;
                const prev = byKey.get(key);
                if (!prev){ byKey.set(key, c); return; }
                const prevTs = Number(new Date(prev.updatedAt || 0).getTime() || 0);
                const curTs = Number(new Date(c.updatedAt || 0).getTime() || 0);
                const prevArchived = prev.archived === true || !!String(prev.mergedInto || '').trim();
                const curArchived = c.archived === true || !!String(c.mergedInto || '').trim();
                if (prevArchived && !curArchived){ byKey.set(key, c); return; }
                if (curArchived && !prevArchived) return;
                if (curTs >= prevTs) byKey.set(key, c);
            });
            rows = Array.from(byKey.values()).sort((a,b)=> Number(new Date(b.updatedAt || 0).getTime() || 0) - Number(new Date(a.updatedAt || 0).getTime() || 0));
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:16px';
            overlay.innerHTML = `<div style="width:min(96vw,520px);max-height:76vh;overflow:auto;background:#0f1724;border:1px solid #2b3445;border-radius:12px;padding:12px"><div style="font-weight:700;margin-bottom:8px">Share to chat</div><div id="share-chat-list"></div><div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="share-chat-close" class="btn btn-secondary">Close</button></div></div>`;
            const list = overlay.querySelector('#share-chat-list');
            const metaMap = new Map();
            const resolveMeta = async (c)=>{
                const parts = getParticipants(c);
                const isGroup = parts.length > 2 || !!String(c.groupName || '').trim() || !!String(c.groupCoverUrl || '').trim();
                if (isGroup){
                    return {
                        title: String(c.groupName || this.getConnectionDisplayName(c) || 'Group chat').trim(),
                        subtitle: 'Group chat',
                        cover: String(c.groupCoverUrl || 'images/default-bird.png').trim() || 'images/default-bird.png'
                    };
                }
                const peerUid = parts.find((uid)=> uid && uid !== me.uid) || '';
                let title = String(this.getConnectionDisplayName(c) || 'Chat').trim();
                let cover = 'images/default-bird.png';
                if (peerUid){
                    try{
                        const u = await window.firebaseService.getUserData(peerUid);
                        title = this._safeUsername(u?.username || '', title);
                        cover = String(u?.avatarUrl || cover).trim() || 'images/default-bird.png';
                    }catch(_){ }
                }
                return { title, subtitle: 'Direct chat', cover };
            };
            await Promise.all(rows.map(async (c)=> metaMap.set(c.id, await resolveMeta(c))));
            rows.forEach((c)=>{
                const meta = metaMap.get(c.id) || { title: this.getConnectionDisplayName(c), subtitle: '', cover: 'images/default-bird.png' };
                const btn = document.createElement('button');
                btn.className = 'btn btn-secondary';
                btn.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
                btn.innerHTML = `<img src="${String(meta.cover || 'images/default-bird.png').replace(/"/g,'&quot;')}" alt="" style="width:28px;height:28px;border-radius:8px;object-fit:cover;flex:0 0 auto"><span style="min-width:0;display:flex;flex-direction:column"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(meta.title || 'Chat').replace(/</g,'&lt;')}</span><span style="opacity:.72;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(meta.subtitle || '').replace(/</g,'&lt;')}</span></span>`;
                btn.onclick = ()=>{
                    try{
                        const key = 'liber_chat_pending_shares_v1';
                        const raw = localStorage.getItem(key);
                        const arr = raw ? JSON.parse(raw) : [];
                        const next = Array.isArray(arr) ? arr : [];
                        next.push({ connId: String(c.id || ''), payload: payload || {}, queuedAt: new Date().toISOString() });
                        localStorage.setItem(key, JSON.stringify(next.slice(-80)));
                    }catch(_){ }
                    overlay.remove();
                    const qs = new URLSearchParams({ connId: String(c.id || '') });
                    const full = new URL(`apps/secure-chat/index.html?${qs.toString()}`, window.location.href).href;
                    if (window.appsManager && typeof window.appsManager.openAppInShell === 'function'){
                        window.appsManager.openAppInShell({ id: 'secure-chat', name: 'Connections' }, full);
                    } else {
                        window.location.href = full;
                    }
                };
                list.appendChild(btn);
            });
            overlay.querySelector('#share-chat-close').onclick = ()=> overlay.remove();
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);
        }catch(_){ this.showError('Unable to share to chat'); }
    }

    getConnectionDisplayName(conn){
        try{
            const meName = String(this.currentUser?.displayName || this.currentUser?.email || '').toLowerCase();
            const parts = Array.isArray(conn?.participants) ? conn.participants : (Array.isArray(conn?.users) ? conn.users : []);
            const names = Array.isArray(conn?.participantUsernames) ? conn.participantUsernames : [];
            const resolved = parts.map((uid, i)=> names[i] || uid).filter(Boolean);
            const others = resolved.filter((n)=> String(n || '').toLowerCase() !== meName);
            if (!others.length) return 'Chat';
            if (others.length === 1) return String(others[0]);
            return `${others[0]}, ${others[1]}${others.length > 2 ? ` +${others.length - 2}` : ''}`;
        }catch(_){ return 'Chat'; }
    }

    bindAssetCardInteractions(cardEl, asset){
        try{
            if (!cardEl || !asset || !asset.url) return;
            const kind = String(asset.kind || this.inferMediaKindFromUrl(asset.url) || 'file');
            const url = String(asset.url || '').trim();
            if (!url) return;
            cardEl.dataset.assetLikeKind = String(kind || 'asset').toLowerCase();
            cardEl.dataset.assetLikeUrl = this.normalizeMediaUrl(url);
            const likeBtn = cardEl.querySelector('.asset-like-btn');
            const likeCount = cardEl.querySelector('.asset-like-count');
            const commentsBtn = cardEl.querySelector('.asset-comment-btn');
            const commentsCount = cardEl.querySelector('.asset-comments-count');
            const viewsCount = cardEl.querySelector('.asset-views-count');
            const shareChatBtn = cardEl.querySelector('.asset-share-chat-btn');
            const keys = this.getAssetLikeKeys(kind, url);
            const primaryKey = keys[0];
            let commentsPostId = '';
            const refreshCount = async ()=>{
                try{
                    const n = await this.getAssetAggregatedLikeCount(kind, url);
                    if (likeCount) likeCount.textContent = `${n}`;
                    if (!commentsPostId){
                        commentsPostId = await this.resolveAssetPostId(asset);
                    }
                    if (commentsCount){
                        if (commentsPostId){
                            const st = await window.firebaseService.getPostStats(commentsPostId);
                            commentsCount.textContent = `${Number(st?.comments || 0)}`;
                        } else {
                            commentsCount.textContent = '0';
                        }
                    }
                    if (viewsCount){
                        const rawViews = Number(asset.viewCount || asset.views || asset.playCount || 0);
                        viewsCount.textContent = `${rawViews > 0 ? rawViews : 0}`;
                    }
                    const cardVideo = cardEl.querySelector('.liber-lib-video');
                    if (cardVideo){
                        cardVideo.dataset.likesCount = String(Number(n || 0) || 0);
                        cardVideo.dataset.commentsCount = String(Number(commentsCount?.textContent || 0) || 0);
                        cardVideo.dataset.viewsCount = String(Number(viewsCount?.textContent || asset.viewCount || 0) || 0);
                    }
                    const norm = this.normalizeMediaUrl(url);
                    document.querySelectorAll('[data-asset-like-kind][data-asset-like-url]').forEach((host)=>{
                        const k = String(host.getAttribute('data-asset-like-kind') || '').toLowerCase();
                        const u = String(host.getAttribute('data-asset-like-url') || '').trim();
                        if (k !== String(kind || '').toLowerCase()) return;
                        if (!this.urlsLikelySame(u, norm)) return;
                        const cnt = host.querySelector('.asset-like-count');
                        if (cnt) cnt.textContent = `${n}`;
                    });
                }catch(_){ }
            };
            refreshCount();
            try{
                const poll = setInterval(()=>{
                    try{
                        if (!cardEl || !document.body.contains(cardEl)){ clearInterval(poll); return; }
                        refreshCount();
                    }catch(_){ clearInterval(poll); }
                }, 6000);
            }catch(_){ }
            if (likeBtn){
                const setActive = (on)=>{
                    if (on){ likeBtn.classList.add('active'); likeBtn.style.color = '#ff6b81'; }
                    else { likeBtn.classList.remove('active'); likeBtn.style.color = '#d6deeb'; }
                };
                this.resolveCurrentUser().then(async (me)=>{
                    if (!me || !me.uid) return;
                    let liked = false;
                    for (const key of keys){
                        try{
                            const ref = firebase.doc(window.firebaseService.db, 'assetLikes', key, 'likes', me.uid);
                            const cur = await firebase.getDoc(ref);
                            if (cur.exists()){ liked = true; break; }
                        }catch(_){ }
                    }
                    setActive(liked);
                }).catch(()=>{});
                if (firebase && typeof firebase.onSnapshot === 'function'){
                    keys.forEach((key)=>{
                        try{
                            firebase.onSnapshot(
                                firebase.collection(window.firebaseService.db, 'assetLikes', key, 'likes'),
                                ()=>{ refreshCount(); }
                            );
                        }catch(_){ }
                    });
                }
                likeBtn.onclick = async ()=>{
                    try{
                        const me = await this.resolveCurrentUser();
                        if (!me || !me.uid){ this.showError('Please sign in'); return; }
                        const refs = [];
                        for (const key of keys){
                            try{
                                if (!key || String(key).length > 1200) continue;
                                refs.push(firebase.doc(window.firebaseService.db, 'assetLikes', key, 'likes', me.uid));
                            }catch(_){ }
                        }
                        if (!refs.length){
                            if (primaryKey){
                                try{ refs.push(firebase.doc(window.firebaseService.db, 'assetLikes', primaryKey, 'likes', me.uid)); }catch(_){ }
                            }
                        }
                        let hasLike = false;
                        for (const ref of refs){
                            try{
                                const s = await firebase.getDoc(ref);
                                if (s.exists()){ hasLike = true; break; }
                            }catch(_){ }
                        }
                        if (hasLike){
                            await Promise.all(refs.map(async (ref)=>{ try{ await firebase.deleteDoc(ref); }catch(_){ } }));
                            setActive(false);
                        } else {
                            let wrote = false;
                            const writeKeys = Array.from(new Set([primaryKey, ...keys].filter(Boolean)));
                            for (const key of writeKeys){
                                try{
                                    const ref = firebase.doc(window.firebaseService.db, 'assetLikes', key, 'likes', me.uid);
                                    await firebase.setDoc(ref, { uid: me.uid, createdAt: new Date().toISOString(), kind, url });
                                    wrote = true;
                                    break;
                                }catch(_){ }
                            }
                            if (!wrote){
                                throw new Error('asset-like-write-failed');
                            }
                            setActive(true);
                        }
                        await refreshCount();
                    }catch(_){ }
                };
            }
            if (shareChatBtn){
                shareChatBtn.onclick = ()=> this.openShareToChatSheet({
                    type: 'asset',
                    asset: {
                        kind,
                        url,
                        title: String(asset.title || asset.name || ''),
                        name: String(asset.title || asset.name || ''),
                        by: String(asset.by || asset.authorName || ''),
                        authorName: String(asset.by || asset.authorName || ''),
                        cover: String(asset.cover || asset.coverUrl || asset.thumbnailUrl || ''),
                        coverUrl: String(asset.cover || asset.coverUrl || asset.thumbnailUrl || ''),
                        thumbnailUrl: String(asset.cover || asset.coverUrl || asset.thumbnailUrl || ''),
                        sourceId: String(asset.sourceId || asset.id || '')
                    }
                });
            }
            if (commentsBtn){
                commentsBtn.onclick = async ()=>{
                    try{
                        if (!commentsPostId){
                            commentsPostId = await this.ensureAssetDiscussionPost(asset);
                        }
                        if (!commentsPostId){
                            this.showError('Unable to open comments');
                            return;
                        }
                        await this.openAssetCommentsModal(commentsPostId, asset.title || asset.name || 'Comments');
                        await refreshCount();
                    }catch(_){ this.showError('Unable to open comments'); }
                };
            }
        }catch(_){ }
    }

    async getMyVisualLibraryIndex(uid){
        const out = { videos: new Set(), pictures: new Set() };
        try{
            const meUid = String(uid || '').trim();
            if (!meUid) return out;
            let snap;
            try{
                const q = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', meUid), firebase.limit(1500));
                snap = await firebase.getDocs(q);
            }catch(_){
                snap = await firebase.getDocs(firebase.collection(window.firebaseService.db,'videos'));
            }
            (snap?.docs || []).forEach((d)=>{
                const v = d.data() || {};
                if (String(v.owner || '').trim() !== meUid) return;
                const url = String(v.url || '').trim();
                if (!url) return;
                if (this.resolveVisualKind(v) === 'image') out.pictures.add(url);
                else out.videos.add(url);
            });
        }catch(_){ }
        return out;
    }

    setupFullscreenImagePreview(){
        if (this._fullscreenImagePreviewBound) return;
        this._fullscreenImagePreviewBound = true;
        document.addEventListener('click', (e)=>{
            try{
                const target = e.target;
                if (!(target instanceof Element)) return;
                const mediaEl = target.closest('img,video');
                if (!(mediaEl instanceof HTMLElement)) return;
                if (mediaEl.closest('button,a,label,input,textarea,select,[data-user-preview],.mobile-bottom-nav,.dashboard-nav,.mini-player,.post-save-visual-btn')) return;
                const isEndpoint = mediaEl.id === 'space-avatar'
                    || mediaEl.id === 'view-user-avatar'
                    || mediaEl.classList.contains('post-media-image')
                    || mediaEl.classList.contains('post-media-video')
                    || mediaEl.getAttribute('data-fullscreen-image') === '1'
                    || mediaEl.getAttribute('data-fullscreen-media') === '1'
                    || mediaEl.closest('.space-post-preview-card')
                    || mediaEl.closest('.preview-visual-grid')
                    || mediaEl.closest('#preview-pictures')
                    || mediaEl.closest('#preview-video')
                    || mediaEl.closest('#preview-videos')
                    || mediaEl.closest('.file-preview');
                if (!isEndpoint) return;
                const payload = this.collectFullscreenMediaContext(mediaEl);
                if (!payload.items.length) return;
                e.preventDefault();
                e.stopPropagation();
                this.openFullscreenMedia(payload.items, payload.startIndex);
            }catch(_){ }
        }, true);
    }

    formatDateTime(value){
        try{
            const d = new Date(value || Date.now());
            if (Number.isNaN(d.getTime())) return '';
            return d.toLocaleString([], { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        }catch(_){ return ''; }
    }

    _sanitizeAudioFilename(name = 'audio'){
        try{
            const cleaned = String(name || 'audio')
                .replace(/[\\/:*?"<>|]+/g, '_')
                .replace(/\s+/g, ' ')
                .trim();
            return cleaned || 'audio';
        }catch(_){ return 'audio'; }
    }

    async downloadAudioAsset(url, fileName = 'audio'){
        try{
            const src = String(url || '').trim();
            if (!src) return;
            const res = await fetch(src, { mode: 'cors', cache: 'default' });
            if (!res.ok) throw new Error('download-failed');
            const blob = await res.blob();
            const ext = String(fileName || '').toLowerCase().endsWith('.mp3')
                || String(fileName || '').toLowerCase().endsWith('.m4a')
                || String(fileName || '').toLowerCase().endsWith('.wav')
                || String(fileName || '').toLowerCase().endsWith('.ogg')
                || String(fileName || '').toLowerCase().endsWith('.webm')
                ? ''
                : ((blob.type || '').includes('mpeg') ? '.mp3'
                  : (blob.type || '').includes('mp4') ? '.m4a'
                  : (blob.type || '').includes('wav') ? '.wav'
                  : (blob.type || '').includes('ogg') ? '.ogg'
                  : '.webm');
            const safe = this._sanitizeAudioFilename(fileName || 'audio') + ext;
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = safe;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(()=>{ try{ URL.revokeObjectURL(objectUrl); }catch(_){ } }, 2000);
        }catch(_){
            this.showError('Failed to download audio');
        }
    }

    isEdited(entity){
        try{
            const createdMs = Number(entity?.createdAtTS?.toMillis?.() || 0) || Number(new Date(entity?.createdAt || 0).getTime() || 0) || 0;
            const editedMs = Number(new Date(entity?.editedAt || 0).getTime() || 0) || 0;
            if (editedMs > 0 && createdMs > 0) return editedMs > (createdMs + 500);
            // Posts often update "updatedAt" for non-content actions (e.g., visibility),
            // so only use updatedAt fallback for non-post entities.
            if (Object.prototype.hasOwnProperty.call(entity || {}, 'visibility')) return false;
            const updatedMs = Number(new Date(entity?.updatedAt || 0).getTime() || 0) || 0;
            return updatedMs > 0 && createdMs > 0 && updatedMs > (createdMs + 1000);
        }catch(_){ return false; }
    }

    async getUserPreviewData(uid){
        const id = String(uid || '').trim();
        if (!id) return null;
        if (this._userPreviewCache.has(id)) return this._userPreviewCache.get(id);
        try{
            const d = await window.firebaseService.getUserData(id);
            if (d){
                this._userPreviewCache.set(id, d);
                return d;
            }
        }catch(_){ }
        return null;
    }

    getAuthorAvatarFromCache(uid, fallback = 'images/default-bird.png'){
        try{
            const id = String(uid || '').trim();
            if (!id) return String(fallback || 'images/default-bird.png');
            const cached = this._userPreviewCache.get(id);
            const avatar = String(cached?.avatarUrl || '').trim();
            return avatar || String(fallback || 'images/default-bird.png');
        }catch(_){ return String(fallback || 'images/default-bird.png'); }
    }

    async hydrateAuthorAvatarImage(imgEl, uid){
        try{
            if (!imgEl) return;
            const id = String(uid || '').trim();
            if (!id) return;
            const d = await this.getUserPreviewData(id);
            const avatar = String(d?.avatarUrl || '').trim();
            if (avatar) imgEl.src = avatar;
        }catch(_){ }
    }

    bindUserPreviewTriggers(root){
        try{
            if (!root) return;
            root.querySelectorAll('[data-user-preview]').forEach((el)=>{
                if (el._userPreviewBound) return;
                el._userPreviewBound = true;
                el.style.cursor = 'pointer';
                el.addEventListener('click', (e)=>{
                    try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
                    const uid = el.getAttribute('data-user-preview');
                    if (uid) this.showUserPreviewModal(uid);
                });
            });
        }catch(_){ }
    }

    async dissolveOutRemove(el, ms = 220){
        try{
            if (!el || !el.isConnected) return;
            el.classList.add('liber-dissolve-out');
            await new Promise((r)=> setTimeout(r, Math.max(120, ms)));
            if (el && el.isConnected) el.remove();
        }catch(_){ }
    }

    scheduleSpaceRetry(){
        if (this._spaceRetryTimer) return;
        this._spaceRetryTimer = setTimeout(()=>{
            this._spaceRetryTimer = null;
            if (this._dashboardSuspended) return;
            if (this.currentSection === 'space'){
                this.loadSpace();
            }
        }, 320);
    }

    applyHorizontalMasonryOrder(container){
        try{
            if (!container || window.innerWidth < 1024) return;
            const containerId = String(container.id || '');
            // Keep wall feed readable and chronologically stable (no visual "duplication" from column reordering).
            if (containerId === 'global-feed' || containerId === 'global-suggestions') return;
            const cards = Array.from(container.querySelectorAll(':scope > .post-item'));
            if (!cards.length) return;
            cards.forEach((el, idx)=>{
                if (!el.dataset.feedOrder) el.dataset.feedOrder = String(idx);
            });
            const base = cards.slice().sort((a,b)=> Number(a.dataset.feedOrder || 0) - Number(b.dataset.feedOrder || 0));
            const colW = 300;
            const gap = 12;
            const width = Math.max(1, Number(container.clientWidth || 0));
            const cols = Math.max(1, Math.floor((width + gap) / (colW + gap)));
            if (cols <= 1){
                base.forEach((el)=> container.appendChild(el));
                return;
            }
            const buckets = Array.from({ length: cols }, ()=> []);
            base.forEach((el, idx)=>{
                buckets[idx % cols].push(el);
            });
            const ordered = [];
            buckets.forEach((bucket)=> bucket.forEach((el)=> ordered.push(el)));
            ordered.forEach((el)=> container.appendChild(el));
        }catch(_){ }
    }

    async fetchPublicPlaylistsForUser(uid, limit = 20){
        const rows = [];
        const targetUid = String(uid || '').trim();
        if (!targetUid || !(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return rows;
        const pushUnique = (id, p)=>{
            const key = String(id || p?.id || '').trim();
            if (!key) return;
            if (rows.some((x)=> String(x.id || '') === key)) return;
            rows.push({ id: key, ...(p || {}) });
        };
        const matchesOwner = (p)=>{
            const ownerId = String(p?.ownerId || '').trim();
            const ownerLegacy = String(p?.owner || '').trim();
            const userId = String(p?.userId || '').trim();
            const authorId = String(p?.authorId || '').trim();
            const createdBy = String(p?.createdBy || '').trim();
            return ownerId === targetUid || ownerLegacy === targetUid || userId === targetUid || authorId === targetUid || createdBy === targetUid;
        };
        const isPublic = (p)=>{
            const visibility = String(p?.visibility || '').trim().toLowerCase();
            if (visibility === 'public') return true;
            if (visibility === 'pub') return true;
            if (p?.isPublic === true) return true;
            if (p?.public === true) return true;
            if (String(p?.privacy || '').trim().toLowerCase() === 'public') return true;
            return false;
        };
        try{
            const q = firebase.query(
                firebase.collection(window.firebaseService.db, 'playlists'),
                firebase.where('ownerId', '==', targetUid),
                firebase.where('visibility', '==', 'public'),
                firebase.limit(Math.max(20, limit))
            );
            const s = await firebase.getDocs(q);
            s.forEach((d)=> pushUnique(d.id, d.data() || {}));
        }catch(_){ }
        if (!rows.length){
            try{
                const qA = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('ownerId', '==', targetUid),
                    firebase.where('isPublic', '==', true),
                    firebase.limit(Math.max(20, limit))
                );
                const sA = await firebase.getDocs(qA);
                sA.forEach((d)=> pushUnique(d.id, d.data() || {}));
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const qB = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('ownerId', '==', targetUid),
                    firebase.where('public', '==', true),
                    firebase.limit(Math.max(20, limit))
                );
                const sB = await firebase.getDocs(qB);
                sB.forEach((d)=> pushUnique(d.id, d.data() || {}));
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q2 = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('owner', '==', targetUid),
                    firebase.where('visibility', '==', 'public'),
                    firebase.limit(Math.max(20, limit))
                );
                const s2 = await firebase.getDocs(q2);
                s2.forEach((d)=> pushUnique(d.id, d.data() || {}));
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q2a = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('owner', '==', targetUid),
                    firebase.where('isPublic', '==', true),
                    firebase.limit(Math.max(20, limit))
                );
                const s2a = await firebase.getDocs(q2a);
                s2a.forEach((d)=> pushUnique(d.id, d.data() || {}));
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q2b = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('owner', '==', targetUid),
                    firebase.where('public', '==', true),
                    firebase.limit(Math.max(20, limit))
                );
                const s2b = await firebase.getDocs(q2b);
                s2b.forEach((d)=> pushUnique(d.id, d.data() || {}));
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q3 = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('visibility', '==', 'public'),
                    firebase.limit(300)
                );
                const s3 = await firebase.getDocs(q3);
                s3.forEach((d)=>{ const p = d.data() || {}; if (matchesOwner(p)) pushUnique(d.id, p); });
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q3a = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('isPublic', '==', true),
                    firebase.limit(300)
                );
                const s3a = await firebase.getDocs(q3a);
                s3a.forEach((d)=>{ const p = d.data() || {}; if (matchesOwner(p)) pushUnique(d.id, p); });
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q3b = firebase.query(
                    firebase.collection(window.firebaseService.db, 'playlists'),
                    firebase.where('public', '==', true),
                    firebase.limit(300)
                );
                const s3b = await firebase.getDocs(q3b);
                s3b.forEach((d)=>{ const p = d.data() || {}; if (matchesOwner(p)) pushUnique(d.id, p); });
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q4 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('ownerId','==', targetUid));
                const s4 = await firebase.getDocs(q4);
                s4.forEach((d)=>{ const p = d.data() || {}; if (isPublic(p)) pushUnique(d.id, p); });
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q5 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('owner','==', targetUid));
                const s5 = await firebase.getDocs(q5);
                s5.forEach((d)=>{ const p = d.data() || {}; if (isPublic(p)) pushUnique(d.id, p); });
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q6 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('userId','==', targetUid));
                const s6 = await firebase.getDocs(q6);
                s6.forEach((d)=>{ const p = d.data() || {}; if (isPublic(p)) pushUnique(d.id, p); });
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const q7 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('authorId','==', targetUid));
                const s7 = await firebase.getDocs(q7);
                s7.forEach((d)=>{ const p = d.data() || {}; if (isPublic(p)) pushUnique(d.id, p); });
            }catch(_){ }
        }
        if (!rows.length){
            try{
                const me = await this.resolveCurrentUser();
                if (String(me?.uid || '').trim() === targetUid){
                    const mine = await this.hydratePlaylistsFromCloud();
                    (mine || []).forEach((p)=>{
                        if (matchesOwner(p) && isPublic(p)){
                            pushUnique(p.id, p);
                        }
                    });
                }
            }catch(_){ }
        }
        rows.sort((a,b)=> new Date(b.updatedAt||0) - new Date(a.updatedAt||0));
        return rows.slice(0, Math.max(1, limit));
    }

    looksLikeGeneratedMediaName(name){
        const v = String(name || '').trim().toLowerCase();
        if (!v) return true;
        if (/^\d{9,}$/.test(v)) return true;
        if (/^\d{9,}[_\-\s]/.test(v)) return true;
        if (/^[a-z0-9]{20,}$/.test(v) && !v.includes(' ')) return true;
        return false;
    }

    getCachedWaveMetaByUrl(url){
        const key = String(url || '').trim();
        if (!key) return null;
        return this._waveMetaByUrl.get(key) || null;
    }

    getCachedVideoMetaByUrl(url){
        const key = String(url || '').trim();
        if (!key) return null;
        return this._videoMetaByUrl.get(key) || null;
    }

    async fetchWaveMetaByUrl(url){
        const key = String(url || '').trim();
        if (!key || !(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return null;
        if (this._waveMetaByUrl.has(key)) return this._waveMetaByUrl.get(key) || null;
        if (this._waveMetaPendingByUrl.has(key)) return this._waveMetaPendingByUrl.get(key);
        const task = (async ()=>{
            let meta = null;
            try{
                const q = firebase.query(
                    firebase.collection(window.firebaseService.db, 'wave'),
                    firebase.where('url', '==', key),
                    firebase.limit(1)
                );
                const s = await firebase.getDocs(q);
                const d = s?.docs?.[0];
                if (d){
                    const w = d.data() || {};
                    meta = {
                        title: String(w.title || '').trim(),
                        coverUrl: String(w.coverUrl || '').trim(),
                        authorName: String(w.authorName || '').trim()
                    };
                }
            }catch(_){ }
            this._waveMetaByUrl.set(key, meta);
            this._waveMetaPendingByUrl.delete(key);
            return meta;
        })();
        this._waveMetaPendingByUrl.set(key, task);
        return task;
    }

    async fetchVideoMetaByUrl(url){
        const key = String(url || '').trim();
        if (!key || !(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return null;
        if (this._videoMetaByUrl.has(key)) return this._videoMetaByUrl.get(key) || null;
        if (this._videoMetaPendingByUrl.has(key)) return this._videoMetaPendingByUrl.get(key);
        const task = (async ()=>{
            let meta = null;
            try{
                const q = firebase.query(
                    firebase.collection(window.firebaseService.db, 'videos'),
                    firebase.where('url', '==', key),
                    firebase.limit(1)
                );
                const s = await firebase.getDocs(q);
                const d = s?.docs?.[0];
                if (d){
                    const v = d.data() || {};
                    meta = {
                        title: String(v.title || '').trim(),
                        coverUrl: String(v.thumbnailUrl || v.coverUrl || '').trim(),
                        authorName: String(v.authorName || '').trim()
                    };
                }
            }catch(_){ }
            this._videoMetaByUrl.set(key, meta);
            this._videoMetaPendingByUrl.delete(key);
            return meta;
        })();
        this._videoMetaPendingByUrl.set(key, task);
        return task;
    }

    async primeWaveMetaForMedia(media){
        try{
            const items = this.normalizePostMediaItems(media);
            const audioUrls = [];
            const videoUrls = [];
            items.forEach((it)=>{
                if (it.kind === 'audio' && it.url && !this._waveMetaByUrl.has(String(it.url).trim())){
                    audioUrls.push(String(it.url).trim());
                }
                if (it.kind === 'video' && it.url && !this._videoMetaByUrl.has(String(it.url).trim())){
                    videoUrls.push(String(it.url).trim());
                }
            });
            const tasks = [];
            if (audioUrls.length){
                const uniqueAudio = Array.from(new Set(audioUrls));
                tasks.push(...uniqueAudio.slice(0, 20).map((u)=> this.fetchWaveMetaByUrl(u)));
            }
            if (videoUrls.length){
                const uniqueVideo = Array.from(new Set(videoUrls));
                tasks.push(...uniqueVideo.slice(0, 20).map((u)=> this.fetchVideoMetaByUrl(u)));
            }
            if (!tasks.length) return;
            await Promise.all(tasks);
        }catch(_){ }
    }

    getMaxPostAttachments(){
        return 10;
    }

    getSpacePostAttachments(){
        return Array.isArray(this._spacePostAttachments) ? this._spacePostAttachments : [];
    }

    getSpaceAttachmentSignature(item){
        try{
            if (!item || typeof item !== 'object') return '';
            return [
                String(item.kind || ''),
                String(item.playlistId || ''),
                String(item.playlistCategory || item.category || ''),
                String(item.url || ''),
                String(item.name || ''),
                String(item.size || 0),
                String(item.lastModified || 0)
            ].join('|');
        }catch(_){ return ''; }
    }

    addUniqueSpaceAttachment(next, item){
        try{
            if (!item || typeof item !== 'object') return false;
            const sig = this.getSpaceAttachmentSignature(item);
            if (!sig) return false;
            const exists = next.some((x)=> this.getSpaceAttachmentSignature(x) === sig);
            if (exists) return false;
            next.push(item);
            return true;
        }catch(_){ return false; }
    }

    resetSpacePostComposer(){
        (this._spacePostAttachments || []).forEach((it)=>{
            const u = String(it?.previewUrl || '').trim();
            if (u){
                try{ URL.revokeObjectURL(u); }catch(_){ }
            }
        });
        this._spacePostAttachments = [];
        const mediaInput = document.getElementById('space-post-media');
        if (mediaInput) mediaInput.value = '';
        this.renderSpacePostComposerQueue();
    }

    queueSpacePostFileAttachments(files){
        const list = Array.from(files || []).filter((f)=> f instanceof File);
        if (!list.length) return;
        const current = this.getSpacePostAttachments();
        const max = this.getMaxPostAttachments();
        const next = current.slice();
        list.forEach((f)=>{
            if (next.length >= max) return;
            this.addUniqueSpaceAttachment(next, {
                kind: this.inferMediaKindFromUrl(f.name || '') === 'file' ? (String(f.type || '').startsWith('image/') ? 'image' : (String(f.type || '').startsWith('video/') ? 'video' : (String(f.type || '').startsWith('audio/') ? 'audio' : 'file'))) : this.inferMediaKindFromUrl(f.name || ''),
                name: f.name || 'file',
                size: Number(f.size || 0),
                lastModified: Number(f.lastModified || 0),
                file: f,
                previewUrl: (String(f.type || '').startsWith('image/') || String(f.type || '').startsWith('video/')) ? URL.createObjectURL(f) : ''
            });
        });
        this._spacePostAttachments = next;
        if (next.length >= max && (current.length + list.length) > max){
            this.showError(`Max ${max} attachments per post`);
        }
        this.renderSpacePostComposerQueue();
    }

    async openSpacePostWavePicker(){
        try{
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid) return;
            const audioRows = [];
            const videoRows = [];
            const playlists = await this.hydratePlaylistsFromCloud().catch(()=> []);
            try{
                const q = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', me.uid), firebase.orderBy('createdAt','desc'), firebase.limit(60));
                const s = await firebase.getDocs(q);
                s.forEach((d)=> audioRows.push(d.data() || {}));
            }catch(_){
                const q2 = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', me.uid));
                const s2 = await firebase.getDocs(q2);
                s2.forEach((d)=> audioRows.push(d.data() || {}));
                audioRows.sort((a,b)=> new Date(b.createdAt||0) - new Date(a.createdAt||0));
            }
            try{
                const qv = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', me.uid), firebase.orderBy('createdAtTS','desc'), firebase.limit(60));
                const sv = await firebase.getDocs(qv);
                sv.forEach((d)=> videoRows.push(d.data() || {}));
            }catch(_){
                try{
                    const qv2 = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', me.uid));
                    const sv2 = await firebase.getDocs(qv2);
                    sv2.forEach((d)=> videoRows.push(d.data() || {}));
                    videoRows.sort((a,b)=> (b.createdAtTS?.toMillis?.()||0) - (a.createdAtTS?.toMillis?.()||0) || new Date(b.createdAt||0) - new Date(a.createdAt||0));
                }catch(__){ }
            }
            audioRows.forEach((w)=>{
                const key = String(w?.url || '').trim();
                if (!key) return;
                this._waveMetaByUrl.set(key, {
                    title: String(w?.title || '').trim(),
                    coverUrl: String(w?.coverUrl || '').trim(),
                    authorName: String(w?.authorName || '').trim()
                });
            });
            videoRows.forEach((v)=>{
                const key = String(v?.url || '').trim();
                if (!key) return;
                this._videoMetaByUrl.set(key, {
                    title: String(v?.title || '').trim(),
                    coverUrl: String(v?.thumbnailUrl || v?.coverUrl || '').trim(),
                    authorName: String(v?.authorName || '').trim()
                });
            });
            const rows = [
                ...audioRows.map((w)=> ({ type:'audio', data:w })),
                ...videoRows.map((v)=> {
                    const mediaType = String(v?.mediaType || 'video');
                    const sourceType = String(v?.sourceMediaType || '').toLowerCase();
                    const inferred = sourceType === 'image' ? 'image' : (sourceType === 'video' ? 'video' : mediaType);
                    return ({ type: inferred === 'image' ? 'image' : 'video', data: v });
                })
            ];
            rows.sort((a,b)=> new Date(b.data?.createdAt||0) - new Date(a.data?.createdAt||0));
            const category = {
                audio: rows.filter((x)=> x.type === 'audio'),
                video: rows.filter((x)=> x.type === 'video'),
                picture: rows.filter((x)=> x.type === 'image'),
                playlists: (Array.isArray(playlists) ? playlists : []).filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) !== 'image'),
                albums: (Array.isArray(playlists) ? playlists : []).filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'image')
            };
            const hasAny = category.audio.length || category.video.length || category.picture.length || category.playlists.length || category.albums.length;
            if (!hasAny){ this.showError('No WaveConnect media found'); return; }
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:16px';
            overlay.innerHTML = `<div style="width:min(96vw,760px);max-height:80vh;overflow:auto;background:#0f1724;border:1px solid #2b3445;border-radius:14px;padding:12px"><div style="font-weight:700;margin-bottom:8px">Add from WaveConnect</div><div id="space-wave-picker-list" style="display:grid;gap:10px"></div><div style="display:flex;justify-content:flex-end;margin-top:10px"><button id="space-wave-picker-close" class="btn btn-secondary">Close</button></div></div>`;
            const list = overlay.querySelector('#space-wave-picker-list');
            const addPayloadToComposer = (payload)=>{
                const cur = this.getSpacePostAttachments();
                if (cur.length >= this.getMaxPostAttachments()){ this.showError(`Max ${this.getMaxPostAttachments()} attachments`); return false; }
                const next = cur.slice();
                const added = this.addUniqueSpaceAttachment(next, payload);
                if (!added){ this.showError('Already added'); return false; }
                this._spacePostAttachments = next;
                this.renderSpacePostComposerQueue();
                overlay.remove();
                return true;
            };
            const renderSection = (title, items, buildRow, mountHost)=>{
                if (!mountHost || !items.length) return;
                const sec = document.createElement('div');
                sec.className = 'wave-home-card';
                sec.style.margin = '0';
                const h = document.createElement('div');
                h.style.cssText = 'font-weight:700;margin-bottom:8px';
                h.textContent = title;
                const wrap = document.createElement('div');
                wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px';
                items.slice(0, 40).forEach((it)=> wrap.appendChild(buildRow(it)));
                sec.appendChild(h);
                sec.appendChild(wrap);
                mountHost.appendChild(sec);
            };
            const mediaCard = (entry)=>{
                const w = entry.data || {};
                const isVideo = entry.type === 'video';
                const isImage = entry.type === 'image';
                const cover = String(w.thumbnailUrl || w.coverUrl || w.url || '').trim() || 'images/default-bird.png';
                const btn = document.createElement('button');
                btn.className = 'btn btn-secondary';
                btn.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;text-align:left';
                btn.innerHTML = `<img src="${cover.replace(/"/g,'&quot;')}" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover;flex:0 0 auto"><span style="min-width:0;display:flex;flex-direction:column"><span style="font-size:11px;opacity:.72;text-transform:uppercase">${isVideo ? 'Video' : (isImage ? 'Picture' : 'Audio')}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(w.title || (isVideo ? 'Video' : (isImage ? 'Picture' : 'Audio'))).replace(/</g,'&lt;')}</span></span>`;
                btn.onclick = ()=>{
                    const payload = isVideo
                        ? { kind:'video', url: String(w.url || ''), name: String(w.title || 'Video'), by: String(w.authorName || ''), cover: String(w.thumbnailUrl || w.coverUrl || ''), sourceId: String(w.id || '') }
                        : (isImage
                        ? { kind:'image', url: String(w.url || ''), name: String(w.title || 'Picture'), by: String(w.authorName || ''), cover: String(w.thumbnailUrl || w.coverUrl || w.url || ''), sourceId: String(w.id || '') }
                        : { kind:'audio', url: String(w.url || ''), name: String(w.title || 'Audio'), by: String(w.authorName || ''), cover: String(w.coverUrl || ''), sourceId: String(w.id || '') });
                    addPayloadToComposer(payload);
                };
                return btn;
            };
            const playlistCard = (pl, asAlbum = false)=>{
                const items = Array.isArray(pl?.items) ? pl.items : [];
                const cover = String(items[0]?.cover || '').trim() || 'images/default-bird.png';
                const cat = this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, items);
                const kind = asAlbum ? 'Album' : (cat === 'video' ? 'Video Playlist' : 'Playlist');
                const btn = document.createElement('button');
                btn.className = 'btn btn-secondary';
                btn.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;text-align:left';
                btn.innerHTML = `<img src="${cover.replace(/"/g,'&quot;')}" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover;flex:0 0 auto"><span style="min-width:0;display:flex;flex-direction:column"><span style="font-size:11px;opacity:.72;text-transform:uppercase">${kind}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(pl?.name || kind).replace(/</g,'&lt;')}</span><span style="font-size:11px;opacity:.7">${items.length} items</span></span>`;
                btn.onclick = ()=> addPayloadToComposer({
                    kind:'playlist',
                    playlistCategory: cat,
                    name: String(pl?.name || kind),
                    playlistId: String(pl?.id || ''),
                    by: String(pl?.ownerName || ''),
                    cover: String(items[0]?.cover || ''),
                    items: items.slice(0, 120)
                });
                return btn;
            };
            const tabs = document.createElement('div');
            tabs.className = 'liber-tab-selector';
            tabs.style.margin = '2px 0 8px';
            tabs.innerHTML = `
              <button type="button" class="btn btn-secondary active" data-space-wave-tab="audio">Audio</button>
              <button type="button" class="btn btn-secondary" data-space-wave-tab="video">Video</button>
              <button type="button" class="btn btn-secondary" data-space-wave-tab="pictures">Pictures</button>
            `;
            const panes = document.createElement('div');
            panes.innerHTML = `
              <div data-space-wave-pane="audio" style="display:grid;gap:10px"></div>
              <div data-space-wave-pane="video" style="display:none;gap:10px"></div>
              <div data-space-wave-pane="pictures" style="display:none;gap:10px"></div>
            `;
            list.appendChild(tabs);
            list.appendChild(panes);
            const paneAudio = panes.querySelector('[data-space-wave-pane="audio"]');
            const paneVideo = panes.querySelector('[data-space-wave-pane="video"]');
            const panePics = panes.querySelector('[data-space-wave-pane="pictures"]');

            renderSection('Audio', category.audio, mediaCard, paneAudio);
            renderSection('Playlists', category.playlists.filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'audio'), (pl)=> playlistCard(pl, false), paneAudio);
            renderSection('Video', category.video, mediaCard, paneVideo);
            renderSection('Video Playlists', category.playlists.filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'video'), (pl)=> playlistCard(pl, false), paneVideo);
            renderSection('Pictures', category.picture, mediaCard, panePics);
            renderSection('Albums', category.albums, (pl)=> playlistCard(pl, true), panePics);

            const ensureEmpty = (pane, text)=>{
                if (!pane) return;
                if (pane.children.length) return;
                pane.innerHTML = `<div style="opacity:.75">${text}</div>`;
            };
            ensureEmpty(paneAudio, 'No audio items yet.');
            ensureEmpty(paneVideo, 'No video items yet.');
            ensureEmpty(panePics, 'No picture items yet.');

            tabs.querySelectorAll('[data-space-wave-tab]').forEach((btn)=>{
                btn.addEventListener('click', ()=>{
                    const tab = String(btn.getAttribute('data-space-wave-tab') || 'audio');
                    tabs.querySelectorAll('[data-space-wave-tab]').forEach((x)=> x.classList.toggle('active', x === btn));
                    if (paneAudio) paneAudio.style.display = tab === 'audio' ? 'grid' : 'none';
                    if (paneVideo) paneVideo.style.display = tab === 'video' ? 'grid' : 'none';
                    if (panePics) panePics.style.display = tab === 'pictures' ? 'grid' : 'none';
                });
            });
            overlay.querySelector('#space-wave-picker-close').onclick = ()=> overlay.remove();
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);
        }catch(_){ this.showError('Failed to load WaveConnect items'); }
    }

    async openWaveConnectPickerForChat(onSelect){
        try{
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid) return;
            const audioRows = []; const videoRows = [];
            try{
                const q = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', me.uid), firebase.orderBy('createdAt','desc'), firebase.limit(60));
                const s = await firebase.getDocs(q); s.forEach((d)=> audioRows.push(d.data() || {}));
            }catch(_){
                try{
                    const q2 = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', me.uid));
                    const s2 = await firebase.getDocs(q2); s2.forEach((d)=> audioRows.push(d.data() || {}));
                }catch(__){ }
            }
            try{
                const qv = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', me.uid), firebase.orderBy('createdAtTS','desc'), firebase.limit(60));
                const sv = await firebase.getDocs(qv); sv.forEach((d)=> videoRows.push(d.data() || {}));
            }catch(_){
                try{
                    const qv2 = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', me.uid));
                    const sv2 = await firebase.getDocs(qv2); sv2.forEach((d)=> videoRows.push(d.data() || {}));
                }catch(__){ }
            }
            const rows = [
                ...audioRows.map((w)=> ({ type:'audio', data:w })),
                ...videoRows.map((v)=> {
                    const mediaType = String(v?.mediaType || 'video');
                    const sourceType = String(v?.sourceMediaType || '').toLowerCase();
                    const inferred = sourceType === 'image' ? 'image' : (sourceType === 'video' ? 'video' : mediaType);
                    return ({ type: inferred === 'image' ? 'image' : 'video', data: v });
                })
            ];
            rows.sort((a,b)=> new Date(b.data?.createdAt||0) - new Date(a.data?.createdAt||0));
            if (!rows.length){ this.showError('No WaveConnect media found'); return; }
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:16px';
            overlay.innerHTML = `<div style="width:min(96vw,560px);max-height:76vh;overflow:auto;background:#0f1724;border:1px solid #2b3445;border-radius:12px;padding:12px"><div style="font-weight:700;margin-bottom:8px">Add from WaveConnect (to composer)</div><div id="chat-wave-picker-list"></div><div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="chat-wave-picker-close" class="btn btn-secondary">Close</button></div></div>`;
            const list = overlay.querySelector('#chat-wave-picker-list');
            rows.slice(0,80).forEach((entry)=>{
                const w = entry.data || {};
                const isVideo = entry.type === 'video';
                const isImage = entry.type === 'image';
                const btn = document.createElement('button');
                btn.className = 'btn btn-secondary';
                btn.style.cssText = 'width:100%;text-align:left;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
                btn.innerHTML = `<i class="fas ${isVideo ? 'fa-video' : (isImage ? 'fa-image' : 'fa-music')}"></i> ${(w.title || (isVideo ? 'Video' : (isImage ? 'Picture' : 'Audio'))).replace(/</g,'&lt;')}`;
                btn.onclick = ()=>{
                    const payload = isVideo
                        ? { kind:'video', url: String(w.url || ''), title: String(w.title || 'Video'), name: String(w.title || 'Video'), by: String(w.authorName || ''), authorName: String(w.authorName || ''), cover: String(w.thumbnailUrl || w.coverUrl || ''), thumbnailUrl: String(w.thumbnailUrl || w.coverUrl || ''), sourceId: String(w.id || '') }
                        : (isImage
                        ? { kind:'image', url: String(w.url || ''), title: String(w.title || 'Picture'), name: String(w.title || 'Picture'), by: String(w.authorName || ''), authorName: String(w.authorName || ''), cover: String(w.thumbnailUrl || w.coverUrl || w.url || ''), thumbnailUrl: String(w.thumbnailUrl || w.coverUrl || w.url || ''), sourceId: String(w.id || '') }
                        : { kind:'audio', url: String(w.url || ''), title: String(w.title || 'Audio'), name: String(w.title || 'Audio'), by: String(w.authorName || ''), authorName: String(w.authorName || ''), cover: String(w.coverUrl || ''), coverUrl: String(w.coverUrl || ''), sourceId: String(w.id || '') });
                    if (typeof onSelect === 'function') onSelect(payload);
                    overlay.remove();
                };
                list.appendChild(btn);
            });
            overlay.querySelector('#chat-wave-picker-close').onclick = ()=> overlay.remove();
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);
        }catch(_){ this.showError('Failed to load WaveConnect items'); }
    }

    async openSpacePostPlaylistPicker(){
        try{
            const rows = await this.hydratePlaylistsFromCloud();
            if (!rows.length){ this.showError('No playlists found'); return; }
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:16px';
            overlay.innerHTML = `<div style="width:min(96vw,680px);max-height:78vh;overflow:auto;background:#0f1724;border:1px solid #2b3445;border-radius:12px;padding:12px"><div style="font-weight:700;margin-bottom:8px">Add collection to post</div><div id="space-playlist-picker-list" style="display:grid;gap:10px"></div><div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="space-playlist-picker-close" class="btn btn-secondary">Close</button></div></div>`;
            const list = overlay.querySelector('#space-playlist-picker-list');
            const all = Array.isArray(rows) ? rows : [];
            const byCat = {
                audio: all.filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'audio'),
                video: all.filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'video'),
                image: all.filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'image')
            };
            const addToPost = (pl, cat)=>{
                const cur = this.getSpacePostAttachments();
                if (cur.length >= this.getMaxPostAttachments()){ this.showError(`Max ${this.getMaxPostAttachments()} attachments`); return; }
                const next = cur.slice();
                const added = this.addUniqueSpaceAttachment(next, {
                    kind:'playlist',
                    playlistCategory: cat,
                    name: String(pl.name || (cat === 'image' ? 'Album' : 'Playlist')),
                    playlistId: String(pl.id || ''),
                    by: String(pl.ownerName || ''),
                    cover: String((pl.items && pl.items[0] && pl.items[0].cover) || ''),
                    items: Array.isArray(pl.items) ? pl.items.slice(0, 120) : []
                });
                if (!added){ this.showError('Already added'); return; }
                this._spacePostAttachments = next;
                this.renderSpacePostComposerQueue();
                overlay.remove();
            };
            const renderSection = (title, rowsInSection, icon)=>{
                if (!rowsInSection.length) return;
                const section = document.createElement('div');
                section.className = 'wave-home-card';
                section.style.margin = '0';
                section.innerHTML = `<div style="font-weight:700;margin-bottom:8px">${title}</div>`;
                const grid = document.createElement('div');
                grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px';
                rowsInSection.slice(0, 50).forEach((pl)=>{
                    const tracks = Array.isArray(pl.items) ? pl.items.length : 0;
                    const cover = String((pl.items && pl.items[0] && pl.items[0].cover) || '').trim() || 'images/default-bird.png';
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-secondary';
                    btn.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;text-align:left';
                    btn.innerHTML = `<img src="${cover.replace(/"/g,'&quot;')}" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover;flex:0 0 auto"><span style="min-width:0;display:flex;flex-direction:column"><span style="font-size:11px;opacity:.72;text-transform:uppercase"><i class="fas ${icon}"></i> ${title}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(pl.name || 'Collection').replace(/</g,'&lt;')}</span><span style="font-size:11px;opacity:.72">${tracks} items</span></span>`;
                    btn.onclick = ()=> addToPost(pl, this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items));
                    grid.appendChild(btn);
                });
                section.appendChild(grid);
                list.appendChild(section);
            };
            renderSection('Audio Playlists', byCat.audio, 'fa-list-music');
            renderSection('Video Playlists', byCat.video, 'fa-photo-film');
            renderSection('Picture Albums', byCat.image, 'fa-images');
            overlay.querySelector('#space-playlist-picker-close').onclick = ()=> overlay.remove();
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);
        }catch(_){ this.showError('Failed to load playlists'); }
    }

    renderSpacePostComposerQueue(){
        const previews = document.getElementById('space-media-previews');
        const countEl = document.getElementById('space-post-attach-count');
        if (!previews) return;
        const items = this.getSpacePostAttachments();
        if (countEl) countEl.textContent = `${items.length}/${this.getMaxPostAttachments()}`;
        previews.innerHTML = '';
        if (!items.length) return;
        const visual = items.filter((it)=> it.kind === 'image' || it.kind === 'video');
        const rest = items.filter((it)=> !(it.kind === 'image' || it.kind === 'video'));
        if (visual.length){
            const row = document.createElement('div');
            row.className = 'space-post-visual-slider';
            visual.forEach((it)=>{
                const idx = items.indexOf(it);
                const card = document.createElement('div');
                card.className = 'space-post-preview-card';
                const src = String(it.previewUrl || it.url || '');
                card.innerHTML = `${it.kind === 'video' ? `<video src="${src}" muted playsinline></video>` : `<img src="${src}" alt="preview">`}<button type="button" class="space-post-preview-remove" title="Remove"><i class="fas fa-xmark"></i></button>`;
                const rm = card.querySelector('.space-post-preview-remove');
                if (rm){
                    rm.onclick = ()=>{
                        const u = String(items[idx]?.previewUrl || '').trim();
                        if (u){
                            try{ URL.revokeObjectURL(u); }catch(_){ }
                        }
                        this._spacePostAttachments.splice(idx, 1);
                        this.renderSpacePostComposerQueue();
                    };
                }
                row.appendChild(card);
            });
            previews.appendChild(row);
        }
        if (rest.length){
            const list = document.createElement('div');
            list.className = 'space-post-files-list';
            rest.forEach((it)=>{
                const idx = items.indexOf(it);
                const row = document.createElement('div');
                row.className = 'space-post-file-row';
                const plCat = this.normalizePlaylistCategory(it?.playlistCategory || it?.category, it?.items);
                const icon = it.kind === 'audio' ? 'fa-music' : (it.kind === 'playlist' ? (plCat === 'image' ? 'fa-images' : (plCat === 'video' ? 'fa-photo-film' : 'fa-list-music')) : 'fa-paperclip');
                const label = it.kind === 'playlist'
                    ? `${plCat === 'image' ? 'Album' : (plCat === 'video' ? 'Video playlist' : 'Playlist')}: ${it.name || (plCat === 'image' ? 'Album' : 'Playlist')}`
                    : (it.name || 'file');
                row.innerHTML = `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="fas ${icon}"></i> ${String(label).replace(/</g,'&lt;')}</span><button type="button" class="space-post-file-remove"><i class="fas fa-xmark"></i></button>`;
                const rm = row.querySelector('.space-post-file-remove');
                if (rm){
                    rm.onclick = ()=>{
                        this._spacePostAttachments.splice(idx, 1);
                        this.renderSpacePostComposerQueue();
                    };
                }
                list.appendChild(row);
            });
            previews.appendChild(list);
        }
    }

    clearPostActionListeners(container){
        try{
            if (!container) return;
            if (this._postActionUnsubsByContainer && this._postActionUnsubsByContainer.get(container)) {
                this._postActionUnsubsByContainer.get(container).forEach((u) => { try { u(); } catch (_) {} });
                this._postActionUnsubsByContainer.set(container, []);
            }
        }catch(_){ }
    }

    suspendDashboardActivity(){
        this._dashboardSuspended = true;
        this.clearPostActionListeners(document.getElementById('global-feed'));
        this.clearPostActionListeners(document.getElementById('space-feed'));
    }

    resumeDashboardActivity(){
        const wasSuspended = this._dashboardSuspended;
        this._dashboardSuspended = false;
        if (!wasSuspended) return;
        if (this.currentSection === 'feed') this.loadGlobalFeed();
        if (this.currentSection === 'space') this.loadSpace();
    }

    getOrCreateDeviceId(){
        try{
            const existing = localStorage.getItem('liber_device_id');
            if (existing) return existing;
            const base = [
                navigator.userAgent || '',
                navigator.platform || '',
                navigator.language || '',
                Intl.DateTimeFormat().resolvedOptions().timeZone || ''
            ].join('|');
            const encoded = btoa(unescape(encodeURIComponent(base))).replace(/[^a-zA-Z0-9]/g, '');
            const id = `dv_${encoded.slice(0, 64)}`;
            localStorage.setItem('liber_device_id', id);
            return id;
        }catch(_){
            const id = `dv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
            try{ localStorage.setItem('liber_device_id', id); }catch(__){ }
            return id;
        }
    }

    async updateVerificationBanner(){
        try{
            let banner = document.getElementById('verify-warning-banner');
            const authUser = window.firebaseService?.auth?.currentUser || null;
            const shouldShow = !!(authUser && authUser.uid && authUser.email && !authUser.emailVerified);
            if (!shouldShow){
                if (banner) banner.remove();
                return;
            }
            if (!banner){
                banner = document.createElement('div');
                banner.id = 'verify-warning-banner';
                banner.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:1200;background:#b91c1c;color:#fff;padding:10px 12px;border-radius:10px;display:flex;gap:10px;align-items:center;max-width:min(92vw,560px);box-shadow:0 8px 24px rgba(0,0,0,.35)';
                banner.innerHTML = `<span style="font-size:13px;line-height:1.3">Accounts not verified in 7 days after register are being deleted.</span>
                                    <button id="verify-warning-resend" class="btn btn-secondary" style="white-space:nowrap">Resend verification</button>`;
                document.body.appendChild(banner);
            }
            const resendBtn = banner.querySelector('#verify-warning-resend');
            if (resendBtn && !resendBtn._bound){
                resendBtn._bound = true;
                resendBtn.onclick = async ()=>{
                    try{
                        resendBtn.disabled = true;
                        const ok = await window.firebaseService.sendEmailVerification();
                        if (ok !== false) this.showSuccess('Verification email sent. The letter may appear in your spam folder.');
                        else this.showError('Failed to send verification email');
                    }catch(_){ this.showError('Failed to send verification email'); }
                    finally{ resendBtn.disabled = false; }
                };
            }
        }catch(_){ }
    }

    inferMediaKindFromUrl(url){
        const href = String(url || '');
            let pathOnly = href;
            try{ pathOnly = new URL(href).pathname; }catch(_){ pathOnly = href.split('?')[0].split('#')[0]; }
            const lower = pathOnly.toLowerCase();
        if (['.png','.jpg','.jpeg','.gif','.webp','.avif'].some((ext)=> lower.endsWith(ext))) return 'image';
        if (['.mp4','.webm','.mov','.mkv'].some((ext)=> lower.endsWith(ext))) return 'video';
        if (['.mp3','.wav','.m4a','.aac','.ogg','.oga','.weba'].some((ext)=> lower.endsWith(ext))) return 'audio';
        return 'file';
    }

    inferMediaNameFromUrl(url, fallback = ''){
        try{
            const href = String(url || '').trim();
            if (!href) return String(fallback || '').trim();
            // Firebase Storage download URLs often carry file path in "name=" or "/o/<encodedPath>"
            const parseFromPath = (rawPath)=>{
                const decoded = decodeURIComponent(String(rawPath || ''));
                const parts = decoded.split('/').filter(Boolean);
                const leaf = String(parts[parts.length - 1] || '').trim();
                if (!leaf) return '';
                const clean = leaf.replace(/\.[a-zA-Z0-9]{1,8}$/,'').replace(/[_-]+/g, ' ').trim();
                return clean || leaf;
            };
            try{
                const u = new URL(href);
                const nameParam = String(u.searchParams.get('name') || '').trim();
                if (nameParam){
                    const byName = parseFromPath(nameParam);
                    if (byName) return byName;
                }
                const seg = u.pathname.split('/o/')[1] || '';
                if (seg){
                    const bySeg = parseFromPath(seg.split('/')[0]);
                    if (bySeg) return bySeg;
                }
                const byPath = parseFromPath(u.pathname);
                if (byPath) return byPath;
            }catch(_){ }
            const noQuery = href.split('?')[0].split('#')[0];
            const byRaw = parseFromPath(noQuery);
            if (byRaw) return byRaw;
            return String(fallback || '').trim();
        }catch(_){ return String(fallback || '').trim(); }
    }

    isPostLibraryItem(item){
        const sourceType = String(item?.sourceType || item?.source || item?.sourceLabel || '').toLowerCase();
        return sourceType === 'post' || sourceType === 'posts' || !!item?.sourcePostId;
    }

    async filterRowsBySourcePostPrivacy(rows, opts = {}){
        try{
            const list = Array.isArray(rows) ? rows : [];
            if (!list.length) return [];
            const isOwnerView = opts?.isOwnerView === true;
            if (isOwnerView) return list;
            const cache = new Map();
            const isPublicPost = async (postId)=>{
                const pid = String(postId || '').trim();
                if (!pid) return false;
                if (cache.has(pid)) return cache.get(pid) === true;
                let ok = false;
                try{
                    const snap = await firebase.getDoc(firebase.doc(window.firebaseService.db, 'posts', pid));
                    if (snap.exists()){
                        const p = snap.data() || {};
                        const vis = String(p.visibility || '').trim().toLowerCase();
                        ok = vis === 'public' || vis === 'pub' || p.isPublic === true || p.public === true;
                    }
                }catch(_){ ok = false; }
                cache.set(pid, !!ok);
                return !!ok;
            };
            const out = [];
            for (const row of list){
                const fromPost = this.isPostLibraryItem(row);
                if (!fromPost){
                    out.push(row);
                    continue;
                }
                const sourcePostId = String(row?.sourcePostId || '').trim();
                if (!sourcePostId){
                    continue; // cannot prove visibility for post-origin asset
                }
                if (await isPublicPost(sourcePostId)){
                    out.push(row);
                }
            }
            return out;
        }catch(_){ return Array.isArray(rows) ? rows : []; }
    }

    extractSyncableMediaFromPost(post){
        const p = post || {};
        const raw = Array.isArray(p.media) ? p.media : (p.mediaUrl ? [p.mediaUrl] : []);
        const out = [];
        raw.forEach((entry)=>{
            if (!entry) return;
            const isObj = entry && typeof entry === 'object' && !Array.isArray(entry);
            const url = String(isObj ? (entry.url || entry.mediaUrl || '') : (entry || '')).trim();
            if (!url) return;
            const kindRaw = String(isObj ? (entry.kind || entry.mediaType || entry.type || '') : '').toLowerCase().trim();
            const kind = ['audio','video','image'].includes(kindRaw) ? kindRaw : this.inferMediaKindFromUrl(url);
            if (!['audio','video','image'].includes(kind)) return;
            const title = String(isObj ? (entry.name || entry.title || '') : '').trim()
                || this.inferMediaNameFromUrl(url, kind === 'audio' ? 'Audio' : (kind === 'video' ? 'Video' : 'Picture'));
            const by = String(isObj ? (entry.by || entry.authorName || '') : '').trim() || String(p.authorName || '').trim();
            const cover = String(isObj ? (entry.cover || entry.coverUrl || entry.thumbnailUrl || '') : '').trim()
                || String(p.coverUrl || p.thumbnailUrl || '').trim();
            out.push({
                kind,
                url,
                title,
                by,
                cover,
                postId: String(p.id || '').trim()
            });
        });
        const seen = new Set();
        return out.filter((m)=>{
            const sig = `${m.kind}|${m.url}`;
            if (seen.has(sig)) return false;
            seen.add(sig);
            return true;
        });
    }

    async syncPostMediaToLibraries(uid, opts = {}){
        const userId = String(uid || '').trim();
        if (!userId) return { addedAudio: 0, addedVideo: 0, addedPictures: 0 };
        const force = !!opts.force;
        const state = this._postLibrarySyncState.get(userId) || {};
        const now = Date.now();
        if (!force && state.running) return state.running;
        if (!force && state.lastAt && (now - state.lastAt) < 120000){
            return { addedAudio: 0, addedVideo: 0, addedPictures: 0 };
        }
        const run = (async ()=>{
            let addedAudio = 0;
            let addedVideo = 0;
            let addedPictures = 0;
            try{
                let posts = Array.isArray(opts.posts) ? opts.posts.filter(Boolean) : [];
                if (!posts.length){
                    try{
                        const q = firebase.query(
                            firebase.collection(window.firebaseService.db, 'posts'),
                            firebase.where('authorId','==', userId),
                            firebase.orderBy('createdAtTS','desc'),
                            firebase.limit(250)
                        );
                        const s = await firebase.getDocs(q);
                        posts = (s.docs || []).map((d)=> d.data() || {});
                    }catch(_){
                        const q2 = firebase.query(firebase.collection(window.firebaseService.db, 'posts'), firebase.where('authorId','==', userId));
                        const s2 = await firebase.getDocs(q2);
                        posts = (s2.docs || []).map((d)=> d.data() || {});
                    }
                }
                const allMedia = [];
                posts.forEach((p)=> allMedia.push(...this.extractSyncableMediaFromPost(p)));
                if (!allMedia.length) return { addedAudio, addedVideo, addedPictures };
                const audioUrls = new Set();
                const videoUrls = new Set();
                const pictureUrls = new Set();
                try{
                    const qWave = firebase.query(firebase.collection(window.firebaseService.db, 'wave'), firebase.where('ownerId','==', userId), firebase.limit(800));
                    const sWave = await firebase.getDocs(qWave);
                    sWave.forEach((d)=>{
                        const w = d.data() || {};
                        const u = this.normalizeMediaUrl(String(w.url || ''));
                        if (u) audioUrls.add(u);
                    });
                }catch(_){ }
                try{
                    const qVid = firebase.query(firebase.collection(window.firebaseService.db, 'videos'), firebase.where('owner','==', userId), firebase.limit(1200));
                    const sVid = await firebase.getDocs(qVid);
                    sVid.forEach((d)=>{
                        const v = d.data() || {};
                        const url = String(v.url || '').trim();
                        if (!url) return;
                        const norm = this.normalizeMediaUrl(url);
                        if (!norm) return;
                        if (String(v.mediaType || '') === 'image') pictureUrls.add(norm);
                        else videoUrls.add(norm);
                    });
                }catch(_){ }
                const meData = await window.firebaseService.getUserData(userId).catch(()=> null);
                const myName = String(meData?.username || '').trim() || 'User';
                for (const m of allMedia){
                    if (m.kind === 'audio'){
                        const norm = this.normalizeMediaUrl(m.url);
                        if (norm && audioUrls.has(norm)) continue;
                        const ref = firebase.doc(firebase.collection(window.firebaseService.db, 'wave'));
                        await firebase.setDoc(ref, {
                            id: ref.id,
                            owner: userId,
                            ownerId: userId,
                            title: String(m.title || 'Audio'),
                            url: m.url,
                            createdAt: new Date().toISOString(),
                            createdAtTS: firebase.serverTimestamp(),
                            authorId: userId,
                            authorName: myName || String(m.by || ''),
                            coverUrl: String(m.cover || ''),
                            sourceType: 'post',
                            sourceLabel: 'posts',
                            sourcePostId: String(m.postId || '')
                        });
                        if (norm) audioUrls.add(norm);
                        addedAudio += 1;
                        continue;
                    }
                    if (m.kind === 'video'){
                        const norm = this.normalizeMediaUrl(m.url);
                        if (norm && videoUrls.has(norm)) continue;
                        const ref = firebase.doc(firebase.collection(window.firebaseService.db, 'videos'));
                        await firebase.setDoc(ref, {
                            id: ref.id,
                            owner: userId,
                            title: String(m.title || 'Video'),
                            url: m.url,
                            createdAt: new Date().toISOString(),
                            createdAtTS: firebase.serverTimestamp(),
                            visibility: 'public',
                            mediaType: 'video',
                            sourceMediaType: 'video',
                            authorId: userId,
                            authorName: myName || String(m.by || ''),
                            thumbnailUrl: String(m.cover || ''),
                            originalAuthorId: userId,
                            originalAuthorName: String(m.by || myName || ''),
                            sourceType: 'post',
                            sourceLabel: 'posts',
                            sourcePostId: String(m.postId || '')
                        });
                        if (norm) videoUrls.add(norm);
                        addedVideo += 1;
                        continue;
                    }
                    if (m.kind === 'image'){
                        const norm = this.normalizeMediaUrl(m.url);
                        if (norm && pictureUrls.has(norm)) continue;
                        const ref = firebase.doc(firebase.collection(window.firebaseService.db, 'videos'));
                        await firebase.setDoc(ref, {
                            id: ref.id,
                            owner: userId,
                            title: String(m.title || 'Picture'),
                            url: m.url,
                            createdAt: new Date().toISOString(),
                            createdAtTS: firebase.serverTimestamp(),
                            visibility: 'public',
                            mediaType: 'image',
                            sourceMediaType: 'image',
                            authorId: userId,
                            authorName: myName || String(m.by || ''),
                            thumbnailUrl: String(m.cover || m.url || ''),
                            originalAuthorId: userId,
                            originalAuthorName: String(m.by || myName || ''),
                            sourceType: 'post',
                            sourceLabel: 'posts',
                            sourcePostId: String(m.postId || '')
                        });
                        if (norm) pictureUrls.add(norm);
                        addedPictures += 1;
                    }
                }
            }catch(_){ }
            return { addedAudio, addedVideo, addedPictures };
        })();
        this._postLibrarySyncState.set(userId, { ...state, running: run, lastAt: now });
        try{
            const result = await run;
            const cur = this._postLibrarySyncState.get(userId) || {};
            this._postLibrarySyncState.set(userId, { ...cur, running: null, lastAt: Date.now() });
            return result;
        }catch(_){
            const cur = this._postLibrarySyncState.get(userId) || {};
            this._postLibrarySyncState.set(userId, { ...cur, running: null, lastAt: Date.now() });
            return { addedAudio: 0, addedVideo: 0, addedPictures: 0 };
        }
    }

    normalizePostMediaItems(media){
        const raw = Array.isArray(media) ? media : (media ? [media] : []);
        const out = [];
        raw.forEach((entry)=>{
            if (!entry) return;
            if (typeof entry === 'string'){
                const url = String(entry || '').trim();
                if (!url) return;
                const kind = this.inferMediaKindFromUrl(url);
                const waveMeta = this.getCachedWaveMetaByUrl(url);
                const videoMeta = this.getCachedVideoMetaByUrl(url);
                const sourceMeta = kind === 'video' ? videoMeta : waveMeta;
                const inferredName = this.inferMediaNameFromUrl(url, '');
                out.push({
                    kind,
                    url,
                    name: (sourceMeta?.title && this.looksLikeGeneratedMediaName(inferredName)) ? sourceMeta.title : inferredName,
                    by: String(sourceMeta?.authorName || '').trim(),
                    cover: String(sourceMeta?.coverUrl || '').trim()
                });
                return;
            }
            if (typeof entry === 'object'){
                const kind = String(entry.kind || entry.mediaType || '').trim().toLowerCase();
                const url = String(entry.url || entry.mediaUrl || '').trim();
                const name = String(entry.name || entry.title || '').trim();
                if (kind === 'playlist'){
                    out.push({
                        kind: 'playlist',
                        name: name || 'Playlist',
                        playlistId: String(entry.playlistId || entry.id || '').trim() || null,
                        playlistCategory: this.normalizePlaylistCategory(entry.playlistCategory || entry.category, entry.items),
                        by: String(entry.by || entry.authorName || '').trim(),
                        cover: String(entry.cover || entry.coverUrl || '').trim(),
                        items: Array.isArray(entry.items) ? entry.items.slice(0, 120) : []
                    });
                    return;
                }
                if (url){
                    const resolvedKind = ['image','video','audio','file'].includes(kind) ? kind : this.inferMediaKindFromUrl(url);
                    const waveMeta = this.getCachedWaveMetaByUrl(url);
                    const videoMeta = this.getCachedVideoMetaByUrl(url);
                    const sourceMeta = resolvedKind === 'video' ? videoMeta : waveMeta;
                    const inferredName = this.inferMediaNameFromUrl(url, '');
                    const resolvedNameBase = name || inferredName;
                    const resolvedName = (sourceMeta?.title && this.looksLikeGeneratedMediaName(resolvedNameBase)) ? sourceMeta.title : resolvedNameBase;
                    out.push({
                        kind: resolvedKind,
                        url,
                        name: resolvedName,
                        by: String(entry.by || entry.authorName || sourceMeta?.authorName || '').trim(),
                        cover: String(entry.cover || entry.coverUrl || sourceMeta?.coverUrl || '').trim()
                    });
                }
            }
        });
        return out;
    }

    getPostDisplayText(post){
        try{
            const raw = String(post?.text || '').trim();
            if (!raw) return '';
            const items = this.normalizePostMediaItems(post?.media || post?.mediaUrl);
            if (items.length === 1 && items[0]?.kind === 'video'){
                const vTitle = String(items[0]?.name || '').trim();
                if (vTitle && raw.toLowerCase() === vTitle.toLowerCase()) return '';
            }
            if (items.length === 1 && items[0]?.kind === 'playlist'){
                const pTitle = String(items[0]?.name || '').trim();
                const normalized = raw.replace(/^playlist:\s*/i, '').trim();
                if (pTitle && normalized.toLowerCase() === pTitle.toLowerCase()) return '';
            }
            return raw;
        }catch(_){ return String(post?.text || '').trim(); }
    }

    renderPostMedia(media, opts = {}){
        const defaultBy = String(opts.defaultBy || '').trim();
        const defaultCover = String(opts.defaultCover || '').trim();
        const authorId = String(opts.authorId || '').trim();
        const items = this.normalizePostMediaItems(media);
        if (!items.length) return '';
        const mediaRank = (it)=> (it.kind === 'image' || it.kind === 'video') ? 0 : 1;
        const ordered = items.slice().sort((a,b)=> mediaRank(a) - mediaRank(b));
        const visual = ordered.filter((it)=> it.kind === 'image' || it.kind === 'video');
        const rest = ordered.filter((it)=> !(it.kind === 'image' || it.kind === 'video'));

        const visualHtml = visual.length
            ? `<div class="post-media-visual-shell"><div class="post-media-visual-wrap"><div class="post-media-visual-slider">${visual.map((it)=>{
                const t = String(it.name || (it.kind === 'image' ? 'Picture' : 'Video')).replace(/"/g,'&quot;');
                const b = String(it.by || defaultBy || '').replace(/"/g,'&quot;');
                const c = String(it.cover || defaultCover || '').replace(/"/g,'&quot;');
                const aid = String(authorId || '').replace(/"/g,'&quot;');
                const actions = it.kind === 'image'
                    ? `<div class="post-media-files-item post-save-visual-wrap" style="padding:8px 0 0"><button type="button" class="post-save-visual-btn" title="To My Pictures" data-save-target="pictures" data-kind="${it.kind}" data-url="${String(it.url || '').replace(/"/g,'&quot;')}" data-title="${t}" data-by="${b}" data-cover="${c}" data-author-id="${aid}"><i class="fas fa-plus"></i></button></div>`
                    : `<div class="post-media-files-item post-save-visual-wrap" style="padding:8px 0 0"><button type="button" class="post-save-visual-btn" title="To My Videos" data-save-target="videos" data-kind="${it.kind}" data-url="${String(it.url || '').replace(/"/g,'&quot;')}" data-title="${t}" data-by="${b}" data-cover="${c}" data-author-id="${aid}"><i class="fas fa-plus"></i></button></div>`;
                if (it.kind === 'image'){
                    return `<div class="post-media-visual-item"><img src="${it.url}" alt="media" class="post-media-image">${actions}</div>`;
                }
                const tHtml = String(it.name || 'Video').replace(/</g,'&lt;');
                return `<div class="post-media-visual-item"><div class="player-card"><div class="post-media-video-head">${tHtml}</div><video src="${it.url}" class="player-media post-media-video" data-title="${t}" data-by="${b}" data-cover="${c}" controls playsinline></video><div class="player-bar"><button class="btn-icon" data-action="play"><i class="fas fa-play"></i></button><div class="progress"><div class="fill"></div></div><div class="time"></div></div></div>${actions}</div>`;
            }).join('')}</div></div>${visual.length > 1 ? `<div class="post-media-dots">${visual.map((_,i)=> `<button type="button" class="post-media-dot${i===0?' active':''}" data-slide-index="${i}" aria-label="Slide ${i+1}"></button>`).join('')}</div>` : ''}</div>`
            : '';

        const restHtml = rest.length
            ? `<div class="post-media-files-list">${rest.map((it)=>{
                if (it.kind === 'audio' && it.url){
                    const t = String(it.name || 'Audio').replace(/</g,'&lt;');
                    const byRaw = String(it.by || defaultBy || '').trim();
                    const by = byRaw.replace(/</g,'&lt;');
                    const tAttr = String(it.name || 'Audio').replace(/"/g,'&quot;');
                    const byAttr = byRaw.replace(/"/g,'&quot;');
                    const coverAttr = String(it.cover || defaultCover || '').replace(/"/g,'&quot;');
                    const coverImg = coverAttr ? `<img src="${coverAttr}" alt="cover" class="post-media-audio-cover">` : `<span class="post-media-audio-cover post-media-audio-cover-fallback"><i class="fas fa-music"></i></span>`;
                    const byNode = by ? (authorId ? `<button type="button" class="post-media-audio-by post-media-audio-by-link" data-user-preview="${authorId.replace(/"/g,'&quot;')}">by ${by}</button>` : `<span class="post-media-audio-by">by ${by}</span>`) : '';
                    return `<div class="post-media-files-item"><div class="post-media-audio-head">${coverImg}<div class="post-media-audio-head-text"><span class="post-media-audio-title">${t}</span>${byNode}</div></div><div class="player-card"><audio src="${it.url}" class="player-media" data-title="${tAttr}" data-by="${byAttr}" data-cover="${coverAttr}" preload="metadata"></audio><div class="player-bar"><button class="btn-icon" data-action="play"><i class="fas fa-play"></i></button><div class="progress"><div class="fill"></div></div><div class="time"></div></div></div></div>`;
                }
                if (it.kind === 'playlist'){
                    const pCat = this.normalizePlaylistCategory(it.playlistCategory || it.category, it.items);
                    const plTitle = pCat === 'image' ? 'Album' : (pCat === 'video' ? 'Video Playlist' : 'Playlist');
                    const safeName = String(it.name || plTitle).replace(/</g,'&lt;');
                    const safeBy = String(it.by || defaultBy || '').replace(/</g,'&lt;');
                    const safeCover = String(it.cover || defaultCover || '').replace(/"/g,'&quot;');
                    const rows = Array.isArray(it.items) ? it.items.slice(0, 5) : [];
                    const encoded = encodeURIComponent(JSON.stringify(rows));
                    const playlistId = String(it.playlistId || '').replace(/"/g,'&quot;');
                    const rowsHtml = rows.length
                        ? `<div style="display:grid;gap:4px;margin-top:8px">${rows.map((row)=>`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;opacity:.88"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(row?.title || 'Track').replace(/</g,'&lt;')}</span><span style="opacity:.7;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(row?.by || '').replace(/</g,'&lt;')}</span></div>`).join('')}</div>`
                        : `<div style="margin-top:8px;font-size:12px;opacity:.75">${plTitle} card</div>`;
                    return `<div class="post-media-files-item post-playlist-card" style="border:1px solid var(--border-color);border-radius:10px;padding:10px;background:rgba(255,255,255,.02)">
                        <div style="display:flex;align-items:center;gap:10px">
                          ${safeCover ? `<img src="${safeCover}" alt="playlist cover" style="width:40px;height:40px;border-radius:8px;object-fit:cover">` : `<span style="width:40px;height:40px;border-radius:8px;display:grid;place-items:center;background:#1b2230"><i class="fas fa-list-music"></i></span>`}
                          <div style="min-width:0;flex:1">
                            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safeName}</div>
                            <div style="font-size:12px;opacity:.8">${safeBy ? `by ${safeBy}` : plTitle}</div>
                          </div>
                          <button type="button" class="btn btn-secondary post-playlist-play-btn" data-playlist-items="${encoded}" data-playlist-id="${playlistId}" title="Play playlist"><i class="fas fa-play"></i></button>
                        </div>
                        ${rowsHtml}
                    </div>`;
                }
                if (it.url){
                    const safeName = String(it.name || 'Open attachment').replace(/</g,'&lt;');
                    return `<div class="post-media-files-item"><a href="${it.url}" target="_blank" rel="noopener noreferrer" class="post-media-file-chip"><i class="fas fa-paperclip"></i> ${safeName}</a></div>`;
                }
                return '';
            }).join('')}</div>`
            : '';
        return `<div class="post-media-block">${visualHtml}${restHtml}</div>`;
    }

    pauseAllMediaExcept(current){
        try{
            const bg = document.getElementById('bg-player');
            if (bg && bg !== current){ try{ bg.pause(); }catch(_){ } }
            const localChatBg = document.getElementById('chat-bg-player');
            if (localChatBg && localChatBg !== current){ try{ localChatBg.pause(); }catch(_){ } }
            try{
                const shellFrame = document.getElementById('app-shell-frame');
                const iframeDoc = shellFrame?.contentWindow?.document;
                const iframeChatBg = iframeDoc?.getElementById('chat-bg-player');
                if (iframeChatBg && iframeChatBg !== current){ try{ iframeChatBg.pause(); }catch(_){ } }
            }catch(_){ }
            document.querySelectorAll('audio.player-media, video.player-media, .liber-lib-audio, .liber-lib-video').forEach((m)=>{
                if (m !== current){
                    try{ m.pause(); }catch(_){ }
                    const card = m.closest('.player-card');
                    const btn = card && card.querySelector('.btn-icon');
                    if (btn) this.setPlayIcon(btn, false);
                }
            });
        }catch(_){ }
    }

    setPlayIcon(btn, isPlaying){
        if (!btn) return;
        btn.innerHTML = `<i class="fas ${isPlaying ? 'fa-pause' : 'fa-play'}"></i>`;
    }

    resolveMediaNodeCover(node){
        try{
            if (!node) return '';
            const direct = String(node.dataset?.cover || '').trim();
            if (direct) return direct;
            const poster = String(node.getAttribute?.('poster') || '').trim();
            if (poster) return poster;
            const waveCard = node.closest('.wave-item');
            if (waveCard){
                const cover = waveCard.querySelector('img');
                return String(cover?.src || '').trim();
            }
            const videoCard = node.closest('.video-item');
            if (videoCard){
                const cover = videoCard.querySelector('img');
                return String(cover?.src || '').trim();
            }
            const postCard = node.closest('.post-item');
            if (postCard){
                // In posts, avoid author avatar and use dedicated media cover only.
                const cover = postCard.querySelector('.post-media-audio-cover');
                return String(cover?.src || '').trim();
            }
            const genericCard = node.closest('.player-card');
            const img = genericCard ? genericCard.querySelector('img') : null;
            return String(img?.src || '').trim();
        }catch(_){ return ''; }
    }

    normalizeMediaByline(value){
        const raw = String(value || '').trim();
        if (!raw) return '';
        return /^by\s+/i.test(raw) ? raw : `by ${raw}`;
    }

    attachWaveAudioUI(media, host, opts = {}){
        try{
            if (!media || !host || media.dataset.waveUiBound === '1') return;
            media.dataset.waveUiBound = '1';
            if (opts.hideNative){
                media.controls = false;
                media.style.display = 'none';
            }
            const seed = String(media.dataset?.title || media.currentSrc || media.src || 'audio');
            const wrap = document.createElement('div');
            wrap.className = 'audio-wave-player';
            const playBtn = document.createElement('button');
            playBtn.className = 'audio-wave-play';
            playBtn.innerHTML = '<i class="fas fa-play"></i>';
            const wave = document.createElement('div');
            wave.className = 'audio-wave-bars';
            const time = document.createElement('div');
            time.className = 'audio-wave-time';
            time.textContent = '0:00/0:00';
            const barsCount = 54;
            this.paintSeedWaveBars(wave, barsCount, seed);
            this.populateWaveBarsFromLoudness(media, wave, barsCount, seed);
            const resolveSource = ()=> media._waveProxySource || media;
            const sync = ()=>{
                const src = resolveSource();
                const d = Number(src?.duration || 0);
                const c = Number(src?.currentTime || 0);
                const ratio = d > 0 ? Math.min(1, Math.max(0, c / d)) : 0;
                const bars = wave.querySelectorAll('.bar');
                const played = Math.round(bars.length * ratio);
                bars.forEach((b, i)=> b.classList.toggle('played', i < played));
                playBtn.innerHTML = `<i class="fas ${(src?.paused ?? true) ? 'fa-play' : 'fa-pause'}"></i>`;
                time.textContent = `${this.formatDuration(c)} / ${this.formatDuration(d)}`;
            };
            const events = ['play','pause','timeupdate','loadedmetadata','ended'];
            let boundSrc = null;
            const boundHandlers = new Map();
            const bindSource = (src)=>{
                try{
                    if (!src || boundSrc === src) return;
                    if (boundSrc){
                        events.forEach((ev)=>{
                            const h = boundHandlers.get(ev);
                            if (h) boundSrc.removeEventListener(ev, h);
                        });
                    }
                    boundHandlers.clear();
                    events.forEach((ev)=>{
                        const h = ()=> sync();
                        boundHandlers.set(ev, h);
                        src.addEventListener(ev, h);
                    });
                    boundSrc = src;
                    sync();
                }catch(_){ }
            };
            bindSource(media);
            media._waveAttachProxy = (proxy)=>{
                media._waveProxySource = proxy || null;
                bindSource(resolveSource());
                sync();
            };
            playBtn.addEventListener('click', ()=>{
                const src = resolveSource();
                if (src.paused){
                    this.pauseAllMediaExcept(src);
                    src.play().catch(()=>{});
                } else {
                    src.pause();
                }
                sync();
            });
            const seekTo = (clientX)=>{
                const rect = wave.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
                const src = resolveSource();
                if (Number(src.duration) > 0) src.currentTime = ratio * src.duration;
                if (src.paused){
                    this.pauseAllMediaExcept(src);
                    src.play().catch(()=>{});
                }
                sync();
            };
            wave.addEventListener('click', (e)=> seekTo(e.clientX));
            let dragging = false;
            wave.addEventListener('pointerdown', (e)=>{ dragging = true; wave.setPointerCapture(e.pointerId); seekTo(e.clientX); });
            wave.addEventListener('pointermove', (e)=>{ if (dragging) seekTo(e.clientX); });
            wave.addEventListener('pointerup', (e)=>{ dragging = false; try{ wave.releasePointerCapture(e.pointerId); }catch(_){ } });
            wrap.appendChild(playBtn);
            wrap.appendChild(wave);
            wrap.appendChild(time);
            host.appendChild(wrap);
            sync();
        }catch(_){ }
    }

    paintSeedWaveBars(wave, barsCount, seed){
        wave.innerHTML = '';
        for (let i = 0; i < barsCount; i++){
            const bar = document.createElement('span');
            bar.className = 'bar';
            const ch = seed.charCodeAt(i % (seed.length || 1)) || 37;
            const waveBase = (Math.sin((i / barsCount) * Math.PI * 2) + 1) * 0.5;
            const jitter = ((ch * (i + 11)) % 10) / 10;
            const h = 5 + Math.round((waveBase * 12) + (jitter * 6));
            bar.style.height = `${h}px`;
            wave.appendChild(bar);
        }
    }

    applyWaveHeights(wave, heights){
        if (!wave || !Array.isArray(heights) || !heights.length) return;
        wave.innerHTML = '';
        heights.forEach((h)=>{
            const bar = document.createElement('span');
            bar.className = 'bar';
            bar.style.height = `${Math.max(4, Math.min(24, Math.round(h)))}px`;
            wave.appendChild(bar);
        });
    }

    async getAudioWaveHeights(src, barsCount = 54){
        try{
            const key = `${src}::${barsCount}`;
            if (this._audioWaveCache.has(key)) return await this._audioWaveCache.get(key);
            const p = (async ()=>{
                const resp = await fetch(src, { mode: 'cors' });
                if (!resp.ok) return null;
                const buf = await resp.arrayBuffer();
                if (!this._audioWaveCtx){
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (!AC) return null;
                    this._audioWaveCtx = new AC();
                }
                const audioBuf = await this._audioWaveCtx.decodeAudioData(buf.slice(0));
                const data = audioBuf.getChannelData(0);
                const total = data.length;
                if (!total) return null;
                const step = Math.max(1, Math.floor(total / barsCount));
                const out = [];
                for (let i = 0; i < barsCount; i++){
                    const start = i * step;
                    const end = Math.min(total, start + step);
                    let sum = 0;
                    let count = 0;
                    for (let j = start; j < end; j++){
                        const v = data[j];
                        sum += v * v;
                        count++;
                    }
                    const rms = count ? Math.sqrt(sum / count) : 0;
                    out.push(rms);
                }
                const max = Math.max(...out, 0.0001);
                return out.map((v)=> 4 + ((v / max) * 20));
            })();
            this._audioWaveCache.set(key, p);
            const result = await p;
            if (!result) this._audioWaveCache.delete(key);
            return result;
        }catch(_){ return null; }
    }

    populateWaveBarsFromLoudness(media, wave, barsCount, seed){
        const attempt = async ()=>{
            try{
                const src = String(media?.currentSrc || media?.src || '').trim();
                if (!src) return;
                const heights = await this.getAudioWaveHeights(src, barsCount);
                if (Array.isArray(heights) && heights.length){
                    this.applyWaveHeights(wave, heights);
                }
            }catch(_){
                this.paintSeedWaveBars(wave, barsCount, seed);
            }
        };
        attempt();
        if (!media.currentSrc && !media.src){
            media.addEventListener('loadedmetadata', attempt, { once: true });
        }
    }

    cycleRepeatMode(){
        const next = this._repeatMode === 'off'
            ? 'all'
            : this._repeatMode === 'all'
                ? 'one'
                : 'off';
        this._repeatMode = next;
        try{ localStorage.setItem('liber_mini_repeat_mode', next); }catch(_){ }
        this.updateMiniRepeatButton();
    }

    updateMiniRepeatButton(){
        const btn = document.getElementById('mini-repeat');
        if (!btn) return;
        const mode = this._repeatMode || 'off';
        const title = mode === 'all'
            ? 'Repeat playlist'
            : mode === 'one'
                ? 'Repeat song'
                : 'Repeat off';
        btn.innerHTML = '<i class="fas fa-repeat"></i>';
        btn.dataset.mode = mode;
        btn.title = title;
        btn.setAttribute('aria-label', title);
    }

    handleMiniPlaybackEnded(source){
        const isVideo = source && String(source.tagName || '').toUpperCase() === 'VIDEO';
        if (isVideo && this._interruptedAudioState){
            const s = this._interruptedAudioState;
            this._interruptedAudioState = null;
            try{
                if (s.mediaEl && !isNaN(s.currentTime)) s.mediaEl.currentTime = s.currentTime;
                this.showMiniPlayer(s.mediaEl);
            }catch(_){ }
            return;
        }
        const queue = this._playQueue || [];
        const len = queue.length;
        const idx = Number.isFinite(Number(this._playQueueIndex)) ? Number(this._playQueueIndex) : -1;

        if (this._repeatMode === 'one'){
            if (len > 0 && idx >= 0){
                this.playQueueIndex(idx, { restart: true });
                return;
            }
            if (source){
                try{
                    source.currentTime = 0;
                    source.play().catch(()=>{});
                }catch(_){ }
            }
            return;
        }

        if (len > 0 && (idx + 1) < len){
            this.playQueueIndex(idx + 1);
            return;
        }

        if (this._repeatMode === 'all' && len > 0){
            this.playQueueIndex(0, { restart: true });
        }
    }

    rememberPlaybackPosition(src, currentTime, duration){
        try{
            const key = String(src || '').trim();
            if (!key) return;
            const t = Number(currentTime || 0);
            const d = Number(duration || 0);
            if (!Number.isFinite(t) || t < 0) return;
            this._resumeBySrc.set(key, {
                time: t,
                duration: Number.isFinite(d) ? Math.max(0, d) : 0,
                updatedAt: Date.now()
            });
        }catch(_){ }
    }

    getPlaybackResumeTime(src){
        try{
            const key = String(src || '').trim();
            if (!key) return 0;
            const rec = this._resumeBySrc.get(key);
            if (!rec) return 0;
            const t = Number(rec.time || 0);
            const d = Number(rec.duration || 0);
            if (!Number.isFinite(t) || t <= 0.1) return 0;
            if (d > 0 && t >= Math.max(0.1, d - 1.2)) return 0;
            return t;
        }catch(_){ return 0; }
    }

    formatDuration(seconds){
        const s = Math.max(0, Math.floor(Number(seconds || 0)));
        const m = Math.floor(s / 60);
        const ss = String(s % 60).padStart(2, '0');
        return `${m}:${ss}`;
    }

    setMiniTitleText(rawTitle){
        const el = document.getElementById('mini-title');
        if (!el) return;
        const full = String(rawTitle || 'Now playing');
        el.dataset.fullTitle = full;
        if (this._miniTitleTicker){
            clearInterval(this._miniTitleTicker);
            this._miniTitleTicker = null;
        }
        const startTicker = ()=>{
            // If title changed while waiting, stop.
            if (el.dataset.fullTitle !== full) return;
            el.textContent = full;
            const hasWidth = Number(el.clientWidth || 0) > 0;
            const measuredOverflow = hasWidth ? ((el.scrollWidth - el.clientWidth) > 2) : false;
            const fallbackOverflow = full.length > 20;
            const shouldScroll = measuredOverflow || fallbackOverflow;
            if (!shouldScroll){
                el.textContent = full;
                return;
            }
            const pad = `${full}    `;
            let i = 0;
            const paint = ()=>{
                if (el.dataset.fullTitle !== full){
                    if (this._miniTitleTicker){ clearInterval(this._miniTitleTicker); this._miniTitleTicker = null; }
                    return;
                }
                const doubled = pad + pad;
                el.textContent = doubled.slice(i, i + 20);
                i = (i + 1) % pad.length;
            };
            paint();
            this._miniTitleTicker = setInterval(paint, 220);
        };
        // Start immediately and retry once after layout settles (protect animation).
        startTicker();
        if (!this._miniTitleTicker){
            setTimeout(()=>{
                if (!this._miniTitleTicker && el.dataset.fullTitle === full) startTicker();
            }, 280);
        }
    }

    getBgPlayer(){
        let bg = document.getElementById('bg-player');
        if (!bg){
            bg = document.createElement('audio');
            bg.id = 'bg-player';
            bg.style.display='none';
            document.body.appendChild(bg);
        }
        return bg;
    }

    getPlaylistStorageKey(){
        const uid = this.currentUser?.uid || window.firebaseService?.auth?.currentUser?.uid || 'anon';
        return `liber_playlists_${uid}`;
    }

    normalizePlaylistCategory(category, items = []){
        const raw = String(category || '').trim().toLowerCase();
        if (raw === 'audio' || raw === 'video' || raw === 'image') return raw;
        const list = Array.isArray(items) ? items : [];
        const kinds = new Set(
            list.map((it)=> this.inferMediaKindFromUrl(String(it?.src || it?.url || '')))
                .filter((k)=> k === 'audio' || k === 'video' || k === 'image')
        );
        if (kinds.size === 1) return Array.from(kinds)[0];
        if (kinds.has('image') && !kinds.has('audio') && !kinds.has('video')) return 'image';
        if (kinds.has('video') && !kinds.has('audio')) return 'video';
        return 'audio';
    }

    getPlaylists(){
        try{
            const raw = localStorage.getItem(this.getPlaylistStorageKey());
            const data = raw ? JSON.parse(raw) : [];
            return Array.isArray(data) ? data : [];
        }catch(_){ return []; }
    }

    normalizePlaylistRows(playlists, ownerUid = ''){
        const uid = String(ownerUid || this.currentUser?.uid || window.firebaseService?.auth?.currentUser?.uid || '').trim();
        const input = Array.isArray(playlists) ? playlists : [];
        const map = new Map();
        input.forEach((pl, idx)=>{
            if (!pl || typeof pl !== 'object') return;
            const resolvedId = String(pl.id || '').trim() || `pl_${Date.now()}_${idx}_${Math.random().toString(36).slice(2,6)}`;
            const visibility = pl.visibility === 'public' ? 'public' : 'private';
            const row = {
                ...pl,
                id: resolvedId,
                owner: String(pl.owner || pl.ownerId || uid),
                ownerId: String(pl.ownerId || pl.owner || uid),
                userId: String(pl.userId || pl.ownerId || pl.owner || uid),
                authorId: String(pl.authorId || pl.ownerId || pl.owner || uid),
                visibility,
                isPublic: visibility === 'public',
                public: visibility === 'public',
                privacy: visibility === 'public' ? 'public' : 'private',
                items: Array.isArray(pl.items) ? pl.items : [],
                category: this.normalizePlaylistCategory(pl.category || pl.playlistCategory, pl.items),
                updatedAt: pl.updatedAt || new Date().toISOString(),
                createdAt: pl.createdAt || new Date().toISOString()
            };
            map.set(resolvedId, row);
        });
        return Array.from(map.values()).sort((a,b)=> new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    }

    savePlaylists(playlists){
        const normalized = this.normalizePlaylistRows(playlists || []);
        try{ localStorage.setItem(this.getPlaylistStorageKey(), JSON.stringify(normalized)); }catch(_){ }
        this._pendingPlaylistSyncRows = normalized.slice();
        if (this._playlistSyncTimer) clearTimeout(this._playlistSyncTimer);
        this._playlistSyncTimer = setTimeout(()=>{
            const rows = Array.isArray(this._pendingPlaylistSyncRows) ? this._pendingPlaylistSyncRows.slice() : [];
            this._pendingPlaylistSyncRows = [];
            this.syncPlaylistsToCloud(rows).catch(()=>{});
        }, 80);
    }

    async hydratePlaylistsFromCloud(){
        try{
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid || !(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return this.getPlaylists();
            const local = this.normalizePlaylistRows(this.getPlaylists(), me.uid);
            try{ localStorage.setItem(this.getPlaylistStorageKey(), JSON.stringify(local)); }catch(_){ }
            if (local.length){
                try{ await this.syncPlaylistsToCloud(local); }catch(_){ }
            }
            const readCloudRows = async ()=>{
                const rows = [];
                try{
                    const q = firebase.query(
                        firebase.collection(window.firebaseService.db, 'playlists'),
                        firebase.where('ownerId','==', me.uid),
                        firebase.orderBy('updatedAt','desc'),
                        firebase.limit(200)
                    );
                    const snap = await firebase.getDocs(q);
                    snap.forEach((d)=> rows.push({ id: d.id, ...d.data() }));
                }catch(_){
                    const q2 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('ownerId','==', me.uid));
                    const s2 = await firebase.getDocs(q2);
                    s2.forEach((d)=> rows.push({ id: d.id, ...d.data() }));
                }
                try{
                    const q3 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('owner','==', me.uid));
                    const s3 = await firebase.getDocs(q3);
                    s3.forEach((d)=> rows.push({ id: d.id, ...d.data() }));
                }catch(_){ }
                try{
                    const q4 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('userId','==', me.uid));
                    const s4 = await firebase.getDocs(q4);
                    s4.forEach((d)=> rows.push({ id: d.id, ...d.data() }));
                }catch(_){ }
                try{
                    const q5 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('authorId','==', me.uid));
                    const s5 = await firebase.getDocs(q5);
                    s5.forEach((d)=> rows.push({ id: d.id, ...d.data() }));
                }catch(_){ }
                return this.normalizePlaylistRows(rows, me.uid);
            };
            let cloudRows = await readCloudRows();
            if (local.length){
                const cloudIds = new Set((cloudRows || []).map((x)=> String(x?.id || '').trim()).filter(Boolean));
                const missingFromCloud = local.filter((x)=> !!x?.id && !cloudIds.has(String(x.id)));
                if (missingFromCloud.length){
                    try{ await this.syncPlaylistsToCloud(missingFromCloud); }catch(_){ }
                    cloudRows = await readCloudRows();
                }
            }
            const map = new Map();
            (local || []).forEach((p)=>{
                if (!p || !p.id) return;
                map.set(p.id, p);
            });
            // Cloud is source of truth across devices.
            (cloudRows || []).forEach((p)=>{
                if (!p || !p.id) return;
                const prev = map.get(p.id) || {};
                map.set(p.id, { ...prev, ...p, id: p.id });
            });
            const merged = Array.from(map.values());
            try{ localStorage.setItem(this.getPlaylistStorageKey(), JSON.stringify(merged)); }catch(_){ }
            return merged;
        }catch(_){ return this.getPlaylists(); }
    }

    async syncPlaylistsToCloud(playlists){
        try{
            const me = await this.resolveCurrentUser();
            const authUid = String(me?.uid || window.firebaseService?.auth?.currentUser?.uid || '').trim();
            if (!authUid || !(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return;
            const now = new Date().toISOString();
            const safeRows = this.normalizePlaylistRows(playlists || [], authUid).map((pl)=> ({
                id: String(pl.id || `pl_${Date.now()}`),
                owner: String(pl.owner || pl.ownerId || authUid),
                ownerId: String(pl.ownerId || authUid),
                ownerName: String(pl.ownerName || me?.email || window.firebaseService?.auth?.currentUser?.email || ''),
                userId: String(pl.userId || pl.ownerId || pl.owner || authUid),
                authorId: String(pl.authorId || pl.ownerId || pl.owner || authUid),
                name: String(pl.name || 'Playlist'),
                visibility: pl.visibility === 'public' ? 'public' : 'private',
                isPublic: pl.visibility === 'public',
                public: pl.visibility === 'public',
                privacy: pl.visibility === 'public' ? 'public' : 'private',
                sourcePlaylistId: String(pl.sourcePlaylistId || '').trim() || null,
                sourceOwnerId: String(pl.sourceOwnerId || '').trim() || null,
                items: Array.isArray(pl.items) ? pl.items.slice(0, 500) : [],
                category: this.normalizePlaylistCategory(pl.category || pl.playlistCategory, pl.items),
                createdAt: pl.createdAt || now,
                updatedAt: now
            }));
            for (const row of safeRows){
                try{
                    const ref = firebase.doc(window.firebaseService.db, 'playlists', row.id);
                    await firebase.setDoc(ref, row, { merge: true });
                }catch(err){
                    console.warn('Playlist cloud sync failed for row', row.id, err?.code || err?.message || err);
                }
            }
            // No cross-device delete sweep here: a stale client must not delete newer cloud rows.
        }catch(_){ }
    }

    async resolvePlaylistForRender(pl){
        try{
            if (!pl || !pl.sourcePlaylistId) return pl;
            if (!(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return pl;
            const snap = await firebase.getDoc(firebase.doc(window.firebaseService.db, 'playlists', pl.sourcePlaylistId));
            if (!snap.exists()){
                return { ...pl, _sourceMissing: true };
            }
            const src = snap.data() || {};
            return {
                ...pl,
                _sourceMissing: false,
                _resolvedFromSource: true,
                sourceName: src.name || '',
                sourceOwnerId: src.ownerId || pl.sourceOwnerId || '',
                sourceOwnerName: src.ownerName || '',
                items: Array.isArray(src.items) ? src.items : [],
                category: this.normalizePlaylistCategory(src.category || src.playlistCategory || pl.category, src.items),
                visibility: src.visibility === 'public' ? 'public' : 'private',
                updatedAt: src.updatedAt || pl.updatedAt
            };
        }catch(_){ return pl; }
    }

    async openPlaylistForPlayback(pl){
        try{
            let resolved = pl || null;
            const resolveById = async (pid)=>{
                const id = String(pid || '').trim();
                if (!id) return null;
                try{
                    const snap = await firebase.getDoc(firebase.doc(window.firebaseService.db, 'playlists', id));
                    if (snap.exists()) return { id, ...(snap.data() || {}) };
                }catch(_){ }
                return null;
            };
            if (!resolved){
                this.showError('Playlist not found');
                return false;
            }
            if (!Array.isArray(resolved.items) || !resolved.items.length){
                const source = await resolveById(resolved.sourcePlaylistId || resolved.id);
                if (source) resolved = { ...resolved, ...source, id: source.id || resolved.id };
            }
            const items = Array.isArray(resolved.items) ? resolved.items : [];
            const queue = items
                .filter((x)=> String(x?.src || '').trim())
                .map((x)=> ({
                    src: String(x.src || ''),
                    title: String(x.title || 'Track'),
                    by: String(x.by || ''),
                    cover: String(x.cover || '')
                }));
            if (!queue.length){
                this.showError('Playlist is empty');
                return false;
            }
            this._playQueue = queue;
            this._playQueueIndex = 0;
            this.playQueueIndex(0, { restart: true });
            return true;
        }catch(_){
            this.showError('Failed to open playlist');
            return false;
        }
    }

    async openWavePlaylistModal(playlistOrId, opts = {}){
        try{
            let pl = null;
            if (playlistOrId && typeof playlistOrId === 'object'){
                pl = playlistOrId;
            } else {
                const id = String(playlistOrId || '').trim();
                if (!id) return false;
                const rows = await this.hydratePlaylistsFromCloud();
                pl = (rows || []).find((x)=> String(x?.id || '') === id) || null;
            }
            if (!pl) return false;
            const resolved = await this.resolvePlaylistForRender(pl);
            const category = this.normalizePlaylistCategory(resolved?.category || resolved?.playlistCategory, resolved?.items);
            const isAudio = category === 'audio';
            const isVideo = category === 'video';
            const noun = isVideo ? 'Video Playlist' : (category === 'image' ? 'Album' : 'Playlist');
            const items = Array.isArray(resolved?.items) ? resolved.items : [];
            const cover = String(items[0]?.cover || '').trim() || 'images/default-bird.png';
            const existing = document.getElementById('wave-playlist-modal');
            if (existing) existing.remove();
            const overlay = document.createElement('div');
            overlay.id = 'wave-playlist-modal';
            overlay.className = 'modal-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:22060;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:14px';
            overlay.innerHTML = `
              <div style="width:min(96vw,760px);max-height:86vh;overflow:auto;background:#0f1724;border:1px solid #2b3445;border-radius:14px;padding:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
                  <div style="font-weight:700">${noun}</div>
                  <button type="button" class="btn btn-secondary" data-close-playlist-modal>Close</button>
                </div>
                <div style="display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:8px;background:rgba(255,255,255,.02);margin-bottom:10px">
                  <img src="${cover.replace(/"/g,'&quot;')}" alt="playlist cover" style="width:64px;height:64px;border-radius:10px;object-fit:cover;flex:0 0 auto">
                  <div style="min-width:0;flex:1">
                    <div style="font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(resolved?.name || noun).replace(/</g,'&lt;')}</div>
                    <div style="font-size:12px;opacity:.8">${items.length} items</div>
                  </div>
                  ${isAudio ? `<div style="display:flex;align-items:center;gap:6px"><button type="button" class="btn btn-secondary" data-pl-playall title="Play all" aria-label="Play all"><i class="fas fa-play"></i></button><button type="button" class="btn btn-secondary" data-pl-shuffle title="Shuffle" aria-label="Shuffle"><i class="fas fa-shuffle"></i></button></div>` : ''}
                </div>
                <div id="wave-playlist-modal-list" style="display:grid;gap:8px"></div>
              </div>
            `;
            document.body.appendChild(overlay);
            const close = ()=>{ try{ overlay.remove(); }catch(_){ } };
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay) close(); });
            overlay.querySelector('[data-close-playlist-modal]')?.addEventListener('click', close);

            const listHost = overlay.querySelector('#wave-playlist-modal-list');
            const renderRows = ()=>{
                if (!listHost) return;
                listHost.innerHTML = '';
                if (!items.length){
                    listHost.innerHTML = '<div style="opacity:.75">No items in this collection.</div>';
                    return;
                }
                items.forEach((it, idx)=>{
                    const rowCover = String(it?.cover || '').trim() || cover;
                    const title = String(it?.title || `Item ${idx + 1}`).replace(/</g,'&lt;');
                    const by = String(it?.by || '').replace(/</g,'&lt;');
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'btn btn-secondary';
                    row.style.cssText = 'width:100%;padding:8px;text-align:left;border-radius:10px;display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:10px';
                    row.innerHTML = `
                      <img src="${rowCover.replace(/"/g,'&quot;')}" alt="" style="width:44px;height:44px;border-radius:8px;object-fit:cover;background:#0f1522">
                      <span style="min-width:0;display:flex;flex-direction:column;gap:3px">
                        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</span>
                        <span style="font-size:11px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${by || '&nbsp;'}</span>
                        <span style="display:block;height:6px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden"><span style="display:block;height:100%;width:${Math.max(18, ((idx * 13 + 37) % 92))}%;background:rgba(91,169,255,.85)"></span></span>
                      </span>
                      <span style="font-size:11px;opacity:.66">${idx + 1}</span>
                    `;
                    row.addEventListener('click', ()=>{
                        if (isAudio){
                            const queue = items
                                .filter((x)=> String(x?.src || '').trim())
                                .map((x)=> ({
                                    src: String(x.src || ''),
                                    title: String(x.title || 'Track'),
                                    by: String(x.by || ''),
                                    cover: String(x.cover || '')
                                }));
                            if (!queue.length){ this.showError('Playlist is empty'); return; }
                            this._playQueue = queue;
                            this._playQueueIndex = Math.max(0, Math.min(idx, queue.length - 1));
                            this.playQueueIndex(this._playQueueIndex, { restart: true });
                            close();
                            return;
                        }
                        const visuals = items
                            .map((x)=> {
                                const u = String(x?.src || x?.url || '').trim();
                                if (!u) return null;
                                const k = this.inferMediaKindFromUrl(u);
                                return {
                                    type: k === 'image' ? 'image' : 'video',
                                    url: u,
                                    title: String(x?.title || 'Media'),
                                    by: String(x?.by || ''),
                                    cover: String(x?.cover || '')
                                };
                            })
                            .filter(Boolean);
                        if (!visuals.length){ this.showError('Collection is empty'); return; }
                        const openIdx = Math.max(0, Math.min(idx, visuals.length - 1));
                        this.openFullscreenMedia(visuals, openIdx);
                        close();
                    });
                    listHost.appendChild(row);
                });
            };
            renderRows();
            if (isAudio){
                overlay.querySelector('[data-pl-playall]')?.addEventListener('click', ()=>{
                    const queue = items
                        .filter((x)=> String(x?.src || '').trim())
                        .map((x)=> ({
                            src: String(x.src || ''),
                            title: String(x.title || 'Track'),
                            by: String(x.by || ''),
                            cover: String(x.cover || '')
                        }));
                    if (!queue.length){ this.showError('Playlist is empty'); return; }
                    this._playQueue = queue;
                    this._playQueueIndex = 0;
                    this.playQueueIndex(0, { restart: true });
                    close();
                });
                overlay.querySelector('[data-pl-shuffle]')?.addEventListener('click', ()=>{
                    const queue = items
                        .filter((x)=> String(x?.src || '').trim())
                        .map((x)=> ({
                            src: String(x.src || ''),
                            title: String(x.title || 'Track'),
                            by: String(x.by || ''),
                            cover: String(x.cover || '')
                        }));
                    if (!queue.length){ this.showError('Playlist is empty'); return; }
                    for (let i = queue.length - 1; i > 0; i--){
                        const j = Math.floor(Math.random() * (i + 1));
                        [queue[i], queue[j]] = [queue[j], queue[i]];
                    }
                    this._playQueue = queue;
                    this._playQueueIndex = 0;
                    this.playQueueIndex(0, { restart: true });
                    close();
                });
            }
            return true;
        }catch(_){
            this.showError('Unable to open collection');
            return false;
        }
    }

    async openAddToPlaylistPopup(track){
        const playlists = await this.hydratePlaylistsFromCloud();
        const targetCategory = this.normalizePlaylistCategory(track?.kind, [{ src: String(track?.src || '') }]);
        const isImage = targetCategory === 'image';
        const noun = isImage ? 'album' : (targetCategory === 'video' ? 'video playlist' : 'playlist');
        const visiblePlaylists = (Array.isArray(playlists) ? playlists : [])
            .filter((p)=> this.normalizePlaylistCategory(p?.category || p?.playlistCategory, p?.items) === targetCategory);
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:16px';
        const options = visiblePlaylists.map((p)=> `<option value="${p.id}">${(p.name||'Playlist').replace(/</g,'&lt;')}</option>`).join('');
        overlay.innerHTML = `
          <div style="width:min(96vw,420px);background:#0f1724;border:1px solid #2b3445;border-radius:12px;padding:12px">
            <div style="font-weight:700;margin-bottom:10px">Add to ${noun}</div>
            <div style="margin-bottom:8px">
              <label style="font-size:12px;opacity:.9;display:block;margin-bottom:4px">Existing ${noun}</label>
              <select id="pl-select" style="width:100%;padding:8px;border-radius:8px;background:#121a28;color:#e8eefb;border:1px solid #2b3445">
                <option value="">Choose ${noun}...</option>
                ${options}
              </select>
            </div>
            <div style="margin-bottom:10px">
              <label style="font-size:12px;opacity:.9;display:block;margin-bottom:4px">Or create new</label>
              <input id="pl-new" type="text" placeholder="New ${noun} name" style="width:100%;padding:8px;border-radius:8px;background:#121a28;color:#e8eefb;border:1px solid #2b3445" />
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button id="pl-cancel" class="btn btn-secondary">Cancel</button>
              <button id="pl-save" class="btn btn-primary">Save</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#pl-cancel').onclick = ()=> overlay.remove();
        overlay.addEventListener('click', (e)=>{ if (e.target === overlay) overlay.remove(); });
        overlay.querySelector('#pl-save').onclick = ()=>{
            const selectedId = String(overlay.querySelector('#pl-select').value || '').trim();
            const newName = String(overlay.querySelector('#pl-new').value || '').trim();
            let selected = null;
            if (selectedId){
                selected = visiblePlaylists.find((p)=> p.id === selectedId) || null;
            } else if (newName){
                selected = {
                    id: `pl_${Date.now()}`,
                    name: newName,
                    visibility: 'private',
                    owner: this.currentUser?.uid || window.firebaseService?.auth?.currentUser?.uid || '',
                    ownerId: this.currentUser?.uid || window.firebaseService?.auth?.currentUser?.uid || '',
                    ownerName: this.currentUser?.email || '',
                    category: targetCategory,
                    items: []
                };
                playlists.push(selected);
            }
            if (!selected){ this.showError(`Choose or create a ${noun}`); return; }
            if (!selected.items) selected.items = [];
            const exists = (selected.items || []).some((it)=> String(it?.src || '') === String(track?.src || ''));
            if (exists){
                this.showSuccess(`Already in ${noun}`);
                overlay.remove();
                return;
            }
            selected.items.push({
                id: `it_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
                src: track.src,
                title: track.title || 'Track',
                by: track.by || '',
                cover: track.cover || '',
                kind: targetCategory
            });
            this.savePlaylists(playlists);
            this.renderPlaylists();
            overlay.remove();
            this.showSuccess(`Added to ${noun}`);
        };
    }

    renderQueuePanel(){
        const panel = document.getElementById('mini-queue-panel');
        const list = document.getElementById('mini-queue-list');
        if (!panel || !list) return;
        const queue = this._playQueue || [];
        const next = queue.slice(Math.max(0, this._playQueueIndex + 1));
        list.innerHTML = next.length
            ? next.map((q,i)=> `<div class="mini-queue-item" data-idx="${this._playQueueIndex + 1 + i}">${(q.title||'Track').replace(/</g,'&lt;')}</div>`).join('')
            : '<div class="mini-queue-item">Queue is empty</div>';
        list.querySelectorAll('[data-idx]').forEach((el)=>{
            el.onclick = ()=>{
                const idx = Number(el.getAttribute('data-idx'));
                this.playQueueIndex(idx);
                panel.style.display = 'none';
            };
        });
    }

    playQueueIndex(idx, opts = {}){
        const item = this._playQueue[idx];
        if (!item) return;
        this._playQueueIndex = idx;
        const restart = !!opts.restart;
        const resumeAt = restart ? 0 : this.getPlaybackResumeTime(item.src || '');
        try{
            if (this._currentPlayer && this._currentPlayer !== this.getBgPlayer()){
                this._currentPlayer._waveAttachProxy && this._currentPlayer._waveAttachProxy(null);
            }
        }catch(_){ }
        const nodes = Array.from(document.querySelectorAll('audio.player-media, video.player-media, .liber-lib-audio, .liber-lib-video'));
        const inlineNode = nodes.find((n)=> (n.currentSrc || n.src || '') === (item.src || ''));
        if (inlineNode && String(inlineNode.tagName || '').toUpperCase() === 'VIDEO'){
            try{
                this.pauseAllMediaExcept(inlineNode);
                this._currentPlayer = inlineNode;
                inlineNode.currentTime = Math.max(0, Number(resumeAt || 0));
                inlineNode.play().catch(()=>{});
                this.showMiniPlayer(inlineNode, { title: item.title, by: item.by, cover: item.cover });
                this.renderQueuePanel();
                return;
            }catch(_){ }
        }
        const bg = this.getBgPlayer();
        this._currentPlayer = bg;
        this.pauseAllMediaExcept(bg);
        bg.src = item.src;
        bg.currentTime = 0;
        if (resumeAt > 0){
            const applyResume = ()=>{
                try{
                    const d = Number(bg.duration || 0);
                    if (d > 0){
                        bg.currentTime = Math.max(0, Math.min(resumeAt, Math.max(0, d - 0.25)));
                    } else {
                        bg.currentTime = Math.max(0, resumeAt);
                    }
                }catch(_){ }
            };
            bg.addEventListener('loadedmetadata', applyResume, { once: true });
            applyResume();
        }
        bg.play().catch(()=>{});
        const mini = document.getElementById('mini-player');
        const miniTitle = document.getElementById('mini-title');
        const miniBy = document.getElementById('mini-by');
        const miniCover = document.querySelector('#mini-player .cover');
        const playBtn = document.getElementById('mini-play');
        const repeatBtn = document.getElementById('mini-repeat');
        const addBtn = document.getElementById('mini-add-playlist');
        const queueBtn = document.getElementById('mini-queue');
        const queuePanel = document.getElementById('mini-queue-panel');
        const queueClose = document.getElementById('mini-queue-close');
        const closeBtn = document.getElementById('mini-close');
        const miniProgress = document.getElementById('mini-progress');
        const miniFill = document.getElementById('mini-fill');
        const miniTime = document.getElementById('mini-time');
        this.setMiniTitleText(item.title || 'Now playing');
        if (miniBy) miniBy.textContent = item.by || '';
        if (miniCover) miniCover.src = item.cover || 'images/default-bird.png';
        if (mini) mini.classList.add('show');
        if (playBtn){ playBtn.onclick = ()=>{ if (bg.paused){ bg.play().catch(()=>{}); } else { bg.pause(); } }; }
        if (repeatBtn){
            repeatBtn.onclick = ()=> this.cycleRepeatMode();
            this.updateMiniRepeatButton();
        }
        const syncMiniBtn = ()=> this.setPlayIcon(playBtn, !bg.paused);
        const syncProgress = ()=>{
            if (!miniFill || !miniTime) return;
            const d = Number(bg.duration || 0);
            const c = Number(bg.currentTime || 0);
            this.rememberPlaybackPosition(bg.currentSrc || bg.src || item.src || '', c, d);
            if (d > 0){
                miniFill.style.width = `${Math.max(0, Math.min(100, (c / d) * 100))}%`;
                miniTime.textContent = `${this.formatDuration(c)} / ${this.formatDuration(d)}`;
            } else {
                miniFill.style.width = '0%';
                miniTime.textContent = '0:00 / 0:00';
            }
        };
        if (miniProgress){
            miniProgress.onclick = (e)=>{
                const rect = miniProgress.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                if (Number(bg.duration) > 0) bg.currentTime = ratio * bg.duration;
            };
        }
        bg.onplay = ()=>{ syncMiniBtn(); syncProgress(); };
        bg.onpause = ()=>{ syncMiniBtn(); syncProgress(); };
        bg.ontimeupdate = syncProgress;
        bg.onloadedmetadata = syncProgress;
        bg.onended = ()=>{
            syncMiniBtn();
            this.handleMiniPlaybackEnded(bg);
        };
        if (addBtn){
            addBtn.onclick = ()=> this.openAddToPlaylistPopup({
                src: bg.currentSrc || bg.src,
                title: miniTitle?.dataset?.fullTitle || miniTitle?.textContent || item.title || 'Track',
                by: miniBy?.textContent || item.by || '',
                cover: (miniCover && miniCover.src) || item.cover || ''
            });
        }
        if (queueBtn && queuePanel){
            queueBtn.onclick = ()=>{
                this.renderQueuePanel();
                queuePanel.style.display = queuePanel.style.display === 'none' ? 'block' : 'none';
            };
        }
        if (queueClose && queuePanel){ queueClose.onclick = ()=> queuePanel.style.display = 'none'; }
        if (closeBtn){ closeBtn.onclick = ()=>{ if (mini) mini.classList.remove('show'); try{ bg.pause(); }catch(_){} if (this._miniTitleTicker){ clearInterval(this._miniTitleTicker); this._miniTitleTicker = null; } }; }
        syncMiniBtn();
        syncProgress();
        this.renderQueuePanel();
    }

    async renderPlaylists(){
        const host = document.getElementById('wave-playlists');
        if (!host) return;
        const playlists = await this.hydratePlaylistsFromCloud();
        host.innerHTML = '';
        const audioPlaylists = (Array.isArray(playlists) ? playlists : [])
            .filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'audio');
        const controls = document.createElement('div');
        controls.className = 'wave-lib-list-controls';
        controls.style.marginBottom = '10px';
        controls.innerHTML = '<button type="button" class="btn btn-secondary"><i class="fas fa-plus"></i> New playlist</button>';
        const createBtn = controls.querySelector('button');
        if (createBtn){
            createBtn.onclick = async ()=>{
                const uid = String(this._waveAudioLibraryOwnerUid || this.currentUser?.uid || '').trim();
                const ownerName = String(this.currentUser?.email || '').trim();
                await this.createWavePlaylistFromPrompt(uid, ownerName);
            };
        }
        host.appendChild(controls);
        if (!audioPlaylists.length){
            const empty = document.createElement('div');
            empty.style.cssText = 'opacity:.8;padding:8px;border:1px solid var(--border-color);border-radius:10px;background:rgba(15,20,30,.4)';
            empty.textContent = 'No playlists yet.';
            host.appendChild(empty);
            return;
        }
        const visible = Math.max(5, Number(this._playlistsVisible || 5));
        for (const plRaw of audioPlaylists.slice(0, visible)){
            const pl = await this.resolvePlaylistForRender(plRaw);
            const wrap = document.createElement('div');
            wrap.className = 'playlist-card';
            wrap.dataset.playlistId = String(plRaw?.id || '');
            wrap.style.cssText = 'border:1px solid var(--border-color);border-radius:10px;padding:8px;margin-bottom:10px;background:#0f1116';
            const head = document.createElement('div');
            head.className = 'playlist-head';
            head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px';
            const visibility = (pl.visibility === 'public') ? 'public' : 'private';
            const ownerName = String(pl.sourceOwnerName || pl.ownerName || '').trim();
            const ownerId = String(pl.sourceOwnerId || pl.ownerId || '').trim();
            const ownerHtml = ownerName
              ? `<button type="button" data-user-preview="${ownerId.replace(/"/g,'&quot;')}" style="background:none;border:none;color:#9db3d5;padding:0;font-size:11px;cursor:pointer">${ownerName.replace(/</g,'&lt;')}</button>`
              : '';
            const sourceBadge = pl._resolvedFromSource ? '<span style="font-size:10px;opacity:.72">synced</span>' : '';
            const missingNote = pl._sourceMissing ? '<span style="font-size:10px;color:#f2a0a0">source unavailable</span>' : '';
            const removeLabel = plRaw.sourcePlaylistId ? 'Remove from My WaveConnect' : 'Remove';
            const plCover = String((Array.isArray(pl?.items) ? pl.items[0]?.cover : '') || 'images/default-bird.png').replace(/"/g,'&quot;');
            head.innerHTML = `<div class="playlist-head-main" style="display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:8px;min-width:0;cursor:pointer"><img src="${plCover}" alt="playlist cover" style="width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid rgba(255,255,255,.16)"><div style="display:flex;flex-direction:column;gap:2px;min-width:0"><div style="display:flex;align-items:center;gap:8px;min-width:0"><strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${(pl.name||'Playlist').replace(/</g,'&lt;')}</strong><span style="font-size:10px;opacity:.75;border:1px solid rgba(255,255,255,.2);padding:1px 6px;border-radius:999px;text-transform:uppercase">${visibility}</span>${sourceBadge}</div><div style="display:flex;align-items:center;gap:8px">${ownerHtml}${missingNote}</div></div><button type="button" class="btn btn-secondary" data-open-playlist-modal="${plRaw.id}" title="Open playlist"><i class="fas fa-up-right-and-down-left-from-center"></i></button></div><div class="playlist-head-actions" style="display:flex;gap:6px"><button class="btn btn-secondary" data-privacy="${plRaw.id}">${visibility === 'public' ? 'Make Private' : 'Make Public'}</button><button class="btn btn-secondary" data-remove-local="${plRaw.id}">${removeLabel}</button><button class="btn btn-secondary" data-del-all="${plRaw.id}">Delete</button></div>`;
            wrap.appendChild(head);
            const list = document.createElement('div');
            list.className = 'playlist-list';
            const canEditItems = !pl._resolvedFromSource;
            (pl.items || []).forEach((it, idx)=>{
                const row = document.createElement('div');
                row.className = 'playlist-row';
                row.draggable = !!canEditItems;
                row.dataset.idx = String(idx);
                row.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px;border-radius:8px;border:1px solid #273247;margin-bottom:6px;cursor:grab';
                const controls = canEditItems
                  ? `<button class="playlist-mini-btn" data-up="${it.id}" title="Move up"><i class="fas fa-arrow-up"></i></button><button class="playlist-mini-btn" data-down="${it.id}" title="Move down"><i class="fas fa-arrow-down"></i></button><button class="playlist-mini-btn" data-play="${it.id}" title="Play"><i class="fas fa-play"></i></button><button class="playlist-mini-btn danger" data-remove="${it.id}" title="Remove"><i class="fas fa-xmark"></i></button>`
                  : `<button class="playlist-mini-btn" data-play="${it.id}" title="Play"><i class="fas fa-play"></i></button>`;
                row.style.cursor = canEditItems ? 'grab' : 'default';
                row.innerHTML = `<div style="min-width:0"><div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600">${(it.title||'Track').replace(/</g,'&lt;')}</div><div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.72">${(it.by||'').replace(/</g,'&lt;')}</div></div><div class="playlist-row-actions" style="display:flex;gap:4px;flex-wrap:nowrap">${controls}</div>`;
                list.appendChild(row);
            });
            wrap.appendChild(list);
            host.appendChild(wrap);
            const openBtn = head.querySelector('[data-open-playlist-modal]');
            if (openBtn){
                openBtn.addEventListener('click', async (e)=>{
                    try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
                    await this.openWavePlaylistModal(plRaw, { source: 'library' });
                });
            }
            head.querySelector('.playlist-head-main')?.addEventListener('click', async (e)=>{
                const t = e.target instanceof Element ? e.target : null;
                if (t?.closest('button,[data-user-preview],a,input,select,textarea')) return;
                await this.openWavePlaylistModal(plRaw, { source: 'library' });
            });

            list.querySelectorAll('[data-play]').forEach((btn)=>{
                btn.onclick = ()=>{
                    const tid = btn.getAttribute('data-play');
                    const item = (pl.items || []).find((x)=> x.id === tid);
                    if (!item) return;
                    this._playQueue = (pl.items || []).map((x)=> ({ src: x.src, title: x.title, by: x.by, cover: x.cover }));
                    this._playQueueIndex = Math.max(0, (pl.items || []).findIndex((x)=> x.id === tid));
                    this.playQueueIndex(this._playQueueIndex);
                };
            });
            if (canEditItems){
            list.querySelectorAll('[data-remove]').forEach((btn)=>{
                btn.onclick = ()=>{
                    const tid = btn.getAttribute('data-remove');
                        plRaw.items = (plRaw.items || []).filter((x)=> x.id !== tid);
                        this.savePlaylists(playlists.map((x)=> x.id === plRaw.id ? { ...x, items: plRaw.items, updatedAt: new Date().toISOString() } : x));
                    this.renderPlaylists();
                };
            });
            list.querySelectorAll('[data-up]').forEach((btn)=>{
                btn.onclick = ()=>{
                    const tid = btn.getAttribute('data-up');
                        const arr = plRaw.items || [];
                    const i = arr.findIndex((x)=> x.id === tid);
                    if (i <= 0) return;
                    [arr[i-1], arr[i]] = [arr[i], arr[i-1]];
                        plRaw.items = arr;
                        this.savePlaylists(playlists.map((x)=> x.id === plRaw.id ? { ...x, items: plRaw.items, updatedAt: new Date().toISOString() } : x));
                    this.renderPlaylists();
                };
            });
            list.querySelectorAll('[data-down]').forEach((btn)=>{
                btn.onclick = ()=>{
                    const tid = btn.getAttribute('data-down');
                        const arr = plRaw.items || [];
                    const i = arr.findIndex((x)=> x.id === tid);
                    if (i < 0 || i >= arr.length - 1) return;
                    [arr[i+1], arr[i]] = [arr[i], arr[i+1]];
                        plRaw.items = arr;
                        this.savePlaylists(playlists.map((x)=> x.id === plRaw.id ? { ...x, items: plRaw.items, updatedAt: new Date().toISOString() } : x));
                    this.renderPlaylists();
                };
            });
            }
            const privacyBtn = wrap.querySelector('[data-privacy]');
            if (privacyBtn){
                privacyBtn.onclick = ()=>{
                    plRaw.visibility = (plRaw.visibility === 'public') ? 'private' : 'public';
                    const isPublic = plRaw.visibility === 'public';
                    this.savePlaylists(playlists.map((x)=> x.id === plRaw.id ? { ...x, visibility: plRaw.visibility, isPublic, public: isPublic, privacy: plRaw.visibility, updatedAt: new Date().toISOString() } : x));
                    this.renderPlaylists();
                };
            }
            const removeBtn = wrap.querySelector('[data-remove-local]');
            if (removeBtn){
                removeBtn.onclick = ()=>{
                    const next = playlists.filter((x)=> x.id !== plRaw.id);
                    this.savePlaylists(next);
                    this.renderPlaylists();
                };
            }
            const delAllBtn = wrap.querySelector('[data-del-all]');
            if (delAllBtn){
                const meUid = this.currentUser?.uid || window.firebaseService?.auth?.currentUser?.uid || '';
                const ownerIdNow = String(plRaw.ownerId || '').trim();
                const canDeleteForAll = !!meUid && ownerIdNow === meUid && !plRaw.sourcePlaylistId;
                if (!canDeleteForAll){
                    delAllBtn.style.display = 'none';
                } else {
                    delAllBtn.onclick = async ()=>{
                        if (!confirm('Delete this playlist for everyone?')) return;
                        try{
                            await firebase.deleteDoc(firebase.doc(window.firebaseService.db, 'playlists', plRaw.id));
                        }catch(_){ }
                        const next = playlists.filter((x)=> x.id !== plRaw.id);
                        this.savePlaylists(next);
                        this.renderPlaylists();
                    };
                }
            }

            if (canEditItems){
            let dragSrc = -1;
            list.querySelectorAll('.playlist-row').forEach((row)=>{
                row.addEventListener('dragstart', ()=>{ dragSrc = Number(row.dataset.idx); row.style.opacity = '0.5'; });
                row.addEventListener('dragend', ()=>{ row.style.opacity = '1'; });
                row.addEventListener('dragover', (e)=>{ e.preventDefault(); });
                row.addEventListener('drop', (e)=>{
                    e.preventDefault();
                    const target = Number(row.dataset.idx);
                    if (!Number.isFinite(dragSrc) || !Number.isFinite(target) || dragSrc === target) return;
                        const arr = plRaw.items || [];
                    const [moved] = arr.splice(dragSrc, 1);
                    arr.splice(target, 0, moved);
                        plRaw.items = arr;
                        this.savePlaylists(playlists.map((x)=> x.id === plRaw.id ? { ...x, items: plRaw.items, updatedAt: new Date().toISOString() } : x));
                    this.renderPlaylists();
                });
            });
            }
            this.bindUserPreviewTriggers(wrap);
        }
        if (audioPlaylists.length > visible){
            const more = document.createElement('button');
            more.className = 'btn btn-secondary';
            more.textContent = 'Show 5 more';
            more.onclick = ()=>{
                this._playlistsVisible = visible + 5;
                this.renderPlaylists();
            };
            host.appendChild(more);
        }
    }

    getShellChatBgPlayer(){
        try{
            const frame = document.getElementById('app-shell-frame');
            const doc = frame?.contentDocument;
            if (!doc) return null;
            return doc.getElementById('chat-bg-player') || null;
        }catch(_){ return null; }
    }

    clearChatMiniSyncTimer(){
        try{
            if (this._chatMiniSyncTimer){
                clearInterval(this._chatMiniSyncTimer);
                this._chatMiniSyncTimer = null;
            }
        }catch(_){ }
    }

    /** Called when chat sends liber:chat-audio-meta: sync mini player display only. Does NOT pause chat or take over playback. */
    setChatAudioMeta(track){
        try{
            if (!track || !track.src) return;
            this._chatAudioMeta = { src: track.src, title: track.title || 'Audio', by: track.by || '', cover: track.cover || '' };
            const mini = document.getElementById('mini-player');
            if (!mini) return;
            const mTitle = document.getElementById('mini-title');
            const mBy = document.getElementById('mini-by');
            const mCover = mini.querySelector('.cover');
            const playBtn = document.getElementById('mini-play');
            const closeBtn = document.getElementById('mini-close');
            const miniProgress = document.getElementById('mini-progress');
            const miniFill = document.getElementById('mini-fill');
            const miniTime = document.getElementById('mini-time');
            if (mTitle) this.setMiniTitleText(track.title || 'Audio');
            if (mBy) mBy.textContent = (track.by ? `by ${track.by}` : '').trim();
            if (mCover) mCover.src = (track.cover || 'images/default-bird.png').trim();
            this._miniControlledByChat = true;
            const getChatPlayer = ()=> this.getShellChatBgPlayer();
            const sync = ()=>{
                const cp = getChatPlayer();
                if (!playBtn || !miniFill || !miniTime){
                    return;
                }
                if (!cp){
                    this.setPlayIcon(playBtn, false);
                    miniFill.style.width = '0%';
                    miniTime.textContent = '0:00 / 0:00';
                    return;
                }
                this.setPlayIcon(playBtn, !cp.paused);
                const d = Number(cp.duration || 0);
                const c = Number(cp.currentTime || 0);
                if (d > 0){
                    miniFill.style.width = `${Math.max(0, Math.min(100, (c / d) * 100))}%`;
                    miniTime.textContent = `${this.formatDuration(c)} / ${this.formatDuration(d)}`;
                }else{
                    miniFill.style.width = '0%';
                    miniTime.textContent = '0:00 / 0:00';
                }
            };
            if (playBtn){
                playBtn.onclick = ()=>{
                    const cp = getChatPlayer();
                    if (!cp) return;
                    if (cp.paused) cp.play().catch(()=>{});
                    else cp.pause();
                    sync();
                };
            }
            if (miniProgress){
                miniProgress.onclick = (e)=>{
                    const cp = getChatPlayer();
                    if (!cp) return;
                    const rect = miniProgress.getBoundingClientRect();
                    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                    if (Number(cp.duration) > 0){
                        cp.currentTime = ratio * cp.duration;
                        sync();
                    }
                };
            }
            if (closeBtn){
                closeBtn.onclick = ()=>{
                    const cp = getChatPlayer();
                    try{
                        if (cp){
                            cp.pause();
                            cp.currentTime = 0;
                        }
                    }catch(_){ }
                    this.clearChatMiniSyncTimer();
                    if (this._miniTitleTicker){ clearInterval(this._miniTitleTicker); this._miniTitleTicker = null; }
                    mini.classList.remove('show');
                };
            }
            this.clearChatMiniSyncTimer();
            this._chatMiniSyncTimer = setInterval(sync, 180);
            sync();
            mini.classList.add('show');
        }catch(_){ }
    }

    addChatAudioToPlayer(track){
        try{
            if (!track || !track.src) return;
            const bg = this.getBgPlayer();
            if (!bg) return;
            this.pauseAllMediaExcept(null);
            bg.src = track.src;
            if (!isNaN(track.currentTime) && track.currentTime > 0) bg.currentTime = track.currentTime;
            bg.play().catch(()=>{});
            this.showMiniPlayer(bg, { title: track.title || 'Audio', by: track.by || '', cover: track.cover || '' });
            this._playQueue = [{ src: track.src, title: track.title || 'Audio', by: track.by || '', cover: track.cover || '' }];
            this._playQueueIndex = 0;
            this.renderQueuePanel();
        }catch(_){ }
    }

    showMiniPlayer(mediaEl, meta={}){
        try{
            this._miniControlledByChat = false;
            this.clearChatMiniSyncTimer();
            if (this._currentPlayer && this._currentPlayer !== mediaEl){
                try{ this._currentPlayer.pause(); }catch(_){}
                try{ this._currentPlayer._waveAttachProxy && this._currentPlayer._waveAttachProxy(null); }catch(_){ }
            }
            const prevPlayer = this._currentPlayer;
            this._currentPlayer = mediaEl;
            // Promote playback to a hidden background audio so it persists across sections
            const bg = this.getBgPlayer();
            const isVideo = String(mediaEl?.tagName || '').toUpperCase() === 'VIDEO';
            if (isVideo && bg && bg.currentSrc && prevPlayer && String(prevPlayer.tagName || '').toUpperCase() !== 'VIDEO'){
                this._interruptedAudioState = { src: bg.currentSrc, currentTime: bg.currentTime, mediaEl: prevPlayer };
            }
            const source = isVideo ? mediaEl : bg;
            const mini = document.getElementById('mini-player'); if (!mini) return;
            const mTitle = document.getElementById('mini-title');
            const mBy = document.getElementById('mini-by');
            const mCover = mini.querySelector('.cover');
            const playBtn = document.getElementById('mini-play');
            const repeatBtn = document.getElementById('mini-repeat');
            const addBtn = document.getElementById('mini-add-playlist');
            const queueBtn = document.getElementById('mini-queue');
            const queuePanel = document.getElementById('mini-queue-panel');
            const queueClose = document.getElementById('mini-queue-close');
            const closeBtn = document.getElementById('mini-close');
            const miniProgress = document.getElementById('mini-progress');
            const miniFill = document.getElementById('mini-fill');
            const miniTime = document.getElementById('mini-time');
            const resolvedTitle = String(
                meta.title
                || mediaEl?.dataset?.title
                || mediaEl?.closest('.post-item,.wave-item,.video-item')?.querySelector('.post-media-audio-title,.audio-title,.video-title,.post-media-video-head,.post-text')?.textContent
                || 'Now playing'
            ).trim();
            const resolvedBy = this.normalizeMediaByline(
                meta.by
                || mediaEl?.dataset?.by
                || mediaEl?.closest('.post-item,.wave-item,.video-item')?.querySelector('.post-media-audio-by,.audio-byline,.byline')?.textContent
                || ''
            );
            const resolvedArtist = String(resolvedBy || '').replace(/^by\s+/i, '').trim();
            const resolvedCover = String(meta.cover || mediaEl?.dataset?.cover || this.resolveMediaNodeCover(mediaEl) || '').trim();
            this.setMiniTitleText(resolvedTitle || 'Now playing');
            if (mBy) mBy.textContent = resolvedBy;
            if (mCover) mCover.src = resolvedCover || 'images/default-bird.png';
            if ('mediaSession' in navigator){
                try{
                    const coverUrl = resolvedCover || 'images/default-bird.png';
                    const imgType = /\.webp(\?|$)/i.test(coverUrl) ? 'image/webp' : /\.gif(\?|$)/i.test(coverUrl) ? 'image/gif' : /\.(jpe?g)(\?|$)/i.test(coverUrl) ? 'image/jpeg' : 'image/png';
                    const artwork = [
                        { src: coverUrl, sizes: '96x96', type: imgType },
                        { src: coverUrl, sizes: '128x128', type: imgType },
                        { src: coverUrl, sizes: '192x192', type: imgType },
                        { src: coverUrl, sizes: '256x256', type: imgType },
                        { src: coverUrl, sizes: '384x384', type: imgType },
                        { src: coverUrl, sizes: '512x512', type: imgType }
                    ];
                    navigator.mediaSession.metadata = new MediaMetadata({
                        title: resolvedTitle || 'Now playing',
                        artist: resolvedArtist,
                        artwork
                    });
                    navigator.mediaSession.setActionHandler('play', ()=> source.play().catch(()=>{}));
                    navigator.mediaSession.setActionHandler('pause', ()=> source.pause());
                    navigator.mediaSession.setActionHandler('seekbackward', ()=>{ source.currentTime = Math.max(0, (source.currentTime||0)-10); });
                    navigator.mediaSession.setActionHandler('seekforward', ()=>{ source.currentTime = Math.min((source.duration||0), (source.currentTime||0)+10); });
                }catch(_){ }
            }
            mini.classList.add('show');
            // Hand off current media to bg player
            try{
                this.pauseAllMediaExcept(mediaEl);
                if (!isVideo){
                    bg.src = mediaEl.currentSrc || mediaEl.src;
                    if (!isNaN(mediaEl.currentTime)) bg.currentTime = mediaEl.currentTime;
                    bg.play().catch(()=>{});
                    mediaEl.pause();
                    try{ mediaEl._waveAttachProxy && mediaEl._waveAttachProxy(bg); }catch(_){ }
                }else{
                    try{ bg.pause(); }catch(_){ }
                    try{ mediaEl._waveAttachProxy && mediaEl._waveAttachProxy(null); }catch(_){ }
                    if (mediaEl.paused) mediaEl.play().catch(()=>{});
                }
            }catch(_){ }
            if (playBtn){ playBtn.onclick = ()=>{ if (source.paused){ source.play().catch(()=>{}); } else { source.pause(); } }; }
            if (repeatBtn){
                repeatBtn.onclick = ()=> this.cycleRepeatMode();
                this.updateMiniRepeatButton();
            }
            const syncMiniBtn = ()=> this.setPlayIcon(playBtn, !source.paused);
            const syncProgress = ()=>{
                if (!miniFill || !miniTime) return;
                const d = Number(source.duration || 0);
                const c = Number(source.currentTime || 0);
                this.rememberPlaybackPosition(source.currentSrc || source.src || '', c, d);
                if (d > 0){
                    miniFill.style.width = `${Math.max(0, Math.min(100, (c / d) * 100))}%`;
                    miniTime.textContent = `${this.formatDuration(c)} / ${this.formatDuration(d)}`;
                } else {
                    miniFill.style.width = '0%';
                    miniTime.textContent = '0:00 / 0:00';
                }
            };
            if (miniProgress){
                miniProgress.onclick = (e)=>{
                    const rect = miniProgress.getBoundingClientRect();
                    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                    if (Number(source.duration) > 0) source.currentTime = ratio * source.duration;
                };
            }
            source.onplay = ()=>{ syncMiniBtn(); syncProgress(); };
            source.onpause = ()=>{ syncMiniBtn(); syncProgress(); };
            source.ontimeupdate = syncProgress;
            source.onloadedmetadata = syncProgress;
            source.onended = ()=>{
                syncMiniBtn();
                this.handleMiniPlaybackEnded(source);
            };
            syncMiniBtn(); syncProgress();
            if (closeBtn){ closeBtn.onclick = ()=>{ mini.classList.remove('show'); try{ source.pause(); }catch(_){} try{ mediaEl._waveAttachProxy && mediaEl._waveAttachProxy(null); }catch(_){ } if (this._miniTitleTicker){ clearInterval(this._miniTitleTicker); this._miniTitleTicker = null; } }; }
            if (queueBtn && queuePanel){
                queueBtn.onclick = ()=>{ this.renderQueuePanel(); queuePanel.style.display = queuePanel.style.display === 'none' ? 'block' : 'none'; };
            }
            if (queueClose && queuePanel){ queueClose.onclick = ()=> queuePanel.style.display = 'none'; }
            if (addBtn){
                addBtn.onclick = ()=> this.openAddToPlaylistPopup({
                    src: source.currentSrc || source.src,
                    title: mTitle?.dataset?.fullTitle || mTitle?.textContent || meta.title || 'Track',
                    by: mBy?.textContent || meta.by || '',
                    cover: (mCover && mCover.src) || meta.cover || ''
                });
            }

            // Build deterministic queue from current context.
            const contextRoot = mediaEl.closest('#wave-library') || mediaEl.closest('#global-feed') || mediaEl.closest('#space-feed') || mediaEl.closest('#video-library') || mediaEl.closest('#wave-results') || document;
            const nodes = Array.from(contextRoot.querySelectorAll('audio.player-media, video.player-media, .liber-lib-audio, .liber-lib-video'));
            const queue = nodes
                .map((n)=>({
                    src: n.currentSrc || n.src || '',
                    title: n.dataset?.title || n.closest('.wave-item,.video-item,.post-item')?.querySelector('.post-media-audio-title,.audio-title,.video-title,.post-text')?.textContent?.trim() || 'Track',
                    by: n.dataset?.by || n.closest('.wave-item,.video-item,.post-item')?.querySelector('.post-media-audio-by,.audio-byline')?.textContent?.trim() || '',
                    cover: this.resolveMediaNodeCover(n) || ''
                }))
                .filter((q)=> !!q.src);
            const currentSrc = source.currentSrc || source.src || '';
            this._playQueue = queue;
            this._playQueueIndex = Math.max(0, queue.findIndex((q)=> q.src === currentSrc));
            this.renderQueuePanel();

            // Keep deterministic behavior: do not auto-jump to random next tracks.
            if (this._onBgEnded){ try{ bg.removeEventListener('ended', this._onBgEnded); }catch(_){ } }
            this._onBgEnded = null;
        }catch(_){ }
    }

    // Activate custom players inside a container (audio/video unified controls)
    activatePlayers(root=document){
        try{
            root.querySelectorAll('.post-media-visual-shell').forEach((shell)=>{
                const wrap = shell.querySelector('.post-media-visual-wrap');
                if (!wrap || wrap.dataset.hScrollBound === '1') return;
                wrap.dataset.hScrollBound = '1';
                const slider = wrap.querySelector('.post-media-visual-slider');
                const dots = shell.querySelector('.post-media-dots');
                const getSlideStep = ()=>{
                    const first = slider?.querySelector('.post-media-visual-item');
                    if (!first) return Math.max(1, wrap.clientWidth || 1);
                    const gap = 8;
                    return Math.max(1, Math.round(first.clientWidth + gap));
                };
                const syncDots = ()=>{
                    if (!dots) return;
                    const step = getSlideStep();
                    const idx = Math.max(0, Math.round((wrap.scrollLeft || 0) / step));
                    dots.querySelectorAll('.post-media-dot').forEach((d, i)=> d.classList.toggle('active', i === idx));
                };
                if (dots){
                    dots.querySelectorAll('.post-media-dot').forEach((btn)=>{
                        btn.addEventListener('click', ()=>{
                            const idx = Number(btn.getAttribute('data-slide-index') || 0);
                            const step = getSlideStep();
                            wrap.scrollTo({ left: Math.max(0, idx * step), behavior: 'smooth' });
                            syncDots();
                        });
                    });
                }
                let sx = 0;
                let sy = 0;
                let horizontalLock = false;
                wrap.addEventListener('touchstart', (e)=>{
                    const t = e.touches && e.touches[0];
                    if (!t) return;
                    sx = t.clientX;
                    sy = t.clientY;
                    horizontalLock = false;
                }, { passive: true });
                wrap.addEventListener('touchmove', (e)=>{
                    const t = e.touches && e.touches[0];
                    if (!t) return;
                    const dx = t.clientX - sx;
                    const dy = t.clientY - sy;
                    if (!horizontalLock && Math.abs(dx) > (Math.abs(dy) + 6)){
                        horizontalLock = true;
                    }
                    if (horizontalLock){
                        e.stopPropagation();
                    }
                }, { passive: true });
                wrap.addEventListener('touchend', ()=>{ horizontalLock = false; }, { passive: true });
                wrap.addEventListener('scroll', ()=> syncDots(), { passive: true });
                syncDots();
            });
            let myVisualIndexPromise = null;
            const ensureMyVisualIndex = async ()=>{
                if (myVisualIndexPromise) return myVisualIndexPromise;
                myVisualIndexPromise = (async ()=>{
                    const me = await this.resolveCurrentUser();
                    if (!me || !me.uid) return { videos: new Set(), pictures: new Set() };
                    return await this.getMyVisualLibraryIndex(me.uid);
                })();
                return myVisualIndexPromise;
            };
            root.querySelectorAll('.post-save-visual-btn').forEach((btn)=>{
                if (btn.dataset.boundSaveVisual === '1') return;
                btn.dataset.boundSaveVisual = '1';
                ensureMyVisualIndex().then((idx)=>{
                    const target = String(btn.dataset.saveTarget || 'videos');
                    const url = String(btn.dataset.url || '').trim();
                    if (!url) return;
                    const set = target === 'pictures' ? idx.pictures : idx.videos;
                    if (!set || !set.has(url)) return;
                    btn.dataset.saved = '1';
                    btn.innerHTML = `<i class="fas fa-check"></i>`;
                    btn.title = 'Saved - click to remove';
                }).catch(()=>{});
                btn.addEventListener('click', async ()=>{
                    const media = {
                        kind: String(btn.dataset.kind || ''),
                        url: String(btn.dataset.url || ''),
                        title: String(btn.dataset.title || ''),
                        by: String(btn.dataset.by || ''),
                        cover: String(btn.dataset.cover || ''),
                        authorId: String(btn.dataset.authorId || '')
                    };
                    const target = String(btn.dataset.saveTarget || 'videos');
                    const visualKind = target === 'pictures' ? 'image' : 'video';
                    if (btn.dataset.saved === '1'){
                        const removed = await this.removeVisualFromLibrary(visualKind, media.url);
                        if (!removed) return;
                        try{
                            const idx = await ensureMyVisualIndex();
                            const set = target === 'pictures' ? idx.pictures : idx.videos;
                            set && set.delete(String(media.url || '').trim());
                        }catch(_){ }
                        btn.dataset.saved = '0';
                        btn.innerHTML = `<i class="fas fa-plus"></i>`;
                        btn.title = target === 'pictures' ? 'To My Pictures' : 'To My Videos';
                        return;
                    }
                    const ok = await this.saveVisualToLibrary(media, target === 'pictures' ? 'pictures' : 'videos');
                    if (!ok) return;
                    try{
                        const idx = await ensureMyVisualIndex();
                        const set = target === 'pictures' ? idx.pictures : idx.videos;
                        set && set.add(String(media.url || '').trim());
                    }catch(_){ }
                    btn.dataset.saved = '1';
                    btn.innerHTML = `<i class="fas fa-check"></i>`;
                    btn.title = 'Saved - click to remove';
                });
            });
            root.querySelectorAll('.post-playlist-play-btn').forEach((btn)=>{
                if (btn.dataset.boundPlaylistPlay === '1') return;
                btn.dataset.boundPlaylistPlay = '1';
                btn.addEventListener('click', async ()=>{
                    try{
                        const fromCard = decodeURIComponent(String(btn.dataset.playlistItems || ''));
                        let items = [];
                        try{ items = JSON.parse(fromCard); }catch(_){ items = []; }
                        if (!Array.isArray(items) || !items.length){
                            const pid = String(btn.dataset.playlistId || '').trim();
                            if (pid){
                                try{
                                    const snap = await firebase.getDoc(firebase.doc(window.firebaseService.db, 'playlists', pid));
                                    if (snap.exists()) items = Array.isArray(snap.data()?.items) ? snap.data().items : [];
                                }catch(_){ }
                            }
                        }
                        const queue = (Array.isArray(items) ? items : [])
                            .filter((x)=> String(x?.src || '').trim())
                            .map((x)=> ({
                                src: String(x.src || ''),
                                title: String(x.title || 'Track'),
                                by: String(x.by || ''),
                                cover: String(x.cover || '')
                            }));
                        if (!queue.length){ this.showError('Playlist is empty'); return; }
                        this._playQueue = queue;
                        this._playQueueIndex = 0;
                        this.playQueueIndex(0, { restart: true });
                    }catch(_){ this.showError('Failed to play playlist'); }
                });
            });
            root.querySelectorAll('.player-card').forEach(card=>{
                if (card.dataset.playerBound === '1') return;
                card.dataset.playerBound = '1';
                const media = card.querySelector('.player-media');
                if (!media) return;
                if (String(media.tagName || '').toUpperCase() === 'AUDIO'){
                    const bar = card.querySelector('.player-bar');
                    if (bar) bar.style.display = 'none';
                    this.attachWaveAudioUI(media, card, { hideNative: true });
                }
                const btn = card.querySelector('.btn-icon');
                const fill = card.querySelector('.progress .fill');
                let knob = card.querySelector('.progress .knob');
                if (!knob){ const k = document.createElement('div'); k.className='knob'; const bar = card.querySelector('.progress'); if (bar){ bar.appendChild(k); knob = k; } }
                const time = card.querySelector('.time');
                const fmt = (s)=>{ const m=Math.floor(s/60); const ss=Math.floor(s%60).toString().padStart(2,'0'); return `${m}:${ss}`; };
                const sync = ()=>{ if (!media.duration) return; const p=(media.currentTime/media.duration)*100; if (fill) fill.style.width = `${p}%`; if (knob){ knob.style.left = `${p}%`; } if (time) time.textContent = `${fmt(media.currentTime)} / ${fmt(media.duration)}`; };
                if (btn){
                    btn.onclick = ()=>{
                        if (media.paused){
                            this.pauseAllMediaExcept(media);
                            media.play().catch(()=>{});
                            this.setPlayIcon(btn, true);
                        } else {
                            media.pause();
                            this.setPlayIcon(btn, false);
                        }
                    };
                }
                media.addEventListener('timeupdate', sync);
                media.addEventListener('loadedmetadata', sync);
                media.addEventListener('play', ()=> this.setPlayIcon(btn, true));
                media.addEventListener('pause', ()=> this.setPlayIcon(btn, false));
                media.addEventListener('ended', ()=> this.setPlayIcon(btn, false));
                const bar = card.querySelector('.progress');
                if (bar){
                    const seekTo = (clientX)=>{
                        const rect = bar.getBoundingClientRect();
                        const ratio = Math.min(1, Math.max(0, (clientX-rect.left)/rect.width));
                        if (media.duration){ media.currentTime = ratio * media.duration; }
                        if (media.paused){ this.pauseAllMediaExcept(media); media.play().catch(()=>{}); this.setPlayIcon(btn, true); }
                    };
                    bar.addEventListener('click', (e)=> seekTo(e.clientX));
                    let dragging = false;
                    bar.addEventListener('pointerdown', (e)=>{ dragging = true; bar.setPointerCapture(e.pointerId); seekTo(e.clientX); });
                    bar.addEventListener('pointermove', (e)=>{ if (dragging) seekTo(e.clientX); });
                    bar.addEventListener('pointerup', (e)=>{ dragging = false; bar.releasePointerCapture(e.pointerId); });
                }
                // keyboard shortcuts when focused
                card.tabIndex = 0;
                card.onkeydown = (e)=>{
                    if (e.code === 'Space'){ e.preventDefault(); btn && btn.click(); }
                    if (e.code === 'ArrowLeft'){ media.currentTime = Math.max(0, media.currentTime - 5); }
                    if (e.code === 'ArrowRight'){ media.currentTime = Math.min(media.duration||0, media.currentTime + 5); }
                };

                media.addEventListener('play', ()=>{
                    const title = media.dataset?.title || card.closest('.post-item')?.querySelector('.post-media-audio-title,.audio-title,.post-text')?.textContent?.slice(0, 60) || 'Now playing';
                    const by = media.dataset?.by || card.closest('.post-item')?.querySelector('.post-media-audio-by,.byline,.audio-byline')?.textContent || '';
                    const cover = media.dataset?.cover || this.resolveMediaNodeCover(media) || '';
                    this.showMiniPlayer(media, { title, by: this.normalizeMediaByline(by), cover });
                });
            });
        }catch(_){ }
    }

    /**
     * Initialize the dashboard
     */
    init() {
        try{
            const prefLang = String(localStorage.getItem('liber_preferred_language') || 'en').trim().toLowerCase();
            this.applyAppLanguage(prefLang);
        }catch(_){ }
        this.setupEventListeners();
        this.setupFullscreenImagePreview();
        this.setupFeedTabs();
        this.setupVideoHostTabs();
        window.addEventListener('liber:app-shell-open', ()=> this.suspendDashboardActivity());
        window.addEventListener('liber:app-shell-close', ()=> this.resumeDashboardActivity());
        // Prevent browser-autofill from leaking login email into dashboard search fields.
        ['app-search', 'space-search', 'user-search', 'wave-search', 'video-search', 'wall-search'].forEach((id) => {
            const el = document.getElementById(id);
            if (el){
                el.value = '';
                el.setAttribute('autocomplete', id === 'wall-search' ? 'new-password' : 'off');
                el.setAttribute('autocorrect', 'off');
                el.setAttribute('autocapitalize', 'off');
                el.setAttribute('spellcheck', 'false');
                el.setAttribute('name', `${id}-${Date.now()}`);
                if (id === 'wall-search') el.setAttribute('readonly', 'readonly');
            }
        });
        // Harden against browser autofill on dynamically rendered fields.
        document.querySelectorAll('#dashboard input, #dashboard textarea').forEach((el)=>{
            try{
                if ((el.type || '').toLowerCase() === 'password') return;
                el.setAttribute('autocomplete', 'off');
                el.setAttribute('autocorrect', 'off');
                el.setAttribute('autocapitalize', 'off');
                el.setAttribute('spellcheck', 'false');
                if (!el.getAttribute('name')) el.setAttribute('name', 'fld-' + Math.random().toString(36).slice(2, 9));
                if (/@/.test((el.value || '').trim())) el.value = '';
            }catch(_){ }
        });
        // Extra scrub: clear browser-restored account values from non-auth inputs.
        const scrubSearchPrefill = ()=>{
            try{
                const raw = localStorage.getItem('liber_accounts');
                const accounts = raw ? JSON.parse(raw) : [];
                const bad = new Set();
                (accounts||[]).forEach(a=>{
                    if (a && typeof a.email === 'string' && a.email) bad.add(a.email.trim().toLowerCase());
                    if (a && typeof a.username === 'string' && a.username) bad.add(a.username.trim().toLowerCase());
                });
                ['app-search','space-search','user-search','wave-search','video-search','wall-search'].forEach((id)=>{
                    const el = document.getElementById(id);
                    if (!el) return;
                    const v = String(el.value || '').trim();
                    if (!v) return;
                    const low = v.toLowerCase();
                    if (bad.has(low) || /@/.test(v)) el.value = '';
                });
            }catch(_){ }
        };
        scrubSearchPrefill();
        setTimeout(scrubSearchPrefill, 120);
        setTimeout(scrubSearchPrefill, 900);
        window.addEventListener('pageshow', scrubSearchPrefill);
        document.addEventListener('focusin', (e)=>{
            const el = e.target;
            if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
            try{
                if ((el.type || '').toLowerCase() === 'password') return;
                el.setAttribute('autocomplete', 'off');
                el.setAttribute('autocorrect', 'off');
                el.setAttribute('autocapitalize', 'off');
                el.setAttribute('spellcheck', 'false');
                if (/@/.test((el.value || '').trim())) el.value = '';
            }catch(_){ }
        }, true);
        try{
            const fromHash = (window.location.hash||'').replace('#','');
            const stored = localStorage.getItem('liber_last_section') || '';
            const preferred = fromHash || stored || 'apps';
            const runInitialLoad = ()=>{
                if (this._dashboardSuspended) return;
                try{
                    this.switchSection(preferred);
                    if (preferred === 'feed'){
                        setTimeout(()=> this.loadGlobalFeed(this._wallSearchTerm || ''), 120);
                    }
                    const returnTo = (typeof URLSearchParams !== 'undefined' && new URLSearchParams(window.location.search).get('returnTo')) || '';
                    if ((returnTo === 'chat' || returnTo === 'tracker') && window.appsManager && typeof window.appsManager.loadApps === 'function'){
                        setTimeout(()=> window.appsManager.loadApps(), 300);
                    }
                    setTimeout(()=>{ this.handleIncomingDeepLink().catch(()=>{}); }, 260);
                    setTimeout(()=>{ this.handleIncomingShareIntent().catch(()=>{}); }, 420);
                }catch(_){ this.switchSection('apps'); }
            };
            if (window.firebaseService && window.firebaseService.isInitialized){
                runInitialLoad();
            } else {
                const onReady = ()=>{
                    window.removeEventListener('firebase-ready', onReady);
                    runInitialLoad();
                };
                window.addEventListener('firebase-ready', onReady);
                setTimeout(()=>{
                    if (window.firebaseService && window.firebaseService.isInitialized){
                        window.removeEventListener('firebase-ready', onReady);
                        runInitialLoad();
                    }
                }, 800);
            }
        }catch(_){ this.switchSection('apps'); }
        this.updateNavigation();
        // Mobile Chrome/PWA can hydrate auth state slightly later; retry nav role gate.
        [900, 2200, 4000, 5500, 7000].forEach((ms)=> setTimeout(()=> this.updateNavigation().catch(()=>{}), ms));
        if (!document._liberNavVisibilityBound) {
            document._liberNavVisibilityBound = true;
            document.addEventListener('visibilitychange', ()=> { if (document.visibilityState === 'visible') this.updateNavigation().catch(()=>{}); });
        }
        this.restoreChatUnreadBadgeFromStorage();
        this.handleWallETransitionToDashboard();
        // Service worker registration (best-effort)
        if ('serviceWorker' in navigator){
            const swPath = (location.pathname && (location.pathname.includes('/control-panel/') || location.pathname.includes('/liber-apps/')))
                ? new URL('sw.js', location.href).pathname
                : '/sw.js';
            navigator.serviceWorker.register(swPath).catch(()=>{});
        }

        // Cache current user for feed actions
        (async()=>{
            try{ this.currentUser = await this.resolveCurrentUser(); }catch(_){ this.currentUser = null; }
            // Keep it fresh
            try{
                firebase.onAuthStateChanged(window.firebaseService.auth, (u)=>{
                    this.currentUser = u || null;
                    this.updateVerificationBanner();
                    this.updateNavigation();
                    this.stopPendingRequestListener();
                    if (u && u.uid) this.startPendingRequestListener();
                });
            }catch(_){ }
            this.updateVerificationBanner();
        })();

        // Global delegated handlers for feed interactions (Feed tab and Personal Space feed)
        if (!window.__LIBER_FEED_DELEGATE_BOUND__){
            window.__LIBER_FEED_DELEGATE_BOUND__ = true;
            const handler = async (e)=>{
                const inFeed = document.getElementById('global-feed')?.contains(e.target) || document.getElementById('space-feed')?.contains(e.target);
                if (!inFeed) return;
                const likeEl = e.target.closest('.like-btn');
                const commentEl = e.target.closest('.comment-btn');
                const repostEl = e.target.closest('.repost-btn');
                const actionEl = likeEl || commentEl || repostEl;
                if (!actionEl) return;
                const delegatedContainer = actionEl.closest('#global-feed, #space-feed');
                // Avoid double handling when container-level delegation is active.
                if (delegatedContainer && delegatedContainer.__postActionsDelegated) return;
                const actionsWrap = actionEl.closest('.post-actions');
                const postItem = actionEl.closest('.post-item');
                const pid = actionsWrap?.dataset.postId || postItem?.dataset.postId;
                if (!pid) return;
                let me = this.currentUser;
                if (!me){ try{ me = await this.resolveCurrentUser(); this.currentUser = me; }catch(_){ return; } }
                if (!me || !me.uid) return;
                if (likeEl){
                    try{ const likeRef = firebase.doc(window.firebaseService.db,'posts',pid,'likes', me.uid); const s=await firebase.getDoc(likeRef); if(s.exists()) await firebase.deleteDoc(likeRef); else await firebase.setDoc(likeRef,{ userId:me.uid, createdAt:new Date().toISOString() }); }catch(_){ }
                    return;
                }
                if (repostEl){
                    try{ const repRef = firebase.doc(window.firebaseService.db,'posts',pid,'reposts', me.uid); const s=await firebase.getDoc(repRef); if(s.exists()) await firebase.deleteDoc(repRef); else await firebase.setDoc(repRef,{ userId:me.uid, createdAt:new Date().toISOString() }); }catch(_){ }
                    return;
                }
                if (commentEl){
                    const tree = postItem?.querySelector('.comment-tree') || document.getElementById(`comments-${pid}`);
                    if (tree) return; // Advanced comments are handled at container/post level.
                    const text = prompt('Add comment:');
                    if (text && text.trim()){ try{ await firebase.addDoc(firebase.collection(window.firebaseService.db,'posts',pid,'comments'), { userId:me.uid, text:text.trim(), createdAt:new Date().toISOString() }); }catch(_){ } }
                    return;
                }
            };
            document.addEventListener('click', handler);
        }
    }

    /**
     * Setup dashboard event listeners
     */
    setupEventListeners() {
        // Desktop navigation buttons
        const openChatApp = () => {
            const full = new URL('apps/secure-chat/index.html', window.location.href).href;
            if (window.appsManager && typeof window.appsManager.openAppInShell === 'function') {
                window.appsManager.openAppInShell({ id: 'secure-chat', name: 'Connections' }, full);
            } else {
                window.location.href = full;
            }
        };
        const navBtns = document.querySelectorAll('.nav-btn');
        navBtns.forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => this.switchSection(newBtn.dataset.section));
            if (newBtn.dataset.section === 'apps' && window.firebaseService?.prefetchChatConnections) {
                newBtn.addEventListener('mouseenter', () => window.firebaseService.prefetchChatConnections().catch(()=>{}), { once: false });
            }
        });

        const chatBtn = document.getElementById('dashboard-chat-btn');
        if (chatBtn) {
            const c = chatBtn.cloneNode(true);
            chatBtn.parentNode.replaceChild(c, chatBtn);
            c.addEventListener('click', openChatApp);
        }

        // Mobile navigation buttons
        const mobileNavBtns = document.querySelectorAll('.mobile-nav-btn');
        mobileNavBtns.forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            if (newBtn.id === 'mobile-wall-e-btn') {
                newBtn.addEventListener('click', () => this.toggleWallEWidget());
            } else if (newBtn.id === 'mobile-wave-upload-btn') {
                newBtn.addEventListener('click', ()=>{
                    this.switchSection('waveconnect');
                    this.openWaveUploadWizard(this._waveMainTab || 'audio');
                });
            } else {
                newBtn.addEventListener('click', () => this.switchSection(newBtn.dataset.section));
            }
        });
        if (!this._videoPlayerEventBridgeBound){
            this._videoPlayerEventBridgeBound = true;
            window.addEventListener('liber-video-comments-open', async (e)=>{
                try{
                    const item = e?.detail || {};
                    const postId = await this.ensureAssetDiscussionPost({
                        kind: 'video',
                        sourceId: String(item.sourceId || ''),
                        url: String(item.url || ''),
                        title: String(item.title || 'Video'),
                        by: String(item.author || item.by || ''),
                        authorName: String(item.author || item.by || ''),
                        cover: String(item.poster || item.cover || '')
                    });
                    if (postId) await this.openAssetCommentsModal(postId, String(item.title || 'Comments'));
                }catch(_){ }
            });
            window.addEventListener('liber-video-engagement-sync', (e)=>{
                try{
                    const d = e?.detail || {};
                    const kind = String(d.kind || 'video').toLowerCase();
                    const normUrl = this.normalizeMediaUrl(String(d.url || ''));
                    const sourceId = String(d.sourceId || '').trim();
                    const likes = String(Math.max(0, Number(d.likesCount || 0) || 0));
                    const comments = String(Math.max(0, Number(d.commentsCount || 0) || 0));
                    const views = String(Math.max(0, Number(d.viewsCount || 0) || 0));
                    document.querySelectorAll('.liber-lib-video').forEach((node)=>{
                        try{
                            const nodeUrl = this.normalizeMediaUrl(String(node.currentSrc || node.src || ''));
                            const nodeSourceId = String(node.dataset.sourceId || '').trim();
                            const match = (!!sourceId && nodeSourceId === sourceId) || this.urlsLikelySame(nodeUrl, normUrl);
                            if (!match) return;
                            node.dataset.likesCount = likes;
                            node.dataset.commentsCount = comments;
                            node.dataset.viewsCount = views;
                            const card = node.closest('.video-item,.wave-item,[data-asset-like-kind][data-asset-like-url]');
                            if (!card) return;
                            const lc = card.querySelector('.asset-like-count');
                            const cc = card.querySelector('.asset-comments-count');
                            const vc = card.querySelector('.asset-views-count');
                            if (lc) lc.textContent = likes;
                            if (cc) cc.textContent = comments;
                            if (vc) vc.textContent = views;
                        }catch(_){ }
                    });
                    document.querySelectorAll('[data-asset-like-kind][data-asset-like-url]').forEach((host)=>{
                        try{
                            const k = String(host.getAttribute('data-asset-like-kind') || '').toLowerCase();
                            const u = this.normalizeMediaUrl(String(host.getAttribute('data-asset-like-url') || ''));
                            if (k !== kind) return;
                            if (!this.urlsLikelySame(u, normUrl)) return;
                            const lc = host.querySelector('.asset-like-count');
                            const cc = host.querySelector('.asset-comments-count');
                            const vc = host.querySelector('.asset-views-count');
                            if (lc) lc.textContent = likes;
                            if (cc) cc.textContent = comments;
                            if (vc) vc.textContent = views;
                        }catch(_){ }
                    });
                }catch(_){ }
            });
            window.addEventListener('liber-video-author-open', async (e)=>{
                try{
                    const item = e?.detail || {};
                    let uid = String(item.authorId || '').trim();
                    if (!uid){
                        const sid = String(item.sourceId || '').trim();
                        if (sid){
                            const snap = await firebase.getDoc(firebase.doc(window.firebaseService.db, 'videos', sid));
                            if (snap.exists()){
                                const data = snap.data() || {};
                                uid = String(data.authorId || data.owner || data.originalAuthorId || '').trim();
                            }
                        }
                    }
                    if (!uid){
                        const mediaUrl = String(item.url || '').trim();
                        if (mediaUrl){
                            try{
                                const q = firebase.query(
                                    firebase.collection(window.firebaseService.db, 'videos'),
                                    firebase.where('url', '==', mediaUrl),
                                    firebase.limit(1)
                                );
                                const s = await firebase.getDocs(q);
                                if (!s.empty){
                                    const data = s.docs[0].data() || {};
                                    uid = String(data.authorId || data.owner || data.originalAuthorId || '').trim();
                                }
                            }catch(_){ }
                        }
                    }
                    if (uid) this.showUserPreviewModal(uid);
                }catch(_){ }
            });
            window.addEventListener('liber-video-share-chat', async (e)=>{
                try{
                    const item = e?.detail || {};
                    e?.preventDefault?.();
                    await this.openShareToChatSheet({
                        kind: 'video',
                        url: String(item.url || ''),
                        title: String(item.title || 'Video'),
                        name: String(item.title || 'Video'),
                        by: String(item.author || item.by || ''),
                        authorName: String(item.author || item.by || ''),
                        cover: String(item.poster || item.cover || ''),
                        thumbnailUrl: String(item.poster || item.cover || ''),
                        sourceId: String(item.sourceId || '')
                    });
                }catch(_){ }
            });
            window.addEventListener('liber-video-copy-link', async (e)=>{
                try{
                    const item = e?.detail || {};
                    const link = this.buildPublicShareLink({
                        kind: 'wave',
                        type: 'video',
                        id: String(item.sourceId || item.id || '').trim(),
                        url: String(item.url || '').trim()
                    });
                    await this.copyShareLinkToClipboard(link, 'Video link copied');
                    try{ item.__liberShareHandled = true; }catch(_){ }
                }catch(_){ this.showError('Failed to copy'); }
            });
            window.addEventListener('liber-video-share-external', async (e)=>{
                try{
                    const item = e?.detail || {};
                    const link = this.buildPublicShareLink({
                        kind: 'wave',
                        type: 'video',
                        id: String(item.sourceId || item.id || '').trim(),
                        url: String(item.url || '').trim()
                    });
                    const title = String(item.title || 'Video').trim() || 'Video';
                    const text = String(item.description || '').trim();
                    if (navigator.share){
                        await navigator.share({ title, text, url: link });
                    } else {
                        await this.copyShareLinkToClipboard(link, 'Video link copied');
                    }
                    try{ item.__liberShareHandled = true; }catch(_){ }
                }catch(_){ }
            });
        }

        // Logout button
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn && logoutBtn.parentNode) logoutBtn.parentNode.removeChild(logoutBtn);
        const spaceLogoutBtn = document.getElementById('space-logout-btn');
        if (spaceLogoutBtn) {
            const btn = spaceLogoutBtn.cloneNode(true);
            spaceLogoutBtn.parentNode.replaceChild(btn, spaceLogoutBtn);
            btn.addEventListener('click', () => authManager.logout());
        }

        // Settings form handlers
        this.setupSettingsHandlers();
        this.setupMobileSectionSwipe();

        // Prevent browser autofill in dynamic search/comment fields.
        if (!this._autofillGuardBound){
            this._autofillGuardBound = true;
            document.addEventListener('focusin', (e)=>{
                const t = e.target;
                if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
                const isTarget = t.matches('#app-search,#space-search,#user-search,#wave-search,#video-search,#wall-search,.reply-input');
                if (!isTarget) return;
                t.setAttribute('autocomplete', 'off');
                t.setAttribute('autocorrect', 'off');
                t.setAttribute('autocapitalize', 'off');
                t.setAttribute('spellcheck', 'false');
                if (!t.getAttribute('name')) t.setAttribute('name', 'fld-' + Math.random().toString(36).slice(2, 9));
                if (/@/.test((t.value || '').trim())) t.value = '';
            }, true);
        }

        // Simple account switcher UI: fill a dropdown if exists
        const switcher = document.getElementById('account-switcher');
        const addAcct = document.getElementById('add-account-btn');
        if (switcher){
            try{
                const raw = localStorage.getItem('liber_accounts');
                const accounts = raw ? JSON.parse(raw) : [];
                switcher.innerHTML = '<option value="">Switch account…</option>' + accounts.map(a=>`<option value="${a.uid||''}">${a.username||a.email}</option>`).join('');
                // Toggle visibility based on availability
                if (Array.isArray(accounts) && accounts.length > 0) { switcher.style.display = ''; }
                else { switcher.style.display = ''; }
                if (addAcct){ addAcct.style.display = 'inline-block'; addAcct.onclick = ()=>{ try{ window.location.hash = 'login'; if (window.authManager && typeof window.authManager.switchTab==='function'){ window.authManager.switchTab('login'); } }catch(_){ } }; }
                // Open popup on click instead of native select UX
                switcher.addEventListener('mousedown', (e)=>{ e.preventDefault(); this.showAccountSwitcherPopup(); });
            }catch(_){ }
        }

        // Ensure a visible switch-accounts button in header near logout/search
        try{
            const btn = document.getElementById('switch-accounts-btn');
            if (btn && !btn._bound){ btn._bound = true; btn.addEventListener('click', ()=> this.showAccountSwitcherPopup()); }
            const spaceBtn = document.getElementById('space-switch-btn');
            if (spaceBtn && !spaceBtn._bound){ spaceBtn._bound = true; spaceBtn.addEventListener('click', ()=> this.showAccountSwitcherPopup()); }
        }catch(_){ }

        // Account switcher popup UI
        this.showAccountSwitcherPopup = async ()=>{
            try{
                const raw = localStorage.getItem('liber_accounts');
                const accounts = raw ? JSON.parse(raw) : [];
                const me = await window.firebaseService.getCurrentUser();
                const currentUid = me && me.uid;
                // Create / reuse layer
                let layer = document.getElementById('account-switcher-layer');
                if (!layer){
                    layer = document.createElement('div');
                    layer.id = 'account-switcher-layer';
                    layer.style.cssText = 'position:fixed;top:60px;right:20px;background:#0f1116;border:1px solid var(--border-color);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);z-index:1000;min-width:260px;max-width:320px;max-height:60vh;overflow:auto;padding:8px';
                    document.body.appendChild(layer);
                }
                const rows = accounts.map(a=>{
                    const checked = (a.uid===currentUid) ? '<span style="color:#22c55e">✔</span>' : '';
                    const avatar = a.avatarUrl || 'images/default-bird.png';
                    const label = a.username || a.email || a.uid;
                    return `<div class="acct-row" data-uid="${a.uid||''}" style="display:flex;gap:10px;align-items:center;padding:8px;border-radius:8px;cursor:pointer">
                              <img src="${avatar}" style="width:28px;height:28px;border-radius:50%;object-fit:cover"> 
                              <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${label}</div>
                              ${checked}
                            </div>`;
                }).join('');
                layer.innerHTML = `<div style="padding:6px 8px;font-weight:600;border-bottom:1px solid var(--border-color)">Switch account</div>
                                    <div>${rows || '<div style="padding:12px;opacity:.8">No saved accounts</div>'}</div>
                                    <div style="padding:8px;border-top:1px solid var(--border-color)"><button id="acct-add" class="btn btn-secondary" style="width:100%"><i class="fas fa-user-plus"></i> Add account</button></div>`;

                layer.querySelectorAll('.acct-row').forEach(row=>{
                    row.onclick = async ()=>{
                        const uid = row.getAttribute('data-uid'); if (!uid) return;
                        try{
                            const fnErrors = [];
                            const callSwitchFn = async (name, payload)=>{
                                const fs = window.firebaseService;
                                const preferred = (()=>{ try{ return localStorage.getItem('liber_functions_region') || 'europe-west1'; }catch(_){ return 'europe-west1'; } })();
                                const regions = [preferred, 'europe-west1'].filter((v,i,a)=> v && a.indexOf(v)===i);
                                const errs = [];
                                for (const r of regions){
                                    try{
                                        if (window.firebaseModular?.httpsCallable && fs?.app){
                                            const f = (fs.functionsByRegion && fs.functionsByRegion[r])
                                                ? fs.functionsByRegion[r]
                                                : (window.firebaseModular.getFunctions ? window.firebaseModular.getFunctions(fs.app, r) : null);
                                            if (!f) throw new Error('functions unavailable');
                                            const callable = window.firebaseModular.httpsCallable(f, name);
                                            const res = await callable(payload);
                                            return (res && res.data) || null;
                                        }
                                    }catch(e){
                                        const code = e?.code || '';
                                        const msg = e?.message || '';
                                        errs.push(`${name}@${r}[callable]: ${code}${msg ? ` (${msg})` : ''}`.trim());
                                    }
                                }
                                throw new Error(errs.join(' | '));
                            };
                            const callFnMaybe = async (name, payload)=>{
                                try{ return await callSwitchFn(name, payload); }
                                catch(e){
                                    fnErrors.push(`${name}: ${e?.message || e}`);
                                    return null;
                                }
                            };
                            const deviceId = this.getOrCreateDeviceId();
                            // Refresh current account seed token before attempting a switch.
                            try{
                                const ua = navigator.userAgent || '';
                                const seed = await callFnMaybe('saveSwitchToken', { deviceId, ua });
                                const tok = seed && seed.token;
                                if (tok){
                                    const meNow = await window.firebaseService.getCurrentUser();
                                    if (meNow && meNow.uid){
                                        const rawT = localStorage.getItem('liber_switch_tokens');
                                        const mapT = rawT ? JSON.parse(rawT) : {};
                                        mapT[meNow.uid] = tok;
                                        localStorage.setItem('liber_switch_tokens', JSON.stringify(mapT));
                                    }
                                }
                            }catch(_){ }
                            let tokenMap = JSON.parse(localStorage.getItem('liber_switch_tokens')||'{}');
                            let token = tokenMap[uid];
                            // If selecting current account, just close
                            if (uid === currentUid){ try{ layer.remove(); }catch(_){ } return; }
                            let isAdmin = false;
                            try{
                                const meData = await window.firebaseService.getUserData(currentUid);
                                isAdmin = String(meData?.role || 'user').toLowerCase() === 'admin';
                            }catch(_){ isAdmin = false; }
                            let customToken = null;
                            // Cache-proof same-device switch (requires both accounts seeded on this device).
                            const byDevice = await callFnMaybe('switchToByDevice', { uid, deviceId });
                            customToken = byDevice?.customToken || null;
                            // Secondary fallback: direct admin-issued custom token.
                            // Server enforces admin role, so it's safe to attempt unconditionally.
                            if (!customToken && isAdmin){
                                const adminSw = await callFnMaybe('adminSwitchToUser', { uid });
                                customToken = adminSw?.customToken || null;
                            }
                            if (!customToken){
                                // Do NOT reload on failed switch. Route to login with one-time prefill.
                                const acc = (accounts||[]).find(a=> (a.uid===uid));
                                const prefill = (acc && (acc.email || acc.username)) || '';
                                try{
                                    if (prefill){
                                        sessionStorage.setItem('liber_switch_prefill_email', prefill);
                                        localStorage.setItem('liber_prefill_email', prefill);
                                    }
                                }catch(_){ }
                                try{ layer.remove(); }catch(_){ }
                                const authScreen = document.getElementById('auth-screen');
                                const dashboard = document.getElementById('dashboard');
                                if (authScreen && dashboard){ dashboard.classList.add('hidden'); authScreen.classList.remove('hidden'); }
                                if (window.authManager && typeof window.authManager.switchTab==='function'){ window.authManager.switchTab('login'); }
                                const emailInput = document.getElementById('loginUsername'); if (emailInput && prefill){ emailInput.value = prefill; emailInput.focus(); }
                                if (fnErrors.length){
                                    console.warn('Instant switch call errors:', fnErrors.join(' | '));
                                }
                                const onlyByDeviceDenied = fnErrors.length > 0 && fnErrors.every((s)=> /switchToByDevice/i.test(s) && /permission-denied/i.test(s));
                                if (onlyByDeviceDenied){
                                    this.showInfo('Target account needs one login on this device first, then instant switch will work.');
                                } else {
                                    this.showError('Instant switch unavailable. Log in once for this account on this device.');
                                }
                                return;
                            }
                            if (firebase.signInWithCustomToken) {
                                await firebase.signInWithCustomToken(window.firebaseService.auth, customToken);
                            } else if (window.firebaseModular && window.firebaseModular.signInWithCustomToken) {
                                await window.firebaseModular.signInWithCustomToken(window.firebaseService.auth, customToken);
                            } else {
                                throw new Error('signInWithCustomToken API not available');
                            }
                            window.location.reload();
                        }catch(e){ console.error('Switch failed', e); this.showError('Switch failed'); }
                    };
                });
                const addBtn = document.getElementById('acct-add');
                if (addBtn){ addBtn.onclick = ()=>{ try{ layer.remove();
                    // Show auth screen and select login tab
                    const authScreen = document.getElementById('auth-screen');
                    const dashboard = document.getElementById('dashboard');
                    if (authScreen && dashboard){ dashboard.classList.add('hidden'); authScreen.classList.remove('hidden'); }
                    if (window.authManager && typeof window.authManager.switchTab==='function'){ window.authManager.switchTab('login'); }
                    // Focus email field
                    const email = document.getElementById('loginUsername'); if (email){ email.focus(); }
                }catch(_){ window.location.hash='login'; } };
                }

                // Close when clicking outside
                const closer = (e)=>{ if (!layer.contains(e.target) && e.target !== switcher){ document.removeEventListener('mousedown', closer); try{ layer.remove(); }catch(_){ } } };
                setTimeout(()=> document.addEventListener('mousedown', closer), 0);
            }catch(_){ }
        };

        // Force reload all (admin only)
        const frAll = document.getElementById('force-reload-all-btn');
        if (frAll){
            frAll.onclick = async ()=>{
                const currentUser = await window.firebaseService.getCurrentUser();
                const me = await window.firebaseService.getUserData(currentUser.uid) || {};
                if ((me.role||'user') !== 'admin'){ return this.showError('Admin only'); }
                const ok = await this.showConfirm('Force sign-out and reload for all users? This will invalidate caches on next load.');
                if (!ok) return;
                try{
                    const ref = firebase.doc(window.firebaseService.db, 'admin', 'broadcast');
                    await firebase.setDoc(ref, { action: 'forceReload', at: new Date().toISOString(), nonce: Math.random().toString(36).slice(2) }, { merge: true });
                    this.showSuccess('Broadcast sent');
                }catch(_){ this.showError('Failed to broadcast'); }
            };
        }
    }

    setupMobileSectionSwipe() {
        const host = document.querySelector('.dashboard-content');
        if (!host || host._swipeBound) return;
        host._swipeBound = true;

        let startX = 0;
        let startY = 0;
        let startTs = 0;
        let ignoreSwipe = false;

        host.addEventListener('touchstart', (e) => {
            if (!e.touches || !e.touches.length) return;
            ignoreSwipe = !!(e.target && e.target.closest && e.target.closest('.post-media-visual-wrap,.post-media-visual-slider,.audio-wave-bars'));
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startTs = Date.now();
        }, { passive: true });

        host.addEventListener('touchend', (e) => {
            if (!e.changedTouches || !e.changedTouches.length) return;
            if (ignoreSwipe){ ignoreSwipe = false; return; }
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const dx = endX - startX;
            const dy = endY - startY;
            const dt = Date.now() - startTs;
            // Horizontal swipe only: fast and clearly stronger than vertical movement.
            if (dt > 600 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.35) return;

            const navBtns = Array.from(document.querySelectorAll('.mobile-nav-btn[data-section]'))
                .filter((btn)=>{
                    try{
                        if (!btn) return false;
                        const style = window.getComputedStyle(btn);
                        if (style.display === 'none' || style.visibility === 'hidden') return false;
                        const sec = String(btn.dataset.section || '');
                        return this.canAccessSection(sec);
                    }catch(_){ return false; }
                });
            const sections = navBtns
                .map(btn => btn.dataset.section)
                .filter(Boolean)
                .filter((section, index, arr) => arr.indexOf(section) === index);
            if (!sections.length) return;

            const current = this.currentSection || 'apps';
            const idx = sections.indexOf(current);
            if (idx < 0) return;

            if (dx < 0 && idx < sections.length - 1) this.switchSection(sections[idx + 1]);
            if (dx > 0 && idx > 0) this.switchSection(sections[idx - 1]);
        }, { passive: true });
    }

    canAccessSection(section){
        const sec = String(section || '').trim();
        if (!sec) return false;
        const adminOnly = sec === 'users' || sec === 'settings';
        if (!adminOnly) return true;
        if (this._isAdminSession) return true;
        try{
            const btn = document.querySelector(`.nav-btn[data-section="${sec}"]`) || document.querySelector(`.mobile-nav-btn[data-section="${sec}"]`);
            if (!btn) return false;
            const style = window.getComputedStyle(btn);
            return style.display !== 'none' && style.visibility !== 'hidden';
        }catch(_){ return false; }
    }
    /**
     * Load Personal Space
     */
    async loadSpace(){
        if (this._dashboardSuspended) return;
        try{
            if (!(window.firebaseService && window.firebaseService.isFirebaseAvailable())){ this.scheduleSpaceRetry(); return; }
            const user = await this.resolveCurrentUserWithRetry(2600);
            if (!user || !user.uid){ this.scheduleSpaceRetry(); return; }
            if (this._spaceRetryTimer){ clearTimeout(this._spaceRetryTimer); this._spaceRetryTimer = null; }
            const data = await window.firebaseService.getUserData(user.uid) || {};
            const unameEl = document.getElementById('space-username');
            const moodEl = document.getElementById('space-mood');
            const avatarEl = document.getElementById('space-avatar');
            const feedTitle = document.getElementById('space-feed-title');
            const cachedName = localStorage.getItem(`liber_profile_username_${user.uid}`) || '';
            const cachedAvatar = localStorage.getItem(`liber_profile_avatar_${user.uid}`) || '';
            const stableName = String(data.username || '').trim() || String(cachedName || '').trim() || '';
            const stableAvatar = String(data.avatarUrl || '').trim() || String(cachedAvatar || '').trim() || String(user.photoURL || '').trim() || 'images/default-bird.png';
            if (String(data.username || '').trim()){
                try{ localStorage.setItem(`liber_profile_username_${user.uid}`, String(data.username || '').trim()); }catch(_){ }
            }
            if (String(data.avatarUrl || '').trim()){
                try{ localStorage.setItem(`liber_profile_avatar_${user.uid}`, String(data.avatarUrl || '').trim()); }catch(_){ }
            }
            if (unameEl) unameEl.value = stableName;
            if (moodEl) moodEl.value = data.mood || '';
            if (avatarEl) avatarEl.src = stableAvatar;
            if (feedTitle) feedTitle.textContent = 'My Wall';

            const saveBtn = document.getElementById('space-save-profile');
            if (saveBtn){
                saveBtn.onclick = async ()=>{
                    const newMood = (document.getElementById('space-mood').value||'').trim();
                    await window.firebaseService.updateUserProfile(user.uid, { mood: newMood });
                    const avInput = document.getElementById('space-avatar-input');
                    if (avInput && avInput.files && avInput.files[0] && firebase.getStorage){
                        try{
                            const s = firebase.getStorage();
                            const file = avInput.files[0];
                            const ext = (file.name.split('.').pop()||'jpg').toLowerCase();
                            const path = `avatars/${user.uid}/avatar.${ext}`;
                            const r = firebase.ref(s, path);
                            await firebase.uploadBytes(r, file, { contentType: file.type || 'image/jpeg' });
                            const url = await firebase.getDownloadURL(r);
                            await window.firebaseService.updateUserProfile(user.uid, { avatarUrl: url });
                            if (avatarEl) avatarEl.src = url;
                            try{ localStorage.setItem(`liber_profile_avatar_${user.uid}`, url); }catch(_){ }
                        }catch(e){ /* ignore avatar errors */ }
                    }
                    this.showSuccess('Profile saved');
                };
            }

            const postBtn = document.getElementById('space-post-btn');
            if (postBtn){
                postBtn.onclick = async ()=>{
                    const text = (document.getElementById('space-post-text').value||'').trim();
                    const mediaInput = document.getElementById('space-post-media');
                    const visibility = 'private';
                    const queued = this.getSpacePostAttachments();
                    if (!text && !queued.length){ this.showError('Add message or attachments'); return; }
                    if (queued.length > this.getMaxPostAttachments()){ this.showError(`Max ${this.getMaxPostAttachments()} attachments`); return; }
                    const postIdRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
                    const media = [];
                    if (queued.length){
                        if (!firebase.getStorage){ this.showError('Storage unavailable'); return; }
                        try{
                            const s = firebase.getStorage();
                            for (let i = 0; i < queued.length; i++){
                                const item = queued[i];
                                if (!item) continue;
                                if (item.kind === 'playlist'){
                                    const pCat = this.normalizePlaylistCategory(item.playlistCategory || item.category, item.items);
                                    media.push({
                                        kind: 'playlist',
                                        name: String(item.name || 'Playlist'),
                                        playlistId: String(item.playlistId || ''),
                                        playlistCategory: pCat,
                                        by: String(item.by || ''),
                                        cover: String(item.cover || ''),
                                        items: Array.isArray(item.items) ? item.items.slice(0, 120) : []
                                    });
                                    continue;
                                }
                                if (item.file instanceof File){
                                    const file = item.file;
                                    const ext = (file.name.split('.').pop()||'bin').toLowerCase();
                                const path = `posts/${user.uid}/${postIdRef.id}/media_${i}.${ext}`;
                                const r = firebase.ref(s, path);
                                await firebase.uploadBytes(r, file, { contentType: file.type||'application/octet-stream' });
                                const url = await firebase.getDownloadURL(r);
                                    media.push({
                                        kind: String(item.kind || this.inferMediaKindFromUrl(file.name || 'file')),
                                        url,
                                        name: file.name || 'attachment',
                                        by: String(item.by || ''),
                                        cover: String(item.cover || '')
                                    });
                                    continue;
                                }
                                if (item.url){
                                    media.push({
                                        kind: String(item.kind || this.inferMediaKindFromUrl(item.url || '')),
                                        url: String(item.url || ''),
                                        name: String(item.name || ''),
                                        by: String(item.by || ''),
                                        cover: String(item.cover || '')
                                    });
                                }
                            }
                        }catch(_){
                            this.showError('Failed to upload attachments');
                            return;
                        }
                    }
                    const uniqueMedia = [];
                    media.forEach((m)=>{
                        if (!m) return;
                        const sig = [
                            String(m.kind || ''),
                            String(m.playlistId || ''),
                            String(m.url || ''),
                            String(m.name || '')
                        ].join('|');
                        if (!sig) return;
                        if (uniqueMedia.some((x)=> [
                            String(x.kind || ''),
                            String(x.playlistId || ''),
                            String(x.url || ''),
                            String(x.name || '')
                        ].join('|') === sig)) return;
                        uniqueMedia.push(m);
                    });
                    const visualFirst = uniqueMedia.find((m)=> m && (m.kind === 'image' || m.kind === 'video')) || uniqueMedia.find((m)=> m && m.url);
                    const mediaUrl = String(visualFirst?.url || '');
                    await firebase.setDoc(postIdRef, {
                        id: postIdRef.id,
                        authorId: user.uid,
                        text,
                        mediaUrl,
                        media: uniqueMedia,
                        visibility,
                        createdAt: new Date().toISOString(),
                        createdAtTS: firebase.serverTimestamp()
                    });
                    await this.syncPostMediaToLibraries(user.uid, {
                        force: true,
                        posts: [{
                            id: postIdRef.id,
                            authorId: user.uid,
                            authorName: String(data?.username || '').trim() || 'User',
                            text,
                            media: uniqueMedia,
                            mediaUrl,
                            createdAt: new Date().toISOString()
                        }]
                    });
                    document.getElementById('space-post-text').value = '';
                    if (mediaInput) mediaInput.value = '';
                    this.resetSpacePostComposer();
                    this.showSuccess('Posted');
                    this.loadMyPosts(user.uid);
                };
                const mediaInput = document.getElementById('space-post-media');
                if (mediaInput && !mediaInput._previewsBound){
                    mediaInput._previewsBound = true;
                    mediaInput.addEventListener('change', ()=>{
                        this.queueSpacePostFileAttachments(mediaInput.files || []);
                        mediaInput.value = '';
                    });
                }
                const postTextEl = document.getElementById('space-post-text');
                if (postTextEl && !postTextEl._spacePasteBound){
                    postTextEl._spacePasteBound = true;
                    postTextEl.addEventListener('paste', (e)=>{
                        const cd = e.clipboardData;
                        if (!cd) return;
                        const files = [];
                        if (cd.files && cd.files.length){
                            for (let i = 0; i < cd.files.length; i++) files.push(cd.files[i]);
                        } else if (cd.items && cd.items.length){
                            for (let i = 0; i < cd.items.length; i++){
                                const it = cd.items[i];
                                if (it && it.kind === 'file'){
                                    const f = it.getAsFile();
                                    if (f) files.push(f);
                                }
                            }
                        }
                        if (files.length){
                            e.preventDefault();
                            this.queueSpacePostFileAttachments(files);
                        }
                    });
                }
                const composeCard = document.getElementById('space-compose-card');
                if (composeCard && !composeCard._spaceDropBound){
                    composeCard._spaceDropBound = true;
                    ['dragenter','dragover'].forEach((evt)=>{
                        composeCard.addEventListener(evt, (e)=>{
                            e.preventDefault();
                            composeCard.classList.add('dragover');
                            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                        });
                    });
                    ['dragleave','dragend'].forEach((evt)=>{
                        composeCard.addEventListener(evt, ()=> composeCard.classList.remove('dragover'));
                    });
                    composeCard.addEventListener('drop', (e)=>{
                        e.preventDefault();
                        composeCard.classList.remove('dragover');
                        const dt = e.dataTransfer;
                        if (!dt) return;
                        const files = dt.files && dt.files.length ? dt.files : null;
                        if (files && files.length){
                            this.queueSpacePostFileAttachments(files);
                        }
                    });
                }
                const waveBtn = document.getElementById('space-add-wave-btn');
                if (waveBtn && !waveBtn._bound){
                    waveBtn._bound = true;
                    waveBtn.onclick = ()=> this.openSpacePostWavePicker();
                }
                const playlistBtn = document.getElementById('space-add-playlist-btn');
                if (playlistBtn && !playlistBtn._bound){
                    playlistBtn._bound = true;
                    playlistBtn.onclick = ()=> this.openSpacePostPlaylistPicker();
                }
                this.renderSpacePostComposerQueue();
            }

            const spaceSearch = document.getElementById('space-search');
            if (spaceSearch){
                const ensureLayer = ()=>{
                    let layer = document.getElementById('space-search-results-layer');
                    if (!layer){
                        layer = document.createElement('div');
                        layer.id = 'space-search-results-layer';
                        layer.style.cssText = 'position:fixed; z-index: 10050; display:none; max-height:320px; overflow:auto; border:1px solid var(--border-color); background: var(--secondary-bg); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.25); left:0; width:auto; max-width:100%;';
                        document.body.appendChild(layer);
                    }
                    return layer;
                };
                const positionLayer = (layer)=>{
                    const r = spaceSearch.getBoundingClientRect();
                    const width = Math.max(280, Math.min(420, r.width));
                    layer.style.left = '0px';
                    layer.style.top = `${Math.round(r.bottom+6)}px`;
                    layer.style.width = 'auto';
                    layer.style.maxWidth = '100%';
                };
                const renderResults = (layer, users)=>{
                    layer.innerHTML = '';
                    const ul = document.createElement('ul');
                    ul.style.listStyle='none'; ul.style.margin='0'; ul.style.padding='8px';
                    (users||[]).slice(0,10).forEach(u=>{
                        const li = document.createElement('li');
                        li.style.cssText='display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px;border-radius:8px;cursor:pointer;';
                        li.onmouseenter = ()=> li.style.background='var(--hover-bg, rgba(255,255,255,.06))';
                        li.onmouseleave = ()=> li.style.background='transparent';
                        li.innerHTML = `<img class="avatar" src="${u.avatarUrl||'images/default-bird.png'}" style="width:32px;height:32px;border-radius:50%;object-fit:cover">`+
                                       `<div style="min-width:0"><div class="uname" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.username||''}</div>`+
                                       `<div class="email" style="opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.email||''}</div></div>`;
                        li.onclick = (ev)=>{ ev.stopPropagation(); layer.style.display='none'; this.showUserPreviewModal(u); };
                        ul.appendChild(li);
                    });
                    layer.appendChild(ul);
                };
                const hideOnOutside = (e)=>{
                    const layer = document.getElementById('space-search-results-layer');
                    if (!layer) return;
                    if (e.target===spaceSearch || spaceSearch.contains(e.target) || layer.contains(e.target)) return;
                    layer.style.display='none';
                };
                window.addEventListener('scroll', ()=>{ const l=document.getElementById('space-search-results-layer'); if(l&&l.style.display!=='none') positionLayer(l); }, true);
                window.addEventListener('resize', ()=>{ const l=document.getElementById('space-search-results-layer'); if(l&&l.style.display!=='none') positionLayer(l); });
                document.addEventListener('click', hideOnOutside);

                spaceSearch.addEventListener('input', async (e)=>{
                    const term = (e.target.value||'').trim().toLowerCase();
                    const layer = ensureLayer();
                    if (!term){ layer.style.display='none'; layer.innerHTML=''; return; }
                    const users = await window.firebaseService.searchUsers(term);
                    renderResults(layer, users);
                    positionLayer(layer);
                    layer.style.display = (users && users.length) ? 'block':'none';
                });
            }

            // Use the class method implementation of showUserPreviewModal.

            // Follow/unfollow bar
            const feedCard = document.getElementById('space-feed-card');
            if (feedCard && !document.getElementById('follow-bar')){
                const followBar = document.createElement('div');
                followBar.id = 'follow-bar';
                followBar.style.marginBottom = '10px';
                followBar.innerHTML = `<button id="follow-btn" class="btn btn-primary" style="display:none">Follow</button>
                                       <button id="unfollow-btn" class="btn btn-secondary" style="display:none">Unfollow</button>`;
                feedCard.insertBefore(followBar, feedCard.firstChild);
            }

            // Initial feed load: show my posts in Personal Space
            this.loadMyPosts(user.uid);
            this.loadConnectionsForSpace();
            this.renderSpacePlaylists(user.uid, false);
        }catch(e){ console.error('loadSpace error', e); }
    }

    async loadMyPosts(uid){
        const feed = document.getElementById('space-feed'); if (!feed) return;
        const feedTitle = document.getElementById('space-feed-title');
        feed.innerHTML='';
        feed.__useAdvancedComments = true;
        try{
            const meUser = await this.resolveCurrentUser();
            const meProfile = (meUser && meUser.uid) ? ((await window.firebaseService.getUserData(meUser.uid)) || {}) : {};
            // Try ordered query for my posts (both public and private)
            let snap;
            try{
                const q = firebase.query(
                    firebase.collection(window.firebaseService.db,'posts'),
                    firebase.where('authorId','==', uid),
                    firebase.orderBy('createdAtTS','desc'),
                    firebase.limit(50)
                );
                snap = await firebase.getDocs(q);
            }catch{
                const q2 = firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.where('authorId','==', uid));
                snap = await firebase.getDocs(q2);
                snap = { docs: snap.docs.sort((a,b)=> (b.data()?.createdAtTS?.toMillis?.()||0) - (a.data()?.createdAtTS?.toMillis?.()||0) || new Date((b.data()||{}).createdAt||0) - new Date((a.data()||{}).createdAt||0)), forEach: (cb)=> snap.docs.forEach(cb) };
            }
            const postsById = new Map();
            snap.forEach(d=>{
                const p = d.data();
                if (p && p.id) postsById.set(p.id, p);
            });
            // Legacy admin fallback: some old posts were not keyed by authorId.
            if (postsById.size === 0 && meUser && meUser.uid){
                try{
                    let allSnap;
                    try{
                        const qAll = firebase.query(
                            firebase.collection(window.firebaseService.db,'posts'),
                            firebase.orderBy('createdAtTS','desc'),
                            firebase.limit(300)
                        );
                        allSnap = await firebase.getDocs(qAll);
                    }catch(_){
                        allSnap = await firebase.getDocs(firebase.collection(window.firebaseService.db,'posts'));
                    }
                    const myEmail = String(meUser.email || '').toLowerCase();
                    const myName = String(meProfile.username || meUser.email || '').toLowerCase();
                    allSnap.forEach(d=>{
                        const p = d.data() || {};
                        if (!p.id) return;
                        const authorId = String(p.authorId || '');
                        const authorEmail = String(p.authorEmail || '').toLowerCase();
                        const authorName = String(p.authorName || '').toLowerCase();
                        if (authorId === meUser.uid || (myEmail && authorEmail === myEmail) || (myName && authorName === myName)){
                            postsById.set(p.id, p);
                        }
                    });
                }catch(_){ }
            }
            // Include public posts that current user reposted so they appear in My Feed.
            try{
                let recent;
                try{
                    const qRecent = firebase.query(
                        firebase.collection(window.firebaseService.db,'posts'),
                        firebase.where('visibility','==','public'),
                        firebase.orderBy('createdAtTS','desc'),
                        firebase.limit(80)
                    );
                    recent = await firebase.getDocs(qRecent);
                }catch{
                    const qRecent2 = firebase.query(
                        firebase.collection(window.firebaseService.db,'posts'),
                        firebase.where('visibility','==','public')
                    );
                    recent = await firebase.getDocs(qRecent2);
                }
                for (const d of recent.docs || []){
                    const p = d.data();
                    if (!p || !p.id || postsById.has(p.id)) continue;
                    try{
                        const repRef = firebase.doc(window.firebaseService.db,'posts', p.id, 'reposts', uid);
                        const rep = await firebase.getDoc(repRef);
                        if (rep.exists()){
                            postsById.set(p.id, { ...p, _isRepostInMyFeed: true });
                        }
                    }catch(_){ }
                }
            }catch(_){ }
            const mergedPosts = Array.from(postsById.values()).sort((a,b)=>
                (b.createdAtTS?.toMillis?.()||0) - (a.createdAtTS?.toMillis?.()||0) ||
                new Date(b.createdAt||0) - new Date(a.createdAt||0)
            );
            await Promise.all(mergedPosts.slice(0, 30).map((p)=> this.primeWaveMetaForMedia(p?.media || p?.mediaUrl)));
            for (const p of mergedPosts){
                const div = document.createElement('div');
                div.className = 'post-item';
                div.style.cssText = 'border:1px solid var(--border-color);border-radius:12px;padding:12px;margin:10px 0;background:var(--secondary-bg)';
                const authorProfile = await this.getUserPreviewData(p.authorId || '');
                const authorName = this._resolveAuthorName(p, authorProfile, {});
                const authorAvatar = String(authorProfile?.avatarUrl || p.coverUrl || p.thumbnailUrl || 'images/default-bird.png');
                const postTime = this.formatDateTime(p.createdAt);
                const editedBadge = this.isEdited(p) ? '<span style="font-size:11px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 6px">edited</span>' : '';
                const by = `<div class="byline post-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0">
                    <button type="button" data-user-preview="${String(p.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:8px;background:none;border:none;color:inherit;padding:0">
                        <img src="${authorAvatar}" alt="author" style="width:22px;height:22px;border-radius:50%;object-fit:cover">
                        <span style="font-size:12px;color:#aaa">${authorName.replace(/</g,'&lt;')}</span>
                    </button>
                    <span class="post-head-meta" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;opacity:.74">${postTime}${editedBadge}</span>
                </div>`;
                const media = (p.media || p.mediaUrl) ? this.renderPostMedia(p.media || p.mediaUrl, { defaultBy: p.authorName || '', defaultCover: p.coverUrl || p.thumbnailUrl || '', authorId: p.authorId || '' }) : '';
                const postText = this.getPostDisplayText(p);
                const postTextHtml = postText ? `<div class="post-text">${postText.replace(/</g,'&lt;')}</div>` : '';
                const repostBadge = p._isRepostInMyFeed ? `<div style="font-size:12px;opacity:.8;margin-bottom:4px"><i class="fas fa-retweet"></i> Reposted</div>` : '';
                div.innerHTML = `${repostBadge}${by}${media}${postTextHtml}
                                 <div class=\"post-actions\" data-post-id=\"${p.id}\" data-author=\"${p.authorId||''}\" style=\"margin-top:8px;display:flex;flex-wrap:wrap;gap:14px;align-items:center\">\n                                   <i class=\"fas fa-heart like-btn\" title=\"Like\" style=\"cursor:pointer\"></i>\n                                   <span class=\"likes-count\"></span>\n                                   <i class=\"fas fa-comment comment-btn\" title=\"Comments\" style=\"cursor:pointer\"></i>\n                                   <i class=\"fas fa-retweet repost-btn\" title=\"Repost\" style=\"cursor:pointer\"></i>\n                                   <span class=\"reposts-count\"></span>\n                                   <i class=\"fas fa-ellipsis-h post-menu\" title=\"More\" style=\"cursor:pointer\"></i>\n                                   <i class=\"fas fa-edit edit-post-btn\" title=\"Edit\" style=\"cursor:pointer\"></i>\n                                   <i class=\"fas fa-trash delete-post-btn\" title=\"Delete\" style=\"cursor:pointer\"></i>\n                                   <button class=\"btn btn-secondary visibility-btn\">${p.visibility==='public'?'Make Private':'Make Public'}</button>\n                                 </div>\n                                 <div class=\"comment-tree\" id=\"comments-${p.id}\" style=\"display:none\"></div>`;
                feed.appendChild(div);
                // double-tap like on post content
                const contentArea = div.querySelector('.post-text') || div;
                let lastTap = 0;
                contentArea.addEventListener('touchend', async ()=>{
                    const now = Date.now();
                    if (now - lastTap < 350){
                        const likeBtn = div.querySelector('.like-btn');
                        likeBtn && likeBtn.click();
                        const pulse = document.createElement('i'); pulse.className='fas fa-heart dbl-like-pulse'; div.appendChild(pulse); setTimeout(()=> pulse.remove(), 700);
                    }
                    lastTap = now;
                }, { passive: true });
                this.activatePlayers(div);
            }
            this.bindUserPreviewTriggers(feed);
            this.applyHorizontalMasonryOrder(feed);
            // Bind actions for my posts
            if (!meUser || !meUser.uid) return;
            document.querySelectorAll('#space-section .post-actions').forEach(async (pa)=>{
                const postId = pa.getAttribute('data-post-id');
                const likeBtn = pa.querySelector('.like-btn');
                const commentBtn = pa.querySelector('.comment-btn');
                const repostBtn = pa.querySelector('.repost-btn');
                const visBtn = pa.querySelector('.visibility-btn');
                const menuBtn = pa.querySelector('.post-menu');
                const editBtn = pa.querySelector('.edit-post-btn');
                const delBtn = pa.querySelector('.delete-post-btn');
                const authorId = pa.getAttribute('data-author') || '';
                const likesCount = pa.querySelector('.likes-count');
                const rCount = pa.querySelector('.reposts-count');
                const s = await window.firebaseService.getPostStats(postId); likesCount.textContent = `${s.likes||0}`; if (rCount) rCount.textContent = `${s.reposts||0}`;
                if (repostBtn){ if (await window.firebaseService.hasReposted(postId, meUser.uid)){ repostBtn.classList.add('active'); } }
                if (await window.firebaseService.hasLiked(postId, meUser.uid)){ likeBtn.classList.add('active'); likeBtn.style.color = '#ff4d4f'; }
                likeBtn.onclick = async ()=>{
                    const liked = await window.firebaseService.hasLiked(postId, meUser.uid);
                    if (liked){ await window.firebaseService.unlikePost(postId, meUser.uid); likeBtn.classList.remove('active'); likeBtn.style.color=''; }
                    else { await window.firebaseService.likePost(postId, meUser.uid); likeBtn.classList.add('active'); likeBtn.style.color='#ff4d4f'; }
                    const s2 = await window.firebaseService.getPostStats(postId); likesCount.textContent = `${s2.likes||0}`; if (rCount) rCount.textContent = `${s2.reposts||0}`;
                };
                if (repostBtn){
                    repostBtn.onclick = async ()=>{
                        try{
                            const me = await this.resolveCurrentUser();
                            if (!me || !me.uid) return;
                            const already = await window.firebaseService.hasReposted(postId, me.uid);
                            if (already){
                                await window.firebaseService.unRepost(postId, me.uid);
                                repostBtn.classList.remove('active');
                            } else {
                                await window.firebaseService.repost(postId, me.uid);
                                repostBtn.classList.add('active');
                            }
                            const s3 = await window.firebaseService.getPostStats(postId); if (rCount) rCount.textContent = `${s3.reposts||0}`;
                            this.loadMyPosts(uid);
                        }catch(_){ }
                    };
                }
                if (menuBtn){
                    menuBtn.onclick = async ()=>{
                        const loc = this.buildPublicShareLink({ kind: 'post', id: postId });
                        await this.shareOrCopyLink(loc, { title: 'Post', copiedMsg: 'Post link copied' });
                    };
                }
                if (editBtn){
                    if (authorId !== meUser.uid){ editBtn.style.display = 'none'; }
                    editBtn.onclick = async ()=>{
                        if (authorId !== meUser.uid) return;
                        const container = pa.closest('.post-item');
                        const textDiv = container && container.querySelector('.post-text');
                        const current = textDiv ? textDiv.textContent : '';
                        const next = prompt('Edit post:', current);
                        if (next === null) return;
                        await window.firebaseService.updatePost(postId, { text: String(next || '').trim() });
                        this.loadMyPosts(uid);
                    };
                }
                if (delBtn){
                    if (authorId !== meUser.uid){ delBtn.style.display = 'none'; }
                    delBtn.onclick = async ()=>{
                        if (authorId !== meUser.uid) return;
                        if (!confirm('Delete this post?')) return;
                        const postEl = pa.closest('.post-item');
                        await this.dissolveOutRemove(postEl, 240);
                        await window.firebaseService.deletePost(postId);
                        this.loadMyPosts(uid);
                    };
                }
                commentBtn.onclick = async ()=>{
                    const tree = pa.closest('.post-item')?.querySelector('.comment-tree') || document.getElementById(`comments-${postId}`);
                    if (!tree) return;
                    const forceOpen = tree.dataset.forceOpen === '1';
                    tree.dataset.forceOpen = '0';
                    if (tree.style.display === 'none' || forceOpen){ tree.style.display='block'; } else { tree.style.display='none'; return; }
                    tree.innerHTML = '';
                    const currentLimit = Number(tree.dataset.limit || 5);
                    const comments = await window.firebaseService.getComments(postId, currentLimit);
                    // Build threaded structure
                    const map = new Map();
                    comments.forEach(c=> map.set(c.id, { ...c, children: [] }));
                    const roots = [];
                    comments.forEach(c=>{ if (c.parentId && map.has(c.parentId)){ map.get(c.parentId).children.push(map.get(c.id)); } else { roots.push(map.get(c.id)); } });
                    const renderNode = (node, container)=>{
                        const item = document.createElement('div');
                        item.className = 'comment-item';
                        const commentTs = this.formatDateTime(node.createdAt);
                        const edited = this.isEdited(node) ? '<span style="font-size:10px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 5px">edited</span>' : '';
                        const fallbackName = String(node.authorId || 'User');
                        item.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">
                          <button type="button" data-user-preview="${String(node.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:6px;background:none;border:none;color:inherit;padding:0">
                            <img data-comment-avatar src="images/default-bird.png" style="width:18px;height:18px;border-radius:50%;object-fit:cover">
                            <span data-comment-name style="font-size:11px;opacity:.86">${fallbackName.slice(0,14).replace(/</g,'&lt;')}</span>
                          </button>
                          <span style="display:inline-flex;align-items:center;gap:6px;font-size:10px;opacity:.72">${commentTs}${edited}</span>
                        </div>
                        <div class="comment-text">${(node.text||'').replace(/</g,'&lt;')}</div>
                        <div class="comment-actions" data-comment-id="${node.id}" data-author="${node.authorId}" style="display:flex;gap:8px;margin-top:4px">
                          <span class="reply-btn" style="cursor:pointer"><i class=\"fas fa-reply\"></i> Reply</span>
                          <i class="fas fa-edit edit-comment-btn" title="Edit" style="cursor:pointer"></i>
                          <i class="fas fa-trash delete-comment-btn" title="Delete" style="cursor:pointer"></i>
                        </div>`;
                        container.appendChild(item);
                        this.getUserPreviewData(node.authorId).then((u)=>{
                            try{
                                const nm = item.querySelector('[data-comment-name]');
                                const av = item.querySelector('[data-comment-avatar]');
                                if (nm) nm.textContent = this._safeUsername(u?.username || '', this._safeUsername(fallbackName || '', 'User'));
                                if (av && u?.avatarUrl) av.src = u.avatarUrl;
                                this.bindUserPreviewTriggers(item);
                            }catch(_){ }
                        }).catch(()=>{ this.bindUserPreviewTriggers(item); });
                        // Reply input (hidden until click)
                        const replyBox = document.createElement('div');
                        replyBox.style.cssText = 'margin:6px 0 0 0; display:none';
                        replyBox.innerHTML = `<input type="text" class="reply-input" placeholder="Reply..." style="width:100%">`;
                        item.appendChild(replyBox);
                        item.querySelector('.reply-btn').onclick = ()=>{ replyBox.style.display = replyBox.style.display==='none'?'block':'none'; if (replyBox.style.display==='block'){ const inp=replyBox.querySelector('.reply-input'); inp && inp.focus(); } };
                        const inp = replyBox.querySelector('.reply-input');
                        if (inp){ inp.onkeydown = async (e)=>{ if (e.key==='Enter' && inp.value.trim()){ const meU = await this.resolveCurrentUser(); if (!meU || !meU.uid) return; await window.firebaseService.addComment(postId, meU.uid, inp.value.trim(), node.id); inp.value=''; tree.dataset.forceOpen = '1'; await commentBtn.onclick(); } }; }
                        if (node.children && node.children.length){
                            const sub = document.createElement('div'); sub.className='comment-tree'; item.appendChild(sub);
                            node.children.forEach(ch=> renderNode(ch, sub));
                        }
                    };
                    roots.reverse().forEach(n=> renderNode(n, tree));
                    if (comments.length >= currentLimit){
                        const more = document.createElement('button');
                        more.className = 'btn btn-secondary';
                        more.style.marginTop = '8px';
                        more.textContent = 'See more comments';
                        more.onclick = async ()=>{ tree.dataset.limit = String(currentLimit + 10); tree.dataset.forceOpen = '1'; await commentBtn.onclick(); };
                        tree.appendChild(more);
                    }
                    // Inline add comment (top-level)
                    const addWrap = document.createElement('div');
                    addWrap.style.cssText = 'margin-top:8px';
                    addWrap.innerHTML = `<input type="text" class="reply-input" id="add-comment-${postId}" placeholder="Add a comment..." style="width:100%">`;
                    tree.appendChild(addWrap);
                    const addInp = document.getElementById(`add-comment-${postId}`);
                    if (addInp){ addInp.onkeydown = async (e)=>{ if (e.key==='Enter' && addInp.value.trim()){ const meU = await this.resolveCurrentUser(); if (!meU || !meU.uid) return; await window.firebaseService.addComment(postId, meU.uid, addInp.value.trim(), null); addInp.value=''; tree.dataset.forceOpen = '1'; await commentBtn.onclick(); } }; }
                    // bind comment edit/delete
                    tree.querySelectorAll('.comment-actions').forEach(act=>{
                        const cid = act.getAttribute('data-comment-id');
                        const author = act.getAttribute('data-author');
                        const canEdit = author === meUser.uid;
                        const eb = act.querySelector('.edit-comment-btn');
                        const db = act.querySelector('.delete-comment-btn');
                        if (!canEdit){ eb && (eb.style.display='none'); db && (db.style.display='none'); }
                        if (canEdit){
                            if (eb){ eb.onclick = async ()=>{
                                const newText = prompt('Edit comment:');
                                if (newText===null) return;
                                await window.firebaseService.updateComment(postId, cid, newText.trim());
                                this.loadFeed(uid, titleName);
                            }; }
                            if (db){ db.onclick = async ()=>{
                                if (!confirm('Delete this comment?')) return;
                                const commentEl = act.closest('.comment-item');
                                await this.dissolveOutRemove(commentEl, 200);
                                await window.firebaseService.deleteComment(postId, cid);
                                this.loadFeed(uid, titleName);
                            }; }
                        }
                    });
                };
                if (visBtn){
                    if (authorId !== meUser.uid){ visBtn.style.display = 'none'; }
                    visBtn.onclick = async ()=>{
                        if (authorId !== meUser.uid) return;
                        try{
                            const ref = firebase.doc(window.firebaseService.db, 'posts', postId);
                            const doc = await firebase.getDoc(ref);
                            const p = doc.data()||{};
                            const next = p.visibility==='public' ? 'private' : 'public';
                            await firebase.updateDoc(ref, { visibility: next, updatedAt: new Date().toISOString() });
                            visBtn.textContent = next==='public' ? 'Make Private' : 'Make Public';
                        }catch(_){ }
                    };
                }
            });
            if (feedTitle) feedTitle.textContent = 'My Wall';
            this.activatePostActions(feed);
            this.subscribeRealtimeFeed(`space-my-posts:${uid}`, ()=>{
                return firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.where('authorId','==', uid));
            }, async (payload)=>{
                if (this.currentSection !== 'space') return;
                const ok = await this.applyRealtimePostChanges(feed, payload, { includeVisibility: true });
                if (!ok) await this.loadMyPosts(uid);
            });
        }catch(_){ }
    }

    stopPendingRequestListener(){
        try{
            if (typeof this._pendingRequestUnsub === 'function'){
                this._pendingRequestUnsub();
                this._pendingRequestUnsub = null;
            }
            this.updatePendingRequestBadge(0);
        }catch(_){ }
    }

    startPendingRequestListener(){
        try{
            const me = this.currentUser || window.firebaseService?.auth?.currentUser;
            if (!me || !me.uid || !(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return;
            if (typeof firebase.onSnapshot !== 'function') return;
            const coll = firebase.collection(window.firebaseService.db, 'connections', me.uid, 'peers');
            this._pendingRequestUnsub = firebase.onSnapshot(coll, (snap)=>{
                let count = 0;
                snap.forEach((d)=>{
                    const d0 = d.data ? d.data() : d;
                    const status = String(d0?.status || '');
                    const requestedTo = String(d0?.requestedTo || '');
                    if (status === 'pending' && requestedTo === me.uid) count++;
                });
                this.updatePendingRequestBadge(count);
            }, (err)=>{ this.updatePendingRequestBadge(0); });
        }catch(_){ this.updatePendingRequestBadge(0); }
    }

    updatePendingRequestBadge(count){
        const ids = ['nav-space-request-badge','nav-profile-request-badge','mobile-space-request-badge','mobile-profile-request-badge'];
        const n = Math.min(99, Math.max(0, count || 0));
        const text = n > 0 ? (n > 99 ? '99+' : String(n)) : '0';
        ids.forEach((id)=>{
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = text;
            el.classList.toggle('hidden', n === 0);
            el.setAttribute('aria-hidden', n === 0 ? 'true' : 'false');
        });
    }

    async loadConnectionsForSpace(){
        try{
            if (!(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return;
            const me = await this.resolveCurrentUser(); if (!me || !me.uid) return;
            const list = document.getElementById('space-connections-list'); if (!list) return;
            list.innerHTML = '';
            let snap;
            try{
                const q = firebase.query(
                    firebase.collection(window.firebaseService.db,'connections',me.uid,'peers'),
                    firebase.orderBy('updatedAt','desc'),
                    firebase.limit(100)
                );
                snap = await firebase.getDocs(q);
            }catch{
                snap = await firebase.getDocs(firebase.collection(window.firebaseService.db,'connections',me.uid,'peers'));
            }
            const rows = [];
            snap.forEach(d=> rows.push({ id:d.id, ...d.data() }));
            rows.sort((a,b)=> new Date(b.updatedAt||b.connectedAt||0) - new Date(a.updatedAt||a.connectedAt||0));
            if (!rows.length){
                list.innerHTML = '<li style="opacity:.8">No connections yet.</li>';
                return;
            }
            rows.forEach((r)=>{
                const li = document.createElement('li');
                li.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px;border-radius:10px;cursor:pointer;';
                const avatar = r.avatarUrl || 'images/default-bird.png';
                const uname = (r.username || r.email || r.uid || r.id || 'User').toString().replace(/</g,'&lt;');
                const email = (r.email || '').toString().replace(/</g,'&lt;');
                const status = String(r.status || 'connected');
                const requestedBy = String(r.requestedBy || '');
                const requestedTo = String(r.requestedTo || '');
                const incomingPending = status === 'pending' && requestedTo === me.uid;
                const outgoingPending = status === 'pending' && requestedBy === me.uid;
                li.innerHTML = `<img src="${avatar}" style="width:34px;height:34px;border-radius:50%;object-fit:cover"><div style="min-width:0;flex:1"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${uname}</div><div style="opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${email}</div></div>`;
                const actions = document.createElement('div');
                actions.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:auto';
                if (incomingPending){
                    const confirmBtn = document.createElement('button');
                    confirmBtn.className = 'btn btn-primary';
                    confirmBtn.textContent = 'Confirm';
                    confirmBtn.onclick = async (ev)=>{
                        ev.stopPropagation();
                        try{
                            confirmBtn.disabled = true;
                            const peerUid = r.uid || r.id;
                            const now = new Date().toISOString();
                            const myRef = firebase.doc(window.firebaseService.db,'connections',me.uid,'peers',peerUid);
                            const peerRef = firebase.doc(window.firebaseService.db,'connections',peerUid,'peers',me.uid);
                            await firebase.setDoc(myRef, { status:'connected', connectedAt:now, updatedAt:now }, { merge:true });
                            await firebase.setDoc(peerRef, { status:'connected', connectedAt:now, updatedAt:now }, { merge:true });
                            await this.loadConnectionsForSpace();
                        }catch(_){ this.showError('Failed to confirm connection'); }
                        finally{ confirmBtn.disabled = false; }
                    };
                    const denyBtn = document.createElement('button');
                    denyBtn.className = 'btn btn-secondary';
                    denyBtn.textContent = 'Deny';
                    denyBtn.onclick = async (ev)=>{
                        ev.stopPropagation();
                        try{
                            denyBtn.disabled = true;
                            const peerUid = r.uid || r.id;
                            const myRef = firebase.doc(window.firebaseService.db,'connections',me.uid,'peers',peerUid);
                            const peerRef = firebase.doc(window.firebaseService.db,'connections',peerUid,'peers',me.uid);
                            await firebase.deleteDoc(myRef).catch(()=>null);
                            await firebase.deleteDoc(peerRef).catch(()=>null);
                            await this.loadConnectionsForSpace();
                        }catch(_){ this.showError('Failed to deny request'); }
                        finally{ denyBtn.disabled = false; }
                    };
                    actions.appendChild(confirmBtn);
                    actions.appendChild(denyBtn);
                } else {
                    const badge = document.createElement('span');
                    badge.style.cssText = 'font-size:12px;opacity:.85';
                    badge.textContent = outgoingPending ? 'Pending' : 'Connected';
                    actions.appendChild(badge);
                }
                li.appendChild(actions);
                li.onclick = ()=> this.showUserPreviewModal({ uid: r.uid || r.id, username: r.username, email: r.email, avatarUrl: r.avatarUrl });
                list.appendChild(li);
            });
        }catch(_){ }
    }

    async renderSpacePlaylists(uid, publicOnly = false){
        try{
            const card = document.getElementById('space-feed-card');
            if (!card || !(window.firebaseService && window.firebaseService.isFirebaseAvailable())) return;
            let panel = document.getElementById('space-playlists-panel');
            if (!panel){
                panel = document.createElement('div');
                panel.id = 'space-playlists-panel';
                panel.style.cssText = 'margin-top:14px';
                card.appendChild(panel);
            }
            let rows = [];
            if (publicOnly){
                rows = await this.fetchPublicPlaylistsForUser(uid, 40);
            } else {
                try{
                    const q = firebase.query(
                        firebase.collection(window.firebaseService.db, 'playlists'),
                        firebase.where('ownerId','==', uid),
                        firebase.orderBy('updatedAt','desc'),
                        firebase.limit(40)
                    );
                    const snap = await firebase.getDocs(q);
                    snap.forEach((d)=> rows.push({ id: d.id, ...d.data() }));
                }catch(_){
                    const q2 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('ownerId','==', uid));
                    const s2 = await firebase.getDocs(q2);
                    s2.forEach((d)=>{
                        const p = d.data() || {};
                        rows.push({ id: d.id, ...p });
                    });
                    if (!rows.length){
                        try{
                            const q3 = firebase.query(firebase.collection(window.firebaseService.db, 'playlists'), firebase.where('owner','==', uid));
                            const s3 = await firebase.getDocs(q3);
                            s3.forEach((d)=>{
                                const p = d.data() || {};
                                rows.push({ id: d.id, ...p });
                            });
                        }catch(_){ }
                    }
                    rows.sort((a,b)=> new Date(b.updatedAt||0) - new Date(a.updatedAt||0));
                }
            }
            const me = await this.resolveCurrentUser();
            const myUid = me?.uid || '';
            if (!rows.length){
                panel.innerHTML = '<div style="opacity:.8">No playlists yet.</div>';
                return;
            }
            panel.innerHTML = `<h4 style="margin:4px 0 8px">Playlists</h4>${rows.slice(0, 20).map((pl)=>{
                const ownerAny = String(pl.ownerId || pl.owner || '').trim();
                const canAdd = !!myUid && myUid !== ownerAny;
                const addBtn = canAdd ? `<button class="btn btn-secondary" data-add-pl="${pl.id}">Add</button>` : '';
                return `<div class="post-item" style="border:1px solid var(--border-color);border-radius:12px;padding:10px;margin:8px 0;background:var(--secondary-bg);display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(pl.name || 'Playlist').replace(/</g,'&lt;')}</div><div style="font-size:11px;opacity:.75;display:flex;gap:8px;align-items:center"><button type="button" data-user-preview="${String(ownerAny || '').replace(/"/g,'&quot;')}" style="background:none;border:none;padding:0;color:#9db3d5;cursor:pointer">${String(pl.ownerName || '').replace(/</g,'&lt;')}</button><span>${Array.isArray(pl.items) ? pl.items.length : 0} tracks</span></div></div>${addBtn}</div>`;
            }).join('')}`;
            panel.querySelectorAll('[data-add-pl]').forEach((btn)=>{
                btn.onclick = async ()=>{
                    const plId = String(btn.getAttribute('data-add-pl') || '').trim();
                    if (!plId) return;
                    const mine = await this.hydratePlaylistsFromCloud();
                    const exists = mine.some((x)=> String(x.id||'') === plId || String(x.sourcePlaylistId||'') === plId);
                    if (exists){
                        this.showSuccess('Playlist already added');
                        return;
                    }
                    const src = rows.find((x)=> String(x.id) === plId);
                    if (!me || !me.uid) return;
                    const copy = {
                        id: `pl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
                        name: src?.name || 'Playlist',
                        owner: me.uid,
                        ownerId: me.uid,
                        ownerName: me.email || '',
                        visibility: 'private',
                        sourcePlaylistId: plId,
                        sourceOwnerId: src?.ownerId || uid,
                        items: [],
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    this.savePlaylists([copy, ...mine]);
                    await this.renderPlaylists();
                    this.showSuccess('Playlist added');
                };
            });
            this.bindUserPreviewTriggers(panel);
        }catch(_){ }
    }

    async loadGlobalFeed(searchTerm = ''){
        if (this._dashboardSuspended) return;
        try{
            const feedEl = document.getElementById('global-feed');
            const suggEl = document.getElementById('global-suggestions');
            if (!feedEl) return;
            const term = String(searchTerm || this._wallSearchTerm || '').trim().toLowerCase();
            // Prevent snapshot listener accumulation across re-renders.
            if (this._postActionUnsubsByContainer && this._postActionUnsubsByContainer.get(feedEl)) {
                this._postActionUnsubsByContainer.get(feedEl).forEach((u) => { try { u(); } catch (_) {} });
                this._postActionUnsubsByContainer.set(feedEl, []);
            }
            feedEl.innerHTML = '';
            // Prevent prompt-based fallback comment UI in delegated handlers.
            feedEl.__useAdvancedComments = true;
            // Recent public posts
            const snap = await firebase.getDocs(firebase.query(
                firebase.collection(window.firebaseService.db,'posts'),
                firebase.where('visibility','==','public')
            ));
            const list = [];
            snap.forEach((d) => {
                const row = d.data() || {};
                list.push({ ...row, id: row.id || d.id });
            });
            const filteredList = term
                ? list.filter((p)=>{
                    const text = String(p?.text || '').toLowerCase();
                    const author = String(p?.authorName || '').toLowerCase();
                    return text.includes(term) || author.includes(term);
                })
                : list;
            filteredList.sort((a,b)=> (b.createdAtTS?.toMillis?.()||0) - (a.createdAtTS?.toMillis?.()||0) || new Date(b.createdAt||0) - new Date(a.createdAt||0));
            const renderList = [];
            const seenMediaKeys = new Set();
            const seenIds = new Set();
            for (const p of filteredList){
                const pid = String(p?.id || '').trim();
                if (pid && seenIds.has(pid)) continue;
                if (pid) seenIds.add(pid);
                const mediaKey = this.normalizeMediaUrl(String(p?.media || p?.mediaUrl || '').trim());
                if (mediaKey){
                    if (seenMediaKeys.has(mediaKey)) continue;
                    seenMediaKeys.add(mediaKey);
                }
                renderList.push(p);
                if (renderList.length >= 20) break;
            }
            await Promise.all(renderList.map((p)=> this.primeWaveMetaForMedia(p?.media || p?.mediaUrl)));
            for (const p of renderList){
                const div = document.createElement('div');
                div.className = 'post-item';
                div.dataset.postId = p.id;
                div.style.cssText = 'border:1px solid var(--border-color);border-radius:12px;padding:12px;margin:10px 0;background:var(--secondary-bg)';
                const authorProfile = await this.getUserPreviewData(p.authorId || '');
                const authorName = this._resolveAuthorName(p, authorProfile, {});
                const authorAvatar = String(authorProfile?.avatarUrl || p.coverUrl || p.thumbnailUrl || 'images/default-bird.png');
                const postTime = this.formatDateTime(p.createdAt);
                const editedBadge = this.isEdited(p) ? '<span style="font-size:11px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 6px">edited</span>' : '';
                const media = (p.media || p.mediaUrl) ? this.renderPostMedia(p.media || p.mediaUrl, { defaultBy: p.authorName || '', defaultCover: p.coverUrl || p.thumbnailUrl || '', authorId: p.authorId || '' }) : '';
                const postText = this.getPostDisplayText(p);
                const postTextHtml = postText ? `<div class="post-text">${postText.replace(/</g,'&lt;')}</div>` : '';
                div.innerHTML = `<div class="post-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
                                  <button type="button" data-user-preview="${String(p.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:8px;background:none;border:none;color:inherit;padding:0">
                                    <img src="${authorAvatar}" alt="author" style="width:22px;height:22px;border-radius:50%;object-fit:cover">
                                    <span style="font-size:12px;color:#aaa">${authorName.replace(/</g,'&lt;')}</span>
                                  </button>
                                  <span class="post-head-meta" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;opacity:.74">${postTime}${editedBadge}</span>
                                </div>
                                ${media}${postTextHtml}
                                 <div class="post-actions" data-post-id="${p.id}" data-author="${p.authorId}" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:14px;align-items:center">
                                   <i class="fas fa-heart like-btn" title="Like" style="cursor:pointer"></i>
                                   <span class="likes-count"></span>
                                   <i class="fas fa-comment comment-btn" title="Comments" style="cursor:pointer"></i>
                                   <span class="comments-count"></span>
                                   <i class="fas fa-retweet repost-btn" title="Repost" style="cursor:pointer"></i>
                                   <span class="reposts-count"></span>
                                   <i class="fas fa-ellipsis-h post-menu" title="More" style="cursor:pointer"></i>
                                   <i class="fas fa-edit edit-post-btn" title="Edit" style="cursor:pointer"></i>
                                   <i class="fas fa-trash delete-post-btn" title="Delete" style="cursor:pointer"></i>
                                 </div>
                                 <div class="comment-tree" id="comments-${p.id}" style="display:none"></div>`;
                feedEl.appendChild(div);
            }
            this.bindUserPreviewTriggers(feedEl);
            this.applyHorizontalMasonryOrder(feedEl);
            if (suggEl){
                try{
                    const meUser = await this.resolveCurrentUserWithRetry(800);
                    const excludeUid = meUser?.uid || '';
                    const trending = await window.firebaseService.getTrendingPosts(excludeUid, 20);
                    let filteredTrending = term
                        ? (trending || []).filter((tp)=>{
                            const text = String(tp?.text || '').toLowerCase();
                            const author = String(tp?.authorName || '').toLowerCase();
                            return text.includes(term) || author.includes(term);
                        })
                        : (trending || []);
                    const mainIds = new Set(renderList.map((p)=> String(p?.id || '')));
                    filteredTrending = filteredTrending.filter((tp)=> tp && tp.id && !mainIds.has(String(tp.id)));
                    suggEl.innerHTML = '';
                    const top = filteredTrending.slice(0, 10);
                    for (const tp of top){
                        if (!tp || !tp.id) continue;
                        try{ await this.primeWaveMetaForMedia(tp?.media || tp?.mediaUrl); }catch(_){ }
                        const card = await this.buildRealtimeFeedPostElement(tp, {});
                        if (card) suggEl.appendChild(card);
                    }
                    this.bindUserPreviewTriggers(suggEl);
                    this.activatePlayers(suggEl);
                    this.clearPostActionListeners(suggEl);
                    this.activatePostActions(suggEl);
                    this.applyHorizontalMasonryOrder(suggEl);
                }catch(_){
                    suggEl.innerHTML = '';
                }
            }
            this.activatePostActions(feedEl);  // Activate actions after rendering (delegated like/comment/repost)
            // owner-only controls and advanced comments UI parity with personal space
            try{
                const meUser = await this.resolveCurrentUserWithRetry(1200);
                const myUid = meUser?.uid || '';
                feedEl.querySelectorAll('.post-actions').forEach(pa=>{
                    const postId = pa.getAttribute('data-post-id');
                    const postAuthor = pa.getAttribute('data-author');
                    const canEditPost = !!myUid && postAuthor === myUid;
                    const editBtn = pa.querySelector('.edit-post-btn');
                    const delBtn = pa.querySelector('.delete-post-btn');
                    const menuBtn = pa.querySelector('.post-menu');
                    const visBtn = pa.querySelector('.visibility-btn');
                    const commentBtn = pa.querySelector('.comment-btn');
                    if (!canEditPost){ if (editBtn) editBtn.style.display='none'; if (delBtn) delBtn.style.display='none'; if (visBtn) visBtn.style.display='none'; }
                    if (menuBtn){ menuBtn.onclick = async ()=>{ const loc = this.buildPublicShareLink({ kind: 'post', id: postId }); await this.shareOrCopyLink(loc, { title: 'Post', copiedMsg: 'Post link copied' }); }; }
                    if (visBtn && canEditPost){ visBtn.onclick = async ()=>{ try{ const ref = firebase.doc(window.firebaseService.db,'posts', postId); const doc = await firebase.getDoc(ref); const p=doc.data()||{}; const next = p.visibility==='public'?'private':'public'; await firebase.updateDoc(ref, { visibility: next, updatedAt:new Date().toISOString() }); visBtn.textContent = next==='public'?'Make Private':'Make Public'; }catch(_){ } }; }
                    if (editBtn && canEditPost){ editBtn.onclick = async ()=>{ const container = pa.closest('.post-item'); const textDiv = container && container.querySelector('.post-text'); const current = textDiv ? textDiv.textContent : ''; const newText = prompt('Edit post:', current); if (newText===null) return; await window.firebaseService.updatePost(postId, { text: newText.trim() }); this.loadGlobalFeed(); }; }
                    if (delBtn && canEditPost){ delBtn.onclick = async ()=>{ if (!confirm('Delete this post?')) return; const postEl = pa.closest('.post-item'); await this.dissolveOutRemove(postEl, 240); await window.firebaseService.deletePost(postId); this.loadGlobalFeed(); }; }
                    if (commentBtn){ commentBtn.onclick = async ()=>{
                        const tree = pa.closest('.post-item')?.querySelector('.comment-tree') || document.getElementById(`comments-${postId}`); if (!tree) return;
                        const forceOpen = tree.dataset.forceOpen === '1';
                        tree.dataset.forceOpen = '0';
                        if (tree.style.display === 'none' || forceOpen){ tree.style.display='block'; } else { tree.style.display='none'; return; }
                        tree.innerHTML = '';
                        const currentLimit = Number(tree.dataset.limit || 5);
                        const comments = await window.firebaseService.getComments(postId, currentLimit);
                        const map = new Map(); comments.forEach(c=> map.set(c.id, { ...c, children: [] }));
                        const roots = []; comments.forEach(c=>{ if (c.parentId && map.has(c.parentId)){ map.get(c.parentId).children.push(map.get(c.id)); } else { roots.push(map.get(c.id)); } });
                        const renderNode = (node, container)=>{
                            const item = document.createElement('div');
                            item.className = 'comment-item';
                            const commentTs = this.formatDateTime(node.createdAt);
                            const edited = this.isEdited(node) ? '<span style="font-size:10px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 5px">edited</span>' : '';
                            const fallbackName = String(node.authorId || 'User');
                            item.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">
                              <button type="button" data-user-preview="${String(node.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:6px;background:none;border:none;color:inherit;padding:0">
                                <img data-comment-avatar src="images/default-bird.png" style="width:18px;height:18px;border-radius:50%;object-fit:cover">
                                <span data-comment-name style="font-size:11px;opacity:.86">${fallbackName.slice(0,14).replace(/</g,'&lt;')}</span>
                              </button>
                              <span style="display:inline-flex;align-items:center;gap:6px;font-size:10px;opacity:.72">${commentTs}${edited}</span>
                            </div>
                            <div class=\"comment-text\">${(node.text||'').replace(/</g,'&lt;')}</div>
                            <div class=\"comment-actions\" data-comment-id=\"${node.id}\" data-author=\"${node.authorId}\" style=\"display:flex;gap:8px;margin-top:4px\">
                              <span class=\"reply-btn\" style=\"cursor:pointer\"><i class=\"fas fa-reply\"></i> Reply</span>
                              <i class=\"fas fa-edit edit-comment-btn\" title=\"Edit\" style=\"cursor:pointer\"></i>
                              <i class=\"fas fa-trash delete-comment-btn\" title=\"Delete\" style=\"cursor:pointer\"></i>
                            </div>`;
                            container.appendChild(item);
                            this.getUserPreviewData(node.authorId).then((u)=>{
                                try{
                                    const nm = item.querySelector('[data-comment-name]');
                                    const av = item.querySelector('[data-comment-avatar]');
                                    if (nm) nm.textContent = this._safeUsername(u?.username || '', this._safeUsername(fallbackName || '', 'User'));
                                    if (av && u?.avatarUrl) av.src = u.avatarUrl;
                                    this.bindUserPreviewTriggers(item);
                                }catch(_){ }
                            }).catch(()=>{ this.bindUserPreviewTriggers(item); });
                            const replyBox = document.createElement('div'); replyBox.style.cssText='margin:6px 0 0 0; display:none'; replyBox.innerHTML = `<input type=\"text\" class=\"reply-input\" placeholder=\"Reply...\" style=\"width:100%\">`; item.appendChild(replyBox);
                            item.querySelector('.reply-btn').onclick = ()=>{ replyBox.style.display = replyBox.style.display==='none'?'block':'none'; if (replyBox.style.display==='block'){ const inp=replyBox.querySelector('.reply-input'); inp && inp.focus(); } };
                            const inp = replyBox.querySelector('.reply-input'); if (inp){ inp.onkeydown = async (e)=>{ if (e.key==='Enter' && inp.value.trim()){ const meU = await this.resolveCurrentUser(); if (!meU || !meU.uid) return; await window.firebaseService.addComment(postId, meU.uid, inp.value.trim(), node.id); inp.value=''; tree.dataset.forceOpen = '1'; await commentBtn.onclick(); } }; }
                            if (node.children && node.children.length){ const sub = document.createElement('div'); sub.className='comment-tree'; item.appendChild(sub); node.children.forEach(ch=> renderNode(ch, sub)); }
                        };
                        roots.reverse().forEach(n=> renderNode(n, tree));
                        if (comments.length >= currentLimit){
                            const more = document.createElement('button');
                            more.className = 'btn btn-secondary';
                            more.style.marginTop = '8px';
                            more.textContent = 'See more comments';
                            more.onclick = async ()=>{
                                tree.dataset.limit = String(currentLimit + 10);
                                tree.dataset.forceOpen = '1';
                                await commentBtn.onclick();
                            };
                            tree.appendChild(more);
                        }
                        const addWrap = document.createElement('div'); addWrap.style.cssText='margin-top:8px'; addWrap.innerHTML = `<input type=\"text\" class=\"reply-input\" id=\"add-comment-${postId}\" placeholder=\"Add a comment...\" style=\"width:100%\">`; tree.appendChild(addWrap);
                        const addInp = document.getElementById(`add-comment-${postId}`); if (addInp){ addInp.onkeydown = async (e)=>{ if (e.key==='Enter' && addInp.value.trim()){ const meU = await this.resolveCurrentUser(); if (!meU || !meU.uid) return; await window.firebaseService.addComment(postId, meU.uid, addInp.value.trim(), null); addInp.value=''; tree.dataset.forceOpen = '1'; await commentBtn.onclick(); } }; }
                        tree.querySelectorAll('.comment-actions').forEach(act=>{
                            const cid = act.getAttribute('data-comment-id'); const author = act.getAttribute('data-author'); const canEdit = !!myUid && author === myUid; const eb = act.querySelector('.edit-comment-btn'); const db = act.querySelector('.delete-comment-btn');
                            if (!canEdit){ eb && (eb.style.display='none'); db && (db.style.display='none'); }
                            if (canEdit){ if (eb){ eb.onclick = async ()=>{ const newText = prompt('Edit comment:'); if (newText===null) return; await window.firebaseService.updateComment(postId, cid, newText.trim()); this.loadGlobalFeed(); }; }
                                if (db){ db.onclick = async ()=>{ if (!confirm('Delete this comment?')) return; const commentEl = act.closest('.comment-item'); await this.dissolveOutRemove(commentEl, 200); await window.firebaseService.deleteComment(postId, cid); this.loadGlobalFeed(); }; }
                            }
                        });
                    }; }
                });
            }catch(_){ }
            this.activatePlayers(feedEl);
            this.subscribeRealtimeFeed('feed-global-public', ()=>{
                return firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.where('visibility','==','public'));
            }, async (payload)=>{
                if (this.currentSection !== 'feed') return;
                const ok = await this.applyRealtimePostChanges(feedEl, payload, { searchTerm: this._wallSearchTerm || term || '' });
                if (!ok) await this.loadGlobalFeed(this._wallSearchTerm || term || '');
            });
        }catch(_){ }
    }

    async loadFeed(uid, titleName){
        const feed = document.getElementById('space-feed');
        const feedTitle = document.getElementById('space-feed-title');
        if (!feed) return;
        feed.innerHTML = '';
        try{
            const meUser = await this.resolveCurrentUser();
            const meUid = meUser?.uid || '';
            const following = meUid ? await window.firebaseService.getFollowingIds(meUid) : [];
            const fb = document.getElementById('follow-btn');
            const ub = document.getElementById('unfollow-btn');
            if (fb && ub){
                if (meUid && uid !== meUid){
                    const isFollowing = following.includes(uid);
                    fb.style.display = isFollowing? 'none':'inline-block';
                    ub.style.display = isFollowing? 'inline-block':'none';
                    fb.onclick = async ()=>{ if (!meUid) return; await window.firebaseService.followUser(meUid, uid); this.loadFeed(uid, titleName); };
                    ub.onclick = async ()=>{ if (!meUid) return; await window.firebaseService.unfollowUser(meUid, uid); this.loadFeed(uid, titleName); };
                } else { fb.style.display='none'; ub.style.display='none'; }
            }
            let snap;
            try {
                const q = firebase.query(
                    firebase.collection(window.firebaseService.db,'posts'),
                    firebase.where('authorId','==', uid),
                    firebase.where('visibility','==','public'),
                    firebase.orderBy('createdAtTS','desc'),
                    firebase.limit(50)
                );
                snap = await firebase.getDocs(q);
            } catch {
                const q2 = firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.where('authorId','==', uid));
                snap = await firebase.getDocs(q2);
                // Normalize to similar interface
                snap = { docs: snap.docs.sort((a,b)=> (b.data()?.createdAtTS?.toMillis?.()||0) - (a.data()?.createdAtTS?.toMillis?.()||0) || new Date((b.data()||{}).createdAt||0) - new Date((a.data()||{}).createdAt||0)), forEach: (cb)=> snap.docs.forEach(cb) };
            }
            const scoped = (snap?.docs || []).map((d)=> d.data()).slice(0, 20);
            await Promise.all(scoped.map((p)=> this.primeWaveMetaForMedia(p?.media || p?.mediaUrl)));
            snap.forEach(d=>{
                const p = d.data();
                const div = document.createElement('div');
                div.className = 'post-item';
                div.style.cssText = 'border:1px solid var(--border-color);border-radius:12px;padding:12px;margin:10px 0;background:var(--secondary-bg)';
                const authorName = this._safeUsername(p.authorName || '', this._safeUsername(titleName || '', 'User'));
                const authorAvatar = String(p.coverUrl || p.thumbnailUrl || 'images/default-bird.png');
                const postTime = this.formatDateTime(p.createdAt);
                const editedBadge = this.isEdited(p) ? '<span style="font-size:11px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 6px">edited</span>' : '';
                const media = (p.media || p.mediaUrl) ? this.renderPostMedia(p.media || p.mediaUrl, { defaultBy: p.authorName || '', defaultCover: p.coverUrl || p.thumbnailUrl || '', authorId: p.authorId || '' }) : '';
                const postText = this.getPostDisplayText(p);
                const postTextHtml = postText ? `<div class="post-text">${postText.replace(/</g,'&lt;')}</div>` : '';
                div.innerHTML = `<div class="post-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
                                   <button type="button" data-user-preview="${String(p.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:8px;background:none;border:none;color:inherit;padding:0">
                                     <img src="${authorAvatar}" alt="author" style="width:22px;height:22px;border-radius:50%;object-fit:cover">
                                     <span style="font-size:12px;color:#aaa">${authorName.replace(/</g,'&lt;')}</span>
                                   </button>
                                   <span class="post-head-meta" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;opacity:.74">${postTime}${editedBadge}</span>
                                 </div>
                                 ${media}${postTextHtml}
                                 <div class="post-actions" data-post-id="${p.id}" data-author="${p.authorId}" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:14px;align-items:center">
                                   <i class="fas fa-heart like-btn" title="Like" style="cursor:pointer"></i>
                                   <span class="likes-count"></span>
                                   <i class="fas fa-comment comment-btn" title="Comments" style="cursor:pointer"></i>
                                   <i class="fas fa-retweet repost-btn" title="Repost" style="cursor:pointer"></i>
                                   <span class="reposts-count"></span>
                                   <i class="fas fa-ellipsis-h post-menu" title="More" style="cursor:pointer"></i>
                                   <i class="fas fa-edit edit-post-btn" title="Edit" style="cursor:pointer"></i>
                                   <i class="fas fa-trash delete-post-btn" title="Delete" style="cursor:pointer"></i>
                                 </div>
                                 <div class="comment-tree" id="comments-${p.id}" style="display:none"></div>`;
                feed.appendChild(div);
            });
            this.bindUserPreviewTriggers(feed);
            this.applyHorizontalMasonryOrder(feed);
            // Bind like/comment actions
            const me2 = await this.resolveCurrentUser();
            const me2Uid = me2?.uid || '';
            feed.querySelectorAll('.post-actions').forEach(async (pa)=>{
                const postId = pa.getAttribute('data-post-id');
                const likeBtn = pa.querySelector('.like-btn');
                const commentBtn = pa.querySelector('.comment-btn');
                const repostBtn = pa.querySelector('.repost-btn');
                const editBtn = pa.querySelector('.edit-post-btn');
                const delBtn = pa.querySelector('.delete-post-btn');
                const menuBtn = pa.querySelector('.post-menu');
                const likesCount = pa.querySelector('.likes-count');
                const rCount = pa.querySelector('.reposts-count');
                const stats = await window.firebaseService.getPostStats(postId); likesCount.textContent = `${stats.likes||0}`; if (rCount) rCount.textContent = `${stats.reposts||0}`;
                if (me2Uid){
                    if (await window.firebaseService.hasLiked(postId, me2Uid)){ likeBtn.classList.add('active'); likeBtn.style.color = '#ff4d4f'; }
                }
                likeBtn.onclick = async ()=>{
                    if (!me2Uid) return;
                    const liked = await window.firebaseService.hasLiked(postId, me2Uid);
                    if (liked){ await window.firebaseService.unlikePost(postId, me2Uid); likeBtn.classList.remove('active'); likeBtn.style.color=''; }
                    else { await window.firebaseService.likePost(postId, me2Uid); likeBtn.classList.add('active'); likeBtn.style.color='#ff4d4f'; }
                    const s = await window.firebaseService.getPostStats(postId); likesCount.textContent = `${s.likes||0}`; if (rCount) rCount.textContent = `${s.reposts||0}`;
                };
                if (repostBtn){
                    repostBtn.onclick = async ()=>{
                        try{
                            const me = await window.firebaseService.getCurrentUser();
                            const already = await window.firebaseService.hasReposted(postId, me.uid);
                            if (already){ await window.firebaseService.unRepost(postId, me.uid); repostBtn.classList.remove('active'); }
                            else { await window.firebaseService.repost(postId, me.uid); repostBtn.classList.add('active'); }
                            const s3 = await window.firebaseService.getPostStats(postId); if (rCount) rCount.textContent = `${s3.reposts||0}`;
                        }catch(_){ }
                    };
                }
                if (menuBtn){
                    menuBtn.onclick = async ()=>{
                        const loc = this.buildPublicShareLink({ kind: 'post', id: postId });
                        await this.shareOrCopyLink(loc, { title: 'Post', copiedMsg: 'Post link copied' });
                    };
                }
                commentBtn.onclick = async ()=>{
                    const tree = pa.closest('.post-item')?.querySelector('.comment-tree') || document.getElementById(`comments-${postId}`);
                    if (!tree) return;
                    const forceOpen = tree.dataset.forceOpen === '1';
                    tree.dataset.forceOpen = '0';
                    if (tree.style.display === 'none' || forceOpen){ tree.style.display='block'; } else { tree.style.display='none'; return; }
                    tree.innerHTML = '';
                    const currentLimit = Number(tree.dataset.limit || 5);
                    const comments = await window.firebaseService.getComments(postId, currentLimit);
                    // Build threaded structure
                    const map = new Map();
                    comments.forEach(c=> map.set(c.id, { ...c, children: [] }));
                    const roots = [];
                    comments.forEach(c=>{ if (c.parentId && map.has(c.parentId)){ map.get(c.parentId).children.push(map.get(c.id)); } else { roots.push(map.get(c.id)); } });
                    const renderNode = (node, container)=>{
                        const item = document.createElement('div');
                        item.className = 'comment-item';
                        const commentTs = this.formatDateTime(node.createdAt);
                        const edited = this.isEdited(node) ? '<span style="font-size:10px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 5px">edited</span>' : '';
                        const fallbackName = String(node.authorId || 'User');
                        item.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">
                          <button type="button" data-user-preview="${String(node.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:6px;background:none;border:none;color:inherit;padding:0">
                            <img data-comment-avatar src="images/default-bird.png" style="width:18px;height:18px;border-radius:50%;object-fit:cover">
                            <span data-comment-name style="font-size:11px;opacity:.86">${fallbackName.slice(0,14).replace(/</g,'&lt;')}</span>
                          </button>
                          <span style="display:inline-flex;align-items:center;gap:6px;font-size:10px;opacity:.72">${commentTs}${edited}</span>
                        </div>
                        <div class="comment-text">${(node.text||'').replace(/</g,'&lt;')}</div>
                        <div class="comment-actions" data-comment-id="${node.id}" data-author="${node.authorId}" style="display:flex;gap:8px;margin-top:4px">
                          <span class="reply-btn" style="cursor:pointer"><i class=\"fas fa-reply\"></i> Reply</span>
                          <i class="fas fa-edit edit-comment-btn" title="Edit" style="cursor:pointer"></i>
                          <i class="fas fa-trash delete-comment-btn" title="Delete" style="cursor:pointer"></i>
                        </div>`;
                        container.appendChild(item);
                        this.getUserPreviewData(node.authorId).then((u)=>{
                            try{
                                const nm = item.querySelector('[data-comment-name]');
                                const av = item.querySelector('[data-comment-avatar]');
                                if (nm) nm.textContent = this._safeUsername(u?.username || '', this._safeUsername(fallbackName || '', 'User'));
                                if (av && u?.avatarUrl) av.src = u.avatarUrl;
                                this.bindUserPreviewTriggers(item);
                            }catch(_){ }
                        }).catch(()=>{ this.bindUserPreviewTriggers(item); });
                        // Reply input (hidden until click)
                        const replyBox = document.createElement('div');
                        replyBox.style.cssText = 'margin:6px 0 0 0; display:none';
                        replyBox.innerHTML = `<input type="text" class="reply-input" placeholder="Reply..." style="width:100%">`;
                        item.appendChild(replyBox);
                        item.querySelector('.reply-btn').onclick = ()=>{ replyBox.style.display = replyBox.style.display==='none'?'block':'none'; if (replyBox.style.display==='block'){ const inp=replyBox.querySelector('.reply-input'); inp && inp.focus(); } };
                        const inp = replyBox.querySelector('.reply-input');
                        if (inp){ inp.onkeydown = async (e)=>{ if (e.key==='Enter' && inp.value.trim()){ const meU = await this.resolveCurrentUser(); if (!meU || !meU.uid) return; await window.firebaseService.addComment(postId, meU.uid, inp.value.trim(), node.id); inp.value=''; tree.dataset.forceOpen = '1'; await commentBtn.onclick(); } }; }
                        if (node.children && node.children.length){
                            const sub = document.createElement('div'); sub.className='comment-tree'; item.appendChild(sub);
                            node.children.forEach(ch=> renderNode(ch, sub));
                        }
                    };
                    roots.reverse().forEach(n=> renderNode(n, tree));
                    if (comments.length >= currentLimit){
                        const more = document.createElement('button');
                        more.className = 'btn btn-secondary';
                        more.style.marginTop = '8px';
                        more.textContent = 'See more comments';
                        more.onclick = async ()=>{ tree.dataset.limit = String(currentLimit + 10); tree.dataset.forceOpen = '1'; await commentBtn.onclick(); };
                        tree.appendChild(more);
                    }
                    // bind comment edit/delete
                    tree.querySelectorAll('.comment-actions').forEach(act=>{
                        const cid = act.getAttribute('data-comment-id');
                        const author = act.getAttribute('data-author');
                        const canEdit = author === meUser.uid;
                        const eb = act.querySelector('.edit-comment-btn');
                        const db = act.querySelector('.delete-comment-btn');
                        if (!canEdit){ eb && (eb.style.display='none'); db && (db.style.display='none'); }
                        if (canEdit){
                            if (eb){ eb.onclick = async ()=>{
                                const newText = prompt('Edit comment:');
                                if (newText===null) return;
                                await window.firebaseService.updateComment(postId, cid, newText.trim());
                                this.loadFeed(uid, titleName);
                            }; }
                            if (db){ db.onclick = async ()=>{
                                if (!confirm('Delete this comment?')) return;
                                await window.firebaseService.deleteComment(postId, cid);
                                this.loadFeed(uid, titleName);
                            }; }
                        }
                    });
                };
                // bind post edit/delete (owner only)
                const postAuthor = pa.getAttribute('data-author');
                const canEditPost = postAuthor === meUser.uid;
                if (!canEditPost){ if (editBtn) editBtn.style.display='none'; if (delBtn) delBtn.style.display='none'; }
                if (canEditPost){
                    if (editBtn){ editBtn.onclick = async ()=>{
                        const container = pa.closest('.post-item');
                        const textDiv = container && container.querySelector('.post-text');
                        const current = textDiv ? textDiv.textContent : '';
                        const newText = prompt('Edit post:', current);
                        if (newText===null) return;
                        await window.firebaseService.updatePost(postId, { text: newText.trim() });
                        this.loadFeed(uid, titleName);
                    }; }
                    if (delBtn){ delBtn.onclick = async ()=>{
                        if (!confirm('Delete this post?')) return;
                        await window.firebaseService.deletePost(postId);
                        this.loadFeed(uid, titleName);
                    }; }
                }
            });
            // Removed legacy unreachable duplicate feed renderer block.
            // Suggestions (simple): recent posts by others
            const sugg = document.getElementById('space-suggestions');
            if (sugg){
                try{
                    const qAny = firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.orderBy('createdAt','desc'), firebase.limit(10));
                    const s2 = await firebase.getDocs(qAny);
                    const cards = [];
                    s2.forEach(dd=>{ const pp = dd.data(); if (pp.authorId !== uid){ cards.push(`<div class="post-item" style="border:1px solid var(--border-color);border-radius:12px;padding:10px;margin:8px 0">${(pp.text||'').replace(/</g,'&lt;')}</div>`); } });
                    sugg.innerHTML = cards.length ? `<h4>Suggestions</h4>${cards.join('')}` : '';
                }catch(_){ sugg.innerHTML = ''; }
            }
            if (feedTitle) feedTitle.textContent = titleName ? `${titleName}'s Wall` : 'My Wall';
            this.activatePostActions(feed);
            this.subscribeRealtimeFeed(`space-user-public:${uid}`, ()=>{
                return firebase.query(
                    firebase.collection(window.firebaseService.db,'posts'),
                    firebase.where('authorId','==', uid),
                    firebase.where('visibility','==','public')
                );
            }, async (payload)=>{
                if (this.currentSection !== 'space') return;
                const ok = await this.applyRealtimePostChanges(feed, payload, { displayName: titleName || '' });
                if (!ok) await this.loadFeed(uid, titleName);
            });
            this.renderSpacePlaylists(uid, true);
        }catch(e){ /* ignore */ }
    }

    async openUserSpace(uid, displayName){
        try{
            // Show banner with basic info and follow controls
            const banner = document.getElementById('space-view-banner');
            const nameEl = document.getElementById('view-user-name');
            const moodEl = document.getElementById('view-user-mood');
            const avatarEl = document.getElementById('view-user-avatar');
            const fBtn = document.getElementById('view-follow-btn');
            const ufBtn = document.getElementById('view-unfollow-btn');

            if (banner){ banner.style.display='block'; }
            if (nameEl){ nameEl.textContent = displayName || ''; }
            try{
                const profile = await window.firebaseService.getUserData(uid);
                if (moodEl) moodEl.textContent = (profile && profile.mood) ? profile.mood : '';
                if (avatarEl && profile && profile.avatarUrl) avatarEl.src = profile.avatarUrl;
            }catch(_){ }

            try{
                const me = await window.firebaseService.getCurrentUser();
                const following = await window.firebaseService.getFollowingIds(me.uid);
                const isFollowing = (following||[]).includes(uid);
                if (fBtn && ufBtn){
                    fBtn.style.display = isFollowing ? 'none' : 'inline-block';
                    ufBtn.style.display = isFollowing ? 'inline-block' : 'none';
                    fBtn.onclick = async ()=>{ await window.firebaseService.followUser(me.uid, uid); this.openUserSpace(uid, displayName); };
                    ufBtn.onclick = async ()=>{ await window.firebaseService.unfollowUser(me.uid, uid); this.openUserSpace(uid, displayName); };
                }
            }catch(_){ }

            // Load only public posts of selected user
            const feed = document.getElementById('space-feed');
            const feedTitle = document.getElementById('space-feed-title');
            if (feed) feed.innerHTML='';
            if (feedTitle) feedTitle.textContent = `${displayName||'User'}'s Wall`;
            try{
                let snap;
                try{
                    const q = firebase.query(
                        firebase.collection(window.firebaseService.db,'posts'),
                        firebase.where('authorId','==', uid),
                        firebase.where('visibility','==','public'),
                        firebase.orderBy('createdAtTS','desc'),
                        firebase.limit(50)
                    );
                    snap = await firebase.getDocs(q);
                }catch{
                    const q2 = firebase.query(firebase.collection(window.firebaseService.db,'posts'), firebase.where('authorId','==', uid), firebase.where('visibility','==','public'));
                    snap = await firebase.getDocs(q2);
                    snap = { docs: snap.docs.sort((a,b)=> (b.data()?.createdAtTS?.toMillis?.()||0) - (a.data()?.createdAtTS?.toMillis?.()||0) || new Date((b.data()||{}).createdAt||0) - new Date((a.data()||{}).createdAt||0)), forEach: (cb)=> snap.docs.forEach(cb) };
                }
                snap.forEach(d=>{
                    const p = d.data();
                    const div = document.createElement('div');
                    div.className = 'post-item';
                    div.style.cssText = 'border:1px solid var(--border-color);border-radius:12px;padding:12px;margin:10px 0;background:var(--secondary-bg)';
                    const authorName = this._safeUsername(p.authorName || '', this._safeUsername(displayName || '', 'User'));
                    const authorAvatar = String(p.coverUrl || p.thumbnailUrl || 'images/default-bird.png');
                    const postTime = this.formatDateTime(p.createdAt);
                    const editedBadge = this.isEdited(p) ? '<span style="font-size:11px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 6px">edited</span>' : '';
                    const media = (p.media || p.mediaUrl) ? this.renderPostMedia(p.media || p.mediaUrl, { defaultBy: p.authorName || '', defaultCover: p.coverUrl || p.thumbnailUrl || '', authorId: p.authorId || '' }) : '';
                    const postText = this.getPostDisplayText(p);
                    const postTextHtml = postText ? `<div class="post-text">${postText.replace(/</g,'&lt;')}</div>` : '';
                    div.innerHTML = `<div class="post-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
                                       <button type="button" data-user-preview="${String(p.authorId || '').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:8px;background:none;border:none;color:inherit;padding:0">
                                         <img src="${authorAvatar}" alt="author" style="width:22px;height:22px;border-radius:50%;object-fit:cover">
                                         <span style="font-size:12px;color:#aaa">${authorName.replace(/</g,'&lt;')}</span>
                                       </button>
                                       <span class="post-head-meta" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;opacity:.74">${postTime}${editedBadge}</span>
                                     </div>
                                     ${media}${postTextHtml}`;
                    if (feed) feed.appendChild(div);
                });
                this.bindUserPreviewTriggers(feed);
                this.applyHorizontalMasonryOrder(feed);
                this.activatePostActions(feed);
                this.subscribeRealtimeFeed(`space-open-user:${uid}`, ()=>{
                    return firebase.query(
                        firebase.collection(window.firebaseService.db,'posts'),
                        firebase.where('authorId','==', uid),
                        firebase.where('visibility','==','public')
                    );
                }, async (payload)=>{
                    if (this.currentSection !== 'space') return;
                    const ok = await this.applyRealtimePostChanges(feed, payload, { displayName: displayName || '' });
                    if (!ok) await this.openUserSpace(uid, displayName);
                });
                this.renderSpacePlaylists(uid, true);
            }catch(_){ }
        }catch(_){ }
    }

    _deferNonVisiblePreload(sectionToPreload) {
        const schedule = typeof requestIdleCallback !== 'undefined'
            ? (cb) => requestIdleCallback(cb, { timeout: 2000 })
            : (cb) => setTimeout(cb, 100);
        schedule(() => {
            if (this._dashboardSuspended || this.currentSection === sectionToPreload) return;
            try {
                if (sectionToPreload === 'feed') this.loadGlobalFeed(this._wallSearchTerm || '');
                else if (sectionToPreload === 'apps' && window.appsManager) window.appsManager.loadApps();
            } catch (_) {}
        });
    }

    /**
     * Switch between dashboard sections
     */
    switchSection(section) {
        if (this._dashboardSuspended) return;
        if (!this.canAccessSection(section)){
            section = 'apps';
        }
        this.updateVerificationBanner();
        // Update desktop navigation
        const navBtns = document.querySelectorAll('.nav-btn');
        navBtns.forEach(btn => btn.classList.remove('active'));
        const desktopActiveBtn = document.querySelector(`.nav-btn[data-section="${section}"]`);
        if (desktopActiveBtn) {
            desktopActiveBtn.classList.add('active');
        }

        // Update mobile navigation
        const mobileNavBtns = document.querySelectorAll('.mobile-nav-btn');
        mobileNavBtns.forEach(btn => btn.classList.remove('active'));
        const mobileActiveBtn = document.querySelector(`.mobile-nav-btn[data-section="${section}"]`);
        if (mobileActiveBtn) {
            mobileActiveBtn.classList.add('active');
        }

        // Update content sections
        const contentSections = document.querySelectorAll('.content-section');
        contentSections.forEach(sectionEl => sectionEl.classList.remove('active'));
        const target = document.getElementById(`${section}-section`);
        if (target) target.classList.add('active');

        this.currentSection = section;
        try{
            document.body.classList.toggle('waveconnect-active', section === 'waveconnect');
        }catch(_){ }

        // Persist last section and sync hash
        try{ localStorage.setItem('liber_last_section', section); if (window.location.hash !== `#${section}`) window.location.hash = section; }catch(_){ }

        // Load section-specific content (visible section immediately)
        switch (section) {
            
            case 'apps':
                if (window.appsManager) {
                    window.appsManager.loadApps();
                }
                if (window.firebaseService?.prefetchChatConnections) {
                    window.firebaseService.prefetchChatConnections().catch(()=>{});
                }
                this._deferNonVisiblePreload('feed');
                break;
            case 'space':
                this.loadSpace();
                break;
            case 'feed':
                this.loadGlobalFeed();
                // Ensure players activate after section switch
                setTimeout(()=> this.activatePlayers(document.getElementById('global-feed')), 50);
                this._deferNonVisiblePreload('apps');
                break;
            case 'waveconnect':
                this.loadWaveConnect();
                this.bindWaveconnectTabsAndSubnav();
                break;
            case 'profile':
                this.loadProfile();
                break;
            case 'users':
                if (window.usersManager) {
                    window.usersManager.loadUsers();
                }
                break;
            case 'settings':
                this.loadSettings();
                break;
        }
    }

    bindWaveconnectTabsAndSubnav(){
        const tA = document.getElementById('wave-tab-audio');
        const tV = document.getElementById('wave-tab-video');
        const tP = document.getElementById('wave-tab-pictures');
        const pA = document.getElementById('wave-audio-pane');
        const pV = document.getElementById('wave-video-pane');
        const pP = document.getElementById('wave-pictures-pane');
        const studioQuick = document.getElementById('wave-studio-btn');
        const studioSubnav = document.getElementById('wave-subnav-studio-btn');
        const mobileUpload = document.getElementById('mobile-wave-upload-btn');
        const subnav = document.getElementById('wave-subnav');
        if (tA && tV && tP && pA && pV && pP && !tA._boundMainTabs){
            tA._boundMainTabs = tV._boundMainTabs = tP._boundMainTabs = true;
            tA.onclick = ()=> this.setWaveMainTab('audio');
            tV.onclick = ()=> this.setWaveMainTab('video');
            tP.onclick = ()=> this.setWaveMainTab('pictures');
        }
        if (subnav && !subnav._boundSubtabs){
            subnav._boundSubtabs = true;
            subnav.querySelectorAll('[data-wave-subtab]').forEach((btn)=>{
                btn.addEventListener('click', ()=>{
                    const sub = String(btn.getAttribute('data-wave-subtab') || 'home').trim().toLowerCase();
                    this.setWaveSubtab(sub);
                });
            });
        }
        if (studioQuick && !studioQuick._bound){
            studioQuick._bound = true;
            studioQuick.onclick = ()=> this.openWaveStudioModal(this._waveMainTab || 'audio');
        }
        if (studioSubnav && !studioSubnav._bound){
            studioSubnav._bound = true;
            studioSubnav.onclick = ()=> this.openWaveStudioModal(this._waveMainTab || 'audio');
        }
        if (mobileUpload && !mobileUpload._bound){
            mobileUpload._bound = true;
            mobileUpload.onclick = ()=>{
                if ((this.currentSection || '') !== 'waveconnect') this.switchSection('waveconnect');
                this.openWaveUploadWizard(this._waveMainTab || 'audio');
            };
        }
        this.setWaveMainTab(this._waveMainTab || 'audio');
    }

    setWaveMainTab(name){
        const next = (name === 'video' || name === 'pictures') ? name : 'audio';
        this._waveMainTab = next;
        const tA = document.getElementById('wave-tab-audio');
        const tV = document.getElementById('wave-tab-video');
        const tP = document.getElementById('wave-tab-pictures');
        const pA = document.getElementById('wave-audio-pane');
        const pV = document.getElementById('wave-video-pane');
        const pP = document.getElementById('wave-pictures-pane');
        if (tA && tV && tP){
            tA.classList.toggle('active', next === 'audio');
            tV.classList.toggle('active', next === 'video');
            tP.classList.toggle('active', next === 'pictures');
            tA.setAttribute('aria-selected', next === 'audio' ? 'true' : 'false');
            tV.setAttribute('aria-selected', next === 'video' ? 'true' : 'false');
            tP.setAttribute('aria-selected', next === 'pictures' ? 'true' : 'false');
        }
        if (pA) pA.style.display = next === 'audio' ? '' : 'none';
        if (pV) pV.style.display = next === 'video' ? 'block' : 'none';
        if (pP) pP.style.display = next === 'pictures' ? 'block' : 'none';
        if (next === 'audio') this.loadWaveConnect();
        if (next === 'video') this.loadVideoHost();
        if (next === 'pictures') this.loadPictureHost();
        this.applyWaveSubtab();
    }

    setWaveSubtab(name){
        const sub = String(name || 'home').trim().toLowerCase() || 'home';
        if (sub !== 'home' && sub !== 'search' && sub !== 'library') return;
        this._waveSubTabByMain[this._waveMainTab || 'audio'] = sub;
        this.applyWaveSubtab();
    }

    applyWaveSubtab(){
        const main = this._waveMainTab || 'audio';
        const sub = String(this._waveSubTabByMain[main] || 'home');
        const subnav = document.getElementById('wave-subnav');
        if (subnav){
            subnav.querySelectorAll('[data-wave-subtab]').forEach((btn)=>{
                const key = String(btn.getAttribute('data-wave-subtab') || '');
                const active = key === sub;
                btn.classList.toggle('active', active);
                btn.setAttribute('aria-selected', active ? 'true' : 'false');
            });
        }
        const pane = main === 'video' ? document.getElementById('wave-video-pane') : (main === 'pictures' ? document.getElementById('wave-pictures-pane') : document.getElementById('wave-audio-pane'));
        if (!pane) return;
        const show = (selector, visible)=>{
            pane.querySelectorAll(selector).forEach((el)=> el.classList.toggle('wave-subtab-hidden', !visible));
        };
        const showCardById = (id, visible)=>{
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.toggle('wave-subtab-hidden', !visible);
        };
        pane.querySelectorAll('.settings-grid').forEach((grid)=> grid.classList.add('wave-subtab-hidden'));
        show('#wave-audio-home,#wave-video-home,#wave-picture-home', sub === 'home');
        show('#wave-audio-pane > .section-header,#wave-results,#wave-results-wrapper,#video-search-pane,#picture-search-pane', sub === 'search');
        show('#wave-library-pane,#wave-library-uploaded-pane,#wave-library-saved-pane,#wave-library-liked-pane,#wave-library-playlists-pane,#video-library-pane,#picture-library-pane,#wave-playlists', sub === 'library');
        show('#video-suggestions-pane,#picture-suggestions-pane', sub === 'home');
        if (main === 'audio'){
            // Audio: keep Home clean; show only relevant cards per subtab.
            showCardById('wave-audio-search-bar', sub === 'search');
            showCardById('wave-audio-search-card', sub === 'search');
            showCardById('wave-audio-library-card', sub === 'library');
            showCardById('wave-upload-card', false);
        }
        if (main === 'video'){
            // Hide the library/search container card on Home to avoid empty shell.
            showCardById('wave-video-library-card', sub !== 'home');
        }
        if (main === 'pictures'){
            // Hide the library/search container card on Home to avoid empty shell.
            showCardById('wave-picture-library-card', sub !== 'home');
        }
        if (sub === 'search'){
            if (main === 'video'){
                const paneSearch = document.getElementById('video-search-pane');
                const paneLib = document.getElementById('video-library-pane');
                const paneSug = document.getElementById('video-suggestions-pane');
                if (paneSearch) paneSearch.style.display = 'block';
                if (paneLib) paneLib.style.display = 'none';
                if (paneSug) paneSug.style.display = 'none';
            } else if (main === 'pictures'){
                const paneSearch = document.getElementById('picture-search-pane');
                const paneLib = document.getElementById('picture-library-pane');
                const paneSug = document.getElementById('picture-suggestions-pane');
                if (paneSearch) paneSearch.style.display = 'block';
                if (paneLib) paneLib.style.display = 'none';
                if (paneSug) paneSug.style.display = 'none';
            }
        } else if (sub === 'library'){
            if (main === 'video'){
                const paneSearch = document.getElementById('video-search-pane');
                const paneLib = document.getElementById('video-library-pane');
                const paneSug = document.getElementById('video-suggestions-pane');
                if (paneSearch) paneSearch.style.display = 'none';
                if (paneLib) paneLib.style.display = 'block';
                if (paneSug) paneSug.style.display = 'none';
            } else if (main === 'pictures'){
                const paneSearch = document.getElementById('picture-search-pane');
                const paneLib = document.getElementById('picture-library-pane');
                const paneSug = document.getElementById('picture-suggestions-pane');
                if (paneSearch) paneSearch.style.display = 'none';
                if (paneLib) paneLib.style.display = 'block';
                if (paneSug) paneSug.style.display = 'none';
            }
        } else {
            if (main === 'video'){
                const paneSearch = document.getElementById('video-search-pane');
                const paneLib = document.getElementById('video-library-pane');
                const paneSug = document.getElementById('video-suggestions-pane');
                if (paneSearch) paneSearch.style.display = 'none';
                if (paneLib) paneLib.style.display = 'none';
                if (paneSug) paneSug.style.display = 'block';
            } else if (main === 'pictures'){
                const paneSearch = document.getElementById('picture-search-pane');
                const paneLib = document.getElementById('picture-library-pane');
                const paneSug = document.getElementById('picture-suggestions-pane');
                if (paneSearch) paneSearch.style.display = 'none';
                if (paneLib) paneLib.style.display = 'none';
                if (paneSug) paneSug.style.display = 'block';
            }
        }
    }

    async openWaveUploadWizard(kind = 'audio'){
        try{
            const k = (kind === 'video' || kind === 'pictures') ? kind : 'audio';
            const existing = document.getElementById('wave-upload-wizard');
            if (existing) existing.remove();
            const overlay = document.createElement('div');
            overlay.id = 'wave-upload-wizard';
            overlay.className = 'waveconnect-sheet';
            const labels = { audio:'Audio', video:'Video', pictures:'Picture' };
            overlay.innerHTML = `<div class="waveconnect-sheet-panel" style="max-width:640px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px"><div style="font-weight:700">Upload ${labels[k]}</div><button type="button" class="btn btn-secondary" data-close>Close</button></div>
              <div style="font-size:12px;opacity:.78;margin-bottom:8px">Step 1: choose file</div>
              <label for="wiz-file" style="font-size:12px;opacity:.82;display:block;margin-bottom:4px">Media file</label>
              <input id="wiz-file" type="file" accept="${k === 'audio' ? 'audio/*' : (k === 'video' ? 'video/*' : 'image/*,video/*')}" style="margin-bottom:10px;width:100%">
              <div style="font-size:12px;opacity:.78;margin-bottom:8px">Step 2: details</div>
              <label for="wiz-title" style="font-size:12px;opacity:.82;display:block;margin-bottom:4px">Title</label>
              <input id="wiz-title" type="text" placeholder="Title" style="width:100%;margin-bottom:8px">
              <label for="wiz-cover" style="font-size:12px;opacity:.82;display:block;margin-bottom:4px">Cover image (optional)</label>
              <input id="wiz-cover" type="file" accept="image/*" style="margin-bottom:8px;width:100%">
              <label for="wiz-tags" style="font-size:12px;opacity:.82;display:block;margin-bottom:4px">Private tags</label>
              <input id="wiz-tags" type="text" placeholder="Tags (comma separated, private for search)" style="width:100%;margin-bottom:8px">
              <div style="font-size:12px;opacity:.78;margin-bottom:8px">Step 3: visibility</div>
              <label for="wiz-visibility" style="font-size:12px;opacity:.82;display:block;margin-bottom:4px">Visibility</label>
              <select id="wiz-visibility" style="width:100%;margin-bottom:12px"><option value="public">Public</option><option value="private">Private</option></select>
              <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button type="button" class="btn btn-primary" id="wiz-submit">Upload</button></div>
            </div>`;
            const close = ()=>{ try{ overlay.remove(); }catch(_){ } };
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay || e.target?.matches?.('[data-close]')) close(); });
            const submit = overlay.querySelector('#wiz-submit');
            if (submit){
                submit.addEventListener('click', async ()=>{
                    const fileInput = overlay.querySelector('#wiz-file');
                    const coverInput = overlay.querySelector('#wiz-cover');
                    const titleInput = overlay.querySelector('#wiz-title');
                    const tagsInput = overlay.querySelector('#wiz-tags');
                    const visInput = overlay.querySelector('#wiz-visibility');
                    const file = fileInput?.files?.[0];
                    if (!file){ this.showError('Please choose a file'); return; }
                    const cover = coverInput?.files?.[0] || null;
                    const title = String(titleInput?.value || '').trim() || String(file.name || '');
                    const tags = String(tagsInput?.value || '').split(',').map((t)=> t.trim().toLowerCase()).filter(Boolean).slice(0, 20);
                    const visibility = String(visInput?.value || 'public') === 'private' ? 'private' : 'public';
                    await this.runWaveUploadWizardSubmit(k, { file, cover, title, tags, visibility });
                    close();
                });
            }
            document.body.appendChild(overlay);
        }catch(_){ }
    }

    async runWaveUploadWizardSubmit(kind, payload){
        try{
            const k = (kind === 'video' || kind === 'pictures') ? kind : 'audio';
            this._pendingWaveUploadTags[k] = Array.isArray(payload?.tags) ? payload.tags : [];
            this._pendingWaveUploadTags[`${k}:visibility`] = String(payload?.visibility || 'public');
            const assignFile = (inputId, file)=>{
                const input = document.getElementById(inputId);
                if (!input || !file) return;
                try{
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    input.files = dt.files;
                }catch(_){ }
            };
            if (k === 'audio'){
                const titleEl = document.getElementById('wave-title');
                if (titleEl) titleEl.value = String(payload?.title || '').trim();
                assignFile('wave-file', payload?.file);
                assignFile('wave-cover', payload?.cover);
                const btn = document.getElementById('wave-upload-btn');
                if (btn) btn.click();
                return;
            }
            if (k === 'video'){
                const titleEl = document.getElementById('video-title');
                if (titleEl) titleEl.value = String(payload?.title || '').trim();
                assignFile('video-file', payload?.file);
                assignFile('video-cover', payload?.cover);
                const btn = document.getElementById('video-upload-btn');
                if (btn) btn.click();
                return;
            }
            const titleEl = document.getElementById('picture-title');
            if (titleEl) titleEl.value = String(payload?.title || '').trim();
            assignFile('picture-file', payload?.file);
            const btn = document.getElementById('picture-upload-btn');
            if (btn) btn.click();
        }catch(_){ this.showError('Upload failed'); }
    }

    async openWaveStudioModal(kind = 'audio'){
        try{
            const k = (kind === 'video' || kind === 'pictures') ? kind : 'audio';
            const me = await this.resolveCurrentUser();
            if (!me?.uid){ this.showError('Please sign in'); return; }
            const old = document.getElementById('wave-studio-modal');
            if (old) old.remove();
            const overlay = document.createElement('div');
            overlay.id = 'wave-studio-modal';
            overlay.className = 'waveconnect-sheet';
            overlay.innerHTML = `<div class="waveconnect-sheet-panel wave-studio-shell" style="width:min(1180px,100%);max-height:88vh;overflow:auto">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
                <div style="font-weight:700">${k[0].toUpperCase() + k.slice(1)} Studio</div>
                <button type="button" class="btn btn-secondary" data-close>Close</button>
              </div>
              <div id="wave-studio-analytics" class="wave-home-grid" style="margin-bottom:12px">
                <div class="wave-home-card"><div style="font-size:12px;opacity:.8">Views</div><div id="wave-studio-metric-views" style="font-size:22px;font-weight:700">0</div></div>
                <div class="wave-home-card"><div style="font-size:12px;opacity:.8">Likes</div><div id="wave-studio-metric-likes" style="font-size:22px;font-weight:700">0</div></div>
                <div class="wave-home-card"><div style="font-size:12px;opacity:.8">Comments</div><div id="wave-studio-metric-comments" style="font-size:22px;font-weight:700">0</div></div>
                <div class="wave-home-card"><div style="font-size:12px;opacity:.8">Reposts</div><div id="wave-studio-metric-reposts" style="font-size:22px;font-weight:700">0</div></div>
              </div>
              <div class="wave-home-card" style="margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
                  <div style="font-weight:600">Performance chart</div>
                  <div style="display:flex;align-items:center;gap:8px">
                    <label for="wave-studio-range" style="font-size:11px;opacity:.75">Range</label>
                    <select id="wave-studio-range" style="font-size:12px;padding:4px 8px;border-radius:8px;background:#131a28;color:#e7efff;border:1px solid rgba(255,255,255,.16)">
                      <option value="day">Day</option>
                      <option value="week">Week</option>
                      <option value="month" selected>Month</option>
                      <option value="year">Year</option>
                    </select>
                  </div>
                </div>
                <div id="wave-studio-chart-host" style="width:100%;height:220px"></div>
              </div>
              <div id="wave-studio-list" class="wave-studio-rows"><div style="opacity:.8">Loading studio...</div></div>
            </div>`;
            const close = ()=>{ try{ overlay.remove(); }catch(_){ } };
            overlay.addEventListener('click', (e)=>{ if (e.target === overlay || e.target?.matches?.('[data-close]')) close(); });
            document.body.appendChild(overlay);
            const host = overlay.querySelector('#wave-studio-list');
            const rows = await this.fetchWaveStudioRows(k, me.uid);
            host.innerHTML = '';
            if (!rows.length){
                host.innerHTML = '<div style="opacity:.8">No media uploaded yet.</div>';
                return;
            }
            await this.ensureD3Loaded();
            await this.renderWaveStudioAnalytics(overlay, rows);
            const rangeSel = overlay.querySelector('#wave-studio-range');
            if (rangeSel && !rangeSel._bound){
                rangeSel._bound = true;
                rangeSel.addEventListener('change', ()=> this.renderWaveStudioAnalytics(overlay, rows));
            }
            rows.forEach((row)=> host.appendChild(this.buildWaveStudioCard(row, k)));
        }catch(_){ this.showError('Unable to open studio'); }
    }

    async ensureD3Loaded(){
        try{
            if (window.d3) return true;
            if (this._d3LoadPromise) return this._d3LoadPromise;
            this._d3LoadPromise = new Promise((resolve)=>{
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
                script.async = true;
                script.onload = ()=> resolve(true);
                script.onerror = ()=> resolve(false);
                document.head.appendChild(script);
            });
            return await this._d3LoadPromise;
        }catch(_){ return false; }
    }

    async renderWaveStudioAnalytics(overlay, rows){
        try{
            const host = overlay?.querySelector?.('#wave-studio-chart-host');
            if (!host) return;
            const totals = rows.reduce((acc, row)=>{
                acc.views += Number(row?.viewCount || row?.playCount || 0) || 0;
                return acc;
            }, { views:0, likes:0, comments:0, reposts:0 });
            const rowsForTotals = rows.slice(0, 120);
            await Promise.all(rowsForTotals.map(async (row)=>{
                try{
                    const postId = await this.resolveAssetPostId({ sourceId: String(row?.id || ''), url: String(row?.url || '') });
                    if (!postId) return;
                    const st = await window.firebaseService?.getPostStats?.(postId) || {};
                    totals.likes += Number(st.likes || 0) || 0;
                    totals.comments += Number(st.comments || 0) || 0;
                    totals.reposts += Number(st.reposts || 0) || 0;
                }catch(_){ }
            }));
            overlay.querySelector('#wave-studio-metric-views').textContent = String(totals.views);
            overlay.querySelector('#wave-studio-metric-likes').textContent = String(totals.likes);
            overlay.querySelector('#wave-studio-metric-comments').textContent = String(totals.comments);
            overlay.querySelector('#wave-studio-metric-reposts').textContent = String(totals.reposts);
            if (!window.d3){
                host.innerHTML = '<div style="font-size:12px;opacity:.8">Chart unavailable.</div>';
                return;
            }
            const range = String(overlay?.querySelector?.('#wave-studio-range')?.value || 'month').toLowerCase();
            const grouped = new Map();
            const toDate = (row)=>{
                const ts = row?.createdAtTS?.toMillis?.();
                if (Number.isFinite(Number(ts)) && Number(ts) > 0) return new Date(Number(ts));
                const raw = String(row?.createdAt || row?.updatedAt || '').trim();
                const t = Number(new Date(raw).getTime() || 0);
                return t > 0 ? new Date(t) : new Date();
            };
            const weekStart = (d)=>{
                const x = new Date(d);
                const day = (x.getDay() + 6) % 7;
                x.setDate(x.getDate() - day);
                x.setHours(0, 0, 0, 0);
                return x;
            };
            rows.forEach((row)=>{
                const d = toDate(row);
                let key = '';
                let label = '';
                if (range === 'day'){
                    key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
                    label = `${d.getDate()}/${d.getMonth() + 1}`;
                } else if (range === 'week'){
                    const w = weekStart(d);
                    key = `${w.getFullYear()}-${w.getMonth() + 1}-${w.getDate()}`;
                    label = `W ${w.getDate()}/${w.getMonth() + 1}`;
                } else if (range === 'year'){
                    key = `${d.getFullYear()}`;
                    label = key;
                } else {
                    key = `${d.getFullYear()}-${d.getMonth() + 1}`;
                    label = `${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}`;
                }
                const cur = grouped.get(key) || { title: label, views: 0 };
                cur.views += Number(row?.viewCount || row?.playCount || 0) || 0;
                grouped.set(key, cur);
            });
            const data = Array.from(grouped.entries())
                .sort((a, b)=> a[0] < b[0] ? -1 : 1)
                .slice(-12)
                .map((x)=> x[1]);
            host.innerHTML = '';
            const width = Math.max(320, host.clientWidth || 320);
            const height = 220;
            const margin = { top: 16, right: 12, bottom: 36, left: 34 };
            const svg = window.d3.select(host).append('svg').attr('width', width).attr('height', height);
            const x = window.d3.scaleBand().domain(data.map((d)=> d.title)).range([margin.left, width - margin.right]).padding(0.2);
            const y = window.d3.scaleLinear().domain([0, window.d3.max(data, (d)=> d.views) || 1]).nice().range([height - margin.bottom, margin.top]);
            svg.append('g').attr('transform', `translate(0,${height - margin.bottom})`).call(window.d3.axisBottom(x).tickSizeOuter(0))
                .selectAll('text').attr('fill','#d9e7ff').style('font-size','10px').attr('transform','rotate(-18)').style('text-anchor','end');
            svg.append('g').attr('transform', `translate(${margin.left},0)`).call(window.d3.axisLeft(y).ticks(4))
                .selectAll('text').attr('fill','#d9e7ff').style('font-size','10px');
            svg.selectAll('.bar').data(data).enter().append('rect')
                .attr('x', (d)=> x(d.title))
                .attr('y', (d)=> y(d.views))
                .attr('width', x.bandwidth())
                .attr('height', (d)=> (height - margin.bottom) - y(d.views))
                .attr('rx', 6)
                .attr('fill', '#3b82f6');
        }catch(_){ }
    }

    async fetchWaveStudioRows(kind, uid){
        const out = [];
        if (kind === 'audio'){
            try{
                const q = firebase.query(firebase.collection(window.firebaseService.db, 'wave'), firebase.where('ownerId','==', uid), firebase.limit(400));
                const s = await firebase.getDocs(q);
                s.forEach((d)=> out.push({ id:d.id, ...(d.data() || {}) }));
            }catch(_){ }
            return out;
        }
        try{
            const q = firebase.query(firebase.collection(window.firebaseService.db, 'videos'), firebase.where('owner','==', uid), firebase.limit(500));
            const s = await firebase.getDocs(q);
            s.forEach((d)=>{
                const row = { id:d.id, ...(d.data() || {}) };
                const resolvedKind = this.resolveVisualKind(row);
                if (kind === 'pictures' ? resolvedKind === 'image' : resolvedKind === 'video') out.push(row);
            });
        }catch(_){ }
        return out;
    }

    buildWaveStudioCard(row, kind){
        const wrap = document.createElement('div');
        wrap.className = 'wave-home-card wave-studio-row';
        const title = String(row?.title || 'Untitled');
        const cover = (()=> {
            const mediaKind = kind === 'audio' ? 'audio' : (kind === 'pictures' ? 'image' : this.resolveVisualKind(row));
            if (mediaKind === 'audio') return String(row?.coverUrl || row?.thumbnailUrl || 'images/default-bird.png');
            if (mediaKind === 'image') return String(row?.thumbnailUrl || row?.url || 'images/default-bird.png');
            return String(row?.thumbnailUrl || row?.coverUrl || 'images/default-bird.png');
        })();
        const views = Number(row?.viewCount || row?.playCount || 0) || 0;
        wrap.innerHTML = `<div class="wave-studio-head">
          <img src="${cover.replace(/"/g,'&quot;')}" alt="" class="wave-studio-cover">
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title.replace(/</g,'&lt;')}</div>
            <div style="opacity:.7;font-size:12px">${views} ${kind === 'audio' ? 'plays' : 'views'}</div>
          </div>
        </div>
        <div class="wave-studio-edit-grid">
          <input type="text" data-studio-title value="${title.replace(/"/g,'&quot;')}" placeholder="Title">
          <select data-studio-visibility><option value="public"${String(row.visibility||'public')==='public'?' selected':''}>public</option><option value="private"${String(row.visibility||'public')==='private'?' selected':''}>private</option></select>
          <input type="text" data-studio-tags value="${Array.isArray(row?.tagsPrivate) ? row.tagsPrivate.join(', ') : ''}" placeholder="Private tags (comma-separated)">
          <input type="file" data-studio-cover accept="image/*" aria-label="Upload cover image">
        </div>
        <div class="wave-studio-actions">
          <button class="btn btn-secondary" data-studio-save>Save</button>
          <button class="btn btn-secondary" data-studio-comments>Comments</button>
          <button class="btn btn-secondary" data-studio-delete>Delete</button>
        </div>
        <div style="font-size:11px;opacity:.74" data-studio-metrics>Loading likes/comments/reposts...</div>`;
        const coverEl = wrap.querySelector('.wave-studio-cover');
        if (coverEl){
            coverEl.addEventListener('error', ()=>{ coverEl.src = 'images/default-bird.png'; }, { once: true });
        }
        const saveBtn = wrap.querySelector('[data-studio-save]');
        if (saveBtn){
            saveBtn.addEventListener('click', async ()=>{
                const t = String(wrap.querySelector('[data-studio-title]')?.value || '').trim() || 'Untitled';
                const v = String(wrap.querySelector('[data-studio-visibility]')?.value || 'public');
                const tags = String(wrap.querySelector('[data-studio-tags]')?.value || '')
                    .split(',')
                    .map((x)=> x.trim().toLowerCase())
                    .filter(Boolean)
                    .slice(0, 20);
                const coverFile = wrap.querySelector('[data-studio-cover]')?.files?.[0] || null;
                try{
                    saveBtn.disabled = true;
                    const col = kind === 'audio' ? 'wave' : 'videos';
                    const patch = {
                        title: t,
                        visibility: v === 'private' ? 'private' : 'public',
                        tagsPrivate: tags,
                        updatedAt: new Date().toISOString(),
                        updatedAtTS: firebase.serverTimestamp()
                    };
                    if (coverFile){
                        try{
                            const me = this.currentUser || (await this.resolveCurrentUser());
                            const uid = String(me?.uid || row?.owner || row?.ownerId || '').trim();
                            const safeName = String(coverFile.name || 'cover.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
                            const dir = kind === 'audio' ? 'wave' : 'video-covers';
                            const s = firebase.getStorage();
                            const cRef = firebase.ref(s, `${dir}/${uid || 'shared'}/studio_${Date.now()}_${safeName}`);
                            await firebase.uploadBytes(cRef, coverFile, { contentType: coverFile.type || 'image/jpeg' });
                            const nextCover = await firebase.getDownloadURL(cRef);
                            if (kind === 'audio') patch.coverUrl = nextCover;
                            else patch.thumbnailUrl = nextCover;
                        }catch(_){ }
                    }
                    await firebase.updateDoc(firebase.doc(window.firebaseService.db, col, String(row.id || '')), patch);
                    row.title = t;
                    row.visibility = v;
                    row.tagsPrivate = tags;
                    if (patch.coverUrl) row.coverUrl = patch.coverUrl;
                    if (patch.thumbnailUrl) row.thumbnailUrl = patch.thumbnailUrl;
                    if (coverEl && (patch.coverUrl || patch.thumbnailUrl)) coverEl.src = String(patch.coverUrl || patch.thumbnailUrl);
                    this.showSuccess('Studio item updated');
                }catch(_){ this.showError('Failed to update item'); }
                finally{ saveBtn.disabled = false; }
            });
        }
        const commentsBtn = wrap.querySelector('[data-studio-comments]');
        if (commentsBtn){
            commentsBtn.addEventListener('click', async ()=>{
                try{
                    const postId = await this.ensureAssetDiscussionPost({
                        kind: kind === 'pictures' ? 'image' : (kind === 'audio' ? 'audio' : 'video'),
                        sourceId: String(row?.id || ''),
                        url: String(row?.url || ''),
                        title: String(row?.title || 'Media'),
                        by: String(row?.authorName || ''),
                        authorName: String(row?.authorName || ''),
                        cover: String(row?.coverUrl || row?.thumbnailUrl || '')
                    });
                    if (!postId){ this.showError('Unable to open comments'); return; }
                    await this.openAssetCommentsModal(postId, String(row?.title || 'Comments'));
                    await this.hydrateStudioMetrics(wrap, row);
                }catch(_){ this.showError('Unable to open comments'); }
            });
        }
        const delBtn = wrap.querySelector('[data-studio-delete]');
        if (delBtn){
            delBtn.addEventListener('click', async ()=>{
                try{
                    if (!confirm('Delete this media item?')) return;
                    delBtn.disabled = true;
                    const col = kind === 'audio' ? 'wave' : 'videos';
                    await firebase.deleteDoc(firebase.doc(window.firebaseService.db, col, String(row.id || '')));
                    wrap.remove();
                    this.showSuccess('Studio item deleted');
                }catch(_){ this.showError('Failed to delete item'); }
                finally{ delBtn.disabled = false; }
            });
        }
        this.hydrateStudioMetrics(wrap, row).catch(()=>{});
        return wrap;
    }

    async hydrateStudioMetrics(root, row){
        const target = root?.querySelector?.('[data-studio-metrics]');
        if (!target) return;
        try{
            const postId = await this.resolveAssetPostId({ sourceId: String(row?.id || ''), url: String(row?.url || '') });
            if (!postId){ target.textContent = 'Likes 0 | Comments 0 | Reposts 0'; return; }
            const stats = await window.firebaseService?.getPostStats?.(postId) || {};
            let top = '';
            try{
                const q = firebase.query(firebase.collection(window.firebaseService.db, 'posts', postId, 'comments'), firebase.limit(3));
                const s = await firebase.getDocs(q);
                const snippets = [];
                s.forEach((d)=> snippets.push(String((d.data() || {}).text || '').trim()));
                top = snippets.filter(Boolean).slice(0, 2).join(' | ');
            }catch(_){ }
            target.textContent = `Likes ${Number(stats.likes || 0)} | Comments ${Number(stats.comments || 0)} | Reposts ${Number(stats.reposts || 0)}${top ? ` | Top: ${top.slice(0, 90)}` : ''}`;
        }catch(_){
            target.textContent = 'Likes 0 | Comments 0 | Reposts 0';
        }
    }

    async resolveAssetPostId(asset = {}){
        try{
            const direct = String(asset.sourcePostId || '').trim();
            if (direct) return direct;
            const srcId = String(asset.sourceId || '').trim();
            if (srcId){
                try{
                    const qBySource = firebase.query(
                        firebase.collection(window.firebaseService.db, 'posts'),
                        firebase.where('sourceType', '==', 'waveconnect-asset'),
                        firebase.where('sourceId', '==', srcId),
                        firebase.limit(1)
                    );
                    const sBySource = await firebase.getDocs(qBySource);
                    if (!sBySource.empty){
                        return String(sBySource.docs[0].id || '').trim();
                    }
                }catch(_){ }
            }
            const url = String(asset.url || '').trim();
            if (!url) return '';
            const q = firebase.query(
                firebase.collection(window.firebaseService.db, 'posts'),
                firebase.where('mediaUrl', '==', url),
                firebase.limit(1)
            );
            const snap = await firebase.getDocs(q);
            if (!snap.empty){
                return String(snap.docs[0].id || '').trim();
            }
            return '';
        }catch(_){ return ''; }
    }

    async ensureAssetDiscussionPost(asset = {}){
        try{
            const existing = await this.resolveAssetPostId(asset);
            if (existing) return existing;
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid) return '';
            const url = String(asset.url || '').trim();
            if (!url) return '';
            const kind = String(asset.kind || this.inferMediaKindFromUrl(url) || 'file');
            const title = String(asset.title || asset.name || 'Media');
            const docRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
            const mediaEntry = (kind === 'image' || kind === 'picture' || kind === 'video')
                ? [{ kind: kind === 'picture' ? 'image' : kind, url, name: title, by: String(asset.by || asset.authorName || ''), cover: String(asset.cover || asset.thumbnailUrl || '') }]
                : [];
            await firebase.setDoc(docRef, {
                id: docRef.id,
                authorId: me.uid,
                authorName: String(me.displayName || me.email || 'User'),
                text: title,
                mediaUrl: url,
                mediaType: kind,
                media: mediaEntry,
                visibility: 'public',
                sourceType: 'waveconnect-asset',
                sourceId: String(asset.sourceId || ''),
                createdAt: new Date().toISOString(),
                createdAtTS: firebase.serverTimestamp()
            }, { merge: true });
            return String(docRef.id || '');
        }catch(_){ return ''; }
    }

    async openAssetCommentsModal(postId, title = 'Comments'){
        try{
            if (!postId) return;
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid){ this.showError('Please sign in'); return; }
            let layer = document.getElementById('asset-comments-layer');
            if (layer) layer.remove();
            layer = document.createElement('div');
            layer.id = 'asset-comments-layer';
            layer.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:22050;display:flex;justify-content:center;align-items:center;padding:14px';
            layer.innerHTML = `<div style="width:min(780px,100%);max-height:85vh;overflow:auto;background:#111722;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
                    <div style="font-weight:600">${String(title || 'Comments').replace(/</g,'&lt;')}</div>
                    <button type="button" class="btn btn-secondary" id="asset-comments-close">Close</button>
                </div>
                <div class="comment-tree" id="asset-comments-tree" style="display:block"></div>
            </div>`;
            document.body.appendChild(layer);
            const close = ()=>{ try{ layer.remove(); }catch(_){ } };
            layer.addEventListener('click', (e)=>{ if (e.target === layer) close(); });
            const closeBtn = layer.querySelector('#asset-comments-close');
            if (closeBtn) closeBtn.addEventListener('click', close);
            const tree = layer.querySelector('#asset-comments-tree');
            if (tree){
                tree.dataset.limit = '10';
                tree.dataset.forceOpen = '1';
                await this.openAdvancedCommentsFallback(postId, tree, me.uid);
            }
        }catch(_){ this.showError('Unable to open comments'); }
    }

    incrementAssetViewCounter(asset = {}){
        try{
            const kind = String(asset.kind || '').toLowerCase();
            if (kind !== 'video' && kind !== 'audio') return;
            const srcId = String(asset.sourceId || asset.id || '').trim();
            if (!srcId) return;
            if (!this._assetViewSession) this._assetViewSession = new Map();
            const key = `${kind}:${srcId}`;
            const now = Date.now();
            const prev = Number(this._assetViewSession.get(key) || 0);
            if (prev && (now - prev) < 20000) return;
            this._assetViewSession.set(key, now);
            if (kind === 'video'){
                try{
                    window.firebaseService?.trackVideoInteraction?.({
                        action: 'open',
                        source: 'app',
                        sourceId: srcId,
                        videoId: srcId
                    });
                }catch(_){ }
                try{
                    const ref = firebase.doc(window.firebaseService.db, 'videos', srcId);
                    firebase.setDoc(ref, { viewCount: firebase.increment(1), updatedAt: new Date().toISOString(), updatedAtTS: firebase.serverTimestamp() }, { merge: true }).catch(()=>{});
                }catch(_){ }
            } else if (kind === 'audio'){
                try{
                    const ref = firebase.doc(window.firebaseService.db, 'wave', srcId);
                    firebase.setDoc(ref, { playCount: firebase.increment(1), updatedAt: new Date().toISOString(), updatedAtTS: firebase.serverTimestamp() }, { merge: true }).catch(()=>{});
                }catch(_){ }
            }
        }catch(_){ }
    }

    async loadWaveConnect(){
        try{
            const me = await window.firebaseService.getCurrentUser();
            await this.syncPostMediaToLibraries(me?.uid, { force: false });
            const lib = document.getElementById('wave-library');
            const res = document.getElementById('wave-results');
            const upBtn = document.getElementById('wave-upload-btn');
            const waveFileInput = document.getElementById('wave-file');
            const waveCoverInput = document.getElementById('wave-cover');
            const waveTitleInput = document.getElementById('wave-title');
            const waveUploadCard = document.getElementById('wave-upload-card');
            if (waveUploadCard && !waveUploadCard._dropBound){
                waveUploadCard._dropBound = true;
                const applyDropFiles = (files)=>{
                    const list = Array.from(files || []).filter((f)=> f instanceof File);
                    if (!list.length) return;
                    const audio = list.find((f)=> String(f.type || '').startsWith('audio/'))
                        || list.find((f)=> /\.(mp3|wav|ogg|m4a|aac|weba|webm)$/i.test(String(f.name || '')));
                    const cover = list.find((f)=> String(f.type || '').startsWith('image/'));
                    if (audio && waveFileInput){
                        try{
                            const dt = new DataTransfer();
                            dt.items.add(audio);
                            waveFileInput.files = dt.files;
                            if (waveTitleInput && !String(waveTitleInput.value || '').trim()){
                                const base = String(audio.name || 'Track').replace(/\.[^/.]+$/, '');
                                waveTitleInput.value = base;
                            }
                        }catch(_){ }
                    }
                    if (cover && waveCoverInput){
                        try{
                            const dt = new DataTransfer();
                            dt.items.add(cover);
                            waveCoverInput.files = dt.files;
                        }catch(_){ }
                    }
                    if (!audio && !cover){
                        this.showError('Drop audio file and optional image cover');
                    }
                };
                ['dragenter','dragover'].forEach((evt)=>{
                    waveUploadCard.addEventListener(evt, (e)=>{
                        e.preventDefault();
                        waveUploadCard.classList.add('dragover');
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                    });
                });
                ['dragleave','dragend'].forEach((evt)=>{
                    waveUploadCard.addEventListener(evt, ()=> waveUploadCard.classList.remove('dragover'));
                });
                waveUploadCard.addEventListener('drop', (e)=>{
                    e.preventDefault();
                    waveUploadCard.classList.remove('dragover');
                    const dt = e.dataTransfer;
                    if (!dt || !dt.files || !dt.files.length) return;
                    applyDropFiles(dt.files);
                });
            }
            if (upBtn && !upBtn._bound){
                upBtn._bound = true;
                upBtn.onclick = async ()=>{
                    try{
                        const file = document.getElementById('wave-file').files[0];
                        const coverFile = document.getElementById('wave-cover')?.files?.[0] || null;
                        if (!file){ return this.showError('Select an audio file'); }
                        // Accept common audio types; cap size to 50 MB
                        const okTypes = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/aac','audio/m4a'];
                        if (!okTypes.includes((file.type||'').toLowerCase())){
                            console.warn('WaveConnect: unexpected type', file.type);
                        }
                        if (file.size > 50*1024*1024){ return this.showError('Max 50 MB'); }
                        const title = (document.getElementById('wave-title').value||file.name).trim();
                        const s = firebase.getStorage();
                        const ref = firebase.ref(s, `wave/${me.uid}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`);
                        const task = firebase.uploadBytesResumable(ref, file, { contentType: (file.type||'audio/mpeg') });
                        await task;
                        const url = await firebase.getDownloadURL(ref);
                        let authorName = (await window.firebaseService.getUserData(me.uid))?.username || me.email || 'Unknown';
                        let coverUrl = (await window.firebaseService.getUserData(me.uid))?.avatarUrl || '';
                        const pendingTags = Array.isArray(this._pendingWaveUploadTags?.audio) ? this._pendingWaveUploadTags.audio : [];
                        const pendingVisibility = String(this._pendingWaveUploadTags?.['audio:visibility'] || 'public') === 'private' ? 'private' : 'public';
                        if (coverFile){
                            // Keep covers under /wave/{uid}/... so existing Storage rules allow owner writes.
                            const cRef = firebase.ref(s, `wave/${me.uid}/covers/${Date.now()}_${coverFile.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`);
                            await firebase.uploadBytes(cRef, coverFile, { contentType: coverFile.type || 'image/jpeg' });
                            coverUrl = await firebase.getDownloadURL(cRef);
                        }
                        const docRef = firebase.doc(firebase.collection(window.firebaseService.db, 'wave'));
                        await firebase.setDoc(docRef, {
                            id: docRef.id,
                            owner: me.uid,
                            ownerId: me.uid,
                            title,
                            url,
                            createdAt: new Date().toISOString(),
                            createdAtTS: firebase.serverTimestamp(),
                            authorId: me.uid,
                            authorName,
                            coverUrl,
                            visibility: pendingVisibility,
                            tagsPrivate: pendingTags
                        });
                        this._pendingWaveUploadTags.audio = [];
                        this._pendingWaveUploadTags['audio:visibility'] = 'public';
                        this.showSuccess('Uploaded');
                        this.renderWaveLibrary(me.uid);
                        this.renderPlaylists();
                    }catch(e){ console.error('Wave upload failed', e); this.showError('Upload failed'); }
                };
            }
            const search = document.getElementById('wave-search');
            const newPlaylistBtn = document.getElementById('wave-new-playlist-btn');
            if (search && !search._bound){
                search._bound = true;
                search.oninput = async (e)=>{
                    const qStr = (e.target.value||'').toLowerCase();
                    if (!res) return;
                    res.innerHTML='';
                    if (!qStr) return;
                    const snap = await firebase.getDocs(firebase.collection(window.firebaseService.db,'wave'));
                    snap.forEach((d)=>{
                        const w = d.data() || {};
                        if (!this.isWaveAudioItem(w)) return;
                        const tags = Array.isArray(w.tagsPrivate) ? w.tagsPrivate.join(' ') : '';
                        if ((w.title || '').toLowerCase().includes(qStr) || String(tags).toLowerCase().includes(qStr)){
                            res.appendChild(this.renderWaveItem(w));
                        }
                    });
                };
            }
            if (newPlaylistBtn && !newPlaylistBtn._bound){
                newPlaylistBtn._bound = true;
                newPlaylistBtn.onclick = async ()=>{
                    await this.createWavePlaylistFromPrompt(me.uid, me.email || '');
                };
            }
            this._waveAudioLibraryOwnerUid = String(me?.uid || '');
            await this.renderWaveLibrary(me.uid);
            this.setupWaveLibraryTabs();
            await this.renderPlaylists();
            await this.renderWaveAudioHome(me.uid);
            this.applyWaveSubtab();
        }catch(_){ }
    }

    async getWaveFollowingUsers(uid){
        const out = [];
        try{
            const q = firebase.query(firebase.collection(window.firebaseService.db, 'connections', uid, 'peers'), firebase.limit(240));
            const s = await firebase.getDocs(q);
            const peerIds = [];
            s.forEach((d)=>{
                const row = d.data() || {};
                if (String(row.status || '').toLowerCase() === 'accepted'){
                    peerIds.push(String(d.id || row.peerId || '').trim());
                }
            });
            for (const pid of peerIds){
                if (!pid) continue;
                try{
                    const u = await window.firebaseService.getUserData(pid);
                    if (!u) continue;
                    out.push({
                        uid: pid,
                        name: String(u.username || u.displayName || u.email || 'User'),
                        avatar: String(u.avatarUrl || 'images/default-bird.png')
                    });
                }catch(_){ }
            }
        }catch(_){ }
        return out;
    }

    async renderWaveAudioHome(uid){
        try{
            const highlights = document.getElementById('wave-audio-highlights');
            const monthHost = document.getElementById('wave-audio-popular-month');
            const followingHost = document.getElementById('wave-audio-following');
            if (!highlights || !monthHost || !followingHost) return;
            const [playlists, followingRows, libraryRows, likedRows] = await Promise.all([
                this.hydratePlaylistsFromCloud().catch(()=> []),
                this.getWaveFollowingUsers(uid).catch(()=> []),
                this.fetchWaveAudioLibraryRows(uid).catch(()=> []),
                this.fetchLikedAudioRows(uid).catch(()=> [])
            ]);
            // Home should be media-first, without metric stat cards.
            highlights.style.display = 'none';
            highlights.innerHTML = '';
            const audioRows = [];
            try{
                const q = firebase.query(firebase.collection(window.firebaseService.db, 'wave'), firebase.limit(320));
                const s = await firebase.getDocs(q);
                s.forEach((d)=> audioRows.push(d.data() || {}));
            }catch(_){ }
            const toPlayableAudioRows = (rows)=> (Array.isArray(rows) ? rows : [])
                .filter((w)=> this.isWaveAudioItem(w))
                .map((w)=> ({
                    ...w,
                    url: String(w?.url || '').trim(),
                    title: String(w?.title || 'Track').trim() || 'Track',
                    authorName: String(w?.authorName || w?.by || '').trim(),
                    coverUrl: String(w?.coverUrl || w?.thumbnailUrl || '').trim()
                }))
                .filter((w)=> !!w.url);
            const monthTop = toPlayableAudioRows(audioRows
                .filter((w)=> this.isWaveAudioItem(w))
                .sort((a,b)=> (Number(b.playCount || 0) || 0) - (Number(a.playCount || 0) || 0))
                .slice(0, 6));
            const followingSet = new Set((followingRows || []).map((u)=> String(u.uid || '').trim()).filter(Boolean));
            const libraryAuthorSet = new Set((libraryRows || []).map((w)=> String(w.authorId || w.owner || '').trim()).filter(Boolean));
            const recommendedTop = toPlayableAudioRows(audioRows
                .filter((w)=> this.isWaveAudioItem(w))
                .map((row)=>{
                    const authorId = String(row.authorId || row.owner || '').trim();
                    let score = Number(row.playCount || 0) * 0.22;
                    if (followingSet.has(authorId)) score += 950;
                    if (libraryAuthorSet.has(authorId)) score += 320;
                    return { row, score };
                })
                .sort((a,b)=> b.score - a.score)
                .map((x)=> x.row)
                .slice(0, 6));
            const fallbackFromLibrary = toPlayableAudioRows((libraryRows || []).slice(0, 6));
            const recRows = recommendedTop.length ? recommendedTop : (monthTop.length ? monthTop : fallbackFromLibrary);
            const recentRows = toPlayableAudioRows((libraryRows || [])
                .slice()
                .sort((a,b)=> {
                    const ta = Number(new Date(a?.updatedAt || a?.createdAt || 0).getTime() || 0);
                    const tb = Number(new Date(b?.updatedAt || b?.createdAt || 0).getTime() || 0);
                    return tb - ta;
                })
                .slice(0, 8));
            const audioPlaylists = (Array.isArray(playlists) ? playlists : [])
                .filter((pl)=> this.normalizePlaylistCategory(pl?.category || pl?.playlistCategory, pl?.items) === 'audio');
            const toTs = (pl)=> Number(new Date(pl?.updatedAt || pl?.createdAt || 0).getTime() || 0);
            const playlistRecent = audioPlaylists
                .slice()
                .sort((a,b)=> toTs(b) - toTs(a))
                .slice(0, 8);
            const playlistFeatured = audioPlaylists
                .slice()
                .sort((a,b)=>{
                    const score = (pl)=>{
                        const items = Array.isArray(pl?.items) ? pl.items : [];
                        const count = items.length;
                        const visBoost = String(pl?.visibility || 'private') === 'public' ? 120 : 0;
                        const recency = Math.max(0, toTs(pl));
                        return visBoost + Math.min(60, count * 4) + (recency / 10000000000000);
                    };
                    return score(b) - score(a);
                })
                .slice(0, 8);
            const prefAudioUrls = new Set(
                []
                    .concat(Array.isArray(libraryRows) ? libraryRows : [], Array.isArray(likedRows) ? likedRows : [])
                    .map((x)=> this.normalizeMediaUrl(String(x?.url || x?.src || '')))
                    .filter(Boolean)
            );
            const playlistRecommended = audioPlaylists
                .slice()
                .map((pl)=>{
                    const items = Array.isArray(pl?.items) ? pl.items : [];
                    let overlap = 0;
                    items.forEach((it)=>{
                        const u = this.normalizeMediaUrl(String(it?.src || it?.url || ''));
                        if (u && prefAudioUrls.has(u)) overlap += 1;
                    });
                    const countBoost = Math.min(40, items.length * 2);
                    const recencyBoost = toTs(pl) / 10000000000000;
                    const score = overlap * 160 + countBoost + recencyBoost;
                    return { pl, score };
                })
                .sort((a,b)=> b.score - a.score)
                .map((x)=> x.pl)
                .slice(0, 8);
            const openPlaylistsLibrary = async (playlistId = '')=>{
                const pid = String(playlistId || '').trim();
                if (!pid) return;
                await this.openWavePlaylistModal(pid, { source: 'home' });
            };
            const appendRichRow = (host, rows)=>{
                if (!host) return;
                host.innerHTML = '';
                if (!rows.length){
                    host.innerHTML = '<div style="opacity:.75">No tracks yet.</div>';
                    return;
                }
                rows.forEach((row, idx)=>{
                    const item = this.renderWaveItem({
                        ...row,
                        coverUrl: String(row.coverUrl || row.thumbnailUrl || '').trim() || 'images/default-bird.png',
                        authorName: String(row.authorName || row.by || '').trim()
                    }, {
                        queueRows: rows,
                        queueIndex: idx
                    });
                    item.classList.add('wave-home-audio-rich-card');
                    host.appendChild(item);
                });
            };
            monthHost.innerHTML = `
              <div class="wave-home-section">
                <h4 style="margin:0 0 8px">Recently Played</h4>
                <div id="wave-home-recent-row" class="wave-home-row"></div>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Recommended For You</h4>
                <div id="wave-home-recommended-row" class="wave-home-row"></div>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Recent Playlists</h4>
                <div id="wave-home-playlist-recent-row" class="wave-home-row"></div>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Featured Playlists</h4>
                <div id="wave-home-playlist-featured-row" class="wave-home-row"></div>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Recommended Playlists</h4>
                <div id="wave-home-playlist-recommended-row" class="wave-home-row"></div>
              </div>
            `;
            appendRichRow(document.getElementById('wave-home-recent-row'), recentRows);
            appendRichRow(document.getElementById('wave-home-recommended-row'), recRows);
            const renderPlaylistRow = (host, rows)=>{
                if (!host) return;
                host.innerHTML = '';
                if (!rows.length){
                    host.innerHTML = '<div style="opacity:.75">No playlists yet.</div>';
                    return;
                }
                rows.forEach((pl)=>{
                    const name = String(pl?.name || 'Playlist').replace(/</g,'&lt;');
                    const items = Array.isArray(pl?.items) ? pl.items : [];
                    const cover = String(items[0]?.cover || items[0]?.coverUrl || 'images/default-bird.png').replace(/"/g,'&quot;');
                    const count = items.length;
                    const card = document.createElement('button');
                    card.type = 'button';
                    card.className = 'wave-home-playlist-card';
                    card.setAttribute('data-open-playlist-home', '1');
                    card.setAttribute('data-playlist-id', String(pl?.id || ''));
                    card.innerHTML = `<img src="${cover}" alt="playlist cover"><span class="wave-home-playlist-overlay"><span class="wave-home-playlist-title">${name}</span><span class="wave-home-playlist-meta">${count} tracks</span></span>`;
                    host.appendChild(card);
                });
            };
            renderPlaylistRow(document.getElementById('wave-home-playlist-recent-row'), playlistRecent);
            renderPlaylistRow(document.getElementById('wave-home-playlist-featured-row'), playlistFeatured);
            renderPlaylistRow(document.getElementById('wave-home-playlist-recommended-row'), playlistRecommended);
            monthHost.querySelectorAll('[data-open-playlist-home]').forEach((btn)=>{
                btn.addEventListener('click', async ()=>{
                    await openPlaylistsLibrary(String(btn.getAttribute('data-playlist-id') || ''));
                });
            });
            const prefRaw = localStorage.getItem(`liber_wave_follow_notify_${uid}`) || '{}';
            let pref = {};
            try{ pref = JSON.parse(prefRaw) || {}; }catch(_){ pref = {}; }
            followingHost.innerHTML = `<h4 style="margin:0 0 8px">Following</h4>${followingRows.map((u)=> `<div class="wave-following-row"><div class="wave-following-meta"><img src="${String(u.avatar || 'images/default-bird.png').replace(/"/g,'&quot;')}" alt=""><span class="wave-following-name">${String(u.name || 'User').replace(/</g,'&lt;')}</span></div><button type="button" class="btn btn-secondary" data-follow-bell="${String(u.uid).replace(/"/g,'&quot;')}"><i class="fas ${pref[u.uid] === false ? 'fa-bell-slash' : 'fa-bell'}"></i></button></div>`).join('') || '<div style="opacity:.75">No followed accounts.</div>'}`;
            followingHost.querySelectorAll('[data-follow-bell]').forEach((btn)=>{
                btn.addEventListener('click', ()=>{
                    const id = String(btn.getAttribute('data-follow-bell') || '');
                    pref[id] = pref[id] === false ? true : false;
                    const icon = btn.querySelector('i');
                    if (icon) icon.className = `fas ${pref[id] === false ? 'fa-bell-slash' : 'fa-bell'}`;
                    try{ localStorage.setItem(`liber_wave_follow_notify_${uid}`, JSON.stringify(pref)); }catch(_){ }
                });
            });
        }catch(_){ }
    }

    setupWaveLibraryTabs(){
        const tabAll = document.getElementById('wave-lib-tab-all');
        const tabUploaded = document.getElementById('wave-lib-tab-uploaded');
        const tabSaved = document.getElementById('wave-lib-tab-saved');
        const tabLiked = document.getElementById('wave-lib-tab-liked');
        const tabPlaylists = document.getElementById('wave-lib-tab-playlists');
        const paneAll = document.getElementById('wave-library-pane');
        const paneUploaded = document.getElementById('wave-library-uploaded-pane');
        const paneSaved = document.getElementById('wave-library-saved-pane');
        const paneLiked = document.getElementById('wave-library-liked-pane');
        const panePlaylists = document.getElementById('wave-library-playlists-pane');
        if (!tabAll || !tabUploaded || !tabSaved || !tabLiked || !tabPlaylists || !paneAll || !paneUploaded || !paneSaved || !paneLiked || !panePlaylists || tabAll._boundTabs) return;
        tabAll._boundTabs = true;
        const open = async (name)=>{
            tabAll.classList.toggle('active', name === 'all');
            tabUploaded.classList.toggle('active', name === 'uploaded');
            tabSaved.classList.toggle('active', name === 'saved');
            tabLiked.classList.toggle('active', name === 'liked');
            tabPlaylists.classList.toggle('active', name === 'playlists');
            paneAll.style.display = name === 'all' ? 'block' : 'none';
            paneUploaded.style.display = name === 'uploaded' ? 'block' : 'none';
            paneSaved.style.display = name === 'saved' ? 'block' : 'none';
            paneLiked.style.display = name === 'liked' ? 'block' : 'none';
            panePlaylists.style.display = name === 'playlists' ? 'block' : 'none';
            const uid = String(this._waveAudioLibraryOwnerUid || '').trim();
            if (!uid) return;
            try{ localStorage.setItem(`liber_wave_audio_lib_tab_${uid}`, name); }catch(_){ }
            if (name === 'playlists'){
                await this.renderPlaylists();
            } else {
                await this.renderWaveLibraryCategory(uid, name);
            }
        };
        tabAll.onclick = ()=> open('all');
        tabUploaded.onclick = ()=> open('uploaded');
        tabSaved.onclick = ()=> open('saved');
        tabLiked.onclick = ()=> open('liked');
        tabPlaylists.onclick = ()=> open('playlists');
        const uid = String(this._waveAudioLibraryOwnerUid || '').trim();
        let remembered = 'all';
        try{
            if (uid){
                const raw = String(localStorage.getItem(`liber_wave_audio_lib_tab_${uid}`) || '').trim().toLowerCase();
                if (raw === 'all' || raw === 'uploaded' || raw === 'saved' || raw === 'liked' || raw === 'playlists') remembered = raw;
            }
        }catch(_){ }
        open(remembered);
    }

    async createWavePlaylistFromPrompt(ownerUid = '', ownerName = ''){
        const uid = String(ownerUid || this._waveAudioLibraryOwnerUid || this.currentUser?.uid || window.firebaseService?.auth?.currentUser?.uid || '').trim();
        if (!uid) return false;
        const name = String(prompt('Playlist name:') || '').trim();
        if (!name) return false;
        const makePublic = confirm('Make this playlist public?');
        const playlists = await this.hydratePlaylistsFromCloud();
        playlists.push({
            id: `pl_${Date.now()}`,
            name,
            visibility: makePublic ? 'public' : 'private',
            owner: uid,
            ownerId: uid,
            ownerName: ownerName || this.currentUser?.email || '',
            category: 'audio',
            items: []
        });
        this.savePlaylists(playlists);
        await this.syncPlaylistsToCloud(playlists);
        await this.renderPlaylists();
        return true;
    }

    setupFeedTabs(){
        const latestBtn = document.getElementById('feed-tab-latest');
        const suggBtn = document.getElementById('feed-tab-suggestions');
        const latestPane = document.getElementById('feed-latest-pane');
        const suggPane = document.getElementById('feed-suggestions-pane');
        const wallSearch = document.getElementById('wall-search');
        if (!latestBtn || !suggBtn || !latestPane || !suggPane || latestBtn._boundTabs) return;
        latestBtn._boundTabs = true;
        const open = (name)=>{
            const showLatest = name === 'latest';
            latestBtn.classList.toggle('active', showLatest);
            suggBtn.classList.toggle('active', !showLatest);
            latestPane.style.display = showLatest ? 'block' : 'none';
            suggPane.style.display = showLatest ? 'none' : 'block';
        };
        latestBtn.onclick = ()=> open('latest');
        suggBtn.onclick = ()=> open('suggestions');
        if (wallSearch && !wallSearch._bound){
            wallSearch._bound = true;
            wallSearch.setAttribute('autocomplete', 'new-password');
            wallSearch.setAttribute('autocorrect', 'off');
            wallSearch.setAttribute('autocapitalize', 'off');
            wallSearch.setAttribute('spellcheck', 'false');
            wallSearch.setAttribute('name', `wall-search-${Date.now()}`);
            // Strong anti-autofill guard: keep readonly until user intent.
            wallSearch.setAttribute('readonly', 'readonly');
            wallSearch.dataset.userTyped = '0';
            const unlock = ()=>{
                try{ wallSearch.removeAttribute('readonly'); }catch(_){ }
            };
            wallSearch.addEventListener('pointerdown', unlock, { passive: true });
            wallSearch.addEventListener('touchstart', unlock, { passive: true });
            wallSearch.addEventListener('focus', ()=>{
                unlock();
                const v = String(wallSearch.value || '').trim();
                if (wallSearch.dataset.userTyped !== '1' && (/@/.test(v) || v.length > 48)) wallSearch.value = '';
            });
            wallSearch.addEventListener('blur', ()=> wallSearch.setAttribute('readonly', 'readonly'));
            wallSearch.addEventListener('input', ()=>{
                wallSearch.dataset.userTyped = '1';
                const term = String(wallSearch.value || '').trim();
                this._wallSearchTerm = term;
                this.loadGlobalFeed(term);
            });
            // Clear late browser-restored autofill values.
            setTimeout(()=>{
                const v = String(wallSearch.value || '').trim();
                if (wallSearch.dataset.userTyped !== '1' && (/@/.test(v) || v.length > 48)) wallSearch.value = '';
            }, 80);
            setTimeout(()=>{
                const v = String(wallSearch.value || '').trim();
                if (wallSearch.dataset.userTyped !== '1' && (/@/.test(v) || v.length > 48)) wallSearch.value = '';
            }, 600);
        }
        open('latest');
    }

    setupVideoHostTabs(){
        const tabLibrary = document.getElementById('video-tab-library');
        const tabSuggestions = document.getElementById('video-tab-suggestions');
        const tabSearch = document.getElementById('video-tab-search');
        const paneLibrary = document.getElementById('video-library-pane');
        const paneSuggestions = document.getElementById('video-suggestions-pane');
        const paneSearch = document.getElementById('video-search-pane');
        if (!tabLibrary || !tabSuggestions || !tabSearch || !paneLibrary || !paneSuggestions || !paneSearch || tabLibrary._boundTabs) return;
        tabLibrary._boundTabs = true;
        const open = (name)=>{
            tabLibrary.classList.toggle('active', name === 'library');
            tabSuggestions.classList.toggle('active', name === 'suggestions');
            tabSearch.classList.toggle('active', name === 'search');
            paneLibrary.style.display = name === 'library' ? 'block' : 'none';
            paneSuggestions.style.display = name === 'suggestions' ? 'block' : 'none';
            paneSearch.style.display = name === 'search' ? 'block' : 'none';
        };
        tabLibrary.onclick = ()=> open('library');
        tabSuggestions.onclick = ()=> open('suggestions');
        tabSearch.onclick = ()=> open('search');
        open('library');
    }

    setupPictureHostTabs(){
        const tabLibrary = document.getElementById('picture-tab-library');
        const tabSuggestions = document.getElementById('picture-tab-suggestions');
        const tabSearch = document.getElementById('picture-tab-search');
        const paneLibrary = document.getElementById('picture-library-pane');
        const paneSuggestions = document.getElementById('picture-suggestions-pane');
        const paneSearch = document.getElementById('picture-search-pane');
        if (!tabLibrary || !tabSuggestions || !tabSearch || !paneLibrary || !paneSuggestions || !paneSearch || tabLibrary._boundTabs) return;
        tabLibrary._boundTabs = true;
        const open = (name)=>{
            tabLibrary.classList.toggle('active', name === 'library');
            tabSuggestions.classList.toggle('active', name === 'suggestions');
            tabSearch.classList.toggle('active', name === 'search');
            paneLibrary.style.display = name === 'library' ? 'block' : 'none';
            paneSuggestions.style.display = name === 'suggestions' ? 'block' : 'none';
            paneSearch.style.display = name === 'search' ? 'block' : 'none';
        };
        tabLibrary.onclick = ()=> open('library');
        tabSuggestions.onclick = ()=> open('suggestions');
        tabSearch.onclick = ()=> open('search');
        open('library');
    }

    async saveVisualToLibrary(media, targetBucket = 'videos'){
        try{
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid || !media || !media.url) return false;
            const rawKind = String(media.kind || '').toLowerCase();
            const inferredKind = ['image','video'].includes(rawKind) ? rawKind : this.inferMediaKindFromUrl(String(media.url || ''));
            if (!['image','video'].includes(inferredKind)){
                this.showError('Only picture or video can be added here');
                return false;
            }
            const asPicture = inferredKind === 'image';
            const title = String(media.title || media.name || (asPicture ? 'Picture' : 'Video')).trim() || (asPicture ? 'Picture' : 'Video');
            const ownerName = (await window.firebaseService.getUserData(me.uid))?.username || me.email || 'Unknown';
            const originalAuthorId = String(media.originalAuthorId || media.authorId || '').trim() || null;
            const originalAuthorName = String(media.originalAuthorName || media.authorName || media.by || '').trim() || null;
            const sourceMediaType = inferredKind;
            const href = String(media.url || '').trim();
            const hrefNorm = this.normalizeMediaUrl(href);
            let targetId = '';
            try{
                const q = firebase.query(
                    firebase.collection(window.firebaseService.db, 'videos'),
                    firebase.where('owner', '==', me.uid),
                    firebase.limit(1200)
                );
                const s = await firebase.getDocs(q);
                for (const d of (s.docs || [])){
                    const row = d.data() || {};
                    const kind = this.resolveVisualKind(row);
                    if (kind !== inferredKind) continue;
                    const rowUrl = String(row.url || '').trim();
                    if (!rowUrl) continue;
                    if (this.urlsLikelySame(this.normalizeMediaUrl(rowUrl), hrefNorm)){
                        targetId = String(d.id || '').trim();
                        break;
                    }
                }
            }catch(_){ }
            if (!targetId){
                targetId = String(media.id || '').trim() || firebase.doc(firebase.collection(window.firebaseService.db, 'videos')).id;
            }
            const docRef = firebase.doc(window.firebaseService.db, 'videos', targetId);
            await firebase.setDoc(docRef, {
                id: targetId,
                owner: me.uid,
                ownerId: me.uid,
                title,
                url: href,
                createdAt: new Date().toISOString(),
                createdAtTS: firebase.serverTimestamp(),
                visibility: 'public',
                mediaType: asPicture ? 'image' : 'video',
                sourceMediaType,
                authorId: me.uid,
                authorName: ownerName,
                thumbnailUrl: String(media.cover || media.thumbnailUrl || ''),
                originalAuthorId,
                originalAuthorName
            }, { merge: true });
            try{
                const qDup = firebase.query(
                    firebase.collection(window.firebaseService.db, 'videos'),
                    firebase.where('owner', '==', me.uid),
                    firebase.limit(1200)
                );
                const sDup = await firebase.getDocs(qDup);
                for (const d of (sDup.docs || [])){
                    if (String(d.id || '').trim() === targetId) continue;
                    const row = d.data() || {};
                    const kind = this.resolveVisualKind(row);
                    if (kind !== inferredKind) continue;
                    const rowUrlNorm = this.normalizeMediaUrl(String(row.url || '').trim());
                    if (!rowUrlNorm || !this.urlsLikelySame(rowUrlNorm, hrefNorm)) continue;
                    try{ await firebase.deleteDoc(firebase.doc(window.firebaseService.db, 'videos', d.id)); }catch(_){ }
                }
            }catch(_){ }
            this.showSuccess(asPicture ? 'Added to My Pictures' : 'Added to My Videos');
            this.refreshVisualSaveButtonsState().catch(()=>{});
            if (asPicture) this.loadPictureHost(); else this.loadVideoHost();
            return true;
        }catch(_){ this.showError('Failed to add to library'); return false; }
    }

    async removeVisualFromLibrary(kind, url, ownerUid = ''){
        try{
            const me = await this.resolveCurrentUser();
            const uid = String(ownerUid || me?.uid || '').trim();
            const href = String(url || '').trim();
            const hrefNorm = this.normalizeMediaUrl(href);
            const targetKind = String(kind || '').toLowerCase() === 'image' ? 'image' : 'video';
            if (!uid || !href) return false;
            let rows = [];
            try{
                const q = firebase.query(
                    firebase.collection(window.firebaseService.db, 'videos'),
                    firebase.where('owner', '==', uid),
                    firebase.where('url', '==', href),
                    firebase.limit(50)
                );
                const s = await firebase.getDocs(q);
                s.forEach((d)=> rows.push({ id: d.id, ...(d.data() || {}) }));
            }catch(_){ }
            if (!rows.length){
                const q2 = firebase.query(firebase.collection(window.firebaseService.db, 'videos'), firebase.where('owner', '==', uid));
                const s2 = await firebase.getDocs(q2);
                s2.forEach((d)=>{
                    const v = d.data() || {};
                    if (this.urlsLikelySame(this.normalizeMediaUrl(String(v.url || '').trim()), hrefNorm)) rows.push({ id: d.id, ...v });
                });
            }
            let removed = 0;
            for (const v of rows){
                const rk = this.resolveVisualKind(v);
                if (rk !== targetKind) continue;
                try{
                    await firebase.deleteDoc(firebase.doc(window.firebaseService.db, 'videos', String(v.id || '').trim()));
                    removed += 1;
                }catch(_){ }
            }
            if (removed > 0) this.refreshVisualSaveButtonsState().catch(()=>{});
            return removed > 0;
        }catch(_){ return false; }
    }

    async refreshVisualSaveButtonsState(root = document){
        try{
            const host = root || document;
            const buttons = Array.from(host.querySelectorAll('.post-save-visual-btn'));
            if (!buttons.length) return;
            const me = await this.resolveCurrentUser();
            if (!me || !me.uid) return;
            const idx = await this.getMyVisualLibraryIndex(me.uid);
            buttons.forEach((btn)=>{
                const target = String(btn.dataset.saveTarget || 'videos');
                const url = String(btn.dataset.url || '').trim();
                if (!url) return;
                const set = target === 'pictures' ? idx.pictures : idx.videos;
                const saved = !!set && set.has(url);
                if (saved){
                    btn.dataset.saved = '1';
                    btn.innerHTML = `<i class="fas fa-check"></i>`;
                    btn.title = 'Saved - click to remove';
                } else {
                    btn.dataset.saved = '0';
                    btn.innerHTML = `<i class="fas fa-plus"></i>`;
                    btn.title = target === 'pictures' ? 'To My Pictures' : 'To My Videos';
                }
            });
        }catch(_){ }
    }

    resolveVisualKind(item){
        const src = String(item?.sourceMediaType || '').toLowerCase().trim();
        if (src === 'image' || src === 'video') return src;
        const mt = String(item?.mediaType || '').toLowerCase().trim();
        if (mt === 'image' || mt === 'video') return mt;
        const urlKind = this.inferMediaKindFromUrl(String(item?.url || ''));
        return urlKind === 'image' ? 'image' : 'video';
    }

    isWaveAudioItem(item){
        try{
            const mt = String(item?.mediaType || '').toLowerCase().trim();
            const src = String(item?.sourceMediaType || '').toLowerCase().trim();
            if (mt && mt !== 'audio') return false;
            if (src && src !== 'audio') return false;
            const kindByUrl = this.inferMediaKindFromUrl(String(item?.url || ''));
            if (kindByUrl === 'image' || kindByUrl === 'video') return false;
            return true;
        }catch(_){ return true; }
    }

    async renderWaveLibrary(uid){
        const activeTab = document.querySelector('#wave-lib-tab-all.active,#wave-lib-tab-uploaded.active,#wave-lib-tab-saved.active,#wave-lib-tab-liked.active,#wave-lib-tab-playlists.active');
        const id = String(activeTab?.id || 'wave-lib-tab-all');
        const map = {
            'wave-lib-tab-all': 'all',
            'wave-lib-tab-uploaded': 'uploaded',
            'wave-lib-tab-saved': 'saved',
            'wave-lib-tab-liked': 'liked',
            'wave-lib-tab-playlists': 'playlists'
        };
        const next = map[id] || 'all';
        if (next === 'playlists'){
            await this.renderPlaylists();
            return;
        }
        await this.renderWaveLibraryCategory(uid, next);
    }

    async fetchWaveAudioLibraryRows(uid){
        const items = [];
        try{
            const q = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', uid), firebase.orderBy('createdAt','desc'), firebase.limit(120));
            const snap = await firebase.getDocs(q);
            snap.forEach((d)=> items.push(d.data() || {}));
        }catch(_){
            try{
                const q2 = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', uid));
                const s2 = await firebase.getDocs(q2);
                s2.forEach((d)=> items.push(d.data() || {}));
            }catch(__){ }
        }
        const rows = items.filter((w)=> this.isWaveAudioItem(w));
        rows.forEach((w)=>{
            const key = String(w?.url || '').trim();
            if (!key) return;
            this._waveMetaByUrl.set(key, {
                title: String(w?.title || '').trim(),
                coverUrl: String(w?.coverUrl || '').trim(),
                authorName: String(w?.authorName || '').trim()
            });
        });
        return rows;
    }

    buildAudioQueueFromRows(rows = []){
        return (Array.isArray(rows) ? rows : [])
            .filter((w)=> String(w?.url || '').trim())
            .map((w)=> ({
                src: String(w.url || ''),
                title: String(w.title || 'Track'),
                by: String(w.authorName || ''),
                cover: String(w.coverUrl || '')
            }));
    }

    async fetchLikedAudioRows(uid){
        const out = [];
        try{
            const snap = await firebase.getDocs(firebase.query(firebase.collection(window.firebaseService.db, 'posts'), firebase.limit(180)));
            const candidates = [];
            snap.forEach((d)=>{
                const p = d.data() || {};
                const mediaType = String(p.mediaType || '').toLowerCase();
                const media = Array.isArray(p.media) ? p.media : [];
                const firstAudio = media.find((m)=> String(m?.kind || '').toLowerCase() === 'audio' && String(m?.url || '').trim());
                const url = firstAudio ? String(firstAudio.url || '').trim() : (mediaType === 'audio' ? String(p.mediaUrl || '').trim() : '');
                if (!url) return;
                candidates.push({
                    postId: d.id,
                    url,
                    title: String(firstAudio?.title || firstAudio?.name || p.text || 'Audio').trim() || 'Audio',
                    by: String(firstAudio?.by || p.authorName || '').trim(),
                    cover: String(firstAudio?.cover || p.coverUrl || '').trim()
                });
            });
            const checks = await Promise.all(candidates.map(async (c)=>{
                try{
                    const likeRef = firebase.doc(window.firebaseService.db, 'posts', c.postId, 'likes', uid);
                    const likeSnap = await firebase.getDoc(likeRef);
                    return likeSnap.exists() ? c : null;
                }catch(_){ return null; }
            }));
            const dedupe = new Set();
            checks.filter(Boolean).forEach((c)=>{
                const key = `${c.postId}::${c.url}`;
                if (dedupe.has(key)) return;
                dedupe.add(key);
                out.push({
                    id: `liked_${c.postId}_${dedupe.size}`,
                    title: c.title,
                    url: c.url,
                    authorName: c.by,
                    coverUrl: c.cover,
                    sourcePostId: c.postId,
                    mediaType: 'audio',
                    sourceMediaType: 'audio',
                    ownerId: uid
                });
            });
        }catch(_){ }
        return out;
    }

    async renderWaveLibraryCategory(uid, category = 'all'){
        const allHost = document.getElementById('wave-library');
        const uploadedHost = document.getElementById('wave-library-uploaded');
        const savedHost = document.getElementById('wave-library-saved');
        const likedHost = document.getElementById('wave-library-liked');
        if (!uid) return;
        const rows = await this.fetchWaveAudioLibraryRows(uid);
        const uploaded = rows.filter((w)=> !this.isPostLibraryItem(w));
        const saved = rows.filter((w)=> this.isPostLibraryItem(w));
        const all = uploaded.concat(saved);
        const renderList = (host, list, emptyText, listName)=>{
            if (!host) return;
            host.innerHTML = '';
            if (!list.length){
                host.innerHTML = `<div style="opacity:.75;padding:8px">${emptyText}</div>`;
                return;
            }
            const controls = document.createElement('div');
            controls.className = 'wave-lib-list-controls';
            controls.innerHTML = `<button type="button" class="btn btn-secondary wave-lib-play-all" title="Play all" aria-label="Play all"><i class="fas fa-play"></i></button><button type="button" class="btn btn-secondary wave-lib-shuffle" title="Shuffle" aria-label="Shuffle"><i class="fas fa-shuffle"></i></button>`;
            const playAllBtn = controls.querySelector('.wave-lib-play-all');
            const shuffleBtn = controls.querySelector('.wave-lib-shuffle');
            if (playAllBtn){
                playAllBtn.onclick = ()=>{
                    const queue = this.buildAudioQueueFromRows(list);
                    if (!queue.length) return;
                    this._playQueue = queue;
                    this.playQueueIndex(0, { restart: true });
                };
            }
            if (shuffleBtn){
                shuffleBtn.onclick = ()=>{
                    const queue = this.buildAudioQueueFromRows(list);
                    if (!queue.length) return;
                    const shuffled = queue.slice();
                    for (let i = shuffled.length - 1; i > 0; i--){
                        const j = Math.floor(Math.random() * (i + 1));
                        const tmp = shuffled[i];
                        shuffled[i] = shuffled[j];
                        shuffled[j] = tmp;
                    }
                    this._playQueue = shuffled;
                    this.playQueueIndex(0, { restart: true });
                };
            }
            host.appendChild(controls);
            list.forEach((w, idx)=>{
                host.appendChild(this.renderWaveItem(w, {
                    allowRemove: true,
                    queueRows: list,
                    queueIndex: idx,
                    onRemoved: ()=> this.renderWaveLibraryCategory(uid, listName)
                }));
            });
        };
        if (category === 'all' || !category) renderList(allHost, all, 'No audio in your library yet.', 'all');
        if (category === 'uploaded') renderList(uploadedHost, uploaded, 'No uploaded audio yet.', 'uploaded');
        if (category === 'saved') renderList(savedHost, saved, 'No saved audio yet.', 'saved');
        if (category === 'liked'){
            if (likedHost) likedHost.innerHTML = '<div style="opacity:.75;padding:8px">Loading liked audio...</div>';
            const likedRows = await this.fetchLikedAudioRows(uid);
            renderList(likedHost, likedRows, 'No liked audio yet.', 'liked');
        }
    }

    async renderWavePostsLibrary(uid){
        const host = document.getElementById('wave-library-posts'); if (!host) return;
        host.innerHTML = '';
        const all = [];
        try{
            const qWave = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', uid), firebase.limit(200));
            const sWave = await firebase.getDocs(qWave);
            sWave.forEach((d)=>{
                const w = d.data() || {};
                if (!this.isPostLibraryItem(w)) return;
                if (!this.isWaveAudioItem(w)) return;
                all.push({ kind: 'audio', item: w, ts: Number(w?.createdAtTS?.toMillis?.() || 0) || Number(new Date(w?.createdAt || 0).getTime() || 0) || 0 });
            });
        }catch(_){ }
        all.sort((a,b)=> b.ts - a.ts);
        if (!all.length){
            const empty = document.createElement('div');
            empty.style.cssText = 'opacity:.75;padding:8px';
            empty.textContent = 'No audio saved from posts yet.';
            host.appendChild(empty);
            return;
        }
        const visible = Math.max(8, Number(this._waveLibraryVisible || 8));
        all.slice(0, visible).forEach((entry)=>{
            host.appendChild(this.renderWaveItem(entry.item, {
                allowRemove: true,
                onRemoved: ()=> this.renderWavePostsLibrary(uid)
            }));
        });
        if (all.length > visible){
            const more = document.createElement('button');
            more.className = 'btn btn-secondary';
            more.textContent = 'Show 5 more';
            more.onclick = ()=>{
                this._waveLibraryVisible = visible + 5;
                this.renderWavePostsLibrary(uid);
            };
            host.appendChild(more);
        }
    }

    renderWaveItem(w, opts = {}){
        const div = document.createElement('div');
        div.className = 'wave-item';
        div.style.cssText = 'border:1px solid var(--border-color);border-radius:10px;padding:10px;margin:8px 0;display:flex;flex-direction:column;gap:10px;align-items:stretch;justify-content:flex-start';
        div.dataset.assetKind = 'audio';
        if (w?.id) div.dataset.assetId = String(w.id);
        if (w?.url) div.dataset.assetUrl = this.normalizeMediaUrl(String(w.url));
        const cover = w.coverUrl || 'images/default-bird.png';
        const allowRemove = !!opts.allowRemove;
        const byline = w.authorName
          ? `<button type="button" class="audio-byline" data-user-preview="${String(w.authorId || '').replace(/"/g,'&quot;')}" style="font-size:12px;color:#aaa;background:none;border:none;padding:0;text-align:left;cursor:pointer">by ${(w.authorName||'').replace(/</g,'&lt;')}</button>`
          : '';
        const iconBtn = 'background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.92;color:#d6deeb';
        const editBtnHtml = `<button class="edit-wave-btn" style="${iconBtn}" title="Edit track"><i class="fas fa-pen"></i></button>`;
        const removeBtnHtml = allowRemove ? `<button class="remove-btn" style="${iconBtn}" title="Remove from my library"><i class="fas fa-trash"></i></button>` : '';
        div.innerHTML = `<div class="wave-item-head" style="display:flex;gap:12px;align-items:center"><img src="${cover}" alt="cover" class="wave-item-cover" style="width:72px;height:72px;border-radius:12px;object-fit:cover"><div style="min-width:0;flex:1"><div class="audio-title">${(w.title||'Untitled').replace(/</g,'&lt;')}</div>${byline}</div></div><audio class="liber-lib-audio" src="${w.url}" style="display:none" data-title="${(w.title||'').replace(/"/g,'&quot;')}" data-by="${(w.authorName||'').replace(/"/g,'&quot;')}" data-cover="${(w.coverUrl||'').replace(/"/g,'&quot;')}"></audio><div class="wave-item-audio-host"></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="asset-like-btn" style="${iconBtn}" title="Like"><i class="fas fa-heart"></i></button><span class="asset-like-count" style="min-width:18px;opacity:.88">0</span><button class="asset-comment-btn" style="${iconBtn}" title="Comments"><i class="fas fa-comment-dots"></i></button><span class="asset-comments-count" style="min-width:18px;opacity:.88">0</span><span style="opacity:.64;font-size:11px"><i class="fas fa-headphones"></i></span><span class="asset-views-count" style="min-width:18px;opacity:.88">${Number(w.playCount || 0) || 0}</span><button class="asset-share-chat-btn" style="${iconBtn}" title="Share to chat"><i class="fas fa-paper-plane"></i></button><button class="audio-download-btn" style="${iconBtn};border:1px solid rgba(255,255,255,.2);border-radius:999px" title="Download audio"><i class="fas fa-download"></i></button><button class="share-btn" style="${iconBtn}" title="Share"><i class="fas fa-share"></i></button><button class="repost-btn" style="${iconBtn}" title="Repost"><i class="fas fa-retweet"></i></button>${editBtnHtml}${removeBtnHtml}</div>`;
        div.querySelector('.share-btn').onclick = async ()=>{
            try{
                const me = await window.firebaseService.getCurrentUser();
                const newRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
                await firebase.setDoc(newRef, { id: newRef.id, authorId: me.uid, text: (w.title||'Audio'), mediaUrl: w.url, mediaType:'audio', visibility:'private', createdAt: new Date().toISOString(), createdAtTS: firebase.serverTimestamp(), authorName: (w.authorName||''), coverUrl: (w.coverUrl||'') });
                this.showSuccess('Shared to your feed (private)');
            }catch(_){ this.showError('Share failed'); }
        };
        const repostBtn = div.querySelector('.repost-btn');
        if (repostBtn){ repostBtn.onclick = async ()=>{
            try{
                const me = await window.firebaseService.getCurrentUser();
                const newRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
                await firebase.setDoc(newRef, { id: newRef.id, authorId: me.uid, text: (w.title||'Audio'), mediaUrl: w.url, mediaType:'audio', visibility:'public', createdAt: new Date().toISOString(), createdAtTS: firebase.serverTimestamp(), authorName: (w.authorName||''), coverUrl: (w.coverUrl||'') });
                this.showSuccess('Reposted to your feed');
            }catch(_){ this.showError('Repost failed'); }
        }; }
        const removeBtn = div.querySelector('.remove-btn');
        if (removeBtn){
            removeBtn.onclick = async ()=>{
                try{
                    if (!confirm('Remove this track from My Library?')) return;
                    const id = String(w.id || '').trim();
                    if (id){
                        await firebase.deleteDoc(firebase.doc(window.firebaseService.db, 'wave', id));
                    } else {
                        const me = await this.resolveCurrentUser();
                        if (!me || !me.uid) return;
                        const q = firebase.query(
                            firebase.collection(window.firebaseService.db, 'wave'),
                            firebase.where('ownerId', '==', me.uid),
                            firebase.where('url', '==', String(w.url || ''))
                        );
                        const s = await firebase.getDocs(q);
                        for (const d of (s.docs || [])){
                            await firebase.deleteDoc(firebase.doc(window.firebaseService.db, 'wave', d.id));
                        }
                    }
                    if (typeof opts.onRemoved === 'function') opts.onRemoved();
                    this.showSuccess('Removed from library');
                }catch(_){ this.showError('Failed to remove'); }
            };
        }
        const dlBtn = div.querySelector('.audio-download-btn');
        if (dlBtn){
            dlBtn.onclick = async (e)=>{
                try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
                await this.downloadAudioAsset(String(w.url || ''), String(w.title || 'audio'));
            };
        }
        const a = div.querySelector('.liber-lib-audio');
        if (a){
            const host = div.querySelector('.wave-item-audio-host') || div;
            this.attachWaveAudioUI(a, host, { hideNative: true });
            a.addEventListener('play', ()=>{
                const queueRows = Array.isArray(opts.queueRows) ? opts.queueRows : [];
                const qIdx = Number.isFinite(Number(opts.queueIndex)) ? Math.max(0, Number(opts.queueIndex)) : -1;
                if (queueRows.length && qIdx >= 0){
                    this._playQueue = this.buildAudioQueueFromRows(queueRows);
                    this._playQueueIndex = Math.min(this._playQueue.length - 1, qIdx);
                }
                this.showMiniPlayer(a, { title: w.title, by: w.authorName, cover: w.coverUrl });
                this.incrementAssetViewCounter({ kind: 'audio', sourceId: w.id, url: w.url });
            });
        }
        const editBtn = div.querySelector('.edit-wave-btn');
        if (editBtn){
            editBtn.onclick = async ()=>{
                try{
                    const id = String(w.id || '').trim();
                    if (!id){ this.showError('Cannot edit this item'); return; }
                    const nextTitle = prompt('Track title:', String(w.title || ''));
                    if (nextTitle === null) return;
                    const nextVisibilityRaw = prompt('Visibility (public/private):', String(w.visibility || 'public'));
                    if (nextVisibilityRaw === null) return;
                    const nextVisibility = String(nextVisibilityRaw || '').trim().toLowerCase() === 'private' ? 'private' : 'public';
                    await firebase.updateDoc(firebase.doc(window.firebaseService.db, 'wave', id), {
                        title: String(nextTitle || '').trim() || 'Untitled',
                        visibility: nextVisibility,
                        updatedAt: new Date().toISOString(),
                        updatedAtTS: firebase.serverTimestamp()
                    });
                    this.showSuccess('Track updated');
                    const me = await window.firebaseService.getCurrentUser();
                    if (me?.uid) this.renderWaveLibrary(me.uid);
                }catch(_){ this.showError('Failed to update track'); }
            };
        }
        this.bindAssetCardInteractions(div, { kind:'audio', url: w.url, title: w.title, by: w.authorName, cover: w.coverUrl, sourceId: w.id, sourcePostId: w.sourcePostId, playCount: Number(w.playCount || 0) || 0 });
        this.bindUserPreviewTriggers(div);
        return div;
    }

    async loadVideoHost(){
        try{
            const me = await window.firebaseService.getCurrentUser();
            await this.syncPostMediaToLibraries(me?.uid, { force: false });
            const lib = document.getElementById('video-library');
            const sug = document.getElementById('video-suggestions');
            const upBtn = document.getElementById('video-upload-btn');
            const prog = document.getElementById('video-progress');
            if (upBtn && !upBtn._bound){
                upBtn._bound = true;
                upBtn.onclick = async ()=>{
                    try{
                        const f = document.getElementById('video-file').files[0];
                        const coverFile = document.getElementById('video-cover')?.files?.[0] || null;
                        if (!f){ return this.showError('Select a video'); }
                        // 5 hours approximate cap enforced by size (assume <= 4GB for safety depending on codec)
                        if (f.size > 4*1024*1024*1024){ return this.showError('Max 4 GB'); }
                        const title = (document.getElementById('video-title').value||f.name).trim();
                        const s = firebase.getStorage();
                        const r = firebase.ref(s, `videos/${me.uid}/${Date.now()}_${f.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`);
                        const task = firebase.uploadBytesResumable(r, f, { contentType: f.type||'video/mp4' });
                        task.on('state_changed', (snap)=>{ if (prog) prog.value = Math.round((snap.bytesTransferred/snap.totalBytes)*100); });
                        await task;
                        const url = await firebase.getDownloadURL(r);
                        const meProfile = await window.firebaseService.getUserData(me.uid);
                        const authorName = (meProfile && meProfile.username) || me.email || 'Unknown';
                        let thumbnailUrl = (meProfile && meProfile.avatarUrl) || '';
                        const pendingTags = Array.isArray(this._pendingWaveUploadTags?.video) ? this._pendingWaveUploadTags.video : [];
                        const pendingVisibility = String(this._pendingWaveUploadTags?.['video:visibility'] || 'public') === 'private' ? 'private' : 'public';
                        if (coverFile){
                            const cRef = firebase.ref(s, `video-covers/${me.uid}/${Date.now()}_${coverFile.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`);
                            await firebase.uploadBytes(cRef, coverFile, { contentType: coverFile.type || 'image/jpeg' });
                            thumbnailUrl = await firebase.getDownloadURL(cRef);
                        }
                        const docRef = firebase.doc(firebase.collection(window.firebaseService.db, 'videos'));
                        await firebase.setDoc(docRef, { id: docRef.id, owner: me.uid, title, url, createdAt: new Date().toISOString(), createdAtTS: firebase.serverTimestamp(), visibility: pendingVisibility, mediaType: 'video', authorId: me.uid, authorName, thumbnailUrl, originalAuthorId: me.uid, originalAuthorName: authorName, tagsPrivate: pendingTags });
                        this._pendingWaveUploadTags.video = [];
                        this._pendingWaveUploadTags['video:visibility'] = 'public';
                        this.showSuccess('Video uploaded');
                        this.renderVideoLibrary(me.uid);
                    }catch(e){ this.showError('Upload failed'); }
                };
            }

            const search = document.getElementById('video-search');
            if (search && !search._bound){
                search._bound = true;
                search.oninput = async (e)=>{
                    const qStr = (e.target.value||'').toLowerCase();
                    const res = document.getElementById('video-search-results'); if (!res) return;
                    res.innerHTML='';
                    if (!qStr) return;
                    const snap = await firebase.getDocs(firebase.collection(window.firebaseService.db,'videos'));
                    res.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:10px;align-items:stretch';
                    snap.forEach(d=>{ const v=d.data(); const tags = Array.isArray(v.tagsPrivate) ? v.tagsPrivate.join(' ') : ''; if (this.resolveVisualKind(v) === 'video' && (((v.title||'').toLowerCase().includes(qStr)) || String(tags).toLowerCase().includes(qStr))){ res.appendChild(this.renderVideoItem(v)); } });
                };
            }

            await this.renderVideoLibrary(me.uid);
            await this.renderVideoSuggestions(me.uid);
            await this.renderWaveVideoHome(me.uid);
            this.setupVideoHostTabs();
            this.applyWaveSubtab();
        }catch(_){ }
    }

    async renderVideoLibrary(uid){
        const lib = document.getElementById('video-library'); if (!lib) return;
        lib.innerHTML = '';
        const items = [];
        try{
            let q;
            try{
                q = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', uid), firebase.orderBy('createdAtTS','desc'), firebase.limit(50));
            }catch(_){
                q = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', uid));
            }
            const snap = await firebase.getDocs(q);
            snap.forEach(d=> items.push(d.data()));
        }catch{
            const q2 = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', uid));
            const s2 = await firebase.getDocs(q2); s2.forEach(d=> items.push(d.data()));
        }
        const filtered = items.filter((v)=> this.resolveVisualKind(v) === 'video');
        lib.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:10px;align-items:stretch';
        const nonPost = filtered.filter((v)=> !this.isPostLibraryItem(v));
        const fromPosts = filtered.filter((v)=> this.isPostLibraryItem(v));
        const ordered = nonPost.concat(fromPosts);
        const visible = Math.max(5, Number(this._videoLibraryVisible || 5));
        let savedSeparatorShown = false;
        let postSeparatorShown = false;
        ordered.slice(0, visible).forEach((v)=>{
            if (!savedSeparatorShown && !this.isPostLibraryItem(v)){
                const sepSaved = document.createElement('div');
                sepSaved.style.cssText = 'margin:10px 0 6px;font-size:12px;opacity:.8;border-top:1px solid rgba(255,255,255,.16);padding-top:8px';
                sepSaved.textContent = 'Saved';
                sepSaved.style.gridColumn = '1 / -1';
                lib.appendChild(sepSaved);
                savedSeparatorShown = true;
            }
            if (!postSeparatorShown && this.isPostLibraryItem(v)){
                const sep = document.createElement('div');
                sep.style.cssText = 'margin:10px 0 6px;font-size:12px;opacity:.8;border-top:1px solid rgba(255,255,255,.16);padding-top:8px';
                sep.textContent = 'Posts';
                sep.style.gridColumn = '1 / -1';
                lib.appendChild(sep);
                postSeparatorShown = true;
            }
            lib.appendChild(this.renderVideoItem(v, {
                allowRemove: true,
                onRemoved: ()=> this.renderVideoLibrary(uid)
            }));
        });
        if (ordered.length > visible){
            const more = document.createElement('button');
            more.className = 'btn btn-secondary';
            more.textContent = 'Show 5 more';
            more.style.gridColumn = '1 / -1';
            more.onclick = ()=>{
                this._videoLibraryVisible = visible + 5;
                this.renderVideoLibrary(uid);
            };
            lib.appendChild(more);
        }
    }

    async renderVideoSuggestions(uid){
        const sug = document.getElementById('video-suggestions'); if (!sug) return;
        sug.innerHTML = '';
        sug.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:10px;align-items:stretch';
        try{
            const [snap, following, personalRec] = await Promise.all([
                firebase.getDocs(firebase.collection(window.firebaseService.db,'videos')),
                this.getWaveFollowingUsers(uid).catch(()=> []),
                window.firebaseService?.getVideoRecommendations?.({ source:'app', sourceId:'', limit:80 }).catch(()=> [])
            ]);
            const personalIds = new Set((Array.isArray(personalRec) ? personalRec : []).map((r)=> String(r?.sourceId || r?.videoId || r?.id || '').trim()).filter(Boolean));
            const followingIds = new Set((following || []).map((f)=> String(f.uid || '').trim()).filter(Boolean));
            const list = [];
            snap.forEach(d=>{
                const v = d.data();
                if (v.owner === uid || this.resolveVisualKind(v) !== 'video') return;
                list.push(v);
            });
            list.sort((a, b)=>{
                const score = (row)=>{
                    let s = Number(row?.viewCount || 0) * 0.15;
                    const rid = String(row?.id || '').trim();
                    const aid = String(row?.authorId || row?.originalAuthorId || '').trim();
                    if (personalIds.has(rid)) s += 1200;
                    if (followingIds.has(aid)) s += 800;
                    return s;
                };
                return score(b) - score(a);
            });
            const visible = Math.max(5, Number(this._videoSuggestionsVisible || 5));
            list.slice(0, visible).forEach(v=> sug.appendChild(this.renderVideoItem(v)));
            if (list.length > visible){
                const more = document.createElement('button');
                more.className = 'btn btn-secondary';
                more.textContent = 'Show 5 more';
                more.style.gridColumn = '1 / -1';
                more.onclick = ()=>{
                    this._videoSuggestionsVisible = visible + 5;
                    this.renderVideoSuggestions(uid);
                };
                sug.appendChild(more);
            }
        }catch(_){ }
    }

    renderVideoItem(v, opts = {}){
        const div = document.createElement('div');
        div.className = 'video-item';
        div.style.cssText = 'border:1px solid var(--border-color);border-radius:10px;padding:10px;margin:0;position:relative;background:var(--secondary-bg);height:100%';
        div.dataset.assetKind = 'video';
        if (v?.id) div.dataset.assetId = String(v.id);
        if (v?.url) div.dataset.assetUrl = this.normalizeMediaUrl(String(v.url));
        const thumb = v.thumbnailUrl || 'images/default-bird.png';
        const cardCover = String(v.thumbnailUrl || v.coverUrl || thumb || 'images/default-bird.png');
        const sourceType = String(v.sourceMediaType || '').toLowerCase();
        const isImageSource = sourceType === 'image' || this.inferMediaKindFromUrl(String(v.url || '')) === 'image';
        const byline = v.authorName ? `<div style=\"font-size:12px;color:#aaa\">by ${(v.authorName||'').replace(/</g,'&lt;')}</div>` : '';
        const originalMark = v.originalAuthorName ? `<div style="font-size:11px;color:#9db3d5">original by ${String(v.originalAuthorName || '').replace(/</g,'&lt;')}</div>` : '';
        const mediaHtml = isImageSource
            ? `<img src="${v.url}" data-fullscreen-image="1" alt="${(v.title||'Picture').replace(/"/g,'&quot;')}" style="width:100%;max-height:320px;border-radius:8px;object-fit:contain;background:#000" />`
            : `<div class="wave-video-preview"><video class="liber-lib-video" src="${v.url}" muted playsinline preload="metadata" style="width:100%;max-height:320px;border-radius:8px;object-fit:contain;background:#000;cursor:pointer" data-title="${(v.title||'').replace(/"/g,'&quot;')}" data-by="${(v.authorName||'').replace(/"/g,'&quot;')}" data-cover="${(v.thumbnailUrl||'').replace(/"/g,'&quot;')}" data-source-id="${String(v.id || '').replace(/"/g,'&quot;')}" data-likes-count="${Number(v.likesCount || v.likes || 0) || 0}" data-comments-count="${Number(v.commentsCount || v.comments || 0) || 0}" data-views-count="${Number(v.viewCount || v.views || 0) || 0}"></video><img class="wave-video-inline-cover" src="${cardCover.replace(/"/g,'&quot;')}" alt="cover"><button type="button" class="video-open-player-btn" title="Open player"><i class="fas fa-play"></i></button></div>`;
        const editBtnHtml = `<button class="edit-visual-btn" title="Edit media" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb"><i class="fas fa-pen"></i></button>`;
        const removeBtnHtml = opts.allowRemove ? `<button class="remove-visual-btn" title="Remove from my library" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb"><i class="fas fa-trash"></i></button>` : '';
        div.innerHTML = `<div class="video-item-header" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;padding-right:130px;min-width:0"><div style="min-width:0;flex:1;overflow:hidden"><div class="video-item-title" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${(v.title||'Untitled').replace(/</g,'&lt;')}</div>${byline}</div></div>
                         ${originalMark}
                         ${mediaHtml}
                         <div class="video-item-actions" style="position:absolute;top:10px;right:8px;display:flex;gap:4px;align-items:center;z-index:5;flex-wrap:wrap;justify-content:flex-end"><button class="asset-like-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Like"><i class="fas fa-heart"></i></button><span class="asset-like-count" style="font-size:11px;opacity:.86;min-width:16px;text-align:center">0</span><button class="asset-comment-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Comments"><i class="fas fa-comment-dots"></i></button><span class="asset-comments-count" style="font-size:11px;opacity:.86;min-width:16px;text-align:center">0</span><span style="opacity:.64;font-size:11px"><i class="fas fa-eye"></i></span><span class="asset-views-count" style="font-size:11px;opacity:.86;min-width:16px;text-align:center">${Number(v.viewCount || 0) || 0}</span><button class="asset-share-chat-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Share to chat"><i class="fas fa-paper-plane"></i></button><button class="add-video-playlist-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Add to playlist"><i class="fas fa-list"></i></button><button class="share-video-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Share"><i class="fas fa-share"></i></button><button class="repost-video-btn" title="Repost" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb"><i class="fas fa-retweet"></i></button>${editBtnHtml}${removeBtnHtml}</div>`;
        div.querySelector('.share-video-btn').onclick = async ()=>{
            try{
                const me = await window.firebaseService.getCurrentUser();
                const newRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
                await firebase.setDoc(newRef, { id: newRef.id, authorId: me.uid, text: (v.title||'Video'), mediaUrl: v.url, mediaType:'video', visibility:'private', createdAt: new Date().toISOString(), createdAtTS: firebase.serverTimestamp(), authorName: (v.authorName||''), thumbnailUrl: (v.thumbnailUrl||'') });
                this.showSuccess('Shared to your feed (private)');
            }catch(_){ this.showError('Share failed'); }
        };
        const rv = div.querySelector('.repost-video-btn');
        if (rv){ rv.onclick = async ()=>{
            try{
                const me = await window.firebaseService.getCurrentUser();
                const newRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
                await firebase.setDoc(newRef, { id: newRef.id, authorId: me.uid, text: (v.title||'Video'), mediaUrl: v.url, mediaType:'video', visibility:'public', createdAt: new Date().toISOString(), createdAtTS: firebase.serverTimestamp(), authorName: (v.authorName||''), thumbnailUrl: (v.thumbnailUrl||'') });
                this.showSuccess('Reposted to your feed');
            }catch(_){ this.showError('Repost failed'); }
        }; }
        const addToPlaylistBtn = div.querySelector('.add-video-playlist-btn');
        if (addToPlaylistBtn){
            addToPlaylistBtn.onclick = ()=> this.openAddToPlaylistPopup({
                kind: 'video',
                src: String(v.url || ''),
                title: String(v.title || 'Video'),
                by: String(v.authorName || ''),
                cover: String(v.thumbnailUrl || '')
            });
        }
        const vEl = div.querySelector('.liber-lib-video');
        const openPlayerBtn = div.querySelector('.video-open-player-btn');
        let holdTimer = 0;
        let previewing = false;
        let holdTriggered = false;
        const clearHoldTimer = ()=>{ try{ clearTimeout(holdTimer); }catch(_){ } holdTimer = 0; };
        const stopPreview = ()=>{
            clearHoldTimer();
            if (!vEl) return;
            if (previewing){
                try{ vEl.pause(); }catch(_){ }
                try{ vEl.currentTime = 0; }catch(_){ }
                try{ vEl.loop = false; }catch(_){ }
            }
            previewing = false;
        };
        const startHold = ()=>{
            if (!vEl) return;
            clearHoldTimer();
            holdTimer = setTimeout(()=>{
                holdTriggered = true;
                previewing = true;
                try{ vEl.muted = true; vEl.volume = 0; vEl.loop = true; }catch(_){ }
                try{ vEl.currentTime = 0; }catch(_){ }
                try{ vEl.play().catch(()=>{}); }catch(_){ }
            }, 220);
        };
        const openInPlayer = ()=>{
            try{
                const root = div.closest('#video-library,#video-suggestions,#video-search-results,#picture-library,#picture-suggestions,#global-feed,#space-feed,#waveconnect-section') || document;
                const videos = Array.from(root.querySelectorAll('.liber-lib-video')).map((node)=> ({
                    type: 'video',
                    url: String(node.currentSrc || node.src || '').trim(),
                    title: String(node.dataset.title || '').trim() || 'Video',
                    by: String(node.dataset.by || '').trim(),
                    cover: String(node.dataset.cover || '').trim(),
                    sourceId: String(node.dataset.sourceId || '').trim(),
                    likesCount: Number(node.dataset.likesCount || 0) || 0,
                    commentsCount: Number(node.dataset.commentsCount || 0) || 0,
                    viewsCount: Number(node.dataset.viewsCount || 0) || 0
                })).filter((it)=> !!it.url);
                if (!videos.length){
                    this.openFullscreenMedia([{ type:'video', url: String(v.url || ''), title: String(v.title || 'Video'), by: String(v.authorName || ''), cover: String(v.thumbnailUrl || ''), sourceId: String(v.id || ''), likesCount: Number(v.likesCount || 0) || 0, commentsCount: Number(v.commentsCount || 0) || 0, viewsCount: Number(v.viewCount || 0) || 0 }], 0);
                    return;
                }
                const idx = Math.max(0, videos.findIndex((it)=> it.url === String(v.url || '')));
                this.openFullscreenMedia(videos, idx);
                this.incrementAssetViewCounter({ kind: 'video', sourceId: v.id, url: v.url });
            }catch(_){ }
        };
        if (vEl){
            vEl.controls = false;
            vEl.addEventListener('pointerdown', startHold);
            vEl.addEventListener('pointerup', stopPreview);
            vEl.addEventListener('pointercancel', stopPreview);
            vEl.addEventListener('pointerleave', stopPreview);
            vEl.addEventListener('touchstart', startHold, { passive: true });
            vEl.addEventListener('touchend', stopPreview, { passive: true });
            vEl.addEventListener('touchcancel', stopPreview, { passive: true });
            vEl.addEventListener('click', (e)=>{
                if (holdTriggered){
                    holdTriggered = false;
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                openInPlayer();
            });
            vEl.addEventListener('play', ()=>{
                if (previewing) return;
                try{ vEl.pause(); }catch(_){ }
                openInPlayer();
            });
        }
        if (openPlayerBtn){
            openPlayerBtn.onclick = (e)=>{
                stopPreview();
                holdTriggered = false;
                e.preventDefault();
                e.stopPropagation();
                openInPlayer();
            };
        }
        const editBtn = div.querySelector('.edit-visual-btn');
        if (editBtn){
            editBtn.onclick = async ()=>{
                try{
                    const id = String(v.id || '').trim();
                    if (!id){ this.showError('Cannot edit this item'); return; }
                    const nextTitle = prompt('Video title:', String(v.title || ''));
                    if (nextTitle === null) return;
                    const nextVisibilityRaw = prompt('Visibility (public/private):', String(v.visibility || 'public'));
                    if (nextVisibilityRaw === null) return;
                    const nextVisibility = String(nextVisibilityRaw || '').trim().toLowerCase() === 'private' ? 'private' : 'public';
                    await firebase.updateDoc(firebase.doc(window.firebaseService.db, 'videos', id), {
                        title: String(nextTitle || '').trim() || 'Untitled',
                        visibility: nextVisibility,
                        updatedAt: new Date().toISOString(),
                        updatedAtTS: firebase.serverTimestamp()
                    });
                    this.showSuccess('Video updated');
                    const me = await window.firebaseService.getCurrentUser();
                    if (me?.uid) this.renderVideoLibrary(me.uid);
                }catch(_){ this.showError('Failed to update video'); }
            };
        }
        const removeBtn = div.querySelector('.remove-visual-btn');
        if (removeBtn){
            removeBtn.onclick = async ()=>{
                try{
                    const removed = await this.removeVisualFromLibrary('video', String(v.url || ''));
                    if (!removed){ this.showError('Failed to remove from library'); return; }
                    if (typeof opts.onRemoved === 'function') opts.onRemoved();
                    this.showSuccess('Removed from My Videos');
                }catch(_){ this.showError('Failed to remove from library'); }
            };
        }
        this.bindAssetCardInteractions(div, { kind:'video', url: v.url, title: v.title, by: v.authorName, cover: v.thumbnailUrl, sourceId: v.id, sourcePostId: v.sourcePostId, viewCount: Number(v.viewCount || 0) || 0 });
        return div;
    }

    async loadPictureHost(){
        try{
            const me = await window.firebaseService.getCurrentUser();
            await this.syncPostMediaToLibraries(me?.uid, { force: false });
            const upBtn = document.getElementById('picture-upload-btn');
            if (upBtn && !upBtn._bound){
                upBtn._bound = true;
                upBtn.onclick = async ()=>{
                    try{
                        const f = document.getElementById('picture-file').files[0];
                        if (!f){ return this.showError('Select a picture or video'); }
                        const title = (document.getElementById('picture-title').value||f.name).trim();
                        const s = firebase.getStorage();
                        const path = `pictures/${me.uid}/${Date.now()}_${f.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
                        const r = firebase.ref(s, path);
                        await firebase.uploadBytesResumable(r, f, { contentType: f.type||'application/octet-stream' });
                        const url = await firebase.getDownloadURL(r);
                        const meProfile = await window.firebaseService.getUserData(me.uid);
                        const authorName = (meProfile && meProfile.username) || me.email || 'Unknown';
                        const mediaType = String(f.type || '').startsWith('video/') ? 'video' : 'image';
                        const thumb = mediaType === 'image' ? url : ((meProfile && meProfile.avatarUrl) || '');
                        const pendingTags = Array.isArray(this._pendingWaveUploadTags?.pictures) ? this._pendingWaveUploadTags.pictures : [];
                        const pendingVisibility = String(this._pendingWaveUploadTags?.['pictures:visibility'] || 'public') === 'private' ? 'private' : 'public';
                        const docRef = firebase.doc(firebase.collection(window.firebaseService.db, 'videos'));
                        await firebase.setDoc(docRef, {
                            id: docRef.id,
                            owner: me.uid,
                            title,
                            url,
                            createdAt: new Date().toISOString(),
                            createdAtTS: firebase.serverTimestamp(),
                            visibility: pendingVisibility,
                            mediaType: 'image',
                            sourceMediaType: mediaType,
                            authorId: me.uid,
                            authorName,
                            thumbnailUrl: thumb,
                            originalAuthorId: me.uid,
                            originalAuthorName: authorName,
                            tagsPrivate: pendingTags
                        });
                        this._pendingWaveUploadTags.pictures = [];
                        this._pendingWaveUploadTags['pictures:visibility'] = 'public';
                        this.showSuccess('Added to My Pictures');
                        this.renderPictureLibrary(me.uid);
                    }catch(_){ this.showError('Upload failed'); }
                };
            }
            const search = document.getElementById('picture-search');
            if (search && !search._bound){
                search._bound = true;
                search.oninput = async (e)=>{
                    const qStr = (e.target.value||'').toLowerCase();
                    const res = document.getElementById('picture-search-results'); if (!res) return;
                    res.innerHTML='';
                    if (!qStr) return;
                    const snap = await firebase.getDocs(firebase.collection(window.firebaseService.db,'videos'));
                    snap.forEach(d=>{ const v=d.data(); const tags = Array.isArray(v.tagsPrivate) ? v.tagsPrivate.join(' ') : ''; if ((v.mediaType||'') === 'image' && (((v.title||'').toLowerCase().includes(qStr)) || String(tags).toLowerCase().includes(qStr))){ res.appendChild(this.renderPictureItem(v)); } });
                };
            }
            await this.renderPictureLibrary(me.uid);
            await this.renderPictureSuggestions(me.uid);
            await this.renderWavePictureHome(me.uid);
            this.setupPictureHostTabs();
            this.applyWaveSubtab();
        }catch(_){ }
    }

    async renderWaveVideoHome(uid){
        const host = document.getElementById('wave-video-home-cards');
        if (!host) return;
        try{
            const [following, snap, playlists] = await Promise.all([
                this.getWaveFollowingUsers(uid),
                firebase.getDocs(firebase.collection(window.firebaseService.db, 'videos')),
                this.hydratePlaylistsFromCloud().catch(()=> [])
            ]);
            const rows = [];
            snap.forEach((d)=> rows.push(d.data() || {}));
            const vids = rows.filter((v)=> this.resolveVisualKind(v) === 'video');
            const followingVids = vids.filter((v)=> following.some((f)=> String(f.uid || '') === String(v.authorId || v.originalAuthorId || '')));
            const galleryRows = (followingVids.length ? followingVids : vids).slice(0, 12);
            const videoPlaylists = (Array.isArray(playlists) ? playlists : [])
                .filter((pl)=> Array.isArray(pl?.items) && pl.items.some((it)=> this.inferMediaKindFromUrl(String(it?.src || '')) === 'video'))
                .slice(0, 8);
            host.className = '';
            host.innerHTML = `
              <div class="wave-home-section">
                <h4 style="margin:0 0 8px">Video Gallery</h4>
                <div class="wave-home-tile-gallery">
                  ${galleryRows.map((v)=> {
                    const cover = String(v.thumbnailUrl || v.coverUrl || '').trim() || 'images/default-bird.png';
                    const title = String(v.title || 'Video').replace(/</g,'&lt;');
                    return `<button type="button" class="wave-home-video-tile" data-wave-video-url="${String(v.url || '').replace(/"/g,'&quot;')}">
                      <img src="${cover.replace(/"/g,'&quot;')}" alt="cover">
                      <span class="wave-home-video-overlay"><i class="fas fa-play"></i></span>
                      <span class="wave-home-video-title">${title}</span>
                    </button>`;
                  }).join('')}
                </div>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Video Playlists</h4>
                <div class="wave-home-row">
                  ${videoPlaylists.map((pl)=>{
                    const first = (pl.items || []).find((it)=> this.inferMediaKindFromUrl(String(it?.src || '')) === 'video') || {};
                    const cover = String(first.cover || '').trim() || 'images/default-bird.png';
                    const name = String(pl.name || 'Playlist').replace(/</g,'&lt;');
                    return `<button type="button" class="wave-home-playlist-card" data-wave-video-playlist="${String(pl.id || '').replace(/"/g,'&quot;')}"><img src="${cover.replace(/"/g,'&quot;')}" alt="${name}"><span>${name}</span></button>`;
                  }).join('') || '<div style="opacity:.75">No video playlists yet.</div>'}
                </div>
              </div>
            `;
            host.querySelectorAll('[data-wave-video-url]').forEach((btn)=>{
                btn.addEventListener('click', ()=>{
                    const url = String(btn.getAttribute('data-wave-video-url') || '');
                    const items = galleryRows.map((v)=> ({
                        type: 'video',
                        url: String(v.url || ''),
                        title: String(v.title || 'Video'),
                        by: String(v.authorName || ''),
                        cover: String(v.thumbnailUrl || v.coverUrl || ''),
                        sourceId: String(v.id || ''),
                        likesCount: Number(v.likesCount || v.likes || 0) || 0,
                        commentsCount: Number(v.commentsCount || v.comments || 0) || 0,
                        viewsCount: Number(v.viewCount || v.views || 0) || 0
                    })).filter((x)=> !!x.url);
                    const idx = Math.max(0, items.findIndex((x)=> x.url === url));
                    if (items.length) this.openFullscreenMedia(items, idx);
                });
            });
            host.querySelectorAll('[data-wave-video-playlist]').forEach((btn)=>{
                btn.addEventListener('click', async ()=>{
                    const id = String(btn.getAttribute('data-wave-video-playlist') || '');
                    const pl = videoPlaylists.find((x)=> String(x?.id || '') === id);
                    if (pl) await this.openWavePlaylistModal(pl, { source: 'video-home' });
                });
            });
        }catch(_){
            host.innerHTML = '<div style="opacity:.75">Unable to load video home.</div>';
        }
    }

    async renderWavePictureHome(uid){
        const host = document.getElementById('wave-picture-home-cards');
        if (!host) return;
        try{
            const [following, snap, playlists] = await Promise.all([
                this.getWaveFollowingUsers(uid),
                firebase.getDocs(firebase.collection(window.firebaseService.db, 'videos')),
                this.hydratePlaylistsFromCloud().catch(()=> [])
            ]);
            const rows = [];
            snap.forEach((d)=> rows.push(d.data() || {}));
            const pics = rows.filter((v)=> this.resolveVisualKind(v) === 'image');
            const followingPics = pics.filter((v)=> following.some((f)=> String(f.uid || '') === String(v.authorId || v.originalAuthorId || '')));
            const feed = (followingPics.length ? followingPics : pics).slice(0, 16);
            const featured = feed[0] || null;
            const recents = feed.slice(0, 6);
            const recommended = feed.slice(1, 7);
            const pictureAlbums = (Array.isArray(playlists) ? playlists : [])
                .filter((pl)=> Array.isArray(pl?.items) && pl.items.some((it)=> this.inferMediaKindFromUrl(String(it?.src || '')) === 'image'))
                .slice(0, 8);
            host.className = '';
            if (!featured){
                host.innerHTML = '<div style="opacity:.75">No pictures yet.</div>';
                return;
            }
            const cover = String(featured.url || featured.thumbnailUrl || featured.coverUrl || '').trim() || 'images/default-bird.png';
            const title = String(featured.title || 'Picture').replace(/</g,'&lt;');
            host.innerHTML = `
              <div class="wave-home-section">
                <h4 style="margin:0 0 8px">Featured Picture</h4>
                <button type="button" class="wave-home-picture-hero" data-wave-picture-url="${String(featured.url || '').replace(/"/g,'&quot;')}">
                  <img src="${cover.replace(/"/g,'&quot;')}" alt="featured picture">
                  <span class="wave-home-picture-caption">${title}</span>
                </button>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Recent</h4>
                <div class="wave-home-row">
                  ${recents.map((p)=> `<button type="button" class="wave-home-media-card" data-wave-picture-url="${String(p.url || '').replace(/"/g,'&quot;')}"><img src="${String(p.url || p.thumbnailUrl || p.coverUrl || 'images/default-bird.png').replace(/"/g,'&quot;')}" alt=""><div>${String(p.title || 'Picture').replace(/</g,'&lt;')}</div></button>`).join('')}
                </div>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Recommended</h4>
                <div class="wave-home-row">
                  ${recommended.map((p)=> `<button type="button" class="wave-home-media-card" data-wave-picture-url="${String(p.url || '').replace(/"/g,'&quot;')}"><img src="${String(p.url || p.thumbnailUrl || p.coverUrl || 'images/default-bird.png').replace(/"/g,'&quot;')}" alt=""><div>${String(p.title || 'Picture').replace(/</g,'&lt;')}</div></button>`).join('') || '<div style="opacity:.75">No recommendations yet.</div>'}
                </div>
              </div>
              <div class="wave-home-section" style="margin-top:12px">
                <h4 style="margin:0 0 8px">Featured Albums</h4>
                <div class="wave-home-row">
                  ${pictureAlbums.map((pl)=>{
                    const first = (pl.items || []).find((it)=> this.inferMediaKindFromUrl(String(it?.src || '')) === 'image') || {};
                    const pTitle = String(pl.name || 'Album').replace(/</g,'&lt;');
                    const pCover = String(first.cover || '').trim() || 'images/default-bird.png';
                    return `<button type="button" class="wave-home-playlist-card" data-wave-picture-album="${String(pl.id || '').replace(/"/g,'&quot;')}"><img src="${pCover.replace(/"/g,'&quot;')}" alt="${pTitle}"><span>${pTitle}</span></button>`;
                  }).join('') || '<div style="opacity:.75">No albums yet. Use "Add to album" on picture cards.</div>'}
                </div>
              </div>
            `;
            const openPictureCollection = (items, url = '')=>{
                const list = (items || []).map((x)=> ({
                    type: this.inferMediaKindFromUrl(String(x?.src || '')) === 'video' ? 'video' : 'image',
                    url: String(x?.src || x?.url || ''),
                    title: String(x?.title || 'Picture'),
                    by: String(x?.by || ''),
                    cover: String(x?.cover || '')
                })).filter((x)=> !!x.url);
                if (!list.length){ this.showError('Collection is empty'); return; }
                const idx = url ? Math.max(0, list.findIndex((x)=> x.url === url)) : 0;
                this.openFullscreenMedia(list, idx);
            };
            const openBtn = host.querySelector('.wave-home-picture-hero');
            if (openBtn){
                openBtn.addEventListener('click', ()=>{
                    const url = String(openBtn.getAttribute('data-wave-picture-url') || '');
                    const items = feed.map((v)=> ({
                        type: this.resolveVisualKind(v) === 'video' ? 'video' : 'image',
                        url: String(v.url || ''),
                        title: String(v.title || 'Picture'),
                        by: String(v.authorName || ''),
                        cover: String(v.thumbnailUrl || v.coverUrl || ''),
                        sourceId: String(v.id || '')
                    })).filter((x)=> !!x.url);
                    const idx = Math.max(0, items.findIndex((x)=> x.url === url));
                    if (items.length) this.openFullscreenMedia(items, idx);
                });
            }
            host.querySelectorAll('.wave-home-media-card[data-wave-picture-url]').forEach((btn)=>{
                btn.addEventListener('click', ()=>{
                    const url = String(btn.getAttribute('data-wave-picture-url') || '');
                    const item = feed.find((x)=> String(x?.url || '') === url) || null;
                    if (item) openPictureCollection([{ src: String(item.url || ''), title: String(item.title || 'Picture'), by: String(item.authorName || ''), cover: String(item.thumbnailUrl || item.coverUrl || item.url || '') }], url);
                });
            });
            host.querySelectorAll('[data-wave-picture-album]').forEach((btn)=>{
                btn.addEventListener('click', ()=>{
                    const id = String(btn.getAttribute('data-wave-picture-album') || '');
                    const pl = pictureAlbums.find((x)=> String(x?.id || '') === id);
                    if (!pl) return;
                    const imageItems = (pl.items || []).filter((it)=> this.inferMediaKindFromUrl(String(it?.src || '')) === 'image');
                    openPictureCollection(imageItems, '');
                });
            });
        }catch(_){
            host.innerHTML = '<div style="opacity:.75">Unable to load pictures home.</div>';
        }
    }

    async renderPictureLibrary(uid){
        const lib = document.getElementById('picture-library'); if (!lib) return;
        lib.innerHTML = '';
        const items = [];
        try{
            const q = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', uid), firebase.orderBy('createdAtTS','desc'), firebase.limit(60));
            const snap = await firebase.getDocs(q);
            snap.forEach(d=> items.push(d.data()));
        }catch{
            const q2 = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', uid));
            const s2 = await firebase.getDocs(q2); s2.forEach(d=> items.push(d.data()));
        }
        const filtered = items.filter((v)=> this.resolveVisualKind(v) === 'image');
        lib.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:10px;align-items:stretch';
        const nonPost = filtered.filter((v)=> !this.isPostLibraryItem(v));
        const fromPosts = filtered.filter((v)=> this.isPostLibraryItem(v));
        const ordered = nonPost.concat(fromPosts);
        const visible = Math.max(5, Number(this._videoLibraryVisible || 5));
        let savedSeparatorShown = false;
        let postSeparatorShown = false;
        ordered.slice(0, visible).forEach((v)=>{
            if (!savedSeparatorShown && !this.isPostLibraryItem(v)){
                const sepSaved = document.createElement('div');
                sepSaved.style.cssText = 'margin:10px 0 6px;font-size:12px;opacity:.8;border-top:1px solid rgba(255,255,255,.16);padding-top:8px';
                sepSaved.textContent = 'Saved';
                sepSaved.style.gridColumn = '1 / -1';
                lib.appendChild(sepSaved);
                savedSeparatorShown = true;
            }
            if (!postSeparatorShown && this.isPostLibraryItem(v)){
                const sep = document.createElement('div');
                sep.style.cssText = 'margin:10px 0 6px;font-size:12px;opacity:.8;border-top:1px solid rgba(255,255,255,.16);padding-top:8px';
                sep.textContent = 'Posts';
                sep.style.gridColumn = '1 / -1';
                lib.appendChild(sep);
                postSeparatorShown = true;
            }
            lib.appendChild(this.renderPictureItem(v, {
                allowRemove: true,
                onRemoved: ()=> this.renderPictureLibrary(uid)
            }));
        });
        if (ordered.length > visible){
            const more = document.createElement('button');
            more.className = 'btn btn-secondary';
            more.textContent = 'Show 5 more';
            more.style.gridColumn = '1 / -1';
            more.onclick = ()=>{
                this._videoLibraryVisible = visible + 5;
                this.renderPictureLibrary(uid);
            };
            lib.appendChild(more);
        }
    }

    async renderPictureSuggestions(uid){
        const sug = document.getElementById('picture-suggestions'); if (!sug) return;
        sug.innerHTML = '';
        sug.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:10px;align-items:stretch';
        try{
            const [snap, following, personalRec] = await Promise.all([
                firebase.getDocs(firebase.collection(window.firebaseService.db,'videos')),
                this.getWaveFollowingUsers(uid).catch(()=> []),
                window.firebaseService?.getVideoRecommendations?.({ source:'app', sourceId:'', limit:80 }).catch(()=> [])
            ]);
            const personalIds = new Set((Array.isArray(personalRec) ? personalRec : []).map((r)=> String(r?.sourceId || r?.videoId || r?.id || '').trim()).filter(Boolean));
            const followingIds = new Set((following || []).map((f)=> String(f.uid || '').trim()).filter(Boolean));
            const list = [];
            snap.forEach(d=>{
                const v = d.data();
                if (v.owner !== uid && this.resolveVisualKind(v) === 'image') list.push(v);
            });
            list.sort((a, b)=>{
                const score = (row)=>{
                    let s = Number(row?.viewCount || 0) * 0.12;
                    const rid = String(row?.id || '').trim();
                    const aid = String(row?.authorId || row?.originalAuthorId || '').trim();
                    if (personalIds.has(rid)) s += 900;
                    if (followingIds.has(aid)) s += 750;
                    return s;
                };
                return score(b) - score(a);
            });
            list.slice(0, Math.max(5, Number(this._videoSuggestionsVisible || 5))).forEach(v=> sug.appendChild(this.renderPictureItem(v)));
        }catch(_){ }
    }

    renderPictureItem(v, opts = {}){
        const div = document.createElement('div');
        div.className = 'video-item';
        div.style.cssText = 'border:1px solid var(--border-color);border-radius:10px;padding:10px;margin:0;position:relative;background:var(--secondary-bg);height:100%';
        div.dataset.assetKind = 'picture';
        if (v?.id) div.dataset.assetId = String(v.id);
        if (v?.url) div.dataset.assetUrl = this.normalizeMediaUrl(String(v.url));
        const authorId = String(v.authorId || v.originalAuthorId || '').trim();
        const thumb = this.getAuthorAvatarFromCache(authorId, 'images/default-bird.png');
        const sourceType = String(v.sourceMediaType || '').toLowerCase();
        const isVideoSource = sourceType === 'video' || this.inferMediaKindFromUrl(String(v.url || '')) === 'video';
        const byline = v.authorName ? `<div style=\"font-size:12px;color:#aaa\">by ${(v.authorName||'').replace(/</g,'&lt;')}</div>` : '';
        const originalMark = v.originalAuthorName ? `<div style="font-size:11px;color:#9db3d5">original by ${String(v.originalAuthorName || '').replace(/</g,'&lt;')}</div>` : '';
        const mediaHtml = isVideoSource
            ? `<div class="wave-video-preview"><video class="liber-lib-video" src="${v.url}" muted playsinline preload="metadata" style="width:100%;max-height:360px;border-radius:8px;object-fit:contain;background:#000;cursor:pointer" data-title="${(v.title||'').replace(/"/g,'&quot;')}" data-by="${(v.authorName||'').replace(/"/g,'&quot;')}" data-cover="${(v.thumbnailUrl||v.url||'').replace(/"/g,'&quot;')}" data-source-id="${String(v.id || '').replace(/"/g,'&quot;')}"></video><button type="button" class="video-open-player-btn" title="Open player"><i class="fas fa-play"></i></button></div>`
            : `<img src="${v.url}" data-fullscreen-image="1" alt="${(v.title||'Picture').replace(/"/g,'&quot;')}" style="width:100%;max-height:360px;border-radius:8px;object-fit:contain;background:#000" />`;
        const editBtnHtml = `<button class="edit-visual-btn" title="Edit media" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb"><i class="fas fa-pen"></i></button>`;
        const removeBtnHtml = opts.allowRemove ? `<button class="remove-visual-btn" title="Remove from my library" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb"><i class="fas fa-trash"></i></button>` : '';
        div.innerHTML = `<div class="video-item-header" style="display:flex;gap:10px;align-items:center;margin-bottom:6px;padding-right:130px;min-width:0"><img class="picture-author-avatar" src="${thumb}" alt="author" style="width:40px;height:40px;flex-shrink:0;border-radius:8px;object-fit:cover"><div style="min-width:0;flex:1;overflow:hidden"><div class="video-item-title" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${(v.title||'Untitled').replace(/</g,'&lt;')}</div>${byline}</div></div>${originalMark}
                         ${mediaHtml}
                         <div class="video-item-actions" style="position:absolute;top:10px;right:8px;display:flex;gap:4px;align-items:center;z-index:5;flex-wrap:wrap;justify-content:flex-end"><button class="asset-like-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Like"><i class="fas fa-heart"></i></button><span class="asset-like-count" style="font-size:11px;opacity:.86;min-width:16px;text-align:center">0</span><button class="asset-comment-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Comments"><i class="fas fa-comment-dots"></i></button><span class="asset-comments-count" style="font-size:11px;opacity:.86;min-width:16px;text-align:center">0</span><button class="asset-share-chat-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Share to chat"><i class="fas fa-paper-plane"></i></button><button class="add-picture-album-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Add to album"><i class="fas fa-folder-plus"></i></button><button class="share-picture-btn" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb" title="Share"><i class="fas fa-share"></i></button><button class="repost-picture-btn" title="Repost" style="background:transparent;border:none;box-shadow:none;padding:2px 4px;min-width:auto;width:auto;height:auto;line-height:1;opacity:.9;color:#d6deeb"><i class="fas fa-retweet"></i></button>${editBtnHtml}${removeBtnHtml}</div>`;
        div.querySelector('.share-picture-btn').onclick = async ()=>{
            try{
                const me = await window.firebaseService.getCurrentUser();
                const newRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
                await firebase.setDoc(newRef, { id: newRef.id, authorId: me.uid, text: (v.title||'Picture'), media: [{ kind:'image', url: v.url, name: v.title||'Picture', by: v.authorName||'', cover: v.thumbnailUrl||v.url||'' }], visibility:'private', createdAt: new Date().toISOString(), createdAtTS: firebase.serverTimestamp(), authorName: (v.authorName||'') });
                this.showSuccess('Shared to your feed (private)');
            }catch(_){ this.showError('Share failed'); }
        };
        const rp = div.querySelector('.repost-picture-btn');
        if (rp){ rp.onclick = async ()=>{
            try{
                const me = await window.firebaseService.getCurrentUser();
                const newRef = firebase.doc(firebase.collection(window.firebaseService.db, 'posts'));
                await firebase.setDoc(newRef, { id: newRef.id, authorId: me.uid, text: (v.title||'Picture'), media: [{ kind:'image', url: v.url, name: v.title||'Picture', by: v.authorName||'', cover: v.thumbnailUrl||v.url||'' }], visibility:'public', createdAt: new Date().toISOString(), createdAtTS: firebase.serverTimestamp(), authorName: (v.authorName||'') });
                this.showSuccess('Reposted to your feed');
            }catch(_){ this.showError('Repost failed'); }
        }; }
        const addToAlbumBtn = div.querySelector('.add-picture-album-btn');
        if (addToAlbumBtn){
            addToAlbumBtn.onclick = ()=> this.openAddToPlaylistPopup({
                kind: 'image',
                src: String(v.url || ''),
                title: String(v.title || 'Picture'),
                by: String(v.authorName || ''),
                cover: String(v.thumbnailUrl || v.url || '')
            });
        }
        const avatarEl = div.querySelector('.picture-author-avatar');
        if (avatarEl && authorId){
            this.hydrateAuthorAvatarImage(avatarEl, authorId);
        }
        const pVideo = div.querySelector('.liber-lib-video');
        const pOpenBtn = div.querySelector('.video-open-player-btn');
        let picHoldTimer = 0;
        let picPreviewing = false;
        let picHoldTriggered = false;
        const clearPicHold = ()=>{ try{ clearTimeout(picHoldTimer); }catch(_){ } picHoldTimer = 0; };
        const stopPicPreview = ()=>{
            clearPicHold();
            if (!pVideo) return;
            if (picPreviewing){
                try{ pVideo.pause(); }catch(_){ }
                try{ pVideo.currentTime = 0; }catch(_){ }
                try{ pVideo.loop = false; }catch(_){ }
            }
            picPreviewing = false;
        };
        const startPicHold = ()=>{
            if (!pVideo) return;
            clearPicHold();
            picHoldTimer = setTimeout(()=>{
                picHoldTriggered = true;
                picPreviewing = true;
                try{ pVideo.muted = true; pVideo.volume = 0; pVideo.loop = true; }catch(_){ }
                try{ pVideo.currentTime = 0; }catch(_){ }
                try{ pVideo.play().catch(()=>{}); }catch(_){ }
            }, 220);
        };
        const openPictureVideoPlayer = ()=>{
            try{
                const root = div.closest('#picture-library,#picture-suggestions,#picture-search-results,#waveconnect-section') || document;
                const videos = Array.from(root.querySelectorAll('.liber-lib-video')).map((node)=> ({
                    type: 'video',
                    url: String(node.currentSrc || node.src || '').trim(),
                    title: String(node.dataset.title || '').trim() || 'Video',
                    by: String(node.dataset.by || '').trim(),
                    cover: String(node.dataset.cover || '').trim(),
                    sourceId: String(node.dataset.sourceId || '').trim()
                })).filter((it)=> !!it.url);
                if (!videos.length){
                    this.openFullscreenMedia([{ type:'video', url: String(v.url || ''), title: String(v.title || 'Video'), by: String(v.authorName || ''), cover: String(v.thumbnailUrl || v.url || ''), sourceId: String(v.id || '') }], 0);
                    return;
                }
                const idx = Math.max(0, videos.findIndex((it)=> it.url === String(v.url || '')));
                this.openFullscreenMedia(videos, idx);
                this.incrementAssetViewCounter({ kind: 'video', sourceId: v.id, url: v.url });
            }catch(_){ }
        };
        if (pVideo){
            pVideo.controls = false;
            pVideo.addEventListener('pointerdown', startPicHold);
            pVideo.addEventListener('pointerup', stopPicPreview);
            pVideo.addEventListener('pointercancel', stopPicPreview);
            pVideo.addEventListener('pointerleave', stopPicPreview);
            pVideo.addEventListener('touchstart', startPicHold, { passive: true });
            pVideo.addEventListener('touchend', stopPicPreview, { passive: true });
            pVideo.addEventListener('touchcancel', stopPicPreview, { passive: true });
            pVideo.addEventListener('click', (e)=>{
                if (picHoldTriggered){
                    picHoldTriggered = false;
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                openPictureVideoPlayer();
            });
            pVideo.addEventListener('play', ()=>{
                if (picPreviewing) return;
                try{ pVideo.pause(); }catch(_){ }
                openPictureVideoPlayer();
            });
        }
        if (pOpenBtn){
            pOpenBtn.onclick = (e)=>{
                stopPicPreview();
                picHoldTriggered = false;
                e.preventDefault();
                e.stopPropagation();
                openPictureVideoPlayer();
            };
        }
        const removeBtn = div.querySelector('.remove-visual-btn');
        if (removeBtn){
            removeBtn.onclick = async ()=>{
                try{
                    const removed = await this.removeVisualFromLibrary('image', String(v.url || ''));
                    if (!removed){ this.showError('Failed to remove from library'); return; }
                    if (typeof opts.onRemoved === 'function') opts.onRemoved();
                    this.showSuccess('Removed from My Pictures');
                }catch(_){ this.showError('Failed to remove from library'); }
            };
        }
        const editBtn = div.querySelector('.edit-visual-btn');
        if (editBtn){
            editBtn.onclick = async ()=>{
                try{
                    const id = String(v.id || '').trim();
                    if (!id){ this.showError('Cannot edit this item'); return; }
                    const nextTitle = prompt('Media title:', String(v.title || ''));
                    if (nextTitle === null) return;
                    const nextVisibilityRaw = prompt('Visibility (public/private):', String(v.visibility || 'public'));
                    if (nextVisibilityRaw === null) return;
                    const nextVisibility = String(nextVisibilityRaw || '').trim().toLowerCase() === 'private' ? 'private' : 'public';
                    await firebase.updateDoc(firebase.doc(window.firebaseService.db, 'videos', id), {
                        title: String(nextTitle || '').trim() || 'Untitled',
                        visibility: nextVisibility,
                        updatedAt: new Date().toISOString(),
                        updatedAtTS: firebase.serverTimestamp()
                    });
                    this.showSuccess('Media updated');
                    const me = await window.firebaseService.getCurrentUser();
                    if (me?.uid) this.renderPictureLibrary(me.uid);
                }catch(_){ this.showError('Failed to update media'); }
            };
        }
        this.bindAssetCardInteractions(div, { kind:'image', url: v.url, title: v.title, by: v.authorName, cover: v.thumbnailUrl || v.url, sourceId: v.id, sourcePostId: v.sourcePostId });
        return div;
    }

    /**
     * Update navigation visibility based on user role
     */
    async updateNavigation() {
        let isAdmin = false;
        let uid = null;
        try {
            uid = (await this.resolveCurrentUserWithRetry(2500))?.uid
                || window.firebaseService?.auth?.currentUser?.uid
                || window.authManager?.currentUser?.id
                || window.authManager?.currentUser?.uid;
            if (!uid) {
                try {
                    const u = JSON.parse(localStorage.getItem('liber_current_user') || '{}');
                    uid = u?.id || u?.uid;
                } catch (_) {}
                this._isAdminSession = false;
            }
            if (uid && window.firebaseService?.getUserData) {
                const data = await window.firebaseService.getUserData(uid);
                const role = String(data?.role || '').toLowerCase();
                isAdmin = role === 'admin';
                // Sync authManager and localStorage with current Firebase user so they match the session
                try {
                    const userPayload = { id: uid, uid, role, username: data?.username || '', email: data?.email || '' };
                    if (window.authManager) {
                        if (!window.authManager.currentUser) window.authManager.currentUser = {};
                        window.authManager.currentUser.role = role || 'user';
                        window.authManager.currentUser.id = window.authManager.currentUser.uid = uid;
                        window.authManager.currentUser.username = userPayload.username;
                        window.authManager.currentUser.email = userPayload.email;
                    }
                    const u = { ...userPayload, role: role || 'user' };
                    localStorage.setItem('liber_current_user', JSON.stringify(u));
                    const sess = localStorage.getItem('liber_session');
                    if (sess) {
                        try {
                            const s = JSON.parse(sess);
                            if (s?.user) { s.user = { ...s.user, ...u }; localStorage.setItem('liber_session', JSON.stringify(s)); }
                        } catch (_) {}
                    }
                } catch (_) {}
            }
            // Only trust authManager if it matches current uid (avoid stale admin after account switch)
            const amUid = window.authManager?.currentUser?.id || window.authManager?.currentUser?.uid;
            if (!isAdmin && amUid === uid && window.authManager?.isAdmin?.()) isAdmin = true;
        } catch (_) {}
        document.querySelectorAll('.admin-only').forEach((el) => { el.style.display = isAdmin ? '' : 'none'; });
        this._isAdminSession = isAdmin;
        if (!isAdmin && (this.currentSection === 'users' || this.currentSection === 'settings')){
            this.switchSection('apps');
        }
        if (window.appsManager && typeof window.appsManager.filterApps === 'function') {
            try { window.appsManager.filterApps(); window.appsManager.renderApps(); } catch (_) {}
        }
    }

    restoreChatUnreadBadgeFromStorage(){
        try{
            const raw = localStorage.getItem('liber_chat_unread_count');
            const count = raw ? parseInt(raw, 10) : 0;
            const badge = document.getElementById('dashboard-chat-unread-badge');
            if (!badge) return;
            if (Number.isFinite(count) && count > 0){
                badge.textContent = String(count > 99 ? '99+' : count);
                badge.classList.remove('hidden');
                badge.removeAttribute('aria-hidden');
            } else {
                badge.classList.add('hidden');
                badge.setAttribute('aria-hidden', 'true');
            }
        }catch(_){ }
    }

    /**
     * Load overview data
     */
    async loadOverview() {
        // Overview removed – no-op to avoid errors
        return;
    }

    /**
     * Get apps count
     */
    async getAppsCount() {
        try {
            if (window.appsManager) {
                const apps = await window.appsManager.getApps();
                return apps.length;
            }
            return 0;
        } catch (error) {
            console.error('Error getting apps count:', error);
            return 0;
        }
    }

    /**
     * Get users count
     */
    async getUsersCount() {
        try {
            if (window.firebaseService && window.firebaseService.isFirebaseAvailable()) {
                const stats = await window.firebaseService.getUserStats();
                return `${stats.total} (${stats.pending} pending)`;
            } else {
                const users = await authManager.getUsers();
                return users.length + 1; // +1 for admin
            }
        } catch (error) {
            console.error('Error getting users count:', error);
            return '0';
        }
    }

    /**
     * Format date for display
     */
    formatDate(date) {
        const now = new Date();
        const diff = now - date;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;

        return date.toLocaleDateString();
    }

    /**
     * Setup settings handlers
     */
    setupSettingsHandlers() {
        // Session timeout
        const sessionTimeout = document.getElementById('session-timeout');
        if (sessionTimeout) {
            sessionTimeout.addEventListener('change', (e) => {
                const value = parseInt(e.target.value);
                if (value >= 5 && value <= 480) {
                    authManager.sessionTimeout = value * 60 * 1000;
                    this.saveSettings();
                }
            });
        }

        // Auto-refresh apps
        const autoRefreshApps = document.getElementById('auto-refresh-apps');
        if (autoRefreshApps) {
            autoRefreshApps.addEventListener('change', () => {
                this.saveSettings();
            });
        }

        // Show app descriptions
        const showAppDescriptions = document.getElementById('show-app-descriptions');
        if (showAppDescriptions) {
            showAppDescriptions.addEventListener('change', () => {
                this.saveSettings();
            });
        }

        // Enable 2FA
        const enable2FA = document.getElementById('enable-2fa');
        if (enable2FA) {
            enable2FA.addEventListener('change', () => {
                this.saveSettings();
            });
        }

        // Secure keys settings
        this.setupSecureKeysHandlers();

        // Profile Force reload handler (user only)
        const profileForceBtn = document.getElementById('profile-force-reload-btn');
        if (profileForceBtn){
            profileForceBtn.onclick = async ()=>{
                const ok = await this.showConfirm(
`You will log out and force reload the LIBER App.
This will clear cached files (including Service Worker caches) to align with the most recent version of the app and reload all pages.
Do you want to proceed?`);
                if (!ok) return;
                await this.forceHardReload();
            };
        }
    }

    /**
     * Load profile info and bind actions
     */
    getDefaultLanguageForCountry(countryCode){
        const c = String(countryCode || '').trim().toUpperCase();
        const map = {
            US:'en', GB:'en',
            DE:'de', FR:'fr', ES:'es', IT:'it', PT:'pt', NL:'nl', PL:'pl',
            UA:'uk', RU:'ru', TR:'tr',
            IN:'hi', AE:'ar',
            JP:'ja', KR:'ko', CN:'zh',
            BR:'pt', MX:'es'
        };
        return map[c] || 'en';
    }

    applyAppLanguage(langCode){
        try{
            const lang = String(langCode || 'en').trim().toLowerCase() || 'en';
            document.documentElement.lang = lang;
            try{ localStorage.setItem('liber_preferred_language', lang); }catch(_){ }
            const dict = {
                en: {
                    waveconnect:'WaveConnect', profile:'My Profile', users:'User Management', settings:'Settings',
                    account:'Account', changePassword:'Change Password', connections:'Connections', username:'Username',
                    country:'Country', accountLanguage:'Account language', saveLanguageCountry:'Save Language & Country',
                    forceReload:'Force Reload', updatePassword:'Update Password',
                    tabAudio:'Audio', tabVideo:'Video', tabPictures:'Pictures',
                    subHome:'Home', subSearch:'Search', subLibrary:'Library', quickStudio:'Studio', quickUpload:'Upload',
                    myLibraryTitle:'My Library', libraryAll:'All', libraryUploaded:'Uploaded', librarySaved:'Saved', libraryLiked:'Liked', libraryPlaylists:'Playlists',
                    playAll:'Play all', shuffle:'Shuffle',
                    navApps:'Apps', navSpace:'Personal Space', navWall:'Wall', navWaveconnect:'WaveConnect', navProfile:'My Profile', navUsers:'User Management', navSettings:'Settings'
                },
                es: {
                    waveconnect:'WaveConnect', profile:'Mi Perfil', users:'Gestión de usuarios', settings:'Configuración',
                    account:'Cuenta', changePassword:'Cambiar contraseña', connections:'Conexiones', username:'Nombre de usuario',
                    country:'País', accountLanguage:'Idioma de la cuenta', saveLanguageCountry:'Guardar idioma y país',
                    forceReload:'Recarga forzada', updatePassword:'Actualizar contraseña',
                    tabAudio:'Audio', tabVideo:'Video', tabPictures:'Imágenes',
                    subHome:'Inicio', subSearch:'Buscar', subLibrary:'Biblioteca', quickStudio:'Studio', quickUpload:'Subir',
                    myLibraryTitle:'Mi biblioteca', libraryAll:'Todo', libraryUploaded:'Subido', librarySaved:'Guardado', libraryLiked:'Me gusta', libraryPlaylists:'Listas',
                    playAll:'Reproducir todo', shuffle:'Aleatorio',
                    navApps:'Aplicaciones', navSpace:'Espacio personal', navWall:'Muro', navWaveconnect:'WaveConnect', navProfile:'Mi perfil', navUsers:'Gestión de usuarios', navSettings:'Configuración'
                },
                fr: {
                    waveconnect:'WaveConnect', profile:'Mon Profil', users:'Gestion des utilisateurs', settings:'Paramètres',
                    account:'Compte', changePassword:'Changer le mot de passe', connections:'Connexions', username:'Nom utilisateur',
                    country:'Pays', accountLanguage:'Langue du compte', saveLanguageCountry:'Enregistrer langue et pays',
                    forceReload:'Rechargement forcé', updatePassword:'Mettre à jour le mot de passe',
                    tabAudio:'Audio', tabVideo:'Vidéo', tabPictures:'Images',
                    subHome:'Accueil', subSearch:'Recherche', subLibrary:'Bibliothèque', quickStudio:'Studio', quickUpload:'Téléverser',
                    myLibraryTitle:'Ma bibliothèque', libraryAll:'Tout', libraryUploaded:'Importé', librarySaved:'Enregistré', libraryLiked:'Aimé', libraryPlaylists:'Playlists',
                    playAll:'Tout lire', shuffle:'Aléatoire',
                    navApps:'Applications', navSpace:'Espace personnel', navWall:'Mur', navWaveconnect:'WaveConnect', navProfile:'Mon profil', navUsers:'Gestion des utilisateurs', navSettings:'Paramètres'
                },
                ru: {
                    waveconnect:'WaveConnect', profile:'Мой профиль', users:'Управление пользователями', settings:'Настройки',
                    account:'Аккаунт', changePassword:'Смена пароля', connections:'Контакты', username:'Имя пользователя',
                    country:'Страна', accountLanguage:'Язык аккаунта', saveLanguageCountry:'Сохранить язык и страну',
                    forceReload:'Принудительная перезагрузка', updatePassword:'Обновить пароль',
                    tabAudio:'Аудио', tabVideo:'Видео', tabPictures:'Картинки',
                    subHome:'Главная', subSearch:'Поиск', subLibrary:'Библиотека', quickStudio:'Студия', quickUpload:'Загрузка',
                    myLibraryTitle:'Моя библиотека', libraryAll:'Все', libraryUploaded:'Загружено', librarySaved:'Сохранено', libraryLiked:'Нравится', libraryPlaylists:'Плейлисты',
                    playAll:'Воспроизвести все', shuffle:'Перемешать',
                    navApps:'Приложения', navSpace:'Личное пространство', navWall:'Лента', navWaveconnect:'WaveConnect', navProfile:'Мой профиль', navUsers:'Управление пользователями', navSettings:'Настройки'
                }
            };
            const t = dict[lang] || dict.en;
            const waveH = document.querySelector('#waveconnect-section .section-header h2');
            const profileH = document.querySelector('#profile-section .section-header h2');
            const usersH = document.querySelector('#users-section .section-header h2');
            const settingsH = document.querySelector('#settings-section .section-header h2');
            if (waveH) waveH.textContent = t.waveconnect;
            if (profileH) profileH.textContent = t.profile;
            if (usersH) usersH.textContent = t.users;
            if (settingsH) settingsH.textContent = t.settings;
            const accountCardTitle = document.querySelector('#profile-section .settings-card h3');
            const passCardTitle = document.querySelector('#profile-section .settings-card:nth-child(2) h3');
            const connCardTitle = document.querySelector('#space-connections-card h3');
            if (accountCardTitle) accountCardTitle.textContent = t.account;
            if (passCardTitle) passCardTitle.textContent = t.changePassword;
            if (connCardTitle) connCardTitle.textContent = t.connections;
            const usernameLabel = document.querySelector('label[for="profile-username"]');
            const countryLabel = document.querySelector('label[for="profile-country"]');
            const langLabel = document.querySelector('label[for="profile-language"]');
            if (usernameLabel) usernameLabel.textContent = t.username;
            if (countryLabel) countryLabel.textContent = t.country;
            if (langLabel) langLabel.textContent = t.accountLanguage;
            const saveLangBtn = document.getElementById('save-language-country-btn');
            const reloadBtn = document.getElementById('profile-force-reload-btn');
            const passBtn = document.getElementById('change-password-btn');
            if (saveLangBtn) saveLangBtn.textContent = t.saveLanguageCountry;
            if (reloadBtn) reloadBtn.textContent = t.forceReload;
            if (passBtn) passBtn.textContent = t.updatePassword;
            const waveAudio = document.getElementById('wave-tab-audio');
            const waveVideo = document.getElementById('wave-tab-video');
            const wavePictures = document.getElementById('wave-tab-pictures');
            if (waveAudio) waveAudio.innerHTML = `<i class="fas fa-music"></i> ${t.tabAudio}`;
            if (waveVideo) waveVideo.innerHTML = `<i class="fas fa-video"></i> ${t.tabVideo}`;
            if (wavePictures) wavePictures.innerHTML = `<i class="fas fa-image"></i> ${t.tabPictures}`;
            const studioQuick = document.getElementById('wave-studio-btn');
            if (studioQuick){ studioQuick.title = t.quickStudio; studioQuick.setAttribute('aria-label', t.quickStudio); }
            const mobileUploadBtn = document.getElementById('mobile-wave-upload-btn');
            if (mobileUploadBtn){ mobileUploadBtn.title = t.quickUpload; mobileUploadBtn.setAttribute('aria-label', t.quickUpload); }
            const subMap = {
                home: t.subHome,
                search: t.subSearch,
                library: t.subLibrary
            };
            document.querySelectorAll('#wave-subnav [data-wave-subtab]').forEach((btn)=>{
                const key = String(btn.getAttribute('data-wave-subtab') || '').trim().toLowerCase();
                if (subMap[key]){
                    btn.title = subMap[key];
                    btn.setAttribute('aria-label', subMap[key]);
                }
            });
            this._activeUiLanguage = lang;
            this._activeUiDict = t;
            this.applyDynamicTranslations(document.body);
            this.ensureTranslationObserver();
            try{
                // Hybrid i18n: keep curated labels + auto-translate all remaining UI chrome.
                const root = document.body;
                window.LiberAutoUiTranslator?.translateRoot?.(root, lang);
            }catch(_){ }
            try{ window.secureChatApp?.applyChatLanguage?.(lang); }catch(_){ }
        }catch(_){ }
    }

    ensureTranslationObserver(){
        try{
            if (this._translationObserver || !window.MutationObserver) return;
            this._translationObserver = new MutationObserver((mutations)=>{
                mutations.forEach((m)=>{
                    m.addedNodes?.forEach?.((n)=>{
                        if (!(n instanceof Element)) return;
                        this.applyDynamicTranslations(n);
                        try{
                            if (this._activeUiLanguage){
                                window.LiberAutoUiTranslator?.translateRoot?.(n, this._activeUiLanguage);
                            }
                        }catch(_){ }
                    });
                });
            });
            this._translationObserver.observe(document.body, { childList: true, subtree: true });
        }catch(_){ }
    }

    applyDynamicTranslations(root){
        try{
            const dict = this._activeUiDict || null;
            if (!dict || !root) return;
            const applyTo = (el)=>{
                const key = String(el.getAttribute('data-i18n') || '').trim();
                const pKey = String(el.getAttribute('data-i18n-placeholder') || '').trim();
                const tKey = String(el.getAttribute('data-i18n-title') || '').trim();
                if (key && dict[key]) el.textContent = dict[key];
                if (pKey && dict[pKey]) el.setAttribute('placeholder', dict[pKey]);
                if (tKey && dict[tKey]){
                    el.setAttribute('title', dict[tKey]);
                    el.setAttribute('aria-label', dict[tKey]);
                }
            };
            if (root instanceof Element){
                applyTo(root);
                root.querySelectorAll('[data-i18n],[data-i18n-placeholder],[data-i18n-title]').forEach(applyTo);
            }
        }catch(_){ }
    }

    async loadProfile() {
        try {
            // Wait for firebase
            if (window.firebaseService && window.firebaseService.isFirebaseAvailable()) {
                const user = await window.firebaseService.getCurrentUser();
                if (!user) return;
                const data = await window.firebaseService.getUserData(user.uid) || {};
                const emailEl = document.getElementById('profil-email');
                const unameEl = document.getElementById('profile-username');
                const verifiedEl = document.getElementById('profile-verified');
                const allowUnconnectedEl = document.getElementById('profile-allow-unconnected-msg');
                const countryEl = document.getElementById('profile-country');
                const langEl = document.getElementById('profile-language');
                if (emailEl) emailEl.value = user.email;
                if (unameEl) unameEl.value = data.username || '';
                if (verifiedEl) verifiedEl.textContent = user.emailVerified ? 'Verified' : 'Not verified';
                if (allowUnconnectedEl) allowUnconnectedEl.checked = data.allowMessagesFromUnconnected !== false;
                if (countryEl) countryEl.value = String(data.country || '').toUpperCase();
                if (langEl){
                    const remembered = String(localStorage.getItem('liber_preferred_language') || '').trim().toLowerCase();
                    langEl.value = String(data.language || remembered || 'en').toLowerCase();
                    this.applyAppLanguage(langEl.value);
                }

                const saveBtn = document.getElementById('save-username-btn');
                if (saveBtn) {
                    saveBtn.onclick = async () => {
                        try {
                            const newName = document.getElementById('profile-username').value.trim();
                            if (!newName) return this.showError('Username cannot be empty');
                            await window.firebaseService.updateUserProfile(user.uid, { username: newName });
                            this.showSuccess('Username updated');
                        } catch (e) {
                            this.showError('Failed to update username');
                        }
                    };
                }

                const rvBtn = document.getElementById('resend-verify-btn');
                if (rvBtn) {
                    rvBtn.style.display = user.emailVerified ? 'none' : 'inline-flex';
                    rvBtn.onclick = async () => {
                        try { await window.firebaseService.sendEmailVerification(); this.showSuccess('Verification email sent. The letter may appear in your spam folder.'); }
                        catch { this.showError('Failed to send verification'); }
                    };
                }
                if (allowUnconnectedEl) {
                    allowUnconnectedEl.onchange = async () => {
                        try {
                            await window.firebaseService.updateUserProfile(user.uid, {
                                allowMessagesFromUnconnected: !!allowUnconnectedEl.checked
                            });
                        } catch (_) {
                            this.showError('Failed to update message privacy');
                        }
                    };
                }
                if (countryEl && langEl){
                    countryEl.onchange = ()=>{
                        const suggested = this.getDefaultLanguageForCountry(countryEl.value);
                        if (!langEl.value || langEl.value === 'en') langEl.value = suggested;
                    };
                }
                const saveLangCountryBtn = document.getElementById('save-language-country-btn');
                if (saveLangCountryBtn && countryEl && langEl){
                    saveLangCountryBtn.onclick = async ()=>{
                        try{
                            const country = String(countryEl.value || '').toUpperCase();
                            const language = String(langEl.value || 'en').toLowerCase();
                            await window.firebaseService.updateUserProfile(user.uid, { country, language });
                            try{
                                localStorage.setItem('liber_preferred_language', language);
                                localStorage.setItem('liber_preferred_country', country);
                                localStorage.setItem('liber_chat_translate_target', language);
                            }catch(_){ }
                            this.applyAppLanguage(language);
                            this.showSuccess('Language and country saved');
                        }catch(_){
                            this.showError('Failed to save language/country');
                        }
                    };
                }

                // Add Link Google Account button if missing
                const profileCard = document.querySelector('#profile-section .settings-card');
                if (profileCard && !document.getElementById('link-google-btn')){
                    const wrap = document.createElement('div');
                    wrap.className = 'setting-item';
                    wrap.innerHTML = '<label>Google</label><button id="link-google-btn" class="btn btn-secondary">Link Google Account</button>';
                    profileCard.appendChild(wrap);
                    const linkBtn = document.getElementById('link-google-btn');
                    if (linkBtn){ linkBtn.onclick = ()=>{ if (window.authManager && typeof window.authManager.linkGoogleAccount==='function'){ window.authManager.linkGoogleAccount(); } }; }
                }

                const chBtn = document.getElementById('change-password-btn');
                if (chBtn) {
                    chBtn.onclick = async () => {
                        const curr = (document.getElementById('current-password').value || '').trim();
                        const np = (document.getElementById('new-password').value || '').trim();
                        const cnp = (document.getElementById('confirm-new-password').value || '').trim();
                        if (!curr || !np || !cnp) return this.showError('Please fill all fields');
                        if (np !== cnp) return this.showError('Passwords do not match');
                        try {
                            // Re-authenticate
                            const cred = firebase.EmailAuthProvider.credential(user.email, curr);
                            await firebase.reauthenticateWithCredential(user, cred);
                            await firebase.updatePassword(user, np);
                            this.showSuccess('Password updated');
                            document.getElementById('current-password').value='';
                            document.getElementById('new-password').value='';
                            document.getElementById('confirm-new-password').value='';
                        } catch (e) {
                            this.showError('Failed to update password');
                        }
                    };
                }
            }
        } catch (e) {
            console.error('Profile load error', e);
        }
    }

    /**
     * Setup secure keys handlers
     */
    setupSecureKeysHandlers() {
        // Load saved secure keys URL
        this.loadSecureKeysUrl();

        // Test keys connection
        const testKeysBtn = document.getElementById('test-keys-btn');
        if (testKeysBtn) {
            testKeysBtn.addEventListener('click', async () => {
                await this.testKeysConnection();
            });
        }

        // Clear key cache
        const clearCacheBtn = document.getElementById('clear-key-cache-btn');
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener('click', () => {
                this.clearKeyCache();
            });
        }

        // Clear all encrypted data
        const clearEncryptedDataBtn = document.getElementById('clear-encrypted-data-btn');
        if (clearEncryptedDataBtn) {
            clearEncryptedDataBtn.addEventListener('click', () => {
                this.clearAllEncryptedData();
            });
        }

        // Save Secure Keys URL
        const secureKeysUrlInput = document.getElementById('secure-keys-url');
        if (secureKeysUrlInput) {
            secureKeysUrlInput.addEventListener('change', () => {
                this.saveSecureKeysUrl();
            });
        }

        // Key cache duration
        const keyCacheDuration = document.getElementById('key-cache-duration');
        if (keyCacheDuration) {
            keyCacheDuration.addEventListener('change', () => {
                this.saveKeyCacheDuration();
            });
        }
    }

    /**
     * Load secure keys URL from localStorage
     */
    loadSecureKeysUrl() {
        const urlInput = document.getElementById('secure-keys-url');
        if (urlInput) {
            const savedUrl = localStorage.getItem('liber_keys_url');
            if (savedUrl) {
                urlInput.value = savedUrl;
            }
        }
    }

    /**
     * Test keys connection
     */
    async testKeysConnection() {
        const testBtn = document.getElementById('test-keys-btn');
        const originalText = testBtn.innerHTML;
        
        try {
            testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
            testBtn.disabled = true;

            const result = await window.secureKeyManager.testConnection();
            
            if (result.success) {
                this.showSuccess('✅ Keys connection successful!');
            } else {
                this.showError(`❌ Connection failed: ${result.message}`);
            }
        } catch (error) {
            this.showError(`❌ Test failed: ${error.message}`);
        } finally {
            testBtn.innerHTML = originalText;
            testBtn.disabled = false;
        }
    }

    /**
     * Clear key cache
     */
    clearKeyCache() {
        window.secureKeyManager.clearCache();
        this.showSuccess('🗑️ Key cache cleared successfully!');
    }

    /**
     * Clear all encrypted data
     */
    clearAllEncryptedData() {
        if (confirm('This will clear all user data, sessions, and encrypted information. This action cannot be undone. Continue?')) {
            window.secureKeyManager.clearAllEncryptedData();
            this.showSuccess('🗑️ All encrypted data cleared successfully!');
            
            // Redirect to login after a short delay
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        }
    }

    /**
     * Save Secure Keys URL
     */
    saveSecureKeysUrl() {
        const urlInput = document.getElementById('secure-keys-url');
        const url = urlInput.value.trim();
        
        if (url) {
            window.secureKeyManager.setKeySource(url);
            this.showSuccess('💾 Secure Keys URL saved!');
        }
    }

    /**
     * Save key cache duration
     */
    saveKeyCacheDuration() {
        const durationInput = document.getElementById('key-cache-duration');
        const duration = parseInt(durationInput.value);
        
        if (duration >= 5 && duration <= 120) {
            window.secureKeyManager.keyCacheExpiry = duration * 60 * 1000;
            this.showSuccess('⏱️ Cache duration updated!');
        }
    }

    /**
     * Load settings
     */
    loadSettings() {
        try {
            const settings = this.getSettings();
            
            // Apply settings to form elements
            const sessionTimeout = document.getElementById('session-timeout');
            if (sessionTimeout) {
                sessionTimeout.value = Math.floor(settings.sessionTimeout / 60000);
            }

            const autoRefreshApps = document.getElementById('auto-refresh-apps');
            if (autoRefreshApps) {
                autoRefreshApps.checked = settings.autoRefreshApps;
            }

            const showAppDescriptions = document.getElementById('show-app-descriptions');
            if (showAppDescriptions) {
                showAppDescriptions.checked = settings.showAppDescriptions;
            }

            const enable2FA = document.getElementById('enable-2fa');
            if (enable2FA) {
                enable2FA.checked = settings.enable2FA;
            }

        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    /**
     * Save settings
     */
    saveSettings() {
        try {
            const stEl = document.getElementById('session-timeout');
            const autoEl = document.getElementById('auto-refresh-apps');
            const showDescEl = document.getElementById('show-app-descriptions');
            const twoFaEl = document.getElementById('enable-2fa');

            // If settings UI is not rendered on this page, silently skip
            if (!stEl && !autoEl && !showDescEl && !twoFaEl) {
                return;
            }

            const sessionTimeout = stEl ? (parseInt(stEl.value || '30') * 60000) : (authManager?.sessionTimeout || 30*60*1000);
            const settings = {
                sessionTimeout,
                autoRefreshApps: !!(autoEl && autoEl.checked),
                showAppDescriptions: !!(showDescEl && showDescEl.checked),
                enable2FA: !!(twoFaEl && twoFaEl.checked),
                lastUpdated: new Date().toISOString()
            };

            localStorage.setItem('liber_settings', JSON.stringify(settings));
            
            // Apply session timeout change
            if (authManager.currentUser) {
                authManager.startSessionTimer();
            }

            // Only show toast if UI exists
            if (stEl || autoEl || showDescEl || twoFaEl) this.showSuccess('Settings saved successfully');
        } catch (error) {
            // Do not alert on pages without settings UI
            console.warn('Skipped saving settings:', error?.message || error);
        }
    }

    /**
     * Get settings
     */
    getSettings() {
        try {
            const settings = localStorage.getItem('liber_settings');
            if (settings) {
                return JSON.parse(settings);
            }
        } catch (error) {
            console.error('Error getting settings:', error);
        }

        // Default settings
        return {
            sessionTimeout: 30 * 60 * 1000, // 30 minutes
            autoRefreshApps: true,
            showAppDescriptions: true,
            enable2FA: false,
            lastUpdated: new Date().toISOString()
        };
    }

    /**
     * Show success message
     */
    showSuccess(message) {
        this.showNotification(message, 'success');
    }

    /**
     * Show error message
     */
    showError(message) {
        this.showNotification(message, 'error');
    }

    /**
     * Show info message
     */
    showInfo(message) {
        this.showNotification(message, 'info');
    }

    /**
     * Show notification
     */
    showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <div class="notification-content">
                <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
                <span>${message}</span>
            </div>
            <button class="notification-close">&times;</button>
        `;

        // Add styles
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--${type === 'success' ? 'success' : type === 'error' ? 'error' : 'accent'}-color);
            color: var(--primary-bg);
            padding: 12px 20px;
            border-radius: var(--border-radius);
            box-shadow: var(--shadow-hover);
            z-index: 10000;
            display: flex;
            align-items: center;
            gap: 12px;
            max-width: 400px;
            animation: slideIn 0.3s ease-out;
        `;

        // Add to page
        document.body.appendChild(notification);

        // Setup close button
        const closeBtn = notification.querySelector('.notification-close');
        closeBtn.addEventListener('click', () => {
            notification.remove();
        });

        // Auto remove after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
    }

    async showConfirm(message){
        return new Promise((resolve)=>{
            // Simple modal
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:10000';
            modal.innerHTML = `
                <div style="background:#0f1116;border:1px solid #333;border-radius:12px;padding:20px;max-width:420px;width:90%;color:#eaeaea;box-shadow:0 10px 30px rgba(0,0,0,.5)">
                    <div style="margin-bottom:14px;white-space:pre-wrap">${message.replace(/</g,'&lt;')}</div>
                    <div style="display:flex;gap:10px;justify-content:flex-end">
                        <button id="confirm-no" class="btn btn-secondary">No</button>
                        <button id="confirm-yes" class="btn btn-primary">Yes</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            modal.querySelector('#confirm-no').onclick = ()=>{ modal.remove(); resolve(false); };
            modal.querySelector('#confirm-yes').onclick = ()=>{ modal.remove(); resolve(true); };
        });
    }

    async forceHardReload(){
        try {
            if (window.authManager) await window.authManager.logout();
        } catch(_) {}

        // Preserve secure keys URL if present
        let keysUrl = null;
        try { keysUrl = localStorage.getItem('liber_keys_url'); } catch(_){ keysUrl = null; }

        // Unregister all service workers
        try{
            if ('serviceWorker' in navigator){
                const regs = await navigator.serviceWorker.getRegistrations();
                for (const r of regs){ try { await r.unregister(); } catch(_){} }
            }
        }catch(_){ }

        // Clear Cache Storage
        try{
            if (window.caches && caches.keys){
                const names = await caches.keys();
                await Promise.all(names.map(n=> caches.delete(n)));
            }
        }catch(_){ }

        // Clear local/session storage (restore keys URL afterwards)
        try { sessionStorage.clear(); } catch(_){}
        try { localStorage.clear(); } catch(_){}
        try { if (keysUrl) localStorage.setItem('liber_keys_url', keysUrl); } catch(_){}

        // Bypass cache on reload
        const href = window.location.pathname + '?reload=' + Date.now();
        window.location.replace(href);
    }

    /**
     * Refresh dashboard data
     */
    async refreshDashboard() {
        await this.loadOverview();
        this.showSuccess('Dashboard refreshed');
    }

    /**
     * Get current section
     */
    getCurrentSection() {
        return this.currentSection;
    }

    /**
     * Check if user has permission for section
     */
    hasPermission(section) {
        const currentUser = authManager.getCurrentUser();
        if (!currentUser) return false;

        // Admin can access all sections
        if (currentUser.role === 'admin') return true;

        // Regular users can only access overview and apps
        return ['overview', 'apps'].includes(section);
    }

    /**
     * Handle keyboard shortcuts
     */
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Only handle shortcuts when not in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Ctrl/Cmd + R to refresh
            if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
                e.preventDefault();
                this.refreshDashboard();
            }

            // Number keys for navigation
            if (e.key >= '1' && e.key <= '4') {
                const sections = ['overview', 'apps', 'users', 'settings'];
                const sectionIndex = parseInt(e.key) - 1;
                if (sections[sectionIndex] && this.hasPermission(sections[sectionIndex])) {
                    this.switchSection(sections[sectionIndex]);
                }
            }
        });
    }

    /**
     * Toggle WALL-E widget
     */
    toggleWallEWidget() {
        console.log('Dashboard WALL-E toggle button clicked!');
        
        // Check if we're on mobile
        if (window.innerWidth <= 768) {
            // Use the exact same logic as login page
            const widget = document.querySelector('.chatgpt-widget');
            const isWidgetActive = widget && widget.classList.contains('mobile-activated');
            
            if (isWidgetActive) {
                // Widget is active, hide it
                console.log('Hiding WALL-E widget on dashboard...');
                widget.classList.remove('mobile-activated');
                
                // Update mobile WALL-E button state
                const mobileWallEBtn = document.getElementById('mobile-wall-e-btn');
                if (mobileWallEBtn) {
                    mobileWallEBtn.classList.remove('active');
                }
            } else {
                // Widget is not active, show it
                console.log('Showing WALL-E widget on dashboard...');
                
                // Wait for WALL-E widget to be initialized (same as login page)
                this.waitForWidgetAndShow();
            }
        } else {
            // On desktop, use the normal toggle
            if (window.wallE && typeof window.wallE.toggleChat === 'function') {
                console.log('Toggling WALL-E widget on desktop...');
                window.wallE.toggleChat();
            } else {
                console.warn('WALL-E widget not available on desktop');
            }
        }
    }

    /**
     * Wait for widget to be available and then show it (same logic as login page)
     */
    async waitForWidgetAndShow() {
        let attempts = 0;
        const maxAttempts = 30;
        
        while ((!window.wallE || !document.querySelector('.chatgpt-widget')) && attempts < maxAttempts) {
            console.log(`Waiting for WALL-E widget... attempt ${attempts + 1}`);
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        if (!window.wallE) {
            console.error('WALL-E widget not available after waiting');
            return;
        }
        
        // Force create widget if it doesn't exist
        let widgetToShow = document.querySelector('.chatgpt-widget');
        if (!widgetToShow && window.wallE.createChatInterface) {
            console.log('Forcing widget creation...');
            window.wallE.createChatInterface();
            widgetToShow = document.querySelector('.chatgpt-widget');
        }
        
        if (widgetToShow) {
            console.log('WALL-E widget found, showing it...');
            
            // Use CSS class instead of inline styles for better compatibility
            widgetToShow.classList.add('mobile-activated');
            
            // Expand the widget
            if (window.wallE && typeof window.wallE.expandChat === 'function') {
                console.log('Expanding WALL-E widget...');
                window.wallE.expandChat();
            }
            
            // Update mobile WALL-E button state
            const mobileWallEBtn = document.getElementById('mobile-wall-e-btn');
            if (mobileWallEBtn) {
                mobileWallEBtn.classList.add('active');
            }
            
            console.log('WALL-E widget successfully activated on dashboard');
        } else {
            console.error('WALL-E widget element not found even after creation attempt');
        }
    }

    /**
     * Show WALL-E modal for mobile
     */
    showWallEModal() {
        // Create modal if it doesn't exist
        let modal = document.getElementById('wall-e-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'wall-e-modal';
            modal.className = 'wall-e-modal';
            modal.innerHTML = `
                <div class="wall-e-modal-content">
                                            <div class="wall-e-modal-header">
                            <h3><img src="images/wall_e.svg" alt="WALL-E" class="modal-icon"> WALL-E Assistant</h3>
                            <button class="wall-e-modal-close">&times;</button>
                        </div>
                    <div class="wall-e-modal-body">
                        <div class="wall-e-chat-container">
                            <div class="wall-e-messages" id="wall-e-messages">
                                <div class="wall-e-welcome">
                                    <img src="images/wall_e.svg" alt="WALL-E" class="welcome-icon">
                                    <h4>Wall-eeeee!</h4>
                                    <p>Any help?</p>
                                </div>
                            </div>
                            <div class="wall-e-input-area">
                                <div class="wall-e-file-upload" id="wall-e-file-upload">
                                    <button class="wall-e-upload-btn" id="wall-e-upload-btn">
                                        <i class="fas fa-paperclip"></i>
                                    </button>
                                    <input type="file" id="wall-e-file-input" multiple style="display: none;">
                                </div>
                                <div class="wall-e-input-container">
                                    <textarea id="wall-e-input" placeholder="Type your message..." rows="1"></textarea>
                                    <button class="wall-e-send" id="wall-e-send">
                                        <i class="fas fa-paper-plane"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            
            // Add event listeners
            const closeBtn = modal.querySelector('.wall-e-modal-close');
            closeBtn.addEventListener('click', () => this.hideWallEModal());
            
            const sendBtn = modal.querySelector('#wall-e-send');
            const input = modal.querySelector('#wall-e-input');
            const uploadBtn = modal.querySelector('#wall-e-upload-btn');
            const fileInput = modal.querySelector('#wall-e-file-input');
            
            sendBtn.addEventListener('click', () => this.sendWallEMessage());
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendWallEMessage();
                }
            });
            
            uploadBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', (e) => this.handleWallEFileUpload(e));
            
            // Add modal styles
            this.addWallEModalStyles();
        }
        
        // Show modal
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        
        // Focus on input
        setTimeout(() => {
            const input = modal.querySelector('#wall-e-input');
            if (input) input.focus();
        }, 100);
    }

    /**
     * Hide WALL-E modal
     */
    hideWallEModal() {
        const modal = document.getElementById('wall-e-modal');
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }
        
        // Update mobile WALL-E button state
        const mobileWallEBtn = document.getElementById('mobile-wall-e-btn');
        if (mobileWallEBtn) {
            mobileWallEBtn.classList.remove('active');
        }
    }

    /**
     * Send WALL-E message
     */
    async sendWallEMessage() {
        const input = document.getElementById('wall-e-input');
        const message = input.value.trim();
        
        if (!message || this._wallESending) return;
        this._wallESending = true;
        
        // Add user message to chat
        this.addWallEMessage('user', message);
        input.value = '';
        this.addWallEMessage('assistant', '...');
        
        // Call WALL-E API
        if (window.wallE && typeof window.wallE.callWALLE === 'function') {
            try {
                const response = await window.wallE.callWALLE(message);
                const msgs = document.querySelectorAll('#wall-e-messages .wall-e-message.assistant');
                const last = msgs[msgs.length - 1];
                if (last && last.textContent && last.textContent.includes('...')) last.remove();
                this.addWallEMessage('assistant', response);
            } catch (error) {
                const msgs = document.querySelectorAll('#wall-e-messages .wall-e-message.assistant');
                const last = msgs[msgs.length - 1];
                if (last && last.textContent && last.textContent.includes('...')) last.remove();
                this.addWallEMessage('error', 'Sorry, I encountered an error. Please try again.');
            }
        } else {
            const msgs = document.querySelectorAll('#wall-e-messages .wall-e-message.assistant');
            const last = msgs[msgs.length - 1];
            if (last && last.textContent && last.textContent.includes('...')) last.remove();
            this.addWallEMessage('assistant', 'Sorry, WALL-E is not available at the moment.');
        }
        this._wallESending = false;
    }

    /**
     * Add message to WALL-E chat
     */
    addWallEMessage(type, content) {
        const messagesContainer = document.getElementById('wall-e-messages');
        if (!messagesContainer) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `wall-e-message ${type}`;
        
        const avatar = document.createElement('div');
        avatar.className = 'wall-e-avatar';
                    avatar.innerHTML = type === 'user' ? '<i class="fas fa-user"></i>' : '<img src="images/wall_e.svg" alt="WALL-E" class="avatar-icon">';
        
        const textDiv = document.createElement('div');
        textDiv.className = 'wall-e-text';
        textDiv.textContent = content;
        
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(textDiv);
        messagesContainer.appendChild(messageDiv);
        
        // Scroll to bottom
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * Handle WALL-E file upload
     */
    handleWallEFileUpload(event) {
        const files = Array.from(event.target.files);
        // Handle file upload logic here
        console.log('Files selected:', files);
    }

    /**
     * Add WALL-E modal styles
     */
    addWallEModalStyles() {
        if (document.getElementById('wall-e-modal-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'wall-e-modal-styles';
        style.textContent = `
            .wall-e-modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.8);
                z-index: 10000;
                display: none;
                align-items: center;
                justify-content: center;
            }
            
            .wall-e-modal-content {
                background: #1a1a1a;
                border-radius: 12px;
                width: 90vw;
                max-width: 500px;
                height: 80vh;
                max-height: 600px;
                display: flex;
                flex-direction: column;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            }
            
            .wall-e-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                background: #007bff;
                color: white;
                border-radius: 12px 12px 0 0;
            }
            
            .wall-e-modal-header h3 {
                margin: 0;
                font-size: 16px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .wall-e-modal-close {
                background: none;
                border: none;
                color: white;
                font-size: 24px;
                cursor: pointer;
                padding: 0;
                width: 30px;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .wall-e-modal-body {
                flex: 1;
                display: flex;
                flex-direction: column;
                background: #1a1a1a;
                border-radius: 0 0 12px 12px;
            }
            
            .wall-e-chat-container {
                flex: 1;
                display: flex;
                flex-direction: column;
                height: 100%;
            }
            
            .wall-e-messages {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            
            .wall-e-welcome {
                text-align: center;
                padding: 20px;
                color: #888;
            }
            
            .wall-e-welcome i {
                font-size: 2rem;
                margin-bottom: 12px;
                color: #007bff;
            }
            
            .wall-e-welcome h4 {
                margin: 0 0 8px 0;
                color: #fff;
            }
            
            .wall-e-message {
                display: flex;
                gap: 8px;
                max-width: 100%;
            }
            
            .wall-e-message.user {
                flex-direction: row-reverse;
            }
            
            .wall-e-avatar {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                font-size: 14px;
            }
            
            .wall-e-message.user .wall-e-avatar {
                background: #007bff;
                color: white;
            }
            
            .wall-e-message.assistant .wall-e-avatar {
                background: #333;
                color: #007bff;
            }
            
            .wall-e-text {
                padding: 10px 14px;
                border-radius: 12px;
                font-size: 14px;
                line-height: 1.4;
                max-width: calc(100% - 40px);
            }
            
            .wall-e-message.user .wall-e-text {
                background: #007bff;
                color: white;
                border-bottom-right-radius: 4px;
            }
            
            .wall-e-message.assistant .wall-e-text {
                background: #333;
                color: #fff;
                border-bottom-left-radius: 4px;
            }
            
            .wall-e-input-area {
                border-top: 1px solid #333;
                padding: 16px;
                background: #1a1a1a;
                border-radius: 0 0 12px 12px;
            }
            
            .wall-e-file-upload {
                margin-bottom: 12px;
            }
            
            .wall-e-upload-btn {
                background: #333;
                border: 1px solid #555;
                color: #888;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
            }
            
            .wall-e-input-container {
                display: flex;
                gap: 8px;
                align-items: flex-end;
            }
            
            #wall-e-input {
                flex: 1;
                border: 1px solid #333;
                border-radius: 8px;
                padding: 10px 12px;
                background: #2a2a2a;
                color: #fff;
                font-size: 14px;
                resize: none;
                min-height: 20px;
                max-height: 120px;
                font-family: inherit;
            }
            
            #wall-e-input:focus {
                outline: none;
                border-color: #007bff;
            }
            
            .wall-e-send {
                background: #007bff;
                border: none;
                color: white;
                padding: 10px 12px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                min-width: 40px;
                min-height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .wall-e-send:hover {
                background: #0056b3;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Initialize keyboard shortcuts
     */
    initKeyboardShortcuts() {
        this.setupKeyboardShortcuts();
    }



    /**
     * Handle WALL-E widget positioning when entering dashboard
     */
    handleWallETransitionToDashboard() {
        const widget = document.querySelector('.chatgpt-widget');
        if (widget) {
            if (sessionStorage.getItem('wallE_activated_on_login') === 'true') {
                // Remove mobile-activated class
                widget.classList.remove('mobile-activated');
                
                // Reset widget positioning for dashboard
                widget.style.position = '';
                widget.style.bottom = '';
                widget.style.right = '';
                widget.style.width = '';
                widget.style.maxWidth = '';
                widget.style.zIndex = '';
                
                // Clear the session storage flag
                sessionStorage.removeItem('wallE_activated_on_login');
            }
            
            // Ensure widget is positioned correctly for dashboard on initial load
            if (window.innerWidth <= 768) {
                // On mobile dashboard, ensure proper positioning but keep hidden by default
                widget.style.bottom = '80px';
                widget.style.right = '10px';
                widget.style.width = 'calc(100vw - 20px)';
                widget.style.maxWidth = '350px';
                widget.style.display = 'none'; // Hidden by default on mobile
                widget.classList.remove('hidden');
                widget.classList.remove('mobile-activated'); // Ensure not activated
                
                // Update mobile button state to inactive
                const mobileWallEBtn = document.getElementById('mobile-wall-e-btn');
                if (mobileWallEBtn) {
                    mobileWallEBtn.classList.remove('active');
                }
                
                // Ensure WALL-E widget is collapsed on mobile
                if (window.wallE && typeof window.wallE.collapseChat === 'function') {
                    window.wallE.collapseChat();
                }
                
                console.log('WALL-E widget positioned for mobile dashboard - hidden by default');
            } else {
                // On desktop, use normal positioning and keep visible
                widget.style.display = 'block';
                widget.classList.remove('hidden');
                widget.classList.remove('mobile-activated'); // Ensure not activated
                console.log('WALL-E widget positioned for desktop dashboard on initial load');
            }
        }
    }

    // In searchUsers or loadSpace search handler
    async searchUsers(term) {
      // existing code ...
      filtered.forEach(u => {
        const li = document.createElement('li');
        li.innerHTML = `
          <img src="${u.avatarUrl || 'default-avatar.png'}" class="avatar" alt="${u.username}">
          <div>
            <div class="uname">${u.username}</div>
            <div class="email">${u.email}</div>
          </div>
        `;
        li.dataset.uid = u.uid || u.id || '';
        li.addEventListener('click', () => {
          this.showUserPreviewModal(u.uid || u.id || u);
        });
        resultsEl.appendChild(li);
      });
      // ... 
    }

    // User profile popup from search/connections.
    async showUserPreviewModal(u) {
      const uid = (u && (u.uid || u.id)) || u;
      if (!uid) return;
      const data = (u && u.username) ? u : ((await window.firebaseService.getUserData(uid)) || {});
      const me = await this.resolveCurrentUser();
      if (!me || !me.uid) return;
      this.ensurePreviewAddButtonStyles();
      const myVisualIndex = await this.getMyVisualLibraryIndex(me.uid);
      const popupUnsubs = [];
      const readConnState = async ()=>{
        try{
          const c = await firebase.getDoc(firebase.doc(window.firebaseService.db,'connections',me.uid,'peers',uid));
          if (!c.exists()) return { status: 'none', requestedBy: '', requestedTo: '' };
          const d = c.data() || {};
          return {
            status: d.status || ((d.requestedBy || d.requestedTo) ? 'pending' : 'connected'),
            requestedBy: d.requestedBy || '',
            requestedTo: d.requestedTo || ''
          };
        }catch(_){
          return { status: 'none', requestedBy: '', requestedTo: '' };
        }
      };
      const connectLabelFor = (state)=>{
        const isConnected = state.status === 'connected';
        const isOutgoingPending = state.status === 'pending' && state.requestedBy === me.uid;
        const isIncomingPending = state.status === 'pending' && state.requestedTo === me.uid;
        if (isConnected) return '<i class="fas fa-unlink"></i> Disconnect';
        if (isOutgoingPending) return '<i class="fas fa-hourglass-half"></i> Pending';
        if (isIncomingPending) return '<i class="fas fa-check"></i> Accept request';
        return '<i class="fas fa-link"></i> Connect';
      };
      let isFollowing = false;
      let connState = { status: 'none', requestedBy: '', requestedTo: '' };
      try { const following = await window.firebaseService.getFollowingIds(me.uid); isFollowing = (following || []).includes(uid); } catch(_) {}
      connState = await readConnState();
      const connectLabel = connectLabelFor(connState);
      const isSelfPreview = String(uid || '') === String(me.uid || '');

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:23090;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto';
      overlay.innerHTML = `
        <div class="modal" style="max-width:860px;width:min(860px,96vw);max-height:calc(100vh - 32px);overflow:auto;margin:0 auto;">
          <div class="modal-header"><h3>${data.username || data.email || 'User'}</h3><button class="modal-close">&times;</button></div>
          <div class="modal-body">
            <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:12px">
              <img src="${data.avatarUrl || 'images/default-bird.png'}" style="width:64px;height:64px;border-radius:12px;object-fit:cover">
              <div style="flex:1">
                <div style="font-weight:700">${data.username || ''}</div>
                <div style="opacity:.8">${data.email || ''}</div>
              </div>
              <button id="follow-toggle" class="btn ${isFollowing ? 'btn-secondary' : 'btn-primary'}">${isFollowing ? 'Unfollow' : 'Follow'}</button>
              <button id="connect-toggle" class="btn btn-secondary">${connectLabel}</button>
              <button id="start-chat" class="btn btn-secondary"><i class="fas fa-comments"></i> Start chat</button>
            </div>
            <div id="preview-feed"></div>
            <div id="preview-playlists" style="margin-top:12px"></div>
            <div id="preview-audio" style="margin-top:12px"></div>
            <div id="preview-pictures" style="margin-top:12px"></div>
            <div id="preview-video" style="margin-top:12px"></div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const closeOverlay = ()=>{
        popupUnsubs.forEach((u)=>{ try{ u(); }catch(_){ } });
        popupUnsubs.length = 0;
        overlay.remove();
      };
      overlay.querySelector('.modal-close').onclick = closeOverlay;
      overlay.addEventListener('click', (e) => { if (e.target.classList.contains('modal-overlay')) closeOverlay(); });

      const toggle = overlay.querySelector('#follow-toggle');
      const connectBtn = overlay.querySelector('#connect-toggle');
      const chatBtn = overlay.querySelector('#start-chat');
      if (isSelfPreview){
        if (toggle) toggle.style.display = 'none';
        if (connectBtn) connectBtn.style.display = 'none';
        if (chatBtn) chatBtn.style.display = 'none';
      }
      toggle.onclick = async () => {
        try {
          toggle.disabled = true;
          if (toggle.textContent === 'Follow') {
            await window.firebaseService.followUser(me.uid, uid);
            toggle.textContent = 'Unfollow';
            toggle.className = 'btn btn-secondary';
          } else {
            await window.firebaseService.unfollowUser(me.uid, uid);
            toggle.textContent = 'Follow';
            toggle.className = 'btn btn-primary';
          }
        } catch(_) {}
        finally { toggle.disabled = false; }
      };

      if (connectBtn) connectBtn.onclick = async ()=>{
        try{
          connectBtn.disabled = true;
          const currentState = await readConnState();
          const status = currentState.status;
          const requestedBy = currentState.requestedBy;
          const requestedTo = currentState.requestedTo;
          const now = new Date().toISOString();
          const meData = (await window.firebaseService.getUserData(me.uid)) || {};
          const mePeer = {
            uid: me.uid,
            username: meData.username || me.email || me.uid,
            email: meData.email || me.email || '',
            avatarUrl: meData.avatarUrl || 'images/default-bird.png'
          };
          const otherPeer = {
            uid,
            username: data.username || data.email || uid,
            email: data.email || '',
            avatarUrl: data.avatarUrl || 'images/default-bird.png'
          };
          const myRef = firebase.doc(window.firebaseService.db,'connections',me.uid,'peers',uid);
          const peerRef = firebase.doc(window.firebaseService.db,'connections',uid,'peers',me.uid);
          let connectionRequestIntro = '';
          if (status === 'connected'){
            await firebase.deleteDoc(myRef).catch(()=>null);
            await firebase.deleteDoc(peerRef).catch(()=>null);
          } else if (status === 'pending' && requestedBy === me.uid){
            await firebase.deleteDoc(myRef).catch(()=>null);
            await firebase.deleteDoc(peerRef).catch(()=>null);
          } else if (status === 'pending' && requestedTo === me.uid){
            await firebase.setDoc(myRef, {
              ...otherPeer, status:'connected', requestedBy, requestedTo, connectedAt:now, updatedAt:now
            }, { merge:true });
            await firebase.setDoc(peerRef, {
              ...mePeer, status:'connected', requestedBy, requestedTo, connectedAt:now, updatedAt:now
            }, { merge:true });
          } else {
            const promptText = window.prompt('Add one intro message with your connection request:', '');
            if (promptText === null){
              return;
            }
            const requesterName = mePeer.username || me.email || 'User';
            connectionRequestIntro = String(promptText || '').trim() || `${requesterName} just sent a connection request`;
            await firebase.setDoc(myRef, {
              ...otherPeer, status:'pending', requestedBy:me.uid, requestedTo:uid, requestedAt:now, updatedAt:now
            }, { merge:true });
            await firebase.setDoc(peerRef, {
              ...mePeer, status:'pending', requestedBy:me.uid, requestedTo:uid, requestedAt:now, updatedAt:now
            }, { merge:true });
            try{
              const key = [me.uid, uid].sort().join('|');
              const connRef = firebase.doc(window.firebaseService.db, 'chatConnections', key);
              await firebase.setDoc(connRef, {
                id: key,
                key,
                participants: [me.uid, uid],
                participantUsernames: [mePeer.username || me.email || me.uid, data.username || data.email || uid],
                admins: [me.uid],
                createdAt: now,
                updatedAt: now,
                lastMessage: connectionRequestIntro.slice(0, 200)
              }, { merge: true });
              const msgRef = firebase.doc(firebase.collection(window.firebaseService.db, 'chatMessages', key, 'messages'));
              await firebase.setDoc(msgRef, {
                id: msgRef.id,
                connId: key,
                sender: me.uid,
                text: connectionRequestIntro,
                previewText: connectionRequestIntro.slice(0, 220),
                createdAt: new Date().toISOString(),
                createdAtTS: firebase.serverTimestamp(),
                systemType: 'connection_request_intro'
              });
            }catch(err){
              console.warn('Failed to send connection intro message', err);
            }
          }
          const nextState = await readConnState();
          connectBtn.innerHTML = connectLabelFor(nextState);
          await this.loadConnectionsForSpace();
        }catch(e){
          console.error('Connection update failed', e);
          this.showError('Connection update failed');
        }
        finally{ connectBtn.disabled = false; }
      };

      if (chatBtn) {
        chatBtn.onclick = async () => {
          try {
            const key = [me.uid, uid].sort().join('|');
            closeOverlay();
            const qs = new URLSearchParams({ connId: key });
            const full = new URL(`apps/secure-chat/index.html?${qs.toString()}`, window.location.href).href;
            if (window.appsManager && typeof window.appsManager.openAppInShell === 'function') {
              window.appsManager.openAppInShell({ id: 'secure-chat', name: 'Connections' }, full);
            } else {
              window.location.href = full;
            }
          } catch(_) {}
        };
      }

      // Public posts with safe fallback (no-index fallback).
      const feed = overlay.querySelector('#preview-feed');
      try{
        let list = [];
        try{
          const q = firebase.query(
            firebase.collection(window.firebaseService.db, 'posts'),
            firebase.where('authorId', '==', uid),
            firebase.where('visibility', '==', 'public'),
            firebase.orderBy('createdAtTS', 'desc'),
            firebase.limit(10)
          );
          const s = await firebase.getDocs(q);
          s.forEach(d => list.push(d.data()));
        }catch{
          const q2 = firebase.query(firebase.collection(window.firebaseService.db, 'posts'), firebase.where('authorId', '==', uid));
          const s2 = await firebase.getDocs(q2);
          s2.forEach(d=>{ const p=d.data(); if ((p.visibility||'public')==='public') list.push(p); });
          list.sort((a,b)=> (b.createdAtTS?.toMillis?.()||0)-(a.createdAtTS?.toMillis?.()||0) || new Date(b.createdAt||0)-new Date(a.createdAt||0));
          list = list.slice(0,10);
        }
        if (!list.length){
          feed.innerHTML = '<h4 style="margin:4px 0 8px">Posts</h4><div style="opacity:.8">No public posts yet.</div>';
        } else {
          feed.innerHTML = '<h4 style="margin:4px 0 8px">Posts</h4>';
          await Promise.all(list.slice(0, 10).map((p)=> this.primeWaveMetaForMedia(p?.media || p?.mediaUrl)));
          list.forEach((p)=>{
            const card = document.createElement('div');
            card.className = 'post-item';
            card.style.cssText = 'border:1px solid var(--border-color);border-radius:12px;padding:12px;margin:10px 0;background:var(--secondary-bg)';
            const authorName = this._safeUsername(p.authorName || '', this._safeUsername(data.username || '', 'User')).replace(/</g,'&lt;');
            const authorAvatar = String(p.coverUrl || data.avatarUrl || 'images/default-bird.png');
            const postTime = this.formatDateTime(p.createdAt);
            const editedBadge = this.isEdited(p) ? '<span style="font-size:11px;opacity:.78;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 6px">edited</span>' : '';
            const media = (p.media || p.mediaUrl) ? this.renderPostMedia(p.media || p.mediaUrl, { defaultBy: p.authorName || '', defaultCover: p.coverUrl || p.thumbnailUrl || '', authorId: p.authorId || '' }) : '';
            const postText = this.getPostDisplayText(p);
            const postTextHtml = postText ? `<div class="post-text">${postText.replace(/</g,'&lt;')}</div>` : '';
            card.innerHTML = `<div class="post-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
                <button type="button" data-user-preview="${String(p.authorId || uid).replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;gap:8px;background:none;border:none;color:inherit;padding:0">
                  <img src="${authorAvatar}" alt="author" style="width:22px;height:22px;border-radius:50%;object-fit:cover">
                  <span style="font-size:12px;color:#aaa">${authorName}</span>
                </button>
                <span class="post-head-meta" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;opacity:.74">${postTime}${editedBadge}</span>
              </div>${media}${postTextHtml}`;
            feed.appendChild(card);
          });
          this.bindUserPreviewTriggers(feed);
          this.activatePlayers(feed);
          this.applyHorizontalMasonryOrder(feed);
        }
      }catch(_){ feed.innerHTML = '<div style="opacity:.8">Unable to load posts.</div>'; }

      // Public playlists section.
      const playlistsEl = overlay.querySelector('#preview-playlists');
      try{
        let rows = [];
        if (isSelfPreview){
          const mine = await this.hydratePlaylistsFromCloud();
          rows = (mine || [])
            .filter((pl)=>{
              const ownerId = String(pl?.ownerId || pl?.owner || pl?.userId || pl?.authorId || '').trim();
              return ownerId === String(uid || '').trim();
            })
            .sort((a,b)=> new Date(b.updatedAt||0) - new Date(a.updatedAt||0))
            .slice(0, 20);
        } else {
          rows = await this.fetchPublicPlaylistsForUser(uid, 20);
        }
        if (!rows.length){
          playlistsEl.innerHTML = `<h4 style="margin:4px 0 8px">Playlists</h4><div style="opacity:.8">${isSelfPreview ? 'No playlists yet.' : 'No public playlists.'}</div>`;
        } else {
          playlistsEl.innerHTML = `<h4 style="margin:4px 0 8px">Playlists</h4>${rows.map((pl)=> { const vis = String(pl.visibility||'private').toLowerCase()==='public'?'public':'private'; return `<div class="post-item" data-pl-id="${pl.id}" style="border:1px solid var(--border-color);border-radius:12px;padding:10px;margin:8px 0;background:var(--secondary-bg);display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${String(pl.name || 'Playlist').replace(/</g,'&lt;')}</div><div style="font-size:11px;opacity:.75">${Array.isArray(pl.items) ? pl.items.length : 0} tracks${isSelfPreview ? ` · ${vis}` : ''}</div></div><button class="btn btn-secondary" data-add-pl="${pl.id}">${isSelfPreview ? 'Open' : 'Add'}</button></div>`; }).join('')}`;
          playlistsEl.querySelectorAll('[data-add-pl]').forEach((btn)=>{
            btn.onclick = async ()=>{
              const plId = String(btn.getAttribute('data-add-pl') || '').trim();
              if (!plId) return;
              try{
                if (isSelfPreview){
                  const sourcePl = rows.find((x)=> String(x.id || '') === plId) || null;
                  const ok = await this.openPlaylistForPlayback(sourcePl || { id: plId });
                  if (ok) this.showSuccess('Playlist opened');
                  return;
                }
                const mine = await this.hydratePlaylistsFromCloud();
                const exists = mine.some((x)=> String(x.id||'') === plId || String(x.sourcePlaylistId||'') === plId);
                if (exists){
                  this.showSuccess('Playlist already added');
                  return;
                }
                const src = rows.find((x)=> String(x.id) === plId);
                const meNow = await this.resolveCurrentUser();
                if (!meNow || !meNow.uid) return;
                const copy = {
                  id: `pl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
                  name: src?.name || 'Playlist',
                  owner: meNow.uid,
                  ownerId: meNow.uid,
                  ownerName: meNow.email || '',
                  visibility: 'private',
                  sourcePlaylistId: plId,
                  sourceOwnerId: src?.ownerId || uid,
                  items: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                };
                const next = [copy, ...mine];
                this.savePlaylists(next);
                await this.renderPlaylists();
                this.showSuccess('Playlist added');
              }catch(_){ this.showError('Failed to add playlist'); }
            };
          });
        }
      }catch(_){
        playlistsEl.innerHTML = '<h4 style="margin:4px 0 8px">Playlists</h4><div style="opacity:.8">Unable to load playlists.</div>';
      }

      // Audio preview section.
      const audioEl = overlay.querySelector('#preview-audio');
      try{
        let rows = [];
        try{
          const q = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', uid), firebase.orderBy('createdAt','desc'), firebase.limit(8));
          const s = await firebase.getDocs(q); s.forEach(d=> rows.push(d.data()));
        }catch{
          const q2 = firebase.query(firebase.collection(window.firebaseService.db,'wave'), firebase.where('ownerId','==', uid));
          const s2 = await firebase.getDocs(q2); s2.forEach(d=> rows.push(d.data()));
          rows.sort((a,b)=> new Date(b.createdAt||0) - new Date(a.createdAt||0));
          rows = rows.slice(0,8);
        }
        rows = await this.filterRowsBySourcePostPrivacy(rows, { isOwnerView: isSelfPreview });
        if (!rows.length){
          audioEl.innerHTML = '<h4 style="margin:4px 0 8px">Audio</h4><div style="opacity:.8">No audio uploaded.</div>';
        } else {
          audioEl.innerHTML = '<h4 style="margin:4px 0 8px">Audio</h4>';
          rows.forEach((w)=>{
            const card = document.createElement('div');
            card.className = 'post-item';
            card.style.cssText = 'border:1px solid var(--border-color);border-radius:12px;padding:10px;margin:8px 0;background:var(--secondary-bg)';
            const cover = String(w.coverUrl || '').trim() || 'images/default-bird.png';
            const byline = String(w.authorName || '').trim();
            card.innerHTML = `<div style="display:flex;gap:10px;align-items:center;margin-bottom:6px"><img src="${cover}" alt="cover" style="width:34px;height:34px;border-radius:8px;object-fit:cover"><div style="min-width:0"><div class="audio-title" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(w.title||'Audio').replace(/</g,'&lt;')}</div>${byline ? `<div class="audio-byline" style="font-size:12px;color:#aaa;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">by ${byline.replace(/</g,'&lt;')}</div>` : ''}</div><button class="audio-download-btn" title="Download audio" style="margin-left:auto;width:20px;height:20px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:rgba(8,12,18,.55);color:#dbe6f7;display:inline-flex;align-items:center;justify-content:center;padding:0"><i class="fas fa-download" style="font-size:11px"></i></button></div><audio class="liber-lib-audio" src="${w.url||''}" style="display:none" data-title="${(w.title||'').replace(/"/g,'&quot;')}" data-by="${(w.authorName||'').replace(/"/g,'&quot;')}" data-cover="${cover.replace(/"/g,'&quot;')}"></audio><div class="wave-item-audio-host"></div>`;
            audioEl.appendChild(card);
            const a = card.querySelector('.liber-lib-audio');
            const dl = card.querySelector('.audio-download-btn');
            if (dl){
              dl.onclick = async (e)=>{
                try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
                await this.downloadAudioAsset(String(w.url || ''), String(w.title || 'audio'));
              };
            }
            const host = card.querySelector('.wave-item-audio-host') || card;
            if (a){
              this.attachWaveAudioUI(a, host, { hideNative: true });
              a.addEventListener('play', ()=> this.showMiniPlayer(a, { title: w.title, by: w.authorName, cover: w.coverUrl }));
            }
          });
        }
      }catch(_){ audioEl.innerHTML = '<h4 style="margin:4px 0 8px">Audio</h4><div style="opacity:.8">Unable to load audio.</div>'; }

      // Pictures + Video preview sections.
      const picturesEl = overlay.querySelector('#preview-pictures');
      const videoEl = overlay.querySelector('#preview-video');
      try{
        let rows = [];
        try{
          const q = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', uid), firebase.orderBy('createdAtTS','desc'), firebase.limit(8));
          const s = await firebase.getDocs(q); s.forEach(d=> rows.push(d.data()));
        }catch{
          const q2 = firebase.query(firebase.collection(window.firebaseService.db,'videos'), firebase.where('owner','==', uid));
          const s2 = await firebase.getDocs(q2); s2.forEach(d=> rows.push(d.data()));
          rows.sort((a,b)=> (b.createdAtTS?.toMillis?.()||0)-(a.createdAtTS?.toMillis?.()||0) || new Date(b.createdAt||0)-new Date(a.createdAt||0));
          rows = rows.slice(0,8);
        }
        rows = await this.filterRowsBySourcePostPrivacy(rows, { isOwnerView: isSelfPreview });
        const videoRows = rows.filter((v)=> this.resolveVisualKind(v) === 'video');
        const pictureRows = rows.filter((v)=> this.resolveVisualKind(v) === 'image');
        const mkAddBtn = (kind, v)=>{
          const targetSet = kind === 'image' ? myVisualIndex.pictures : myVisualIndex.videos;
          const src = String(v?.url || '').trim();
          const isSaved = !!src && targetSet.has(src);
          const btn = document.createElement('button');
          btn.className = `preview-add-my-btn${isSaved ? ' saved' : ''}`;
          btn.textContent = isSaved ? 'Saved' : '+';
          btn.title = isSaved ? 'Remove from my library' : 'Add to my library';
          btn.onclick = async (e)=>{
            e.preventDefault();
            e.stopPropagation();
            const url = String(v?.url || '').trim();
            if (!url) return;
            if (targetSet.has(url)){
              const removed = await this.removeVisualFromLibrary(kind, url, me.uid);
              if (!removed){ this.showError('Failed to remove from library'); return; }
              targetSet.delete(url);
              btn.classList.remove('saved');
              btn.textContent = '+';
              btn.title = 'Add to my library';
              btn.animate(
                [{ opacity:0.72 }, { opacity:1 }],
                { duration: 180, easing: 'ease-out' }
              );
              return;
            }
            const ok = await this.saveVisualToLibrary({
              kind,
              url,
              title: String(v?.title || (kind === 'image' ? 'Picture' : 'Video')),
              by: String(v?.authorName || data?.username || ''),
              cover: String(v?.thumbnailUrl || v?.coverUrl || url),
              authorId: String(v?.originalAuthorId || v?.authorId || uid || '')
            }, kind === 'image' ? 'pictures' : 'videos');
            if (!ok) return;
            targetSet.add(url);
            btn.classList.add('saved');
            btn.textContent = 'Saved';
            btn.title = 'Remove from my library';
            btn.animate(
              [{ opacity:0.72 }, { opacity:1 }],
              { duration: 200, easing: 'ease-out' }
            );
          };
          return btn;
        };
        const renderVisualGrid = (rowsList, kind)=>{
          if (!rowsList.length){
            const empty = document.createElement('div');
            empty.style.cssText = 'opacity:.8';
            empty.textContent = `No ${kind === 'image' ? 'pictures' : 'videos'} uploaded.`;
            return empty;
          }
          const wrap = document.createElement('div');
          wrap.className = 'preview-visual-grid';
          rowsList.forEach((v)=>{
            const card = document.createElement('div');
            card.className = 'preview-visual-card';
            const title = String(v?.title || (kind === 'image' ? 'Picture' : 'Video')).replace(/</g,'&lt;');
            const mediaWrap = document.createElement('div');
            mediaWrap.className = 'preview-visual-media';
            mediaWrap.style.cssText = 'max-height:260px';
            if (kind === 'image'){
              mediaWrap.innerHTML = `<img loading="lazy" data-fullscreen-image="1" style="width:100%;max-height:260px;object-fit:contain;border-radius:8px;background:#000" src="${String(v?.url || '').replace(/"/g,'&quot;')}" alt="${String(v?.title || 'Picture').replace(/"/g,'&quot;')}">`;
            } else {
              mediaWrap.innerHTML = `<video controls playsinline data-fullscreen-media="1" style="width:100%;max-height:260px" src="${String(v?.url || '').replace(/"/g,'&quot;')}"></video>`;
            }
            mediaWrap.appendChild(mkAddBtn(kind, v));
            card.innerHTML = `<div style="margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</div>`;
            card.appendChild(mediaWrap);
            wrap.appendChild(card);
          });
          return wrap;
        };
        if (picturesEl){
          picturesEl.innerHTML = '<h4 style="margin:4px 0 8px">Pictures</h4>';
          picturesEl.appendChild(renderVisualGrid(pictureRows, 'image'));
        }
        videoEl.innerHTML = '<h4 style="margin:4px 0 8px">Videos</h4>';
        videoEl.appendChild(renderVisualGrid(videoRows, 'video'));
      }catch(_){
        if (picturesEl) picturesEl.innerHTML = '<h4 style="margin:4px 0 8px">Pictures</h4><div style="opacity:.8">Unable to load pictures.</div>';
        videoEl.innerHTML = '<h4 style="margin:4px 0 8px">Videos</h4><div style="opacity:.8">Unable to load videos.</div>';
      }
    }

    async openAdvancedCommentsFallback(postId, tree, myUid){
      if (!tree || !postId) return;
      const forceOpen = tree.dataset.forceOpen === '1';
      tree.dataset.forceOpen = '0';
      if (tree.style.display === 'none' || forceOpen) tree.style.display = 'block';
      else { tree.style.display = 'none'; return; }

      const renderTree = async () => {
        tree.innerHTML = '';
        const currentLimit = Number(tree.dataset.limit || 5);
        const comments = await window.firebaseService.getComments(postId, currentLimit);
        const map = new Map();
        comments.forEach(c => map.set(c.id, { ...c, children: [] }));
        const roots = [];
        comments.forEach(c => {
          if (c.parentId && map.has(c.parentId)) map.get(c.parentId).children.push(map.get(c.id));
          else roots.push(map.get(c.id));
        });

        const renderNode = (node, parent) => {
          const item = document.createElement('div');
          item.className = 'comment-item';
          item.innerHTML = `<div class="comment-text">${(node.text||'').replace(/</g,'&lt;')}</div>
          <div class="comment-actions" data-comment-id="${node.id}" data-author="${node.authorId}" style="display:flex;gap:8px;margin-top:4px">
            <span class="reply-btn" style="cursor:pointer"><i class="fas fa-reply"></i> Reply</span>
            <i class="fas fa-edit edit-comment-btn" title="Edit" style="cursor:pointer"></i>
            <i class="fas fa-trash delete-comment-btn" title="Delete" style="cursor:pointer"></i>
          </div>`;
          parent.appendChild(item);

          const replyBox = document.createElement('div');
          replyBox.style.cssText = 'margin:6px 0 0 0; display:none';
          replyBox.innerHTML = '<input type="text" class="reply-input" placeholder="Reply..." style="width:100%">';
          item.appendChild(replyBox);
          item.querySelector('.reply-btn').onclick = () => {
            replyBox.style.display = replyBox.style.display === 'none' ? 'block' : 'none';
            if (replyBox.style.display === 'block'){
              const i = replyBox.querySelector('.reply-input'); if (i) i.focus();
            }
          };

          const inp = replyBox.querySelector('.reply-input');
          if (inp){
            inp.onkeydown = async (ev) => {
              if (ev.key === 'Enter' && inp.value.trim()){
                await window.firebaseService.addComment(postId, myUid, inp.value.trim(), node.id);
                inp.value = '';
                tree.dataset.forceOpen = '1';
                await this.openAdvancedCommentsFallback(postId, tree, myUid);
              }
            };
          }

          if (node.children && node.children.length){
            const sub = document.createElement('div');
            sub.className = 'comment-tree';
            item.appendChild(sub);
            node.children.forEach(ch => renderNode(ch, sub));
          }
        };
        roots.reverse().forEach(n => renderNode(n, tree));

        if (comments.length >= currentLimit){
          const more = document.createElement('button');
          more.className = 'btn btn-secondary';
          more.style.marginTop = '8px';
          more.textContent = 'See more comments';
          more.onclick = async () => {
            tree.dataset.limit = String(currentLimit + 10);
            tree.dataset.forceOpen = '1';
            await this.openAdvancedCommentsFallback(postId, tree, myUid);
          };
          tree.appendChild(more);
        }

        const addWrap = document.createElement('div');
        addWrap.style.cssText = 'margin-top:8px';
        addWrap.innerHTML = '<input type="text" class="reply-input" placeholder="Add a comment..." style="width:100%">';
        tree.appendChild(addWrap);
        const addInp = addWrap.querySelector('.reply-input');
        if (addInp){
          addInp.onkeydown = async (ev) => {
            if (ev.key === 'Enter' && addInp.value.trim()){
              await window.firebaseService.addComment(postId, myUid, addInp.value.trim(), null);
              addInp.value = '';
              tree.dataset.forceOpen = '1';
              await this.openAdvancedCommentsFallback(postId, tree, myUid);
            }
          };
        }

        tree.querySelectorAll('.comment-actions').forEach((act) => {
          const cid = act.getAttribute('data-comment-id');
          const author = act.getAttribute('data-author');
          const canEdit = !!myUid && author === myUid;
          const eb = act.querySelector('.edit-comment-btn');
          const db = act.querySelector('.delete-comment-btn');
          if (!canEdit){ if (eb) eb.style.display = 'none'; if (db) db.style.display = 'none'; return; }
          if (eb){
            eb.onclick = async () => {
              const newText = prompt('Edit comment:');
              if (newText === null) return;
              await window.firebaseService.updateComment(postId, cid, newText.trim());
              tree.dataset.forceOpen = '1';
              await this.openAdvancedCommentsFallback(postId, tree, myUid);
            };
          }
          if (db){
            db.onclick = async () => {
              if (!confirm('Delete this comment?')) return;
              await window.firebaseService.deleteComment(postId, cid);
              tree.dataset.forceOpen = '1';
              await this.openAdvancedCommentsFallback(postId, tree, myUid);
            };
          }
        });
      };

      try { await renderTree(); } catch (_) { tree.innerHTML = '<div style="opacity:.8">Unable to load comments.</div>'; }
    }

    activatePostActions(container = document) {
      if (!this._postActionUnsubsByContainer) this._postActionUnsubsByContainer = new WeakMap();
      if (!this._postActionUnsubsByContainer.get(container)) this._postActionUnsubsByContainer.set(container, []);
      // Delegate clicks once per container to ensure handlers always work
      if (!container.__postActionsDelegated) {
        container.__postActionsDelegated = true;
        container.addEventListener('click', async (e) => {
          const likeEl = e.target.closest('.like-btn');
          const commentEl = e.target.closest('.comment-btn');
          const repostEl = e.target.closest('.repost-btn');
          const shareChatEl = e.target.closest('.share-chat-post-btn');
          const actionEl = likeEl || commentEl || repostEl || shareChatEl;
          if (!actionEl || !container.contains(actionEl)) return;

          const actionsWrap = actionEl.closest('.post-actions');
          const postItem = actionEl.closest('.post-item');
          const pid = actionsWrap?.dataset.postId || postItem?.dataset.postId;
          if (!pid) return;

          let me = this.currentUser;
          if (!me) {
            try { me = await this.resolveCurrentUser(); this.currentUser = me; } catch(_) { return; }
          }
          if (!me || !me.uid) return;

          if (shareChatEl){
            try{
              const postRef = firebase.doc(window.firebaseService.db, 'posts', pid);
              const snap = await firebase.getDoc(postRef);
              const p = snap.exists() ? (snap.data() || {}) : {};
              await this.openShareToChatSheet({
                type: 'post',
                post: {
                  id: pid,
                  authorId: String(p.authorId || actionsWrap?.dataset?.author || ''),
                  authorName: String(p.authorName || ''),
                  text: String(p.text || ''),
                  media: Array.isArray(p.media) ? p.media : [],
                  mediaUrl: String(p.mediaUrl || '')
                }
              });
            }catch(_){ this.showError('Failed to share post to chat'); }
            return;
          }

          if (likeEl) {
            try {
              const likeRef = firebase.doc(window.firebaseService.db, 'posts', pid, 'likes', me.uid);
              const snap = await firebase.getDoc(likeRef);
              if (snap.exists()) { await firebase.deleteDoc(likeRef); }
              else { await firebase.setDoc(likeRef, { userId: me.uid, createdAt: new Date().toISOString() }); }
            } catch(_) {}
            return;
          }

          if (repostEl) {
            try {
              const repostRef = firebase.doc(window.firebaseService.db, 'posts', pid, 'reposts', me.uid);
              const snap = await firebase.getDoc(repostRef);
              if (snap.exists()) { await firebase.deleteDoc(repostRef); }
              else { await firebase.setDoc(repostRef, { userId: me.uid, createdAt: new Date().toISOString() }); }
            } catch(_) {}
            return;
          }

          if (commentEl) {
            // Advanced comments are normally bound per-post. Keep prompt fallback for basic containers.
            if (!container.__useAdvancedComments){
              const text = prompt('Add comment:');
              if (text && text.trim()) {
                try { await firebase.addDoc(firebase.collection(window.firebaseService.db, 'posts', pid, 'comments'), { userId: me.uid, text: text.trim(), createdAt: new Date().toISOString() }); } catch(_) {}
              }
            } else if (typeof commentEl.onclick !== 'function') {
              const tree = postItem?.querySelector('.comment-tree') || document.getElementById(`comments-${pid}`);
              if (!tree) return;
              try { await this.openAdvancedCommentsFallback(pid, tree, me.uid); } catch (_) {}
            }
            return;
          }
        });
      }

      container.querySelectorAll('.post-item').forEach(item => {
        const pid = item.dataset.postId || item.querySelector('.post-actions')?.dataset.postId;
        if (!pid) return;
        const actionsWrap = item.querySelector('.post-actions');
        if (actionsWrap && !actionsWrap.querySelector('.share-chat-post-btn')){
          const shareChat = document.createElement('i');
          shareChat.className = 'fas fa-comments share-chat-post-btn';
          shareChat.title = 'Share to chat';
          shareChat.style.cursor = 'pointer';
          actionsWrap.appendChild(shareChat);
        }
        
        // Like
        const likeBtn = item.querySelector('.like-btn');
        const likeSpan = item.querySelector('.likes-count');
        const likeIcon = likeBtn?.querySelector('i');
        if (likeBtn) {
          const unsub = firebase.onSnapshot(
            firebase.collection(window.firebaseService.db, 'posts', pid, 'likes'),
            snap => { if (likeSpan) likeSpan.textContent = snap.size; },
            async ()=>{ try{ const s = await window.firebaseService.getPostStats(pid); if (likeSpan) likeSpan.textContent = `${s.likes||0}`; }catch(_){ } }
          );
          this._postActionUnsubsByContainer.get(container).push(unsub);
          // Clicks handled by delegated listener above
        }
        
        // Comment
        const commentBtn = item.querySelector('.comment-btn');
        const commentSpan = item.querySelector('.comments-count');
        if (commentBtn) {
          const unsub = firebase.onSnapshot(
            firebase.collection(window.firebaseService.db, 'posts', pid, 'comments'),
            snap => { if (commentSpan) commentSpan.textContent = snap.size; },
            ()=>{}
          );
          this._postActionUnsubsByContainer.get(container).push(unsub);
          // Clicks handled by delegated listener above
        }
        
        // Repost
        const repostBtn = item.querySelector('.repost-btn');
        const repostSpan = item.querySelector('.reposts-count');
        const repostIcon = repostBtn?.querySelector('i');
        if (repostBtn) {
          const unsub = firebase.onSnapshot(
            firebase.collection(window.firebaseService.db, 'posts', pid, 'reposts'),
            snap => { if (repostSpan) repostSpan.textContent = snap.size; },
            async ()=>{ try{ const s = await window.firebaseService.getPostStats(pid); if (repostSpan) repostSpan.textContent = `${s.reposts||0}`; }catch(_){ } }
          );
          this._postActionUnsubsByContainer.get(container).push(unsub);
          // Clicks handled by delegated listener above
        }
      });
    }
}

// Create global instance
window.dashboardManager = new DashboardManager();

// Bridge: allow embedded apps (iframe) to request top-level playlist popup.
try{
    window.addEventListener('message', (event)=>{
        const data = event?.data || {};
        if (!data || data.type !== 'LIBER_ADD_TO_PLAYLIST') return;
        const track = data.track || {};
        const src = String(track.src || '').trim();
        if (!src) return;
        try{
            if (window.dashboardManager && typeof window.dashboardManager.openAddToPlaylistPopup === 'function'){
                window.dashboardManager.openAddToPlaylistPopup({
                    src,
                    title: track.title || 'Track',
                    by: track.by || '',
                    cover: track.cover || ''
                });
            }
        }catch(_){ }
    });
}catch(_){ }

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DashboardManager;
}
