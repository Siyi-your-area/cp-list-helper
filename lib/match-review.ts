import type { NormalizedCPPItem } from "./types";

const REVIEW_PREFIX = "待确认候选：";
const PENDING_BOOTH_LABEL = "摊位待公布";
const CANDIDATE_MARKER = /\s*\[\[CPP:(\d+)\]\]\s*$/;

export interface ReviewCandidateReference {
  boothNumber: string;
  productName: string;
  doujinshiId?: number;
}

export function buildReviewNote(candidate: NormalizedCPPItem): string {
  const marker = candidate.doujinshiId
    ? ` [[CPP:${candidate.doujinshiId}]]`
    : "";
  const boothLabel = candidate.boothNumber || PENDING_BOOTH_LABEL;
  return `${REVIEW_PREFIX}${boothLabel} · ${candidate.productName}${marker}`;
}

export function parseReviewNote(note?: string): ReviewCandidateReference | null {
  if (!note?.startsWith(REVIEW_PREFIX)) return null;

  const marker = note.match(CANDIDATE_MARKER);
  const visible = note.replace(CANDIDATE_MARKER, "").trim();
  const content = visible.slice(REVIEW_PREFIX.length);
  const separatorIndex = content.indexOf(" · ");
  if (separatorIndex < 0) return null;

  const boothLabel = content.slice(0, separatorIndex).trim();
  const boothNumber = boothLabel === PENDING_BOOTH_LABEL ? "" : boothLabel;
  const productName = content.slice(separatorIndex + 3).trim();
  if (!productName || (!boothNumber && !marker)) return null;

  return {
    boothNumber,
    productName,
    doujinshiId: marker ? Number(marker[1]) : undefined,
  };
}

export function getVisibleWishNote(note?: string): string {
  const visible = note?.replace(CANDIDATE_MARKER, "").trim() || "";
  if (!visible.startsWith(REVIEW_PREFIX)) return visible;

  const content = visible.slice(REVIEW_PREFIX.length);
  if (content.startsWith(" · ")) {
    return `${REVIEW_PREFIX}${PENDING_BOOTH_LABEL}${content}`;
  }
  return visible;
}
