// Installable app: register the service worker (network-first; see /sw.js)
// and keep the browser's install prompt so Settings can offer an Install button.
let deferred = null;
const listeners = new Set();

if ('serviceWorker' in navigator && isSecureContext) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  listeners.forEach((f) => f(true));
});
addEventListener('appinstalled', () => {
  deferred = null;
  listeners.forEach((f) => f(false));
});

export const installed = () => matchMedia('(display-mode: standalone)').matches;
export const canInstall = () => !!deferred;
export function onInstallable(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}
export async function install() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  return outcome === 'accepted';
}
