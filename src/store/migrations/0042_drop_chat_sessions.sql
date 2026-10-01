-- Drop the playground chat session tables. The dashboard's /dashboard/chat
-- page and the /api/chats admin endpoint have been removed; existing rows are
-- no longer reachable from the UI but kept wasting disk. Drop them outright.
-- chat_messages was created with ON DELETE CASCADE so the order doesn't matter.
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
