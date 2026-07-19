import type { NormalizedCPPItem } from "./types";

const REVIEW_PREFIX = "待确认候选：";
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
  return `${REVIEW_PREFIX}${candidate.boothNumber} · ${candidate.productName}${marker}`;
}

export function parseReviewNote(note?: string): ReviewCandidateReference | null {
  if (!note?.startsWith(REVIEW_PREFIX)) return null;

  const marker = note.match(CANDIDATE_MARKER);
  const visible = note.replace(CANDIDATE_MARKER, "").trim();
  const content = visible.slice(REVIEW_PREFIX.length);
  const separatorIndex = content.indexOf(" · ");
  if (separatorIndex < 0) return null;

  const boothNumber = content.slice(0, separatorIndex).trim();
  const productName = content.slice(separatorIndex + 3).trim();
  if (!boothNumber || !productName) return null;

  return {
    boothNumber,
    productName,
    doujinshiId: marker ? Number(marker[1]) : undefined,
  };
}

export function getVisibleWishNote(note?: string): string {
  return note?.replace(CANDIDATE_MARKER, "").trim() || "";
}
