// Dynamic Firebase SDK loader with version fallback
// Attempts latest first, falls back if CDN path is unavailable

const FIREBASE_VERSIONS = [
	'12.1.0',
	'13.1.0'
];

async function loadFirebaseVersion(version) {
	const base = `https://www.gstatic.com/firebasejs/${version}`;

	const appMod = await import(`${base}/firebase-app.js`);
	const authMod = await import(`${base}/firebase-auth.js`);
	const fsMod = await import(`${base}/firebase-firestore.js`);
	const storageMod = await import(`${base}/firebase-storage.js`);
	let fnMod = null; try { fnMod = await import(`${base}/firebase-functions.js`); } catch(_) { fnMod = null; }
	let msgMod = null; try { msgMod = await import(`${base}/firebase-messaging.js`); } catch(_) { msgMod = null; }

	const {
		initializeApp
	} = appMod;

	const {
		getAuth,
		GoogleAuthProvider,
		signInWithPopup,
		linkWithPopup,
		signInWithCustomToken,
		createUserWithEmailAndPassword,
		signInWithEmailAndPassword,
		sendPasswordResetEmail,
		sendEmailVerification,
		onAuthStateChanged,
		fetchSignInMethodsForEmail,
		verifyPasswordResetCode,
		confirmPasswordReset,
		updatePassword,
		browserLocalPersistence,
		setPersistence,
		signOut,
		updateProfile,
		deleteUser,
		reauthenticateWithCredential,
		EmailAuthProvider
	} = authMod;

	const {
		getFirestore,
		enableIndexedDbPersistence,
		enableMultiTabIndexedDbPersistence,
		serverTimestamp,
		collection,
		doc,
		addDoc,
		setDoc,
		getDoc,
		getDocs,
		query,
		where,
		orderBy,
		enableNetwork,
		disableNetwork,
		updateDoc,
		increment,
		limit,
		startAfter,
		deleteDoc,
		onSnapshot,
		runTransaction
	} = fsMod;

	const {
		getStorage,
		ref,
		uploadBytes,
		uploadBytesResumable,
		getDownloadURL,
		deleteObject
	} = storageMod;
	const getBlob = typeof storageMod.getBlob === 'function' ? storageMod.getBlob : null;

	const functionsFns = fnMod
		? (function(){ const { getFunctions, httpsCallable } = fnMod; return { getFunctions, httpsCallable }; })()
		: {};

	// Firebase Functions callable normally forwards Auth automatically. In this app,
	// saveFcmToken/saveSwitchToken can run immediately after auth restoration and the
	// SDK occasionally reaches the endpoint without a usable bearer token, producing
	// a visible 401 on LIBER/APPS entry. For these two authenticated token-registration
	// calls only, use the callable wire protocol directly with a freshly issued ID token.
	if (functionsFns.httpsCallable) {
		const nativeHttpsCallable = functionsFns.httpsCallable;
		functionsFns.httpsCallable = function patchedHttpsCallable(functionsInstance, name, options) {
			if (name !== 'saveFcmToken' && name !== 'saveSwitchToken') {
				return nativeHttpsCallable(functionsInstance, name, options);
			}
			return async function authenticatedTokenCallable(data) {
				const service = window.firebaseService;
				const user = service?.auth?.currentUser || null;
				if (!user || typeof user.getIdToken !== 'function') return { data: null };

				const idToken = await user.getIdToken(true);
				const projectId = service?.app?.options?.projectId || 'liber-apps-cca20';
				let region = 'europe-west1';
				try {
					const match = Object.entries(service?.functionsByRegion || {})
						.find(([, instance]) => instance === functionsInstance);
					if (match?.[0]) region = match[0];
					else if (functionsInstance?._region) region = functionsInstance._region;
					else if (functionsInstance?.region) region = functionsInstance.region;
				} catch (_) {}

				const url = `https://${region}-${projectId}.cloudfunctions.net/${encodeURIComponent(name)}`;
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${idToken}`
					},
					body: JSON.stringify({ data: data ?? {} })
				});
				const json = await response.json().catch(() => ({}));
				if (!response.ok) {
					const error = new Error(json?.error?.message || json?.message || `HTTP ${response.status}`);
					error.code = json?.error?.status || `http/${response.status}`;
					throw error;
				}
				return { data: json?.result ?? json?.data ?? json ?? null };
			};
		};
	}

	const messagingFns = msgMod ? (function(){ const { getMessaging, getToken, onMessage, isSupported } = msgMod; return { getMessaging, getToken, onMessage, isSupported }; })() : {};

	// Expose compat-style object expected by existing code
	window.firebase = {
		initializeApp,
		auth: getAuth,
		firestore: getFirestore,
		SDK_VERSION: version,
		// Auth
		createUserWithEmailAndPassword,
		GoogleAuthProvider,
		signInWithPopup,
		linkWithPopup,
		signInWithCustomToken,
		signInWithEmailAndPassword,
		sendPasswordResetEmail,
		sendEmailVerification,
		onAuthStateChanged,
		fetchSignInMethodsForEmail,
		verifyPasswordResetCode,
		confirmPasswordReset,
		updatePassword,
		browserLocalPersistence,
		setPersistence,
		signOut,
		updateProfile,
		deleteUser,
		reauthenticateWithCredential,
		EmailAuthProvider,
		// Firestore
		collection,
		doc,
		addDoc,
		setDoc,
		getDoc,
		getDocs,
		query,
		where,
		orderBy,
		enableNetwork,
		disableNetwork,
		updateDoc,
		increment,
		limit,
		startAfter,
		deleteDoc,
		onSnapshot,
		runTransaction,
		enableIndexedDbPersistence,
		enableMultiTabIndexedDbPersistence,
		serverTimestamp,
		// Storage
		getStorage,
		ref,
		uploadBytes,
		uploadBytesResumable,
		getDownloadURL,
		getBlob: getBlob || (()=>{}),
		deleteObject
	};

	// Also expose modular functions directly
	window.firebaseModular = {
		initializeApp,
		getAuth,
		getFirestore,
		createUserWithEmailAndPassword,
		GoogleAuthProvider,
		signInWithPopup,
		linkWithPopup,
		signInWithCustomToken,
		signInWithEmailAndPassword,
		sendPasswordResetEmail,
		sendEmailVerification,
		onAuthStateChanged,
		fetchSignInMethodsForEmail,
		verifyPasswordResetCode,
		confirmPasswordReset,
		updatePassword,
		browserLocalPersistence,
		setPersistence,
		signOut,
		updateProfile,
		deleteUser,
		reauthenticateWithCredential,
		EmailAuthProvider,
		collection,
		doc,
		setDoc,
		getDoc,
		getDocs,
		query,
		where,
		orderBy,
		enableNetwork,
		disableNetwork,
		updateDoc,
		increment,
		limit,
		startAfter,
		deleteDoc,
		onSnapshot,
		runTransaction,
		enableIndexedDbPersistence,
		enableMultiTabIndexedDbPersistence,
		serverTimestamp,
		getStorage,
		ref,
		uploadBytes,
		uploadBytesResumable,
		getDownloadURL,
		deleteObject,
		// Functions (optional)
		...(functionsFns || {}),
		// Messaging (optional)
		...(messagingFns || {})
	};

	console.log(`✅ Firebase Modular SDK v${version} loaded successfully`);
	console.log('Available services: Auth, Firestore');
}

(async () => {
	let lastError = null;
	for (const v of FIREBASE_VERSIONS) {
		try {
			await loadFirebaseVersion(v);
			return; // success
		} catch (e) {
			lastError = e;
			console.warn(`⚠️ Failed to load Firebase SDK v${v}:`, e?.message || e);
		}
	}
	console.error('❌ All Firebase SDK versions failed to load');
	window.firebaseLoadError = lastError;
})();
