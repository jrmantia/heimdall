// Rev: 2026-11-06-preserve-paused-state-on-scrub-release-v30
const CACHE_NAME = 'heimdall-pwa-v30';
const META_CACHE_URL = new URL('./__heimdall_meta__.json', self.location).pathname;
const PRECACHE_URLS = [
  './remote.html',
  './drop.html',
  './manifest-remote.json',
  './manifest-guest.json',
  './heimdall_icon_192.png',
  './heimdall_icon_512.png',
  './heimdall_badge.png',
  './heimdall_emblem_circle.png',
  './heimdall_icon.png'
];

let activeBackendOrigin = null;
let savedMetaState = {};

function isStaticCloudHost() {
  const h = ((self.location && self.location.hostname) || '').toLowerCase();
  return (
    h.endsWith('.github.io') ||
    h.endsWith('.pages.dev') ||
    h.endsWith('.netlify.app') ||
    h.endsWith('.vercel.app') ||
    h.endsWith('.surge.sh')
  );
}

function isValidHeimdallResponse(res) {
  if (!res || !res.ok) return false;
  if (isStaticCloudHost()) return true;
  const h = res.headers && res.headers.get('x-heimdall-server');
  return h === '1';
}

async function persistMetaToCache(patch) {
  if (!patch || typeof patch !== 'object') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const existingRes = (await cache.match(META_CACHE_URL)) || (await cache.match('/__heimdall_meta__.json'));
    let prev = {};
    if (existingRes) {
      try { prev = await existingRes.json(); } catch (_) {}
    }
    savedMetaState = Object.assign({}, prev, savedMetaState, patch, { updatedAt: Date.now() });
    if (savedMetaState.origin && typeof savedMetaState.origin === 'string' && savedMetaState.origin.startsWith('http')) {
      activeBackendOrigin = savedMetaState.origin.replace(/\/+$/, '');
    }
    const bodyStr = JSON.stringify(savedMetaState);
    await cache.put(
      META_CACHE_URL,
      new Response(bodyStr, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      })
    );
    if (META_CACHE_URL !== '/__heimdall_meta__.json') {
      await cache.put(
        '/__heimdall_meta__.json',
        new Response(bodyStr, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        })
      );
    }
  } catch (_) {}
}

self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SET_ACTIVE_ORIGIN' || data.type === 'SET_AUTH_TOKEN') {
    if (typeof data.origin === 'string' && data.origin.startsWith('http')) {
      activeBackendOrigin = data.origin.replace(/\/+$/, '');
    }
    persistMetaToCache({
      origin: activeBackendOrigin || data.origin || '',
      lanIp: data.lanIp || savedMetaState.lanIp || '',
      port: data.port || savedMetaState.port || 4848,
      publicHttpsUrl: data.publicHttpsUrl || savedMetaState.publicHttpsUrl || '',
      authToken: data.authToken || savedMetaState.authToken || '',
      rendezvousTopic: data.rendezvousTopic || savedMetaState.rendezvousTopic || '',
      mdnsHost: data.mdnsHost || savedMetaState.mdnsHost || ''
    });
  }
});

self.addEventListener('install', (event) => {
  const bust = Date.now();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_URLS.map((relUrl) => {
          const fullPath = new URL(relUrl, self.location).pathname;
          return fetch(fullPath + '?_cb=' + bust, { cache: 'reload' }).then((res) => {
            if (isValidHeimdallResponse(res) || (res && res.ok && fullPath.endsWith('.png'))) {
              return cache.put(fullPath, res);
            }
          });
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      // Preserve saved /__heimdall_meta__.json across Service Worker cache version upgrades
      try {
        const destCache = await caches.open(CACHE_NAME);
        const alreadyHasMeta = (await destCache.match(META_CACHE_URL)) || (await destCache.match('/__heimdall_meta__.json'));
        if (!alreadyHasMeta) {
          for (const k of keys) {
            if (k === CACHE_NAME || k.startsWith('heimdall-thumb')) continue;
            const oldCache = await caches.open(k);
            const oldMeta = (await oldCache.match(META_CACHE_URL)) || (await oldCache.match('/__heimdall_meta__.json'));
            if (oldMeta) {
              await destCache.put(META_CACHE_URL, oldMeta.clone());
              if (META_CACHE_URL !== '/__heimdall_meta__.json') {
                await destCache.put('/__heimdall_meta__.json', oldMeta.clone());
              }
              break;
            }
          }
        }
      } catch (_) {}
      await Promise.all(
        keys.map((k) => (k !== CACHE_NAME && k !== 'heimdall-thumb-blobs-v2' ? caches.delete(k) : Promise.resolve()))
      );
    }).then(() => self.clients.claim()).then(async () => {
      try {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientList) {
          try { client.postMessage({ type: 'SW_UPDATED', cacheName: CACHE_NAME }); } catch (_) {}
          if (client && typeof client.navigate === 'function' && client.url) {
            try { await client.navigate(client.url); } catch (_) {}
          }
        }
      } catch (_) {}
    })
  );
});

