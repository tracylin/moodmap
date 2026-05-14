// MooTracker service worker.
// Handles Web Push events from Apple/Mozilla/FCM and shows local notifications.
// When a push arrives with a payload, that wins. Empty-payload pushes pick
// a phrase at random from a small pool so the same words don't repeat each
// time — keeps the nudge feeling fresh rather than robotic. Payload tags
// intentionally replace earlier notifications from the same slot/day.

const NOTIF_DEFAULTS = {
  title: "MooTracker",
  icon: "/apple-touch-icon.png",
  badge: "/apple-touch-icon.png",
  tag: "mt-reminder",
  renotify: true,
};

const FALLBACK_PHRASES = [
  "How was today?",
  "Anything to note?",
  "Just a soft check-in.",
  "How's the day landing?",
  "Even one word is enough.",
  "A small step is still a step.",
  "MooTracker is here when you want.",
  "No rush — come when you're ready.",
  "What stood out today?",
];

function pickFallbackPhrase() {
  return FALLBACK_PHRASES[Math.floor(Math.random() * FALLBACK_PHRASES.length)];
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let opts = { ...NOTIF_DEFAULTS };
  opts.body = pickFallbackPhrase();

  if (event.data) {
    try {
      const data = event.data.json();
      if (data.title) opts.title = data.title;
      if (data.body) opts.body = data.body;
      if (data.tag) opts.tag = data.tag;
      if (data.url) opts.data = { url: data.url };
    } catch {
      const text = event.data.text();
      if (text) opts.body = text;
    }
  }

  const title = opts.title;
  delete opts.title;
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Default deep-link target: today's mood entry. App reads location.hash
  // on mount (and on hashchange) and routes accordingly.
  const url = (event.notification.data && event.notification.data.url) || "/#log/today";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // If a window is already open, focus it and force-navigate via postMessage
      // so the hash change fires even when the URL matches the existing path.
      for (const c of clients) {
        if ("focus" in c) {
          try { c.navigate(url); } catch (_) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
