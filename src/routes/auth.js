/**
 * User Authentication Routes
 * POST /v1/auth/phone/send-code
 * POST /v1/auth/phone/login
 * GET  /v1/auth/profile
 * PUT  /v1/auth/profile
 */
import { Pool } from 'pg';
import { randomInt } from 'crypto';
import Redis from 'ioredis';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

export default async function authRoutes(fastify) {

  // Send SMS verification code
  fastify.post('/phone/send-code', {
    schema: {
      body: {
        type: 'object',
        required: ['phone'],
        properties: { phone: { type: 'string', pattern: '^1[3-9]\\d{9}$' } }
      }
    }
  }, async (request, reply) => {
    const { phone } = request.body;
    const code = String(randomInt(100000, 999999));

    // Store code in Redis, expire in 5 minutes
    await redis.setex(`sms:code:${phone}`, 300, code);

    // In production, integrate with SMS provider (Aliyun/Tencent)
    fastify.log.info(`[DEV] SMS code for ${phone}: ${code}`);

    return {
      success: true,
      message: 'Verification code sent',
      // DEV ONLY: return code in response
      ...(process.env.NODE_ENV === 'development' && { code })
    };
  });

  // Phone + code login
  fastify.post('/phone/login', {
    schema: {
      body: {
        type: 'object',
        required: ['phone', 'code'],
        properties: {
          phone: { type: 'string' },
          code: { type: 'string', minLength: 6, maxLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    const { phone, code } = request.body;

    // Verify code (skip in dev mode for code '000000')
    if (code !== '000000') {
      const stored = await redis.get(`sms:code:${phone}`);
      if (!stored || stored !== code) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid verification code'
        });
      }
      await redis.del(`sms:code:${phone}`);
    }

    // Find or create user
    let user = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [phone]
    );

    if (user.rows.length === 0) {
      user = await pool.query(
        `INSERT INTO users (phone, nickname) VALUES ($1, $2) RETURNING *`,
        [phone, `用户${phone.slice(-4)}`]
      );
    }

    const userData = user.rows[0];

    // Generate JWT
    const token = fastify.jwt.sign({
      id: userData.id,
      phone: userData.phone,
      role: userData.role
    });

    return {
      success: true,
      data: {
        token,
        user: {
          id: userData.id,
          phone: userData.phone,
          nickname: userData.nickname,
          avatar_url: userData.avatar_url,
          role: userData.role,
          level: userData.level
        }
      }
    };
  });

  // Get current user profile
  fastify.get('/profile', async (request) => {
    const result = await pool.query(
      'SELECT id, phone, nickname, avatar_url, bio, role, level, created_at FROM users WHERE id = $1',
      [request.user.id]
    );
    return { success: true, data: result.rows[0] };
  });

  // Update profile
  fastify.put('/profile', {
    schema: {
      body: {
        type: 'object',
        properties: {
          nickname: { type: 'string', maxLength: 50 },
          avatar_url: { type: 'string' },
          bio: { type: 'string', maxLength: 200 }
        }
      }
    }
  }, async (request) => {
    const { nickname, avatar_url, bio } = request.body;
    const result = await pool.query(
      `UPDATE users SET
        nickname = COALESCE($1, nickname),
        avatar_url = COALESCE($2, avatar_url),
        bio = COALESCE($3, bio),
        updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [nickname, avatar_url, bio, request.user.id]
    );
    return { success: true, data: result.rows[0] };
  });

  // Apply to become an author
  fastify.post('/author/apply', async (request, reply) => {
    const userId = request.user.id;

    const existing = await pool.query(
      'SELECT * FROM author_profiles WHERE user_id = $1',
      [userId]
    );

    if (existing.rows.length > 0) {
      return reply.status(400).send({
        success: false,
        error: 'Already applied or is an author'
      });
    }

    await pool.query(
      `INSERT INTO author_profiles (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    await pool.query(
      `UPDATE users SET role = 'author' WHERE id = $1`,
      [userId]
    );

    return {
      success: true,
      message: 'Author application submitted successfully'
    };
  });
}
