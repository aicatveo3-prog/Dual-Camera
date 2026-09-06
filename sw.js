/**
 * 서비스 워커
 * =============================================================================
 * 홈 화면 아이콘으로 설치할 수 있게 하고, 네트워크가 없어도 앱이 열리게 한다.
 *
 * 카메라는 이 워커에서 다룰 수 없다. 서비스 워커에는 DOM 도 getUserMedia 도
 * 없고, 브라우저는 화면에 보이지 않는 문서에서 카메라 시작을 금지한다.
 * 따라서 이 파일의 역할은 오직 "빠르게 열리게 하는 것"까지다.
 *
 * 캐시 전략
 *   HTML   네트워크 우선. 실패하면 캐시. 새 버전을 놓치지 않으려는 것이다.
 *   그 외   캐시 우선. 아이콘·매니페스트는 바뀌지 않으므로 즉시 응답한다.
 * =============================================================================
 */

const VERSION = "v1";
const CACHE = `dual-camera-${VERSION}`;

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 일부 항목이 실패해도 설치를 막지 않는다
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("dual-camera-") && k !== CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 외부 요청은 건드리지 않는다

  const isDoc = req.mode === "navigate" ||
                (req.headers.get("accept") || "").includes("text/html");

  if (isDoc) {
    // 네트워크 우선 — 새로 배포된 버전을 바로 받도록
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // 그 외는 캐시 우선
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
