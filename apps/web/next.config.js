// Security headers for every page. The CSP is deliberately conservative:
// Next.js app router needs inline bootstrap scripts ('unsafe-inline'), fonts
// come from Google Fonts (globals.css @import), logos are data: URIs, email
// images stream through the API's image proxy, and socket.io talks to the API
// origin over ws(s). img-src stays broad (https:) because R2/public hosts are
// env-dependent.
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const WS_ORIGIN = API_ORIGIN.replace(/^http/, 'ws');

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      `connect-src 'self' ${API_ORIGIN} ${WS_ORIGIN} https://fonts.googleapis.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Lets parallel dev servers use separate build dirs so they don't clobber each other's chunks
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
