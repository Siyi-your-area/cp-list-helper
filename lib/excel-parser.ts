/**
 * Excel 解析器
 *
 * 解析 CPP 心愿单 Excel 文件，提取摊位号、展品名称等字段。
 */

import * as XLSX from "xlsx";
import type { MatchInput } from "./types";

/**
 * Excel 列名映射（支持多种命名）
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  boothNumber: ["社团摊位号", "摊位号", "booth", "摊位"],
  productName: ["展品名称", "制品名称", "名称", "product", "展品"],
  author: ["作者", "author", "画师"],
  circleName: ["社团名称", "社团名", "circle", "circleName"],
};

/**
 * 在 sheet 的 header 行中找到目标列
 */
function findColumn(headers: string[], aliases: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]?.toString().trim() || "";
    for (const alias of aliases) {
      if (h === alias || h.includes(alias)) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * 解析已加载的工作表。独立于 FileReader，便于用真实 XLS/XLSX 二进制回归。
 */
export function parseExcelSheet(
  sheet: XLSX.WorkSheet,
  skipRows: number = 2
): MatchInput[] {
  const rawData: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
  });

  if (rawData.length < 2) return [];

  const searchRowCount = Math.min(rawData.length, Math.max(5, skipRows + 1));
  const headerIndex = rawData
    .slice(0, searchRowCount)
    .findIndex((row) =>
      findColumn(row || [], COLUMN_ALIASES.boothNumber) >= 0
      && findColumn(row || [], COLUMN_ALIASES.productName) >= 0
    );
  const headerRow = headerIndex >= 0 ? rawData[headerIndex] : [];
  const boothCol = findColumn(headerRow, COLUMN_ALIASES.boothNumber);
  const productCol = findColumn(headerRow, COLUMN_ALIASES.productName);
  const authorCol = findColumn(headerRow, COLUMN_ALIASES.author);
  const circleNameCol = findColumn(headerRow, COLUMN_ALIASES.circleName);

  if (boothCol >= 0 && productCol >= 0) {
    const items: MatchInput[] = [];
    for (let index = headerIndex + 1; index < rawData.length; index += 1) {
      const row = rawData[index];
      if (!row || row.length === 0) continue;

      const boothNumber = (row[boothCol] || "").toString().trim();
      const productName = (row[productCol] || "").toString().trim();
      const author = authorCol >= 0
        ? (row[authorCol] || "").toString().trim()
        : undefined;
      const circleName = circleNameCol >= 0
        ? (row[circleNameCol] || "").toString().trim()
        : undefined;

      if (boothNumber || productName) {
        items.push({
          boothNumber,
          productName,
          author: author || undefined,
          circleName: circleName || undefined,
        });
      }
    }
    return items;
  }

  // CPP 的真实导出可能把列名放在第 3 行；range=2 会以该行为表头。
  const jsonData = XLSX.utils.sheet_to_json(sheet, {
    range: skipRows,
  }) as Record<string, unknown>[];

  return jsonData
    .map((row) => {
      const boothNumber = row["社团摊位号"] || row["摊位号"] || "";
      const productName = row["展品名称"] || row["制品名称"] || "";
      const author = row["作者"] || row["画师"] || row["author"] || undefined;
      const circleName = row["社团名称"] || row["社团名"] || undefined;

      return {
        boothNumber: boothNumber.toString().trim(),
        productName: productName.toString().trim(),
        author: author?.toString().trim() || undefined,
        circleName: circleName?.toString().trim() || undefined,
      };
    })
    .filter((item) => item.boothNumber || item.productName);
}

export function parseExcelWorkbook(
  workbook: XLSX.WorkBook,
  skipRows: number = 2
): MatchInput[] {
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  return parseExcelSheet(workbook.Sheets[firstSheetName], skipRows);
}

/**
 * 解析 Excel 文件，返回匹配输入数组
 *
 * @param file Excel 文件 (File 对象)
 * @param skipRows 跳过的行数（默认 2，即从第 3 行开始读取数据）
 */
export async function parseExcelFile(
  file: File,
  skipRows: number = 2
): Promise<MatchInput[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        resolve(parseExcelWorkbook(workbook, skipRows));
      } catch (error) {
        reject(new Error("Excel 解析失败: " + (error as Error).message));
      }
    };

    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsBinaryString(file);
  });
}
