/**
 * Room Durable Object 중개 로직 검증
 * =============================================================================
 * Cloudflare 런타임 없이 DurableObjectState / WebSocketPair 를 흉내내서
 * 시그널링 메시지 흐름을 검증한다. 의존성 없이 node 로 바로 돌아간다.
 *
 *   node worker/test/room.test.mjs
 *
 * 이 테스트는 실제로 버그를 하나 잡았다. 경로 전체를 대문자로 바꾼 뒤
 * 소문자 "/room/" 리터럴과 비교해서 모든 요청이 404 로 떨어지던 문제였다.
 * =============================================================================
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "src", "index.js");

/* ---- Cloudflare 런타임 스텁 ---------------------------------------------- */

class MockWS {
  constructor(name) { this.name = name; this.inbox = []; this.closed = null; }
  send(data) { this.inbox.push(typeof data === "string" ? JSON.parse(data) : data); }
  close(code, reason) { this.closed = { code, reason }; }
  types() { return this.inbox.map((m) => m.type); }
}

globalThis.WebSocketPair = class {
  constructor() { this[0] = new MockWS("client"); this[1] = new MockWS("server"); }
};
globalThis.Response = class {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.webSocket = init.webSocket;
  }
};

class MockState {
  constructor() { this.entries = []; }
  acceptWebSocket(ws, tags) { this.entries.push({ ws, tags }); }
  getWebSockets(tag) {
    return this.entries.filter((e) => !tag || e.tags.includes(tag)).map((e) => e.ws);
  }
  getTags(ws) {
    const e = this.entries.find((x) => x.ws === ws);
    return e ? e.tags : [];
  }
}

/* ---- 대상 모듈 로드 ------------------------------------------------------ */

const src = fs.readFileSync(TARGET, "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const { Room } = mod;

/* ---- 도구 --------------------------------------------------------------- */

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  → " + extra : "")); }
}

async function connect(room, state, role) {
  const request = {
    url: `https://x/room/ABC234?role=${role}`,
    headers: { get: (h) => (h === "Upgrade" ? "websocket" : null) },
  };
  const res = await room.fetch(request);
  const server = state.entries[state.entries.length - 1].ws;
  return { res, server };
}

const mkReq = (pathname, upgrade) => ({
  url: "https://x" + pathname,
  headers: { get: (h) => (h === "Upgrade" ? upgrade : null) },
});

/* ---- 시나리오 ----------------------------------------------------------- */

console.log("\n[1] host 먼저 접속 → 상대 없음을 알려야 한다");
{
  const state = new MockState();
  const room = new Room(state);
  const { res, server } = await connect(room, state, "host");
  check("101 응답 + webSocket 반환", res.status === 101 && !!res.webSocket, "status=" + res.status);
  check("welcome 수신", server.types().includes("welcome"));
  const w = server.inbox.find((m) => m.type === "welcome");
  check("role=host", w && w.role === "host", JSON.stringify(w));
  check("peerPresent=false", w && w.peerPresent === false, JSON.stringify(w));
}

console.log("\n[2] sender 합류 → 양쪽이 서로를 인지해야 한다");
{
  const state = new MockState();
  const room = new Room(state);
  const h = await connect(room, state, "host");
  const s = await connect(room, state, "sender");
  const w = s.server.inbox.find((m) => m.type === "welcome");
  check("sender welcome.peerPresent=true", w && w.peerPresent === true, JSON.stringify(w));
  check("host 가 peer-joined 수신", h.server.types().includes("peer-joined"));
}

