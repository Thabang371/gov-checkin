import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { closeEvents } from './events.js';

const server = createApp().listen(config.port, () => {
  console.log(`gov-checkin API listening on port ${config.port}`);
});

// Cloud Run sends SIGTERM before stopping an instance
process.on('SIGTERM', () => {
  server.close(() => closeEvents().then(() => pool.end()).then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref(); // open event streams can hold close() open
});
