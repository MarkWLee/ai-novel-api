import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

// Routes
import authRoutes from './routes/auth.js';
import storiesRoutes from './routes/stories.js';
import chaptersRoutes from './routes/chapters.js';
import aiRoutes from './routes/ai.js';
import { authenticate } from './middleware/auth.js';

const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
});

// Plugins
await fastify.register(cors, {
  origin: true,
  credentials: true
});

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'fallback-secret-do-not-use-in-prod'
});

await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
});

// Health check
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Public routes
fastify.register(authRoutes, { prefix: '/v1/auth' });
fastify.register(aiRoutes, { prefix: '/v1/ai' });

// Protected routes
fastify.register(async function protectedRoutes(f) {
  f.addHook('onRequest', authenticate);

  f.register(storiesRoutes, { prefix: '/v1/stories' });
  f.register(chaptersRoutes, { prefix: '/v1' });
});

// Start
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