console.log("\n[3] 메시지가 상대에게만 전달되어야 한다");
{
  const state = new MockState();
  const room = new Room(state);
  const h = await connect(room, state, "host");
  const s = await connect(room, state, "sender");
  const hBefore = h.server.inbox.length, sBefore = s.server.inbox.length;

  room.webSocketMessage(h.server, JSON.stringify({ type: "need-offer" }));
  check("host→sender 전달됨", s.server.inbox.length === sBefore + 1);
  check("host 에게 에코되지 않음", h.server.inbox.length === hBefore, "에코 발생");

  room.webSocketMessage(s.server, JSON.stringify({ type: "offer", sdp: "x" }));
  const got = h.server.inbox[h.server.inbox.length - 1];
  check("sender→host 전달됨", got && got.type === "offer", JSON.stringify(got));
}

console.log("\n[4] 같은 역할 재접속 → 이전 소켓만 끊고 peer-left 는 보내지 않아야 한다");
{
  const state = new MockState();
  const room = new Room(state);
  const h = await connect(room, state, "host");
  const s1 = await connect(room, state, "sender");
  const hBefore = h.server.inbox.length;

  await connect(room, state, "sender");   // 새로고침 상황
  check("이전 sender 소켓이 닫힘", s1.server.closed !== null, JSON.stringify(s1.server.closed));
  check("닫힘 코드 4001", s1.server.closed && s1.server.closed.code === 4001);

  room.webSocketClose(s1.server, 4001);
  const left = h.server.inbox.slice(hBefore).filter((m) => m.type === "peer-left");
  check("host 에게 peer-left 가 가지 않음", left.length === 0, "peer-left " + left.length + "건");
  check("host 는 peer-joined 를 다시 받음",
    h.server.inbox.slice(hBefore).some((m) => m.type === "peer-joined"));
}

console.log("\n[5] 진짜 연결 종료 → 상대에게 peer-left 를 알려야 한다");
{
  const state = new MockState();
  const room = new Room(state);
  const h = await connect(room, state, "host");
  const s = await connect(room, state, "sender");
  const sBefore = s.server.inbox.length;
  room.webSocketClose(h.server, 1001);
  const msg = s.server.inbox.slice(sBefore).find((m) => m.type === "peer-left");
  check("sender 가 peer-left 수신", !!msg);
  check("나간 역할이 host 로 표기", msg && msg.role === "host");
}

console.log("\n[6] 방 격리 — 다른 코드는 다른 DO 인스턴스이므로 서로 못 본다");
{
  const stateA = new MockState(), stateB = new MockState();
  const roomA = new Room(stateA), roomB = new Room(stateB);
  const a = await connect(roomA, stateA, "host");
  const b = await connect(roomB, stateB, "sender");
  const aBefore = a.server.inbox.length;
  roomB.webSocketMessage(b.server, JSON.stringify({ type: "offer" }));
  check("다른 방으로 새지 않음", a.server.inbox.length === aBefore);
}

console.log("\n[7] 라우팅");
{
  const env = {
    ROOMS: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => new Response(null, { status: 101 }) }),
    },
  };
  const r1 = await mod.default.fetch(mkReq("/health", null), env);
  check("/health → 200", r1.status === 200, "status=" + r1.status);

  const r2 = await mod.default.fetch(mkReq("/room/ABC234", null), env);
  check("업그레이드 헤더 없으면 426", r2.status === 426, "status=" + r2.status);

  const r3 = await mod.default.fetch(mkReq("/nope", "websocket"), env);
  check("알 수 없는 경로 404", r3.status === 404, "status=" + r3.status);

  const r4 = await mod.default.fetch(mkReq("/room/abc234", "websocket"), env);
  check("소문자 코드도 같은 방으로 허용", r4.status === 101, "status=" + r4.status);

  const r5 = await mod.default.fetch(mkReq("/room/AB", "websocket"), env);
  check("너무 짧은 코드 404", r5.status === 404, "status=" + r5.status);

  const r6 = await mod.default.fetch(mkReq("/room/ABO01I", "websocket"), env);
  check("허용되지 않는 글자(O,0,1,I) 404", r6.status === 404, "status=" + r6.status);
}

console.log(`\n결과: ${pass} 통과, ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
