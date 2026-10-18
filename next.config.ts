import type { NextConfig } from "next";

// GitHub Pages serves project sites from /<repository>/.
// Other hosts and local development should continue to use the site root.
const isGitHubPages = process.env.DEPLOY_TARGET === "github-pages";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: isGitHubPages ? "/my-reading-app" : undefined,
  images: { unoptimized: true },
};

export default nextConfig;
