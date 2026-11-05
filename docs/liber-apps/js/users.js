/**
 * Users Module for Liber Apps Control Panel
 * Handles user management for admin users
 */

class UsersManager {
    constructor() {
        this.users = [];
        this.init();
    }

    init() {
        // Delay loading users until an authenticated admin is present to avoid UI alerts on refresh
        const tryLoad = async () => {
            try {
                if (window.firebaseService && window.firebaseService.isInitialized && window.authManager) {
                    const cu = window.firebaseService.auth.currentUser;
                    if (cu) {
                        // Admin authority is a verified Auth custom claim, never a
                        // mutable users/{uid}.role display field.
                        try {
                            const token = await cu.getIdTokenResult();
                            if (token?.claims?.liber_admin === true) {
                                await this.loadUsers();
                                return;
                            }
                        } catch (_) {}
                    }
                }
            } catch (_) {}
            // Retry shortly; avoid spamming errors
            setTimeout(tryLoad, 500);
        };
        tryLoad();
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleAddUser();
            });
        }

        // Search functionality
        const searchInput = document.getElementById('user-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.filterUsers(e.target.value.toLowerCase());
            });
        }
    }

    async loadUsers() {
        try {
            // Firebase is REQUIRED for user management
            // Wait for Firebase to be fully initialized
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds
            
            while ((!window.firebaseService || !window.firebaseService.isInitialized) && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            
            if (window.firebaseService && window.firebaseService.isInitialized) {
                try {
                    console.log('Loading users from Firebase...');
                    // Load all users across pages so admin sees full user base.
                    const all = [];
                    let cursor = null;
                    let hasMore = true;
                    while (hasMore) {
                        const result = await window.firebaseService.getUsersWithPagination(100, cursor);
                        all.push(...(result.users || []));
                        cursor = result.lastDoc || null;
                        hasMore = !!result.hasMore;
                    }
                    this.users = all;
                    console.log('Firebase users loaded:', this.users.length);
                    
                    // Update user statistics
                    this.updateUserStats();
                } catch (firebaseError) {
                    console.warn('Firebase users loading failed (suppressed on UI):', firebaseError.message);
                    return;
                }
            } else {
                console.warn('Firebase not available yet - delaying user list load.');
                this.users = []; // Ensure users array is empty if Firebase is not available
                return;
            }
                
            this.renderUsers();
            this.updateUserCount();
        } catch (error) {
            console.error('Error loading users:', error);
            this.showError('Failed to load users');
        }
    }

    /**
     * Update user statistics
     */
    async updateUserStats() {
        try {
            if (window.firebaseService && window.firebaseService.isInitialized) {
                const stats = await window.firebaseService.getUserStats();
                const statsElement = document.getElementById('users-count');
                if (statsElement) {
                    statsElement.textContent = `${stats.total} total (${stats.pending} pending)`;
                }
            }
        } catch (error) {
            console.error('Error updating user stats:', error);
        }
    }

    renderUsers() {
        const usersList = document.getElementById('users-list');
        if (!usersList) return;

        if (this.users.length === 0) {
            usersList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-users"></i>
                    <h3>No Users Found</h3>
                    <p>Add your first user to get started.</p>
                </div>
            `;
            return;
        }

        // Simplify: show all users; verification status only
        const allUsers = this.users || [];
        let html = '';
        html += `
            <div class="users-section">
                <h3>Users (${allUsers.length})</h3>
                <div class="users-grid">
                    ${allUsers.map(user => this.getUserCardHTML(user, false)).join('')}
                </div>
            </div>
        `;

        usersList.innerHTML = html;

        // Add event listeners to action buttons
        this.setupUserActionListeners();
    }

    getUserCardHTML(user, isPending) {
        const createdAt = new Date(user.createdAt).toLocaleDateString();
        
        // Status purely by verification
        let statusClass = user.isVerified ? 'approved' : 'pending';
        let statusText = user.isVerified ? 'Verified' : 'Unverified';
        
        const actionsHTML = `
            <button class="btn btn-danger btn-sm delete-btn" data-uid="${user.id || user.uid}">
                <i class="fas fa-trash"></i> Delete
            </button>
        `;

        return `
            <div class="user-card ${statusClass}">
                <div class="user-header">
                    <div class="user-avatar">
                        <i class="fas fa-user"></i>
                    </div>
                    <div class="user-info">
                        <h4>${user.username}</h4>
                        <p class="user-email">${user.email}</p>
                        <span class="user-status ${statusClass}">${statusText}</span>
                    </div>
                </div>
                <div class="user-details">
                    <div class="detail-item">
                        <span class="label">Role:</span>
                        <span class="value">
                            <select class="role-select" data-uid="${user.id || user.uid}">
                                <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
                                <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
                            </select>
                            <button class="btn btn-secondary btn-sm save-role-btn" data-uid="${user.id || user.uid}">Save</button>
                        </span>
                    </div>
                    <div class="detail-item">
                        <span class="label">Created:</span>
                        <span class="value">${createdAt}</span>
                    </div>
                    
                </div>
                <div class="user-actions">
                    ${actionsHTML}
                </div>
            </div>
        `;
    }

    setupUserActionListeners() {
        // Approve/Reject removed — verification handled elsewhere

        // Delete buttons
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uid = btn.dataset.uid;
                await this.deleteUser(uid);
            });
        });

        // Save role buttons
        document.querySelectorAll('.save-role-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uid = btn.dataset.uid;
                const select = document.querySelector(`.role-select[data-uid="${uid}"]`);
                if (!select) return;
                await this.updateUserRole(uid, select.value);
            });
        });
    }

    async handleAddUser() {
        const username = document.getElementById('new-username').value.trim();
        const email = document.getElementById('new-email').value.trim();
        const password = document.getElementById('new-password').value;
        const role = document.getElementById('new-role').value;

        if (!username || !email || !password) {
            this.showError('Please fill in all required fields');
            return;
        }

        if (password.length < 8) {
            this.showError('Password must be at least 8 characters long');
            return;
        }

        try {
            const hashedPassword = await window.cryptoManager.hashPassword(password);
            const newUser = {
                username,
                email,
                passwordHash: hashedPassword,
                role,
                status: 'approved', // Admin-created users are auto-approved
                createdAt: new Date().toISOString(),
                approvedBy: window.authManager.getCurrentUser().username,
                approvedAt: new Date().toISOString()
            };

            const success = await window.authManager.addUser(newUser);
            if (success) {
                this.showSuccess('User added successfully');
                document.getElementById('add-user-form').reset();
                await this.loadUsers();
            } else {
                this.showError('Failed to add user. Username or email may already exist.');
            }
        } catch (error) {
            console.error('Error adding user:', error);
            this.showError('Failed to add user');
        }
    }

    async approveUser(uid) {
        if (!confirm(`Are you sure you want to approve this user?`)) {
            return;
        }

        try {
            if (window.firebaseService && window.firebaseService.isFirebaseAvailable()) {
                await window.firebaseService.approveUser(uid);
                this.showSuccess('User approved successfully');
                await this.loadUsers();
            } else {
                this.showError('Firebase service not available');
            }
        } catch (error) {
            console.error('Error approving user:', error);
            this.showError('Failed to approve user');
        }
    }

    async updateUserRole(uid, role) {
        try {
            if (window.firebaseService && window.firebaseService.isFirebaseAvailable()) {
                const enabled = role === 'admin';
                const result = await window.firebaseService.callFunction('adminSetLiberAdmin', {
                    schema: 'liber.admin.set-liber-admin-request.v1',
                    targetUid: uid,
                    enabled
                });
                if (!result?.ok) throw new Error('Admin role update was not confirmed.');
                // The server owns the claim. Refresh when changing the current
                // account so subsequent rule checks see the new authority.
                if (uid === window.firebaseService.auth?.currentUser?.uid && result.requiresTokenRefresh) {
                    await window.firebaseService.auth.currentUser.getIdToken(true);
                }
                this.showSuccess('Admin access updated');
                await this.loadUsers();
            } else {
                this.showError('Firebase service not available');
            }
        } catch (error) {
            console.error('Error updating user role:', error);
            this.showError('Failed to update role');
        }
    }

    async rejectUser(uid) {
        if (!confirm(`Are you sure you want to reject this user? This action cannot be undone.`)) {
            return;
        }

        try {
            if (window.firebaseService && window.firebaseService.isFirebaseAvailable()) {
                await window.firebaseService.rejectUser(uid);
                this.showSuccess('User rejected successfully');
                await this.loadUsers();
            } else {
                this.showError('Firebase service not available');
            }
        } catch (error) {
            console.error('Error rejecting user:', error);
            this.showError('Failed to reject user');
        }
    }

    async deleteUser(uid) {
        const currentUser = window.authManager.getCurrentUser();
        if (currentUser && (currentUser.id === uid || currentUser.uid === uid)) {
            this.showError('You cannot delete your own account');
            return;
        }

        if (!confirm(`Are you sure you want to delete this user? This action cannot be undone.`)) {
            return;
        }

        try {
            if (window.firebaseService && window.firebaseService.isFirebaseAvailable()) {
                await window.firebaseService.deleteUser(uid);
                this.showSuccess('User deleted successfully');
                await this.loadUsers();
            } else {
                this.showError('Firebase service not available');
            }
        } catch (error) {
            console.error('Error deleting user:', error);
            this.showError('Failed to delete user');
        }
    }

    async filterUsers(searchTerm) {
        if (!searchTerm || searchTerm.length < 2) {
            // If search term is too short, show all users
            await this.loadUsers();
            return;
        }
        // The shared searchUsers API is intentionally public-profile-only for
        // peer discovery. Admin user management filters its already-authorized
        // full list locally, so it never leaks email search into the browser's
        // public discovery path.
        this.filterUsersClientSide(searchTerm);
    }

    filterUsersClientSide(searchTerm) {
        const userCards = document.querySelectorAll('.user-card');
        userCards.forEach(card => {
            const username = card.querySelector('h4').textContent.toLowerCase();
            const email = card.querySelector('.user-email').textContent.toLowerCase();
            
            if (username.includes(searchTerm) || email.includes(searchTerm)) {
                card.style.display = 'block';
            } else {
                card.style.display = 'none';
            }
        });
    }

    updateUserCount() {
        const countElement = document.getElementById('users-count');
        if (countElement) {
            const totalUsers = this.users.length;
            const pendingUsers = this.users.filter(u => u.status === 'pending' || (!u.status && !u.isVerified)).length;
            countElement.textContent = `${totalUsers} total (${pendingUsers} pending)`;
        }
    }

    showSuccess(message) {
        if (window.dashboardManager) {
            window.dashboardManager.showSuccess(message);
        }
    }

    showError(message) {
        if (window.dashboardManager) {
            window.dashboardManager.showError(message);
        }
    }

    getUsers() {
        return this.users;
    }
}

// Create global instance
window.usersManager = new UsersManager();
