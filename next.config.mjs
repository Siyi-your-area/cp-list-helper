import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import("next").NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_BUILD_VERSION: new Date().toISOString(),
  },
};

initOpenNextCloudflareForDev();

export default nextConfig;
