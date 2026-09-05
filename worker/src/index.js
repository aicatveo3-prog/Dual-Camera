/**
 * Dual-Camera 시그널링 서버
 * =============================================================================
 * 두 기기가 WebRTC로 직접 연결되기 전에, 서로의 접속 정보(SDP·ICE 후보)를
 * 교환할 통로만 제공한다.
 *
 * 영상은 이 서버를 거치지 않는다. 연결이 수립되면 기기 간 P2P로 직접 흐르고,
 * 서버는 악수(handshake)만 중개한다. 그래서 트래픽이 극히 적다.
 *
 * 구조
 *   Worker            요청을 방 코드별 Durable Object로 넘긴다
 *   Room (DO)         방 하나. 최대 2개 소켓(host/sender)을 물고 메시지를 relay
 *
 * 방 코드마다 별도의 Durable Object 인스턴스가 생기므로, 다른 방끼리는
 * 서로를 볼 수 없다.
 *
 * WebSocket Hibernation API를 쓴다. 유휴 소켓이 메모리에서 내려가 과금 시간이
 * 잡히지 않게 하려는 것이다. 무료 플랜에서 돌리기 위한 선택이다.
 * =============================================================================
 */

const ROLES = ["host", "sender"];

/**
 * 경로에서 방 코드를 떼어낸다.
 * 경로 전체를 대문자로 바꾸면 "/room/" 리터럴이 "/ROOM/" 이 되어 매칭이 깨지므로,
 * 여기서는 형태만 보고 코드의 대소문자 정규화는 뒤에서 따로 한다.
 */
const ROOM_PATH = /^\/room\/([A-Za-z0-9]{4,12})$/;

/** 방 코드에 쓰는 문자 집합. 클라이언트 app.js의 CODE_ALPHABET과 맞춰야 한다. */
const CODE_RE = /^[2-9A-HJ-NP-Z]{4,12}$/;

/** 같은 역할이 재접속해서 이전 소켓을 끊을 때 쓰는 코드 */
const CLOSE_REPLACED = 4001;

const otherRole = (r) => (r === "host" ? "sender" : "host");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "dual-camera-signal" });
    }

    const match = ROOM_PATH.exec(url.pathname);
    if (!match) {
      return json({ error: "not found", hint: "use /room/<CODE>" }, 404);
    }

    // 소문자로 들어와도 같은 방으로 취급한다
    const code = match[1].toUpperCase();
    if (!CODE_RE.test(code)) {
      return json({ error: "invalid room code" }, 404);
    }

    const upgrade = request.headers.get("Upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return json({ error: "expected websocket upgrade" }, 426);
    }

    // 방 코드 → 항상 같은 Durable Object 인스턴스
    const id = env.ROOMS.idFromName(code);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let role = url.searchParams.get("role");
    if (!ROLES.includes(role)) role = "sender";

    // 같은 역할로 이미 붙어 있으면 이전 연결을 끊는다.
    // (새로고침·앱 전환으로 유령 소켓이 남는 경우 대비)
    for (const stale of this.state.getWebSockets(role)) {
      try { stale.close(CLOSE_REPLACED, "replaced"); } catch (_) {}
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 태그로 역할을 기록해 둔다. hibernation 후 깨어나도 유지된다.
    this.state.acceptWebSocket(server, [role]);

    const peers = this.state.getWebSockets(otherRole(role));
    this.sendTo(server, {
      type: "welcome",
      role,
      peerPresent: peers.length > 0,
    });
    for (const p of peers) {
      this.sendTo(p, { type: "peer-joined", role });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 시그널링 메시지는 내용을 해석하지 않고 상대에게 그대로 넘긴다.
   * 서버가 SDP를 이해할 필요가 없다.
   */
  webSocketMessage(ws, message) {
    const role = this.roleOf(ws);
    if (!role) return;
    for (const peer of this.state.getWebSockets(otherRole(role))) {
      try { peer.send(message); } catch (_) {}
    }
  }

  webSocketClose(ws, code) {
    // 우리가 교체 목적으로 끊은 소켓이면 상대에게 알리지 않는다.
    // 알리면 방금 접속한 쪽이 "상대가 나갔다"고 오해한다.
    if (code === CLOSE_REPLACED) return;

    const role = this.roleOf(ws);
    if (!role) return;
    for (const peer of this.state.getWebSockets(otherRole(role))) {
      this.sendTo(peer, { type: "peer-left", role });
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1006);
  }

  roleOf(ws) {
    const tags = this.state.getTags(ws);
    return ROLES.find((r) => tags.includes(r)) || null;
  }

  sendTo(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
