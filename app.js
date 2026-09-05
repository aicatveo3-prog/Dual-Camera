"use strict";

/* =============================================================================
   앞뒤 카메라 — 기기 페어링
   -----------------------------------------------------------------------------
   기기 두 대를 WebRTC로 연결해, 한쪽은 후면 카메라(풍경), 다른 한쪽은 전면
   카메라(얼굴)를 담당하게 한다. 각 기기가 카메라를 하나만 열기 때문에
   "두 카메라 동시 실행" 하드웨어 제약을 아예 받지 않는다.

   역할
     host   : 자기 후면 카메라를 로컬로 켜고, 상대 영상을 받아 나란히 표시한다
     sender : 자기 전면 카메라를 잡아 host에게 보낸다. 화면은 표시하지 않는다

   음성은 어떤 경로로도 다루지 않는다
     1. getUserMedia에 audio:false 를 넘긴다  → 마이크 권한 팝업조차 뜨지 않는다
     2. 비디오 트랙만 addTrack 한다           → 전송 트랙에 오디오가 없다
     3. 모든 <video>에 muted 를 강제한다      → 스피커로 나갈 경로가 없다
   따라서 통화처럼 소리가 들리는 일은 발생하지 않는다.

   협상 순서 (glare 방지)
     host 가 항상 요청하고, sender 는 요청받을 때만 offer 를 만든다.
     양쪽이 동시에 offer 를 만들어 충돌하는 상황을 원천적으로 없앤다.

       host   --- need-offer -->  sender
       host   <--- offer ------   sender
       host   --- answer ----->   sender
       host  <--- ice --------->  sender
   ========================================================================== */

/* ------------------------------------------------------------------ 설정 */

/** 배포한 Worker 주소를 여기에 넣어두면 매번 입력하지 않아도 된다. */
const SIGNAL_DEFAULT = "";

const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/** 헷갈리는 글자(0/O, 1/I/L)를 뺀 집합. worker 쪽 정규식과 맞춰야 한다. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN = 6;

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

/* ------------------------------------------------------- 저장 (localStorage) */

const KEYS = { role: "dc.role", code: "dc.code", signal: "dc.signal" };

