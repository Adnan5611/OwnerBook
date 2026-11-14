import { readSupabaseEnvironment } from '../src/config/environment';

const result = readSupabaseEnvironment({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL,
  publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
if (!result.ok) {
  console.error(
    result.reason === 'missing'
      ? `Missing environment variables: ${result.missing.join(', ')}. Copy .env.example to .env.`
      : 'Invalid Supabase configuration: use an HTTPS project URL and a publishable key or legacy anon JWT. Secret/service-role keys are forbidden.',
  );
  process.exitCode = 1;
} else {
  // Do not print even a public key into shared build logs.
  console.log('Supabase public environment configuration is valid. No live request was made.');
}
