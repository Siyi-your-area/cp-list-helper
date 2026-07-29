import { createHmac, randomUUID } from "node:crypto";
import { getServerEnv } from "@/lib/server-env";

const SHARE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function secret(): string {
  const value = getServerEnv("SHARE_CODE_SECRET");
  if (!value || value.length < 32) {
    throw new Error("服务器缺少至少 32 字符的 SHARE_CODE_SECRET");
  }
  return value;
}

export function deriveShareCode(seed: string): string {
  const digest = createHmac("sha256", secret()).update(`code:${seed}`).digest();
  return Array.from(digest.subarray(0, 4), (byte) => SHARE_ALPHABET[byte % SHARE_ALPHABET.length]).join("");
}

export function hashShareCode(code: string): string {
  return createHmac("sha256", secret()).update(`lookup:${code}`).digest("hex");
}

export function hashClientIp(ip: string): string {
  return createHmac("sha256", secret()).update(`ip:${ip || "unknown"}`).digest("hex");
}

export function hashLegacyClientId(clientId: string): string {
  return createHmac("sha256", secret()).update(`legacy-client:${clientId}`).digest("hex");
}

export function newShareSeed(): string {
  return randomUUID();
}
