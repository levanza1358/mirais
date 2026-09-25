-- ChatGPT OAuth and OpenAI API-key accounts are one logical provider.
UPDATE providers SET type = 'openai', updated_at = datetime('now') WHERE type = 'chatgpt';