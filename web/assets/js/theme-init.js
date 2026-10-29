// Runs in <head>, before first paint, so a saved light theme never flashes dark.
try {
  if (localStorage.getItem('antibody.theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch (e) {
  /* storage unavailable: dark */
}
