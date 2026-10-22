import fs from 'node:fs';

// Application registration belongs to the launcher publisher, never the player.
const bundled = JSON.parse(fs.readFileSync(new URL('./microsoft-app.json', import.meta.url), 'utf8'));
export const microsoftClientId = String(process.env.CQU_PCL_MICROSOFT_CLIENT_ID || bundled.clientId || '').trim();
