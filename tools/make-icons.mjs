/**
 * 홈 화면 아이콘 생성기
 * =============================================================================
 * PWA 설치에 필요한 PNG 아이콘을 의존성 없이 만든다.
 * node 내장 zlib 만 쓰고 외부 이미지 라이브러리를 쓰지 않는다.
 *
 *   node tools/make-icons.mjs
 *
 * 디자인: 어두운 배경에 렌즈 두 개(전면·후면)를 나란히 둔 형태.
 * 안드로이드가 아이콘을 원형 등으로 잘라내므로(maskable) 배경을 꽉 채우고
 * 내용은 가운데 안전 영역에만 배치한다.
 * =============================================================================
 */
import zlib from "zlib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---- PNG 인코더 ---------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array, 길이 = w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // 각 스캔라인 앞에 필터 바이트(0 = None)를 붙인다
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---- 그리기 -------------------------------------------------------------- */

const BG = [0x0f, 0x10, 0x14];
const LENS_BACK = [0x4c, 0x8d, 0xff];   // 후면 = 앱의 강조색
const LENS_FRONT = [0xf2, 0xf2, 0xf4];  // 전면 = 밝은 회색
const RING = [0x2a, 0x2c, 0x34];

/** 정규화 좌표(0~1)에서의 색을 돌려준다. 없으면 null */
function shade(x, y) {
  // 렌즈 두 개를 가로로 나란히 배치
  const lenses = [
    { cx: 0.335, cy: 0.5, r: 0.15, fill: LENS_BACK },
    { cx: 0.665, cy: 0.5, r: 0.15, fill: LENS_FRONT },
  ];

  for (const l of lenses) {
    const d = Math.hypot(x - l.cx, y - l.cy);
    if (d <= l.r) {
      // 가운데를 어둡게 해서 렌즈처럼 보이게 한다
      return d <= l.r * 0.42 ? RING : l.fill;
    }
    // 렌즈 바깥 얇은 테두리
    if (d <= l.r * 1.16) return RING;
  }
  return null;
}

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  const SS = 3;   // 계단현상을 줄이기 위한 수퍼샘플링

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = shade(x, y) || BG;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = 255;   // maskable 이므로 전체 불투명
    }
  }
  return rgba;
}

/* ---- 실행 --------------------------------------------------------------- */

for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, size, render(size)));
  console.log(`생성: icon-${size}.png (${fs.statSync(file).size} bytes)`);
}