function fetchWithTimeout(requestOrUrl, timeoutMs, initOpts) {
  return new Promise((resolve, reject) => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (controller) {
        try { controller.abort(); } catch (_) {}
      }
      reject(new Error('sw-fetch-timeout'));
    }, timeoutMs);

    const opts = Object.assign({}, initOpts || {}, controller ? { signal: controller.signal } : {});
    fetch(requestOrUrl, opts)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function hydrateSavedMetaState() {
  if (savedMetaState && savedMetaState.updatedAt) return savedMetaState;
  try {
    const cache = await caches.open(CACHE_NAME);
    const existingRes = (await cache.match(META_CACHE_URL)) || (await cache.match('/__heimdall_meta__.json'));
    if (existingRes) {
      const prev = await existingRes.json();
      if (prev && typeof prev === 'object') {
        savedMetaState = Object.assign({}, prev, savedMetaState);
        if (!activeBackendOrigin && typeof savedMetaState.origin === 'string' && savedMetaState.origin.startsWith('http')) {
          activeBackendOrigin = savedMetaState.origin.replace(/\/+$/, '');
        }
      }
    }
  } catch (_) {}
  return savedMetaState;
}

async function fetchHeimdallAppShell(req, canonicalPath) {
  await hydrateSavedMetaState();
  try {
    const bustUrl = canonicalPath + (canonicalPath.includes('?') ? '&' : '?') + '_cb=' + Date.now();
    const primaryRes = await fetchWithTimeout(bustUrl, 3500, { cache: 'reload' });
    if (isValidHeimdallResponse(primaryRes)) {
      return primaryRes;
    }
  } catch (_) {}

  if (!isStaticCloudHost() && activeBackendOrigin && activeBackendOrigin !== self.location.origin) {
    try {
      const headers = savedMetaState && savedMetaState.authToken
        ? { 'X-Heimdall-Token': savedMetaState.authToken }
        : {};
      const fallbackRes = await fetchWithTimeout(activeBackendOrigin + canonicalPath, 1200, {
        mode: 'cors',
        cache: 'no-store',
        headers
      });
      if (isValidHeimdallResponse(fallbackRes)) {
        return fallbackRes;
      }
    } catch (_) {}
  }
  throw new Error('heimdall-shell-unreachable');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  const pathname = url.pathname;
  if (url.origin !== self.location.origin) return;

  if (pathname === META_CACHE_URL || pathname.endsWith('/__heimdall_meta__.json')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const matched = (await cache.match(META_CACHE_URL)) || (await cache.match('/__heimdall_meta__.json'));
        if (matched) return matched;
        return new Response(JSON.stringify(savedMetaState || {}), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      })
    );
    return;
  }

  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/thumbs/') ||
    pathname.includes('/thumbs/') ||
    pathname.startsWith('/video/') ||
    pathname.startsWith('/loop/') ||
    pathname.startsWith('/ws') ||
    pathname.endsWith('/beacon.json')
  ) {
    return;
  }

  const isDropNav = pathname.endsWith('/drop') || pathname.endsWith('/drop.html');
  const isRemoteNav = pathname.endsWith('/remote') || pathname.endsWith('/remote.html');
  const isAppShell = req.mode === 'navigate' || isRemoteNav || isDropNav;

  if (isAppShell) {
    const canonicalPath = new URL(isDropNav ? './drop.html' : './remote.html', self.location).pathname;
    event.respondWith(
      fetchHeimdallAppShell(req, canonicalPath)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(canonicalPath, copy);
          }).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          const fallbackRel = isDropNav ? './drop.html' : './remote.html';
          const fallbackAbs = isDropNav ? '/drop.html' : '/remote.html';
          const matched =
            (await cache.match(canonicalPath, { ignoreSearch: true })) ||
            (await cache.match(req, { ignoreSearch: true })) ||
            (await cache.match(new URL(fallbackRel, self.location).pathname, { ignoreSearch: true })) ||
            (await cache.match(fallbackAbs, { ignoreSearch: true }));
          if (matched) return matched;
          return fetch(req);
        })
    );
    return;
  }

  if (
    pathname.includes('manifest-') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg')
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const networkPromise = fetchWithTimeout(req, 2500, { cache: 'no-cache' })
          .then((res) => {
            if (isValidHeimdallResponse(res) || (res && res.ok)) {
              cache.put(pathname, res.clone()).catch(() => {});
              return res;
            }
            return null;
          })
          .catch(() => null);
        const fresh = await networkPromise;
        if (fresh) return fresh;
        const cached = await cache.match(pathname, { ignoreSearch: true });
        return cached || new Response('', { status: 404 });
      })
    );
  }
});



