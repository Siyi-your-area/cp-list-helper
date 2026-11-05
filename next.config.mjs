import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { getAppBuildVersion } from "./lib/app-build-version.mjs";

/** @type {import("next").NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_BUILD_VERSION: getAppBuildVersion(),
  },
};

initOpenNextCloudflareForDev();

export default nextConfig;
