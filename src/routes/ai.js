/**
 * AI Routes - Streaming SSE Implementation
 * POST /v1/ai/continue    - AI story continuation (SSE)
 * POST /v1/ai/choices     - AI generate choices (SSE)
 * POST /v1/ai/outline     - AI generate story outline (SSE)
 * POST /v1/ai/polish      - AI polish text (SSE)
 * POST /v1/ai/check       - AI logic check (sync)
 */
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SYSTEM_PROMPT = `你是一位资深互动小说作家，擅长创作分支剧情。
风格指南：
- 修仙题材：古典仙侠风，文笔优美
- 都市题材：贴近现实，节奏明快
- 末日题材：紧张刺激，悬念迭起

规则：
1. 每个选择分支应通向不同结局
2. 保持剧情逻辑连贯
3. 避免血腥暴力内容
4. 单次续写不超过2000字
5. 每次生成3个分支选项供选择`;

function buildContinuePrompt(context, direction, genre) {
  return `前情：${context}\n方向：${direction}\n请续写剧情，要求：情节跌宕起伏，人物性格鲜明，不超过1500字。`;
}

function buildChoicesPrompt(context) {
  return `前情：${context}\n请根据上述剧情，生成3个合理的分支选择，每个选择控制在20字以内，用换行分隔。`;
}

function buildOutlinePrompt(genre, theme) {
  return `请为一部${genre}题材的互动小说生成大纲，包含：作品标题（20字内）、简介（200字内）、核心人物设定（3个）、故事主线分支（3条）、预计结局数（3-5个）。`;
}

function buildPolishPrompt(text) {
  return `请将以下文本润色，使文笔更优美流畅，保持原有剧情不变：\n\n${text}`;
}

// Proxy to MiniMax API with SSE streaming
async function streamMiniMax(messages, request, reply, eventName = 'chunk') {
  const apiKey = process.env.MINIMAX_API_KEY;
  const baseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1';

  if (!apiKey) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'MiniMax API key not configured' })}\n\n`);
    reply.raw.end();
    return;
  }

  try {
    const response = await fetch(`${baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'MiniMax-Text-01',
        messages,
        stream: true,
        max_tokens: 4096,
        temperature: 0.8
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: `AI API error: ${response.status}`, detail: errorText })}\n\n`);
      reply.raw.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            totalTokens++;
            reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify({ text: content })}\n\n`);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    reply.raw.write(`event: done\ndata: ${JSON.stringify({ total_tokens: totalTokens })}\n\n`);
    reply.raw.end();
  } catch (err) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    reply.raw.end();
  }
}

export default async function aiRoutes(fastify) {

  // Set SSE headers for all AI routes
  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  };

  // AI Story Continuation
  fastify.post('/continue', {
    schema: {
      body: {
        type: 'object',
        required: ['story_id', 'previous_content'],
        properties: {
          story_id: { type: 'string', format: 'uuid' },
          chapter_id: { type: 'string', format: 'uuid' },
          previous_content: { type: 'string' },
          direction: { type: 'string' },
          max_words: { type: 'integer', default: 1000 },
          temperature: { type: 'number', default: 0.8 }
        }
      }
    }
  }, async (request, reply) => {
    const { story_id, chapter_id, previous_content, direction = '继续剧情', max_words } = request.body;

    // Log to AI generation history
    if (request.user) {
      await pool.query(
        `INSERT INTO ai_generation_logs (author_id, story_id, chapter_id, prompt, model)
         VALUES ($1, $2, $3, $4, 'MiniMax-Text-01')`,
        [request.user.id, story_id, chapter_id, buildContinuePrompt(previous_content, direction, '')]
      );
    }

    reply.raw.writeHead(200, sseHeaders);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildContinuePrompt(previous_content, direction, '') }
    ];

    await streamMiniMax(messages, request, reply, 'chunk');
  });

  // AI Generate Choices
  fastify.post('/choices', {
    schema: {
      body: {
        type: 'object',
        required: ['previous_content'],
        properties: {
          previous_content: { type: 'string' },
          count: { type: 'integer', default: 3, minimum: 2, maximum: 5 }
        }
      }
    }
  }, async (request, reply) => {
    const { previous_content } = request.body;

    reply.raw.writeHead(200, sseHeaders);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildChoicesPrompt(previous_content) }
    ];

    await streamMiniMax(messages, request, reply, 'choice');
  });

  // AI Generate Outline
  fastify.post('/outline', {
    schema: {
      body: {
        type: 'object',
        required: ['genre', 'theme'],
        properties: {
          genre: { type: 'string' },
          theme: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { genre, theme } = request.body;

    reply.raw.writeHead(200, sseHeaders);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildOutlinePrompt(genre, theme) }
    ];

    await streamMiniMax(messages, request, reply, 'outline');
  });

  // AI Polish Text
  fastify.post('/polish', {
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { text } = request.body;

    reply.raw.writeHead(200, sseHeaders);

    const messages = [
      { role: 'system', content: '你是一位专业的中文写作润色专家，擅长提升文笔质量。' },
      { role: 'user', content: buildPolishPrompt(text) }
    ];

    await streamMiniMax(messages, request, reply, 'polish');
  });

  // AI Logic Check (synchronous)
  fastify.post('/check', {
    schema: {
      body: {
        type: 'object',
        required: ['chapters'],
        properties: {
          chapters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                content: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const apiKey = process.env.MINIMAX_API_KEY;
    const baseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1';

    if (!apiKey) {
      return reply.status(500).send({ success: false, error: 'MiniMax API key not configured' });
    }

    const { chapters } = request.body;
    const chaptersText = chapters.map((c, i) => `第${i + 1}章：${c.title}\n${c.content}`).join('\n\n');

    const response = await fetch(`${baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'MiniMax-Text-01',
        messages: [
          { role: 'system', content: '你是互动小说逻辑审查专家。请检查以下章节是否存在逻辑漏洞、剧情矛盾或人设崩坏，并给出修改建议。' },
          { role: 'user', content: chaptersText }
        ],
        max_tokens: 2048,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      return reply.status(502).send({ success: false, error: 'AI check failed' });
    }

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content || '';

    return { success: true, data: { analysis: result, tokens_used: data.usage?.total_tokens } };
  });
}
