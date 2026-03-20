-- =============================================
-- AI 互动小说平台 - 数据库建表 SQL
-- PostgreSQL 16
-- =============================================

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================
-- 用户表
-- =============================================
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone         VARCHAR(20) UNIQUE,
    nickname      VARCHAR(50) NOT NULL,
    avatar_url    TEXT,
    bio           VARCHAR(200),
    role          VARCHAR(20) DEFAULT 'reader',
    level         INT DEFAULT 1,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 作品表
-- =============================================
CREATE TABLE stories (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id     UUID NOT NULL REFERENCES users(id),
    title         VARCHAR(100) NOT NULL,
    cover_url     TEXT,
    description   TEXT,
    tags          TEXT[] DEFAULT '{}',
    status        VARCHAR(20) DEFAULT 'draft',
    chapter_count  INT DEFAULT 0,
    ending_count  INT DEFAULT 0,
    read_count    INT DEFAULT 0,
    like_count    INT DEFAULT 0,
    collect_count INT DEFAULT 0,
    is_paywalled  BOOLEAN DEFAULT false,
    price_chapter DECIMAL(5,2) DEFAULT 0,
    is_finished   BOOLEAN DEFAULT false,
    first_chapter_id UUID,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stories_author ON stories(author_id);
CREATE INDEX idx_stories_status ON stories(status);
CREATE INDEX idx_stories_tags ON stories USING GIN(tags);

-- =============================================
-- 章节表
-- =============================================
CREATE TABLE chapters (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id      UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    title         VARCHAR(100) NOT NULL,
    content       TEXT NOT NULL,
    order_index   INT NOT NULL,
    is_free       BOOLEAN DEFAULT true,
    is_ending     BOOLEAN DEFAULT false,
    word_count    INT DEFAULT 0,
    ai_generated  BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(story_id, order_index)
);

CREATE INDEX idx_chapters_story ON chapters(story_id);
CREATE INDEX idx_chapters_order ON chapters(story_id, order_index);

-- =============================================
-- 选择/分支表
-- =============================================
CREATE TABLE choices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id    UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    text          VARCHAR(500) NOT NULL,
    hint_text     VARCHAR(200),
    next_chapter_id UUID REFERENCES chapters(id),
    order_index   INT DEFAULT 0,
    is_locked     BOOLEAN DEFAULT false,
    unlock_condition JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_choices_chapter ON choices(chapter_id);

-- =============================================
-- 结局表
-- =============================================
CREATE TABLE endings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id      UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    title         VARCHAR(100) NOT NULL,
    description   TEXT,
    chapter_id    UUID REFERENCES chapters(id),
    unlock_count  INT DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_endings_story ON endings(story_id);

-- =============================================
-- 阅读进度表
-- =============================================
CREATE TABLE reading_progress (
    user_id       UUID NOT NULL REFERENCES users(id),
    story_id      UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    current_chapter_id UUID REFERENCES chapters(id),
    history       JSONB DEFAULT '[]',
    unlocked_endings UUID[] DEFAULT '{}',
    last_read_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, story_id)
);

CREATE INDEX idx_progress_user ON reading_progress(user_id);

-- =============================================
-- 收藏表
-- =============================================
CREATE TABLE favorites (
    user_id       UUID NOT NULL REFERENCES users(id),
    story_id      UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, story_id)
);

-- =============================================
-- 章节点赞/踩表
-- =============================================
CREATE TABLE chapter_votes (
    user_id       UUID NOT NULL REFERENCES users(id),
    chapter_id    UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    vote          SMALLINT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, chapter_id)
);

-- =============================================
-- 作品点赞表
-- =============================================
CREATE TABLE story_likes (
    user_id       UUID NOT NULL REFERENCES users(id),
    story_id      UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, story_id)
);

-- =============================================
-- 打赏表
-- =============================================
CREATE TABLE donations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id),
    story_id      UUID NOT NULL REFERENCES stories(id),
    author_id     UUID NOT NULL REFERENCES users(id),
    amount        DECIMAL(10,2) NOT NULL,
    message       VARCHAR(200),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_donations_author ON donations(author_id);

-- =============================================
-- 创作者信息表
-- =============================================
CREATE TABLE author_profiles (
    user_id       UUID PRIMARY KEY REFERENCES users(id),
    is_verified   BOOLEAN DEFAULT false,
    total_stories INT DEFAULT 0,
    total_reads  BIGINT DEFAULT 0,
    total_earnings DECIMAL(12,2) DEFAULT 0,
    withdrawal_balance DECIMAL(12,2) DEFAULT 0,
    bank_account  JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- AI 生成历史
-- =============================================
CREATE TABLE ai_generation_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id     UUID NOT NULL REFERENCES users(id),
    story_id      UUID REFERENCES stories(id),
    chapter_id    UUID REFERENCES chapters(id),
    prompt        TEXT NOT NULL,
    result        TEXT,
    model         VARCHAR(50),
    tokens_used   INT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_logs_author ON ai_generation_logs(author_id);
