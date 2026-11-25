import express from 'express';
import helmet from 'helmet';
import { pool } from './db.js';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { visitsRouter } from './routes/visits.js';
import { sitesRouter } from './routes/sites.js';
import { personsRouter } from './routes/persons.js';
import { auditRouter } from './routes/audit.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Cloud Run sits behind one proxy; needed for real client IPs
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));

  app.get('/healthz', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api', visitsRouter); // /api/checkins, /api/checkouts
  app.use('/api/sites', sitesRouter);
  app.use('/api/persons', personsRouter);
  app.use('/api/audit', auditRouter);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body must be valid JSON' });
    console.error(err);
    res.status(500).json({ error: config.isProduction ? 'Something went wrong' : err.message });
  });

  return app;
}