const store = {
  read(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  write(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  drop(k) { try { localStorage.removeItem(k); } catch (_) {} },

  get role() { return this.read(KEYS.role); },
  set role(v) { this.write(KEYS.role, v); },
  get code() { return this.read(KEYS.code); },
  set code(v) { this.write(KEYS.code, v); },
  get signal() { return this.read(KEYS.signal) || SIGNAL_DEFAULT; },
  set signal(v) { this.write(KEYS.signal, v); },

  clearPairing() { this.drop(KEYS.role); this.drop(KEYS.code); },
};

/* ------------------------------------------------------------------- DOM */

const $ = (id) => document.getElementById(id);

const el = {
  screens: { setup: $("setup"), host: $("host"), sender: $("sender") },

  signalUrl: $("signalUrl"),
  pickHost: $("pickHost"),
  pickSender: $("pickSender"),
  setupNote: $("setupNote"),
  resetPairing: $("resetPairing"),

  stage: $("stage"),
  panelLocal: $("panelLocal"),
  panelRemote: $("panelRemote"),
  localVideo: $("localVideo"),
  remoteVideo: $("remoteVideo"),
  resLocal: $("resLocal"),
  resRemote: $("resRemote"),
  codeBig: $("codeBig"),
  codePill: $("codePill"),
  hostState: $("hostState"),
  btnLayout: $("btnLayout"),
  btnSwap: $("btnSwap"),
  btnMirror: $("btnMirror"),
  btnFull: $("btnFull"),
  btnDiag: $("btnDiag"),
  btnHostStop: $("btnHostStop"),

  senderJoin: $("senderJoin"),
  senderLive: $("senderLive"),
  codeInput: $("codeInput"),
  btnJoin: $("btnJoin"),
  senderState: $("senderState"),
  senderSub: $("senderSub"),
  senderPill: $("senderPill"),
  selfWrap: $("selfWrap"),
  selfVideo: $("selfVideo"),
  btnSelfView: $("btnSelfView"),
  btnSenderStop: $("btnSenderStop"),

  toast: $("toast"),
  toastText: $("toastText"),
  toastClose: $("toastClose"),
  diag: $("diag"),
  diagBody: $("diagBody"),
};

/* ------------------------------------------------------------------ 상태 */

const state = {
  role: null,          // "host" | "sender"
  code: null,
  signal: null,        // Signal 인스턴스
  pc: null,
  localStream: null,   // host: 후면 / sender: 전면
  remoteStream: null,  // host 만 사용
  pendingIce: [],
  layout: "auto",
  swapped: false,
  mirrorRemote: true,
  wakeLock: null,
  resTimer: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- UI 도구 */

function showScreen(name) {
  for (const [k, node] of Object.entries(el.screens)) {
    node.classList.toggle("active", k === name);
  }
}

let toastTimer = null;
function toast(text, kind, ms = 7000) {
  el.toastText.textContent = text;
  el.toast.className = "show " + (kind || "");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  el.toast.className = "";
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}

function setPill(node, text, kind) {
  node.textContent = text;
  node.className = "pill " + (kind || "off");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------------- 방 코드 */

function makeCode() {
  const bytes = new Uint8Array(CODE_LEN);
  (crypto || window.crypto).getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function normalizeCode(raw) {
  // 코드 문자 집합에 없는 글자는 버린다.
  // 집합 자체에서 헷갈리는 글자(0/O, 1/I/L)를 이미 제외했으므로 따로 교정하지 않는다.
  let out = "";
  for (const ch of String(raw || "").toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length >= CODE_LEN) break;
  }
  return out;
}

/* ----------------------------------------------------------- 시그널링 계층 */

/**
 * Cloudflare Worker 와의 WebSocket 연결.
 * 이 클래스만 갈아끼우면 다른 시그널링 백엔드로 옮길 수 있다.
 */
class Signal {
  constructor({ url, code, role, onMessage, onState }) {
    this.base = String(url).replace(/\/+$/, "");
    this.code = code;
    this.role = role;
    this.onMessage = onMessage || (() => {});
    this.onState = onState || (() => {});
    this.ws = null;
    this.closed = false;
    this.retry = 0;
  }

  open() {
    if (this.closed) return;
    const url = `${this.base}/room/${this.code}?role=${this.role}`;
    this.onState("connecting");

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.onState("error", err);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retry = 0;
      this.onState("open");
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      this.onMessage(msg);
    });

    ws.addEventListener("close", (ev) => {
      if (this.closed) return;
      this.onState("closed", ev);
      this.scheduleRetry();
    });

    ws.addEventListener("error", () => {
      // close 이벤트가 뒤따르므로 여기서는 재시도를 걸지 않는다
      this.onState("error");
    });
  }

  scheduleRetry() {
    if (this.closed) return;
    const wait = Math.min(1000 * Math.pow(2, this.retry), 10000);
    this.retry += 1;
    setTimeout(() => this.open(), wait);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  get ready() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    if (this.ws) { try { this.ws.close(1000, "bye"); } catch (_) {} }
    this.ws = null;
  }
}

/* --------------------------------------------------------------- 카메라 */

/**
 * 카메라를 연다. audio 는 어떤 경우에도 요청하지 않는다.
 */
async function openCamera(facing) {
  if (!window.isSecureContext) {
    throw Object.assign(new Error("insecure"), { name: "InsecureContext" });
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw Object.assign(new Error("unsupported"), { name: "Unsupported" });
  }

  const attempts = [
    { ...VIDEO_CONSTRAINTS, facingMode: { exact: facing } },
    { ...VIDEO_CONSTRAINTS, facingMode: facing },
    { ...VIDEO_CONSTRAINTS },
  ];

  let lastErr;
  for (const video of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      lastErr = err;
      if (err && err.name === "NotAllowedError") throw err;
    }
  }
  throw lastErr;
}

function stopStream(stream) {
  if (stream) for (const t of stream.getTracks()) t.stop();
}

function explainCameraError(err) {
  switch ((err && err.name) || "") {
    case "InsecureContext":
      return "HTTPS가 아니라서 카메라를 쓸 수 없습니다.\nhttps:// 주소로 접속해 주세요.";
    case "Unsupported":
      return "이 브라우저는 카메라 API를 지원하지 않습니다.\n안드로이드는 Chrome을 써 주세요.";
    case "NotAllowedError":
      return "카메라 권한이 거부되었습니다.\n주소창의 자물쇠 아이콘 → 사이트 설정 → 카메라를 '허용'으로 바꾼 뒤 새로고침해 주세요.";
    case "NotFoundError":
      return "카메라를 찾을 수 없습니다.";
    case "NotReadableError":
    case "TrackStartError":
      return "카메라를 시작할 수 없습니다.\n다른 앱이 카메라를 쓰고 있는지 확인해 주세요.";
    default:
      return "카메라를 켜지 못했습니다.\n" + ((err && (err.name + ": " + err.message)) || "알 수 없는 오류");
  }
}

/* ------------------------------------------------------------ RTCPeerConn */

function buildPc() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.addEventListener("icecandidate", (ev) => {
    if (ev.candidate && state.signal) {
      state.signal.send({ type: "ice", candidate: ev.candidate.toJSON() });
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    onPcState(pc.connectionState);
  });

  if (state.role === "host") {
    pc.addEventListener("track", (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      state.remoteStream = stream;
      el.remoteVideo.srcObject = stream;
      el.remoteVideo.muted = true;           // 소리가 나갈 경로를 남기지 않는다
      el.remoteVideo.play().catch(() => {});
      el.panelRemote.dataset.live = "true";
      setPill(el.hostState, "연결됨", "ok");
    });
  }

  return pc;
}

function resetPc() {
  if (state.pc) {
    try { state.pc.close(); } catch (_) {}
  }
  state.pc = null;
  state.pendingIce = [];
  if (state.role === "host") {
    state.remoteStream = null;
    el.remoteVideo.srcObject = null;
    el.panelRemote.dataset.live = "false";
    el.resRemote.textContent = "";
  }
}

async function drainIce() {
  const list = state.pendingIce;
  state.pendingIce = [];
  for (const c of list) {
    try { await state.pc.addIceCandidate(c); } catch (_) {}
  }
}

function onPcState(s) {
  if (state.role === "host") {
    if (s === "connected") setPill(el.hostState, "연결됨", "ok");
    else if (s === "connecting") setPill(el.hostState, "연결 중", "wait");
    else if (s === "failed") {
      setPill(el.hostState, "연결 실패", "bad");
      toast("P2P 연결에 실패했습니다.\n두 기기가 같은 와이파이에 있는지 확인해 주세요.", "bad");
      // 상대에게 다시 offer 를 요청해 본다
      requestOffer();
    } else if (s === "disconnected") {
      setPill(el.hostState, "연결 끊김", "wait");
    }
  } else {
    if (s === "connected") {
      setPill(el.senderPill, "전송 중", "ok");
      el.senderState.textContent = "전송 중";
      el.senderSub.textContent = "호스트 기기 화면을 확인하세요. 소리는 전송하지 않습니다.";
    } else if (s === "connecting") {
      setPill(el.senderPill, "연결 중", "wait");
    } else if (s === "failed") {
      setPill(el.senderPill, "연결 실패", "bad");
      el.senderState.textContent = "연결 실패";
      el.senderSub.textContent = "두 기기가 같은 와이파이에 있는지 확인해 주세요.";
    } else if (s === "disconnected") {
      setPill(el.senderPill, "연결 끊김", "wait");
    }
  }
  renderDiag();
}

/* --------------------------------------------------------------- 메시지 */

function requestOffer() {
  if (state.role === "host" && state.signal) {
    state.signal.send({ type: "need-offer" });
  }
}

async function onSignalMessage(msg) {
  try {
    switch (msg.type) {
      case "welcome":
        if (msg.peerPresent) {
          if (state.role === "host") requestOffer();
        } else {
          if (state.role === "host") setPill(el.hostState, "연결 대기", "wait");
          else setPill(el.senderPill, "호스트 대기", "wait");
        }
        break;

      case "peer-joined":
        if (state.role === "host") requestOffer();
        break;

      case "peer-left":
        resetPc();
        if (state.role === "host") setPill(el.hostState, "상대 나감", "wait");
        else setPill(el.senderPill, "호스트 대기", "wait");
        break;

      // host → sender : offer 를 만들어 달라
      case "need-offer":
        if (state.role === "sender") await senderSendOffer();
        break;

      case "offer":
        if (state.role !== "host") break;
        resetPc();
        state.pc = buildPc();
        await state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await drainIce();
        {
          const answer = await state.pc.createAnswer();
          await state.pc.setLocalDescription(answer);
          state.signal.send({ type: "answer", sdp: state.pc.localDescription });
        }
        break;

      case "answer":
        if (state.role !== "sender" || !state.pc) break;
        await state.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await drainIce();
        break;

      case "ice":
        if (!msg.candidate) break;
        if (state.pc && state.pc.remoteDescription) {
          try { await state.pc.addIceCandidate(msg.candidate); } catch (_) {}
        } else {
          state.pendingIce.push(msg.candidate);
        }
        break;
    }
  } catch (err) {
    toast("연결 처리 중 오류가 발생했습니다.\n" + ((err && err.message) || ""), "bad");
  }
  renderDiag();
}

function onSignalState(s) {
  const pill = state.role === "host" ? el.hostState : el.senderPill;
  if (s === "connecting") setPill(pill, "서버 연결 중", "wait");
  else if (s === "closed") setPill(pill, "서버 끊김 · 재시도", "wait");
  else if (s === "error") setPill(pill, "서버 오류", "bad");
  renderDiag();
}

/* ---------------------------------------------------------------- 호스트 */

async function startHost() {
  state.role = "host";
  store.role = "host";

  state.code = store.code || makeCode();
  store.code = state.code;
  el.codeBig.textContent = state.code;
  el.codePill.textContent = state.code;

  showScreen("host");
  setPill(el.hostState, "카메라 준비 중", "wait");

  // 후면 카메라 (로컬 표시 전용, 전송하지 않는다)
  try {
    state.localStream = await openCamera("environment");
    el.localVideo.srcObject = state.localStream;
    el.localVideo.muted = true;
    await el.localVideo.play().catch(() => {});
    el.panelLocal.dataset.live = "true";
  } catch (err) {
    toast(explainCameraError(err), "bad", 12000);
    setPill(el.hostState, "카메라 실패", "bad");
  }

  connectSignal();
  startResTimer();
  requestWakeLock();
}

/* ----------------------------------------------------------------- 송신 */

async function startSender(code) {
  state.role = "sender";
  store.role = "sender";
  state.code = code;
  store.code = code;

  showScreen("sender");
  el.senderJoin.hidden = true;
  el.senderLive.hidden = false;
  el.senderState.textContent = "카메라 준비 중…";
  setPill(el.senderPill, "카메라 준비 중", "wait");

  try {
    state.localStream = await openCamera("user");
    el.selfVideo.srcObject = state.localStream;
    el.selfVideo.muted = true;
  } catch (err) {
    toast(explainCameraError(err), "bad", 12000);
    el.senderState.textContent = "카메라 실패";
    el.senderSub.textContent = "권한을 허용한 뒤 다시 시도해 주세요.";
    setPill(el.senderPill, "카메라 실패", "bad");
    return;
  }

  el.senderState.textContent = "호스트 연결 대기…";
  connectSignal();
  startResTimer();
  requestWakeLock();
}

async function senderSendOffer() {
  if (!state.localStream) return;

  resetPc();
  state.pc = buildPc();

  // 비디오 트랙만 넣는다. 오디오 트랙은 애초에 존재하지 않는다.
  for (const track of state.localStream.getVideoTracks()) {
    state.pc.addTrack(track, state.localStream);
  }

  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  state.signal.send({ type: "offer", sdp: state.pc.localDescription });
  setPill(el.senderPill, "연결 중", "wait");
}

/* ------------------------------------------------------------- 공통 시작 */

function connectSignal() {
  if (state.signal) state.signal.close();
  state.signal = new Signal({
    url: store.signal,
    code: state.code,
    role: state.role,
    onMessage: onSignalMessage,
    onState: onSignalState,
  });
  state.signal.open();
}

function stopAll(backToSetup) {
  if (state.signal) { state.signal.close(); state.signal = null; }
  resetPc();
  stopStream(state.localStream);
  state.localStream = null;
  el.localVideo.srcObject = null;
  el.selfVideo.srcObject = null;
  el.panelLocal.dataset.live = "false";
  stopResTimer();
  releaseWakeLock();
  hideToast();
  if (backToSetup) {
    state.role = null;
    showScreen("setup");
    refreshSetup();
  }
}

/* -------------------------------------------------------- 화면 꺼짐 방지 */

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch (_) {}
}
function releaseWakeLock() {
  if (state.wakeLock) { try { state.wakeLock.release(); } catch (_) {} state.wakeLock = null; }
}

