// Re-check on return from admin settings and while this page remains visible.
// Only the connection controls change; preserve in-progress calendar selection.
(() => {
  const disabled = document.querySelector('[data-microsoft-unconfigured]');
  const connect = document.querySelector('[data-microsoft-connect]');
  if (!disabled || !connect) return;
  let pending = false;
  async function refresh() {
    if (pending || document.hidden) return;
    pending = true;
    try {
      const response = await fetch('/app/settings/calendar-sync/status', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return;
      const status = await response.json();
      if (typeof status.microsoftConfigured !== 'boolean') return;
      disabled.hidden = status.microsoftConfigured;
      connect.hidden = !status.microsoftConfigured;
      connect.querySelector('button').disabled = !status.microsoftConfigured;
    } catch { /* Keep the last known state on connection failure. */ }
    finally { pending = false; }
  }
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.setInterval(refresh, 30000);
})();
