/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Lets parallel dev servers use separate build dirs so they don't clobber each other's chunks
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

module.exports = nextConfig;