/* ------------------------------------------------------------ 해상도 표시 */

function startResTimer() {
  stopResTimer();
  state.resTimer = setInterval(() => {
    if (state.role === "host") {
      el.resLocal.textContent = resOf(state.localStream);
      el.resRemote.textContent = resOf(state.remoteStream);
    }
    if (!el.diag.hidden) renderDiag();
  }, 2000);
}
function stopResTimer() {
  if (state.resTimer) { clearInterval(state.resTimer); state.resTimer = null; }
}
function resOf(stream) {
  const t = stream && stream.getVideoTracks()[0];
  if (!t) return "";
  const s = t.getSettings();
  return s.width && s.height ? `${s.width}×${s.height}` : "";
}

/* --------------------------------------------------------------- 진단 */

function renderDiag() {
  if (el.diag.hidden) return;
  const rows = [
    ["역할", state.role || "-"],
    ["방 코드", state.code || "-"],
    ["시그널 서버", store.signal || "(미설정)"],
    ["시그널 상태", state.signal ? (state.signal.ready ? "연결됨" : "끊김/재시도") : "-"],
    ["PC 상태", state.pc ? state.pc.connectionState : "-"],
    ["ICE 상태", state.pc ? state.pc.iceConnectionState : "-"],
    ["로컬 영상", resOf(state.localStream) || "-"],
    ["원격 영상", resOf(state.remoteStream) || "-"],
    ["오디오 트랙", audioSummary()],
    ["보안 연결", window.isSecureContext ? "HTTPS" : "아님"],
    ["화면", `${window.innerWidth}×${window.innerHeight}`],
    ["User Agent", navigator.userAgent],
  ];
  el.diagBody.innerHTML = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
}

