/**
 * Main Application Entry Point
 * LIBER/APPS
 */

class LiberAppsControlPanel {
    constructor() {
        this.isInitialized = false;
        this.init();
    }

    /**
     * Initialize the application
     */
    async init() {
        try {
            // Show loading screen
            this.showLoadingScreen();

            // Wait for DOM to be ready
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.startApp());
            } else {
                this.startApp();
            }

        } catch (error) {
            console.error('Failed to initialize application:', error);
            this.showError('Failed to initialize application');
        }
    }

    /**
     * Start the application
     */
    async startApp() {
        try {
            // Initialize all modules
            await this.initializeModules();

            // Setup global event listeners
            this.setupGlobalEventListeners();

            // Initialize keyboard shortcuts
            if (window.dashboardManager) {
                window.dashboardManager.initKeyboardShortcuts();
            }

            // Hide loading screen
            this.hideLoadingScreen();

            // Mark as initialized
            this.isInitialized = true;

            if (window.__devLog) window.__devLog('LIBER/APPS initialized successfully');

        } catch (e) {
            console.error('App start failed:', e);
            document.body.innerHTML = `
              <div style="color: #ff4444; text-align: center; padding: 40px; background: #111; border-radius: 12px; max-width: 600px; margin: 20% auto;">
                <h2>Failed to Load LIBER/APPS</h2>
                <p>${e.message}</p>
                <p>Check your network connection and try reloading. If issues persist, clear cache or contact support.</p>
                <button onclick="location.reload()" style="padding: 10px 20px; background: #00d4ff; border: none; border-radius: 6px; color: #000; cursor: pointer;">Reload</button>
              </div>
            `;
        }
    }

    /**
     * Initialize all modules
     */
    async initializeModules() {
        // Wait for all modules to be available
        const maxWaitTime = 30000; // 30 seconds
        const startTime = Date.now();

        while (!this.areModulesReady() && (Date.now() - startTime) < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        if (!this.areModulesReady()) {
            throw new Error('Failed to load required modules after extended wait');
        }

        // Check Firebase availability first - REQUIRED
        if (window.__devLog) window.__devLog('Checking Firebase availability...');
        
        // Wait for Firebase to be fully initialized (listen to event + poll)
        let attempts = 0;
        const maxAttempts = 150; // 15 seconds for CDN + keys

        if (!window.firebaseService || !window.firebaseService.isInitialized) {
            await new Promise(resolve => {
                const handler = () => {
                    window.removeEventListener('firebase-ready', handler);
                    resolve();
                };
                window.addEventListener('firebase-ready', handler, { once: true });
                // Also poll as a fallback
                (async () => {
                    while ((!window.firebaseService || !window.firebaseService.isInitialized) && attempts < maxAttempts) {
                        await new Promise(r => setTimeout(r, 50));
                        attempts++;
                    }
                    resolve();
                })();
            });
        }

        if (!window.firebaseService || !window.firebaseService.isInitialized) {
            console.error('❌ Firebase is required but not available!');
            console.error('Firebase service status:', {
                serviceExists: !!window.firebaseService,
                isInitialized: window.firebaseService?.isInitialized,
                firebaseSDK: typeof firebase !== 'undefined'
            });
            console.error('❌ Firebase authentication is required. Please check your connection and try again.');
            return;
        }
        
        if (window.__devLog) window.__devLog('✅ Firebase is available and initialized');

        // Initialize modules in order
        if (window.cryptoManager) {
            if (window.__devLog) window.__devLog('Crypto module initialized');
        }

        if (window.authManager) {
            if (window.__devLog) window.__devLog('Auth module initialized');
        }

        if (window.dashboardManager) {
            if (window.__devLog) window.__devLog('Dashboard module initialized');
        }

        if (window.appsManager) {
            if (window.__devLog) window.__devLog('Apps module initialized');
        }

        if (window.usersManager) {
            if (window.__devLog) window.__devLog('Users module initialized');
        }
        
        if (window.__devLog) window.__devLog('LIBER/APPS initialized successfully');

        // Listen for admin force reload broadcast
        try{
            if (window.firebaseService && window.firebaseService.db && typeof firebase.onSnapshot === 'function'){
                const bRef = firebase.doc(window.firebaseService.db, 'admin', 'broadcast');
                firebase.onSnapshot(bRef, (snap)=>{
                    try{
                        const d = snap.exists()? snap.data():null;
                        if (d && d.action === 'forceReload' && window.dashboardManager && typeof window.dashboardManager.forceHardReload === 'function'){
                            window.dashboardManager.forceHardReload();
                        }
                    }catch(_){ }
                });
            }
        }catch(_){ }
    }

    /**
     * Check if all required modules are ready
     */
    areModulesReady() {
        return window.cryptoManager && 
               window.authManager && 
               window.dashboardManager && 
               window.appsManager && 
               window.usersManager;
    }

    /**
     * Setup global event listeners
     */
    setupGlobalEventListeners() {
        // Handle window resize
        window.addEventListener('resize', this.debounce(() => {
            this.handleResize();
        }, 250));

        // Handle visibility change (tab switching)
        document.addEventListener('visibilitychange', () => {
            this.handleVisibilityChange();
        });

        // Handle beforeunload
        window.addEventListener('beforeunload', (e) => {
            this.handleBeforeUnload(e);
        });

        // Handle keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            this.handleGlobalKeyboardShortcuts(e);
        });

        // Handle clicks outside modals
        document.addEventListener('click', (e) => {
            this.handleOutsideClick(e);
        });

        // Handle form submissions
        document.addEventListener('submit', (e) => {
            this.handleFormSubmission(e);
        });

        // Mobile: periodically clean up stray overlays that block scroll/touch
        try{
            const cleanup = ()=>{
                const overlays = Array.from(document.querySelectorAll('.modal-overlay, .reset-modal, .firebase-error-overlay'));
                // Remove fully transparent or zero-sized overlays
                overlays.forEach(el=>{
                    try{
                        const cs = window.getComputedStyle(el);
                        const hidden = cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity||'1') === 0;
                        const rect = el.getBoundingClientRect();
                        const zero = (rect.width === 0 && rect.height === 0);
                        if (hidden || zero){ el.remove(); }
                    }catch(_){ }
                });
                // Ensure only the top-most overlay captures events
                if (overlays.length > 1){
                    overlays.slice(0, -1).forEach(el=>{ el.style.pointerEvents = 'none'; });
                    overlays[overlays.length-1].style.pointerEvents = '';
                }
            };
            // Run soon after load and on orientation changes
            setTimeout(cleanup, 300);
            window.addEventListener('orientationchange', ()=> setTimeout(cleanup, 250));
            window.addEventListener('app-resize', cleanup);
        }catch(_){ }
    }

    /**
     * Handle window resize
     */
    handleResize() {
        // Trigger resize events for responsive components
        window.dispatchEvent(new CustomEvent('app-resize'));
    }

    /**
     * Handle visibility change
     */
    handleVisibilityChange() {
        if (document.hidden) {
            // Page is hidden (user switched tabs)
            if (window.__devLog) window.__devLog('Page hidden');
        } else {
            // Page is visible again
            if (window.__devLog) window.__devLog('Page visible');
            // Refresh data if needed
            if (window.dashboardManager) {
                window.dashboardManager.loadOverview();
            }
        }
    }

    /**
     * Handle before unload
     */
    handleBeforeUnload(e) {
        // Save any unsaved data
        if (window.dashboardManager) {
            window.dashboardManager.saveSettings();
        }
    }

    /**
     * Handle global keyboard shortcuts
     */
    handleGlobalKeyboardShortcuts(e) {
        // Only handle shortcuts when not in input fields
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        // Escape key to close modals
        if (e.key === 'Escape') {
            const modals = document.querySelectorAll('.modal-overlay');
            if (modals.length > 0) {
                modals[modals.length - 1].remove();
            }
        }

        // Ctrl/Cmd + K for search
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            const searchInput = document.getElementById('app-search');
            if (searchInput) {
                searchInput.focus();
            }
        }

        // Ctrl/Cmd + L for logout
        if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
            e.preventDefault();
            if (window.authManager) {
                window.authManager.logout();
            }
        }
    }

    /**
     * Handle clicks outside modals
     */
    handleOutsideClick(e) {
        // Close modals when clicking outside
        if (e.target.classList.contains('modal-overlay')) {
            e.target.remove();
        }
    }

    /**
     * Handle form submissions
     */
    handleFormSubmission(e) {
        // Add loading states to forms
        const form = e.target;
        const submitBtn = form.querySelector('button[type="submit"]');
        
        if (submitBtn) {
            submitBtn.classList.add('loading');
            submitBtn.disabled = true;
            
            // Remove loading state after form processing
            setTimeout(() => {
                submitBtn.classList.remove('loading');
                submitBtn.disabled = false;
            }, 2000);
        }
    }

    /**
     * Show loading screen
     */
    showLoadingScreen() {
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen) {
            loadingScreen.classList.remove('hidden');
        }
    }

    /**
     * Hide loading screen
     */
    hideLoadingScreen() {
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen) {
            loadingScreen.classList.add('hidden');
            // Remove from DOM after animation
            setTimeout(() => {
                if (loadingScreen.parentNode) {
                    loadingScreen.remove();
                }
            }, 500);
        }
    }

    /**
     * Show error message
     */
    showError(message) {
        console.error(message);
        
        // Create error notification
        const notification = document.createElement('div');
        notification.className = 'notification notification-error';
        notification.innerHTML = `
            <div class="notification-content">
                <i class="fas fa-exclamation-circle"></i>
                <span>${message}</span>
            </div>
            <button class="notification-close">&times;</button>
        `;

        // Add styles
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--error-color);
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

        // Auto remove after 10 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 10000);
    }

    /**
     * Debounce function
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Get application version
     */
    getVersion() {
        return '1.0.0';
    }

    /**
     * Get application info
     */
    getAppInfo() {
        return {
            name: 'LIBER/APPS',
            version: this.getVersion(),
            description: 'A modern control panel for managing and launching applications',
            author: 'Liber Apps Team',
            initialized: this.isInitialized
        };
    }

    /**
     * Reload application
     */
    reload() {
        window.location.reload();
    }

    /**
     * Clear all data
     */
    clearAllData() {
        if (confirm('Are you sure you want to clear all data? This action cannot be undone.')) {
            localStorage.clear();
            sessionStorage.clear();
            this.reload();
        }
    }
}

