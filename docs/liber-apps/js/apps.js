/**
 * Apps Module for Liber Apps Control Panel
 * Handles app discovery, launching, and management
 */

class AppsManager {
    constructor() {
        this.apps = [];
        this.filteredApps = [];
        this.currentCategory = 'all';
        this.searchTerm = '';
        this._autoRefreshTimer = null;
        this._activeAppUrl = '';
        this._closingShell = false;
        this._chatCallState = { active: false, connId: '', inRoom: false };
        this._iosNativeCallsEnabled = this._readIosNativeCallsFlag();
        this.init();
    }

    /**
     * Initialize apps manager
     */
    init() {
        this.setupAppShell();
        this.setupEventListeners();
        this.loadApps();
    }

    _readIosNativeCallsFlag(){
        try{
            if (typeof window.LIBER_IOS_NATIVE_CALLS !== 'undefined'){
                return String(window.LIBER_IOS_NATIVE_CALLS) === 'true' || window.LIBER_IOS_NATIVE_CALLS === true;
            }
            const raw = String(localStorage.getItem('liber_ios_native_calls') || '').trim().toLowerCase();
            return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
        }catch(_){ return false; }
    }

    _isIOSDevice(){
        try{
            const ua = String(navigator.userAgent || '');
            return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
        }catch(_){ return false; }
    }

    _shouldUseIosNativeCalls(){
        return !!(this._iosNativeCallsEnabled && this._isIOSDevice());
    }

    _sendIosNativeCallIntent(payload){
        try{
            if (!this._shouldUseIosNativeCalls()) return false;
            const bridge = window?.webkit?.messageHandlers?.liberCallBridge;
            if (!bridge || typeof bridge.postMessage !== 'function') return false;
            bridge.postMessage(payload || {});
            return true;
        }catch(_){ return false; }
    }

    setupAppShell(){
        const shell = document.getElementById('app-shell');
        const closeBtn = document.getElementById('app-shell-close');
        const reloadBtn = document.getElementById('app-shell-reload');
        const openTabBtn = document.getElementById('app-shell-open-tab');
        const frame = document.getElementById('app-shell-frame');
        if (!shell) return;
        if (closeBtn && !closeBtn._bound){
            closeBtn._bound = true;
            closeBtn.addEventListener('click', ()=> this.closeAppShell());
        }
        if (reloadBtn && !reloadBtn._bound){
            reloadBtn._bound = true;
            reloadBtn.addEventListener('click', ()=>{
                const frame = document.getElementById('app-shell-frame');
                if (frame && frame.src) frame.src = frame.src;
            });
        }
        if (openTabBtn && !openTabBtn._bound){
            openTabBtn._bound = true;
            openTabBtn.addEventListener('click', ()=>{
                if (this._activeAppUrl) window.open(this._activeAppUrl, '_blank', 'noopener,noreferrer');
            });
        }
        if (frame && !frame._boundBackRelay){
            frame._boundBackRelay = true;
            frame.addEventListener('load', ()=> this.handleShellFrameLoad(frame));
            frame.addEventListener('error', ()=> this.closeAppShell());
        }
        if (!window._liberAppShellMsgBound){
            window._liberAppShellMsgBound = true;
            window.addEventListener('message', (ev)=>{
                const data = ev && ev.data ? ev.data : {};
                if (data && data.type === 'liber:close-app-shell'){
                    this.closeAppShell();
                } else if (data && data.type === 'liber:gallery-error'){
                    if (data.isError !== false) console.error('[Gallery Control]', data.label || 'error', data.message || '', data.stack || '', data.extra || '');
                    else console.log('[Gallery Control]', data.label, data.extra || '');
                } else if (data && data.type === 'liber:ios-call-intent'){
                    const payload = {
                        type: 'liber:ios-call-intent',
                        action: String(data.action || '').trim(),
                        connId: String(data.connId || ''),
                        callId: String(data.callId || ''),
                        video: !!data.video,
                        source: 'app-shell'
                    };
                    const sent = this._sendIosNativeCallIntent(payload);
                    if (!sent) return;
                    // Optimistic UI state while native call UI opens.
                    this._chatCallState = {
                        active: payload.action === 'start' || payload.action === 'join' || !!this._chatCallState.active,
                        connId: payload.connId || this._chatCallState.connId || '',
                        inRoom: true
                    };
                    this.updateGlobalCallButton();
                    try{
                        const frame = document.getElementById('app-shell-frame');
                        frame?.contentWindow?.postMessage({
                            type: 'liber:ios-call-state',
                            active: !!this._chatCallState.active,
                            inRoom: true,
                            connId: this._chatCallState.connId || ''
                        }, '*');
                    }catch(_){ }
                } else if (data && data.type === 'liber:native-call-state'){
                    this._chatCallState = {
                        active: !!data.active,
                        connId: String(data.connId || this._chatCallState?.connId || ''),
                        inRoom: !!data.inRoom
                    };
                    this.updateGlobalCallButton();
                    try{
                        const frame = document.getElementById('app-shell-frame');
                        frame?.contentWindow?.postMessage({
                            type: 'liber:ios-call-state',
                            active: !!data.active,
                            inRoom: !!data.inRoom,
                            connId: String(data.connId || ''),
                            callId: String(data.callId || ''),
                            error: String(data.error || '')
                        }, '*');
                    }catch(_){ }
                } else if (data && data.type === 'liber:chat-call-state'){
                    const active = !!data.active;
                    this._chatCallState = {
                        active,
                        connId: String(data.connId || ''),
                        inRoom: !!data.inRoom
                    };
                    this.updateGlobalCallButton();
                } else if (data && data.type === 'liber:chat-audio-meta' && data.src){
                    try{
                        const dm = window.dashboardManager;
                        if (dm && typeof dm.setChatAudioMeta === 'function'){
                            dm.setChatAudioMeta({ src: data.src, title: data.title || 'Audio', by: data.by || '', cover: data.cover || '' });
                        }
                    }catch(_){ }
                } else if (data && data.type === 'liber:chat-audio-play' && data.src){
                    // Chat now uses liber:chat-audio-meta only - do NOT take over playback (would pause chat and break it)
                    try{
                        const dm = window.dashboardManager;
                        if (dm && typeof dm.setChatAudioMeta === 'function'){
                            dm.setChatAudioMeta({ src: data.src, title: data.title || 'Audio', by: data.by || '', cover: data.cover || '' });
                        }
                    }catch(_){ }
                } else if (data && data.type === 'liber:chat-unread' && typeof data.count === 'number'){
                    const badge = document.getElementById('dashboard-chat-unread-badge');
                    if (badge){
                        if (data.count > 0){
                            badge.textContent = String(data.count > 99 ? '99+' : data.count);
                            badge.classList.remove('hidden');
                            badge.removeAttribute('aria-hidden');
                        } else {
                            badge.classList.add('hidden');
                            badge.setAttribute('aria-hidden', 'true');
                        }
                    }
                }
            });
        }
        window.addEventListener('keydown', (e)=>{
            if (e.key === 'Escape' && document.body.classList.contains('app-shell-open')) {
                this.closeAppShell();
            }
        });
        this.ensureGlobalCallButton();
        this.updateGlobalCallButton();
    }

