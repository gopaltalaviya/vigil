// Applies the reader's chosen theme before the page is drawn, so there is no
// flash of the wrong colours. "system" (or nothing stored) follows the OS.
(() => {
  let theme = "system";
  try {
    theme = localStorage.getItem("vigil-theme") ?? "system";
  } catch {
    /* storage may be blocked; follow the system setting */
  }
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
})();