/** 오디오가 정말 하나도 없는지 눈으로 확인할 수 있게 노출한다 */
function audioSummary() {
  const local = state.localStream ? state.localStream.getAudioTracks().length : 0;
  const remote = state.remoteStream ? state.remoteStream.getAudioTracks().length : 0;
  return `로컬 ${local}개 / 원격 ${remote}개 (0이어야 정상)`;
}

/* ------------------------------------------------------------ 설정 화면 */

function refreshSetup() {
  el.signalUrl.value = store.signal || "";
  const hasPairing = !!(store.role && store.code);
  el.resetPairing.hidden = !hasPairing;
  if (hasPairing) {
    el.setupNote.hidden = false;
    el.setupNote.textContent =
      `저장된 페어링: ${store.role === "host" ? "호스트" : "송신"} · 코드 ${store.code}`;
  } else {
    el.setupNote.hidden = true;
  }
}

function readSignalUrl() {
  let v = el.signalUrl.value.trim();
  if (!v) return null;
  v = v.replace(/\/+$/, "");
  if (/^https:\/\//i.test(v)) v = "wss://" + v.slice(8);
  else if (/^http:\/\//i.test(v)) v = "ws://" + v.slice(7);
  else if (!/^wss?:\/\//i.test(v)) v = "wss://" + v;
  return v;
}

/* ------------------------------------------------------------- 이벤트 */

el.pickHost.addEventListener("click", () => {
  const url = readSignalUrl();
  if (!url) return toast("시그널 서버 주소를 먼저 입력해 주세요.", "warn");
  store.signal = url;
  startHost();
});

el.pickSender.addEventListener("click", () => {
  const url = readSignalUrl();
  if (!url) return toast("시그널 서버 주소를 먼저 입력해 주세요.", "warn");
  store.signal = url;
  state.role = "sender";
  showScreen("sender");
  el.senderJoin.hidden = false;
  el.senderLive.hidden = true;
  el.codeInput.value = store.code || "";
  el.codeInput.focus();
});

el.btnJoin.addEventListener("click", () => {
  const code = normalizeCode(el.codeInput.value);
  if (code.length !== CODE_LEN) {
    return toast(`코드 ${CODE_LEN}자리를 정확히 입력해 주세요.`, "warn");
  }
  startSender(code);
});

el.codeInput.addEventListener("input", (e) => {
  e.target.value = normalizeCode(e.target.value);
});
el.codeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.btnJoin.click();
});

el.resetPairing.addEventListener("click", () => {
  store.clearPairing();
  refreshSetup();
  toast("저장된 페어링을 지웠습니다.", null, 3000);
});

el.btnHostStop.addEventListener("click", () => stopAll(true));
el.btnSenderStop.addEventListener("click", () => stopAll(true));

el.btnLayout.addEventListener("click", () => {
  const order = ["auto", "rows", "cols"];
  const names = { auto: "자동", rows: "위/아래", cols: "좌/우" };
  state.layout = order[(order.indexOf(state.layout) + 1) % order.length];
  el.stage.dataset.layout = state.layout;
  el.btnLayout.textContent = "분할: " + names[state.layout];
});

el.btnSwap.addEventListener("click", () => {
  state.swapped = !state.swapped;
  el.stage.dataset.swapped = String(state.swapped);
});

if (el.btnMirror) {
  el.btnMirror.addEventListener("click", () => {
    state.mirrorRemote = !state.mirrorRemote;
    el.panelRemote.dataset.mirror = String(state.mirrorRemote);
    el.btnMirror.setAttribute("aria-pressed", String(state.mirrorRemote));
  });
}

el.btnFull.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.getElementById("app").requestFullscreen({ navigationUI: "hide" });
  } catch (_) {}
});