    ensureGlobalCallButton(){
        if (document.getElementById('dashboard-call-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'dashboard-call-btn';
        btn.className = 'dashboard-chat-btn';
        btn.title = 'Return to active call';
        btn.setAttribute('aria-label', 'Return to active call');
        btn.style.display = 'none';
        btn.style.bottom = '126px';
        btn.innerHTML = '<i class="fas fa-phone-volume"></i>';
        btn.addEventListener('click', ()=> this.openActiveCallShell());
        document.body.appendChild(btn);
    }

    updateGlobalCallButton(){
        const btn = document.getElementById('dashboard-call-btn');
        if (!btn) return;
        const show = !!(this._chatCallState?.active || this._chatCallState?.inRoom);
        btn.style.display = show ? 'inline-flex' : 'none';
    }

    openActiveCallShell(){
        try{
            if (this._shouldUseIosNativeCalls()){
                const sent = this._sendIosNativeCallIntent({
                    type: 'liber:ios-call-intent',
                    action: 'show_call_ui',
                    connId: String(this._chatCallState?.connId || ''),
                    source: 'app-shell'
                });
                if (sent) return;
            }
            const shell = document.getElementById('app-shell');
            const frame = document.getElementById('app-shell-frame');
            const title = document.getElementById('app-shell-title');
            if (!shell || !frame) return;
            const src = String(frame.getAttribute('src') || '');
            const canReuse = /apps\/secure-chat\/index\.html/i.test(src) && src !== 'about:blank';
            if (canReuse){
                shell.classList.remove('hidden');
                shell.classList.remove('chat-kept-alive');
                shell.setAttribute('aria-hidden', 'false');
                document.body.classList.add('app-shell-open');
                if (title) title.textContent = 'Connections';
                return;
            }
            const full = new URL('apps/secure-chat/index.html', window.location.href).href;
            this.openAppInShell({ id: 'secure-chat', name: 'Connections' }, full);
        }catch(_){ }
    }

    bindShellBackBridge(frame){
        try{
            const doc = frame?.contentDocument;
            if (!doc || doc._liberBackBridgeBound) return;
            doc._liberBackBridgeBound = true;
            doc.addEventListener('click', (e)=>{
                const t = e.target && e.target.closest
                    ? e.target.closest('#back-btn, [data-close-shell], [onclick*="history.back"], [id*="back"], [class*="back"], a[href$="/index.html"], a[href="../../index.html"], a[href="../index.html"]')
                    : null;
                if (!t) return;
                const href = (t.getAttribute && t.getAttribute('href')) || '';
                const idClass = `${(t.id || '')} ${(t.className || '')}`.toLowerCase();
                const hasBackToken = /(^|[\s_-])back([\s_-]|$)|\bgo-back\b|\bback-btn\b/.test(idClass);
                const isBack = t.id === 'back-btn'
                    || t.hasAttribute('data-close-shell')
                    || /index\.html(\?|$)/i.test(href)
                    || hasBackToken
                    || (t.getAttribute && /history\.back\s*\(/i.test(String(t.getAttribute('onclick') || '')));
                if (!isBack) return;
                e.preventDefault();
                e.stopPropagation();
                this.closeAppShell();
            }, true);
        }catch(_){ /* cross-origin or transient frame state */ }
    }

    handleShellFrameLoad(frame){
        this.bindShellBackBridge(frame);
        // Recovery: if iframe navigates back to the control panel, close shell.
        // Some in-app back links navigate instead of posting close messages.
        try{
            if (this._closingShell) return;
            const href = String(frame?.contentWindow?.location?.href || '');
            if (!href || href === 'about:blank'){
                if (document.body.classList.contains('app-shell-open')) this.closeAppShell();
                return;
            }
            const url = new URL(href, window.location.href);
            const sameOrigin = url.origin === window.location.origin;
            if (!sameOrigin) return;
            const path = String(url.pathname || '').toLowerCase();
            const isControlPanelPath = /\/(control-panel|liber-apps)(\/index\.html)?\/?$/.test(path);
            const isSelfPath = path === String(window.location.pathname || '').toLowerCase();
            if (isControlPanelPath || isSelfPath){
                this.closeAppShell();
            }
        }catch(_){ }
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Auto-refresh if enabled
        this.setupAutoRefresh();
    }

    /**
     * Setup search functionality
     */
    setupSearchFunctionality() {
        // Remove existing event listeners to prevent duplicates
        const searchInput = document.getElementById('app-search');
        if (searchInput) {
            // Clone the element to remove all event listeners
            const newSearchInput = searchInput.cloneNode(true);
            searchInput.parentNode.replaceChild(newSearchInput, searchInput);
            // Keep anti-autofill settings after cloning.
            newSearchInput.setAttribute('autocomplete', 'new-password');
            newSearchInput.setAttribute('autocorrect', 'off');
            newSearchInput.setAttribute('autocapitalize', 'off');
            newSearchInput.setAttribute('spellcheck', 'false');
            // Keep regular field behavior but defeat browser account-autofill heuristics.
            newSearchInput.setAttribute('type', 'search');
            newSearchInput.setAttribute('name', `app-search-${Date.now()}`);
            newSearchInput.value = '';
            const clearAutofill = ()=>{
                const v = (newSearchInput.value || '').trim();
                // Clear likely account autofill content (email-like or long single token).
                if (/@/.test(v) || /^[A-Za-z0-9._-]{16,}$/.test(v)) { newSearchInput.value = ''; return; }
                try{
                    const raw = localStorage.getItem('liber_accounts');
                    const accounts = raw ? JSON.parse(raw) : [];
                    const low = v.toLowerCase();
                    if ((accounts||[]).some(a => String(a?.email||'').toLowerCase()===low || String(a?.username||'').toLowerCase()===low)){
                        newSearchInput.value = '';
                    }
                }catch(_){ }
            };
            setTimeout(clearAutofill, 0);
            setTimeout(clearAutofill, 300);
            setTimeout(clearAutofill, 1200);
            setTimeout(clearAutofill, 2500);
            newSearchInput.addEventListener('focus', clearAutofill);
            newSearchInput.addEventListener('input', clearAutofill);
            window.addEventListener('pageshow', clearAutofill);
            
            // Add new event listener
            newSearchInput.addEventListener('input', (e) => {
                this.searchTerm = e.target.value.toLowerCase();
                this.filterApps();
                this.renderApps();
            });

            // Add keydown event for better UX
            newSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.clearSearch();
                }
            });

            // Add clear button functionality
            const searchContainer = newSearchInput.closest('.search-container');
            if (searchContainer) {
                // Remove existing clear button if any
                const existingClearBtn = searchContainer.querySelector('.search-clear');
                if (existingClearBtn) {
                    existingClearBtn.remove();
                }

                // Add clear button
                const clearBtn = document.createElement('button');
                clearBtn.className = 'search-clear';
                clearBtn.innerHTML = '<i class="fas fa-times"></i>';
                
                clearBtn.addEventListener('click', () => {
                    this.clearSearch();
                });

                searchContainer.appendChild(clearBtn);

                // Show/hide clear button based on input value
                newSearchInput.addEventListener('input', () => {
                    if (newSearchInput.value) {
                        clearBtn.classList.add('visible');
                    } else {
                        clearBtn.classList.remove('visible');
                    }
                });
            }
        }
    }

