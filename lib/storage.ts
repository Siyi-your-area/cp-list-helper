/**
 * LocalStorage 封装
 *
 * 提供类型安全的 CRUD 操作。
 */

import type { Exhibit } from "./types";

const STORAGE_KEY = "cp-exhibits";

/**
 * 获取所有展会
 */
export function getExhibits(): Exhibit[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/**
 * 保存所有展会
 */
export function saveExhibits(exhibits: Exhibit[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(exhibits));
}

/**
 * 获取单个展会
 */
export function getExhibit(id: string): Exhibit | null {
  const exhibits = getExhibits();
  return exhibits.find((e) => e.id === id) || null;
}

/**
 * 更新单个展会
 */
export function updateExhibit(id: string, updates: Partial<Exhibit>): Exhibit | null {
  const exhibits = getExhibits();
  const index = exhibits.findIndex((e) => e.id === id);
  if (index < 0) return null;

  exhibits[index] = {
    ...exhibits[index],
    ...updates,
    updatedAt: Date.now(),
  };
  saveExhibits(exhibits);
  return exhibits[index];
}

/**
 * 创建展会
 */
export function createExhibit(
  name: string,
  venue: string,
  date: string
): Exhibit {
  const exhibit: Exhibit = {
    id: Date.now().toString(),
    name,
    venue,
    date,
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const exhibits = getExhibits();
  exhibits.push(exhibit);
  saveExhibits(exhibits);
  return exhibit;
}

/**
 * 删除展会
 */
export function deleteExhibit(id: string): boolean {
  const exhibits = getExhibits();
  const filtered = exhibits.filter((e) => e.id !== id);
  if (filtered.length === exhibits.length) return false;
  saveExhibits(filtered);
  return true;
}
