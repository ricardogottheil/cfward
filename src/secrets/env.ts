import { SecretError, type SecretBackend } from './types.js'

/** `acme-client` -> `CFWARD_TOKEN_ACME_CLIENT` */
export function envVarFor(profile: string): string {
  return `CFWARD_TOKEN_${profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/**
 * Read-only. CI has no keychain and nobody to type a passphrase: the runner
 * injects the token as an environment variable and we read it. Writing here
 * makes no sense, and failing loudly beats pretending to persist something
 * that vanishes when the job ends.
 */
export class EnvBackend implements SecretBackend {
  readonly id = 'env' as const
  readonly writable = false

  async isAvailable(): Promise<boolean> {
    return true
  }

  async get(profile: string): Promise<string | null> {
    return process.env[envVarFor(profile)] ?? process.env.CLOUDFLARE_API_TOKEN ?? null
  }

  async set(): Promise<never> {
    throw new SecretError(
      'BACKEND_READONLY',
      'The environment backend is read-only.',
      'In CI, provide the token as a runner secret instead.',
    )
  }

  async delete(): Promise<boolean> {
    return false
  }
}