    /**
     * Clear search
     */
    clearSearch() {
        const searchInput = document.getElementById('app-search');
        if (searchInput) {
            searchInput.value = '';
        }
        this.searchTerm = '';
        this.filterApps();
        this.renderApps();
    }

    /**
     * Setup auto-refresh functionality
     */
    setupAutoRefresh() {
        const settings = dashboardManager.getSettings();
        if (settings.autoRefreshApps) {
            // Refresh apps every 5 minutes
            this._autoRefreshTimer = setInterval(() => {
                if (document.body.classList.contains('app-shell-open')) return;
                this.loadApps();
            }, 5 * 60 * 1000);
        }
    }

    /**
     * Load apps from the apps directory
     */
    async loadApps() {
        try {
            // Show loading state
            this.showLoadingState();

            // Setup search functionality when apps section is loaded
            this.setupSearchFunctionality();

            // In a real implementation, this would scan the apps directory
            // For now, we'll use sample apps
            this.apps = await this.getSampleApps();
            
            this.filterApps();
            this.renderApps();
            this.updateAppsCount();

            let launchId = sessionStorage.getItem('liber_launch_after_verify');
            let projectId = sessionStorage.getItem('liber_verify_project_id');
            let chatConnId = sessionStorage.getItem('liber_return_chat_conn_id');
            let extraParams = '';
            if (!launchId && (typeof URLSearchParams !== 'undefined')) {
                try {
                    const params = new URLSearchParams(window.location.search);
                    const returnTo = params.get('returnTo');
                    if (returnTo === 'tracker' && window.firebaseService?.auth?.currentUser) {
                        launchId = 'project-tracker';
                        projectId = sessionStorage.getItem('liber_return_project_id') || projectId;
                        sessionStorage.removeItem('liber_return_project_id');
                        try { const u = new URL(window.location.href); u.searchParams.delete('returnTo'); u.searchParams.delete('projectId'); window.history.replaceState({}, '', u.toString()); } catch (_) {}
                    } else if (returnTo === 'specifications' && window.firebaseService?.auth?.currentUser) {
                        launchId = 'revex';
                        extraParams = ['view=spec'].concat(['specUrl', 'specTitle', 'specNote', 'specProjectId', 'section', 'item']
                            .filter((k) => params.get(k))
                            .map((k) => k + '=' + encodeURIComponent(params.get(k))))
                            .join('&');
                        try {
                            const u = new URL(window.location.href);
                            ['returnTo', 'specUrl', 'specTitle', 'specNote', 'specProjectId', 'section', 'view', 'item'].forEach((k) => u.searchParams.delete(k));
                            window.history.replaceState({}, '', u.toString());
                        } catch (_) {}
                    } else if (returnTo === 'chat' && window.firebaseService?.auth?.currentUser) {
                        launchId = 'chat';
                        chatConnId = chatConnId || params.get('connId');
                        sessionStorage.removeItem('liber_return_chat_conn_id');
                    }
                } catch (_) {}
            }
            if (launchId === 'chat') {
                const chatPath = 'apps/secure-chat/index.html';
                let chatUrl = new URL(chatPath, window.location.href).href;
                if (chatConnId) chatUrl += (chatUrl.includes('?') ? '&' : '?') + 'connId=' + encodeURIComponent(chatConnId);
                try {
                    const u = new URL(window.location.href);
                    u.searchParams.delete('returnTo');
                    u.searchParams.delete('connId');
                    window.history.replaceState({}, '', u.toString());
                } catch (_) {}
                setTimeout(() => this.openAppInShell({ id: 'secure-chat', name: 'Connections' }, chatUrl), 400);
            } else if (launchId) {
                if (launchId === 'specifications') {
                    launchId = 'revex';
                    extraParams = extraParams ? `view=spec&${extraParams}` : 'view=spec';
                }
                sessionStorage.removeItem('liber_launch_after_verify');
                if (projectId) sessionStorage.removeItem('liber_verify_project_id');
                const app = this.apps.find((a) => a.id === launchId);
                if (app && !app.adminOnly) {
                    const appUrl = new URL(app.path, window.location.href).href;
                    let urlWithProject = projectId ? `${appUrl}${appUrl.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}` : appUrl;
                    if (extraParams) urlWithProject += (urlWithProject.includes('?') ? '&' : '?') + extraParams;
                    setTimeout(() => this.openAppInShell(app, urlWithProject), 400);
                }
            }
        } catch (error) {
            console.error('Error loading apps:', error);
            this.showError('Failed to load apps');
        }
    }

