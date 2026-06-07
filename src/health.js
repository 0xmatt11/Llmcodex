import express from 'express';
import pinoHttp from 'pino-http';

export function createHealthServer({ logger, store, discordClient }) {
  const app = express();
  app.use(pinoHttp({ logger }));

  app.get('/healthz', (_req, res) => {
    try {
      store.db.prepare('SELECT 1').get();
      res.json({
        ok: true,
        discordReady: Boolean(discordClient?.isReady?.()),
        uptimeSeconds: Math.round(process.uptime())
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return app;
}
