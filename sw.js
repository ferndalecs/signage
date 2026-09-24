// Service worker: keeps a copy of the player's own files, so a sign can still open the
// player after a reboot while the network (or GitHub) is down.
// Network first, so signs always get the latest code when online; the saved copy is used
// only if the network fails or takes longer than 3 s. Google Sheets and Slides requests
// are never touched.
// Every GitHub Pages site on an account shares one origin, so only touch caches named signage-*.

const CACHE = 'signage-shell';
const SHELL = ['./', './player.css', './player.js', './lib.js', './config.js'];
const ROOT = new URL('./', self.location).href;
const SHELL_URLS = SHELL.map((path) => new URL(path, self.location).href);
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  // skipWaiting: a kiosk's one tab never closes, so a waiting worker would never take over.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('signage-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  let key = url.origin + url.pathname; // ignores ?debug=1 and ?settings=…
  if (key === ROOT + 'index.html') key = ROOT;
  if (!SHELL_URLS.includes(key)) return; // not one of ours: the browser handles it as normal
  event.respondWith(networkFirst(event, key));
});

async function networkFirst(event, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(event.request).then(async (response) => {
    // Only keep real, successful copies of our own files (no redirects, errors or other sites).
    if (response.ok && response.type === 'basic') await cache.put(key, response.clone());
    return response;
  });
  event.waitUntil(network.catch(() => {})); // let a slow download still refresh the saved copy
  try {
    return await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
  } catch (error) {
    const saved = await cache.match(key);
    return saved || network;
  }
}

function timeout(ms) {
  return new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out')), ms));
}