    /**
     * Get sample apps (replace with actual directory scanning)
     */
    async getSampleApps() {
        // Only include apps that actually exist in the apps folder
        // Project Tracker first for users (userOnly) - they see it at the top
        const availableApps = [
            {
                id: 'project-tracker',
                name: 'Project Tracker',
                description: 'Track your projects, view status, access chat and project library.',
                version: '1.0.0',
                category: 'business',
                icon: 'fas fa-tasks',
                status: 'online',
                path: 'apps/project-tracker/index.html',
                author: 'Liber Apps',
                lastUpdated: '2026-02-22',
                logo: null,
                userOnly: true
            },
            {
                id: 'revex',
                name: 'REVEX Companion',
                description: 'One Revit-connected workspace for BIM, Design Book, Spec Book, documents, chat and AI renders.',
                version: '0.6.0',
                category: 'business',
                icon: 'fas fa-cube',
                status: 'online',
                path: 'apps/revex/index.html',
                author: 'LIBER',
                lastUpdated: '2026-08-09',
                logo: null
            },
            {
                id: 'calculator',
                name: 'Calculator',
                description: 'A calculator application for mathematical operations.',
                version: '1.0.0',
                category: 'utilities',
                icon: 'fas fa-calculator',
                status: 'online',
                path: 'apps/calculator/index.html',
                author: 'Liber Apps',
                lastUpdated: '2025-08-16',
                logo: null
            },
            {
                id: 'invoice-generator',
                name: 'Invoice Generator',
                description: 'Create, manage, and download invoices.',
                version: '1.0.0',
                category: 'business',
                icon: 'fas fa-file-invoice-dollar',
                status: 'online',
                path: 'apps/invoices-app/invoices.html',
                author: 'Liber Apps',
                lastUpdated: '2025-08-16',
                logo: null
            },
            {
                id: 'file-converter',
                name: 'File Converter',
                description: 'Convert images, vectors, videos and audio between common formats (in-browser).',
                version: '1.0.0',
                category: 'utilities',
                icon: 'fas fa-exchange-alt',
                status: 'online',
                path: 'apps/file-converter/index.html',
                author: 'Liber Apps',
                lastUpdated: '2025-08-23',
                logo: null
            },
            {
                id: 'media-enhancer',
                name: 'Media Enhancer',
                description: 'Audio vocal/music splitter and image upscaler/denoiser.',
                version: '1.0.0',
                category: 'media',
                icon: 'fas fa-magic',
                status: 'online',
                path: 'apps/media-enhancer/index.html',
                author: 'Liber Apps',
                lastUpdated: '2025-08-23',
                logo: null
            },
            {
                id: 'gallery-control',
                name: 'Gallery Control',
                description: 'Admin app to manage project galleries, media and publish state.',
                version: '1.0.0',
                category: 'media',
                icon: 'fas fa-images',
                status: 'online',
                path: 'apps/gallery-control/index.html',
                author: 'Liber Apps',
                lastUpdated: '2026-02-22',
                logo: null,
                adminOnly: true
            },
            {
                id: 'project-manager',
                name: 'Project Manager',
                description: 'Admin app to manage projects, library, status and chat.',
                version: '1.0.0',
                category: 'business',
                icon: 'fas fa-cogs',
                status: 'online',
                path: 'apps/project-manager/index.html',
                author: 'Liber Apps',
                lastUpdated: '2026-02-22',
                logo: null,
                adminOnly: true
            },
            {
                id: 'downloads-manager',
                name: 'Downloads Manager',
                description: 'Admin app to manage direct download links and versions metadata.',
                version: '1.0.0',
                category: 'business',
                icon: 'fas fa-download',
                status: 'online',
                path: 'apps/downloads-manager/index.html',
                author: 'Liber Apps',
                lastUpdated: '2026-02-27',
                logo: null,
                adminOnly: true
            },
            {
                id: 'whatsapp-monitor',
                name: 'WhatsApp Monitor',
                description: 'Scans your WhatsApp Business chats twice a day, summarizes with AI, and alerts you to what matters. Runs on a persistent server — no setup needed.',
                version: '1.0.0',
                category: 'utilities',
                icon: 'fab fa-whatsapp',
                status: 'online',
                path: '#whatsapp-monitor-external',
                externalUrl: 'https://github.com/nvberegovykh/liber-whatsapp-monitor',
                author: 'Liber Apps',
                lastUpdated: '2026-05-29',
                logo: null
            }
        ];

        const validApps = [];
        for (const app of availableApps) {
            if (app.externalUrl) { validApps.push(app); continue; }
            if (app.path && app.path.startsWith('#')) { validApps.push(app); continue; }
            try {
                if ((await fetch(app.path)).ok) validApps.push(app);
            } catch (_) {}
        }
        return validApps;
    }

