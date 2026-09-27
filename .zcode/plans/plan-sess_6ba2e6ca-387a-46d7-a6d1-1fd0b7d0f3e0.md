## Pemisahan final

1. **Tiga provider jelas**
   - `openai`: API key OpenAI biasa, tanpa browser OAuth.
   - `chatgpt`: login browser OAuth, tanpa paste-token form.
   - `codex`: import JSON `accessToken`/`refreshToken`, tanpa browser OAuth.
   - Provider lama `openai` yang sudah punya akun OAuth tetap didukung sebagai legacy agar routing existing tidak putus.

2. **Backend type/schema**
   - Tambah `chatgpt` ke `ProviderType`, provider create/update schema, backup schema, dashboard provider types.
   - Tambah preset `ChatGPT` (`type: chatgpt`, default name `chatgpt`) dan ubah preset `Codex` tetap `type: codex`.
   - `openai` catalog label kembali menjadi `OpenAI`.
   - Tambah helper provider-aware: ChatGPT/Codex/legacy OpenAI OAuth memakai transport Codex; API-key OpenAI tetap memakai OpenAI API.

3. **OAuth behavior**
   - Browser OAuth start hanya tampil untuk `chatgpt` dan legacy `openai`; provider `codex` tidak lagi menampilkan tombol browser login.
   - OAuth route menerima `chatgpt` selain legacy `openai`.
   - Account label hasil browser login menjadi `ChatGPT (email)`.
   - Codex JSON import tetap hanya valid untuk provider `codex`.
   - `POST /api/providers/:id/accounts` tetap menolak API-key account untuk `codex`; ChatGPT provider memakai browser OAuth.

4. **Routing/admin**
   - ChatGPT OAuth dan Codex imported OAuth diarahkan ke ChatGPT Codex Responses backend.
   - `openai` API-key account diarahkan ke `api.openai.com/v1`.
   - Warmup, quota, model sync, paid-plan gating, model test, dan startup checks memakai predicate transport Codex untuk `chatgpt`, `codex`, dan legacy `openai` OAuth.
   - Provider `chatgpt` dan `codex` tidak boleh memakai jalur API-key `/models`.

5. **Dashboard**
   - Provider cards terpisah: OpenAI, ChatGPT, Codex.
   - Add Account modal:
     - ChatGPT: hanya `Login with browser`.
     - Codex: hanya `Paste Codex JSON`.
     - OpenAI: `Single API key`/bulk API keys.
   - Quota/model plan UI memakai ChatGPT/Codex predicate, bukan `type === openai`.
   - Provider type selector menampilkan label manusiawi, termasuk `ChatGPT` dan `OpenAI Codex`.

6. **Tests/docs**
   - Tambah tests untuk provider type validation, ChatGPT OAuth start allowed, Codex browser OAuth rejected, Codex JSON import accepted, OpenAI API-key routing unchanged, and imported token mapping.
   - Update architecture, API, DB schema, and UI docs.
   - Jalankan `bun run typecheck`, `bun test test/`, dan `bun run build`.

Tidak menyentuh token OAuth yang sudah dikirim. Token tetap tidak masuk source code/test/log. Token tersebut sebaiknya direvoke/refresh setelah testing karena sudah terekspos di chat.