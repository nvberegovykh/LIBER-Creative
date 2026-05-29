/**
 * WALL-E AI Assistant Integration Module for Liber Apps Control Panel
 * Powered by GPT-4o and OpenAI Assistant API
 */

class ChatGPTIntegration {
    constructor() {
        // Configuration will be loaded from Gist
        this.apiKey = null;
        this.assistantId = null;
        this.proxyUrl = null; // Optional serverless proxy base URL
        this.proxyAuth = null; // Optional proxy auth token
        this.isEnabled = false;
        this.chatHistory = [];
        this.currentContext = 'liber-apps';
        this.fileUploads = [];
        this.maxFileSize = 25 * 1024 * 1024; // 25MB limit
        this.supportedFileTypes = ['image/*', 'application/pdf', 'text/*', 'application/json', 'application/xml', 'text/csv'];
        this.isExpanded = false;
        this.threadId = null;
        this.configLoaded = false;
        this.currentUserId = null;
        this.functionsRegion = 'europe-west1';
        this.projectId = 'liber-apps-cca20';
        this.functionsBaseUrl = '';
        this.nycResolverUrl = '';
        this.maxHistoryItems = 50; // Keep last 50 messages
        this.cryptoKey = null; // WebCrypto key for local chat encryption
        this.cryptoReady = false;
        this.responsesModel = 'gpt-4.1';
        // Keep fallback on a chat-completions-native model for reliability.
        this.chatFallbackModel = 'gpt-4o-mini';
        this.generatedLocalReports = new Map();
        this._jsPdfLoadPromise = null;
        this._lastZoningCtx = null;
        this.isFullscreen = false;
        
        // Thread management
        this.savedThreads = [];
        this.currentThreadName = 'New Chat';
        this.maxThreads = 20; // Keep last 20 threads
        
        this.init();
    }

    /**
     * Initialize WALL-E integration
     */
    async init() {
        try {
            await this.loadConfiguration();
            if (this.isEnabled) {
                // Assistants API is deprecated; keep startup lightweight and Responses-first.
                Promise.resolve().then(() => {
                    if (window.__devLog) window.__devLog('WALL-E startup: Responses API mode enabled');
                });
            }
        } catch (error) {
            if (window.__devWarn) window.__devWarn('⚠️ WALL-E configuration failed, but widget will still be created:', error.message);
        }
        
        // Always create the interface regardless of configuration status
        try {
            await this.initCrypto();
            this.loadSavedThreads(); // Load saved threads
            this.createChatInterface();
            this.setupEventListeners();
            this.loadChatHistory();
            this.displayChatHistory();
            
            // Set initial state based on screen size
            if (window.innerWidth <= 768) {
                // On mobile, let the dashboard control visibility
                this.isExpanded = false;
                // Don't auto-expand on mobile - let dashboard handle it
            } else {
                // On desktop, always ensure widget is visible
                this.isExpanded = true;
                this.expandChat();
            }
            
            if (window.__devLog) window.__devLog('✅ WALL-E widget initialized successfully');
        } catch (error) {
            console.error('❌ Critical error initializing WALL-E widget:', error);
        }
    }

    /**
     * Helper: base URL for OpenAI (proxy-aware)
     */
    getOpenAIBase() {
        return this.proxyUrl || 'https://api.openai.com';
    }

    getFunctionsBase() {
        if (this.functionsBaseUrl) return this.functionsBaseUrl;
        const region = String(this.functionsRegion || 'europe-west1').trim();
        const pid = String(this.projectId || 'liber-apps-cca20').trim();
        return `https://${region}-${pid}.cloudfunctions.net`;
    }

    /**
     * Helper: build headers, optionally JSON content-type and Assistants beta header
     */
    buildOpenAIHeaders({ json = true, beta = null } = {}) {
        const headers = {};
        if (json) headers['Content-Type'] = 'application/json';
        if (beta) headers['OpenAI-Beta'] = beta;
        if (!this.proxyUrl && this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        if (this.proxyUrl && this.proxyAuth) {
            headers['X-Proxy-Auth'] = this.proxyAuth;
        }
        return headers;
    }

    /**
     * Helper: perform fetch to OpenAI (or proxy) with sensible defaults
     */
    async openaiFetch(path, { method = 'GET', headers = {}, body = undefined, beta = null, json = true, timeoutMs = 45000 } = {}) {
        const base = this.getOpenAIBase();
        const url = path.startsWith('http') ? path : `${base}${path}`;
        const mergedHeaders = { ...this.buildOpenAIHeaders({ json, beta }), ...headers };
        const controller = new AbortController();
        const timer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
        }, Math.max(5000, Number(timeoutMs || 45000)));
        try {
            return await fetch(url, { method, headers: mergedHeaders, body, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Ensure assistant supports file attachments
     */
    async ensureAssistantSupportsFiles() {
        try {
            if (!this.assistantId) {
                if (window.__devLog) window.__devLog('Assistant ID not set; skipping file support check');
                return;
            }
            // Try v2 endpoint first (newer API)
            let response = await this.openaiFetch(`/v2/assistants/${this.assistantId}`, {
                beta: 'assistants=v2',
                json: false
            });

            // If v2 fails, try v1 endpoint (fallback)
            if (!response.ok) {
                if (window.__devLog) window.__devLog('v2 endpoint failed for file support check, trying v1...');
                response = await this.openaiFetch(`/v1/assistants/${this.assistantId}`, {
                    beta: 'assistants=v1',
                    json: false
                });
            }

            if (!response.ok) {
                if (window.__devWarn) window.__devWarn('⚠️ Could not fetch assistant configuration for file support check, proceeding with current setup');
                if (window.__devLog) window.__devLog('✅ File attachments will be attempted but may not work');
                return;
            }

            const assistant = await response.json();
            
            // Check if assistant uses a model that supports file attachments
            const supportedModels = [
                'gpt-4o',
                'gpt-4o-mini', 
                'gpt-4-turbo',
                'gpt-4-turbo-preview',
                'gpt-4-vision-preview'
            ];

            if (supportedModels.includes(assistant.model)) {
                if (window.__devLog) window.__devLog(`✅ Assistant is using supported model: ${assistant.model}`);
                if (window.__devLog) window.__devLog(`✅ File attachments are supported and ready to use`);
            } else {
                if (window.__devWarn) window.__devWarn(`⚠️ Assistant is using model: ${assistant.model} which may not support file attachments`);
                if (window.__devWarn) window.__devWarn(`💡 Consider updating to gpt-4o-mini for full file support`);
            }
        } catch (error) {
            if (window.__devWarn) window.__devWarn('Error checking assistant configuration:', error);
        }
    }

    /**
     * Check assistant configuration
     */
    async checkAssistantConfig() {
        try {
            if (!this.assistantId) {
                if (window.__devLog) window.__devLog('Assistant ID not set; skipping assistant config check');
                return;
            }
            if (window.__devLog) window.__devLog('Checking assistant configuration...');
            
            // Try v2 endpoint first (newer API)
            let response = await this.openaiFetch(`/v2/assistants/${this.assistantId}`, {
                beta: 'assistants=v2',
                json: false
            });

            // If v2 fails, try v1 endpoint (fallback)
            if (!response.ok) {
                if (window.__devLog) window.__devLog('v2 endpoint failed for config check, trying v1...');
                response = await this.openaiFetch(`/v1/assistants/${this.assistantId}`, {
                    beta: 'assistants=v1',
                    json: false
                });
            }

            if (!response.ok) {
                if (window.__devWarn) window.__devWarn(`⚠️ Could not fetch assistant config (${response.status}), but assistant will still work`);
                if (window.__devLog) window.__devLog('✅ Assistant is ready to use despite config check failure');
                return;
            }

            const assistant = await response.json();
            if (window.__devLog) window.__devLog('Assistant Configuration:', {
                id: assistant.id,
                name: assistant.name,
                model: assistant.model,
                instructions: assistant.instructions?.substring(0, 100) + '...',
                tools: assistant.tools?.length || 0
            });
            
            if (assistant.model !== 'gpt-4o-mini') {
                if (window.__devWarn) window.__devWarn(`⚠️ Assistant is using model: ${assistant.model}, expected: gpt-4o-mini`);
            } else {
                if (window.__devLog) window.__devLog('✅ Assistant is correctly configured with gpt-4o-mini');
            }
        } catch (error) {
            // Don't crash the widget - just log the error and continue
            if (window.__devWarn) window.__devWarn('⚠️ Error checking assistant config (non-critical):', error.message);
            if (window.__devLog) window.__devLog('✅ Assistant will continue to work normally');
        }
    }

    /**
     * Load saved threads for current user
     */
    loadSavedThreads() {
        try {
            const userId = this.getCurrentUserId();
            const threadsKey = `wall_e_saved_threads_${userId}`;
            const savedThreads = localStorage.getItem(threadsKey);
            
            if (savedThreads) {
                let parsed;
                try { parsed = JSON.parse(savedThreads); } catch { parsed = null; }
                if (parsed && parsed.enc && parsed.data) {
                    if (this.cryptoReady) {
                        // Decrypt asynchronously; update selector when done
                        this.decryptString(parsed.data).then((plain) => {
                            try {
                                const arr = JSON.parse(plain || '[]');
                                this.savedThreads = Array.isArray(arr) ? arr : [];
                                if (window.__devLog) window.__devLog('Loaded', this.savedThreads.length, 'encrypted threads');
                                this.updateThreadSelector();
                            } catch {
                                this.savedThreads = [];
                            }
                        });
                    } else {
                        if (window.__devWarn) window.__devWarn('Encrypted saved threads present but crypto not ready');
                        this.savedThreads = [];
                    }
                } else if (Array.isArray(parsed)) {
                    this.savedThreads = parsed;
                    if (window.__devLog) window.__devLog('Loaded', this.savedThreads.length, 'saved threads');
                } else {
                    this.savedThreads = [];
                }
            } else {
                if (window.__devLog) window.__devLog('No saved threads found');
            }
        } catch (error) {
            console.error('Failed to load saved threads:', error);
        }
    }

    /**
     * Save threads to localStorage
     */
    saveThreads() {
        try {
            const userId = this.getCurrentUserId();
            const threadsKey = `wall_e_saved_threads_${userId}`;
            
            // Keep only last 20 threads
            const threadsToSave = this.savedThreads.slice(-this.maxThreads);
            
            if (this.cryptoReady) {
                const plain = JSON.stringify(threadsToSave);
                this.encryptString(plain).then((cipher) => {
                    if (cipher) {
                        const envelope = { v: 1, enc: true, data: cipher };
                        localStorage.setItem(threadsKey, JSON.stringify(envelope));
                        if (window.__devLog) window.__devLog(`Saved ${threadsToSave.length} encrypted threads for user: ${userId}`);
                    } else {
                        localStorage.setItem(threadsKey, JSON.stringify(threadsToSave));
                        if (window.__devLog) window.__devLog(`Saved ${threadsToSave.length} (fallback plaintext) threads for user: ${userId}`);
                    }
                }).catch(() => {
                    localStorage.setItem(threadsKey, JSON.stringify(threadsToSave));
                    if (window.__devLog) window.__devLog(`Saved ${threadsToSave.length} (fallback plaintext) threads for user: ${userId}`);
                });
            } else {
                localStorage.setItem(threadsKey, JSON.stringify(threadsToSave));
                if (window.__devLog) window.__devLog(`Saved ${threadsToSave.length} threads for user: ${userId}`);
            }
        } catch (error) {
            console.error('Failed to save threads:', error);
        }
    }

    /**
     * Create a new thread
     */
    async createNewThread(threadName = null) {
        try {
            // Create new thread on OpenAI
            const newThreadId = await this.createThread();
            
            // Generate thread name if not provided
            const name = threadName || `Chat ${new Date().toLocaleString()}`;
            
            // Add to saved threads
            const newThread = {
                id: newThreadId,
                name: name,
                createdAt: new Date().toISOString(),
                lastUsed: new Date().toISOString()
            };
            
            this.savedThreads.push(newThread);
            this.saveThreads();
            
            // Set as current thread
            this.threadId = newThreadId;
            this.currentThreadName = name;
            
            // Clear chat history for new thread
            this.chatHistory = [];
            this.displayChatHistory();
            
            // Update thread selector
            this.updateThreadSelector();
            
            if (window.__devLog) window.__devLog(`Created new thread: ${name} (${newThreadId})`);
            return newThreadId;
        } catch (error) {
            console.error('Failed to create new thread:', error);
            throw error;
        }
    }

    /**
     * Switch to a different thread
     */
    async switchToThread(threadId) {
        try {
            const thread = this.savedThreads.find(t => t.id === threadId);
            if (!thread) {
                throw new Error('Thread not found');
            }
            
            // Update last used timestamp
            thread.lastUsed = new Date().toISOString();
            this.saveThreads();
            
            // Set as current thread
            this.threadId = threadId;
            this.currentThreadName = thread.name;
            
            // Load chat history for this thread
            this.loadChatHistoryForThread(threadId);
            
            // Update thread selector
            this.updateThreadSelector();
            
            if (window.__devLog) window.__devLog(`Switched to thread: ${thread.name} (${threadId})`);
        } catch (error) {
            console.error('Failed to switch thread:', error);
            throw error;
        }
    }

    /**
     * Load chat history for specific thread
     */
    loadChatHistoryForThread(threadId) {
        try {
            const userId = this.getCurrentUserId();
            const historyKey = `wall_e_chat_history_${userId}_${threadId}`;
            const savedHistory = localStorage.getItem(historyKey);
            
            if (savedHistory) {
                let parsed;
                try { parsed = JSON.parse(savedHistory); } catch { parsed = null; }
                if (parsed && parsed.enc && parsed.data) {
                    if (this.cryptoReady) {
                        this.decryptString(parsed.data).then((plain) => {
                            try {
                                const arr = JSON.parse(plain || '[]');
                                this.chatHistory = Array.isArray(arr) ? arr.slice(-this.maxHistoryItems) : [];
                                if (window.__devLog) window.__devLog(`Loaded ${this.chatHistory.length} encrypted messages for thread: ${threadId}`);
                                this.displayChatHistory();
                            } catch {
                                this.chatHistory = [];
                                this.displayChatHistory();
                            }
                        });
                        return;
                    } else {
                        if (window.__devWarn) window.__devWarn('Encrypted chat history present but crypto not ready');
                        this.chatHistory = [];
                    }
                } else if (Array.isArray(parsed)) {
                    this.chatHistory = parsed.slice(-this.maxHistoryItems);
                    if (window.__devLog) window.__devLog('Loaded', this.chatHistory.length, 'messages for thread');
                } else {
                    this.chatHistory = [];
                }
            } else {
                this.chatHistory = [];
                if (window.__devLog) window.__devLog('No history found for thread');
            }
            
            this.displayChatHistory();
        } catch (error) {
            console.error('Failed to load thread history:', error);
            this.chatHistory = [];
            this.displayChatHistory();
        }
    }

    /**
     * Save chat history for current thread
     */
    saveChatHistoryForThread() {
        try {
            if (!this.threadId) return;
            
            const userId = this.getCurrentUserId();
            const historyKey = `wall_e_chat_history_${userId}_${this.threadId}`;
            
            // Keep only last 50 messages
            const historyToSave = this.chatHistory.slice(-this.maxHistoryItems);
            if (this.cryptoReady) {
                const plain = JSON.stringify(historyToSave);
                this.encryptString(plain).then((cipher) => {
                    if (cipher) {
                        const envelope = { v: 1, enc: true, data: cipher };
                        localStorage.setItem(historyKey, JSON.stringify(envelope));
                        if (window.__devLog) window.__devLog(`Saved ${historyToSave.length} encrypted messages for thread: ${this.threadId}`);
                    } else {
                        localStorage.setItem(historyKey, JSON.stringify(historyToSave));
                        if (window.__devLog) window.__devLog(`Saved ${historyToSave.length} (fallback plaintext) messages for thread: ${this.threadId}`);
                    }
                }).catch(() => {
                    localStorage.setItem(historyKey, JSON.stringify(historyToSave));
                    if (window.__devLog) window.__devLog(`Saved ${historyToSave.length} (fallback plaintext) messages for thread: ${this.threadId}`);
                });
            } else {
                localStorage.setItem(historyKey, JSON.stringify(historyToSave));
                if (window.__devLog) window.__devLog(`Saved ${historyToSave.length} messages for thread: ${this.threadId}`);
            }
            
            // Update clear history button visibility
            this.updateClearHistoryButton(historyToSave.length > 0);
        } catch (error) {
            console.error('Failed to save thread history:', error);
        }
    }

    /**
     * Delete a thread
     */
    async deleteThread(threadId) {
        try {
            // Remove from saved threads
            this.savedThreads = this.savedThreads.filter(t => t.id !== threadId);
            this.saveThreads();
            
            // Delete thread history
            const userId = this.getCurrentUserId();
            const historyKey = `wall_e_chat_history_${userId}_${threadId}`;
            localStorage.removeItem(historyKey);
            
            // If this was the current thread, create a new one
            if (this.threadId === threadId) {
                await this.createNewThread();
            }
            
            // Update thread selector
            this.updateThreadSelector();
            
            if (window.__devLog) window.__devLog(`Deleted thread: ${threadId}`);
        } catch (error) {
            console.error('Failed to delete thread:', error);
            throw error;
        }
    }

    /**
     * Rename current thread
     */
    renameCurrentThread(newName) {
        try {
            if (!this.threadId || !newName.trim()) return;
            
            const thread = this.savedThreads.find(t => t.id === this.threadId);
            if (thread) {
                thread.name = newName.trim();
                this.currentThreadName = newName.trim();
                this.saveThreads();
                this.updateThreadSelector();
                if (window.__devLog) window.__devLog(`Renamed thread to: ${newName}`);
            }
        } catch (error) {
            console.error('Failed to rename thread:', error);
        }
    }

    /**
     * Update thread selector UI
     */
    updateThreadSelector() {
        const threadSelector = document.getElementById('chatgpt-thread-selector');
        if (!threadSelector) return;
        
        // Update current thread name
        const currentThreadName = document.getElementById('chatgpt-current-thread');
        if (currentThreadName) {
            currentThreadName.textContent = this.currentThreadName;
        }
        
        // Update thread list
        const threadList = document.getElementById('chatgpt-thread-list');
        if (threadList) {
            threadList.innerHTML = '';
            
            this.savedThreads.forEach(thread => {
                const threadItem = document.createElement('div');
                threadItem.className = `thread-item ${thread.id === this.threadId ? 'active' : ''}`;
                threadItem.innerHTML = `
                    <div class="thread-info">
                        <span class="thread-name">${thread.name}</span>
                        <small class="thread-date">${new Date(thread.lastUsed).toLocaleDateString()}</small>
                    </div>
                    <div class="thread-actions">
                        <button class="thread-rename" title="Rename" onclick="chatgptIntegration.renameThreadPrompt('${thread.id}')">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="thread-delete" title="Delete" onclick="chatgptIntegration.deleteThread('${thread.id}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                `;
                
                threadItem.addEventListener('click', (e) => {
                    if (!e.target.closest('.thread-actions')) {
                        this.switchToThread(thread.id);
                    }
                });
                
                threadList.appendChild(threadItem);
            });
        }
    }

    /**
     * Load configuration from GitHub Gist using existing SecureKeyManager
     */
    async loadConfiguration() {
        try {
            const keys = await window.secureKeyManager.getKeys();

            // 1) Configure secure proxy URL (preferred)
            const region = (keys && keys.firebase && keys.firebase.functionsRegion) || 'europe-west1';
            const projectId = (keys && keys.firebase && keys.firebase.projectId) || 'liber-apps-cca20';
            this.functionsRegion = String(region || 'europe-west1');
            this.projectId = String(projectId || 'liber-apps-cca20');
            this.functionsBaseUrl = `https://${this.functionsRegion}-${this.projectId}.cloudfunctions.net`;
            const defaultProxy = `https://${region}-${projectId}.cloudfunctions.net/openaiProxy`;
            this.proxyUrl = (keys && keys.aiProxyUrl) || defaultProxy;
            this.nycResolverUrl = `${this.functionsBaseUrl}/resolveNycZoningContext`;

            // 2) Optional direct keys (not required when proxy is present)
            if (keys && keys.openai) {
                if (keys.openai.apiKey) this.apiKey = keys.openai.apiKey;
                if (keys.openai.assistantId) this.assistantId = keys.openai.assistantId;
                if (keys.openai.responsesModel) this.responsesModel = String(keys.openai.responsesModel || this.responsesModel);
                if (keys.openai.chatFallbackModel) this.chatFallbackModel = String(keys.openai.chatFallbackModel || this.chatFallbackModel);
            }

            // Enable if either proxy or apiKey is available
            this.isEnabled = !!(this.proxyUrl || this.apiKey);
            this.configLoaded = true;
            if (window.__devLog) window.__devLog(this.isEnabled ? 'WALL-E configured (proxy or key present)' : 'WALL-E not configured');
        } catch (error) {
            // Fallback: derive proxy URL from known project/region so widget still works
            this.functionsRegion = 'europe-west1';
            this.projectId = 'liber-apps-cca20';
            this.functionsBaseUrl = `https://${this.functionsRegion}-${this.projectId}.cloudfunctions.net`;
            this.nycResolverUrl = `${this.functionsBaseUrl}/resolveNycZoningContext`;
            this.proxyUrl = 'https://europe-west1-liber-apps-cca20.cloudfunctions.net/openaiProxy';
            this.apiKey = null;
            this.assistantId = null;
            this.isEnabled = true; // proxy assumed available
            this.configLoaded = true;
            if (window.__devWarn) window.__devWarn('WALL-E: keys unavailable; using default proxy URL');
        }
    }

    /**
     * Initialize WebCrypto for encrypting chat history at rest
     */
    async initCrypto() {
        try {
            const userId = this.getCurrentUserId() || 'anonymous';
            const deviceSalt = this.getOrCreateDeviceSalt();
            const material = await window.crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(`${userId}:${deviceSalt}`),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );
            this.cryptoKey = await window.crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: new TextEncoder().encode('liber.wall_e.local_history'),
                    iterations: 100000,
                    hash: 'SHA-256'
                },
                material,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
            this.cryptoReady = true;
            if (window.__devLog) window.__devLog('WALL-E local encryption initialized');
        } catch (e) {
            if (window.__devWarn) window.__devWarn('Local crypto init failed; falling back to plaintext history', e);
            this.cryptoReady = false;
        }
    }

    getOrCreateDeviceSalt() {
        const key = 'wall_e_device_salt_v1';
        let salt = localStorage.getItem(key);
        if (!salt) {
            const arr = new Uint8Array(16);
            window.crypto.getRandomValues(arr);
            salt = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem(key, salt);
        }
        return salt;
    }

    async encryptString(plaintext) {
        if (!this.cryptoReady || !this.cryptoKey) return null;
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const cipherBuf = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.cryptoKey,
            enc.encode(plaintext)
        );
        const payload = new Uint8Array(iv.length + new Uint8Array(cipherBuf).length);
        payload.set(iv, 0);
        payload.set(new Uint8Array(cipherBuf), iv.length);
        return btoa(String.fromCharCode(...payload));
    }

