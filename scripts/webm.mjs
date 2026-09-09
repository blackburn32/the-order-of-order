// A minimal WebM (Matroska) muxer for a single VP8 video track.
//
// It exists because MediaRecorder cannot record these clips honestly. Chromium's
// recorder holds one frame in flight and takes ~65ms to encode a 1600x900 frame
// of tumbling dice, so it silently drops every other frame and discards whatever
// is still queued when the recording stops: clips came out at 11-15fps whatever
// they were sampled at, and lost their closing beat. WebCodecs' VideoEncoder has
// no such ceiling — it encodes the same frames at ~80fps and drops none — but it
// hands back naked VP8 frames, which is what this file wraps.
//
// Only the subset a looping, silent, fixed-size clip needs is implemented: one
// track, no audio, no lacing, no seek index. Frames are buffered by the caller
// before muxing, so every element is written with a known size.

const ID = {
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  ebmlVersion: [0x42, 0x86],
  ebmlReadVersion: [0x42, 0xf7],
  ebmlMaxIdLength: [0x42, 0xf2],
  ebmlMaxSizeLength: [0x42, 0xf3],
  docType: [0x42, 0x82],
  docTypeVersion: [0x42, 0x87],
  docTypeReadVersion: [0x42, 0x85],
  segment: [0x18, 0x53, 0x80, 0x67],
  info: [0x15, 0x49, 0xa9, 0x66],
  timecodeScale: [0x2a, 0xd7, 0xb1],
  muxingApp: [0x4d, 0x80],
  writingApp: [0x57, 0x41],
  duration: [0x44, 0x89],
  tracks: [0x16, 0x54, 0xae, 0x6b],
  trackEntry: [0xae],
  trackNumber: [0xd7],
  trackUid: [0x73, 0xc5],
  flagLacing: [0x9c],
  language: [0x22, 0xb5, 0x9c],
  codecId: [0x86],
  trackType: [0x83],
  defaultDuration: [0x23, 0xe3, 0x83],
  video: [0xe0],
  pixelWidth: [0xb0],
  pixelHeight: [0xba],
  cluster: [0x1f, 0x43, 0xb6, 0x75],
  timecode: [0xe7],
  simpleBlock: [0xa3],
};

const TRACK_NUMBER = 1;
/** Matroska timestamps are written in these units: 1e6 nanoseconds, so 1ms. */
const TIMECODE_SCALE_NS = 1_000_000;
/** A block's timestamp is a signed 16-bit offset from its cluster's, so a
 *  cluster can only cover ~32s. Starting one on every keyframe keeps clusters
 *  far shorter than that and gives a player somewhere to resume from. */
const MAX_CLUSTER_MS = 30_000;

/** Mux VP8 frames into a WebM file.
 *
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.fps - Nominal frame rate, written as DefaultDuration.
 * @param {{ key: boolean, timestampUs: number, data: Uint8Array }[]} options.frames
 *   In presentation order, the first of them a keyframe.
 * @returns {Uint8Array} the complete file.
 */
export function muxWebm({ width, height, fps, frames }) {
  if (frames.length === 0) throw new Error("muxWebm: no frames");
  if (!frames[0].key) throw new Error("muxWebm: first frame is not a keyframe");

  const app = "the-order-of-order capture studio";
  const lastMs = Math.round(frames.at(-1).timestampUs / 1000);
  const header = element(ID.ebml, [
    element(ID.ebmlVersion, uint(1)),
    element(ID.ebmlReadVersion, uint(1)),
    element(ID.ebmlMaxIdLength, uint(4)),
    element(ID.ebmlMaxSizeLength, uint(8)),
    element(ID.docType, ascii("webm")),
    element(ID.docTypeVersion, uint(2)),
    element(ID.docTypeReadVersion, uint(2)),
  ]);
  const info = element(ID.info, [
    element(ID.timecodeScale, uint(TIMECODE_SCALE_NS)),
    element(ID.muxingApp, ascii(app)),
    element(ID.writingApp, ascii(app)),
    // MediaRecorder leaves this out, which is why its clips report a bogus
    // duration until they have been played all the way through.
    element(ID.duration, float64(lastMs + 1000 / fps)),
  ]);
  const tracks = element(ID.tracks, [
    element(ID.trackEntry, [
      element(ID.trackNumber, uint(TRACK_NUMBER)),
      element(ID.trackUid, uint(TRACK_NUMBER)),
      element(ID.flagLacing, uint(0)),
      element(ID.language, ascii("und")),
      element(ID.codecId, ascii("V_VP8")),
      element(ID.trackType, uint(1)),
      element(ID.defaultDuration, uint(Math.round(1_000_000_000 / fps))),
      element(ID.video, [
        element(ID.pixelWidth, uint(width)),
        element(ID.pixelHeight, uint(height)),
      ]),
    ]),
  ]);

  const clusters = [];
  let blocks = [];
  let clusterMs = 0;
  const flush = () => {
    if (blocks.length === 0) return;
    clusters.push(
      element(ID.cluster, [element(ID.timecode, uint(clusterMs)), ...blocks]),
    );
    blocks = [];
  };
  for (const frame of frames) {
    const ms = Math.round(frame.timestampUs / 1000);
    if (blocks.length > 0 && frame.key && ms - clusterMs > 0) flush();
    else if (ms - clusterMs > MAX_CLUSTER_MS) flush();
    if (blocks.length === 0) clusterMs = ms;
    blocks.push(simpleBlock(frame, ms - clusterMs));
  }
  flush();

  const segment = element(ID.segment, [info, tracks, ...clusters]);
  return concat([header, segment]);
}

/** One frame, as a SimpleBlock: track number, its offset from the cluster's
 *  timestamp, a flag byte whose top bit marks a keyframe, then the frame. */
function simpleBlock(frame, relativeMs) {
  const head = new Uint8Array(4);
  head[0] = 0x80 | TRACK_NUMBER; // one-byte VINT
  head[1] = (relativeMs >> 8) & 0xff;
  head[2] = relativeMs & 0xff;
  head[3] = frame.key ? 0x80 : 0x00;
  return element(ID.simpleBlock, concat([head, frame.data]));
}

function element(id, payload) {
  const body = Array.isArray(payload) ? concat(payload) : payload;
  return concat([Uint8Array.from(id), vint(body.length), body]);
}

/** An EBML variable-length integer: a length marker bit in the leading byte,
 *  then the value in the 7 bits per byte that remain. */
function vint(value) {
  let length = 1;
  while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[0] |= 1 << (8 - length);
  return bytes;
}

/** An unsigned integer in as few big-endian bytes as it needs. */
function uint(value) {
  const bytes = [];
  let remaining = Math.max(0, Math.round(value));
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

function float64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

function ascii(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0x7f);
}

function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
