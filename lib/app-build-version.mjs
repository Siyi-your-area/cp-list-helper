import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 同一份源码的客户端和版本接口必须得到同一个版本号。
const SOURCE_DIRS = ["app", "components", "hooks", "lib", "public"];
const SOURCE_EXTENSIONS = /\.(css|gif|ico|jpe?g|js|jsx|mjs|png|svg|ts|tsx|webp)$/;

export function getAppBuildVersion(root = process.cwd()) {
  const hash = createHash("sha256");
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        hash.update(path.replaceAll("\\", "/"));
        hash.update(readFileSync(join(root, path)));
      }
    }
  };
  SOURCE_DIRS.forEach(walk);
  return hash.digest("hex").slice(0, 16);
}
