// MooTracker service worker.
// Handles Web Push events from Apple/Mozilla/FCM and shows local notifications.
// Empty-payload pushes use static text; payloads (when added later) can override.

const NOTIF_DEFAULTS = {
  title: "MooTracker",
  body: "Time to check in.",
  icon: "/apple-touch-icon.png",
  badge: "/apple-touch-icon.png",
  tag: "mt-reminder",
  renotify: true,
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let opts = { ...NOTIF_DEFAULTS };

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
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.endsWith(url) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
