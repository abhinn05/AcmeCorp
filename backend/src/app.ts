import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { corsOrigins, env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { api } from './routes/index.js';

/**
 * The Express application, kept separate from the server so that tests can
 * mount it without opening a port or starting the schedulers.
 */
export function createApp() {
  const app = express();

  // Behind a proxy the rate limiter needs the real client address, but trusting
  // every hop would let a client spoof it, so only the first is trusted.
  app.set('trust proxy', 1);

  app.use(helmet());
  // The API is called by a separate front end, so the allowed origins are
  // listed explicitly rather than reflecting whatever origin turns up.
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || corsOrigins.includes(origin)) callback(null, true);
        else callback(new Error('This origin is not allowed to call the API.'));
      },
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.NODE_ENV === 'test' ? 10_000 : 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests. Wait a moment and try again.' },
    }),
  );

  app.use('/api', api);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
