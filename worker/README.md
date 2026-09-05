# 시그널링 서버 (Cloudflare Worker)

두 기기가 WebRTC로 직접 연결되기 전에 접속 정보(SDP·ICE 후보)를 교환할 통로만 제공합니다.

**영상은 이 서버를 거치지 않습니다.** 연결이 수립되면 기기 간 P2P로 직접 흐르고, 서버는 최초 악수만 중개합니다. 그래서 트래픽이 연결당 메시지 몇 개 수준이고, 무료 한도에 걸릴 일이 없습니다.

## 배포

Cloudflare 계정이 필요합니다. 무료 플랜으로 충분합니다.

```bash
cd worker
npx wrangler login     # 브라우저가 열리고 계정 인증
npx wrangler deploy
```

배포가 끝나면 이런 주소가 출력됩니다.

```
https://dual-camera-signal.<your-subdomain>.workers.dev
```

동작 확인:

```bash
curl https://dual-camera-signal.<your-subdomain>.workers.dev/health
# {"ok":true,"service":"dual-camera-signal"}
```

## 앱에 주소 넣기

앱 첫 화면의 **시그널 서버 주소** 칸에 위 주소를 넣습니다. `https://`를 `wss://`로 바꿔서 넣어도 되고, 그냥 붙여넣어도 앱이 알아서 `wss://`로 변환합니다.

```
wss://dual-camera-signal.<your-subdomain>.workers.dev
```

한 번 입력하면 기기에 저장되어 다시 묻지 않습니다. 두 기기 각각에 한 번씩 넣어야 합니다.

매번 입력이 번거로우면 두 가지 방법이 있습니다.

- `app.js`의 `SIGNAL_DEFAULT` 상수에 주소를 넣고 커밋
- URL 파라미터로 전달: `https://<pages-url>/?signal=wss://...`

## 무료 플랜에서 돌아가는 이유

[Durable Objects는 Workers 무료 플랜에서도 사용 가능](https://developers.cloudflare.com/durable-objects/platform/limits/)하고, [WebSocket은 모든 Cloudflare 플랜에서 지원](https://developers.cloudflare.com/network/websockets/)됩니다.

두 가지를 맞춰야 무료로 돌아갑니다.

- `wrangler.toml`의 마이그레이션이 `new_sqlite_classes`여야 합니다. 무료 플랜은 SQLite 기반 Durable Object만 허용합니다.
- WebSocket Hibernation API(`state.acceptWebSocket`)를 씁니다. 유휴 소켓이 메모리에서 내려가 과금 시간이 잡히지 않게 하려는 것입니다. 일반 `accept()`를 쓰면 소켓이 열려 있는 내내 시간이 청구됩니다.

*(출처 내용은 라이선스 준수를 위해 요약·재구성했습니다.)*

## 프로토콜

방 코드마다 별도의 Durable Object 인스턴스가 생기므로 다른 방끼리는 서로를 볼 수 없습니다.

```
WS  /room/<CODE>?role=host|sender
```

서버가 보내는 메시지:

| 타입 | 시점 | 내용 |
|---|---|---|
| `welcome` | 접속 직후 | `{ role, peerPresent }` |
| `peer-joined` | 상대가 들어옴 | `{ role }` |
| `peer-left` | 상대가 나감 | `{ role }` |

그 외 모든 메시지는 **내용을 해석하지 않고 상대에게 그대로 전달**합니다. 서버는 SDP를 이해할 필요가 없습니다. 클라이언트끼리 쓰는 타입은 `need-offer`, `offer`, `answer`, `ice`입니다.

협상은 **호스트가 요청하고 송신 기기가 응답하는** 단방향으로 고정했습니다. 양쪽이 동시에 offer를 만들어 충돌하는(glare) 상황을 원천적으로 없애기 위한 것입니다.

```
host  --- need-offer -->  sender
host  <--- offer ------    sender
host  --- answer ----->   sender
host  <---- ice ------->  sender
```

## 테스트

의존성 없이 node로 바로 돌아갑니다.

```bash
node worker/test/room.test.mjs
```

Cloudflare 런타임 없이 `DurableObjectState`와 `WebSocketPair`를 흉내내서 메시지 흐름을 검증합니다. 이 테스트는 실제로 버그를 하나 잡았습니다 — 경로 전체를 대문자로 바꾼 뒤 소문자 `/room/` 리터럴과 비교해서 모든 요청이 404로 떨어지던 문제였습니다.
