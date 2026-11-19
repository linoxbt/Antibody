// Antibody Guard has no service worker: every visit reads the live chains.
export const installed = () => false;
export const canInstall = () => false;
export const onInstallable = () => () => {};
export async function install() { return false; }
