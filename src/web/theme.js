// The theme picked in 設定 > 表示, set on the root before the page draws so it does not flash.
// light or dark wins over the system; auto (nothing kept) follows the system.
(() => {
  try {
    const t = localStorage.getItem('wf.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch {
    // Storage may be off: the system's choice stands.
  }
})();
