-- GamesPlot MySQL Schema
-- Designed from the current Games Plot project structure.
-- MySQL 8.x recommended.

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS gamesplot
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE gamesplot;

-- =========================================================
-- 1) USERS
-- id = Firebase Auth UID for the first migration phase.
-- Passwords are NOT stored here.
-- =========================================================
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(128) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    username VARCHAR(80) NULL,
    photo_url VARCHAR(2048) NULL,
    xp INT NOT NULL DEFAULT 0,
    role ENUM('user', 'admin', 'super_admin') NOT NULL DEFAULT 'user',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email),
    UNIQUE KEY uq_users_username (username),
    KEY idx_users_xp (xp),
    KEY idx_users_role (role)
) ENGINE=InnoDB;

-- =========================================================
-- 2) CATEGORIES
-- Firestore's "count" will be calculated by the API instead
-- of being stored, so it cannot get out of sync.
-- =========================================================
CREATE TABLE IF NOT EXISTS categories (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    img_url VARCHAR(2048) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),
    UNIQUE KEY uq_categories_name (name)
) ENGINE=InnoDB;

-- Default category used by the current site.
INSERT IGNORE INTO categories (name, img_url)
VALUES ('عام', NULL);

-- =========================================================
-- 3) QUESTIONS
-- =========================================================
CREATE TABLE IF NOT EXISTS questions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id VARCHAR(128) NOT NULL,
    category_id BIGINT UNSIGNED NULL,

    title VARCHAR(200) NOT NULL,

    -- Snapshot keeps the same behavior as the current Firestore data.
    author_name_snapshot VARCHAR(100) NOT NULL,

    likes_count INT UNSIGNED NOT NULL DEFAULT 0,
    dislikes_count INT UNSIGNED NOT NULL DEFAULT 0,

    best_answer_comment_id BIGINT UNSIGNED NULL,
    best_answer_user_id VARCHAR(128) NULL,

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_activity_at DATETIME(3) NULL,

    PRIMARY KEY (id),

    CONSTRAINT fk_questions_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_questions_category
        FOREIGN KEY (category_id) REFERENCES categories(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    CONSTRAINT fk_questions_best_user
        FOREIGN KEY (best_answer_user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    KEY idx_questions_user_created (user_id, created_at),
    KEY idx_questions_category_created (category_id, created_at),
    KEY idx_questions_created (created_at),
    KEY idx_questions_last_activity (last_activity_at),
    KEY idx_questions_score (likes_count, dislikes_count)
) ENGINE=InnoDB;

-- =========================================================
-- 4) COMMENTS + NESTED REPLIES
-- =========================================================
CREATE TABLE IF NOT EXISTS comments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    question_id BIGINT UNSIGNED NOT NULL,
    parent_id BIGINT UNSIGNED NULL,
    user_id VARCHAR(128) NOT NULL,

    user_name_snapshot VARCHAR(100) NOT NULL,
    text_content TEXT NULL,

    media_url VARCHAR(2048) NULL,
    media_type VARCHAR(30) NULL,

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),

    CONSTRAINT fk_comments_question
        FOREIGN KEY (question_id) REFERENCES questions(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_comments_parent
        FOREIGN KEY (parent_id) REFERENCES comments(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_comments_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    KEY idx_comments_question_created (question_id, created_at),
    KEY idx_comments_parent (parent_id),
    KEY idx_comments_user_created (user_id, created_at),

    -- Important for the current 60-second main-comment cooldown.
    KEY idx_comments_cooldown (
        question_id,
        user_id,
        parent_id,
        created_at
    )
) ENGINE=InnoDB;

-- Circular relation is added after comments exists.
-- Add the circular FK only once, so re-running this script is safe.
SET @fk_exists = (
    SELECT COUNT(*)
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'questions'
      AND CONSTRAINT_NAME = 'fk_questions_best_comment'
);
SET @fk_sql = IF(
    @fk_exists = 0,
    'ALTER TABLE questions ADD CONSTRAINT fk_questions_best_comment FOREIGN KEY (best_answer_comment_id) REFERENCES comments(id) ON UPDATE CASCADE ON DELETE SET NULL',
    'SELECT 1'
);
PREPARE fk_stmt FROM @fk_sql;
EXECUTE fk_stmt;
DEALLOCATE PREPARE fk_stmt;

-- =========================================================
-- 5) QUESTION VOTES
-- Current project stores the user's vote only in localStorage.
-- This table makes voting server-side and prevents duplicate votes.
-- =========================================================
CREATE TABLE IF NOT EXISTS question_votes (
    question_id BIGINT UNSIGNED NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    vote ENUM('up', 'down') NOT NULL,

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (question_id, user_id),

    CONSTRAINT fk_votes_question
        FOREIGN KEY (question_id) REFERENCES questions(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_votes_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    KEY idx_votes_user (user_id),
    KEY idx_votes_question_vote (question_id, vote)
) ENGINE=InnoDB;

-- =========================================================
-- 6) FAVORITE CATEGORIES
-- Replaces users.favorites array from Firestore.
-- =========================================================
CREATE TABLE IF NOT EXISTS user_favorite_categories (
    user_id VARCHAR(128) NOT NULL,
    category_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (user_id, category_id),

    CONSTRAINT fk_favorites_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_favorites_category
        FOREIGN KEY (category_id) REFERENCES categories(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    KEY idx_favorites_category (category_id)
) ENGINE=InnoDB;

-- =========================================================
-- 7) NOTIFICATIONS
-- =========================================================
CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    owner_id VARCHAR(128) NOT NULL,
    from_user_id VARCHAR(128) NULL,

    type VARCHAR(50) NOT NULL,
    from_user_name_snapshot VARCHAR(100) NULL,

    question_id BIGINT UNSIGNED NOT NULL,
    question_title_snapshot VARCHAR(200) NOT NULL,
    comment_id BIGINT UNSIGNED NULL,

    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),

    CONSTRAINT fk_notifications_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_notifications_from_user
        FOREIGN KEY (from_user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    CONSTRAINT fk_notifications_question
        FOREIGN KEY (question_id) REFERENCES questions(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_notifications_comment
        FOREIGN KEY (comment_id) REFERENCES comments(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    KEY idx_notifications_owner_time (owner_id, created_at),
    KEY idx_notifications_unread (owner_id, is_read, created_at),
    KEY idx_notifications_question (question_id)
) ENGINE=InnoDB;

-- =========================================================
-- 8) CATEGORY SUGGESTIONS
-- =========================================================
CREATE TABLE IF NOT EXISTS suggestions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id VARCHAR(128) NOT NULL,

    category_name VARCHAR(100) NOT NULL,
    user_name_snapshot VARCHAR(100) NOT NULL,

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),

    CONSTRAINT fk_suggestions_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    -- Same user cannot submit the exact same pending suggestion twice.
    UNIQUE KEY uq_suggestions_user_category (user_id, category_name),
    KEY idx_suggestions_created (created_at)
) ENGINE=InnoDB;

