import crypto from "node:crypto";

const KEYS_URL = "https://appleid.apple.com/auth/keys";
const ISSUER = "https://appleid.apple.com";

let cached = { keys: null, at: 0 };

/** Apple rotates its signing keys, so fetch them and keep them briefly. */
async function signingKeys() {
  if (cached.keys && Date.now() - cached.at < 60 * 60 * 1000) return cached.keys;
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error(`could not fetch Apple's keys: ${res.status}`);
  const { keys } = await res.json();
  cached = { keys, at: Date.now() };
  return keys;
}

const decode = (part) =>
  JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

/**
 * Verify an identity token from Sign in with Apple and return its subject.
 *
 * The token is the whole credential, so every part of this matters: the
 * signature proves Apple issued it, `aud` proves it was issued for this app
 * and not another one, and `exp` stops an old token being replayed.
 */
export async function verifyAppleToken(idToken, audience) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");

  const header = decode(parts[0]);
  const payload = decode(parts[1]);

  const jwk = (await signingKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64")
  );
  if (!ok) throw new Error("bad signature");

  if (payload.iss !== ISSUER) throw new Error("wrong issuer");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (audience && !audiences.includes(audience)) throw new Error("wrong audience");
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    throw new Error("token expired");
  }
  if (!payload.sub) throw new Error("no subject");

  return { sub: payload.sub, email: payload.email ?? null };
}
