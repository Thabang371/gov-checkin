// Imported first by every test so the app connects to the TEST database, never the real one.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a throwaway database before running tests (it gets wiped).');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
