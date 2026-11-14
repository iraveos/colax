// The PlatformAPI implementation for the Tauri shell (see src/lib/platform.ts).
// Injected before any page script runs, so the React app finds `window.platform`
// exactly as it does under Electron — the UI itself is untouched.
(function () {
  if (window.platform) return;
  var invoke = function (cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  };
  window.platform = {
    name: 'tauri',
    versions: function () {
      return { app: '__APP_VERSION__', host: 'WebView2 · Tauri 2' };
    },
    // The shell routes this to the OS browser; a bare window.open inside a
    // webview would open a second app window holding the unlocked vault.
    openExternal: function (url) {
      invoke('open_external', { url: url }).catch(function () {
        window.open(url, '_blank', 'noopener');
      });
    },
  };
})();
