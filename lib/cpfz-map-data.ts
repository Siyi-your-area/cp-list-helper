// 坐标基于官方 1–4 馆原始 PNG，锚点是深色摊位矩形的中心，而非旁边每五号标注的数字。
// 每排从图上的 01 到末号逐格核对；没有连续小格的特装/创摊区域不推算。
export const CPFZ_MAP_ASPECT = 5669 / 2972;

type Row = {
  hall: string;
  letter: string;
  first: number;
  last: number;
  line1: number;
  line2: number;
  count: number;
  direction: "vertical" | "horizontal";
};

// 纵排：line1 = 01 一侧的 x，line2 = 末号一侧的 x；first/last = 首尾格中心 y。
const vertical = (hall: string, letters: string, pairs: number[][], first: number, last: number, count: number): Row[] =>
  [...letters].map((letter, index) => ({ hall, letter, first, last, line1: pairs[index][0], line2: pairs[index][1], count, direction: "vertical" }));

// 横排：line1/line2 = 上下排中心 y；first/last = 01 至中间号的左右格中心 x。
const horizontal = (hall: string, letter: string, first: number, last: number, line1: number, line2: number, count: number): Row =>
  ({ hall, letter, first, last, line1, line2, count, direction: "horizontal" });

const ROWS: Row[] = [
  ...vertical("壹", "ABCDEFGH", [[2842.5,2766.5],[2648.5,2572.5],[2457.5,2381.5],[2269.5,2193],[2028,1951.5],[1837,1761],[1648.5,1572.5],[1456.5,1380.5]], 905, 1270, 13),
  horizontal("壹", "I", 2657, 2201, 1463.5, 1539.5, 16),
  horizontal("壹", "J", 2627, 2201, 1651.5, 1727.5, 15),
  horizontal("壹", "K", 2596, 2201, 1842.5, 1918.5, 14),
  horizontal("壹", "L", 2020, 1564, 1463.5, 1539.5, 16),
  horizontal("壹", "M", 2020, 1594, 1651.5, 1727.5, 15),
  horizontal("壹", "N", 2020, 1625, 1842.5, 1918.5, 14),

  ...vertical("贰", "ABCDEFGHIJ", [[3220,3144],[3030.5,2954.5],[2840.5,2764.5],[2649.5,2573.5],[2461.5,2385],[2220,2144],[2029,1953],[1841,1764.5],[1650.5,1574.5],[1462.5,1386.5]], 919, 1284, 13),
  ...vertical("贰", "KLMNOPQR", [[3029.5,2953.5],[2840.5,2764.5],[2649.5,2573.5],[2461.5,2385],[2220,2144],[2029,1953],[1840.5,1764.5],[1651.5,1575.5]], 1487, 1913, 15),

  ...vertical("叁", "ABCD", [[3030.5,2954.5],[2840.5,2764.5],[2649.5,2573.5],[2461.5,2385]], 919, 1284, 13),
  ...vertical("叁", "E", [[2220,2143.5]], 949.5, 1284, 12),
  ...vertical("叁", "FG", [[2029,1953],[1840.5,1764.5]], 919, 1284, 13),
  ...vertical("叁", "H", [[1650.5,1574.5]], 888, 1284, 14),
  ...vertical("叁", "IJKL", [[3029.5,2953.5],[2840.5,2764.5],[2649.5,2573.5],[2461.5,2385]], 1487, 1730.5, 9),

  ...vertical("肆", "ABCDEF", [[2648.5,2572.5],[2457.5,2381.5],[2269.5,2193],[2028,1951.5],[1837,1761],[1648.5,1572.5]], 905, 1270, 13),
  ...vertical("肆", "GHIJKLMN", [[2838.5,2762.5],[2648.5,2572.5],[2457.5,2381.5],[2269,2193],[2028,1951.5],[1837.5,1761],[1648.5,1572.5],[1458.5,1382.5]], 1521, 1886, 13),
];

const ROW_BY_KEY = new Map(ROWS.map((row) => [`${row.hall}${row.letter}`, row]));

export type CpfzMapPoint = { hall: string; boothCode: string; x: number; y: number };

export function getCpfzMapPoint(boothCode: string): CpfzMapPoint | null {
  const match = /^([壹贰叁肆])([A-Z])(\d{1,2})$/.exec(boothCode.normalize("NFKC"));
  if (!match) return null;
  const [, hall, letter, rawNumber] = match;
  const number = Number(rawNumber);
  const row = ROW_BY_KEY.get(`${hall}${letter}`);
  if (!row || number < 1 || number > row.count * 2) return null;
  const side = number <= row.count ? 0 : 1;
  const offset = side === 0 ? number - 1 : number - row.count - 1;
  const t = offset / (row.count - 1);
  const rawWidth = hall === "贰" || hall === "叁" ? 5677 : 5669;
  if (row.direction === "vertical") {
    return { hall, boothCode, x: (side === 0 ? row.line1 : row.line2) / rawWidth, y: (row.first + (row.last - row.first) * (side === 0 ? t : 1 - t)) / 2972 };
  }
  return { hall, boothCode, x: (row.first + (row.last - row.first) * (side === 0 ? t : 1 - t)) / rawWidth, y: (side === 0 ? row.line1 : row.line2) / 2972 };
}