    /**
     * Filter apps based on search term and category
     */
    filterApps() {
        const isAdmin = this._isAdmin();
        this.filteredApps = this.apps.filter(app => {
            if (app.adminOnly && !isAdmin) return false;
            if (app.userOnly && isAdmin) return false;
            const matchesSearch = this.searchTerm === '' || 
                                app.name.toLowerCase().includes(this.searchTerm) ||
                                app.description.toLowerCase().includes(this.searchTerm) ||
                                app.category.toLowerCase().includes(this.searchTerm);
            const matchesCategory = this.currentCategory === 'all' || app.category === this.currentCategory;
            
            return matchesSearch && matchesCategory;
        });
    }

    _isAdmin() {
        return !!(window.dashboardManager?._isAdminSession || (window.authManager && window.authManager.isAdmin && window.authManager.isAdmin()));
    }

    /**
     * Render apps in the grid
     */
    renderApps() {
        const appsGrid = document.getElementById('apps-grid');
        if (!appsGrid) return;

        if (this.filteredApps.length === 0) {
            appsGrid.innerHTML = this.getEmptyStateHTML();
            return;
        }

        appsGrid.innerHTML = this.filteredApps.map(app => this.getAppCardHTML(app)).join('');
        
        // Add click handlers to app cards (internal anchors handled by switchSection)
        this.setupAppCardEventListeners();
    }

