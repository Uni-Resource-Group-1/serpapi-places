-- Operator-managed SerpApi credentials.
--
-- The API key can now be saved from Settings instead of requiring a redeploy.
-- The value is encrypted with AES-256-GCM before it reaches the database; only
-- the last four characters are stored in clear text for display. The server
-- never returns the key to the browser.
--
-- `serpapi_api_key_status` records the outcome of the last verification call:
--   valid | invalid | unverified | unreadable
-- `unreadable` means the ciphertext exists but the active encryption secret no
-- longer decrypts it (for example after rotating APP_ACCESS_KEY without a
-- dedicated SETTINGS_ENCRYPTION_KEY), and the operator must re-enter the key.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_api_key_cipher text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_api_key_last4 text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_api_key_updated_at timestamptz;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_api_key_updated_by text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_api_key_status text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_api_key_checked_at timestamptz;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_account_plan text;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS serpapi_account_searches_left integer;

ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_serpapi_key_status_valid;
ALTER TABLE app_settings ADD CONSTRAINT app_settings_serpapi_key_status_valid
  CHECK (serpapi_api_key_status IS NULL OR serpapi_api_key_status IN ('valid', 'invalid', 'unverified', 'unreadable'));
