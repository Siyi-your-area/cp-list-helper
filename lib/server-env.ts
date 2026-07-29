import { getCloudflareContext } from "@opennextjs/cloudflare";

type RuntimeBindings = Record<string, unknown>;

export function selectServerEnvValue(
  cloudflareValue: unknown,
  processValue: string | undefined
): string | undefined {
  if (typeof cloudflareValue === "string" && cloudflareValue.length > 0) {
    return cloudflareValue;
  }
  return processValue || undefined;
}

export function getServerEnv(name: string): string | undefined {
  let cloudflareValue: unknown;
  try {
    const bindings = getCloudflareContext().env as unknown as RuntimeBindings;
    cloudflareValue = bindings[name];
  } catch {
    // Plain Next.js and CLI runtimes do not expose a Cloudflare request context.
  }
  return selectServerEnvValue(cloudflareValue, process.env[name]);
}

export function requireServerEnv(name: string): string {
  const value = getServerEnv(name);
  if (!value) throw new Error(`服务器缺少 ${name}`);
  return value;
}
