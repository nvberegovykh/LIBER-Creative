/**
 * Authentication Module for Liber Apps Control Panel
 * Handles user authentication, registration, and session management
 */

class AuthManager {
    constructor() {
        this.currentUser = null;
        this._sessionGeneration = 0;
        this._sessionHydration = null;
        this._loginPending = false;
        // Persist session for a very long period to "remember device"
        this.sessionTimeout = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years
        this.init();
    }

    async init() {
        try {
            // R158: restore local identity only as a cache.  It is never cloud-auth
            // authority until Firebase's first auth-state callback confirms the UID.
            this._cachedLocalUser = null;
            try {
                const raw = localStorage.getItem('liber_current_user');
                if (raw) {
                    const u = JSON.parse(raw);
                    if (u && (u.id || u.uid)) this._cachedLocalUser = { id: u.id || u.uid, uid: u.uid || u.id, username: u.username, email: u.email, role: u.role || 'user' };
                }
                if (!this._cachedLocalUser) {
                    const sess = localStorage.getItem('liber_session');
                    if (sess) {
                        const parsed = JSON.parse(sess);
                        const user = parsed?.user;
                        if (user && (user.id || user.uid)) this._cachedLocalUser = { id: user.id || user.uid, uid: user.uid || user.id, username: user.username, email: user.email, role: user.role || 'user' };
                    }
                }
            } catch (_) {}
            this.currentUser = null;
            await this.waitForCryptoManager();
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Check URL actions (verification, password reset)
            this.checkUrlActions();
            
            // Debug Gist configuration
            if (window.__devLog) window.__devLog('=== Auto-debugging Gist configuration ===');
            await window.secureKeyManager.debugGistConfig();
            
            // Wait for Firebase to be available
            let attempts = 0;
            const maxAttempts = 150; // 15 seconds for Firebase service bootstrap
            
            while ((!window.firebaseService || !window.firebaseService.isInitialized) && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            
            if (!window.firebaseService || !window.firebaseService.isInitialized) {
                console.error('Firebase service did not initialize; protected LIBER session remains closed.');
                if (this.shouldOpenPublicShareView()) this.showPublicSharedContentView();
                else this.showAuthScreen();
                return;
            }

            let firebaseUser = null;
            try {
                firebaseUser = (typeof window.firebaseService.waitForAuthState === 'function')
                    ? await window.firebaseService.waitForAuthState(15000)
                    : await window.firebaseService.getCurrentUser();
            } catch (error) {
                console.error('Firebase auth-state prerequisite failed:', error?.message || error);
                if (this.shouldOpenPublicShareView()) this.showPublicSharedContentView();
                else this.showAuthScreen();
                return;
            }

            // Clean any legacy local users and disable auto test creation
            try { localStorage.removeItem('liber_users'); } catch {}

            await this.onFirebaseUserChanged(firebaseUser);
            
        } catch (error) {
            console.error('Auth initialization error:', error);
        }
    }

    shouldOpenPublicShareView(){
        try{
            const params = new URLSearchParams(window.location.search || '');
            const open = String(params.get('open') || '').trim().toLowerCase();
            if (open === 'post' || open === 'wave') return true;
            // PWA share-target payload can be handled without login too.
            if (String(params.get('share_target') || '').trim() === '1') return true;
            const hash = String(window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
            if (/^post[-_:]/.test(hash)) return true;
            return false;
        }catch(_){ return false; }
    }

    applyPublicShareReadOnlyUi(){
        try{
            document.body.classList.add('liber-public-share-mode');
            const hide = (sel)=> document.querySelectorAll(sel).forEach((el)=>{ el.style.display = 'none'; });
            hide('#logout-btn,#space-logout-btn,#switch-accounts-btn,#account-switcher,#add-account-btn');
            hide('.nav-btn[data-section="space"],.nav-btn[data-section="profile"],.nav-btn[data-section="users"],.nav-btn[data-section="settings"]');
            hide('.mobile-nav-btn[data-section="space"],.mobile-nav-btn[data-section="profile"],.mobile-nav-btn[data-section="users"],.mobile-nav-btn[data-section="settings"]');
            hide('#dashboard-chat-btn');

            // Keep guest mode read-only: disable create/upload/edit actions.
            document.querySelectorAll('#space-section input,#space-section textarea,#space-section button,#profile-section input,#profile-section textarea,#profile-section button').forEach((el)=>{
                el.setAttribute('disabled', 'disabled');
            });
            document.querySelectorAll('#wave-upload-btn,#video-upload-btn,#picture-upload-btn,#mobile-wave-upload-btn,#wave-subnav-studio-btn,.edit-wave-btn,.edit-visual-btn,.remove-btn,.remove-visual-btn').forEach((el)=>{
                el.style.display = 'none';
            });
        }catch(_){ }
    }

    showPublicSharedContentView(){
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        this.applyPublicShareReadOnlyUi();
        if (window.dashboardManager) {
            window.dashboardManager.init();
        }
    }

    /**
     * Debug user storage and show current state
     */
    async debugUserStorage() {
        if (window.__devLog) window.__devLog('=== Debugging User Storage ===');
        
        // First check raw storage
        this.checkRawStorage();
        
        try {
            // Check current users in encrypted storage
            const users = await this.getUsers();
            if (window.__devLog) window.__devLog('Users in encrypted storage:', users.length);
            if (window.__devLog) window.__devLog('All users:', users);
            
            // Check legacy storage with proper error handling
            let legacyUsers = [];
            try {
                const legacyData = localStorage.getItem('liber_users');
                if (legacyData) {
                    // Check if it's valid JSON
                    if (legacyData.startsWith('[') || legacyData.startsWith('{')) {
                        legacyUsers = JSON.parse(legacyData);
                    } else {
                        if (window.__devLog) window.__devLog('Legacy data is not JSON (likely encrypted):', legacyData.substring(0, 20) + '...');
                    }
                }
            } catch (parseError) {
                if (window.__devLog) window.__devLog('Legacy data parsing failed (likely encrypted data):', parseError.message);
            }
            
            if (window.__devLog) window.__devLog('Users in legacy storage:', legacyUsers.length);
            if (window.__devLog) window.__devLog('Legacy users:', legacyUsers);
            
            // Check if we need to migrate
            if (legacyUsers.length > 0 && users.length === 0) {
                if (window.__devLog) window.__devLog('Found legacy users, attempting migration...');
                await this.saveUsers(legacyUsers);
                localStorage.removeItem('liber_users');
                if (window.__devLog) window.__devLog('Migration completed');
            }
            
            // Show current state after migration
            const finalUsers = await this.getUsers();
            if (window.__devLog) window.__devLog('Final user count:', finalUsers.length);
            
        } catch (error) {
            console.error('Debug error:', error);
        }
    }

    /**
     * Wait for cryptoManager to be initialized
     */
    async waitForCryptoManager() {
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds max wait
        
        while (!window.cryptoManager && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        if (!window.cryptoManager) {
            console.error('CryptoManager not available after waiting');
            throw new Error('CryptoManager initialization failed');
        }
    }

    // Secure admin credentials - derived from Google Drive keys
    async getAdminCredentials() {
        return await window.secureKeyManager.getAdminCredentials();
    }

    async generateAdminHash(password) {
        return await window.secureKeyManager.generateAdminHash(password);
    }

    async getMasterKey() {
        return await window.secureKeyManager.getSystemKey();
    }

    getDefaultLanguageForCountry(countryCode) {
        const c = String(countryCode || '').trim().toUpperCase();
        const map = {
            US: 'en', GB: 'en',
            DE: 'de', FR: 'fr', ES: 'es', IT: 'it', PT: 'pt', NL: 'nl', PL: 'pl',
            UA: 'uk', RU: 'ru', TR: 'tr',
            IN: 'hi', AE: 'ar',
            JP: 'ja', KR: 'ko', CN: 'zh',
            BR: 'pt', MX: 'es'
        };
        return map[c] || 'en';
    }

    setupEventListeners() {
        // Login form
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.handleLogin();
            });
        }

        // Register form
        const registerForm = document.getElementById('registerForm');
        if (registerForm) {
            registerForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.handleRegister();
            });
        }

        // Password reset form
        const resetForm = document.getElementById('resetForm');
        if (resetForm) {
            resetForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.handlePasswordReset();
            });
        }

        // Resend verification form
        const resendVerificationForm = document.getElementById('resendVerificationForm');
        if (resendVerificationForm) {
            resendVerificationForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.handleResendVerification();
            });
        }

        // Tab switching
        const tabBtns = document.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });

        // Password visibility toggles
        const toggleCheckboxes = document.querySelectorAll('.password-toggle-checkbox');
        toggleCheckboxes.forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                this.togglePasswordVisibility(checkbox);
            });
        });
        
        // Setup mobile WALL-E toggle for initial load
        this.setupMobileWallEToggle();

        const registerCountry = document.getElementById('registerCountry');
        const registerLanguage = document.getElementById('registerLanguage');
        if (registerCountry && registerLanguage) {
            const preferredCountry = String(localStorage.getItem('liber_preferred_country') || '').trim().toUpperCase();
            const preferredLanguage = String(localStorage.getItem('liber_preferred_language') || '').trim().toLowerCase();
            if (preferredCountry) registerCountry.value = preferredCountry;
            if (preferredLanguage) registerLanguage.value = preferredLanguage;
            else if (registerCountry.value) registerLanguage.value = this.getDefaultLanguageForCountry(registerCountry.value);
            registerCountry.addEventListener('change', () => {
                registerLanguage.value = this.getDefaultLanguageForCountry(registerCountry.value);
            });
        }
    }

    switchTab(tabName) {
        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        const activeTabBtn = document.querySelector(`[data-tab="${tabName}"]`);
        if (activeTabBtn) {
            activeTabBtn.classList.add('active');
        }

        // Update active form
        document.querySelectorAll('.auth-form').forEach(form => {
            form.classList.remove('active');
        });
        
        const activeForm = document.getElementById(`${tabName}Form`);
        if (activeForm) {
            activeForm.classList.add('active');
        }
    }

    togglePasswordVisibility(checkbox) {
        const inputId = checkbox.id.replace('Toggle', '');
        const input = document.getElementById(inputId);
        const label = checkbox.parentElement;
        const icon = label.querySelector('i');
        const text = label.querySelector('span');
        
        if (checkbox.checked) {
            input.type = 'text';
            icon.className = 'fas fa-eye';
            text.textContent = 'Password visible';
        } else {
            input.type = 'password';
            icon.className = 'fas fa-eye-slash';
            text.textContent = 'Password invisible';
        }
    }

    /**
     * Handle user login
     */
    authFailureMessage(error) {
        const code = String(error?.code || '');
        if (['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password', 'auth/user-not-found'].includes(code)) {
            return 'Email/password sign-in was not accepted. Check your details or use the sign-in method you registered with.';
        }
        if (code === 'auth/invalid-email') return 'Please enter a valid email address.';
        if (code === 'auth/network-request-failed') return 'Could not reach the sign-in service. Check your connection and try again.';
        if (code === 'auth/too-many-requests') return 'Sign-in is temporarily limited. Please wait and try again.';
        if (code === 'auth/user-disabled') return 'This account has been disabled. Contact LIBER support.';
        if (['auth/operation-not-allowed', 'auth/unauthorized-domain', 'auth/invalid-api-key', 'auth/app-not-authorized', 'auth/configuration-not-found'].includes(code)) {
            return 'The sign-in service is not configured correctly. Contact LIBER support.';
        }
        if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(code)) return 'Sign-in was cancelled. Please try again when ready.';
        if (code === 'auth/popup-blocked') return 'Your browser blocked the sign-in window. Allow the popup and try again.';
        return 'Sign-in could not be completed. Please try again; this does not necessarily mean your password is wrong.';
    }

    async handleLogin() {
        const email = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;

        if (!email || !password) {
            this.showMessage('Please enter both email and password', 'error');
            return;
        }

        if (this._loginPending) return;
        if (!this.isValidEmail(email)) return this.showMessage('Please enter a valid email address', 'error');
        this._loginPending = true;
        try {
            const service = window.firebaseService;
            if (!service) throw new Error('Authentication service is unavailable.');
            await service.waitForInit();
            // Firebase Auth alone validates credentials. Do not query private
            // account records or implement browser-side password/lockout checks.
            let firebaseUser;
            try {
                firebaseUser = await service.signInUser(email, password);
            } catch (error) {
                this.showMessage(this.authFailureMessage(error), 'error');
                return;
            }
            // Auth callbacks and explicit sign-in share one profile/session owner.
            await this.onFirebaseUserChanged(firebaseUser);
        } catch (error) {
            console.error('Authentication service unavailable:', error?.code || error?.message);
            this.showMessage('Authentication service is unavailable. Please try again.', 'error');
        } finally {
            this._loginPending = false;
        }
    }

    /**
     * Handle registration with resend verification option
     */
    async handleRegister() {
        const username = document.getElementById('registerUsername').value.trim();
        const email = document.getElementById('registerEmail').value.trim();
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerConfirmPassword').value;
        const country = String(document.getElementById('registerCountry')?.value || '').trim().toUpperCase();
        const language = String(document.getElementById('registerLanguage')?.value || '').trim().toLowerCase() || this.getDefaultLanguageForCountry(country);

        if (!username || !email || !password || !confirmPassword) {
            this.showMessage('All fields are required', 'error');
            return;
        }
        if (!country) {
            this.showMessage('Please select your country', 'error');
            return;
        }

        if (password !== confirmPassword) {
            this.showMessage('Passwords do not match', 'error');
            return;
        }

        if (password.length < 8) {
            this.showMessage('Password must be at least 8 characters long', 'error');
            return;
        }

        if (!this.isValidEmail(email)) {
            this.showMessage('Please enter a valid email address', 'error');
            return;
        }

        try {
            // Wait for Firebase to be fully initialized
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds
            
            while ((!window.firebaseService || !window.firebaseService.isInitialized) && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            // Firebase registration is REQUIRED
            if (window.firebaseService && window.firebaseService.isInitialized) {
                try {
                    if (window.__devLog) window.__devLog('Attempting Firebase registration...');
                    
                    // Check if user already exists in Firebase
                    const existingMethods = await window.firebaseService.auth.fetchSignInMethodsForEmail(email);
                    if (existingMethods.length > 0) {
                        this.showMessage('An account with this email already exists', 'error');
                        return;
                    }
                    
                    // Create user in Firebase
                    const userData = {
                        username: username,
                        email: email,
                        country,
                        language,
                        role: 'user',
                        isVerified: false,
                        status: 'pending',
                        createdAt: new Date().toISOString()
                    };
                    
                    const firebaseUser = await window.firebaseService.createUser(email, password, userData);
                    
                    if (firebaseUser) {
                        try{
                            localStorage.setItem('liber_preferred_country', country);
                            localStorage.setItem('liber_preferred_language', language);
                            localStorage.setItem('liber_chat_translate_target', language);
                        }catch(_){ }
                        // Send verification email via Firebase
                        await window.firebaseService.sendEmailVerification();
                        
                        this.showMessage('Registration successful! Please check your email to verify your account. The letter may appear in your spam folder.', 'success');
                        
                        // Clear form
                        document.getElementById('registerForm').reset();
                        
                        // Switch to login tab
                        this.switchTab('login');
                        return;
                    }
                } catch (firebaseError) {
                    console.error('Firebase registration failed:', firebaseError);
                    const code = firebaseError?.code || '';
                    const message = firebaseError?.message || '';
                    
                    // Handle specific Firebase errors
                    if (code === 'auth/email-already-in-use') {
                        this.showMessage('An account with this email already exists', 'error');
                    } else if (code === 'auth/weak-password') {
                        this.showMessage('Password is too weak. Please choose a stronger password.', 'error');
                    } else if (code === 'auth/invalid-email') {
                        this.showMessage('Please enter a valid email address', 'error');
                    } else if (code === 'auth/operation-not-allowed') {
                        this.showMessage('Email/Password sign-up is disabled in Firebase Console. Enable it under Authentication → Sign-in method.', 'error');
                    } else if (code === 'auth/network-request-failed') {
                        this.showMessage('Network error while contacting Firebase. Please check your connection and try again.', 'error');
                    } else if (code === 'auth/unauthorized-domain') {
                        this.showMessage('Unauthorized domain for Firebase Auth. Add your domain to Firebase Authentication → Settings → Authorized domains.', 'error');
                    } else if (code === 'auth/invalid-api-key') {
                        this.showMessage('Invalid Firebase API key. Please verify Gist configuration matches Firebase Console.', 'error');
                    } else {
                        this.showMessage(`Registration failed: ${message || 'Unknown error'}`, 'error');
                    }
                    return;
                }
            } else {
                console.error('Firebase not available - registration requires Firebase. No fallback.');
                this.showMessage('Registration service not available. Please contact support.', 'error');
                return;
            }

        } catch (error) {
            console.error('Registration error:', error);
            this.showMessage('Registration failed. Please try again.', 'error');
        }
    }

    // Google Sign-In for login screen
    async googleSignIn(){
        try{
            if (!(window.firebaseService && window.firebaseService.isInitialized)){
                return this.showMessage('Auth not ready', 'error');
            }
            const provider = new firebase.GoogleAuthProvider();
            const result = await firebase.signInWithPopup(window.firebaseService.auth, provider);
            const user = result.user;
            if (user){
                await this.onFirebaseUserChanged(user);
            }
        }catch(e){
            console.error('Google sign-in failed', e);
            this.showMessage(this.authFailureMessage(e), 'error');
        }
    }

    /**
     * Link Google account to current user (My Profile)
     */
    async linkGoogleAccount(){
        try{
            if (!(window.firebaseService && window.firebaseService.isInitialized)){
                return this.showMessage('Auth not ready', 'error');
            }
            const auth = window.firebaseService.auth;
            const user = auth.currentUser;
            if (!user){ return this.showMessage('Please login first', 'error'); }
            const provider = new firebase.GoogleAuthProvider();
            await firebase.linkWithPopup(user, provider);
            this.showMessage('Google account linked', 'success');
        }catch(e){
            const code = e?.code||'';
            if (code === 'auth/credential-already-in-use'){
                this.showMessage('This Google account is already linked to another user.', 'error');
            }else{
                this.showMessage('Failed to link Google account', 'error');
            }
        }
    }

    /**
     * Resend verification email for existing unverified user
     */
    async resendVerificationEmail(user) {
        try {
            // Generate new verification token
            const newToken = window.emailService.generateVerificationToken();
            
            // Update user with new token
            const users = await this.getUsers();
            const updatedUser = users.find(u => u.id === user.id);
            if (updatedUser) {
                updatedUser.verificationToken = newToken;
                updatedUser.verificationTokenCreated = Date.now();
                
                const updatedUsers = users.map(u => u.id === user.id ? updatedUser : u);
                await this.saveUsers(updatedUsers);
                
                // Send new verification email
                await window.emailService.sendVerificationEmail(user.email, user.username, newToken);
                this.showMessage(`Verification email resent to ${user.email}. The letter may appear in your spam folder.`, 'success');
            }
        } catch (error) {
            console.error('Failed to resend verification email:', error);
            this.showMessage('Failed to resend verification email. Please try again.', 'error');
        }
    }

    /**
     * Handle password reset request
     */
    async handlePasswordReset() {
        const email = document.getElementById('resetEmail').value.trim();

        if (!email) {
            this.showMessage('Please enter your email address', 'error');
            return;
        }

        if (!this.isValidEmail(email)) {
            this.showMessage('Please enter a valid email address', 'error');
            return;
        }

        try {
            if (window.__devLog) window.__devLog('Password reset requested for email:', email);
            
            // Wait for Firebase to be fully initialized
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds
            
            while ((!window.firebaseService || !window.firebaseService.isInitialized) && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            
            // Use Firebase password reset if available
            if (window.firebaseService && window.firebaseService.isInitialized) {
                if (window.__devLog) window.__devLog('Using Firebase password reset...');
                await window.firebaseService.sendPasswordResetEmail(email);
                this.showMessage('Password reset link sent to your email. Please check your inbox. The letter may appear in your spam folder.', 'success');
            } else {
                console.error('Firebase not available - password reset requires Firebase. No fallback.');
                this.showMessage('Password reset service not available. Please contact support.', 'error');
                return;
            }
            
            // Clear form
            document.getElementById('resetEmail').value = '';

        } catch (error) {
            console.error('Password reset error:', error);
            
            // Handle specific Firebase errors
            if (error.code === 'auth/user-not-found') {
                this.showMessage('No account found with this email address', 'error');
            } else if (error.code === 'auth/invalid-email') {
                this.showMessage('Please enter a valid email address', 'error');
            } else {
                this.showMessage('Failed to send reset email. Please try again.', 'error');
            }
        }
    }

    /**
     * Handle resend verification request
     */
    async handleResendVerification() {
        const email = document.getElementById('resendVerificationEmail').value.trim();

        if (!email) {
            this.showMessage('Please enter your email address', 'error');
            return;
        }

        if (!this.isValidEmail(email)) {
            this.showMessage('Please enter a valid email address', 'error');
            return;
        }

        try {
            if (window.__devLog) window.__devLog('Resend verification requested for email:', email);
            
            // Wait for Firebase to be fully initialized
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds
            
            while ((!window.firebaseService || !window.firebaseService.isInitialized) && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            
            // Use Firebase resend verification if available
            if (window.firebaseService && window.firebaseService.isInitialized) {
                if (window.__devLog) window.__devLog('Using Firebase resend verification...');
                
                // First, try to sign in the user to get the current user object
                try {
                    // Check if user exists
                    const existingMethods = await window.firebaseService.auth.fetchSignInMethodsForEmail(email);
                    if (existingMethods.length === 0) {
                        this.showMessage('No account found with this email address', 'error');
                        return;
                    }
                    
                    // If current user matches email, send directly; else attempt link-based send
                    if (window.firebaseService && window.firebaseService.auth.currentUser && (window.firebaseService.auth.currentUser.email||'').toLowerCase()===email.toLowerCase()){
                        await window.firebaseService.sendEmailVerification();
                        this.showMessage('Verification email sent. Please check your inbox. The letter may appear in your spam folder.', 'success');
                        return;
                    }
                    // Fallback: ask user to login for verification mail (required by Firebase)
                    this.showMessage('Please login as this user, then click Resend verification again.', 'info');
                    this.switchTab('login');
                    return;
                    
                } catch (firebaseError) {
                    console.error('Firebase resend verification failed:', firebaseError.message);
                    this.showMessage('Failed to send verification email. Please try again.', 'error');
                    return;
                }
            } else {
                console.error('Firebase not available - resend verification requires Firebase. No fallback.');
                this.showMessage('Verification service not available. Please contact support.', 'error');
                return;
            }
            
            // Clear form
            document.getElementById('resendVerificationEmail').value = '';

        } catch (error) {
            console.error('Resend verification error:', error);
            this.showMessage('Failed to send verification email. Please try again.', 'error');
        }
    }

    /**
     * Handle password reset with token
     */
    async handlePasswordResetWithToken(token, email, newPassword, confirmPassword) {
        if (window.__devLog) window.__devLog('=== Password Reset Process ===');
        if (window.__devLog) window.__devLog('Email:', email);
        if (window.__devLog) window.__devLog('Token:', token);
        if (window.__devLog) window.__devLog('New password length:', newPassword.length);
        
        if (!newPassword || !confirmPassword) {
            this.showMessage('Please enter both password fields', 'error');
            return false;
        }

        if (newPassword !== confirmPassword) {
            this.showMessage('Passwords do not match', 'error');
            return false;
        }

        if (newPassword.length < 8) {
            this.showMessage('Password must be at least 8 characters long', 'error');
            return false;
        }

        try {
            // Use Firebase password reset if available
            if (window.firebaseService && window.firebaseService.isInitialized) {
                if (window.__devLog) window.__devLog('Using Firebase password reset...');
                
                if (window.__devLog) window.__devLog('Step 1: Verifying reset code...');
                // Verify the reset code with Firebase
                const verifiedEmail = await window.firebaseService.verifyPasswordResetCode(token);
                if (window.__devLog) window.__devLog('Reset code verified for email:', verifiedEmail);
                
                if (window.__devLog) window.__devLog('Step 2: Confirming password reset...');
                // Confirm the password reset
                await window.firebaseService.confirmPasswordReset(token, newPassword);
                if (window.__devLog) window.__devLog('Password reset confirmed successfully');
                
                this.showMessage('Password updated successfully! You can now login with your new password.', 'success');
                return true;
            } else {
                console.error('Firebase not available - password reset confirmation requires Firebase. No fallback.');
                this.showMessage('Password reset service not available. Please contact support.', 'error');
                return false;
            }

        } catch (error) {
            console.error('Password reset error:', error);
            this.showMessage(error.message || 'Password reset failed. Please try again.', 'error');
            return false;
        }
    }

    /**
     * Handle email verification
     */
    async handleEmailVerification(token, email) {
        try {
            if (window.firebaseService && window.firebaseService.isInitialized) {
                // Try applying as Firebase OOB code first
                try { await window.firebaseService.auth.applyActionCode(token); } catch (_) {}
                try { await window.firebaseService.auth.currentUser?.reload?.(); } catch(_){ }
                // Update Firestore flag best-effort
                try{
                    const u = window.firebaseService.auth.currentUser;
                    if (u){
                        const ref = window.firebase.doc(window.firebaseService.db,'users', u.uid);
                        await window.firebase.updateDoc(ref, { isVerified: true, updatedAt: new Date().toISOString() });
                    }
                }catch(_){ }
                this.showMessage('Email verified successfully! You can now login to your account.', 'success');
                return true;
            } else {
                this.showMessage('Email verification service not available. Please contact support.', 'error');
                return false;
            }
        } catch (error) {
            console.error('Email verification error:', error);
            this.showMessage(error.message || 'Email verification failed.', 'error');
            return false;
        }
    }

    /**
     * Check URL parameters for verification and reset actions
     */
    async checkUrlActions() {
        const urlParams = new URLSearchParams(window.location.search);
        const action = urlParams.get('action');
        const token = urlParams.get('token') || urlParams.get('oobCode');
        const email = urlParams.get('email') || urlParams.get('continueUrl') || '';

        if (token && (action === 'verify' || urlParams.get('mode') === 'verifyEmail')) {
            try{
                await this.handleEmailVerification(token, email);
            }catch(_){ }
            // Redirect to login with prefilled email
            const href = `${location.origin}${location.pathname}#login`;
            history.replaceState({}, document.title, href);
            setTimeout(()=>{
                const input = document.getElementById('loginUsername'); if (input) input.value = (typeof email==='string' ? email : '');
                this.switchTab('login');
            }, 50);
            return;
        }

        if (action && token && email) {
            if (window.__devLog) window.__devLog('=== URL Action Detected ===');
            if (window.__devLog) window.__devLog('Action:', action);
            if (window.__devLog) window.__devLog('Token:', token);
            if (window.__devLog) window.__devLog('Email:', email);
            
            // Check if we've already processed this verification
            const processedKey = `processed_${action}_${token}_${email}`;
            if (window.__devLog) window.__devLog('Processing key:', processedKey);
            if (window.__devLog) window.__devLog('Already processed:', sessionStorage.getItem(processedKey));
            
            if (sessionStorage.getItem(processedKey)) {
                if (window.__devLog) window.__devLog('Verification already processed, skipping...');
                // Clear URL parameters
                window.history.replaceState({}, document.title, window.location.pathname);
                return;
            }

            if (action === 'verify') {
                if (window.__devLog) window.__devLog('Starting email verification...');
                try {
                    await this.handleEmailVerification(token, email);
                    if (window.__devLog) window.__devLog('Email verification completed successfully');
                    // Mark as processed
                    sessionStorage.setItem(processedKey, 'true');
                    if (window.__devLog) window.__devLog('Marked as processed in session storage');
                } catch (error) {
                    console.error('Email verification failed:', error);
                    // Don't mark as processed if it failed
                }
            } else if (action === 'reset') {
                if (window.__devLog) window.__devLog('Starting password reset...');
                this.showPasswordResetForm(token, email);
                // Mark as processed
                sessionStorage.setItem(processedKey, 'true');
            }
            
            // Clear URL parameters
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    /**
     * Show password reset form
     */
    showPasswordResetForm(token, email) {
        // Create reset form modal
        const modal = document.createElement('div');
        modal.className = 'reset-modal';
        modal.innerHTML = `
            <div class="reset-modal-content">
                <h2>Reset Your Password</h2>
                <p>Please enter your new password below.</p>
                <form id="resetPasswordForm">
                    <div class="form-group">
                        <label for="newPassword">New Password</label>
                        <input type="password" id="newPassword" required minlength="8">
                    </div>
                    <div class="form-group">
                        <label for="confirmNewPassword">Confirm New Password</label>
                        <input type="password" id="confirmNewPassword" required minlength="8">
                    </div>
                    <button type="submit" class="btn-primary">Update Password</button>
                    <button type="button" class="btn-secondary" onclick="this.closest('.reset-modal').remove()">Cancel</button>
                </form>
            </div>
        `;

        document.body.appendChild(modal);

        // Handle form submission
        document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmNewPassword').value;
            
            const success = await this.handlePasswordResetWithToken(token, email, newPassword, confirmPassword);
            if (success) {
                modal.remove();
            }
        });
    }

    /**
     * Show password reset form (for "Forgot Password?" link)
     */
    showPasswordResetTab() {
        this.switchTab('reset');
    }

    /**
     * Show resend verification form (for "Resend Verification" link)
     */
    showResendVerificationTab() {
        this.switchTab('resendVerification');
    }

    /**
     * Generate unique user ID
     */
    generateUserId() {
        return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Validate email format
     */
    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    async login(username, password) {
        try {
            if (window.__devLog) window.__devLog('Attempting login for:', username);
            
            // Check admin credentials first
            const adminCreds = await this.getAdminCredentials();
            if (window.__devLog) window.__devLog('Admin credentials loaded:', !!adminCreds);
            
            if (username === adminCreds.username) {
                if (window.__devLog) window.__devLog('Admin login attempt');
                // Verify admin password using hash comparison
                const inputHash = await this.generateAdminHash(password);
                if (window.__devLog) window.__devLog('Admin hash comparison:', inputHash === adminCreds.passwordHash);
                
                if (inputHash === adminCreds.passwordHash) {
                    this.currentUser = { 
                        username: adminCreds.username,
                        email: adminCreds.email,
                        role: adminCreds.role
                    };
                    this.createSession();
                    if (window.__devLog) window.__devLog('Admin login successful');
                    return true;
                }
            }

            // Check regular users
            if (window.__devLog) window.__devLog('Checking regular users');
            const users = await this.getUsers();
            if (window.__devLog) window.__devLog('Users loaded:', users.length);
            
            const user = users.find(u => u.username === username || u.email === username);
            if (window.__devLog) window.__devLog('User found:', !!user);
            
            if (user) {
                // Check if user is verified (for email verification) or approved (for admin approval)
                if (!user.isVerified && user.status !== 'approved') {
                    if (window.__devLog) window.__devLog('User not verified or approved');
                    return false;
                }
                
                const hashedPassword = await window.cryptoManager.hashPassword(password);
                if (window.__devLog) window.__devLog('Password hash comparison:', user.passwordHash === hashedPassword);
                
                if (user.passwordHash === hashedPassword) {
                    this.currentUser = user;
                    this.createSession();
                    if (window.__devLog) window.__devLog('User login successful');
                    return true;
                }
            }

            if (window.__devLog) window.__devLog('Login failed - no matching credentials');
            return false;
        } catch (error) {
            console.error('Login error:', error);
            return false;
        }
    }

    async register(username, email, password) {
        try {
            const users = await this.getUsers();
            
            // Check if username or email already exists
            if (users.some(u => u.username === username || u.email === email)) {
                return false;
            }

            const hashedPassword = await window.cryptoManager.hashPassword(password);
            const newUser = {
                username,
                email,
                passwordHash: hashedPassword,
                role: 'user',
                status: 'pending', // Requires admin approval
                createdAt: new Date().toISOString(),
                approvedBy: null,
                approvedAt: null
            };

            users.push(newUser);
            await this.saveUsers(users);
            return true;
        } catch (error) {
            console.error('Registration error:', error);
            return false;
        }
    }

    async loadUsers() {
        try {
            if (window.__devLog) window.__devLog('=== loadUsers called ===');
            const masterKey = await this.getMasterKey();
            if (window.__devLog) window.__devLog('Master key obtained:', !!masterKey, 'Length:', masterKey ? masterKey.length : 0);
            
            const users = await window.cryptoManager.secureRetrieve('liber_users', masterKey);
            if (window.__devLog) window.__devLog('secureRetrieve result:', users);
            if (window.__devLog) window.__devLog('Users type:', typeof users);
            if (window.__devLog) window.__devLog('Users is array:', Array.isArray(users));
            
            const result = users || [];
            if (window.__devLog) window.__devLog('Final result:', result);
            if (window.__devLog) window.__devLog('Result length:', result.length);
            
            return result;
        } catch (error) {
            console.error('Error loading users:', error);
            return [];
        }
    }

    async getUsers() {
        // Firebase-only implementation - no local storage fallback
        if (window.firebaseService && window.firebaseService.isInitialized) {
            try {
                if (window.__devLog) window.__devLog('Loading users from Firebase...');
                const users = await window.firebaseService.getAllUsers();
                if (window.__devLog) window.__devLog('Firebase users loaded:', users.length);
                return users;
            } catch (error) {
                console.error('Failed to load users from Firebase:', error);
                // Return empty array instead of throwing error to prevent app crashes
                return [];
            }
        } else {
            if (window.__devWarn) window.__devWarn('⚠️ Firebase not available - getUsers requires Firebase. No fallback.');
            // Return empty array instead of throwing error to prevent app crashes
            return [];
        }
    }

    async saveUsers(users) {
        // Firebase-only implementation - no local storage fallback
        if (window.firebaseService && window.firebaseService.isInitialized) {
            try {
                if (window.__devLog) window.__devLog('=== saveUsers called (Firebase) ===');
                if (window.__devLog) window.__devLog('Users to save:', users);
                if (window.__devLog) window.__devLog('Users count:', users.length);
                
                // Note: Firebase doesn't have a bulk save method, so this is mainly for compatibility
                // Individual user operations should use Firebase methods directly
                if (window.__devLog) window.__devLog('Firebase users are managed individually, not bulk saved');
                return true;
            } catch (error) {
                console.error('Error with Firebase users:', error);
                return false;
            }
        } else {
            console.error('Firebase not available - saveUsers requires Firebase. No fallback.');
            return false;
        }
    }

    async addUser(userData) {
        // Firebase-only implementation - no local storage fallback
        if (window.firebaseService && window.firebaseService.isInitialized) {
            try {
                if (window.__devLog) window.__devLog('Adding user via Firebase...');
                // Note: User creation should use Firebase Auth directly
                // This method is mainly for compatibility
                if (window.__devLog) window.__devLog('User creation should use Firebase Auth methods directly');
                return true;
            } catch (error) {
                console.error('Error adding user via Firebase:', error);
                return false;
            }
        } else {
            console.error('Firebase not available - addUser requires Firebase. No fallback.');
            return false;
        }
    }

    async deleteUser(username) {
        // Firebase-only implementation - no local storage fallback
        if (window.firebaseService && window.firebaseService.isInitialized) {
            try {
                if (window.__devLog) window.__devLog('Deleting user via Firebase...');
                const users = await window.firebaseService.getAllUsers();
                const user = users.find(u => u.username === username || u.email === username);
                
                if (user) {
                    await window.firebaseService.deleteUser(user.id);
                    if (window.__devLog) window.__devLog(`User ${username} deleted successfully`);
                    return true;
                }
                return false;
            } catch (error) {
                console.error('Error deleting user via Firebase:', error);
                return false;
            }
        } else {
            console.error('Firebase not available - deleteUser requires Firebase. No fallback.');
            return false;
        }
    }

    async approveUser(username) {
        // Firebase-only implementation - no local storage fallback
        if (window.firebaseService && window.firebaseService.isInitialized) {
            try {
                if (window.__devLog) window.__devLog('Approving user via Firebase...');
                const users = await window.firebaseService.getAllUsers();
                const user = users.find(u => u.username === username || u.email === username);
                
                if (user) {
                    await window.firebaseService.updateUserData(user.id, {
                        status: 'approved',
                        approvedBy: this.currentUser?.username || 'admin',
                        approvedAt: new Date().toISOString()
                    });
                    if (window.__devLog) window.__devLog(`User ${username} approved successfully`);
                    return true;
                }
                return false;
            } catch (error) {
                console.error('Error approving user via Firebase:', error);
                return false;
            }
        } else {
            console.error('Firebase not available - approveUser requires Firebase. No fallback.');
            return false;
        }
    }

    async rejectUser(username) {
        // Firebase-only implementation - no local storage fallback
        if (window.firebaseService && window.firebaseService.isInitialized) {
            try {
                if (window.__devLog) window.__devLog('Rejecting user via Firebase...');
                const users = await window.firebaseService.getAllUsers();
                const user = users.find(u => u.username === username || u.email === username);
                
                if (user) {
                    await window.firebaseService.deleteUser(user.id);
                    if (window.__devLog) window.__devLog(`User ${username} rejected and deleted successfully`);
                    return true;
                }
                return false;
            } catch (error) {
                console.error('Error rejecting user via Firebase:', error);
                return false;
            }
        } else {
            console.error('Firebase not available - rejectUser requires Firebase. No fallback.');
            return false;
        }
    }

    createSession() {
        const uid = this.currentUser?.uid || this.currentUser?.id;
        if (!uid || window.firebaseService?.auth?.currentUser?.uid !== uid) return false;
        const session = {
            user: this.currentUser,
            createdAt: new Date().toISOString(),
            // Far future expiration to avoid unexpected sign-outs
            expiresAt: new Date(Date.now() + this.sessionTimeout).toISOString()
        };
        
        localStorage.setItem('liber_session', JSON.stringify(session));
        localStorage.setItem('liber_current_user', JSON.stringify(this.currentUser));
        
        // For Firebase users, set a derived password for app compatibility
        if (this.currentUser && this.currentUser.id) {
            // Use user ID as the "password" for app encryption
            localStorage.setItem('liber_user_password', this.currentUser.id);
        } else if (this.currentUser && this.currentUser.username) {
            // Fallback for non-Firebase users
            localStorage.setItem('liber_user_password', this.currentUser.username);
        }
        
        // Maintain a lightweight account switcher list (email/uid/username)
        try {
            const raw = localStorage.getItem('liber_accounts');
            const list = raw ? JSON.parse(raw) : [];
            const acct = {
                uid: this.currentUser.id || this.currentUser.uid || '',
                email: this.currentUser.email || '',
                username: this.currentUser.username || '',
                lastUsedAt: new Date().toISOString()
            };
            const dedup = list.filter(a => a.uid !== acct.uid);
            dedup.unshift(acct);
            localStorage.setItem('liber_accounts', JSON.stringify(dedup.slice(0, 10)));
        } catch (_) { /* ignore */ }
        
        // Update user info in dashboard
        this.updateUserInfo();
        return true;
    }

    async checkSession() {
        const service = window.firebaseService;
        if (!service) return;
        try {
            await service.waitForAuthState();
            return await this.onFirebaseUserChanged(service.auth.currentUser);
        } catch (error) {
            console.error('Session prerequisite unavailable:', error?.code || error?.message);
            this.showMessage('The sign-in service is unavailable. Please try again.', 'error');
        }
    }

    async logout() {
        this._sessionGeneration++;
        this._sessionHydration = null;
        this._signingOut = true;
        try {
            // Sign out from Firebase if available
            if (window.firebaseService && window.firebaseService.isInitialized) {
                await window.firebaseService.signOutUser();
                if (window.__devLog) window.__devLog('Firebase sign out successful');
            }
        } catch (error) {
            console.error('Firebase sign out error:', error);
        }
        this._signingOut = false;
        
        this.currentUser = null;
        localStorage.removeItem('liber_session');
        localStorage.removeItem('liber_current_user');
        localStorage.removeItem('liber_user_password'); // Clear stored password
        this.showAuthScreen();
    }

    showAuthScreen() {
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('dashboard').classList.add('hidden');
        // Login screen uses normal page scrolling.
        document.body.style.overflowY = 'auto';
        document.body.style.overflowX = 'hidden';
        
        // Restore mobile WALL-E toggle button if it was hidden
        const toggleBtn = document.getElementById('mobile-wall-e-toggle-btn');
        if (toggleBtn) {
            toggleBtn.style.display = '';
        }
        
        // Hide WALL-E widget on login screen (unless it was activated)
        const widget = document.querySelector('.chatgpt-widget');
        if (widget && sessionStorage.getItem('wallE_activated_on_login') !== 'true') {
            widget.style.display = 'none';
        }
        window.wallE?.reconcileAuthenticationVisibility?.();
        
        // One-time prefill email for switch-account flow.
        try{
            const email = sessionStorage.getItem('liber_switch_prefill_email') || localStorage.getItem('liber_prefill_email');
            if (email){
                const el = document.getElementById('loginUsername');
                if (el){ el.value = email; }
                // Email already known — drop cursor straight into password field.
                setTimeout(()=>{
                    try{
                        const passEl = document.getElementById('loginPassword');
                        if (passEl){ passEl.focus(); }
                    }catch(_){ }
                }, 50);
            }
            // Clear prefill after a short grace period to avoid leaking into unrelated forms.
            setTimeout(()=>{
                try{
                    sessionStorage.removeItem('liber_switch_prefill_email');
                    localStorage.removeItem('liber_prefill_email');
                }catch(_){ }
            }, 2000);
        }catch(_){ }

        // Setup mobile WALL-E toggle for login screen
        this.setupMobileWallEToggle();
    }

    showDashboard() {
        const uid = this.currentUser?.uid || this.currentUser?.id;
        if (!uid || window.firebaseService?.auth?.currentUser?.uid !== uid) return false;
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');
        // Lock page scroll and keep scrolling inside active dashboard sections.
        document.body.style.overflow = 'hidden';
        
        // Initialize dashboard
        if (window.dashboardManager) {
            window.dashboardManager.init();
        }
        window.wallE?.reconcileAuthenticationVisibility?.();
    }

    showMessage(message, type = 'info') {
        const messageDiv = document.createElement('div');
        messageDiv.className = `auth-message ${type}`;
        messageDiv.textContent = message;
        
        const authScreen = document.getElementById('auth-screen');
        authScreen.appendChild(messageDiv);
        
        setTimeout(() => {
            messageDiv.remove();
        }, 5000);
    }

    getCurrentUser() {
        return this.currentUser;
    }

    /**
     * Called by firebase-service onAuthStateChanged after any Firebase auth state change.
     * Rebuilds the app session in-place — no page reload needed.
     * One owner finalizes each Firebase UID/auth-state revision. Late profile
     * reads never resurrect a signed-out or replaced account.
     */
    async onFirebaseUserChanged(firebaseUser) {
        const service = window.firebaseService;
        const newUid = firebaseUser?.uid || '';
        if ((service?.auth?.currentUser?.uid || '') !== newUid) return null;
        if (!firebaseUser) {
            this._sessionGeneration++;
            this._sessionHydration = null;
            this.currentUser = null;
            this._cachedLocalUser = null;
            try { localStorage.removeItem('liber_session'); } catch (_) { }
            try { localStorage.removeItem('liber_current_user'); } catch (_) { }
            try { localStorage.removeItem('liber_user_password'); } catch (_) { }
            document.getElementById('auth-account-data-retry')?.remove();
            if (this.shouldOpenPublicShareView()) this.showPublicSharedContentView();
            else this.showAuthScreen();
            return null;
        }
        if (this._signingOut) return null;
        const revision = service._authStateRevision || 0;
        const previous = this._sessionHydration;
        if (previous?.uid === newUid && previous.revision === revision) return previous.promise;
        if (this.currentUser && (this.currentUser.uid || this.currentUser.id) !== newUid) {
            this.currentUser = null;
            this._cachedLocalUser = null;
            for (const key of ['liber_session', 'liber_current_user', 'liber_user_password']) {
                try { localStorage.removeItem(key); } catch (_) { }
            }
            this.showAuthScreen();
        }
        const generation = ++this._sessionGeneration;
        const isCurrent = () => !this._signingOut && this._sessionGeneration === generation &&
            window.firebaseService === service && service.auth?.currentUser?.uid === newUid &&
            (service._authStateRevision || 0) === revision;
        const hydration = { uid: newUid, revision, promise: null };
        this._sessionHydration = hydration;
        hydration.promise = (async () => {
            try {
                let data = await service.getUserData(newUid);
                if (!isCurrent()) return null;
                if (!data) {
                    await service.ensureUserDoc(newUid, {
                        email: firebaseUser.email || '', username: '',
                        isVerified: !!firebaseUser.emailVerified, status: 'approved'
                    });
                    if (!isCurrent()) return null;
                    data = await service.getUserData(newUid);
                    if (!isCurrent()) return null;
                }
                if (!data) throw new Error('Account profile is unavailable.');
                this.currentUser = {
                    id: newUid, uid: newUid,
                    username: data.username || firebaseUser.displayName || firebaseUser.email || '',
                    email: firebaseUser.email || '', role: data.role || 'user'
                };
                this._cachedLocalUser = this.currentUser;
                try {
                    const country = String(data.country || '').trim().toUpperCase();
                    const language = String(data.language || '').trim().toLowerCase();
                    if (country) localStorage.setItem('liber_preferred_country', country);
                    if (language) {
                        localStorage.setItem('liber_preferred_language', language);
                        localStorage.setItem('liber_chat_translate_target', language);
                    }
                } catch (_) { }
                if (!this.createSession()) return null;
                document.getElementById('auth-account-data-retry')?.remove();
                const authScreen = document.getElementById('auth-screen');
                if (authScreen && !authScreen.classList.contains('hidden')) this.showDashboard();
                else this.updateUserInfo();
                return this.currentUser;
            } catch (error) {
                if (!isCurrent()) return null;
                console.error('Authenticated account data unavailable:', error?.code || error?.message);
                this.currentUser = null;
                this.showAccountDataUnavailable(firebaseUser, generation);
                return null;
            }
        })();
        return hydration.promise;
    }

    showAccountDataUnavailable(firebaseUser, generation) {
        this.showAuthScreen();
        document.getElementById('auth-account-data-retry')?.remove();
        const message = document.createElement('div');
        message.id = 'auth-account-data-retry';
        message.className = 'auth-message error';
        message.setAttribute('role', 'status');
        message.textContent = 'You are signed in, but your LIBER account data is unavailable. Retry loading it; you do not need to sign in again. ';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry account loading';
        retry.addEventListener('click', () => {
            if (this._sessionGeneration !== generation || window.firebaseService?.auth?.currentUser?.uid !== firebaseUser.uid) return;
            this._sessionHydration = null;
            retry.disabled = true;
            void this.onFirebaseUserChanged(window.firebaseService.auth.currentUser);
        });
        message.appendChild(retry);
        document.getElementById('auth-screen')?.appendChild(message);
    }

    /**
     * Update user info in dashboard header
     */
    updateUserInfo() {
        const currentUserElement = document.getElementById('current-user');
        const userRoleElement = document.getElementById('user-role');
        
        if (currentUserElement && this.currentUser) {
            currentUserElement.textContent = this.currentUser.username || this.currentUser.email;
        }
        
        if (userRoleElement && this.currentUser) {
            userRoleElement.textContent = `(${this.currentUser.role})`;
        }
    }

    isAdmin() {
        return this.currentUser && this.currentUser.role === 'admin';
    }

    /**
     * Setup mobile WALL-E toggle for login screen
     */
    setupMobileWallEToggle() {
        if (window.__devLog) window.__devLog('setupMobileWallEToggle called');
        const toggleBtn = document.getElementById('mobile-wall-e-toggle-btn');
        if (window.__devLog) window.__devLog('Toggle button found:', !!toggleBtn);
        
        if (toggleBtn) {
            if (window.__devLog) window.__devLog('Setting up event listener for toggle button');
            // Remove any existing event listeners
            const newToggleBtn = toggleBtn.cloneNode(true);
            toggleBtn.parentNode.replaceChild(newToggleBtn, toggleBtn);
            
            newToggleBtn.addEventListener('click', async (e) => {
                if (window.__devLog) window.__devLog('WALL-E toggle button clicked!', e);
                
                // Check if widget is already active
                const widget = document.querySelector('.chatgpt-widget');
                const isWidgetActive = widget && widget.classList.contains('mobile-activated');
                
                if (isWidgetActive) {
                    // Widget is active, hide it
                    if (window.__devLog) window.__devLog('Hiding WALL-E widget...');
                    widget.classList.remove('mobile-activated');
                    sessionStorage.removeItem('wallE_activated_on_login');
                    window.wallE?.reconcileAuthenticationVisibility?.();
                    return;
                }
                
                // Widget is not active, show it
                if (window.__devLog) window.__devLog('Showing WALL-E widget...');
                
                // Wait for WALL-E widget to be initialized
                let attempts = 0;
                const maxAttempts = 30; // Increased attempts
                
                while ((!window.wallE || !document.querySelector('.chatgpt-widget')) && attempts < maxAttempts) {
                    if (window.__devLog) window.__devLog(`Waiting for WALL-E widget... attempt ${attempts + 1}`);
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
                    if (window.__devLog) window.__devLog('Forcing widget creation...');
                    window.wallE.createChatInterface();
                    widgetToShow = document.querySelector('.chatgpt-widget');
                }
                
                if (widgetToShow) {
                    if (window.__devLog) window.__devLog('WALL-E widget found, showing it...');
                    
                    // Use CSS class instead of inline styles for better compatibility
                    widgetToShow.classList.add('mobile-activated');
                    sessionStorage.setItem('wallE_activated_on_login', 'true');
                    window.wallE?.reconcileAuthenticationVisibility?.();
                    
                    // Expand the widget
                    if (window.wallE && typeof window.wallE.expandChat === 'function') {
                        if (window.__devLog) window.__devLog('Expanding WALL-E widget...');
                        window.wallE.expandChat();
                    }
                    
                    // Store state that WALL-E was activated on login screen
                    sessionStorage.setItem('wallE_activated_on_login', 'true');
                    
                    if (window.__devLog) window.__devLog('WALL-E widget successfully activated on login screen');
                } else {
                    console.error('WALL-E widget element not found even after creation attempt');
                }
            });
            
            if (window.__devLog) window.__devLog('Event listener attached successfully');
        } else {
            console.error('Mobile WALL-E toggle button not found in DOM');
        }
    }

    /**
     * Test function to debug user storage
     */
    async testUserStorage() {
        if (window.__devLog) window.__devLog('=== Testing User Storage ===');
        
        // Check current users
        const users = await this.getUsers();
        if (window.__devLog) window.__devLog('Current users:', users);
        
        // Check legacy storage (safely)
        let legacyUsers = [];
        try {
            const legacyData = localStorage.getItem('liber_users');
            if (legacyData && (legacyData.startsWith('[') || legacyData.startsWith('{'))) {
                legacyUsers = JSON.parse(legacyData);
            }
        } catch (error) {
            if (window.__devLog) window.__devLog('Legacy data parsing failed (likely encrypted):', error.message);
        }
        if (window.__devLog) window.__devLog('Legacy users:', legacyUsers);
        
        // Test saving a user
        const testUser = {
            id: 'test_user_' + Date.now(),
            username: 'testuser',
            email: 'test@example.com',
            passwordHash: 'test_hash',
            role: 'user',
            isVerified: false,
            createdAt: new Date().toISOString()
        };
        
        if (window.__devLog) window.__devLog('Testing save with user:', testUser);
        const saveResult = await this.saveUsers([testUser]);
        if (window.__devLog) window.__devLog('Save result:', saveResult);
        
        // Check if user was saved
        const savedUsers = await this.getUsers();
        if (window.__devLog) window.__devLog('Users after save:', savedUsers);
        
        return saveResult;
    }

    /**
     * Debug verification process
     */
    async debugVerification(email) {
        if (window.__devLog) window.__devLog('=== Debugging Verification for:', email, '===');
        
        try {
            const users = await this.getUsers();
            if (window.__devLog) window.__devLog('All users:', users);
            
            const user = users.find(u => u.email === email);
            if (window.__devLog) window.__devLog('User found:', user);
            
            if (user) {
                if (window.__devLog) window.__devLog('User verification status:', user.isVerified);
                if (window.__devLog) window.__devLog('User verification token:', user.verificationToken);
                if (window.__devLog) window.__devLog('Token created:', user.verificationTokenCreated);
                if (window.__devLog) window.__devLog('Token age (hours):', (Date.now() - user.verificationTokenCreated) / (60 * 60 * 1000));
            }
            
            // Test verification process
            if (user && user.verificationToken) {
                if (window.__devLog) window.__devLog('Testing verification with token:', user.verificationToken);
                try {
                    const verifiedUser = await window.emailService.verifyToken(user.verificationToken, email);
                    if (window.__devLog) window.__devLog('Verification successful:', verifiedUser);
                } catch (error) {
                    console.error('Verification failed:', error);
                }
            }
            
        } catch (error) {
            console.error('Debug error:', error);
        }
    }

    /**
     * Test function to manually create a user and verify storage
     */
    async testCreateUser() {
        if (window.__devLog) window.__devLog('=== Testing User Creation ===');
        
        try {
            const testUser = {
                id: 'test_user_' + Date.now(),
                username: 'testuser',
                email: 'test@example.com',
                passwordHash: 'test_hash_' + Date.now(),
                role: 'user',
                isVerified: false,
                status: 'pending',
                verificationToken: 'test_token_' + Date.now(),
                verificationTokenCreated: Date.now(),
                createdAt: new Date().toISOString()
            };
            
            if (window.__devLog) window.__devLog('Creating test user:', testUser);
            
            // Get current users
            const currentUsers = await this.getUsers();
            if (window.__devLog) window.__devLog('Current users before:', currentUsers.length);
            
            // Add test user
            currentUsers.push(testUser);
            
            // Save users
            const saveResult = await this.saveUsers(currentUsers);
            if (window.__devLog) window.__devLog('Save result:', saveResult);
            
            // Verify user was saved
            const savedUsers = await this.getUsers();
            if (window.__devLog) window.__devLog('Users after save:', savedUsers.length);
            if (window.__devLog) window.__devLog('Test user in storage:', savedUsers.find(u => u.id === testUser.id));
            
            return saveResult;
            
        } catch (error) {
            console.error('Test create user error:', error);
            return false;
        }
    }

    /**
     * Check and fix user verification status
     */
    async checkUserVerificationStatus(email) {
        if (window.__devLog) window.__devLog('=== Checking User Verification Status ===');
        if (window.__devLog) window.__devLog('Email:', email);
        
        try {
            const users = await this.getUsers();
            const user = users.find(u => u.email === email);
            
            if (user) {
                if (window.__devLog) window.__devLog('User found:', user);
                if (window.__devLog) window.__devLog('isVerified:', user.isVerified);
                if (window.__devLog) window.__devLog('status:', user.status);
                if (window.__devLog) window.__devLog('verificationToken:', user.verificationToken);
                
                // If user is verified but status is not approved, fix it
                if (user.isVerified && user.status !== 'approved') {
                    if (window.__devLog) window.__devLog('Fixing user status...');
                    user.status = 'approved';
                    const updatedUsers = users.map(u => u.email === email ? user : u);
                    await this.saveUsers(updatedUsers);
                    if (window.__devLog) window.__devLog('User status fixed to approved');
                }
                
                return user;
            } else {
                if (window.__devLog) window.__devLog('User not found');
                return null;
            }
        } catch (error) {
            console.error('Error checking user verification status:', error);
            return null;
        }
    }

    /**
     * Check raw storage data to see what's actually stored
     */
    checkRawStorage() {
        if (window.__devLog) window.__devLog('=== Checking Raw Storage Data ===');
        
        // Check all localStorage keys
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const value = localStorage.getItem(key);
            if (window.__devLog) window.__devLog(`Key: ${key}`);
            if (window.__devLog) window.__devLog(`Value (first 50 chars): ${value ? value.substring(0, 50) + '...' : 'null'}`);
            if (window.__devLog) window.__devLog(`Value length: ${value ? value.length : 0}`);
            if (window.__devLog) window.__devLog('---');
        }
    }
}

// Initialize auth manager
window.authManager = new AuthManager();

// Add global debug function for easy console access
window.debugUser = async function(email) {
    if (window.__devLog) window.__devLog('=== Quick User Debug ===');
    if (window.__devLog) window.__devLog('Email:', email);
    
    try {
        const users = await window.authManager.getUsers();
        const user = users.find(u => u.email === email);
        
        if (user) {
            if (window.__devLog) window.__devLog('✅ User found:', user);
            if (window.__devLog) window.__devLog('📧 Email:', user.email);
            if (window.__devLog) window.__devLog('👤 Username:', user.username);
            if (window.__devLog) window.__devLog('✅ Verified:', user.isVerified);
            if (window.__devLog) window.__devLog('📋 Status:', user.status);
            if (window.__devLog) window.__devLog('🔑 Token:', user.verificationToken);
            if (window.__devLog) window.__devLog('📅 Created:', user.createdAt);
            
            if (user.isVerified && user.status !== 'approved') {
                if (window.__devLog) window.__devLog('⚠️ User is verified but status is not approved - fixing...');
                user.status = 'approved';
                const updatedUsers = users.map(u => u.email === email ? user : u);
                await window.authManager.saveUsers(updatedUsers);
                if (window.__devLog) window.__devLog('✅ Status fixed to approved');
            }
            
            return user;
        } else {
            if (window.__devLog) window.__devLog('❌ User not found');
            return null;
        }
    } catch (error) {
        console.error('❌ Error:', error);
        return null;
    }
};

// Add manual verification function
window.manualVerify = async function(email) {
    if (window.__devLog) window.__devLog('=== Manual Verification ===');
    if (window.__devLog) window.__devLog('Email:', email);
    
    try {
        const users = await window.authManager.getUsers();
        const user = users.find(u => u.email === email);
        
        if (user) {
            if (window.__devLog) window.__devLog('✅ User found, manually verifying...');
            
            // Manually set verification status
            user.isVerified = true;
            user.status = 'approved';
            user.verificationToken = null;
            user.verificationTokenCreated = null;
            user.verifiedAt = new Date().toISOString();
            
            // Save the updated user
            const updatedUsers = users.map(u => u.email === email ? user : u);
            const saveResult = await window.authManager.saveUsers(updatedUsers);
            
            if (window.__devLog) window.__devLog('✅ Manual verification completed');
            if (window.__devLog) window.__devLog('Save result:', saveResult);
            if (window.__devLog) window.__devLog('Updated user:', user);
            
            return user;
        } else {
            if (window.__devLog) window.__devLog('❌ User not found');
            return null;
        }
    } catch (error) {
        console.error('❌ Manual verification error:', error);
        return null;
    }
};

// Add test verification function to test the actual verification process
window.testVerification = async function(email, token) {
    if (window.__devLog) window.__devLog('=== Testing Verification Process ===');
    if (window.__devLog) window.__devLog('Email:', email);
    if (window.__devLog) window.__devLog('Token:', token);
    
    try {
        // Test step 1: Get users
        if (window.__devLog) window.__devLog('Step 1: Getting users...');
        const users = await window.authManager.getUsers();
        if (window.__devLog) window.__devLog('Users loaded:', users.length);
        
        // Test step 2: Find user
        if (window.__devLog) window.__devLog('Step 2: Finding user...');
        const user = users.find(u => u.email === email && u.verificationToken === token);
        if (window.__devLog) window.__devLog('User found:', !!user);
        if (user) {
            if (window.__devLog) window.__devLog('User data:', user);
        }
        
        // Test step 3: Call email service verification
        if (window.__devLog) window.__devLog('Step 3: Calling email service verification...');
        const verifiedUser = await window.emailService.verifyToken(token, email);
        if (window.__devLog) window.__devLog('Verification result:', verifiedUser);
        
        // Test step 4: Check if user was actually saved
        if (window.__devLog) window.__devLog('Step 4: Checking if user was saved...');
        const updatedUsers = await window.authManager.getUsers();
        const savedUser = updatedUsers.find(u => u.email === email);
        if (window.__devLog) window.__devLog('Saved user:', savedUser);
        if (window.__devLog) window.__devLog('Is verified:', savedUser?.isVerified);
        if (window.__devLog) window.__devLog('Status:', savedUser?.status);
        
        return verifiedUser;
    } catch (error) {
        console.error('❌ Test verification error:', error);
        return null;
    }
};

// Add function to refresh admin panel and check user status
window.refreshAdminPanel = async function() {
    if (window.__devLog) window.__devLog('=== Refreshing Admin Panel ===');
    
    try {
        // Refresh users in admin panel
        if (window.usersManager) {
            await window.usersManager.loadUsers();
            if (window.__devLog) window.__devLog('Admin panel refreshed');
        } else {
            if (window.__devLog) window.__devLog('Users manager not available');
        }
        
        // Check current user status
        const users = await window.authManager.getUsers();
        const user = users.find(u => u.email === 'emelianen63@gmail.com');
        if (user) {
            if (window.__devLog) window.__devLog('Current user status:');
            if (window.__devLog) window.__devLog('- Email:', user.email);
            if (window.__devLog) window.__devLog('- Username:', user.username);
            if (window.__devLog) window.__devLog('- isVerified:', user.isVerified);
            if (window.__devLog) window.__devLog('- status:', user.status);
            if (window.__devLog) window.__devLog('- verificationToken:', user.verificationToken);
        }
        
    } catch (error) {
        console.error('Error refreshing admin panel:', error);
    }
};

// Add function to create a test user
window.createTestUser = async function() {
    if (window.__devLog) window.__devLog('=== Creating Test User ===');
    
    try {
        const testUser = {
            id: 'test_user_' + Date.now(),
            username: 'nvberegovykh',
            email: 'nvberegovykh@gmail.com',
            passwordHash: await window.cryptoManager.hashPassword('testpassword123'),
            role: 'user',
            isVerified: true,
            status: 'approved',
            createdAt: new Date().toISOString(),
            lastLogin: null
        };
        
        const users = await window.authManager.getUsers();
        users.push(testUser);
        
        const saveResult = await window.authManager.saveUsers(users);
        if (window.__devLog) window.__devLog('Test user created:', saveResult);
        if (window.__devLog) window.__devLog('Test user credentials:');
        if (window.__devLog) window.__devLog('- Username: nvberegovykh');
        if (window.__devLog) window.__devLog('- Email: nvberegovykh@gmail.com');
        if (window.__devLog) window.__devLog('- Password: testpassword123');
        
        return saveResult;
    } catch (error) {
        console.error('Error creating test user:', error);
        return false;
    }
};

// Add comprehensive migration function
window.migrateAllUsersToFirebase = async function() {
    if (window.__devLog) window.__devLog('=== Migrating All Users to Firebase ===');
    
    try {
        // Check if Firebase is available
        if (!window.firebaseService || !window.firebaseService.isInitialized) {
            console.error('Firebase not available - cannot migrate users');
            return false;
        }
        
        // Get existing users from local storage
        const localUsers = await window.authManager.getUsers();
        if (window.__devLog) window.__devLog('Found local users:', localUsers.length);
        
        if (localUsers.length === 0) {
            if (window.__devLog) window.__devLog('No local users to migrate');
            return true;
        }
        
        let migratedCount = 0;
        let failedCount = 0;
        
        for (const localUser of localUsers) {
            try {
                if (window.__devLog) window.__devLog(`Migrating user: ${localUser.email}`);
                
                // Check if user already exists in Firebase
                const existingMethods = await window.firebaseService.auth.fetchSignInMethodsForEmail(localUser.email);
                
                if (existingMethods.length > 0) {
                    if (window.__devLog) window.__devLog(`User ${localUser.email} already exists in Firebase`);
                    migratedCount++;
                    continue;
                }
                
                // Create user in Firebase with temporary password
                const tempPassword = 'TempPassword123!';
                const userData = {
                    username: localUser.username,
                    email: localUser.email,
                    role: localUser.role || 'user',
                    isVerified: localUser.isVerified || false,
                    status: localUser.status || 'pending',
                    createdAt: localUser.createdAt || new Date().toISOString(),
                    migratedFromLocalStorage: true,
                    needsPasswordReset: true
                };
                
                const firebaseUser = await window.firebaseService.createUser(localUser.email, tempPassword, userData);
                
                if (firebaseUser) {
                    if (window.__devLog) window.__devLog(`✅ Successfully migrated user: ${localUser.email}`);
                    migratedCount++;
                } else {
                    console.error(`❌ Failed to migrate user: ${localUser.email}`);
                    failedCount++;
                }
                
            } catch (error) {
                console.error(`❌ Error migrating user ${localUser.email}:`, error);
                failedCount++;
            }
        }
        
        if (window.__devLog) window.__devLog(`=== Migration Complete ===`);
        if (window.__devLog) window.__devLog(`✅ Successfully migrated: ${migratedCount} users`);
        if (window.__devLog) window.__devLog(`❌ Failed to migrate: ${failedCount} users`);
        
        if (migratedCount > 0) {
            if (window.__devLog) window.__devLog('📧 Sending password reset emails to migrated users...');
            await window.sendPasswordResetEmailsToMigratedUsers();
        }
        
        return migratedCount > 0;
        
    } catch (error) {
        console.error('Migration error:', error);
        return false;
    }
};

// Add function to send password reset emails to migrated users
window.sendPasswordResetEmailsToMigratedUsers = async function() {
    if (window.__devLog) window.__devLog('=== Sending Password Reset Emails to Migrated Users ===');
    
    try {
        if (!window.firebaseService || !window.firebaseService.isInitialized) {
            console.error('Firebase not available');
            return;
        }
        
        const firebaseUsers = await window.firebaseService.getAllUsers();
        const migratedUsers = firebaseUsers.filter(user => user.migratedFromLocalStorage && user.needsPasswordReset);
        
        if (window.__devLog) window.__devLog(`Found ${migratedUsers.length} migrated users needing password reset`);
        
        for (const user of migratedUsers) {
            try {
                await window.firebaseService.sendPasswordResetEmail(user.email);
                if (window.__devLog) window.__devLog(`✅ Password reset email sent to: ${user.email}`);
                
                // Mark as password reset sent
                await window.firebaseService.updateUserData(user.id, {
                    needsPasswordReset: false,
                    passwordResetSent: new Date().toISOString()
                });
                
            } catch (error) {
                console.error(`❌ Failed to send password reset to ${user.email}:`, error);
            }
        }
        
        if (window.__devLog) window.__devLog('✅ Password reset emails sent to migrated users');
        
    } catch (error) {
        console.error('Error sending password reset emails:', error);
    }
};
