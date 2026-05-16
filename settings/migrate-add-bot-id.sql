-- Migration: Add bot_id column to the settings table
-- This allows multiple bots to share the same MySQL database while keeping
-- their settings (prefix, volume, etc.) completely separate.
--
-- NOTE: The bot now auto-migrates on startup! You do NOT need to run this
-- file manually. It is kept here as a reference / manual fallback.
--
-- The auto-migration happens when setBotId() is called after Discord login:
--   1. Checks if bot_id column exists (via information_schema)
--   2. If not, adds the column as NOT NULL DEFAULT '' and updates the PK
--   3. If the column exists but isn't in the PK (broken migration from
--      previous version that used DEFAULT NULL), fixes the NULL values
--      and retries the PK update
--   4. Claims all legacy rows (bot_id = '') for the current bot
--
-- If you prefer to run it manually instead:
--   mysql -u <user> -p <database> < settings/migrate-add-bot-id.sql
--
-- After migration:
--   - Existing rows are claimed by the first bot to start (bot_id set to that bot's ID)
--   - New rows created by other bots will have their own bot_id
--   - The composite primary key (id, bot_id) allows the same guild to have
--     separate settings per bot
--
-- IMPORTANT: The bot_id column MUST be NOT NULL because MySQL does not allow
-- NULL values in primary key columns. The previous version used DEFAULT NULL
-- which caused ALTER TABLE ... ADD PRIMARY KEY to fail silently.

-- Step 1: Add bot_id column if it doesn't exist (NOT NULL DEFAULT '')
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS bot_id VARCHAR(32) NOT NULL DEFAULT '';

-- Step 2: If the column exists from a previous (broken) migration with
-- DEFAULT NULL, fix the NULL values and make it NOT NULL
UPDATE settings SET bot_id = '' WHERE bot_id IS NULL;
ALTER TABLE settings MODIFY COLUMN bot_id VARCHAR(32) NOT NULL DEFAULT '';

-- Step 3: Drop the old primary key (id) and create a composite one (id, bot_id)
-- We use a procedure because MySQL doesn't support IF EXISTS on ALTER TABLE ... DROP PRIMARY KEY
-- and we want this migration to be idempotent (safe to run multiple times).

DELIMITER //

DROP PROCEDURE IF EXISTS migrate_add_bot_id_pk //

CREATE PROCEDURE migrate_add_bot_id_pk()
BEGIN
  DECLARE pk_has_bot_id INT DEFAULT 0;

  -- Check if the current primary key already includes bot_id
  SELECT COUNT(*) INTO pk_has_bot_id
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'settings'
    AND COLUMN_KEY = 'PRI'
    AND COLUMN_NAME = 'bot_id';

  IF pk_has_bot_id = 0 THEN
    -- bot_id is not part of the primary key yet; safe to alter
    ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id);
  END IF;
END //

CALL migrate_add_bot_id_pk() //

DROP PROCEDURE IF EXISTS migrate_add_bot_id_pk //

DELIMITER ;

-- Step 4 (Optional): If you already know which bot owns which rows,
-- you can set bot_id manually. For example, if the existing rows belong
-- to a bot with ID "123456789012345678":
--   UPDATE settings SET bot_id = '123456789012345678' WHERE bot_id = '';
--
-- If you leave bot_id as '', the first bot to start will automatically
-- claim those rows via setBotId().