el.btnDiag.addEventListener("click", () => {
  const show = el.diag.hidden;
  el.diag.hidden = !show;
  el.btnDiag.setAttribute("aria-pressed", String(show));
  renderDiag();
});

el.btnSelfView.addEventListener("click", () => {
  const on = !el.selfWrap.hidden;
  el.selfWrap.hidden = on;
  el.btnSelfView.setAttribute("aria-pressed", String(!on));
  if (!on) el.selfVideo.play().catch(() => {});
});

el.toastClose.addEventListener("click", hideToast);

// 백그라운드에서 돌아왔을 때 카메라·화면 복구
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !state.role) return;
  requestWakeLock();
  const v = state.role === "host" ? el.localVideo : el.selfVideo;
  if (v && v.srcObject) v.play().catch(() => {});
  if (state.role === "host") el.remoteVideo.play().catch(() => {});
  // 시그널 소켓이 끊겨 있으면 Signal 이 알아서 재시도한다
  if (state.role === "host" && state.signal && state.signal.ready) requestOffer();
});

/* ------------------------------------------------------------ 부트스트랩 */

(function boot() {
  // ?signal=... 로 서버 주소를 넘길 수 있게 한다
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("signal");
  if (fromUrl) store.signal = fromUrl.replace(/\/+$/, "");

  refreshSetup();

  // 저장된 역할과 코드가 있으면 자동으로 재연결한다.
  // 최초 1회만 페어링하고 이후에는 페이지만 열면 붙게 하는 것이 목적이다.
  const role = store.role;
  const code = store.code;
  const signal = store.signal;
  const auto = params.get("setup") !== "1";

  if (auto && signal && role && code) {
    if (role === "host") startHost();
    else startSender(code);
  } else {
    showScreen("setup");
  }
})();
