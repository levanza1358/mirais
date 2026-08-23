-- Drop the proxy pool feature. Migrations 0011/0012 created these tables; the
-- feature is removed entirely (scraper, admin routes, dashboard page), so the
-- tables and its settings row go with it.
DROP TABLE IF EXISTS proxy_assignments;
DROP TABLE IF EXISTS proxy_scrape_runs;
DROP TABLE IF EXISTS proxy_proxies;
DELETE FROM settings WHERE key = 'proxy_config';
