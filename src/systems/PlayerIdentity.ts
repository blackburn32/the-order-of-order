// Who this device is to the global board, without a sign-in.
//
// The device keeps a random secret token. Writes to the board carry it in a
// header; the board stores and publishes only its hash, the member id. So the
// id printed beside a row — and shown to the player in Settings, for a deletion
// request — is safe to share, and cannot be used to post as them. The board
// derives the same id from the token (worker/src/index.ts, memberIdFor).
//
// Before tokens, the member id was a bare device UUID, which the board printed
// and which was the only thing a write needed. That UUID is kept, read-only,
// so the Hall can still recognise a row the device posted under it.

import { sha256Hex } from "./sha256";

const KEY_TOKEN = "ooo_player_token_v1";
const KEY_LEGACY_ID = "ooo_player_id_v1";

let ephemeralToken: string | null = null;
let cached: { token: string; memberId: string } | null = null;

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, unpadded: 43 characters, inside the board's token shape.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The device's secret. Never shown, never sent except as the write header. */
export function playerToken(): string {
  try {
    let token = localStorage.getItem(KEY_TOKEN);
    if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      token = newToken();
      localStorage.setItem(KEY_TOKEN, token);
    }
    return token;
  } catch {
    // Storage unavailable: a token for this session only.
    ephemeralToken ??= newToken();
    return ephemeralToken;
  }
}

/** The public member id for a token. */
export function memberIdForToken(token: string): string {
  return sha256Hex(`ooo-member:v1:${token}`).slice(0, 32);
}

/** This device's public member id. */
export function memberId(): string {
  const token = playerToken();
  if (cached?.token !== token)
    cached = { token, memberId: memberIdForToken(token) };
  return cached.memberId;
}

/** The pre-token device UUID, when this device had one, else "". */
export function legacyPlayerId(): string {
  try {
    return localStorage.getItem(KEY_LEGACY_ID) ?? "";
  } catch {
    return "";
  }
}

/** Start over as a new player: a fresh token, so a new member id. Used after
 *  the player deletes their record, so a later post is not tied to the old
 *  one. */
export function resetPlayerToken(): void {
  cached = null;
  ephemeralToken = null;
  try {
    localStorage.setItem(KEY_TOKEN, newToken());
  } catch {
    // non-fatal: the session token above is replaced on next use
  }
}