// Create global application instance
window.liberApps = new LiberAppsControlPanel();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LiberAppsControlPanel;
}

// Add some additional CSS for missing elements
const additionalStyles = `
    .users-table-container {
        overflow-x: auto;
        border-radius: var(--border-radius);
        border: 1px solid var(--border-color);
    }

    .users-table {
        width: 100%;
        border-collapse: collapse;
        background: var(--secondary-bg);
    }

    .users-table th,
    .users-table td {
        padding: 12px 16px;
        text-align: left;
        border-bottom: 1px solid var(--border-color);
    }

    .users-table th {
        background: var(--tertiary-bg);
        font-weight: 600;
        color: var(--primary-text);
        position: sticky;
        top: 0;
        z-index: 10;
    }

    .users-table tr:hover {
        background: var(--tertiary-bg);
    }

    .user-info-cell {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .current-user-badge {
        background: var(--accent-color);
        color: var(--primary-bg);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 600;
    }

    .role-badge {
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
    }

    .role-admin {
        background: var(--accent-color);
        color: var(--primary-bg);
    }

    .role-user {
        background: var(--tertiary-bg);
        color: var(--secondary-text);
        border: 1px solid var(--border-color);
    }

    .user-actions {
        display: flex;
        gap: 8px;
    }

    .btn-sm {
        padding: 6px 12px;
        font-size: 12px;
    }

    .delete-confirmation {
        text-align: center;
        padding: 20px;
    }

    .delete-confirmation i {
        font-size: 3rem;
        margin-bottom: 16px;
    }

    .delete-confirmation h4 {
        margin-bottom: 12px;
        color: var(--primary-text);
    }

    .delete-confirmation p {
        color: var(--secondary-text);
        line-height: 1.6;
    }

    .app-info-details {
        padding: 20px 0;
    }

    .app-info-header {
        display: flex;
        align-items: center;
        gap: 20px;
        margin-bottom: 24px;
        padding-bottom: 20px;
        border-bottom: 1px solid var(--border-color);
    }

    .app-icon.large {
        width: 80px;
        height: 80px;
        font-size: 40px;
    }

    .app-info-text h4 {
        font-size: 1.5rem;
        margin-bottom: 8px;
        color: var(--primary-text);
    }

    .app-version {
        color: var(--accent-color);
        font-weight: 600;
        margin-bottom: 4px;
    }

    .app-author {
        color: var(--secondary-text);
        font-size: 0.9rem;
    }

    .app-description-full h5 {
        margin-bottom: 12px;
        color: var(--primary-text);
    }

    .app-description-full p {
        color: var(--secondary-text);
        line-height: 1.6;
        margin-bottom: 24px;
    }

    .app-details {
        display: grid;
        gap: 12px;
    }

    .detail-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px solid var(--border-color);
    }

    .detail-item:last-child {
        border-bottom: none;
    }

    .detail-label {
        font-weight: 600;
        color: var(--primary-text);
    }

    .detail-value {
        color: var(--secondary-text);
    }

    .modal-actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        margin-top: 24px;
        padding-top: 20px;
        border-top: 1px solid var(--border-color);
    }

    .notification {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: 400px;
        animation: slideIn 0.3s ease-out;
    }

    .notification-content {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
    }

    .notification-close {
        background: none;
        border: none;
        color: inherit;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        transition: var(--transition);
    }

    .notification-close:hover {
        background: rgba(255, 255, 255, 0.1);
    }
`;

// Inject additional styles
const styleSheet = document.createElement('style');
styleSheet.textContent = additionalStyles;
document.head.appendChild(styleSheet);

// Add Firebase error handling function
window.showFirebaseError = function() {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.9);
        color: white;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        text-align: center;
        padding: 20px;
    `;
    errorDiv.innerHTML = `
        <h1 style="color: #ff4444; margin-bottom: 20px;">❌ Firebase Required</h1>
        <p style="font-size: 18px; margin-bottom: 15px;">This application requires Firebase to function.</p>
        <p style="margin-bottom: 20px;">Please check:</p>
        <ul style="text-align: left; margin-bottom: 20px;">
            <li>Your internet connection</li>
            <li>Firebase configuration in your Gist</li>
            <li>Firebase Console settings</li>
        </ul>
        <button onclick="location.reload()" style="
            background: #007bff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
        ">Retry</button>
    `;
    document.body.appendChild(errorDiv);
};
