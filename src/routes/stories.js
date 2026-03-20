/**
 * Stories CRUD Routes
 * GET  /v1/stories              - List stories
 * GET  /v1/stories/:id          - Get story detail
 * POST /v1/stories              - Create story
 * PUT  /v1/stories/:id          - Update story
 * DELETE /v1/stories/:id        - Delete story
 * POST /v1/stories/:id/publish  - Publish story
 * GET  /v1/stories/:id/stats    - Story statistics
 * POST /v1/stories/:id/like     - Like/unlike story
 */
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default async function storiesRoutes(fastify) {

  // List stories with pagination & filters
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          status: { type: 'string', enum: ['draft', 'published'] },
          tag: { type: 'string' },
          author_id: { type: 'string', format: 'uuid' },
          search: { type: 'string' },
          sort: { type: 'string', enum: ['recent', 'popular', 'hot'], default: 'recent' }
        }
      }
    }
  }, async (request) => {
    const { page = 1, limit = 20, status, tag, author_id, search, sort } = request.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE s.status = $1';
    let params = ['published'];
    let paramIdx = 2;

    if (status) { where += ` AND s.status = $${paramIdx++}`; params.push(status); }
    if (tag) { where += ` AND $${paramIdx++} = ANY(s.tags)`; params.push(tag); }
    if (author_id) { where += ` AND s.author_id = $${paramIdx++}`; params.push(author_id); }
    if (search) { where += ` AND (s.title ILIKE $${paramIdx++} OR s.description ILIKE $${paramIdx++})`; params.push(`%${search}%`, `%${search}%`); }

    let orderBy = 's.created_at DESC';
    if (sort === 'popular') orderBy = 's.like_count DESC';
    if (sort === 'hot') orderBy = 's.read_count DESC';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM stories s ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT s.*, u.nickname as author_name, u.avatar_url as author_avatar
       FROM stories s
       JOIN users u ON s.author_id = u.id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      params
    );

    return {
      success: true,
      data: {
        list: result.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
      }
    };
  });

  // Get story detail
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params;

    const story = await pool.query(
      `SELECT s.*, u.nickname as author_name, u.avatar_url as author_avatar
       FROM stories s JOIN users u ON s.author_id = u.id
       WHERE s.id = $1`,
      [id]
    );

    if (story.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Story not found' });
    }

    // Increment read count
    await pool.query('UPDATE stories SET read_count = read_count + 1 WHERE id = $1', [id]);

    // Check if liked by current user
    let is_liked = false;
    let is_favorited = false;
    if (request.user) {
      const like = await pool.query(
        'SELECT 1 FROM story_likes WHERE user_id = $1 AND story_id = $2',
        [request.user.id, id]
      );
      const fav = await pool.query(
        'SELECT 1 FROM favorites WHERE user_id = $1 AND story_id = $2',
        [request.user.id, id]
      );
      is_liked = like.rows.length > 0;
      is_favorited = fav.rows.length > 0;
    }

    return {
      success: true,
      data: {
        ...story.rows[0],
        is_liked,
        is_favorited
      }
    };
  });

  // Create story
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', maxLength: 100 },
          description: { type: 'string' },
          cover_url: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          is_paywalled: { type: 'boolean' },
          price_chapter: { type: 'number' }
        }
      }
    }
  }, async (request) => {
    const { title, description, cover_url, tags, is_paywalled, price_chapter } = request.body;

    const result = await pool.query(
      `INSERT INTO stories (author_id, title, description, cover_url, tags, is_paywalled, price_chapter)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [request.user.id, title, description, cover_url, tags || [], is_paywalled || false, price_chapter || 0]
    );

    return { success: true, data: result.rows[0] };
  });

  // Update story
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params;
    const { title, description, cover_url, tags, is_paywalled, price_chapter, is_finished } = request.body;

    // Verify ownership
    const check = await pool.query('SELECT author_id FROM stories WHERE id = $1', [id]);
    if (check.rows.length === 0) return reply.status(404).send({ success: false, error: 'Not found' });
    if (check.rows[0].author_id !== request.user.id) return reply.status(403).send({ success: false, error: 'Forbidden' });

    const result = await pool.query(
      `UPDATE stories SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        cover_url = COALESCE($3, cover_url),
        tags = COALESCE($4, tags),
        is_paywalled = COALESCE($5, is_paywalled),
        price_chapter = COALESCE($6, price_chapter),
        is_finished = COALESCE($7, is_finished),
        updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [title, description, cover_url, tags, is_paywalled, price_chapter, is_finished, id]
    );

    return { success: true, data: result.rows[0] };
  });

  // Delete story
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params;

    const check = await pool.query('SELECT author_id FROM stories WHERE id = $1', [id]);
    if (check.rows.length === 0) return reply.status(404).send({ success: false, error: 'Not found' });
    if (check.rows[0].author_id !== request.user.id) return reply.status(403).send({ success: false, error: 'Forbidden' });

    await pool.query('DELETE FROM stories WHERE id = $1', [id]);
    return { success: true, message: 'Story deleted' };
  });

  // Publish story
  fastify.post('/:id/publish', async (request, reply) => {
    const { id } = request.params;

    const check = await pool.query('SELECT author_id, title FROM stories WHERE id = $1', [id]);
    if (check.rows.length === 0) return reply.status(404).send({ success: false, error: 'Not found' });
    if (check.rows[0].author_id !== request.user.id) return reply.status(403).send({ success: false, error: 'Forbidden' });

    const result = await pool.query(
      `UPDATE stories SET status = 'published', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );

    return { success: true, data: result.rows[0] };
  });

  // Story stats
  fastify.get('/:id/stats', async (request, reply) => {
    const { id } = request.params;

    const story = await pool.query('SELECT * FROM stories WHERE id = $1', [id]);
    if (story.rows.length === 0) return reply.status(404).send({ success: false, error: 'Not found' });

    const chapters = await pool.query(
      'SELECT COUNT(*) as count FROM chapters WHERE story_id = $1', [id]
    );
    const endings = await pool.query(
      'SELECT COUNT(*) as count FROM endings WHERE story_id = $1', [id]
    );
    const likes = await pool.query(
      'SELECT COUNT(*) as count FROM story_likes WHERE story_id = $1', [id]
    );

    return {
      success: true,
      data: {
        read_count: story.rows[0].read_count,
        like_count: likes.rows[0].count,
        chapter_count: parseInt(chapters.rows[0].count, 10),
        ending_count: parseInt(endings.rows[0].count, 10),
        collect_count: story.rows[0].collect_count
      }
    };
  });

  // Like/unlike story
  fastify.post('/:id/like', async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;

    const existing = await pool.query(
      'SELECT 1 FROM story_likes WHERE user_id = $1 AND story_id = $2',
      [userId, id]
    );

    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM story_likes WHERE user_id = $1 AND story_id = $2', [userId, id]);
      await pool.query('UPDATE stories SET like_count = like_count - 1 WHERE id = $1', [id]);
      return { success: true, liked: false };
    } else {
      await pool.query('INSERT INTO story_likes (user_id, story_id) VALUES ($1, $2)', [userId, id]);
      await pool.query('UPDATE stories SET like_count = like_count + 1 WHERE id = $1', [id]);
      return { success: true, liked: true };
    }
  });
}
