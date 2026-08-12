/* Service Worker for LIBER/APPS
 * - Shows notifications when the page posts a message to the SW
 * - Handles generic Push events if configured by a push service (FCM or other)
 * - Keeps REVEX core assets network-authoritative so mixed cached builds cannot execute together
 */

self.addEventListener('install', (event) => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		try {
			const names = await caches.keys();
			await Promise.all(names.map((name) => caches.delete(name)));
		} catch (_) {}
		await clients.claim();
	})());
});

/* REVEX is revision-sensitive: app/store/integrity/viewer/energy must come from one deployment.
 * Do not serve these from a stale browser/SW cache even when their historical ?v= token is old.
 */
self.addEventListener('fetch', (event) => {
	try {
		const request = event.request;
		if (!request || request.method !== 'GET') return;
		const url = new URL(request.url);
		if (url.origin !== self.location.origin) return;
		const isRevex = /\/liber-apps\/apps\/revex\//.test(url.pathname);
		const isCoreAsset = isRevex && (/\.(?:js|css|html|webmanifest)$/.test(url.pathname) || /\/revex-r39-runtime\.js$/.test(url.pathname));
		if (!isCoreAsset) return;
		event.respondWith((async () => {
			try {
				return await fetch(request, { cache: 'no-store' });
			} catch (error) {
				const cached = await caches.match(request);
				if (cached) return cached;
				throw error;
			}
		})());
	} catch (_) {}
});

let __activeCallCache = { title: '', body: '', at: 0 };

async function showNotification(data){
	const title = data.title || 'LIBER/APPS';
	const options = {
		body: data.body || '',
		icon: data.icon || '/images/LIBER LOGO.png',
		badge: data.badge || '/images/LIBER LOGO.png',
		data: data.data || {},
		silent: !!data.silent,
	};
	try { await self.registration.showNotification(title, options); } catch (_) {}
}

self.addEventListener('message', (event) => {
	const msg = event.data || {};
	if (msg && msg.type === 'notify') {
		showNotification(msg.payload || {});
	}
	if (msg && msg.type === 'call-state') {
		const p = msg.payload || {};
		const state = String(p.state || 'idle');
		if (state !== 'active') {
			__activeCallCache = { title: '', body: '', at: Date.now() };
			event.waitUntil((async ()=>{
				try{
					const list = await self.registration.getNotifications({ tag: 'active-call' });
					await Promise.all((list || []).map((n)=> { try { n.close(); } catch(_) {} return Promise.resolve(); }));
				}catch(_){}
			})());
			return;
		}
		const title = String(p.title || 'Call in progress');
		const body = String(p.body || 'Tap to return to call');
		const now = Date.now();
		if (__activeCallCache.title === title && __activeCallCache.body === body && (now - __activeCallCache.at) < 12000) return;
		__activeCallCache = { title, body, at: now };
		const connId = String(p.connId || '');
		const basePath = (self.location?.pathname || '').replace(/\/[^/]*$/, '') || '/liber-apps';
		const url = `${basePath}/apps/secure-chat/index.html${connId ? `?connId=${encodeURIComponent(connId)}` : ''}`;
		event.waitUntil(self.registration.showNotification(title, {
			body,
			tag: 'active-call',
			renotify: false,
			requireInteraction: true,
			silent: true,
			icon: '/images/LIBER LOGO.png',
			badge: '/images/LIBER LOGO.png',
			actions: [
				{ action: 'call_open', title: 'Open' },
				{ action: 'call_mute', title: 'Mute' },
				{ action: 'call_end', title: 'End' }
			],
			data: { type: 'active_call', connId, url }
		}));
	}
});

self.addEventListener('push', (event) => {
	let raw = {};
	try { raw = event.data ? event.data.json() : {}; } catch(_) {}
	const payload = {
		title: raw.notification?.title || raw.title || 'LIBER/APPS',
		body: raw.notification?.body || raw.body || '',
		icon: raw.notification?.icon || raw.icon,
		data: { ...(raw.data || {}), ...(raw.notification?.data || {}) },
		silent: raw.silent,
	};
	event.waitUntil(showNotification(payload));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const d = (event.notification && event.notification.data) || {};
	const action = String(event.action || '').trim();
	if (d.type === 'active_call' && (action === 'call_mute' || action === 'call_end')) {
		event.waitUntil((async () => {
			try{
				const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
				for (const client of allClients) {
					try{ client.postMessage({ type: 'liber-call-action', action, connId: d.connId || '' }); }catch(_){}
				}
			}catch(_){}
		})());
		return;
	}
	let targetUrl = d.url;
	const basePath = (self.location?.pathname || '').replace(/\/[^/]*$/, '') || '/liber-apps';
	if (!targetUrl && d.type === 'chat_message' && d.connId) {
		targetUrl = `${basePath}/apps/secure-chat/index.html?connId=${encodeURIComponent(String(d.connId))}`;
	}
	targetUrl = targetUrl || `${basePath}/index.html`;
	const fullUrl = targetUrl.startsWith('http') ? targetUrl : (self.location.origin || '') + (targetUrl.startsWith('/') ? targetUrl : '/' + targetUrl);
	event.waitUntil((async () => {
		const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
		for (const client of allClients) {
			try { await client.navigate(fullUrl); return client.focus(); }
			catch(_) { return client.focus(); }
		}
		if (clients.openWindow) return clients.openWindow(fullUrl);
	})());
});

self.addEventListener('message', (event) => {
	const msg = event.data || {};
	if (msg && msg.type === 'force-reload') {
		event.waitUntil((async () => {
			try {
				const names = await caches.keys();
				await Promise.all(names.map((n) => caches.delete(n)));
			} catch (_) {}
			const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
			list.forEach((c) => c.postMessage && c.postMessage({ type: 'force-reload-done' }));
		})());
	}
});