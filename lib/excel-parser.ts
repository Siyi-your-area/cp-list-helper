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
  author: ["作者", "社团名", "author", "画师"],
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
        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        // 先读取原始数据用于定位列
        const rawData: any[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          blankrows: false,
        });

        if (rawData.length < skipRows + 1) {
          resolve([]);
          return;
        }

        // 从 header 行（最后一行被跳过的行）找列位置
        const headerRow = rawData[skipRows - 1] || [];
        const boothCol = findColumn(headerRow, COLUMN_ALIASES.boothNumber);
        const productCol = findColumn(headerRow, COLUMN_ALIASES.productName);
        const authorCol = findColumn(headerRow, COLUMN_ALIASES.author);

        // 如果通过 header 找不到列，用 sheet_to_json 自动映射
        let items: MatchInput[];

        if (boothCol >= 0 && productCol >= 0) {
          // 手动按列位置解析
          items = [];
          for (let i = skipRows; i < rawData.length; i++) {
            const row = rawData[i];
            if (!row || row.length === 0) continue;

            const boothNumber = (row[boothCol] || "").toString().trim();
            const productName = (row[productCol] || "").toString().trim();
            const author = authorCol >= 0 ? (row[authorCol] || "").toString().trim() : undefined;

            if (boothNumber || productName) {
              items.push({
                boothNumber,
                productName,
                author: author || undefined,
              });
            }
          }
        } else {
          // 使用中文列名自动映射
          const jsonData = XLSX.utils.sheet_to_json(sheet, {
            range: skipRows,
          }) as any[];

          items = jsonData
            .map((row) => {
              const boothNumber =
                row["社团摊位号"] || row["摊位号"] || "";
              const productName =
                row["展品名称"] || row["制品名称"] || "";
              const author =
                row["作者"] || row["社团名"] || undefined;

              return {
                boothNumber: boothNumber.toString().trim(),
                productName: productName.toString().trim(),
                author: author?.toString().trim() || undefined,
              };
            })
            .filter((item) => item.boothNumber || item.productName);
        }

        resolve(items);
      } catch (error) {
        reject(new Error("Excel 解析失败: " + (error as Error).message));
      }
    };

    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsBinaryString(file);
  });
}
