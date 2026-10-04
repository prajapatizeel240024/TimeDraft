import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg talks to Postgres over TCP and must stay a plain Node dependency.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