    async decryptString(b64) {
        if (!this.cryptoReady || !this.cryptoKey) return null;
        try {
            const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const iv = raw.slice(0, 12);
            const data = raw.slice(12);
            const plainBuf = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                this.cryptoKey,
                data
            );
            return new TextDecoder().decode(plainBuf);
        } catch (e) {
            if (window.__devWarn) window.__devWarn('Decrypt failed; possibly legacy plaintext history', e);
            return null;
        }
    }

    /**
     * Decode base64 URL using the same method as SecureKeyManager
     */
    decodeUrl(encoded) {
        try {
            return atob(encoded);
        } catch (error) {
            console.error('Failed to decode WALL-E URL:', error);
            return '';
        }
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Listen for context changes
        document.addEventListener('app-context-changed', (e) => {
            this.updateContext(e.detail.context);
        });
        // When app shell opens, refresh initial guidelines (context may have changed)
        window.addEventListener('liber:app-shell-open', () => {
            if (this.chatHistory.length === 0) {
                setTimeout(() => this.displayChatHistory(), 150);
            }
        });
    }

    /**
     * Create chat interface
     */
    createChatInterface() {
        if (window.__devLog) window.__devLog('Creating chat interface...');
        const chatHTML = `
            <div id="chatgpt-widget" class="chatgpt-widget ${this.isEnabled ? 'enabled' : 'disabled'}">
                <div class="chatgpt-header" id="chatgpt-header">
                    <div class="chatgpt-title">
                        <img src="images/wall_e.svg" alt="WALL-E" class="chatgpt-icon">
                        <span>WALL-E</span>
                    </div>
                    <div class="chatgpt-controls">
                        <button class="chatgpt-new-thread" id="chatgpt-new-thread" title="New Chat">
                            <i class="fas fa-plus"></i>
                        </button>
                        <button class="chatgpt-fullscreen" id="chatgpt-fullscreen" title="Fullscreen">
                            <i class="fas fa-expand"></i>
                        </button>
                        <button class="chatgpt-thread-menu" id="chatgpt-thread-menu" title="Saved Chats">
                            <i class="fas fa-list"></i>
                        </button>
                        <button class="chatgpt-clear-history" id="chatgpt-clear-history" title="Clear Chat History" style="display: none;">
                            <i class="fas fa-trash"></i>
                        </button>
                        <button class="chatgpt-toggle" id="chatgpt-toggle" title="Toggle Chat">
                            <i class="fas fa-chevron-up"></i>
                        </button>
                    </div>
                </div>
                
                <!-- Thread Selector Dropdown -->
                <div class="chatgpt-thread-selector" id="chatgpt-thread-selector" style="display: none;">
                    <div class="thread-selector-header">
                        <span id="chatgpt-current-thread">${this.currentThreadName}</span>
                        <button class="thread-selector-close" id="thread-selector-close">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="thread-list" id="chatgpt-thread-list">
                        <!-- Thread items will be populated here -->
                    </div>
                </div>
                
                <div class="chatgpt-body" id="chatgpt-body" style="display: ${window.innerWidth <= 768 ? 'flex' : 'none'};">
                    <div class="chatgpt-messages" id="chatgpt-messages">
                        <div class="chatgpt-welcome">
                            <img src="images/wall_e.svg" alt="WALL-E" class="welcome-icon">
                            <h4>Wall-eeeee!</h4>
                            <p>Any help?</p>
                            ${!this.isEnabled ? '<p class="setup-notice"><strong>⚠️ Configuration Required:</strong> WALL-E configuration could not be loaded. Please check the Gist setup.</p>' : ''}
                        </div>
                    </div>
                    <div class="chatgpt-input-area">
                        <div class="chatgpt-file-upload" id="chatgpt-file-upload">
                            <input type="file" id="chatgpt-file-input" multiple accept="${this.supportedFileTypes.join(',')}" style="display: none;">
                            <button class="chatgpt-upload-btn" id="chatgpt-upload-btn" title="Attach files">
                                <i class="fas fa-paperclip"></i>
                            </button>
                        </div>
                        <div class="chatgpt-input-container">
                            <textarea id="chatgpt-input" placeholder="Ask WALL-E anything, upload files, or request image generation..." rows="1"></textarea>
                            <button class="chatgpt-send" id="chatgpt-send" title="Send message">
                                <i class="fas fa-paper-plane"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Add to body if not exists
        if (!document.getElementById('chatgpt-widget')) {
            if (window.__devLog) window.__devLog('Adding widget to body...');
            document.body.insertAdjacentHTML('beforeend', chatHTML);
            if (window.__devLog) window.__devLog('Widget added successfully');
        } else {
            if (window.__devLog) window.__devLog('Widget already exists');
        }

        this.setupChatEventListeners();
    }

    /**
     * Setup chat event listeners
     */
    setupChatEventListeners() {
        const header = document.getElementById('chatgpt-header');
        const toggle = document.getElementById('chatgpt-toggle');
        const send = document.getElementById('chatgpt-send');
        const input = document.getElementById('chatgpt-input');
        const uploadBtn = document.getElementById('chatgpt-upload-btn');
        const fileInput = document.getElementById('chatgpt-file-input');
        const clearHistoryBtn = document.getElementById('chatgpt-clear-history');
        const newThreadBtn = document.getElementById('chatgpt-new-thread');
        const fullscreenBtn = document.getElementById('chatgpt-fullscreen');
        const threadMenuBtn = document.getElementById('chatgpt-thread-menu');
        const threadSelector = document.getElementById('chatgpt-thread-selector');
        const threadSelectorClose = document.getElementById('thread-selector-close');
        const widget = document.getElementById('chatgpt-widget');
        const body = document.getElementById('chatgpt-body');

        // Add header click listener for mobile expansion
        if (header) {
            if (window.__devLog) window.__devLog('Setting up header click listener');
            header.addEventListener('click', (e) => {
                if (window.__devLog) window.__devLog('Header clicked');
                // Don't trigger if clicking on toggle button or other controls
                if (e.target.closest('.chatgpt-controls')) {
                    if (window.__devLog) window.__devLog('Clicked on controls, ignoring');
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                this.toggleChat();
            });
        } else {
            if (window.__devWarn) window.__devWarn('Header element not found');
        }

        // Add specific click listener for WALL-E icon and title
        const title = document.querySelector('.chatgpt-title');
        if (title) {
            if (window.__devLog) window.__devLog('Setting up title click listener');
            title.addEventListener('click', (e) => {
                if (window.__devLog) window.__devLog('Title clicked');
                e.preventDefault();
                e.stopPropagation();
                this.toggleChat();
            });
        } else {
            if (window.__devWarn) window.__devWarn('Title element not found');
        }

        // Add click listener for the WALL-E icon specifically
        const icon = document.querySelector('.chatgpt-icon');
        if (icon) {
            if (window.__devLog) window.__devLog('Setting up icon click listener');
            icon.addEventListener('click', (e) => {
                if (window.__devLog) window.__devLog('Icon clicked');
                e.preventDefault();
                e.stopPropagation();
                this.toggleChat();
            });
        } else {
            if (window.__devWarn) window.__devWarn('Icon element not found');
        }

        if (toggle) {
            if (window.__devLog) window.__devLog('Setting up toggle click listener');
            toggle.addEventListener('click', (e) => {
                if (window.__devLog) window.__devLog('Toggle clicked');
                e.preventDefault();
                e.stopPropagation();
                this.toggleChat();
            });
        } else {
            if (window.__devWarn) window.__devWarn('Toggle element not found');
        }

        // New thread button
        if (newThreadBtn) {
            newThreadBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.createNewThread();
            });
        }

        // Thread menu button
        if (threadMenuBtn) {
            threadMenuBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleThreadSelector();
            });
        }

        if (fullscreenBtn) {
            fullscreenBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleFullscreen();
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isFullscreen) {
                this.toggleFullscreen(false);
            }
        });

        // Thread selector close button
        if (threadSelectorClose) {
            threadSelectorClose.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.hideThreadSelector();
            });
        }

        if (clearHistoryBtn) {
            clearHistoryBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.clearChatHistory();
            });
        }

        if (send) {
            send.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.sendMessage();
            });
        }

        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });

            input.addEventListener('input', () => {
                this.autoResizeTextarea(input);
            });
        }

        if (uploadBtn) {
            uploadBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fileInput.click();
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.handleFileUpload(e));
        }

        // Add drag and drop functionality
        if (widget) {
            widget.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleDragOver(e);
            });

            widget.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleDragLeave(e);
            });

            widget.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleDrop(e);
            });
        }

        // Add paste event listener to the entire document for global paste
        document.addEventListener('paste', (e) => {
            // Only handle paste if WALL-E is expanded and focused
            if (this.isExpanded && (e.target === input || input.contains(e.target))) {
                this.handlePaste(e);
            }
        });
    }

    /**
     * Handle paste events for file uploads
     */
    handlePaste(e) {
        // Prevent duplicate processing
        if (e.defaultPrevented) {
            return;
        }
        
        const items = e.clipboardData?.items;
        if (!items) return;

        const files = [];
        let hasFiles = false;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            
            if ((item.type || '').indexOf('image') !== -1) {
                const file = item.getAsFile();
                if (file) {
                    files.push(file);
                    hasFiles = true;
                }
            } else if ((item.type || '').indexOf('text') !== -1) {
                // Handle text paste - let it go through normally
                continue;
            }
        }

        if (hasFiles) {
            e.preventDefault();
            if (window.__devLog) window.__devLog('Processing', files.length, 'files from paste');
            this.processFiles(files);
        }
    }

    /**
     * Handle drag over events
     */
    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const widget = document.getElementById('chatgpt-widget');
        if (widget) {
            widget.classList.add('drag-over');
        }
    }

    /**
     * Handle drag leave events
     */
    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const widget = document.getElementById('chatgpt-widget');
        if (widget) {
            widget.classList.remove('drag-over');
        }
    }

    /**
     * Handle drop events
     */
    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const widget = document.getElementById('chatgpt-widget');
        if (widget) {
            widget.classList.remove('drag-over');
        }

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            this.processFiles(files);
        }
    }

    /**
     * Process uploaded files
     */
    processFiles(files) {
        files.forEach(file => {
            // Check if file is already in uploads (prevent duplicates)
            const isDuplicate = this.fileUploads.some(existingFile => 
                existingFile.name === file.name && 
                existingFile.size === file.size &&
                existingFile.lastModified === file.lastModified
            );
            
            if (isDuplicate) {
                if (window.__devLog) window.__devLog(`Skipping duplicate file: ${file.name}`);
                return;
            }
            
            if (file.size > this.maxFileSize) {
                this.showError(`File ${file.name} is too large. Maximum size is 25MB.`);
                return;
            }

            if (!this.isFileTypeSupported(file.type)) {
                this.showError(`File type ${file.type} is not supported.`);
                return;
            }

            this.fileUploads.push(file);
        });

        this.updateFileUploadDisplay();
        
        // Show success message
        if (files.length === 1) {
            this.showSuccess(`File "${files[0].name}" uploaded successfully!`);
        } else {
            this.showSuccess(`${files.length} files uploaded successfully!`);
        }
    }

    /**
     * Show success message
     */
    showSuccess(message) {
        if (window.dashboardManager) {
            window.dashboardManager.showSuccess(message);
        } else {
            if (window.__devLog) window.__devLog('WALL-E Success:', message);
            // Show a simple alert if dashboard manager is not available
            alert('WALL-E Success: ' + message);
        }
    }

    /**
     * Show image generation modal
     */
    showImageGenerationModal() {
        if (!this.isEnabled) {
            this.showError('WALL-E is not configured. Please check the Gist setup.');
            return;
        }

        // Remove any existing modal
        const existingModal = document.querySelector('.modal-overlay');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content image-gen-modal">
                <div class="modal-header">
                    <h3><img src="images/wall_e.svg" alt="WALL-E" style="width: 20px; height: 20px; margin-right: 8px;"> Generate Image with WALL-E</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="setting-group">
                        <label for="image-prompt">Image Description:</label>
                        <textarea id="image-prompt" placeholder="Describe the image you want to generate..." rows="4"></textarea>
                        <small>Be detailed and specific for better results</small>
                    </div>
                    <div class="setting-group">
                        <label for="image-size">Image Size:</label>
                        <select id="image-size">
                            <option value="1024x1024">Square (1024x1024)</option>
                            <option value="1792x1024">Landscape (1792x1024)</option>
                            <option value="1024x1792">Portrait (1024x1792)</option>
                        </select>
                    </div>
                    <div class="setting-group">
                        <label for="image-quality">Quality:</label>
                        <select id="image-quality">
                            <option value="standard">Standard</option>
                            <option value="hd">HD</option>
                        </select>
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
                    <button class="btn" onclick="chatgptIntegration.generateImage()">Generate Image</button>
                </div>
            </div>
        `;

        // Setup modal close
        const closeBtn = modal.querySelector('.modal-close');
        closeBtn.addEventListener('click', () => modal.remove());

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        document.body.appendChild(modal);
        
        // Focus on the textarea
        const textarea = modal.querySelector('#image-prompt');
        if (textarea) {
            setTimeout(() => textarea.focus(), 100);
        }
    }

    /**
     * Generate image using DALL-E
     */
    async generateImage() {
        // Require either proxy or direct API key
        if (!this.proxyUrl && !this.apiKey) {
            this.showError('WALL-E is not configured. Please check the Gist setup.');
            return;
        }

        const promptInput = document.getElementById('image-prompt');
        const sizeInput = document.getElementById('image-size');
        const qualityInput = document.getElementById('image-quality');

        if (!promptInput || !sizeInput || !qualityInput) {
            this.showError('Image generation modal not found.');
            return;
        }

        const prompt = promptInput.value.trim();
        const size = sizeInput.value;
        const quality = qualityInput.value;

        if (!prompt) {
            this.showError('Please enter an image description.');
            return;
        }

        // Close modal
        const modal = document.querySelector('.modal-overlay');
        if (modal) {
            modal.remove();
        }

        // Add user message to chat
        this.addMessage('user', `Generate image: ${prompt}`);

        // Show typing indicator
        this.addTypingIndicator();

        try {
            const imageUrl = await this.callDALLE(prompt, size, quality);
            this.removeTypingIndicator();
            
            // Add image response
            this.addImageMessage(imageUrl, prompt);
        } catch (error) {
            this.removeTypingIndicator();
            this.addMessage('error', `Image generation failed: ${error.message}`);
        }
    }

    /**
     * Call DALL-E API
     */
    async callDALLE(prompt, size, quality) {
        const response = await this.openaiFetch('/v1/images/generations', {
            method: 'POST',
            beta: null,
            body: JSON.stringify({
                model: 'dall-e-3',
                prompt: prompt,
                n: 1,
                size: size,
                quality: quality
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || 'Failed to generate image');
        }

        const data = await response.json();
        return data.data[0].url;
    }

    /**
     * Add image message to chat
     */
    addImageMessage(imageUrl, prompt) {
        const messagesContainer = document.getElementById('chatgpt-messages');
        if (!messagesContainer) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = 'chatgpt-message assistant';

        const messageHTML = `
            <div class="message-avatar">
                <img src="images/wall_e.svg" alt="WALL-E" class="avatar-icon">
            </div>
            <div class="message-content">
                <div class="message-text">
                    <p>Here's your generated image based on: "${prompt}"</p>
                    <div class="generated-image">
                        <img src="${imageUrl}" alt="Generated image" style="max-width: 100%; border-radius: 8px; margin-top: 8px;">
                        <div class="image-actions">
                            <a href="${imageUrl}" target="_blank" class="btn btn-secondary btn-sm">
                                <i class="fas fa-external-link-alt"></i> Open Full Size
                            </a>
                            <button class="btn btn-secondary btn-sm" onclick="chatgptIntegration.downloadImage('${imageUrl}', '${prompt.replace(/[^a-zA-Z0-9]/g, '_')}')">
                                <i class="fas fa-download"></i> Download
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        messageDiv.innerHTML = messageHTML;
        messagesContainer.appendChild(messageDiv);
        messageDiv.querySelectorAll('.wall-e-file-download').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const fileId = String(btn.getAttribute('data-file-id') || '').trim();
                if (!fileId) return;
                this.downloadGeneratedFile(fileId);
            });
        });

        // Scroll to bottom
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        // Add to history
        this.chatHistory.push({ role: 'assistant', content: `Generated image: ${prompt}`, imageUrl, timestamp: new Date() });

        // Limit history
        if (this.chatHistory.length > 50) {
            this.chatHistory = this.chatHistory.slice(-50);
        }
    }

    /**
     * Download generated image
     */
    async downloadImage(imageUrl, filename) {
        try {
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `wall-e-generated-${filename}.png`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } catch (error) {
            this.showError('Failed to download image');
        }
    }

    /**
     * Toggle chat visibility
     */
    toggleChat() {
        if (window.__devLog) window.__devLog('Toggling chat visibility:', this.isExpanded);
        if (this.isExpanded) {
            this.collapseChat();
        } else {
            this.expandChat();
        }
        
        // Sync with mobile button state
        this.updateMobileButtonState();
    }

    /**
     * Expand chat
     */
    expandChat() {
        if (window.__devLog) window.__devLog('Expanding chat');
        const widget = document.getElementById('chatgpt-widget');
        const body = document.getElementById('chatgpt-body');
        const toggle = document.getElementById('chatgpt-toggle');
        const icon = toggle.querySelector('i');

        if (widget && body && toggle) {
            body.style.display = 'flex';
            icon.className = 'fas fa-chevron-down';
            widget.classList.add('expanded');
            this.isExpanded = true;
            
            // Focus on input
            const input = document.getElementById('chatgpt-input');
            if (input) {
                setTimeout(() => input.focus(), 100);
            }
        }
        
        // Sync mobile button state
        this.updateMobileButtonState();
    }

    /**
     * Collapse chat
     */
    collapseChat() {
        if (window.__devLog) window.__devLog('Collapsing chat');
        const widget = document.getElementById('chatgpt-widget');
        const body = document.getElementById('chatgpt-body');
        const toggle = document.getElementById('chatgpt-toggle');
        const icon = toggle.querySelector('i');

        if (widget && body && toggle) {
            body.style.display = 'none';
            icon.className = 'fas fa-chevron-up';
            widget.classList.remove('expanded');
            this.isExpanded = false;
            if (this.isFullscreen) this.toggleFullscreen(false);
        }
        
        // Sync mobile button state
        this.updateMobileButtonState();
    }

    /**
     * Update mobile button state to sync with widget state
     */
    updateMobileButtonState() {
        const mobileWallEBtn = document.getElementById('mobile-wall-e-btn');
        if (mobileWallEBtn) {
            if (this.isExpanded) {
                mobileWallEBtn.classList.add('active');
            } else {
                mobileWallEBtn.classList.remove('active');
            }
        }
    }

    toggleFullscreen(force) {
        const widget = document.getElementById('chatgpt-widget');
        const body = document.getElementById('chatgpt-body');
        const btn = document.getElementById('chatgpt-fullscreen');
        const icon = btn ? btn.querySelector('i') : null;
        if (!widget || !body) return;
        if (!this.isExpanded) this.expandChat();
        const next = typeof force === 'boolean' ? force : !this.isFullscreen;
        this.isFullscreen = !!next;
        widget.classList.toggle('fullscreen', this.isFullscreen);
        if (btn) btn.title = this.isFullscreen ? 'Exit fullscreen' : 'Fullscreen';
        if (icon) icon.className = this.isFullscreen ? 'fas fa-compress' : 'fas fa-expand';
        if (this.isFullscreen) {
            document.body.classList.add('chatgpt-fullscreen-open');
        } else {
            document.body.classList.remove('chatgpt-fullscreen-open');
        }
        const input = document.getElementById('chatgpt-input');
        if (input) setTimeout(() => input.focus(), 50);
    }

    /**
     * Send message to WALL-E
     */
    async sendMessage() {
        if (window.__devLog) window.__devLog('=== SEND MESSAGE STARTED ===');
        
        // Require either proxy or direct API key
        if (!this.proxyUrl && !this.apiKey) {
            this.showError('WALL-E is not configured. Please check the Gist setup.');
            return;
        }

        const input = document.getElementById('chatgpt-input');
        const message = input.value.trim();

        if (window.__devLog) window.__devLog('Message from input: [redacted]');
        if (window.__devLog) window.__devLog('File uploads:', this.fileUploads);
        if (window.__devLog) window.__devLog('File uploads length:', this.fileUploads.length);

        if (!message && this.fileUploads.length === 0) {
            if (window.__devLog) window.__devLog('No message and no files, returning');
            return;
        }

        // Create a new thread if one doesn't exist
        if (!this.threadId) {
            try {
                await this.createNewThread();
            } catch (error) {
                console.error('Failed to create new thread:', error);
                this.addMessage('error', `Failed to create new chat: ${error.message}`);
                return;
            }
        }

        // Check if this is an image generation request
        const isImageRequest = this.isImageGenerationRequest(message);
        if (window.__devLog) window.__devLog('Is image generation request:', isImageRequest);

        // Add user message to chat
        this.addMessage('user', message, this.fileUploads);

        // Store file uploads before clearing
        const filesToSend = [...this.fileUploads];
        if (window.__devLog) window.__devLog('Files to send:', filesToSend);

        // Clear input and file uploads
        input.value = '';
        this.fileUploads = [];
        this.updateFileUploadDisplay();

        // Show typing indicator
        this.addTypingIndicator();

        try {
            if (isImageRequest) {
                if (window.__devLog) window.__devLog('Handling image generation request');
                // Handle image generation directly
                await this.handleImageGenerationRequest(message);
            } else {
                if (window.__devLog) window.__devLog('Handling normal chat message with files count:', filesToSend.length);
                // Normal chat message
                const response = await this.callWALLE(message, filesToSend);
                this.removeTypingIndicator();
                let safeResponse = String(response || '').trim() || 'I could not generate visible output for this request. Please retry, or ask me to return a concise text summary.';
                const localReportMarker = await this.maybeGenerateLocalPdfReportMarker(message, safeResponse);
                if (localReportMarker) safeResponse += `\n\n${localReportMarker}`;
                this.addMessage('assistant', safeResponse);
            }
        } catch (error) {
            console.error('Error in sendMessage:', error);
            this.removeTypingIndicator();
            this.addMessage('error', `Error: ${error.message}`);
        }
    }

    /**
     * Check if message is an image generation request
     */
    isImageGenerationRequest(message) {
        const imageKeywords = [
            'generate an image', 'create an image', 'make an image', 'generate a picture', 
            'create a picture', 'make a picture', 'generate image', 'create image', 
            'make image', 'generate picture', 'create picture', 'make picture',
            'draw', 'paint', 'visualize', 'show me', 'picture of', 'image of'
        ];
        
        const lowerMessage = message.toLowerCase();
        return imageKeywords.some(keyword => lowerMessage.includes(keyword));
    }

    isAddressAnalysisRequest(message) {
        const text = String(message || '').toLowerCase();
        if (!text) return false;
        const hasAnalysisIntent = /(zoning|analysis|report|far|floor area|setback|lot|bbl|borough block lot)/i.test(text);
        const hasAddressLike = /\b\d{1,6}\s+[a-z0-9.'\- ]+\s+(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|place|pl|drive|dr|court|ct|terrace|ter|way)\b/i.test(text)
            || /\b(borough|block|lot)\b/i.test(text);
        if (hasAnalysisIntent && hasAddressLike) return true;
        // Allow one-line address replies after WALL-E asks for parcel clarification.
        if (hasAddressLike && this.wasAwaitingAddressClarification()) return true;
        return false;
    }

    wasAwaitingAddressClarification() {
        const history = this.getRecentConversationWindow(4);
        if (!Array.isArray(history) || !history.length) return false;
        for (let i = history.length - 1; i >= 0; i -= 1) {
            const msg = history[i];
            if (msg?.role !== 'assistant') continue;
            const body = String(msg?.content || '').toLowerCase();
            return body.includes('quick clarification') &&
                (body.includes('lock the parcel confidently') || body.includes('reply with one line'));
        }
        return false;
    }

    looksLikeClarificationInsteadOfReport(text) {
        const s = String(text || '').toLowerCase();
        if (!s) return false;
        const cues = [
            'quick confirmation',
            'quick clarification',
            'quick clarification first',
            'one short piece of clarification',
            'clarification first',
            'please confirm',
            'do you mean',
            'which do you want',
            'if you want me to proceed',
            'confirm borough',
            'can you confirm',
            'verification rules',
            'provide the bbl',
            'or confirm that you mean',
            'do you want a full development potential analysis',
            'or just the base zoning designation'
        ];
        return cues.some((c) => s.includes(c));
    }

    scoreAddressReportCompleteness(text) {
        const s = String(text || '').toLowerCase();
        if (!s.trim()) return { score: 0, isComplete: false };
        const checks = [
            /(zoning district|zoning designation|district[s]?|overlay[s]?)/i.test(s),
            /(far|floor area ratio)/i.test(s) && /(buildable|zoning floor area|floor area)/i.test(s),
            /(air rights|air-rights|development rights|transfer of development rights|tdr)/i.test(s),
            (/(max possible|regular deduction|low energy|envelope)/i.test(s) && /\|/.test(s)) || /(capacity breakdown|comparison table)/i.test(s),
            /(reference|sources?)/i.test(s) && /https?:\/\//i.test(s)
        ];
        const score = checks.filter(Boolean).length;
        return { score, isComplete: score >= 4 };
    }

    needsAddressReportRegeneration(text) {
        const body = String(text || '').trim();
        if (!body) return true;
        if (this.looksLikeClarificationInsteadOfReport(body)) return true;
        if (/could not generate visible output/i.test(body)) return true;
        const schema = this.validateAddressReportSchema(body);
        if (!schema.valid) return true;
        const assumedCount = (body.match(/\bassum(ed|ption|ptions)\b/gi) || []).length;
        const linkCount = (body.match(/https?:\/\//gi) || []).length;
        if (assumedCount >= 4 && linkCount < 3) return true;
        const q = this.scoreAddressReportCompleteness(body);
        return !q.isComplete;
    }

    buildAutonomousAddressDirective(message) {
        const autofill = this.inferAddressAutofillHint(message);
        return `${String(message || '')}

Autonomous mode requirements:
- ${autofill}
- Produce full development-potential analysis now.
- Do NOT ask clarifying questions.
- Include zoning district/overlays, FAR buildable area math, bulk controls, max-possible capacity breakdown, regular deductions, 5% low-energy bonus case, air-rights availability and purchase-impact math, visual summary bars, and references.
- If a value cannot be verified online in this pass, proceed with explicit assumption and confidence note.`;
    }

    normalizeReportTextForPdf(text) {
        const raw = String(text || '');
        return raw
            .replace(/\r\n/g, '\n')
            .replace(/^#{1,6}\s*/gm, '')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/```(?:text|markdown)?\s*/gi, '')
            .replace(/```/g, '')
            .replace(/`([^`\n]+)`/g, '$1')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    summarizeModelNarrative(text) {
        const rows = String(text || '')
            .split('\n')
            .map((r) => r.trim())
            .filter((r) => r && !r.startsWith('|') && !/^[-:|]{3,}$/.test(r) && !/^[`]+/.test(r));
        const picked = [];
        for (const row of rows) {
            if (/^(#{1,6}\s*)?(site identity|references?|source snapshot|model narrative)$/i.test(row)) continue;
            picked.push(row.replace(/^[-*]\s*/, ''));
            if (picked.length >= 8) break;
        }
        return picked.join('\n') || 'Narrative condensed to deterministic report sections.';
    }

    parseNumericToken(value) {
        const n = Number(String(value || '').replace(/,/g, '').trim());
        return Number.isFinite(n) ? n : null;
    }

    extractPdfMetrics(reportText) {
        const text = String(reportText || '');
        const pick = (rx) => {
            const m = text.match(rx);
            return this.parseNumericToken(m?.[1]);
        };
        return {
            maxCap: pick(/\|\s*Max possible cap by envelope\/FAR \(net\)\s*\|\s*([0-9,.\-]+)/i)
                ?? pick(/\|\s*Max possible by envelope\/FAR\s*\|\s*([0-9,.\-]+)/i),
            gross: pick(/\|\s*Gross before regular deductions\s*\|\s*([0-9,.\-]+)/i),
            net: pick(/\|\s*Net after regular deductions \(= cap\)\s*\|\s*([0-9,.\-]+)/i)
                ?? pick(/\|\s*Net after regular deductions\s*\|\s*([0-9,.\-]+)/i),
            bonusMax: pick(/\|\s*Max with low-energy bonus\s*\|\s*([0-9,.\-]+)/i),
            lotFootprint: pick(/Lot Footprint Cap:\s*([0-9,.\-]+)/i)
        };
    }

    extractPdfDrawingData(zoningCtx, reportText = '') {
        const site = zoningCtx?.site || {};
        const calc = zoningCtx?.deterministicAnalysis || {};
        const env = calc?.envelope || {};
        const metrics = this.extractPdfMetrics(reportText);
        const asNum = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const asPositive = (v) => {
            const n = Number(v);
            return (Number.isFinite(n) && n > 0) ? n : null;
        };
        const zrRefs = Array.isArray(site?.zrReferences) ? site.zrReferences : [];
        return {
            address: String(zoningCtx?.query?.address || site?.address || 'n/a'),
            borough: String(site?.borough || 'n/a'),
            block: String(site?.block || 'n/a'),
            lot: String(site?.lot || 'n/a'),
            bbl: String(site?.bbl || 'n/a'),
            zoning: Array.isArray(site?.zoningDistricts) && site.zoningDistricts.length ? site.zoningDistricts.join(', ') : 'UNVERIFIED',
            overlays: Array.isArray(site?.overlays) && site.overlays.length ? site.overlays.join(', ') : 'none',
            frontageFt: asNum(site?.lotFrontageFt),
            depthFt: asNum(site?.lotDepthFt),
            lotAreaSf: asNum(site?.lotAreaSqft),
            maxHeightFt: asPositive(env?.maxHeightFt),
            rearYardLabel: String((env?.setbacks?.[1]?.value) || 'UNVERIFIED'),
            rearYardDepthFt: asNum(env?.rearYardDepthFt),
            footprintSf: asNum(env?.maxFootprintSqft) ?? metrics.lotFootprint,
            buildableFootprintSf: asNum(env?.buildableFootprintSqft),
            baseHeightFt: asPositive(env?.baseHeightFt),
            upperStorySetbackReductionPct: asNum(env?.upperStorySetbackReductionPct),
            baseStoriesEstimate: asNum(env?.baseStoriesEstimate),
            towerStoriesEstimate: asNum(env?.towerStoriesEstimate),
            towerFootprintSf: asNum(env?.towerFootprintSqft),
            maxNetSf: asNum(calc?.results?.maxNetByEnvelopeOrFarSqft) ?? metrics.maxCap,
            grossSf: asNum(calc?.results?.grossBeforeRegularDeductionsSqft) ?? metrics.gross,
            bonusSf: asNum(calc?.results?.maxWithLowEnergyBonusSqft) ?? metrics.bonusMax,
            useGroup: String(calc?.useGroup || 'UNVERIFIED'),
            requiredStreetTreesCount: asNum(calc?.results?.requiredStreetTreesCount),
            maxHeightSource: String(env?.maxHeightSource || 'UNVERIFIED'),
            zrRefsShort: zrRefs.slice(0, 3).map((r) => String(r?.url || '')).filter(Boolean)
        };
    }

    drawPdfTitleBlock(doc, x, y, w, h, data) {
        doc.setDrawColor(60, 70, 90);
        doc.setFillColor(248, 250, 254);
        doc.rect(x, y, w, h, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Filing-Sheet Title Block', x + 10, y + 16);
        const rows = [
            ['Project', 'NYC Zoning Analysis'],
            ['Address', data.address],
            ['Borough / Block / Lot', `${data.borough} / ${data.block} / ${data.lot}`],
            ['BBL', data.bbl],
            ['District / Overlays', `${data.zoning} / ${data.overlays}`],
            ['Use Group (Permitted)', data.useGroup || 'UNVERIFIED'],
            ['Lot (frontage x depth)', `${data.frontageFt ?? 'UNVERIFIED'} ft x ${data.depthFt ?? 'UNVERIFIED'} ft`],
            ['Lot Area', `${data.lotAreaSf ?? 'UNVERIFIED'} sf`],
            ['Rear Yard Setback', data.rearYardDepthFt != null ? `${data.rearYardDepthFt} ft` : String(data.rearYardLabel || 'UNVERIFIED')],
            ['Base Height Before Setback', data.baseHeightFt != null ? `${data.baseHeightFt} ft` : 'UNVERIFIED'],
            ['Upper-Story Setback Rule', data.upperStorySetbackReductionPct != null ? `${data.upperStorySetbackReductionPct}% footprint reduction above base height` : 'UNVERIFIED'],
            ['Street Trees Required', data.requiredStreetTreesCount != null ? `${data.requiredStreetTreesCount}` : 'UNVERIFIED'],
            ['Height Limit', data.maxHeightFt != null ? `${data.maxHeightFt} ft` : 'UNVERIFIED'],
            ['Height Source', data.maxHeightSource || 'UNVERIFIED'],
            ['ZR References', data.zrRefsShort.length ? data.zrRefsShort.join(' | ') : 'UNVERIFIED']
        ];
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.2);
        let ry = y + 30;
        rows.forEach(([k, v]) => {
            doc.setFont('helvetica', 'bold');
            doc.text(`${k}:`, x + 10, ry);
            doc.setFont('helvetica', 'normal');
            doc.text(String(v || 'n/a'), x + 150, ry);
            ry += 13;
        });
    }

    drawScaledPlanSectionIso(doc, x, y, w, h, data) {
        const gap = 10;
        const eachW = Math.floor((w - (gap * 2)) / 3);
        const eachH = h;
        const planX = x;
        const secX = x + eachW + gap;
        const isoX = x + (eachW + gap) * 2;

        const box = (bx, title) => {
            doc.setDrawColor(90, 100, 120);
            doc.setFillColor(252, 253, 255);
            doc.rect(bx, y, eachW, eachH, 'FD');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.text(title, bx + 8, y + 14);
        };
        box(planX, 'Plan View (scaled)');
        box(secX, 'Section View (scaled)');
        box(isoX, 'Isometric Massing');

        const frontage = Math.max(20, Number(data.frontageFt || 50));
        const depth = Math.max(20, Number(data.depthFt || 100));
        const lotScale = Math.min((eachW - 30) / frontage, (eachH - 52) / depth);
        const lotW = frontage * lotScale;
        const lotH = depth * lotScale;
        const lotX = planX + 12;
        const lotY = y + 24;
        doc.setDrawColor(30, 30, 30);
        doc.rect(lotX, lotY, lotW, lotH);
        const rearYardDepthFt = Number(data.rearYardDepthFt || 0);
        const rearInsetByDepth = (Number(data.depthFt || 0) > 0 && rearYardDepthFt > 0)
            ? Math.max(4, (rearYardDepthFt / Number(data.depthFt)) * lotH)
            : Math.max(5, Math.min(lotW, lotH) * 0.08);
        const sideInset = Math.max(3, Math.min(lotW, lotH) * 0.04);
        if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([3, 2], 0);
        doc.rect(
            lotX + sideInset,
            lotY + sideInset,
            Math.max(12, lotW - (sideInset * 2)),
            Math.max(12, lotH - sideInset - rearInsetByDepth)
        );
        if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([], 0);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.3);
        doc.text(`Frontage: ${data.frontageFt ?? 'UNVERIFIED'} ft`, lotX, lotY + lotH + 12);
        doc.text(`Depth: ${data.depthFt ?? 'UNVERIFIED'} ft`, lotX + 120, lotY + lotH + 12);
        doc.text(`Rear yard: ${data.rearYardDepthFt ?? data.rearYardLabel}`, lotX, lotY + lotH + 24);

        const secBaseY = y + eachH - 26;
        const secBaseX = secX + 18;
        const secW = eachW - 36;
        const maxH = Math.max(40, eachH - 62);
        const hFt = Math.max(10, Number(data.maxHeightFt || 80));
        const hScale = maxH / hFt;
        const drawH = Math.max(20, hFt * hScale);
        const baseHeightFt = Number(data.baseHeightFt || 0);
        const baseRatio = (baseHeightFt > 0 && hFt > 0) ? Math.max(0.05, Math.min(0.95, baseHeightFt / hFt)) : 0.65;
        const setbackPlaneY = secBaseY - (drawH * baseRatio);
        doc.setDrawColor(55, 55, 55);
        doc.line(secBaseX, secBaseY, secBaseX + secW, secBaseY);
        doc.rect(secBaseX + 24, secBaseY - drawH, secW - 70, drawH);
        if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([3, 2], 0);
        doc.line(secBaseX + 8, setbackPlaneY, secBaseX + secW - 8, setbackPlaneY);
        if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([], 0);
        doc.setFontSize(8.3);
        doc.text(`Height: ${data.maxHeightFt ?? 'UNVERIFIED'} ft`, secBaseX + 4, secBaseY - drawH - 6);
        doc.text(`Setback starts at base height: ${data.baseHeightFt ?? 'UNVERIFIED'} ft`, secBaseX + 120, secBaseY - drawH - 6);

        const ix = isoX + 28;
        const iy = y + eachH - 34;
        const iw = eachW - 80;
        const ih = Math.max(34, eachH - 84);
        doc.setDrawColor(40, 40, 40);
        doc.line(ix, iy, ix + iw, iy - 18);
        doc.line(ix + iw, iy - 18, ix + iw, iy - ih - 18);
        doc.line(ix, iy, ix, iy - ih);
        doc.line(ix, iy - ih, ix + iw, iy - ih - 18);
        doc.line(ix + iw, iy - ih - 18, ix + iw, iy - 18);
        doc.line(ix, iy - ih, ix + iw, iy - ih - 18);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.3);
        doc.text(`Net Cap: ${data.maxNetSf ?? 'UNVERIFIED'} sf`, isoX + 10, y + eachH - 8);
    }

    renderPdfCapacityChart(doc, metrics, x, y, w, h) {
        const vals = [
            { key: 'maxCap', label: 'Net Cap', color: [46, 134, 222] },
            { key: 'gross', label: 'Gross Before Deductions', color: [243, 156, 18] },
            { key: 'net', label: 'Net After Deductions', color: [39, 174, 96] },
            { key: 'bonusMax', label: 'Max With 5% Bonus', color: [142, 68, 173] }
        ].map((r) => ({ ...r, value: metrics?.[r.key] }));
        const available = vals.filter((v) => Number.isFinite(v.value) && v.value > 0);
        if (!available.length) return;
        const maxValue = Math.max(...available.map((v) => v.value), 1);
        const rowH = Math.max(16, Math.floor((h - 20) / available.length));
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Capacity Graphics', x, y + 11);
        let cy = y + 22;
        available.forEach((v) => {
            const ratio = Math.max(0, Math.min(1, v.value / maxValue));
            const barW = Math.max(1, (w - 250) * ratio);
            doc.setDrawColor(220, 220, 220);
            doc.setFillColor(248, 248, 248);
            doc.rect(x + 120, cy, w - 250, rowH - 6, 'FD');
            doc.setFillColor(v.color[0], v.color[1], v.color[2]);
            doc.rect(x + 120, cy, barW, rowH - 6, 'F');
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9.5);
            doc.text(v.label, x, cy + rowH - 10);
            doc.text(`${Math.round(v.value).toLocaleString()} sf`, x + w - 120, cy + rowH - 10, { align: 'right' });
            cy += rowH;
        });
    }

    renderPdfEnvelopeSketch(doc, metrics, x, y, w, h) {
        const frameW = Math.max(170, Math.floor(w * 0.46));
        const frameH = Math.max(96, Math.floor(h * 0.62));
        const fx = x + 8;
        const fy = y + 20;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Lot Plan + Envelope Diagram', x, y + 11);
        // Lot plan (left)
        const lotW = Math.max(120, Math.floor(frameW * 0.46));
        const lotH = Math.max(80, Math.floor(frameH * 0.72));
        const lotX = fx;
        const lotY = fy + 8;
        doc.setDrawColor(30, 30, 30);
        doc.rect(lotX, lotY, lotW, lotH);
        doc.setDrawColor(90, 90, 90);
        const setX = lotX + 12;
        const setY = lotY + 10;
        const setW = Math.max(40, lotW - 24);
        const setH = Math.max(34, lotH - 20);
        doc.rect(setX, setY, setW, setH);
        if (typeof doc.setLineDashPattern === 'function') {
            doc.setLineDashPattern([3, 2], 0);
            doc.rect(setX + 7, setY + 7, Math.max(12, setW - 14), Math.max(12, setH - 14));
            doc.setLineDashPattern([], 0);
        }
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.text('LOT LINE', lotX + 4, lotY - 2);
        doc.text('MAX BUILDABLE FOOTPRINT', lotX + 16, lotY + 22);
        doc.text('DASHED: REQUIRED YARD / SETBACK LIMITS', lotX + 16, lotY + 34);
        doc.text(`Rear yard: ${metrics?.rearYardDepthFt ?? 'UNVERIFIED'} ft`, lotX + 16, lotY + 46);
        // Envelope section (right)
        const envX = lotX + lotW + 14;
        const envW = Math.max(70, frameW - lotW - 14);
        const envY = lotY;
        const baseHeightFt = Number(metrics?.baseHeightFt || 0);
        const maxHeightFt = Math.max(10, Number(metrics?.maxHeightFt || 80));
        const baseRatio = (baseHeightFt > 0 && maxHeightFt > 0) ? Math.max(0.05, Math.min(0.95, baseHeightFt / maxHeightFt)) : 0.65;
        const baseBandY = envY + lotH - (lotH * baseRatio);
        const upperReductionPct = Math.max(0, Math.min(80, Number(metrics?.upperStorySetbackReductionPct || 0)));
        const towerInset = Math.max(2, (envW * upperReductionPct) / 200);
        doc.setDrawColor(70, 70, 70);
        doc.rect(envX, envY, envW, lotH);
        doc.rect(envX + towerInset, envY, Math.max(8, envW - (towerInset * 2)), Math.max(8, baseBandY - envY));
        if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([3, 2], 0);
        doc.line(envX, baseBandY, envX + envW, baseBandY);
        if (typeof doc.setLineDashPattern === 'function') doc.setLineDashPattern([], 0);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.text('ROOF LINE', envX + 6, envY + 14);
        doc.text('TOWER MASS', envX + 6, envY + 28);
        doc.text('BASE MASS', envX + 6, baseBandY + 14);
        doc.text(`Base h: ${metrics?.baseHeightFt ?? 'UNVERIFIED'} ft`, envX + 6, baseBandY - 4);
        doc.text(`Tower setback: ${metrics?.upperStorySetbackReductionPct ?? 'UNVERIFIED'}%`, envX + 6, baseBandY + 26);
        const lotTxt = Number.isFinite(metrics?.lotFootprint) ? `${Math.round(metrics.lotFootprint).toLocaleString()} sf` : 'UNVERIFIED';
        const buildableTxt = Number.isFinite(metrics?.buildableFootprintSf) ? `${Math.round(metrics.buildableFootprintSf).toLocaleString()} sf` : 'UNVERIFIED';
        const towerTxt = Number.isFinite(metrics?.towerFootprintSf) ? `${Math.round(metrics.towerFootprintSf).toLocaleString()} sf` : 'UNVERIFIED';
        doc.text(`Lot Footprint Cap: ${lotTxt}`, fx, fy + frameH + 14);
        doc.text(`Buildable Footprint (after setbacks): ${buildableTxt}`, fx, fy + frameH + 26);
        doc.text(`Tower Footprint (above base): ${towerTxt}`, fx, fy + frameH + 38);
        doc.text('Setback Regime: dashed line marks base-height trigger', fx, fy + frameH + 50);
    }

    inferAddressAutofillHint(message) {
        const text = String(message || '').toLowerCase();
        const byName = [
            ['brooklyn', 'Brooklyn'],
            ['queens', 'Queens'],
            ['bronx', 'Bronx'],
            ['manhattan', 'Manhattan'],
            ['staten island', 'Staten Island']
        ].find(([k]) => text.includes(k));
        if (byName) return `Use borough=${byName[1]}. If BBL is unavailable, infer from ZoLa parcel lookup and continue.`;
        const zip = (text.match(/\b(10\d{3}|11\d{3})\b/) || [])[1] || '';
        if (zip.startsWith('112')) return 'Use borough=Brooklyn by default from ZIP pattern; continue without asking.';
        if (zip.startsWith('111') || zip.startsWith('113') || zip.startsWith('114') || zip.startsWith('116')) return 'Use borough=Queens by default from ZIP pattern; continue without asking.';
        if (zip.startsWith('104')) return 'Use borough=Bronx by default from ZIP pattern; continue without asking.';
        if (zip.startsWith('103')) return 'Use borough=Staten Island by default from ZIP pattern; continue without asking.';
        if (zip.startsWith('100') || zip.startsWith('101') || zip.startsWith('102')) return 'Use borough=Manhattan by default from ZIP pattern; continue without asking.';
        return 'If borough is missing, proceed with best-match NYC parcel candidate and continue without requesting confirmation.';
    }

    inferRequestedProgramType(message) {
        const explicit = this.inferExplicitProgramType(message);
        if (explicit) return explicit;
        return 'residential-new-building';
    }

    inferExplicitProgramType(message) {
        const text = String(message || '').toLowerCase();
        if (/(mixed[-\s]?use|mixed use)/i.test(text)) return 'mixed-use-new-building';
        if (/(commercial|office|retail|manufacturing|industrial)/i.test(text)) return 'commercial-new-building';
        if (/(community facility|facility|school|hospital|clinic|religious)/i.test(text)) return 'community-facility-new-building';
        if (/(residential|apartment|housing|multi[-\s]?family|single[-\s]?family)/i.test(text)) return 'residential-new-building';
        return '';
    }

    buildSimpleAddressClarification(message, zoningCtx = null) {
        if (!this.isAddressAnalysisRequest(message)) return '';
        const address = this.extractAddressCandidate(message);
        const hasBoroughHint = /\b(brooklyn|queens|manhattan|bronx|staten island)\b/i.test(String(message || ''));
        if (!zoningCtx || zoningCtx.ok !== true) {
            if (hasBoroughHint) return '';
            return `Quick clarification: I could not lock the parcel confidently yet.\nPlease reply with one line: "${address || 'address'} , borough".\nExample: "565 Union Street, Brooklyn".`;
        }
        const missingCritical = Array.isArray(zoningCtx?.flags?.missingCritical) ? zoningCtx.flags.missingCritical : [];
        if (missingCritical.some((k) => ['bbl', 'zoningDistricts', 'lotAreaSqft'].includes(String(k)))) {
            return `Quick clarification: parcel data is incomplete for this address.\nPlease confirm borough + address in one line (example: "565 Union Street, Brooklyn") and I’ll continue automatically.`;
        }
        return '';
    }

    extractAddressCandidate(message) {
        const text = String(message || '').trim();
        if (!text) return '';
        const m = text.match(/\b\d{1,6}\s+[A-Za-z0-9.'\- ]+\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Place|Pl|Drive|Dr|Court|Ct|Terrace|Ter|Way)\b(?:,\s*[A-Za-z ]+)?(?:\s+NY)?(?:\s+\d{5})?/i);
        if (m && m[0]) return m[0].replace(/\s+/g, ' ').trim();
        return text;
    }

    safeJsonForPrompt(obj, maxChars = 16000) {
        try {
            const str = JSON.stringify(obj || {}, null, 2);
            if (str.length <= maxChars) return str;
            return `${str.slice(0, maxChars)}\n... [truncated for prompt length]`;
        } catch (_) {
            return '{}';
        }
    }

    async fetchNycZoningContext(message) {
        if (!this.isAddressAnalysisRequest(message)) return null;
        const address = this.extractAddressCandidate(message);
        if (!address) return null;
        const programType = this.inferRequestedProgramType(message);
        const endpoint = this.nycResolverUrl || `${this.getFunctionsBase()}/resolveNycZoningContext`;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
        }, 25000);
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ address, programType }),
                signal: controller.signal
            });
            if (!resp.ok) {
                const txt = await resp.text();
                throw new Error(`resolver_failed_${resp.status}: ${txt || resp.statusText}`);
            }
            const data = await resp.json();
            if (!data || data.ok !== true) return null;
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    validateAddressReportSchema(text) {
        const s = String(text || '').toLowerCase();
        if (!s.trim()) return { valid: false, missing: ['empty'] };
        const required = [
            { key: 'site_identity', ok: /(property identification|site identity|bbl|borough|block|lot)/i.test(s) },
            { key: 'overlays_maps', ok: /(overlay|special district|map layer|flood|coastal)/i.test(s) },
            { key: 'site_conditions', ok: /(street tree|amenit|additional regulation|special district requirement)/i.test(s) },
            { key: 'district_scan', ok: /(district-specific rule scans|district \/ overlay|requirement scanned|zoningresolution\.planning\.nyc\.gov)/i.test(s) },
            { key: 'zr_exact_sections', ok: /(zr exact sections applied|article-|zoningresolution\.planning\.nyc\.gov\/article-)/i.test(s) },
            { key: 'metric_citations', ok: /(citations by metric|use_group|lot_area|max_zoning_floor_area|street_tree_requirement|height_setback)/i.test(s) },
            { key: 'set_ready_compliance', ok: /(permitted\/required|provided\/proposed|citation)/i.test(s) && /\|/.test(s) },
            { key: 'zoning_controls_table', ok: /(zoning controls|coefficient|far|table)/i.test(s) && /\|/.test(s) },
            { key: 'capacity_breakdown', ok: /(max possible|regular deduction|low energy|capacity breakdown)/i.test(s) && /\|/.test(s) },
            { key: 'envelope', ok: /(envelope|max footprint|setback|height)/i.test(s) },
            { key: 'air_rights', ok: /(air rights|transfer)/i.test(s) },
            { key: 'references', ok: /(references|source snapshot)/i.test(s) && /https?:\/\//i.test(s) }
        ];
        const missing = required.filter((r) => !r.ok).map((r) => r.key);
        return { valid: missing.length === 0, missing };
    }

    buildDeterministicEnvelopeDiagram(zoningCtx) {
        const env = zoningCtx?.deterministicAnalysis?.envelope || {};
        const maxHeight = (typeof env?.maxHeightFt === 'number' && env.maxHeightFt > 0) ? `${env.maxHeightFt} ft` : 'UNVERIFIED';
        const lot = zoningCtx?.site?.lotAreaSqft != null ? `${zoningCtx.site.lotAreaSqft} sf` : 'UNVERIFIED';
        const frontage = zoningCtx?.site?.lotFrontageFt != null ? `${zoningCtx.site.lotFrontageFt} ft` : 'UNVERIFIED';
        const depth = zoningCtx?.site?.lotDepthFt != null ? `${zoningCtx.site.lotDepthFt} ft` : 'UNVERIFIED';
        const rearYard = (typeof env?.rearYardDepthFt === 'number' && env.rearYardDepthFt >= 0)
            ? `${env.rearYardDepthFt} ft`
            : (env?.setbacks?.[1]?.value || 'UNVERIFIED');
        const buildable = env?.buildableFootprintSqft != null ? `${env.buildableFootprintSqft} sf` : 'UNVERIFIED';
        const baseHeight = (typeof env?.baseHeightFt === 'number' && env.baseHeightFt > 0) ? `${env.baseHeightFt} ft` : 'UNVERIFIED';
        const postBaseSetback = (typeof env?.upperStorySetbackReductionPct === 'number' && env.upperStorySetbackReductionPct >= 0) ? `${env.upperStorySetbackReductionPct}%` : 'UNVERIFIED';
        return [
            '```text',
            'Scaled Lot Plan + Envelope (deterministic)',
            '+-------------------------------------------+',
            '|<-------------- lot frontage ------------->|',
            '|  . . . . . . dashed setback zone . . . .  |',
            '|  +-------------------------------------+  |  Max Height: ' + maxHeight,
            '|  |            BUILDING MASS            |  |',
            '|  +-------------------------------------+  |',
            '|  Rear yard setback: ' + rearYard + '                      |',
            '+-------------------------------------------+',
            ' Lot footprint cap: ' + lot,
            ' Buildable footprint after setbacks: ' + buildable,
            ' Base height before setback: ' + baseHeight,
            ' Upper-story setback reduction above base: ' + postBaseSetback,
            ' Lot dimensions: frontage=' + frontage + ', depth=' + depth,
            '```'
        ].join('\n');
    }

    buildStructuredAddressReport(zoningCtx, modelNarrative = '') {
        const site = zoningCtx?.site || {};
        const calc = zoningCtx?.deterministicAnalysis || {};
        const coeffRows = Array.isArray(calc?.coefficients) ? calc.coefficients : [];
        const results = calc?.results || {};
        const layers = Array.isArray(site?.mapLayers) ? site.mapLayers : [];
        const uses = site?.uses || {};
        const siteConditions = site?.siteConditions || {};
        const streetTrees = siteConditions?.streetTrees || {};
        const amenities = siteConditions?.amenities || {};
        const amenityCounts = amenities?.counts || {};
        const topAmenities = Object.entries(amenityCounts)
            .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
            .slice(0, 10);
        const additionalRegs = Array.isArray(zoningCtx?.additionalRegulations) ? zoningCtx.additionalRegulations : [];
        const specialReqs = Array.isArray(site?.specialDistrictRequirements) ? site.specialDistrictRequirements : [];
        const districtReqs = Array.isArray(site?.districtSpecificRequirements) ? site.districtSpecificRequirements : [];
        const zrRefs = Array.isArray(site?.zrReferences) ? site.zrReferences : [];
        const zrSections = Array.isArray(site?.zrSections) ? site.zrSections : [];
        const ruleSignals = site?.ruleSignals || {};
        const scanPlan = Array.isArray(zoningCtx?.scanPlan) ? zoningCtx.scanPlan : [];
        const metricCitations = zoningCtx?.citationsByMetric || {};
        const refs = Array.isArray(zoningCtx?.sourceSnapshot) ? zoningCtx.sourceSnapshot : [];
        const legal = Array.isArray(zoningCtx?.legalUpdates?.entries) ? zoningCtx.legalUpdates.entries : [];
        const candidates = Array.isArray(zoningCtx?.airRights?.candidates) ? zoningCtx.airRights.candidates.slice(0, 8) : [];
        const unitsTotal = Number(uses?.unitsTotal);
        const amenityBaselineSqft = Number.isFinite(unitsTotal) && unitsTotal > 0 ? (unitsTotal * 40) : null;

        const coeffTable = [
            '| Coefficient | Value | Citation |',
            '|---|---:|---|',
            ...coeffRows.map((r) => `| ${String(r?.key || '')} | ${r?.value == null ? 'UNVERIFIED' : r.value} | ${String(r?.citation || '')} |`)
        ].join('\n');

        const metricCitationTable = [
            '| Metric key | Citation label | URL | Status |',
            '|---|---|---|---|',
            ...Object.entries(metricCitations).map(([k, v]) =>
                `| ${String(k)} | ${String(v?.citationLabel || '')} | ${String(v?.citationUrl || '')} | ${String(v?.status || '')} |`)
        ].join('\n');

        const capacityTable = [
            '| Metric | Value (sq ft) | Notes |',
            '|---|---:|---|',
            `| FAR net capacity (before envelope min-control) | ${results?.farNetCapacitySqft == null ? 'UNVERIFIED' : results.farNetCapacitySqft} | lotArea x FAR |`,
            `| Envelope net capacity (after setbacks/coverage/height) | ${results?.envelopeNetCapacitySqft == null ? 'UNVERIFIED' : results.envelopeNetCapacitySqft} | Deterministic geometry/envelope cap |`,
            `| Max possible cap by envelope/FAR (net) | ${results?.maxNetByEnvelopeOrFarSqft == null ? 'UNVERIFIED' : results.maxNetByEnvelopeOrFarSqft} | Target net cap from zoning/FAR envelope |`,
            `| Gross before regular deductions | ${results?.grossBeforeRegularDeductionsSqft == null ? 'UNVERIFIED' : results.grossBeforeRegularDeductionsSqft} | Gross area needed so deductions resolve to cap |`,
            `| Regular deductions (${results?.regularDeductionsPct ?? 'UNVERIFIED'}% of gross) | ${results?.regularDeductionsSqft == null ? 'UNVERIFIED' : results.regularDeductionsSqft} | Difference between gross and net cap |`,
            `| Net after regular deductions (= cap) | ${results?.netAfterRegularDeductionsSqft == null ? 'UNVERIFIED' : results.netAfterRegularDeductionsSqft} | Should equal max possible cap by definition |`,
            `| Low-energy bonus (+${results?.lowEnergyBonusPct ?? 5}%) | ${results?.lowEnergyBonusSqft == null ? 'UNVERIFIED' : results.lowEnergyBonusSqft} | Bonus shown separately |`,
            `| Max with low-energy bonus | ${results?.maxWithLowEnergyBonusSqft == null ? 'UNVERIFIED' : results.maxWithLowEnergyBonusSqft} | Envelope/FAR plus energy bonus case |`
        ].join('\n');

        const airRightsSummaryTable = [
            '| Air-rights metric | Value (sq ft) | Notes |',
            '|---|---:|---|',
            `| On-site area available by envelope to max out | ${results?.airRightsNeededToMaxEnvelopeSqft == null ? 'UNVERIFIED' : results.airRightsNeededToMaxEnvelopeSqft} | Capped by min(FAR net cap, envelope net capacity) minus existing built area |`,
            `| Neighboring sites transferable total (sellable) | ${results?.neighboringTransferableSqftTotal == null ? 'UNVERIFIED' : results.neighboringTransferableSqftTotal} | Sum of screened nearby transfer candidates |`,
            `| Merged zoning-lot max floor area with top donor | ${results?.mergedZoningLotMaxFloorAreaWithBestDonorSqft == null ? 'UNVERIFIED' : results.mergedZoningLotMaxFloorAreaWithBestDonorSqft} | Combined max floor area estimate (subject + top donor) |`,
            `| Subject-side potential with top donor merged | ${results?.subjectPotentialWithBestDonorSqft == null ? 'UNVERIFIED' : results.subjectPotentialWithBestDonorSqft} | Donor keeps as-built area; unused rights shift to merged zoning lot plan |`
        ].join('\n');

        const mapTable = [
            '| Map Layer | Values | Source |',
            '|---|---|---|',
            ...layers.map((l) => `| ${String(l?.label || l?.id || '')} | ${(Array.isArray(l?.values) && l.values.length) ? l.values.join(', ') : 'none listed'} | ${String(l?.source || '')} |`)
        ].join('\n');

        const filingProjectInfo = [
            '| Item | Value |',
            '|---|---|',
            `| Address | ${String(zoningCtx?.query?.address || site?.address || 'n/a')} |`,
            `| Borough | ${String(site?.borough || 'n/a')} |`,
            `| Block | ${String(site?.block || 'n/a')} |`,
            `| Lot | ${String(site?.lot || 'n/a')} |`,
            `| BBL | ${String(site?.bbl || 'n/a')} |`,
            `| Zoning district(s) | ${(Array.isArray(site?.zoningDistricts) && site.zoningDistricts.length) ? site.zoningDistricts.join(', ') : 'UNVERIFIED'} |`,
            `| Overlay(s) | ${(Array.isArray(site?.overlays) && site.overlays.length) ? site.overlays.join(', ') : 'none listed'} |`,
            `| Special district(s) | ${(Array.isArray(site?.specialDistricts) && site.specialDistricts.length) ? site.specialDistricts.join(', ') : 'none listed'} |`,
            `| Program | ${String(calc?.programType || zoningCtx?.query?.requestedProgramType || 'residential-new-building')} |`
        ].join('\n');

        const zoningComplianceTable = [
            '| Item | Permitted / Required | Provided / Proposed | Remarks | Citation |',
            '|---|---|---|---|---|',
            `| Use group / occupancy | ${String(calc?.useGroup || 'UNVERIFIED')} | ${String(calc?.programType || zoningCtx?.query?.requestedProgramType || 'residential-new-building')} | Derived from adaptive rule profile + ZR scan sources | ${String(metricCitations?.use_group?.citationUrl || zrRefs.find((r) => /use group/i.test(String(r?.label || '')))?.url || 'https://zoningresolution.planning.nyc.gov/article-ii')} |`,
            `| Lot area | ${site?.lotAreaSqft == null ? 'UNVERIFIED' : `${site.lotAreaSqft} sf (base)`} | ${site?.lotAreaSqft == null ? 'UNVERIFIED' : `${site.lotAreaSqft} sf`} | Baseline from parcel snapshot | NYC MapPLUTO lotarea |`,
            `| Max zoning floor area | ${results?.maxNetByEnvelopeOrFarSqft == null ? 'UNVERIFIED' : `${results.maxNetByEnvelopeOrFarSqft} sf (net cap)`} | ${results?.maxNetByEnvelopeOrFarSqft == null ? 'UNVERIFIED' : `${results.maxNetByEnvelopeOrFarSqft} sf`} | Controlled by FAR cap and envelope constraints | ${String(metricCitations?.max_zoning_floor_area?.citationUrl || 'MapPLUTO/ZR')} |`,
            `| Street tree requirement | ${results?.requiredStreetTreesCount == null ? 'UNVERIFIED' : `${results.requiredStreetTreesCount} tree(s) required`} | frontage=${results?.lotFrontageFt == null ? 'UNVERIFIED' : `${results.lotFrontageFt} ft`} | Formula: ${String(calc?.formulas?.streetTreesRequired || 'UNVERIFIED')} | ${String(metricCitations?.street_tree_requirement?.citationUrl || zrRefs.find((r) => /street tree/i.test(String(r?.label || '')))?.url || 'https://zoningresolution.planning.nyc.gov/search?search=street%20tree')} |`,
            `| Height / setback | District-specific limits required | ${(typeof calc?.envelope?.maxHeightFt === 'number' && calc.envelope.maxHeightFt > 0) ? `${calc.envelope.maxHeightFt} ft (${String(calc?.envelope?.maxHeightSource || 'resolved')})` : 'UNVERIFIED'} | Base height=${calc?.envelope?.baseHeightFt == null ? 'UNVERIFIED' : `${calc.envelope.baseHeightFt} ft`}; post-base setback=${calc?.envelope?.upperStorySetbackReductionPct == null ? 'UNVERIFIED' : `${calc.envelope.upperStorySetbackReductionPct}% reduction`} | ${String(metricCitations?.height_setback?.citationUrl || zrRefs.find((r) => /district search/i.test(String(r?.label || '')))?.url || 'https://zoningresolution.planning.nyc.gov/')} |`
        ].join('\n');

        const appliedControlsTable = [
            '| Order | Applied control | Basis | Value used | Governing source |',
            '|---:|---|---|---|---|',
            `| 1 | Parcel identity lock | BBL + district + geometry | BBL ${String(site?.bbl || 'UNVERIFIED')} | NYC MapPLUTO + geocode match |`,
            `| 2 | Use group permitted | Program -> adaptive profile | ${String(calc?.useGroup || 'UNVERIFIED')} | ${String(metricCitations?.use_group?.citationUrl || 'https://zoningresolution.planning.nyc.gov/article-ii')} |`,
            `| 3 | Height baseline | ltdheight or district baseline | ${(typeof calc?.envelope?.maxHeightFt === 'number' && calc.envelope.maxHeightFt > 0) ? `${calc.envelope.maxHeightFt} ft` : 'UNVERIFIED'} | ${String(metricCitations?.height_setback?.citationUrl || 'https://zoningresolution.planning.nyc.gov/')} |`,
            `| 4 | Setback / rear yard | adaptive profile district rule | ${calc?.envelope?.rearYardDepthFt == null ? 'UNVERIFIED' : `${calc.envelope.rearYardDepthFt} ft`} | ${(zrSections.find((z) => /rear\s*yard/i.test(String(z?.topic || '')))?.url) || String(metricCitations?.height_setback?.citationUrl || '') || 'UNVERIFIED'} |`,
            `| 5 | Post-base-height setback | tower reduction above base height | base=${calc?.envelope?.baseHeightFt == null ? 'UNVERIFIED' : `${calc.envelope.baseHeightFt} ft`}; reduction=${calc?.envelope?.upperStorySetbackReductionPct == null ? 'UNVERIFIED' : `${calc.envelope.upperStorySetbackReductionPct}%`} | ${(zrSections.find((z) => /height factor|height|district/i.test(String(z?.topic || '')))?.url) || String(metricCitations?.height_setback?.citationUrl || '') || 'UNVERIFIED'} |`,
            `| 6 | Envelope buildable footprint | geometry(frontage*depth-setback) ∩ lot coverage | ${calc?.envelope?.buildableFootprintSqft == null ? 'UNVERIFIED' : `${calc.envelope.buildableFootprintSqft} sf`} | Deterministic envelope engine |`,
            `| 7 | Net capacity cap | min(FAR net cap, envelope net cap) | ${results?.maxNetByEnvelopeOrFarSqft == null ? 'UNVERIFIED' : `${results.maxNetByEnvelopeOrFarSqft} sf`} | MapPLUTO FAR + envelope controls |`
        ].join('\n');

        const floorAreaInputTable = [
            '| Floor Area Input | Area (sf) | Notes |',
            '|---|---:|---|',
            `| Existing built area | ${site?.existingBuiltSqft == null ? 'UNVERIFIED' : site.existingBuiltSqft} | Parcel baseline |`,
            `| FAR net cap | ${results?.farNetCapacitySqft == null ? 'UNVERIFIED' : results.farNetCapacitySqft} | lotArea x FAR |`,
            `| Envelope net cap | ${results?.envelopeNetCapacitySqft == null ? 'UNVERIFIED' : results.envelopeNetCapacitySqft} | Rear yard, lot coverage, stories by height |`,
            `| Base height before setback | ${calc?.envelope?.baseHeightFt == null ? 'UNVERIFIED' : `${calc.envelope.baseHeightFt} ft`} | Street-wall/base envelope height |`,
            `| Upper-story setback reduction | ${calc?.envelope?.upperStorySetbackReductionPct == null ? 'UNVERIFIED' : `${calc.envelope.upperStorySetbackReductionPct}%`} | Applies above base height to tower footprint |`,
            `| Max zoning floor area cap (net) | ${results?.maxNetByEnvelopeOrFarSqft == null ? 'UNVERIFIED' : results.maxNetByEnvelopeOrFarSqft} | Net cap target after envelope/FAR min-control |`,
            `| Gross before deductions | ${results?.grossBeforeRegularDeductionsSqft == null ? 'UNVERIFIED' : results.grossBeforeRegularDeductionsSqft} | Gross envelope before regular deductions |`,
            `| Deductions (${results?.regularDeductionsPct ?? 'UNVERIFIED'}% of gross) | ${results?.regularDeductionsSqft == null ? 'UNVERIFIED' : results.regularDeductionsSqft} | Gross-minus-cap difference |`,
            `| Low-energy bonus (+${results?.lowEnergyBonusPct ?? 5}%) | ${results?.lowEnergyBonusSqft == null ? 'UNVERIFIED' : results.lowEnergyBonusSqft} | Separate bonus track |`,
            `| Max with low-energy bonus | ${results?.maxWithLowEnergyBonusSqft == null ? 'UNVERIFIED' : results.maxWithLowEnergyBonusSqft} | Bonus-inclusive ceiling |`
        ].join('\n');

        const usesTable = [
            '| Use signal | Value |',
            '|---|---|',
            `| Mapped use group | ${String(calc?.useGroup || 'UNVERIFIED')} |`,
            `| Land use code | ${String(uses?.landUseCode || 'n/a')} |`,
            `| Building class | ${String(uses?.buildingClass || 'n/a')} |`,
            `| Residential units | ${uses?.unitsResidential == null ? 'n/a' : uses.unitsResidential} |`,
            `| Total units | ${uses?.unitsTotal == null ? 'n/a' : uses.unitsTotal} |`
        ].join('\n');

        const siteConditionsTable = [
            '| Site condition | Value | Notes |',
            '|---|---|---|',
            `| Street trees nearby | ${String(streetTrees?.status || '').startsWith('ok') ? String(streetTrees?.nearbyCount ?? 0) : 'UNVERIFIED'} | Radius ${streetTrees?.radiusMeters || 'n/a'}m; source: NYC Street Tree Census (${streetTrees?.status || 'unknown'}) |`,
            `| Amenity categories nearby | ${String(amenities?.status || '').startsWith('ok') ? String(topAmenities.length) : 'UNVERIFIED'} | Radius ${amenities?.radiusMeters || 'n/a'}m; source: OSM Overpass snapshot (${amenities?.status || 'unknown'}) |`
        ].join('\n');

        const amenitiesTable = [
            '| Amenity type | Count |',
            '|---|---:|',
            ...(topAmenities.length ? topAmenities.map(([k, v]) => `| ${String(k)} | ${Number(v || 0)} |`) : ['| none captured | 0 |'])
        ].join('\n');

        const amenitySpaceTable = [
            '| Amenity space item | Value | Basis |',
            '|---|---:|---|',
            `| Residential units (baseline) | ${Number.isFinite(unitsTotal) ? unitsTotal : 'UNVERIFIED'} | MapPLUTO unitstotal snapshot |`,
            `| Required amenity/recreation baseline area | ${amenityBaselineSqft == null ? 'UNVERIFIED' : amenityBaselineSqft} | Planning baseline = 40 sf/unit (confirm district program and ZR article) |`
        ].join('\n');

        const specialDistrictReqsTable = [
            '| Special district | Requirement |',
            '|---|---|',
            ...(specialReqs.length ? specialReqs.map((r) => `| ${String(r?.district || '')} | ${String(r?.requirement || '')} |`) : ['| none listed | No mapped special district requirement in current snapshot |'])
        ].join('\n');

        const districtSpecificReqTable = [
            '| District / Overlay | Requirement scanned | Source | Status |',
            '|---|---|---|---|',
            ...(districtReqs.length
                ? districtReqs.map((r) => `| ${String(r?.district || '')} | ${String(r?.requirement || '')} | ${String(r?.source || '')} | ${String(r?.status || 'unknown')} |`)
                : ['| n/a | No district-specific scans available | n/a | unavailable |'])
        ].join('\n');

        const zrReferenceTable = [
            '| Topic | Reference |',
            '|---|---|',
            ...(zrRefs.length
                ? zrRefs.map((r) => `| ${String(r?.label || '')} | ${String(r?.url || '')} |`)
                : ['| ZR references | UNVERIFIED |'])
        ].join('\n');

        const zrSectionTable = [
            '| Topic | Exact section | URL | Status |',
            '|---|---|---|---|',
            ...(zrSections.length
                ? zrSections.map((r) => `| ${String(r?.topic || '')} | ${String(r?.section || '')} | ${String(r?.url || '')} | ${String(r?.status || 'unknown')} |`)
                : ['| n/a | UNVERIFIED | UNVERIFIED | unavailable |'])
        ].join('\n');

        const ruleSignalsTable = [
            '| Signal | Value | Source |',
            '|---|---|---|',
            `| Use group (scan-derived) | ${String(ruleSignals?.useGroup || 'UNVERIFIED')} | ZR section text parsing |`,
            `| Max height ft (scan-derived) | ${ruleSignals?.maxHeightFt == null ? 'UNVERIFIED' : ruleSignals.maxHeightFt} | ZR section text parsing |`,
            `| Base height ft (scan-derived) | ${ruleSignals?.baseHeightFt == null ? 'UNVERIFIED' : ruleSignals.baseHeightFt} | ZR section text parsing |`,
            `| Rear yard ft (scan-derived) | ${ruleSignals?.rearYardDepthFt == null ? 'UNVERIFIED' : ruleSignals.rearYardDepthFt} | ZR section text parsing |`,
            `| Street-tree frontage ft/tree (scan-derived) | ${ruleSignals?.streetTreeFrontageFtPerTree == null ? 'UNVERIFIED' : ruleSignals.streetTreeFrontageFtPerTree} | ZR section text parsing |`,
            `| Post-base-height setback reduction % (scan-derived) | ${ruleSignals?.upperStorySetbackReductionPct == null ? 'UNVERIFIED' : ruleSignals.upperStorySetbackReductionPct} | ZR section text parsing |`
        ].join('\n');

        const scanPlanTable = [
            '| Step | Action | Status | Note |',
            '|---:|---|---|---|',
            ...(scanPlan.length
                ? scanPlan.map((s) => `| ${String(s?.step ?? '')} | ${String(s?.action || '')} | ${String(s?.status || '')} | ${String(s?.note || '')} |`)
                : ['| 1 | sequential scan | unavailable | Scan plan not returned by resolver |'])
        ].join('\n');

        const additionalRegTable = [
            '| Additional regulation check | Status | Note |',
            '|---|---|---|',
            ...(additionalRegs.length ? additionalRegs.map((r) => `| ${String(r?.title || r?.id || '')} | ${String(r?.status || 'review_required')} | ${String(r?.note || '')} |`) : ['| none listed | review_required | Manual jurisdictional checks still required |'])
        ].join('\n');

        const exceptionsAndTriggersTable = [
            '| Exception / Trigger | Status | Note |',
            '|---|---|---|',
            `| Secondary means of egress trigger | review_required | Check final story count/height/occupant load against current BC egress triggers |`,
            `| Sustainable roofing / solar / green roof requirements | review_required | Validate rooftop exclusions, occupiable roof, and sustainable roof zone exceptions |`,
            `| Special district supplemental controls | ${(specialReqs.length ? 'review_required' : 'none_mapped')} | ${(specialReqs.length ? 'Mapped special district controls present' : 'No mapped special district in current snapshot')} |`,
            `| Site-specific environmental/flood constraints | review_required | Confirm flood/coastal + CEQR/(E) designations and DEP requirements where applicable |`
        ].join('\n');

        const airRightsTable = [
            '| Candidate BBL | Address | Transferable Sq Ft (est.) | Eligibility |',
            '|---|---|---:|---|',
            ...(candidates.length ? candidates.map((c) => `| ${String(c?.bbl || '')} | ${String(c?.address || '')} | ${Number(c?.transferableSqftEstimate || 0)} | ${String(c?.eligibility || '')} |`) : ['| n/a | n/a | 0 | none identified |'])
        ].join('\n');

        const refsList = [
            ...refs.map((r) => `- ${String(r?.id || 'source')}: ${String(r?.url || '')} (${String(r?.status || 'unknown')}, ${String(r?.retrievedAt || '')})`),
            ...legal.map((l) => `- legal update ${String(l?.id || '')}: ${String(l?.url || '')} (${String(l?.status || '')}, ${String(l?.checkedAt || '')})`)
        ].filter(Boolean).join('\n');

        const confidence = zoningCtx?.confidence?.level || 'low';
        const missing = Array.isArray(zoningCtx?.flags?.missingCritical) ? zoningCtx.flags.missingCritical : [];
        const adaptiveHealth = zoningCtx?.adaptiveRuleProfileHealth || {};

        const sections = [
            `## Site Identity`,
            `- Address: ${String(zoningCtx?.query?.address || site?.address || 'n/a')}`,
            `- Borough / Block / Lot: ${String(site?.borough || 'n/a')} / ${String(site?.block || 'n/a')} / ${String(site?.lot || 'n/a')}`,
            `- BBL: ${String(site?.bbl || 'n/a')}`,
            `- Program mode: ${String(calc?.programType || zoningCtx?.query?.requestedProgramType || 'residential-new-building')}`,
            '',
            `## Filing Set Ready Input Packet`,
            filingProjectInfo,
            '',
            `## Zoning Compliance Matrix (Permitted/Required vs Provided/Proposed)`,
            zoningComplianceTable,
            '',
            `## Applied Controls (Sorted By Governing Order)`,
            appliedControlsTable,
            '',
            `## Floor Area Inputs And Deductions`,
            floorAreaInputTable,
            '',
            `## Overlays And Maps`,
            mapTable,
            '',
            `## Uses`,
            usesTable,
            '',
            `## Site Conditions`,
            siteConditionsTable,
            '',
            `## Nearby Amenities Snapshot`,
            amenitiesTable,
            '',
            `## Required Amenity Space Baseline`,
            amenitySpaceTable,
            '',
            `## Special District Requirements`,
            specialDistrictReqsTable,
            '',
            `## District-Specific Rule Scans`,
            districtSpecificReqTable,
            '',
            `## ZR Section References`,
            zrReferenceTable,
            '',
            `## ZR Exact Sections Applied`,
            zrSectionTable,
            '',
            `## Scan-Derived Rule Signals`,
            ruleSignalsTable,
            '',
            `## Sequential Scan Execution Log`,
            scanPlanTable,
            '',
            `## Citations By Metric`,
            metricCitationTable,
            '',
            `## Additional Possible Regulations`,
            additionalRegTable,
            '',
            `## Exceptions And Trigger Checks`,
            exceptionsAndTriggersTable,
            '',
            `## Zoning Controls Table`,
            coeffTable,
            '',
            `## Maximum Capacity Breakdown`,
            capacityTable,
            '',
            `## Envelope And Setback Diagram`,
            this.buildDeterministicEnvelopeDiagram(zoningCtx),
            '',
            `## Air Rights Summary`,
            airRightsSummaryTable,
            '',
            `## Air Rights Transfer Screening (Off-Site)`,
            airRightsTable,
            '',
            `## Source Snapshot`,
            refsList || '- No source snapshot available',
            '',
            `## Confidence And Flags`,
            `- Confidence: ${confidence}`,
            `- Missing critical fields: ${missing.length ? missing.join(', ') : 'none'}`,
            `- Adaptive rule profile health: ${adaptiveHealth?.ok ? 'ok' : 'incomplete'}${adaptiveHealth?.missing?.length ? ` (missing: ${adaptiveHealth.missing.join(', ')})` : ''}`,
            '- Numeric values marked UNVERIFIED are excluded from final maximum conclusion.'
        ];

        return sections.join('\n');
    }

    sanitizeFilename(input) {
        return String(input || 'zoning-report')
            .replace(/[^a-z0-9\-_.\s]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)
            .replace(/\s/g, '_') || 'zoning-report';
    }

    async ensureJsPdfLoaded() {
        if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
        if (this._jsPdfLoadPromise) return this._jsPdfLoadPromise;
        this._jsPdfLoadPromise = new Promise((resolve, reject) => {
            try {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
                s.async = true;
                s.onload = () => {
                    if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
                    else reject(new Error('jsPDF loaded but unavailable'));
                };
                s.onerror = () => reject(new Error('Failed to load jsPDF'));
                document.head.appendChild(s);
            } catch (err) {
                reject(err);
            }
        }).finally(() => {
            this._jsPdfLoadPromise = null;
        });
        return this._jsPdfLoadPromise;
    }

    async buildPdfBlobFromText(title, bodyText, zoningCtx = null) {
        const jsPDFCtor = await this.ensureJsPdfLoaded();
        const doc = new jsPDFCtor({ orientation: 'landscape', unit: 'pt', format: 'a3' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 34;
        const contentW = pageW - margin * 2;
        let y = margin;
        const ensureSpace = (needed = 20) => {
            if ((y + needed) <= (pageH - margin)) return;
            doc.addPage();
            y = margin;
        };

        const drawHeader = () => {
            doc.setFillColor(16, 24, 40);
            doc.rect(0, 0, pageW, 64, 'F');
            doc.setTextColor(255, 255, 255);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(18);
            doc.text(String(title || 'Zoning Analysis Report'), margin, 38);
            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            doc.text(`Generated: ${new Date().toISOString()}`, pageW - margin, 38, { align: 'right' });
            doc.setTextColor(20, 20, 20);
            y = 84;
        };

        const parseTable = (tableLines) => {
            const rows = [];
            tableLines.forEach((ln) => {
                if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(ln)) return;
                const cells = String(ln)
                    .trim()
                    .replace(/^\|/, '')
                    .replace(/\|$/, '')
                    .split('|')
                    .map((c) => c.trim());
                if (cells.length) rows.push(cells);
            });
            return rows;
        };

        const drawTable = (tableLines) => {
            const rows = parseTable(tableLines);
            if (!rows.length) return;
            const cols = Math.max(...rows.map((r) => r.length), 1);
            const colW = contentW / cols;
            rows.forEach((row, rowIdx) => {
                const cellLines = row.map((cell) => doc.splitTextToSize(cell || '', colW - 8));
                const rowHeight = Math.max(22, ...cellLines.map((arr) => 14 + ((arr.length - 1) * 10)));
                ensureSpace(rowHeight + 2);
                row.forEach((cell, colIdx) => {
                    const x = margin + (colIdx * colW);
                    doc.setDrawColor(165, 175, 190);
                    doc.setFillColor(rowIdx === 0 ? 235 : 250, rowIdx === 0 ? 241 : 252, rowIdx === 0 ? 255 : 255);
                    doc.rect(x, y, colW, rowHeight, 'FD');
                    doc.setFont('helvetica', rowIdx === 0 ? 'bold' : 'normal');
                    doc.setFontSize(rowIdx === 0 ? 10 : 9.2);
                    const lines = cellLines[colIdx];
                    lines.forEach((ln, i) => {
                        doc.text(String(ln), x + 4, y + 14 + (i * 10));
                    });
                });
                y += rowHeight;
            });
            y += 8;
        };

        drawHeader();
        const metrics = this.extractPdfMetrics(bodyText);
        const drawing = this.extractPdfDrawingData(zoningCtx, bodyText);

        // Locked Page 1 template: title block + scaled architectural diagrams.
        const titleBlockH = 212;
        this.drawPdfTitleBlock(doc, margin, y, contentW, titleBlockH, drawing);
        y += titleBlockH + 12;
        const diagramsH = Math.max(220, pageH - y - margin);
        this.drawScaledPlanSectionIso(doc, margin, y, contentW, diagramsH, drawing);

        // Locked Page 2 template starts with capacity panel; tables continue after.
        doc.addPage();
        drawHeader();
        ensureSpace(190);
        doc.setDrawColor(190, 196, 205);
        doc.setFillColor(251, 253, 255);
        doc.roundedRect(margin, y, contentW, 174, 6, 6, 'FD');
        this.renderPdfCapacityChart(doc, metrics, margin + 12, y + 10, Math.floor(contentW * 0.55), 150);
        this.renderPdfEnvelopeSketch(
            doc,
            {
                ...metrics,
                lotFootprint: drawing?.footprintSf ?? metrics?.lotFootprint ?? null,
                buildableFootprintSf: drawing?.buildableFootprintSf ?? null,
                rearYardDepthFt: drawing?.rearYardDepthFt ?? null,
                baseHeightFt: drawing?.baseHeightFt ?? null,
                upperStorySetbackReductionPct: drawing?.upperStorySetbackReductionPct ?? null,
                towerFootprintSf: drawing?.towerFootprintSf ?? null,
                maxHeightFt: drawing?.maxHeightFt ?? null
            },
            margin + Math.floor(contentW * 0.58),
            y + 10,
            Math.floor(contentW * 0.4),
            150
        );
        y += 190;

        const text = this.normalizeReportTextForPdf(bodyText);
        const rows = text.split('\n');
        for (let i = 0; i < rows.length; i += 1) {
            const line = String(rows[i] || '');
            const trimmed = line.trim();
            if (!trimmed) {
                y += 6;
                continue;
            }
            if (trimmed.startsWith('|')) {
                const tableLines = [];
                while (i < rows.length && String(rows[i] || '').trim().startsWith('|')) {
                    tableLines.push(String(rows[i] || ''));
                    i += 1;
                }
                i -= 1;
                drawTable(tableLines);
                continue;
            }
            if (/^##\s*/.test(line)) {
                ensureSpace(20);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(13);
                doc.text(line.replace(/^##\s*/, ''), margin, y);
                y += 18;
                continue;
            }
            const isBullet = /^-\s+/.test(trimmed);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            const wrapped = doc.splitTextToSize(line, contentW);
            ensureSpace((wrapped.length * 12) + 2);
            wrapped.forEach((ln) => {
                doc.text(String(ln), margin + (isBullet ? 4 : 0), y);
                y += 12;
            });
        }
        return doc.output('blob');
    }

    async maybeGenerateLocalPdfReportMarker(userMessage, assistantText) {
        try {
            if (!this.isAddressAnalysisRequest(userMessage)) return '';
            const body = String(assistantText || '').trim();
            if (!body) return '';
            if (this.looksLikeClarificationInsteadOfReport(body)) return '';
            if (/could not generate visible output/i.test(body)) return '';
            if (!this.scoreAddressReportCompleteness(body).isComplete) return '';
            const title = `Zoning Analysis Report - ${String(userMessage || '').slice(0, 90)}`;
            const canonicalBody = this._lastZoningCtx
                ? this.buildStructuredAddressReport(this._lastZoningCtx, '')
                : body;
            if (!this.isPdfSheetReady(this._lastZoningCtx, canonicalBody)) return '';
            const reportBlob = await this.buildPdfBlobFromText(title, canonicalBody, this._lastZoningCtx || null);
            const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const filename = `${this.sanitizeFilename(title)}.pdf`;
            this.generatedLocalReports.set(id, { blob: reportBlob, filename, createdAt: Date.now() });
            return `[Local report: ${id}|Download zoning analysis PDF]`;
        } catch (err) {
            if (window.__devWarn) window.__devWarn('Local report generation failed:', err);
            return '';
        }
    }

    isPdfSheetReady(zoningCtx, reportBody) {
        const s = String(reportBody || '').toLowerCase();
        if (!/zoning compliance matrix/i.test(s)) return false;
        if (!/maximum capacity breakdown/i.test(s)) return false;
        const d = this.extractPdfDrawingData(zoningCtx, reportBody);
        if (!d || !d.address) return false;
        return true;
    }

    downloadLocalReport(reportId) {
        try {
            const id = String(reportId || '').trim();
            const item = this.generatedLocalReports.get(id);
            if (!item || !item.blob) {
                this.showError('Report is unavailable. Please regenerate.');
                return;
            }
            const url = URL.createObjectURL(item.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = item.filename || `zoning-report-${id}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1200);
        } catch (err) {
            this.showError(`Failed to download local report: ${err?.message || err}`);
        }
    }

    /**
     * Handle image generation request
     */
    async handleImageGenerationRequest(message) {
        try {
            // Extract the image description from the message
            const imageKeywords = [
                'generate an image of', 'create an image of', 'make an image of',
                'generate a picture of', 'create a picture of', 'make a picture of',
                'generate image of', 'create image of', 'make image of',
                'generate picture of', 'create picture of', 'make picture of',
                'draw', 'paint', 'visualize', 'show me', 'picture of', 'image of'
            ];
            
            let prompt = message;
            for (const keyword of imageKeywords) {
                if (message.toLowerCase().includes(keyword)) {
                    prompt = message.substring(message.toLowerCase().indexOf(keyword) + keyword.length).trim();
                    break;
                }
            }
            
            if (!prompt) {
                prompt = message; // Use the full message if no keyword found
            }

            // Generate image using DALL-E
            const imageUrl = await this.callDALLE(prompt, '1024x1024', 'standard');
            this.removeTypingIndicator();
            
            // Add image response
            this.addImageMessage(imageUrl, prompt);
        } catch (error) {
            this.removeTypingIndicator();
            this.addMessage('error', `Image generation failed: ${error.message}`);
        }
    }

    /**
     * Call WALL-E using OpenAI Responses-first flow
     */
    async callWALLE(message, files = []) {
        try {
            // Validate configuration
            // Using proxy allows text-only without exposing apiKey
            if (!this.proxyUrl && !this.apiKey) throw new Error('WALL-E not configured (no proxy or key).');
            const isAddressMode = this.isAddressAnalysisRequest(message);
            let zoningCtx = null;
            if (isAddressMode) {
                try {
                    zoningCtx = await this.fetchNycZoningContext(message);
                    this._lastZoningCtx = zoningCtx || null;
                } catch (resolverErr) {
                    if (window.__devWarn) window.__devWarn('NYC zoning resolver failed:', resolverErr?.message || resolverErr);
                    this._lastZoningCtx = null;
                }
                const quickClarification = this.buildSimpleAddressClarification(message, zoningCtx);
                if (quickClarification) return quickClarification;
            }

            // OpenAI-recommended path: use Responses API for text and multimodal inputs.
            if (window.__devLog) window.__devLog('Using grounded responses API (text + files)');
            try {
                let out = await this.callGroundedResponses(message, false, files, '', zoningCtx);
                // Force completion mode for address analyses: avoid "please confirm" loops.
                if (isAddressMode) {
                    let attempts = 0;
                    while (attempts < 3 && this.needsAddressReportRegeneration(out)) {
                        const autofill = this.inferAddressAutofillHint(message);
                        out = await this.callGroundedResponses(
                            `${String(message || '')}

Autofill directive: ${autofill}
Return a complete final report now. Do NOT ask clarification questions.
Must include: zoning designation/overlays, FAR math, max-possible capacity breakdown, regular deductions, 5% low-energy bonus case, air-rights math, visual summary bars, and references with links.`,
                            true,
                            files,
                            '',
                            zoningCtx
                        );
                        attempts += 1;
                    }
                }
                if (!String(out || '').trim()) throw new Error('Address analysis returned empty output');
                if (isAddressMode && zoningCtx) {
                    out = this.buildStructuredAddressReport(zoningCtx, out);
                }
                return out;
            } catch (groundedErr) {
                if (window.__devWarn) window.__devWarn('Grounded responses failed:', groundedErr?.message || groundedErr);
                // Do not silently drop multimodal inputs by downgrading to text-only fallback.
                if (Array.isArray(files) && files.length > 0) {
                    throw new Error(`Responses failed for file/image input: ${groundedErr?.message || 'unknown error'}`);
                }
                if (isAddressMode) {
                    const forced = this.buildAutonomousAddressDirective(message);
                    try {
                        let out = await this.callGroundedResponses(forced, true, files, 'gpt-4o', zoningCtx);
                        let attempts = 0;
                        while (attempts < 2 && this.needsAddressReportRegeneration(out)) {
                            out = await this.callGroundedResponses(
                                `${forced}

Verification pass:
- Rebuild the report with official-source citations for all numeric coefficients.
- If unverified, mark UNVERIFIED and do not use those values in final totals.`,
                                true,
                                files,
                                'gpt-4o',
                                zoningCtx
                            );
                            attempts += 1;
                        }
                        if (String(out || '').trim()) {
                            if (zoningCtx) out = this.buildStructuredAddressReport(zoningCtx, out);
                            return out;
                        }
                    } catch (secondGroundedErr) {
                        if (window.__devWarn) window.__devWarn('Secondary grounded model failed:', secondGroundedErr?.message || secondGroundedErr);
                    }
                }
                if (window.__devWarn) window.__devWarn('Falling back to chat completions for text-only request');
                if (isAddressMode) {
                    const forced = this.buildAutonomousAddressDirective(message);
                    let out = await this.callChatCompletions(forced, { skipHistory: true });
                    let attempts = 0;
                    while (attempts < 3 && this.needsAddressReportRegeneration(out)) {
                        out = await this.callChatCompletions(
                            `${forced}

Regenerate as final report only. No questions. Include zoning/FAR/max-possible capacity breakdown/deductions/5%-low-energy/air-rights/references.`,
                            { skipHistory: true }
                        );
                        attempts += 1;
                    }
                    if (!String(out || '').trim()) throw new Error('Address analysis fallback returned empty output');
                    if (this.needsAddressReportRegeneration(out)) {
                        throw new Error('Address analysis could not be verified from reliable web-grounded sources. Please retry.');
                    }
                    if (zoningCtx) out = this.buildStructuredAddressReport(zoningCtx, out);
                    return out;
                }
                return await this.callChatCompletions(message);
            }
        } catch (error) {
            console.error('WALL-E API Error:', error);
            throw error;
        }
    }

    /**
     * Get a short friendly initial message for the current page (shown on load)
     */
    getInitialGuidelinesMessage() {
        const ctx = this.getCurrentContext();
        const hints = {
            'project-tracker': "Hey! I'm here to help with the Project Tracker. You can ask me things like: how to add a team member, where to approve your project, how the status steps work, or how to get back to your project list. Just ask!",
            'project-manager': "Hi there! I can guide you through the Project Manager—like how to respond to clients, send messages with attachments, or manage project status. What do you need?",
            'secure-chat': "Hello! I'm here to help with Connections. Ask me how to start a chat, make a call, or find a contact.",
            'calculator-app': "Hi! I can help with the Calculator or any math questions you have.",
            'invoice-app': "Hello! I can guide you through creating and managing invoices.",
            'liber-apps': "Hi! I'm WALL-E. I can help you find your way around—like opening Project Tracker, Connections, or any other app. Just ask what you'd like to do!"
        };
        return hints[ctx] || hints['liber-apps'];
    }

    /**
     * Get page-specific guidelines for WALL-E (friendly, semi-formal)
     */
    getContextGuidelines() {
        const ctx = this.getCurrentContext();
        const guidelines = {
            'project-tracker': `You are helping with the Project Tracker. The user is viewing their projects and project details.

**What's on this page:**
- My Projects grid: cards showing each project, status, description
- Project detail view: when a project is open, they see status, progress bar (Submitted → Initializing → In Progress → Review → Completed), Chat button, description, response history, team members, project library (Record In / Record Out)
- Actions vary by status: "I Approve" (initializing), "Approve (Complete)" (review), Add members by email, add files to library

**How to help:**
- Explain how to get somewhere: e.g. "Click a project card to open it" or "Use the Back button to return to the list"
- Guide through status steps: "Your project is in Review—when you're satisfied, click Approve (Complete)"
- Explain how to add members: "Type an email in the Team Members section and click Add"
- For new projects: "Submit a request from the main site to create your first project"
- Be warm and semi-formal; use "you" naturally`
            ,
            'project-manager': `You are helping with the Project Manager (admin view). The user manages project requests and responds to clients.

**What's on this page:**
- Projects list, filters by status
- Project detail: status, client info, description, admin response, files
- Send response with message and attachments to notify the client
- Approve or manage projects

**How to help:**
- Explain how to respond: "Add your message and optionally attach files, then click Send Response"
- Guide workflow: "Mark the project In Progress, then send a response so the client is notified"`
            ,
            'secure-chat': `You are helping with Connections (secure chat). The user can message contacts, start calls, or manage connections.

**How to help:**
- Explain how to start a chat: "Select a connection or create a new one"
- For calls: "Click the call icon next to a contact to start a voice or video call"`
            ,
            'calculator-app': `You are helping with the Calculator app. The user can perform math operations.

**How to help:**
- Answer calculation questions or explain how to use the calculator`
            ,
            'invoice-app': `You are helping with the Invoice Generator. The user creates and manages invoices.

**How to help:**
- Guide through creating an invoice, adding line items, or exporting`
            ,
            'file-converter': `You are helping with the File Converter. The user can convert files between formats.

**How to help:**
- Explain supported formats and how to convert files`
            ,
            'media-enhancer': `You are helping with the Media Enhancer. The user can enhance images or media.

**How to help:**
- Guide through uploading and enhancing media`
            ,
            'gallery-control': `You are helping with the Gallery Control. The user manages image galleries.

**How to help:**
- Explain how to browse, organize, or manage gallery content`
            ,
            'liber-apps': `You are helping with the Liber Apps control panel. The user sees the main dashboard with:
- Apps grid: Project Tracker, Connections (chat), Calculator, Invoices, File Converter, Media Enhancer, Gallery Control, Project Manager
- Feed, WaveConnect (audio/video), and other sections depending on view

**How to help:**
- "Click Project Tracker to see your projects" or "Open Connections to chat"
- "Use the search to find an app quickly"
- Guide them to the app that matches what they want to do`
        };
        return guidelines[ctx] || guidelines['liber-apps'];
    }

    /**
     * Build system prompt with base personality and page-specific guidelines
     */
    buildSystemPrompt() {
        const base = `You are WALL-E, a friendly, straightforward, calm expert assistant for LIBER. Be concise, practical, and natural. Keep continuity across turns: remember recent user intents, constraints, and unresolved asks. Prefer direct helpful answers over generic questions. If clarification is needed, ask one focused question and propose a best-effort assumption path in parallel.`;
        const guidelines = this.getContextGuidelines();
        const appKnowledge = `LIBER Control Panel quick map:
- Apps icon (\`fa-th\`) => Apps grid
- Personal Space (\`fa-id-badge\`) => personal profile and posting
- Wall (\`fa-stream\`) => feed posts and suggestions
- WaveConnect (\`fa-music\`) => media platform
- Profile (\`fa-user\`) => my profile
- Admin only: User Management (\`fa-users\`), Settings (\`fa-cog\`)
- WaveConnect main tabs: Audio (\`fa-music\`), Video (\`fa-video\`), Pictures (\`fa-image\`)
- WaveConnect secondary nav: Home (\`fa-house\`), Search (\`fa-magnifying-glass\`), Upload (\`fa-plus\`), Library (\`fa-user\`), Studio (\`fa-sliders\`)`;
        const regulatoryGrounding = `When users ask about zoning/codes/filing/compliance, prioritize current official sources and cite them inline with markdown links:
- NYC Zoning Resolution: https://zoningresolution.planning.nyc.gov/
- NYC ZoLa zoning map: https://zola.planning.nyc.gov/about#9.72/40.7125/-73.733
- NYC Buildings codes page: https://www.nyc.gov/site/buildings/codes/nyc-code.page
Rules:
1) Do not invent section numbers, FAR values, overlays, or filing requirements.
2) Ask clarification only if parcel lock is blocked by missing critical inputs. Otherwise continue with best-match parcel and explicit confidence flags.
3) For exact zoning floor area calculations, show formula and assumptions, and clearly label values as verified vs assumed.
4) Prefer latest adopted text and note effective date if source provides it.
5) For legal/safety-critical guidance, recommend licensed professional verification.
6) For non-NYC regions, first confirm jurisdiction and code edition, then cite the relevant official source before giving compliance guidance.
7) Capacity convention: max ZFA cap is net. Gross before deductions = cap/(1-deductionPct). Deductions = gross-cap.
8) Air-rights convention: describe zoning-lot merger transfer mechanics and donor-lot development-rights forfeiture constraints.`;
        const liveContext = this.getLiveUiContextSnapshot();
        return `${base}\n\n${appKnowledge}\n\n${regulatoryGrounding}\n\n**Current page context:**\n${guidelines}\n\n**Live UI context snapshot:**\n${liveContext}`;
    }

    getLiveUiContextSnapshot() {
        try {
            const lines = [];
            const path = String(window.location?.pathname || '/');
            lines.push(`Path: ${path}`);
            const shellOpen = !!document.body?.classList?.contains('app-shell-open');
            lines.push(`App shell open: ${shellOpen ? 'yes' : 'no'}`);
            const frame = document.getElementById('app-shell-frame');
            if (shellOpen && frame) {
                const src = String(frame.getAttribute('src') || frame.src || '').trim();
                if (src) lines.push(`Current app iframe src: ${src}`);
            }
            const activeDesktop = document.querySelector('.nav-btn.active[data-section]');
            if (activeDesktop) {
                lines.push(`Active main section: ${String(activeDesktop.getAttribute('data-section') || '').trim()}`);
            }
            const activeWaveMain = document.querySelector('.waveconnect-tabs .btn.active');
            if (activeWaveMain) {
                lines.push(`WaveConnect main tab: ${String(activeWaveMain.textContent || '').trim()}`);
            }
            const activeWaveSub = document.querySelector('#wave-subnav .btn.active[data-wave-subtab]');
            if (activeWaveSub) {
                lines.push(`WaveConnect subtab: ${String(activeWaveSub.getAttribute('data-wave-subtab') || '').trim()}`);
            }
            return lines.join('\n');
        } catch (_) {
            return 'Unavailable';
        }
    }

    getRecentConversationWindow(limit = 10) {
        try {
            const rows = Array.isArray(this.chatHistory) ? this.chatHistory : [];
            const filtered = rows
                .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
                .map((m) => ({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: String(m.content || '').trim()
                }))
                .filter((m) => m.content.length > 0);
            if (!filtered.length) return [];
            return filtered.slice(-Math.max(1, Number(limit || 10)));
        } catch (_) {
            return [];
        }
    }

    isRegulatoryOrCodeQuery(message) {
        const text = String(message || '').toLowerCase();
        if (!text) return false;
        const keys = [
            'zoning', 'zola', 'far', 'floor area', 'setback', 'overlay',
            'nyc code', 'building code', 'fire code', 'dob', 'permit',
            'filing', 'occupancy', 'egress', 'sprinkler', 'ceqr',
            'special district', 'lot coverage', 'height factor'
        ];
        return keys.some((k) => text.includes(k));
    }

    extractAssistantTextFromResponsesPayload(data) {
        try {
            const fileIds = new Set();
            if (typeof data?.output_text === 'string' && data.output_text.trim()) {
                return data.output_text.trim();
            }
            if (Array.isArray(data?.output_text)) {
                const joined = data.output_text.map((x) => String((x?.text ?? x ?? '')).trim()).filter(Boolean).join('\n\n');
                if (joined) return joined;
            }
            const output = Array.isArray(data?.output) ? data.output : [];
            const parts = [];
            output.forEach((item) => {
                const direct = String(item?.text?.value ?? item?.text ?? item?.output_text?.value ?? item?.output_text ?? '').trim();
                if (direct) parts.push(direct);
                const content = Array.isArray(item?.content) ? item.content : [];
                content.forEach((c) => {
                    const rawText = c?.text?.value ?? c?.text ?? c?.output_text?.value ?? c?.output_text ?? '';
                    const t = String(rawText || '').trim();
                    if (t) parts.push(t);
                    const refusal = String(c?.refusal?.value ?? c?.refusal ?? '').trim();
                    if (refusal) parts.push(refusal);
                    const directFileId = String(c?.file_id || '').trim();
                    if (directFileId) fileIds.add(directFileId);
                    const anns = Array.isArray(c?.annotations) ? c.annotations : [];
                    anns.forEach((a) => {
                        const ids = [
                            a?.file_id,
                            a?.file_path?.file_id,
                            a?.file_citation?.file_id
                        ].map((x) => String(x || '').trim()).filter(Boolean);
                        ids.forEach((id) => fileIds.add(id));
                    });
                });
            });
            if (parts.length) {
                const body = parts.join('\n\n');
                if (!fileIds.size) return body;
                const filesBlock = Array.from(fileIds).map((id) => `[Generated file: ${id}]`).join('\n');
                return `${body}\n\nGenerated files:\n${filesBlock}`;
            }
            const fallback = String(data?.choices?.[0]?.message?.content || '').trim();
            if (fallback) return fallback;
            const errType = String(data?.error?.type || '').trim();
            const errMsg = String(data?.error?.message || '').trim();
            if (errType || errMsg) return `Model error${errType ? ` (${errType})` : ''}: ${errMsg || 'unknown error'}`;
            return '';
        } catch (_) {
            return '';
        }
    }

    async fileToDataUrl(file) {
        return await new Promise((resolve, reject) => {
            try {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error(`Failed to read file: ${String(file?.name || 'unknown')}`));
                reader.readAsDataURL(file);
            } catch (err) {
                reject(err);
            }
        });
    }

    async downloadGeneratedFile(fileId) {
        try {
            const id = String(fileId || '').trim();
            if (!id) return;
            const resp = await this.openaiFetch(`/v1/files/${encodeURIComponent(id)}/content`, {
                method: 'GET',
                json: false,
                timeoutMs: 45000
            });
            if (!resp.ok) {
                const msg = await resp.text().catch(() => '');
                throw new Error(msg || `Unable to download file (${resp.status})`);
            }
            const blob = await resp.blob();
            const cd = String(resp.headers.get('content-disposition') || '');
            const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
            const filename = decodeURIComponent(String(nameMatch?.[1] || '').trim() || `wall-e-generated-${id}.bin`);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
        } catch (err) {
            this.showError(`Generated file download failed: ${err?.message || err}`);
        }
    }

    async fileToText(file, maxChars = 160000) {
        try {
            const text = await file.text();
            const safe = String(text || '');
            if (safe.length <= maxChars) return safe;
            return `${safe.slice(0, maxChars)}\n\n[Truncated to ${maxChars} chars]`;
        } catch (_) {
            return '';
        }
    }

    async uploadFileToOpenAI(file) {
        try {
            const form = new FormData();
            form.append('purpose', 'user_data');
            form.append('file', file, String(file?.name || 'upload.bin'));
            let resp = await this.openaiFetch('/v1/files', {
                method: 'POST',
                json: false,
                timeoutMs: 60000,
                body: form
            });
            if (!resp.ok) {
                // Compatibility fallback with legacy purpose name.
                const form2 = new FormData();
                form2.append('purpose', 'assistants');
                form2.append('file', file, String(file?.name || 'upload.bin'));
                resp = await this.openaiFetch('/v1/files', {
                    method: 'POST',
                    json: false,
                    timeoutMs: 60000,
                    body: form2
                });
            }
            if (!resp.ok) {
                const msg = await resp.text().catch(() => '');
                throw new Error(msg || `File upload failed (${resp.status})`);
            }
            const data = await resp.json();
            const id = String(data?.id || '').trim();
            if (!id) throw new Error('OpenAI file id missing');
            return id;
        } catch (err) {
            if (window.__devWarn) window.__devWarn('uploadFileToOpenAI failed:', err);
            return '';
        }
    }

    async buildResponsesUserContent(message, files = []) {
        const content = [];
        const userText = String(message || '').trim();
        if (userText) content.push({ type: 'input_text', text: userText });

        if (!Array.isArray(files) || files.length === 0) return content;

        const notes = [];
        for (const file of files) {
            if (!file || typeof file !== 'object') continue;
            const name = String(file.name || 'file');
            const type = String(file.type || '').toLowerCase();
            const size = Number(file.size || 0);

            // Keep request payloads predictable.
            if (size > 8 * 1024 * 1024) {
                notes.push(`Skipped large file "${name}" (${Math.round(size / (1024 * 1024))} MB). Please upload a smaller file.`);
                continue;
            }

            if (type.startsWith('image/')) {
                try {
                    const dataUrl = await this.fileToDataUrl(file);
                    if (dataUrl) {
                        content.push({ type: 'input_image', image_url: dataUrl });
                        notes.push(`Included image: "${name}".`);
                        continue;
                    }
                } catch (_) {}
                notes.push(`Could not attach image "${name}".`);
                continue;
            }

            if (type === 'application/pdf') {
                const fileId = await this.uploadFileToOpenAI(file);
                if (fileId) {
                    content.push({ type: 'input_file', file_id: fileId });
                    notes.push(`Included PDF as reference: "${name}".`);
                    continue;
                }
                notes.push(`Could not upload PDF "${name}" for model reading.`);
                continue;
            }

            const isTextLike = type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || type === 'text/csv';
            if (isTextLike) {
                const textBody = await this.fileToText(file);
                if (textBody) {
                    content.push({
                        type: 'input_text',
                        text: `File "${name}" (${type || 'text/plain'}) content:\n\n${textBody}`
                    });
                    continue;
                }
            }

            notes.push(`File "${name}" (${type || 'unknown'}) attached as metadata only. If you need deep analysis, provide text content or image/PDF extract.`);
        }

        if (notes.length > 0) {
            content.push({ type: 'input_text', text: `Attachment notes:\n- ${notes.join('\n- ')}` });
        }
        return content;
    }

    buildResponsesHistoryInput(currentMessage = '') {
        const current = String(currentMessage || '').trim();
        const history = this.getRecentConversationWindow(10);
        if (!history.length) return [];
        // Avoid duplicating the message just typed in this request.
        const deduped = history.filter((m, idx) => !(idx === history.length - 1 && m.role === 'user' && m.content === current));
        return deduped.map((m) => ({
            role: m.role,
            content: [{
                type: m.role === 'assistant' ? 'output_text' : 'input_text',
                text: m.content.slice(0, 3000)
            }]
        }));
    }

    buildChatCompletionsHistory(currentMessage = '') {
        const current = String(currentMessage || '').trim();
        const history = this.getRecentConversationWindow(10);
        if (!history.length) return [];
        const deduped = history.filter((m, idx) => !(idx === history.length - 1 && m.role === 'user' && m.content === current));
        return deduped.map((m) => ({
            role: m.role,
            content: m.content.slice(0, 3000)
        }));
    }

    async callGroundedResponses(message, forceRegulatory = false, files = [], modelOverride = '', zoningCtx = null) {
        const systemPrompt = this.buildSystemPrompt();
        const requireWeb = forceRegulatory || this.isRegulatoryOrCodeQuery(message);
        const wantsAddressReport = this.isAddressAnalysisRequest(message);
        let instructions = requireWeb
            ? `${systemPrompt}\n\nFor this request, use web search grounding and include source links for factual claims. Keep structure concise and practical.`
            : systemPrompt;
        if (wantsAddressReport) {
            const program = zoningCtx?.query?.requestedProgramType || this.inferRequestedProgramType(message);
            instructions += `\n\nGenerate a comprehensive zoning analysis report for the provided address. Include:
1) Property identification and assumptions used
2) Current zoning district/overlays and use framework
3) FAR/buildable area analysis with formulas and explicit assumptions
4) Bulk controls summary (height, setbacks, lot coverage, yards, parking/loading if applicable)
5) Air-rights analysis:
   - Available development rights on lot (sq ft) = max zoning floor area - existing built floor area
   - Potential added floor area from purchased air rights (sq ft) and resulting total achievable floor area
   - Practical transferability caveats and constraints
6) Maximum buildable capacity breakdown with constraints:
   - Max net by envelope/FAR min-control
   - Regular deductions (show as separate line item)
   - 5% low-energy bonus case (separate line item)
   - Final max line after each adjustment path
7) Explicit use-group row derived from current ZR/adaptive profile sources
8) Street-tree requirement computed from lot frontage using active rule profile formula
9) District-specific ZR scans with direct source URLs
10) Filing-set-ready zoning matrix table with columns:
   - Item
   - Permitted/Required
   - Provided/Proposed
   - Remarks
   - Citation
11) Constraints/risks and filing considerations
12) Practical next steps and data still needed
13) A "References" section with source links inline and at the end.
Formatting requirements:
- Use clean section headers
- Include at least one table for capacity breakdown
- Include at least one compliance matrix table in filing-set format (Permitted/Required vs Provided/Proposed)
- Include a simple visual summary (ASCII bar chart or score bars) for buildable options
- No tutorial text, no "how to start", no numbered generic learning steps.
- Keep a professional filing-style tone and architecture-ready layout.
Behavior requirements:
- Default development scenario is "${program}" unless the user explicitly requested another program.
- Do NOT ask for confirmation first; proceed with best-match interpretation and clearly state assumptions
- If address ambiguity exists, continue with best likely parcel and list alternatives in assumptions.
Do not omit references.`;
            instructions += `\n\nData-verification requirements:
- Pull zoning district and overlays from NYC ZoLa for the specific address.
- For each numeric zoning coefficient used (FAR, height/setback/bulk controls), include an explicit NYC Zoning Resolution citation.
- Do NOT invent coefficients. If exact value is not verified from official sources in this run, label it UNVERIFIED and exclude it from final max-buildable totals.
- Include a "Source Snapshot" section with source URLs and retrieval date.`;
            if (zoningCtx && zoningCtx.ok) {
                instructions += `\n\nDeterministic NYC context is provided below. Treat its numeric values as authoritative for calculations unless flagged missing/unverified. Use these values in your analysis tables and cite provided sources.`;
            }
        }
        const userContent = await this.buildResponsesUserContent(message, files);
        const modelName = String(modelOverride || this.responsesModel || 'gpt-4.1').trim();
        const deterministicContextText = (wantsAddressReport && zoningCtx && zoningCtx.ok)
            ? this.safeJsonForPrompt(zoningCtx, 22000)
            : '';
        const payload = {
            model: modelName,
            input: [
                { role: 'system', content: [{ type: 'input_text', text: instructions }] },
                ...(wantsAddressReport ? [] : this.buildResponsesHistoryInput(message)),
                ...(deterministicContextText ? [{
                    role: 'system',
                    content: [{
                        type: 'input_text',
                        text: `Deterministic NYC zoning context JSON:\n${deterministicContextText}`
                    }]
                }] : []),
                { role: 'user', content: userContent.length ? userContent : [{ type: 'input_text', text: String(message || '') }] }
            ],
            max_output_tokens: 1400
        };
        if (requireWeb) {
            payload.tools = [{ type: 'web_search_preview', search_context_size: 'high' }];
        }
        const response = await this.openaiFetch('/v1/responses', {
            method: 'POST',
            beta: null,
            timeoutMs: 35000,
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`Responses API failed: ${response.status} - ${errorData || response.statusText}`);
        }
        const data = await response.json();
        let out = this.extractAssistantTextFromResponsesPayload(data);
        if (String(out || '').trim()) return out;

        // Some responses finish asynchronously; try fetching by response id once.
        const respId = String(data?.id || '').trim();
        if (respId) {
            try {
                await new Promise((r) => setTimeout(r, 900));
                const poll = await this.openaiFetch(`/v1/responses/${encodeURIComponent(respId)}`, {
                    method: 'GET',
                    json: false,
                    timeoutMs: 15000
                });
                if (poll.ok) {
                    const polledData = await poll.json();
                    out = this.extractAssistantTextFromResponsesPayload(polledData);
                    if (String(out || '').trim()) return out;
                }
            } catch (_) {}
        }

        // If web-grounded call returned empty, retry once without tools to avoid blank replies.
        if (requireWeb) {
            const retryPayload = {
                model: modelName,
                input: [
                    { role: 'system', content: [{ type: 'input_text', text: `${systemPrompt}\n\nProvide the best possible answer now. If external lookup is unavailable, clearly state assumptions and required verification steps.` }] },
                    { role: 'user', content: userContent.length ? userContent : [{ type: 'input_text', text: String(message || '') }] }
                ],
                max_output_tokens: 1400
            };
            const retry = await this.openaiFetch('/v1/responses', {
                method: 'POST',
                beta: null,
                timeoutMs: 22000,
                body: JSON.stringify(retryPayload)
            });
            if (retry.ok) {
                const retryData = await retry.json();
                out = this.extractAssistantTextFromResponsesPayload(retryData);
                if (String(out || '').trim()) return out;
            }
        }

        throw new Error('Empty model output from Responses API');
    }

    /**
     * Use Chat Completions API for text-only messages
     */
    async callChatCompletions(message, opts = {}) {
        try {
            if (window.__devLog) window.__devLog('Using chat completions API fallback (text-only)');
            const systemPrompt = this.buildSystemPrompt();
            const historyMessages = opts?.skipHistory ? [] : this.buildChatCompletionsHistory(message);
            
            const response = await this.openaiFetch('/v1/chat/completions', {
                method: 'POST',
                beta: null,
                body: JSON.stringify({
                    model: this.chatFallbackModel || 'gpt-5-mini',
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        ...historyMessages,
                        {
                            role: 'user',
                            content: message
                        }
                    ],
                    max_completion_tokens: 1000
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error('Chat completions failed:', response.status, errorData);
                throw new Error(`Chat completions failed: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            if (window.__devLog) window.__devLog('Chat completions response received');
            const msg = data?.choices?.[0]?.message;
            const content = msg?.content;
            if (typeof content === 'string' && content.trim()) return content;
            if (Array.isArray(content)) {
                const text = content
                    .map((part) => {
                        const t = part?.text;
                        if (typeof t === 'string') return t.trim();
                        if (t && typeof t === 'object') return String(t?.value || t?.content || '').trim();
                        return String(part?.content || part?.value || '').trim();
                    })
                    .filter(Boolean)
                    .join('\n\n');
                if (text) return text;
            }
            const fallback = String(msg?.text || '').trim();
            if (fallback) return fallback;
            throw new Error('Empty model output from Chat Completions');
        } catch (error) {
            console.error('Chat completions error:', error);
            throw error;
        }
    }

    /**
     * Create a new thread
     */
    async createThread() {
        try {
            const response = await this.openaiFetch('/v1/threads', {
                method: 'POST',
                beta: 'assistants=v2'
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error('Thread creation failed:', response.status, errorData);
                throw new Error(`Failed to create thread: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            return data.id;
        } catch (error) {
            console.error('Thread creation error:', error);
            throw new Error(`Thread creation failed: ${error.message}`);
        }
    }

    /**
     * Add message to thread - HANDLES ALL POSSIBLE INPUT COMBINATIONS
     */
    async addMessageToThread(message, files = []) {
        try {
            if (window.__devLog) window.__devLog('=== ADDING MESSAGE TO THREAD ===');
            if (window.__devLog) window.__devLog('Message: [redacted]');
            if (window.__devLog) window.__devLog('Files:', files);
            if (window.__devLog) window.__devLog('Files length:', files.length);
            
            // SCENARIO 1: No message and no files - INVALID
            if (!message && (!files || files.length === 0)) {
                throw new Error('Cannot send empty message with no files');
            }
            
            // SCENARIO 2: Text-only message (no files)
            if (message && (!files || files.length === 0)) {
                if (window.__devLog) window.__devLog('SCENARIO 2: Text-only message');
                
                if (window.__devLog) window.__devLog('Sending text-only content as string: [redacted]');
                
                const response = await this.openaiFetch(`/v1/threads/${this.threadId}/messages`, {
                    method: 'POST',
                    beta: 'assistants=v2',
                    body: JSON.stringify({
                        role: 'user',
                        content: message.trim()
                    })
                });

                if (!response.ok) {
                    const errorData = await response.text();
                    console.error('Failed to add text-only message:', response.status, errorData);
                    throw new Error(`Failed to add message to thread: ${response.status} - ${response.statusText}`);
                }

                const result = await response.json();
                if (window.__devLog) window.__devLog('Text-only message added successfully:', result);
                return result;
            }
            
            // SCENARIO 3: Files only (no message)
            if (!message && files && files.length > 0) {
                if (window.__devLog) window.__devLog('SCENARIO 3: Files only');
                return await this.handleFilesOnlyMessage(files);
            }
            
            // SCENARIO 4: Message with files
            if (message && files && files.length > 0) {
                if (window.__devLog) window.__devLog('SCENARIO 4: Message with files');
                return await this.handleMessageWithFiles(message, files);
            }
            
            // Fallback - should never reach here
            throw new Error('Invalid input combination');
            
        } catch (error) {
            console.error('Error adding message to thread:', error);
            throw error;
        }
    }

    /**
     * Handle files-only message (no text)
     */
    async handleFilesOnlyMessage(files) {
        if (window.__devLog) window.__devLog('Processing files-only message');
        
        // Upload all files first
        const uploadedFiles = await this.uploadAllFiles(files);
        
        if (uploadedFiles.length === 0) {
            throw new Error('No files were successfully uploaded');
        }
        
        // Separate files by type
        const { imageFiles, otherFiles } = this.separateFilesByType(uploadedFiles);
        
        // Create content array
        const content = [];
        
        // Add image files directly to message content
        for (const { fileId } of imageFiles) {
            content.push({
                type: 'image_file',
                image_file: {
                    file_id: fileId
                }
            });
        }
        
        // For non-image files, attach them to the assistant first
        if (otherFiles.length > 0) {
            const otherFileIds = otherFiles.map(({ fileId }) => fileId);
            await this.attachFilesToAssistant(otherFileIds);
        }
        
        // If we have no content (shouldn't happen), add a default text
        if (content.length === 0) {
            if (window.__devLog) window.__devLog('No files uploaded, sending default text message');
            
            const response = await this.openaiFetch(`/v1/threads/${this.threadId}/messages`, {
                method: 'POST',
                beta: 'assistants=v2',
                body: JSON.stringify({
                    role: 'user',
                    content: 'Please analyze the attached files.'
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error('Failed to add default message:', response.status, errorData);
                throw new Error(`Failed to add message to thread: ${response.status} - ${response.statusText}`);
            }

            const result = await response.json();
            if (window.__devLog) window.__devLog('Default message added successfully:', result);
            return result;
        }
        
        if (window.__devLog) window.__devLog('Sending files-only content:', JSON.stringify(content, null, 2));
        
        const response = await this.openaiFetch(`/v1/threads/${this.threadId}/messages`, {
            method: 'POST',
            beta: 'assistants=v2',
            body: JSON.stringify({
                role: 'user',
                content: content
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Failed to add files-only message:', response.status, errorData);
            throw new Error(`Failed to add message to thread: ${response.status} - ${response.statusText}`);
        }

        const result = await response.json();
        if (window.__devLog) window.__devLog('Files-only message added successfully:', result);
        return result;
    }

    /**
     * Handle message with files
     */
    async handleMessageWithFiles(message, files) {
        if (window.__devLog) window.__devLog('Processing message with files');
        
        // Upload all files first
        const uploadedFiles = await this.uploadAllFiles(files);
        
        if (uploadedFiles.length === 0) {
            if (window.__devWarn) window.__devWarn('No files were successfully uploaded, falling back to text-only');
            // Fall back to text-only message
            if (window.__devLog) window.__devLog('Fallback to text-only message');
            
            const response = await this.openaiFetch(`/v1/threads/${this.threadId}/messages`, {
                method: 'POST',
                beta: 'assistants=v2',
                body: JSON.stringify({
                    role: 'user',
                    content: message.trim()
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error('Failed to add fallback message:', response.status, errorData);
                throw new Error(`Failed to add message to thread: ${response.status} - ${response.statusText}`);
            }

            const result = await response.json();
            if (window.__devLog) window.__devLog('Fallback message added successfully:', result);
            return result;
        }
        
        // Separate files by type
        const { imageFiles, otherFiles } = this.separateFilesByType(uploadedFiles);
        
        // Create content array starting with text
        const content = [
            {
                type: 'text',
                text: message.trim()
            }
        ];
        
        // Add image files directly to message content
        for (const { fileId } of imageFiles) {
            content.push({
                type: 'image_file',
                image_file: {
                    file_id: fileId
                }
            });
        }
        
        // For non-image files, attach them to the assistant first
        if (otherFiles.length > 0) {
            const otherFileIds = otherFiles.map(({ fileId }) => fileId);
            await this.attachFilesToAssistant(otherFileIds);
        }
        
        if (window.__devLog) window.__devLog('Sending message with files content:', JSON.stringify(content, null, 2));
        
        const response = await this.openaiFetch(`/v1/threads/${this.threadId}/messages`, {
            method: 'POST',
            beta: 'assistants=v2',
            body: JSON.stringify({
                role: 'user',
                content: content
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Failed to add message with files:', response.status, errorData);
            throw new Error(`Failed to add message to thread: ${response.status} - ${response.statusText}`);
        }

        const result = await response.json();
        if (window.__devLog) window.__devLog('Message with files added successfully:', result);
        return result;
    }

    /**
     * Upload all files and return array of { file, fileId }
     */
    async uploadAllFiles(files) {
        const uploadedFiles = [];
        
        for (const file of files) {
            try {
                if (window.__devLog) window.__devLog('Uploading file:', file.name, file.type, file.size);
                const fileId = await this.uploadFile(file);
                uploadedFiles.push({ file, fileId });
                if (window.__devLog) window.__devLog('File uploaded successfully:', file.name, '->', fileId);
            } catch (fileError) {
                console.error('Failed to upload file:', fileError);
                // Continue with other files
            }
        }
        
        return uploadedFiles;
    }

    /**
     * Separate files by type (images vs others)
     */
    separateFilesByType(uploadedFiles) {
        const imageFiles = [];
        const otherFiles = [];
        
        for (const { file, fileId } of uploadedFiles) {
            if (file.type && file.type.startsWith('image/')) {
                imageFiles.push({ file, fileId });
            } else {
                otherFiles.push({ file, fileId });
            }
        }
        
        if (window.__devLog) window.__devLog('Separated files - Images:', imageFiles.length, 'Others:', otherFiles.length);
        return { imageFiles, otherFiles };
    }

    /**
     * Upload file to OpenAI
     */
    async uploadFile(file) {
        try {
            // Create FormData for file upload
            const formData = new FormData();
            formData.append('file', file);
            formData.append('purpose', 'assistants');

            const response = await this.openaiFetch('/v1/files', {
                method: 'POST',
                json: false,
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error('File upload failed:', response.status, errorData);
                throw new Error(`File upload failed: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            if (window.__devLog) window.__devLog(`File uploaded successfully: ${file.name} -> ${data.id}`);
            return data.id;
        } catch (error) {
            console.error('Error uploading file:', error);
            throw error;
        }
    }

    /**
     * Attach files to the assistant
     */
    async attachFilesToAssistant(fileIds) {
        try {
            if (window.__devLog) window.__devLog('Attaching files to assistant:', fileIds);
            
            // First, get the current assistant configuration
            const getResponse = await this.openaiFetch(`/v1/assistants/${this.assistantId}`, {
                method: 'GET',
                beta: 'assistants=v2',
                json: false
            });

            if (!getResponse.ok) {
                const errorData = await getResponse.text();
                console.error('Failed to get assistant config:', getResponse.status, errorData);
                throw new Error(`Failed to get assistant config: ${getResponse.status} - ${getResponse.statusText}`);
            }

            const assistant = await getResponse.json();
            if (window.__devLog) window.__devLog('Current assistant config:', assistant);
            
            // Get existing file IDs
            const existingFileIds = assistant.file_ids || [];
            if (window.__devLog) window.__devLog('Existing file IDs:', existingFileIds);
            
            // Merge with new file IDs, avoiding duplicates
            const allFileIds = [...new Set([...existingFileIds, ...fileIds])];
            if (window.__devLog) window.__devLog('All file IDs (merged):', allFileIds);
            
            // Update the assistant with all file IDs
            const updateResponse = await this.openaiFetch(`/v1/assistants/${this.assistantId}`, {
                method: 'POST',
                beta: 'assistants=v2',
                body: JSON.stringify({
                    file_ids: allFileIds
                })
            });

            if (!updateResponse.ok) {
                const errorData = await updateResponse.text();
                console.error('Failed to update assistant with files:', updateResponse.status, errorData);
                throw new Error(`Failed to update assistant with files: ${updateResponse.status} - ${updateResponse.statusText}`);
            }

            const data = await updateResponse.json();
            if (window.__devLog) window.__devLog('Assistant updated with files successfully:', data);
            return data;
        } catch (error) {
            console.error('Error attaching files to assistant:', error);
            throw error;
        }
    }

    /**
     * Run the assistant
     */
    async runAssistant() {
        try {
            if (window.__devLog) window.__devLog('Starting assistant run...');
            const response = await this.openaiFetch(`/v1/threads/${this.threadId}/runs`, {
                method: 'POST',
                beta: 'assistants=v2',
                body: JSON.stringify({
                    assistant_id: this.assistantId
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error('Assistant run failed:', response.status, errorData);
                throw new Error(`Failed to run assistant: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            if (window.__devLog) window.__devLog('Assistant run started successfully:', data);
            return data.id;
        } catch (error) {
            console.error('Error in runAssistant:', error);
            throw error;
        }
    }

    /**
     * Wait for assistant response
     */
    async waitForResponse(runId) {
        let attempts = 0;
        const maxAttempts = 30; // 30 seconds timeout

        if (window.__devLog) window.__devLog(`Waiting for assistant response (runId: ${runId})...`);

        while (attempts < maxAttempts) {
            try {
                const response = await this.openaiFetch(`/v1/threads/${this.threadId}/runs/${runId}`, {
                    beta: 'assistants=v2',
                    json: false
                });

                if (!response.ok) {
                    const errorData = await response.text();
                    console.error('Failed to check run status:', response.status, errorData);
                    throw new Error(`Failed to check run status: ${response.status} - ${response.statusText}`);
                }

                const data = await response.json();
                if (window.__devLog) window.__devLog(`Run status (attempt ${attempts + 1}):`, data.status);

                if (data.status === 'completed') {
                    if (window.__devLog) window.__devLog('Assistant run completed successfully');
                    // Get the response message
                    return await this.getLastMessage();
                } else if (data.status === 'failed') {
                    console.error('Assistant run failed:', data);
                    throw new Error(`Assistant run failed: ${data.last_error?.message || 'Unknown error'}`);
                } else if (data.status === 'requires_action') {
                    console.error('Assistant requires action:', data);
                    throw new Error(`Assistant requires action: ${data.required_action?.type || 'Unknown action'}`);
                } else if (data.status === 'cancelled') {
                    console.error('Assistant run was cancelled');
                    throw new Error('Assistant run was cancelled');
                } else if (data.status === 'expired') {
                    console.error('Assistant run expired');
                    throw new Error('Assistant run expired');
                }

                // Wait 1 second before checking again
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            } catch (error) {
                console.error(`Error checking run status (attempt ${attempts + 1}):`, error);
                throw error;
            }
        }

        console.error('Assistant run timed out after', maxAttempts, 'attempts');
        throw new Error('Response timeout');
    }

    /**
     * Get the last message from the thread
     */
    async getLastMessage() {
        const response = await this.openaiFetch(`/v1/threads/${this.threadId}/messages`, {
            beta: 'assistants=v2',
            json: false
        });

        if (!response.ok) {
            throw new Error('Failed to get messages');
        }

        const data = await response.json();
        const messages = data.data;
        
        if (messages.length > 0) {
            const lastMessage = messages[0];
            if (lastMessage.content && lastMessage.content.length > 0) {
                const content = lastMessage.content[0];
                
                // Handle different content types
                if (content.type === 'text') {
                    return content.text.value;
                } else if (content.type === 'image_file') {
                    // Handle image file attachments
                    const fileId = content.image_file.file_id;
                    return `[Image attachment: ${fileId}]`;
                } else if (content.type === 'file') {
                    // Handle file attachments
                    const fileId = content.file.file_id;
                    return `[File attachment: ${fileId}]`;
                }
            }
        }

        return 'No response received';
    }

    /**
     * Get current context (active app in shell takes precedence over main page)
     */
    getCurrentContext() {
        const shell = document.getElementById('app-shell');
        const frame = document.getElementById('app-shell-frame');
        if (shell && frame && document.body.classList.contains('app-shell-open')) {
            try {
                const src = String(frame.src || frame.getAttribute('src') || '').toLowerCase();
                if (src && src !== 'about:blank') {
                    if (src.includes('/apps/project-tracker/')) return 'project-tracker';
                    if (src.includes('/apps/project-manager/')) return 'project-manager';
                    if (src.includes('/apps/secure-chat/')) return 'secure-chat';
                    if (src.includes('/apps/calculator/')) return 'calculator-app';
                    if (src.includes('/apps/invoices-app/')) return 'invoice-app';
                    if (src.includes('/apps/file-converter/')) return 'file-converter';
                    if (src.includes('/apps/media-enhancer/')) return 'media-enhancer';
                    if (src.includes('/apps/gallery-control/')) return 'gallery-control';
                }
            } catch (_) {}
        }
        const path = window.location.pathname.toLowerCase();
        if (path.includes('/apps/calculator/')) return 'calculator-app';
        if (path.includes('/apps/invoices-app/')) return 'invoice-app';
        if (path.includes('/apps/project-tracker/')) return 'project-tracker';
        if (path.includes('/apps/project-manager/')) return 'project-manager';
        if (path.includes('/control-panel') || path.includes('/liber-apps')) return 'liber-apps';
        return 'liber-apps';
    }

    /**
     * Get app information
     */
    getAppInfo() {
        const context = this.getCurrentContext();
        const appMap = {
            'calculator-app': { name: 'Calculator', description: 'Mathematical operations and calculations' },
            'invoice-app': { name: 'Invoice Generator', description: 'Create and manage invoices' },
            'liber-apps': { name: 'Control Panel', description: 'Main dashboard for app management' }
        };
        return appMap[context] || { name: 'Unknown App', description: 'Unknown application' };
    }

    /**
     * Add message to chat
     */
    addMessage(role, content, files = []) {
        const messagesContainer = document.getElementById('chatgpt-messages');
        if (!messagesContainer) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = `chatgpt-message ${role}`;

        let messageHTML = '';
        
        if (role === 'user') {
            messageHTML = `
                <div class="message-content">
                    <div class="message-text">${this.escapeHtml(content)}</div>
                    ${this.renderFileAttachments(files)}
                </div>
                <div class="message-avatar">
                    <i class="fas fa-user"></i>
                </div>
            `;
        } else if (role === 'assistant') {
            // Check if content contains file attachments
            const hasFileAttachments = content.includes('[Image attachment:') || content.includes('[File attachment:');
            
            messageHTML = `
                <div class="message-avatar">
                    <img src="images/wall_e.svg" alt="WALL-E" class="avatar-icon">
                </div>
                <div class="message-content">
                    <div class="message-text">
                        ${this.formatResponse(content)}
                        ${hasFileAttachments ? '<p><em>📎 Assistant has attached files to this response</em></p>' : ''}
                    </div>
                </div>
            `;
        } else if (role === 'error') {
            messageHTML = `
                <div class="message-avatar">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <div class="message-content">
                    <div class="message-text error">${this.escapeHtml(content)}</div>
                </div>
            `;
        }

        messageDiv.innerHTML = messageHTML;
        messagesContainer.appendChild(messageDiv);
        messageDiv.querySelectorAll('.wall-e-file-download').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const fileId = String(btn.getAttribute('data-file-id') || '').trim();
                if (!fileId) return;
                this.downloadGeneratedFile(fileId);
            });
        });
        messageDiv.querySelectorAll('.wall-e-local-report-download').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const reportId = String(btn.getAttribute('data-local-report-id') || '').trim();
                if (!reportId) return;
                this.downloadLocalReport(reportId);
            });
        });

        // Scroll to bottom
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        // Add to history
        this.chatHistory.push({ role, content, files, timestamp: new Date() });

        // Limit history to last 50 messages
        if (this.chatHistory.length > this.maxHistoryItems) {
            this.chatHistory = this.chatHistory.slice(-this.maxHistoryItems);
        }

        // Save history to localStorage
        this.saveChatHistory();
    }

    /**
     * Render file attachments in message
     */
    renderFileAttachments(files) {
        if (!files || files.length === 0) return '';

        return `
            <div class="file-attachments">
                ${files.map(file => {
                    // Safety check for file object
                    if (!file || typeof file !== 'object') {
                        return '';
                    }
                    
                    const fileName = file.name || 'Unknown file';
                    const fileType = file.type || '';
                    const fileSize = file.size || 0;
                    
                    return `
                        <div class="file-attachment">
                            <i class="fas ${this.getFileIcon(fileType)}"></i>
                            <span>${fileName}</span>
                            <small>(${this.formatFileSize(fileSize)})</small>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    /**
     * Get file icon based on type
     */
    getFileIcon(type) {
        // Handle undefined, null, or empty type
        if (!type || typeof type !== 'string') {
            return 'fa-file';
        }
        
        if (type.startsWith('image/')) return 'fa-image';
        if (type === 'application/pdf') return 'fa-file-pdf';
        if (type.startsWith('text/')) return 'fa-file-text';
        if (type === 'application/json') return 'fa-file-code';
        if (type === 'application/xml') return 'fa-file-code';
        if (type === 'text/csv') return 'fa-file-csv';
        return 'fa-file';
    }

    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Handle file upload
     */
    handleFileUpload(event) {
        const files = Array.from(event.target.files);
        this.processFiles(files);
        event.target.value = ''; // Clear input
    }

    /**
     * Check if file type is supported
     */
    isFileTypeSupported(type) {
        return this.supportedFileTypes.some(supportedType => {
            if (supportedType.endsWith('/*')) {
                return type.startsWith(supportedType.slice(0, -1));
            }
            return type === supportedType;
        });
    }

    /**
     * Update file upload display
     */
    updateFileUploadDisplay() {
        const uploadArea = document.getElementById('chatgpt-file-upload');
        if (!uploadArea) return;

        const existingFiles = uploadArea.querySelectorAll('.uploaded-file');
        existingFiles.forEach(file => file.remove());

        this.fileUploads.forEach((file, index) => {
            // Safety check for file object
            if (!file || typeof file !== 'object') {
                return;
            }
            
            const fileName = file.name || 'Unknown file';
            const fileType = file.type || '';
            
            const fileDiv = document.createElement('div');
            fileDiv.className = 'uploaded-file';
            fileDiv.innerHTML = `
                <i class="fas ${this.getFileIcon(fileType)}"></i>
                <span>${fileName}</span>
                <button class="remove-file" onclick="chatgptIntegration.removeFile(${index})">
                    <i class="fas fa-times"></i>
                </button>
            `;
            uploadArea.appendChild(fileDiv);
        });
    }

    /**
     * Remove file from uploads
     */
    removeFile(index) {
        this.fileUploads.splice(index, 1);
        this.updateFileUploadDisplay();
    }

    /**
     * Add typing indicator
     */
    addTypingIndicator() {
        const messagesContainer = document.getElementById('chatgpt-messages');
        if (!messagesContainer) return;

        const typingDiv = document.createElement('div');
        typingDiv.className = 'chatgpt-message assistant typing';
        typingDiv.id = 'typing-indicator';
        typingDiv.innerHTML = `
            <div class="message-avatar">
                <img src="images/wall_e.svg" alt="WALL-E" class="avatar-icon">
            </div>
            <div class="message-content">
                <div class="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        `;
        messagesContainer.appendChild(typingDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * Remove typing indicator
     */
    removeTypingIndicator() {
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
    }

    /**
     * Auto-resize textarea
     */
    autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    /**
     * Format response with markdown-like formatting
     */
    formatResponse(text) {
        // Convert markdown-like formatting to HTML
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\[Generated file:\s*([A-Za-z0-9_-]+)\]/g, '<button type="button" class="btn btn-secondary btn-sm wall-e-file-download" data-file-id="$1">Download generated file</button>')
            .replace(/\[Local report:\s*([A-Za-z0-9_-]+)\|([^\]]+)\]/g, '<button type="button" class="btn btn-secondary btn-sm wall-e-local-report-download" data-local-report-id="$1">$2</button>')
            .replace(/\n/g, '<br>');
    }

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show error message
     */
    showError(message) {
        if (window.dashboardManager) {
            window.dashboardManager.showError(message);
        } else {
            console.error('WALL-E Error:', message);
            // Show a simple alert if dashboard manager is not available
            alert('WALL-E Error: ' + message);
        }
    }

    /**
     * Update context
     */
    updateContext(context) {
        this.currentContext = context;
    }

    /**
     * Get chat history
     */
    getChatHistory() {
        return this.chatHistory;
    }

    /**
     * Get current user ID for history storage
     */
    getCurrentUserId() {
        // Try to get user ID from various sources
        if (window.authManager && window.authManager.currentUser) {
            return window.authManager.currentUser.username || window.authManager.currentUser.email;
        }
        
        // Fallback to session storage or generate temporary ID
        const sessionId = sessionStorage.getItem('wall_e_session_id');
        if (sessionId) {
            return sessionId;
        }
        
        // Generate new session ID
        const newSessionId = 'guest_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('wall_e_session_id', newSessionId);
        return newSessionId;
    }

    /**
     * Load chat history for current user
     */
    loadChatHistory() {
        try {
            const userId = this.getCurrentUserId();
            this.currentUserId = userId;
            
            // If we have a current thread, load its history
            if (this.threadId) {
                this.loadChatHistoryForThread(this.threadId);
            } else {
                // Legacy: load from old format
                const historyKey = `wall_e_chat_history_${userId}`;
                const savedHistory = localStorage.getItem(historyKey);
                
                if (savedHistory) {
                    let parsed;
                    try { parsed = JSON.parse(savedHistory); } catch { parsed = null; }
                    if (parsed && parsed.enc && parsed.data) {
                        if (this.cryptoReady) {
                            this.decryptString(parsed.data).then((plain) => {
                                try {
                                    const arr = JSON.parse(plain || '[]');
                                    this.chatHistory = Array.isArray(arr) ? arr.slice(-this.maxHistoryItems) : [];
                                    if (window.__devLog) window.__devLog(`Loaded ${this.chatHistory.length} encrypted legacy messages for user: ${userId}`);
                                    this.displayChatHistory();
                                } catch {
                                    this.chatHistory = [];
                                    this.displayChatHistory();
                                }
                            });
                            return;
                        } else {
                            if (window.__devWarn) window.__devWarn('Encrypted legacy history present but crypto not ready');
                            this.chatHistory = [];
                        }
                    } else if (Array.isArray(parsed)) {
                        this.chatHistory = parsed.slice(-this.maxHistoryItems);
                        if (window.__devLog) window.__devLog(`Loaded ${this.chatHistory.length} chat history items for user: ${userId}`);
                        this.displayChatHistory();
                    } else {
                        if (window.__devLog) window.__devLog('No valid legacy history found');
                    }
                } else {
                    if (window.__devLog) window.__devLog(`No chat history found for user: ${userId}`);
                }
            }
        } catch (error) {
            console.error('Failed to load chat history:', error);
        }
    }

    /**
     * Display chat history in the messages container
     */
    displayChatHistory() {
        const messagesContainer = document.getElementById('chatgpt-messages');
        if (!messagesContainer) return;

        if (this.chatHistory.length === 0) {
            const initialGuidelines = this.getInitialGuidelinesMessage();
            messagesContainer.innerHTML = `
                <div class="chatgpt-welcome">
                    <img src="images/wall_e.svg" alt="WALL-E" class="welcome-icon">
                    <h4>Wall-eeeee!</h4>
                    <p>Any help?</p>
                    <p class="wall-e-initial-guidelines">${this.escapeHtml(initialGuidelines)}</p>
                    ${!this.isEnabled ? '<p class="setup-notice"><strong>⚠️ Configuration Required:</strong> WALL-E configuration could not be loaded. Please check the Gist setup.</p>' : ''}
                </div>
            `;
            this.updateClearHistoryButton(false);
            return;
        }

        // Clear welcome message
        messagesContainer.innerHTML = '';

        // Display each message from history
        this.chatHistory.forEach(item => {
            if (item.role === 'user') {
                this.addMessageToDisplay('user', item.content, item.files || []);
            } else if (item.role === 'assistant') {
                this.addMessageToDisplay('assistant', item.content);
            } else if (item.role === 'error') {
                this.addMessageToDisplay('error', item.content);
            }
        });

        // Scroll to bottom
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        // Show clear history button
        this.updateClearHistoryButton(this.chatHistory.length > 0);
    }

    /**
     * Add message to display without saving to history (for loading history)
     */
    addMessageToDisplay(role, content, files = []) {
        const messagesContainer = document.getElementById('chatgpt-messages');
        if (!messagesContainer) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = `chatgpt-message ${role}`;

        let messageHTML = '';
        
        if (role === 'user') {
            messageHTML = `
                <div class="message-content">
                    <div class="message-text">${this.escapeHtml(content)}</div>
                    ${this.renderFileAttachments(files)}
                </div>
                <div class="message-avatar">
                    <i class="fas fa-user"></i>
                </div>
            `;
        } else if (role === 'assistant') {
            // Check if content contains file attachments
            const hasFileAttachments = content.includes('[Image attachment:') || content.includes('[File attachment:');
            
            messageHTML = `
                <div class="message-avatar">
                    <img src="images/wall_e.svg" alt="WALL-E" class="avatar-icon">
                </div>
                <div class="message-content">
                    <div class="message-text">
                        ${this.formatResponse(content)}
                        ${hasFileAttachments ? '<p><em>📎 Assistant has attached files to this response</em></p>' : ''}
                    </div>
                </div>
            `;
        } else if (role === 'error') {
            messageHTML = `
                <div class="message-avatar">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <div class="message-content">
                    <div class="message-text error">${this.escapeHtml(content)}</div>
                </div>
            `;
        }

        messageDiv.innerHTML = messageHTML;
        messagesContainer.appendChild(messageDiv);
    }

    /**
     * Clear chat history for current user
     */
    clearChatHistory() {
        try {
            if (this.threadId) {
                // Clear current thread history
                const userId = this.getCurrentUserId();
                const historyKey = `wall_e_chat_history_${userId}_${this.threadId}`;
                localStorage.removeItem(historyKey);
            }
            
            this.chatHistory = [];
            
            // Reset to welcome message
            const messagesContainer = document.getElementById('chatgpt-messages');
            if (messagesContainer) {
                messagesContainer.innerHTML = `
                    <div class="chatgpt-welcome">
                        <img src="images/wall_e.svg" alt="WALL-E" class="welcome-icon">
                        <h4>Wall-eeeee!</h4>
                        <p>Any help?</p>
                        ${!this.isEnabled ? '<p class="setup-notice"><strong>⚠️ Configuration Required:</strong> WALL-E configuration could not be loaded. Please check the Gist setup.</p>' : ''}
                    </div>
                `;
            }
            
            if (window.__devLog) window.__devLog(`Cleared chat history for thread: ${this.threadId}`);
        } catch (error) {
            console.error('Failed to clear chat history:', error);
        }
    }

    /**
     * Update clear history button visibility
     */
    updateClearHistoryButton(show) {
        const clearHistoryBtn = document.getElementById('chatgpt-clear-history');
        if (clearHistoryBtn) {
            if (show) {
                clearHistoryBtn.style.display = 'flex';
                clearHistoryBtn.classList.add('visible');
            } else {
                clearHistoryBtn.style.display = 'none';
                clearHistoryBtn.classList.remove('visible');
            }
        }
    }

    /**
     * Save chat history for current user
     */
    saveChatHistory() {
        // Use the new thread-based save method
        this.saveChatHistoryForThread();
    }

    /**
     * Show rename thread prompt
     */
    renameThreadPrompt(threadId) {
        const thread = this.savedThreads.find(t => t.id === threadId);
        if (!thread) return;
        
        const newName = prompt('Enter new thread name:', thread.name);
        if (newName && newName.trim() && newName.trim() !== thread.name) {
            thread.name = newName.trim();
            if (threadId === this.threadId) {
                this.currentThreadName = newName.trim();
            }
            this.saveThreads();
            this.updateThreadSelector();
        }
    }

    /**
     * Toggle thread selector visibility
     */
    toggleThreadSelector() {
        const threadSelector = document.getElementById('chatgpt-thread-selector');
        
        if (!threadSelector) {
            console.error('Thread selector element not found!');
            return;
        }
        
        if (threadSelector.style.display === 'none' || !threadSelector.style.display) {
            this.showThreadSelector();
        } else {
            this.hideThreadSelector();
        }
    }

    /**
     * Show thread selector
     */
    showThreadSelector() {
        const threadSelector = document.getElementById('chatgpt-thread-selector');
        if (!threadSelector) {
            console.error('Thread selector element not found in showThreadSelector!');
            return;
        }
        
        threadSelector.style.display = 'block';
        threadSelector.style.visibility = 'visible';
        threadSelector.style.opacity = '1';
        
        // Update the thread list
        this.updateThreadSelector();
    }

    /**
     * Hide thread selector
     */
    hideThreadSelector() {
        const threadSelector = document.getElementById('chatgpt-thread-selector');
        if (!threadSelector) {
            console.error('Thread selector element not found in hideThreadSelector!');
            return;
        }
        
        threadSelector.style.display = 'none';
    }
}

// Create global instance
window.chatgptIntegration = new ChatGPTIntegration();
window.wallE = window.chatgptIntegration; // Alias for compatibility

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChatGPTIntegration;
}