    /**
     * Get app card HTML
     */
    getAppCardHTML(app) {
        const settings = dashboardManager.getSettings();
        const showDescriptions = settings.showAppDescriptions;
        
        const appUrl = new URL(app.path, window.location.href).href;
        
        return `
            <div class="app-card" data-app-id="${app.id}" data-app-primary="${app.userOnly ? '1' : '0'}">
                <div class="app-header">
                    <div class="app-icon">
                        ${app.logo ? `<img src="${app.logo}" alt="${app.name}" class="app-logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">` : ''}
                        <i class="${app.icon}" ${app.logo ? 'style="display: none;"' : ''}></i>
                    </div>
                    <div class="app-info">
                        <h3>${app.name}</h3>
                        <div class="app-version">v${app.version}</div>
                    </div>
                </div>
                ${showDescriptions ? `<div class="app-description">${app.description}</div>` : ''}
                <div class="app-meta">
                    <div class="app-status ${app.status}">
                        <span class="status-dot"></span>
                        ${app.status.charAt(0).toUpperCase() + app.status.slice(1)}
                    </div>
                    <div class="app-actions">
                        <button class="app-btn launch-btn" data-app-id="${app.id}">
                            <i class="fas fa-rocket"></i> Launch
                        </button>
                        <button class="app-btn secondary info-btn" data-app-id="${app.id}">
                            <i class="fas fa-info-circle"></i> Info
                        </button>
                        <!-- Mobile-friendly direct link (hidden on desktop) -->
                        <a href="${appUrl}" class="app-btn mobile-launch-link" style="display: none;">
                            <i class="fas fa-external-link-alt"></i> Open
                        </a>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Get empty state HTML
     */
    getEmptyStateHTML() {
        return `
            <div class="apps-empty">
                <i class="fas fa-search"></i>
                <h3>No apps found</h3>
                <p>Try adjusting your search terms or category filter to find what you're looking for.</p>
            </div>
        `;
    }

    /**
     * Setup app card event listeners
     */
    setupAppCardEventListeners() {
        // Prefetch chat connections when hovering chat tile
        const chatCard = document.querySelector('.app-card[data-app-id="secure-chat"]');
        if (chatCard && window.firebaseService?.prefetchChatConnections) {
            chatCard.addEventListener('mouseenter', () => window.firebaseService.prefetchChatConnections().catch(()=>{}), { once: false });
        }
        // Launch buttons
        const launchBtns = document.querySelectorAll('.launch-btn');
        launchBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const appId = btn.dataset.appId;
                this.launchApp(appId);
            });
        });

        // Info buttons
        const infoBtns = document.querySelectorAll('.info-btn');
        infoBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const appId = btn.dataset.appId;
                this.showAppInfo(appId);
            });
        });

        // Card clicks
        const appCards = document.querySelectorAll('.app-card');
        appCards.forEach(card => {
            card.addEventListener('click', () => {
                const appId = card.dataset.appId;
                this.launchApp(appId);
            });
        });
    }

    /**
     * Launch an app
     */
    launchApp(appId) {
        const app = this.apps.find(a => a.id === appId);
        if (!app) {
            this.showError('App not found');
            return;
        }

        if (app.status === 'offline') {
            this.showError('This app is currently offline');
            return;
        }

        if (app.status === 'maintenance') {
            this.showWarning('This app is under maintenance. Some features may be unavailable.');
        }

        try {
            // External URL apps (e.g. GitHub-hosted tools)
            if (app.externalUrl) {
                window.open(app.externalUrl, '_blank', 'noopener,noreferrer');
                this.showSuccess(`Opening ${app.name}...`);
                return;
            }
            // Internal anchors switch sections instead of opening new windows
            if (app.path && app.path.startsWith('#')){
                const section = app.path.replace('#','');
                if (window.dashboardManager){ window.dashboardManager.switchSection(section); this.showSuccess(`Opening ${app.name}...`); }
                return;
            }
            const appUrl = new URL(app.path, window.location.href).href;
            
            // Show success message
            this.showSuccess(`Launching ${app.name}...`);
            this.openAppInShell(app, appUrl);

        } catch (error) {
            console.error('Error launching app:', error);
            this.showError('Failed to launch app');
        }
    }

    /** Apps whose iframe survives a shell close so state is preserved. */
    isKeepAliveApp(src){
        return /apps\/(secure-chat|specifications|revex)\/index\.html/i.test(String(src || ''));
    }
    /** Document identity of an app URL, ignoring query string and hash. */
    appDocKey(src){
        try { const u = new URL(String(src), window.location.href); return u.origin + u.pathname; }
        catch (_) { return String(src || '').split('?')[0].split('#')[0]; }
    }

    openAppInShell(app, appUrl){
        const shell = document.getElementById('app-shell');
        const frame = document.getElementById('app-shell-frame');
        const title = document.getElementById('app-shell-title');
        if (!shell || !frame){
            window.location.href = appUrl;
            return;
        }
        this._activeAppUrl = appUrl;
        try { frame.setAttribute('allow', 'web-share; clipboard-write; clipboard-read; fullscreen; camera; microphone'); } catch (_) {}
        const currentSrc = String(frame.getAttribute('src') || '');
        const currentIsChat = /apps\/secure-chat\/index\.html/i.test(currentSrc) && currentSrc !== 'about:blank';
        const nextIsChat = String(app?.id || '') === 'secure-chat' || /apps\/secure-chat\/index\.html/i.test(String(appUrl || ''));
        const shouldReuseChat = currentIsChat && nextIsChat;
        // Same app reopened while its iframe is still mounted: keep it alive so the
        // user resumes exactly where they left off, and hand parameters over by
        // postMessage instead of reloading the document.
        const sameMounted = currentSrc && currentSrc !== 'about:blank'
            && this.appDocKey(currentSrc) === this.appDocKey(appUrl);
        const shouldReuse = shouldReuseChat || (sameMounted && this.isKeepAliveApp(appUrl));
        if (!shouldReuse){
            const separator = appUrl.includes('?') ? '&' : '?';
            frame.src = `${appUrl}${separator}inShell=1`;
        } else if (sameMounted){
            try{
                const q = new URL(appUrl, window.location.href).searchParams;
                const params = {};
                ['specUrl','specTitle','specNote','specProjectId','section','view','mode','item','projectId']
                    .forEach((k)=>{ if (q.get(k)) params[k] = q.get(k); });
                if (Object.keys(params).length){
                    frame.contentWindow?.postMessage({ type: 'liber:app-params', params }, '*');
                }
            } catch (_) {}
        }
        if (title) title.textContent = app?.name || 'App';
        shell.classList.remove('hidden');
        shell.classList.remove('chat-kept-alive');
        shell.setAttribute('aria-hidden', 'false');
        document.body.classList.add('app-shell-open');
        window.dispatchEvent(new CustomEvent('liber:app-shell-open', { detail: { appId: app?.id || '', appUrl } }));
    }

    closeAppShell(){
        if (this._closingShell) return;
        this._closingShell = true;
        const shell = document.getElementById('app-shell');
        const frame = document.getElementById('app-shell-frame');
        try{
            if (!shell || !frame) return;
            const activeSrc = String(frame.getAttribute('src') || '');
            const isChatShell = /apps\/secure-chat\/index\.html/i.test(activeSrc);
            // Keep secure-chat (in-call state) and specifications (unsaved edits,
            // scroll position, open section) alive across shell close/open.
            const keepAliveChat = isChatShell || this.isKeepAliveApp(activeSrc);
            if (!keepAliveChat){
                frame.src = 'about:blank';
                this._activeAppUrl = '';
                shell.classList.remove('chat-kept-alive');
                shell.classList.add('hidden');
            } else {
                shell.classList.remove('hidden');
                shell.classList.add('chat-kept-alive');
            }
            shell.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('app-shell-open');
            window.dispatchEvent(new Event('liber:app-shell-close'));
            // iOS/mobile: reset overflow and restore scroll capability after closing shell
            if (this.isMobileDevice()){
                try { frame.contentWindow?.blur(); } catch (_){}
                const doit = ()=>{
                    document.body.style.overflow = '';
                    document.body.style.touchAction = '';
                    document.documentElement.style.overflow = '';
                    document.documentElement.style.touchAction = '';
                    const activeSection = document.querySelector('.content-section.active');
                    if (activeSection && activeSection.scrollHeight > activeSection.clientHeight){
                        const y = activeSection.scrollTop;
                        activeSection.scrollTop = y + 1;
                        requestAnimationFrame(()=>{
                            activeSection.scrollTop = y;
                        });
                    }
                };
                requestAnimationFrame(()=> requestAnimationFrame(doit));
            }
            // Ensure control panel view is visible and has an active section.
            const dashboard = document.getElementById('dashboard');
            const authScreen = document.getElementById('auth-screen');
            if (dashboard && authScreen && !dashboard.classList.contains('hidden') && authScreen.classList.contains('hidden')){
                const activeSection = document.querySelector('.content-section.active');
                if (!activeSection && window.dashboardManager && typeof window.dashboardManager.switchSection === 'function'){
                    const preferred = (window.dashboardManager.getCurrentSection && window.dashboardManager.getCurrentSection()) || 'apps';
                    window.dashboardManager.switchSection(preferred);
                }
            }
        }finally{
            setTimeout(()=>{ this._closingShell = false; }, 120);
        }
    }

    /**
     * Check if device is mobile
     */
    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
               window.innerWidth <= 768;
    }

    /**
     * Show app information
     */
    showAppInfo(appId) {
        const app = this.apps.find(a => a.id === appId);
        if (!app) {
            this.showError('App not found');
            return;
        }

        const modal = this.createModal();
        modal.innerHTML = `
            <div class="modal-header">
                <h3>${app.name}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="app-info-details">
                    <div class="app-info-header">
                        <div class="app-icon large">
                            <i class="${app.icon}"></i>
                        </div>
                        <div class="app-info-text">
                            <h4>${app.name}</h4>
                            <p class="app-version">Version ${app.version}</p>
                            <p class="app-author">by ${app.author}</p>
                        </div>
                    </div>
                    <div class="app-description-full">
                        <h5>Description</h5>
                        <p>${app.description}</p>
                    </div>
                    <div class="app-details">
                        <div class="detail-item">
                            <span class="detail-label">Category:</span>
                            <span class="detail-value">${app.category}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Status:</span>
                            <span class="detail-value status-${app.status}">${app.status}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Last Updated:</span>
                            <span class="detail-value">${new Date(app.lastUpdated).toLocaleDateString()}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Path:</span>
                            <span class="detail-value">${app.path}</span>
                        </div>
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
                    <button class="btn" onclick="appsManager.launchApp('${app.id}'); this.closest('.modal-overlay').remove()">
                        <i class="fas fa-rocket"></i> Launch App
                    </button>
                </div>
            </div>
        `;

        // Setup modal close
        const closeBtn = modal.querySelector('.modal-close');
        closeBtn.addEventListener('click', () => modal.remove());

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    /**
     * Create modal element
     */
    createModal() {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 2000;
            padding: 20px;
        `;

        const modalContent = document.createElement('div');
        modalContent.className = 'modal';
        modalContent.style.cssText = `
            background: var(--secondary-bg);
            border: 1px solid var(--border-color);
            border-radius: var(--border-radius);
            max-width: 600px;
            width: 100%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: var(--shadow-hover);
            animation: slideUp 0.3s ease-out;
        `;

        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        return modalContent;
    }

