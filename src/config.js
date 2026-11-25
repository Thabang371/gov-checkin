import 'dotenv/config';

function required(name, devDefault) {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return devDefault;
}

export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 8080),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres@localhost:5432/govcheckin'),
  // Signs staff login tokens
  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  // Keyed hash for ID numbers. Changing it makes every stored person unfindable, so set it once.
  idHashSecret: required('ID_HASH_SECRET', 'dev-only-id-hash-secret-change-me'),
  // Signs the mock ID QR codes so a home-made QR is rejected
  qrSigningSecret: required('QR_SIGNING_SECRET', 'dev-only-qr-secret-change-me'),
  timezone: process.env.APP_TIMEZONE || 'Africa/Gaborone',
  tokenTtl: process.env.TOKEN_TTL || '8h',
};