-- =========================================================
-- 9) REPORTS
-- target_id is VARCHAR because reports can later target comments,
-- questions or users without needing multiple nullable FK columns.
-- =========================================================
CREATE TABLE IF NOT EXISTS reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    target_id VARCHAR(128) NOT NULL,
    target_type VARCHAR(30) NOT NULL,

    reporter_user_id VARCHAR(128) NULL,
    reporter_name_snapshot VARCHAR(100) NOT NULL,

    reason VARCHAR(1000) NOT NULL,
    content_snippet VARCHAR(255) NULL,

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),

    CONSTRAINT fk_reports_reporter
        FOREIGN KEY (reporter_user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    KEY idx_reports_created (created_at),
    KEY idx_reports_target (target_type, target_id)
) ENGINE=InnoDB;

-- =========================================================
-- 10) ACTIVE RADAR / ADMIN ACTIVITY
-- =========================================================
CREATE TABLE IF NOT EXISTS active_radar (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id VARCHAR(128) NOT NULL,

    user_name_snapshot VARCHAR(100) NOT NULL,
    action VARCHAR(255) NOT NULL,

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),

    CONSTRAINT fk_radar_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    KEY idx_radar_created (created_at),
    KEY idx_radar_user_created (user_id, created_at)
) ENGINE=InnoDB;
