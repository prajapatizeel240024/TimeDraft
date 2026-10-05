import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg talks to Postgres over TCP and must stay a plain Node dependency.
  serverExternalPackages: ['pg'],
  // Next 16 otherwise writes a generated block into CLAUDE.md on every `next dev`.
  agentRules: false,
};

export default nextConfig;
