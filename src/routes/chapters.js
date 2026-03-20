/**
 * Chapter CRUD Routes
 * GET  /v1/stories/:storyId/chapters       - List chapters
 * GET  /v1/chapters/:id                    - Get chapter detail
 * POST /v1/stories/:storyId/chapters       - Create chapter
 * PUT  /v1/chapters/:id                    - Update chapter
 * DELETE /v1/chapters/:id                  - Delete chapter
 * POST /v1/chapters/:id/choices             - Add/update choices
 * POST /v1/reading/progress                - Save reading progress
 * GET  /v1/reading/progress/:storyId        - Get reading progress
 * POST /v1/favorites/:storyId               - Favorite story
 * DELETE /v1/favorites/:storyId             - Unfavorite story
 * GET  /v1/favorites                       - List favorites
 */
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default async function chaptersRoutes(fastify) {

  // List chapters for a story
  fastify.get('/stories/:storyId/chapters', async (request) => {
    const { storyId } = request.params;

    const result = await pool.query(
      `SELECT id, story_id, title, order_index, is_free, is_ending, word_count, ai_generated, created_at
       FROM chapters WHERE story_id = $1 ORDER BY order_index`,
      [storyId]
    );

    return { success: true, data: result.rows };
  });

  // Get chapter detail with choices
  fastify.get('/chapters/:id', async (request, reply) => {
    const { id } = request.params;

    const chapter = await pool.query('SELECT * FROM chapters WHERE id = $1', [id]);
    if (chapter.rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Chapter not found' });
    }

    const choices = await pool.query(
      `SELECT c.*, ch.title as next_chapter_title
       FROM choices c
       LEFT JOIN chapters ch ON c.next_chapter_id = ch.id
       WHERE c.chapter_id = $1 ORDER BY c.order_index`,
      [id]
    );

    return {
      success: true,
      data: { ...chapter.rows[0], choices: choices.rows }
    };
  });

  // Create chapter
  fastify.post('/stories/:storyId/chapters', {
    schema: {
      body: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          title: { type: 'string', maxLength: 100 },
          content: { type: 'string' },
          order_index: { type: 'integer' },
          is_free: { type: 'boolean' },
          is_ending: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { storyId } = request.params;
    const { title, content, order_index, is_free, is_ending } = request.body;

    // Verify ownership
    const story = await pool.query('SELECT author_id FROM stories WHERE id = $1', [storyId]);
    if (story.rows.length === 0) return reply.status(404).send({ success: false, error: 'Story not found' });
    if (story.rows[0].author_id !== request.user.id) return reply.status(403).send({ success: false, error: 'Forbidden' });

    // Auto-assign order_index if not provided
    let orderIdx = order_index;
    if (orderIdx === undefined) {
      const maxOrder = await pool.query(
        'SELECT COALESCE(MAX(order_index), 0) as max FROM chapters WHERE story_id = $1',
        [storyId]
      );
      orderIdx = parseInt(maxOrder.rows[0].max, 10) + 1;
    }

    const wordCount = content.replace(/\s/g, '').length;

    const result = await pool.query(
      `INSERT INTO chapters (story_id, title, content, order_index, is_free, is_ending, word_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [storyId, title, content, orderIdx, is_free ?? true, is_ending ?? false, wordCount]
    );

    // Update story's first_chapter_id if first chapter
    if (orderIdx === 1) {
      await pool.query(
        'UPDATE stories SET first_chapter_id = $1, chapter_count = chapter_count + 1 WHERE id = $2',
        [result.rows[0].id, storyId]
      );
    } else {
      await pool.query(
        'UPDATE stories SET chapter_count = chapter_count + 1 WHERE id = $1',
        [storyId]
      );
    }

    // If ending chapter, update story ending_count
    if (is_ending) {
      await pool.query(
        'UPDATE stories SET ending_count = ending_count + 1 WHERE id = $1',
        [storyId]
      );
    }

    return { success: true, data: result.rows[0] };
  });

  // Update chapter
  fastify.put('/chapters/:id', async (request, reply) => {
    const { id } = request.params;
    const { title, content, is_free, is_ending } = request.body;

    const chapter = await pool.query('SELECT story_id FROM chapters WHERE id = $1', [id]);
    if (chapter.rows.length === 0) return reply.status(404).send({ success: false, error: 'Not found' });

    const story = await pool.query('SELECT author_id FROM stories WHERE id = $1', [chapter.rows[0].story_id]);
    if (story.rows[0].author_id !== request.user.id) return reply.status(403).send({ success: false, error: 'Forbidden' });

    const wordCount = content ? content.replace(/\s/g, '').length : undefined;

    const result = await pool.query(
      `UPDATE chapters SET
        title = COALESCE($1, title),
        content = COALESCE($2, content),
        is_free = COALESCE($3, is_free),
        is_ending = COALESCE($4, is_ending),
        word_count = COALESCE($5, word_count),
        updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [title, content, is_free, is_ending, wordCount, id]
    );

    return { success: true, data: result.rows[0] };
  });

  // Delete chapter
  fastify.delete('/chapters/:id', async (request, reply) => {
    const { id } = request.params;

    const chapter = await pool.query('SELECT story_id, order_index FROM chapters WHERE id = $1', [id]);
    if (chapter.rows.length === 0) return reply.status(404).send({ success: false, error: 'Not found' });

    const story = await pool.query('SELECT author_id FROM stories WHERE id = $1', [chapter.rows[0].story_id]);
    if (story.rows[0].author_id !== request.user.id) return reply.status(403).send({ success: false, error: 'Forbidden' });

    await pool.query('DELETE FROM chapters WHERE id = $1', [id]);
    await pool.query(
      'UPDATE stories SET chapter_count = chapter_count - 1 WHERE id = $1',
      [chapter.rows[0].story_id]
    );

    return { success: true, message: 'Chapter deleted' };
  });

  // Add/update choices for a chapter
  fastify.post('/chapters/:id/choices', {
    schema: {
      body: {
        type: 'object',
        properties: {
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                hint_text: { type: 'string' },
                next_chapter_id: { type: 'string' },
                order_index: { type: 'integer' },
                is_locked: { type: 'boolean' },
                unlock_condition: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { choices } = request.body;

    const chapter = await pool.query('SELECT story_id FROM chapters WHERE id = $1', [id]);
    if (chapter.rows.length === 0) return reply.status(404).send({ success: false, error: 'Not found' });

    const story = await pool.query('SELECT author_id FROM stories WHERE id = $1', [chapter.rows[0].story_id]);
    if (story.rows[0].author_id !== request.user.id) return reply.status(403).send({ success: false, error: 'Forbidden' });

    // Delete existing choices
    await pool.query('DELETE FROM choices WHERE chapter_id = $1', [id]);

    // Insert new choices
    if (choices && choices.length > 0) {
      for (const c of choices) {
        await pool.query(
          `INSERT INTO choices (chapter_id, text, hint_text, next_chapter_id, order_index, is_locked, unlock_condition)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, c.text, c.hint_text, c.next_chapter_id, c.order_index ?? 0, c.is_locked ?? false, c.unlock_condition]
        );
      }
    }

    return { success: true, message: 'Choices updated' };
  });

  // Save reading progress
  fastify.post('/reading/progress', async (request) => {
    const { story_id, chapter_id, history } = request.body;
    const userId = request.user.id;

    await pool.query(
      `INSERT INTO reading_progress (user_id, story_id, current_chapter_id, history, last_read_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, story_id) DO UPDATE SET
         current_chapter_id = $3,
         history = $4,
         last_read_at = NOW()`,
      [userId, story_id, chapter_id, JSON.stringify(history || [])]
    );

    return { success: true };
  });

  // Get reading progress
  fastify.get('/reading/progress/:storyId', async (request) => {
    const { storyId } = request.params;

    const result = await pool.query(
      'SELECT * FROM reading_progress WHERE user_id = $1 AND story_id = $2',
      [request.user.id, storyId]
    );

    return { success: true, data: result.rows[0] || null };
  });

  // Favorite/unfavorite story
  fastify.post('/favorites/:storyId', async (request, reply) => {
    const { storyId } = request.params;
    const userId = request.user.id;

    const existing = await pool.query(
      'SELECT 1 FROM favorites WHERE user_id = $1 AND story_id = $2',
      [userId, storyId]
    );

    if (existing.rows.length > 0) {
      return reply.status(400).send({ success: false, error: 'Already favorited' });
    }

    await pool.query(
      'INSERT INTO favorites (user_id, story_id) VALUES ($1, $2)',
      [userId, storyId]
    );
    await pool.query(
      'UPDATE stories SET collect_count = collect_count + 1 WHERE id = $1',
      [storyId]
    );

    return { success: true, favorited: true };
  });

  // Unfavorite story
  fastify.delete('/favorites/:storyId', async (request) => {
    const { storyId } = request.params;

    await pool.query(
      'DELETE FROM favorites WHERE user_id = $1 AND story_id = $2',
      [request.user.id, storyId]
    );
    await pool.query(
      'UPDATE stories SET collect_count = GREATEST(collect_count - 1, 0) WHERE id = $1',
      [storyId]
    );

    return { success: true, favorited: false };
  });

  // List my favorites
  fastify.get('/favorites', async (request) => {
    const { page = 1, limit = 20 } = request.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const result = await pool.query(
      `SELECT s.*, f.created_at as favorited_at
       FROM favorites f
       JOIN stories s ON f.story_id = s.id
       WHERE f.user_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [request.user.id, limit, offset]
    );

    return { success: true, data: result.rows };
  });
}