    /**
     * Show loading state
     */
    showLoadingState() {
        const appsGrid = document.getElementById('apps-grid');
        if (!appsGrid) return;

        appsGrid.innerHTML = Array(6).fill(0).map(() => `
            <div class="app-card loading">
                <div class="app-header">
                    <div class="app-icon"></div>
                    <div class="app-info">
                        <h3></h3>
                        <div class="app-version"></div>
                    </div>
                </div>
                <div class="app-description"></div>
                <div class="app-meta">
                    <div class="app-status"></div>
                    <div class="app-actions"></div>
                </div>
            </div>
        `).join('');
    }

    /**
     * Update apps count
     */
    updateAppsCount() {
        const countElement = document.getElementById('apps-count');
        if (countElement) {
            countElement.textContent = this.apps.length;
        }
    }

    /**
     * Get all apps
     */
    getApps() {
        return Promise.resolve(this.apps);
    }

    /**
     * Get app by ID
     */
    getAppById(appId) {
        return this.apps.find(app => app.id === appId);
    }

    /**
     * Show success message
     */
    showSuccess(message) {
        if (window.dashboardManager) {
            window.dashboardManager.showSuccess(message);
        }
    }

    /**
     * Show error message
     */
    showError(message) {
        if (window.dashboardManager) {
            window.dashboardManager.showError(message);
        }
    }

    /**
     * Show warning message
     */
    showWarning(message) {
        if (window.dashboardManager) {
            window.dashboardManager.showNotification(message, 'warning');
        }
    }
}

// Create global instance
window.appsManager = new AppsManager();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AppsManager;
}
