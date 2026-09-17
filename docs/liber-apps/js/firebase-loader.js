// Dynamic Firebase SDK loader with an exact, current browser-module fallback.
// Every Firebase product in a window must come from the same SDK release.
(function liberFirebaseLoader(){

const FIREBASE_VERSIONS = [
	'12.17.1',
	'12.17.0'
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
		initializeApp,
		getApps,
		getApp
	} = appMod;

	const {
		getAuth,
		GoogleAuthProvider,
		signInWithPopup,
		linkWithPopup,
		reauthenticateWithPopup,
		signInWithRedirect,
		linkWithRedirect,
		reauthenticateWithRedirect,
		getRedirectResult,
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

	// Keep Firebase Functions on the SDK's native callable transport. It attaches the
	// active Firebase Auth context itself and avoids a second hand-built bearer path.
	const functionsFns = fnMod
		? (function(){ const { getFunctions, httpsCallable } = fnMod; return { getFunctions, httpsCallable }; })()
		: {};

	const messagingFns = msgMod ? (function(){ const { getMessaging, getToken, onMessage, isSupported } = msgMod; return { getMessaging, getToken, onMessage, isSupported }; })() : {};

	// Expose compat-style object expected by existing code
	window.firebase = {
		initializeApp,
		getApps,
		getApp,
		auth: getAuth,
		firestore: getFirestore,
		SDK_VERSION: version,
		// Auth
		createUserWithEmailAndPassword,
		GoogleAuthProvider,
		signInWithPopup,
		linkWithPopup,
		reauthenticateWithPopup,
		signInWithRedirect,
		linkWithRedirect,
		reauthenticateWithRedirect,
		getRedirectResult,
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
		getApps,
		getApp,
		getAuth,
		getFirestore,
		createUserWithEmailAndPassword,
		GoogleAuthProvider,
		signInWithPopup,
		linkWithPopup,
		reauthenticateWithPopup,
		signInWithRedirect,
		linkWithRedirect,
		reauthenticateWithRedirect,
		getRedirectResult,
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

	if (window.__liberFirebaseSdkPromise) return;
	window.__liberFirebaseSdkPromise = (async () => {
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
})();
