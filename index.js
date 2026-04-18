require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || path.join(__dirname, '..', '.secrets', 'squad-monitor-gcloud.json');
const SNAPSHOT_HOUR = parseInt(process.env.SNAPSHOT_HOUR || '23', 10);
const SNAPSHOT_MINUTE = parseInt(process.env.SNAPSHOT_MINUTE || '0', 10);
let sheetsApi;
async function getSheets() {
  if (sheetsApi) return sheetsApi;
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  sheetsApi = google.sheets({ version: 'v4', auth });
  return sheetsApi;
}
const counters = new Map();
function guildCounter(guildId) {
  if (!counters.has(guildId)) {
    counters.set(guildId, { messages: 0, voiceMinutes: 0, joins: 0, leaves: 0, creatorPosts: 0, activeUsers: new Set(), voiceSessions: new Map() });
  }
  return counters.get(guildId);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildPresences, GatewayIntentBits.MessageContent,
  ],
});
client.once('ready', () => {
  console.log(`[Squad Monitor] Logged in as ${client.user.tag}`);
  console.log(`[Squad Monitor] Monitoring ${client.guilds.cache.size} server(s):`);
  client.guilds.cache.forEach(g => console.log(`  - ${g.name} (${g.id}) — ${g.memberCount} members`));
  scheduleSnapshot();
});

client.on('messageCreate', (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const c = guildCounter(msg.guildId);
  c.messages++;
  c.activeUsers.add(msg.author.id);
  const member = msg.member;
  if (member) {
    const isOwner = msg.guild.ownerId === msg.author.id;
        const hasCreatorRole = member.roles.cache.some(r => /creator|founder|host|owner|squad.?lead/i.test(r.name));
    if (isOwner || hasCreatorRole) c.creatorPosts++;
  }
});

client.on('guildMemberAdd', (member) => { guildCounter(member.guild.id).joins++; });
client.on('guildMemberRemove', (member) => { guildCounter(member.guild.id).leaves++; });

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;
  const c = guildCounter(guildId);
  const odId = (newState.member || oldState.member)?.id;
  if (!odId) return;
  if (!oldState.channelId && newState.channelId) { c.voiceSessions.set(odId, Date.now()); c.activeUsers.add(odId); }
    if (oldState.channelId && !newState.channelId) {
    const joinTime = c.voiceSessions.get(odId);
    if (joinTime) { c.voiceMinutes += Math.round((Date.now() - joinTime) / 60000); c.voiceSessions.delete(odId); }
  }
});

async function takeSnapshot() {
  const sheets = await getSheets();
  const dateStr = new Date().toISOString().split('T')[0];
  const rows = [];
  for (const guild of client.guilds.cache.values()) {
    const c = counters.get(guild.id) || { messages: 0, voiceMinutes: 0, joins: 0, leaves: 0, creatorPosts: 0, activeUsers: new Set(), voiceSessions: new Map() };
    for (const [uid, joinTime] of c.voiceSessions.entries()) { c.voiceMinutes += Math.round((Date.now() - joinTime) / 60000); }
    rows.push([dateStr, guild.name, guild.id, guild.memberCount, c.activeUsers.size, c.messages, c.voiceMinutes, c.creatorPosts, c.joins, c.leaves]);
  }
    if (rows.length === 0) { console.log('[Squad Monitor] No guilds to snapshot.'); return; }
  try {
    await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: 'Daily Metrics!A:J', valueInputOption: 'USER_ENTERED', requestBody: { values: rows } });
    console.log(`[Squad Monitor] Snapshot written for ${rows.length} guild(s) on ${dateStr}`);
  } catch (err) { console.error('[Squad Monitor] Failed to write snapshot:', err.message); }
  for (const row of rows) {
    const [date, name, id, members, active, msgs, voice, creator, joins, leaves] = row;
    const alerts = [];
    if (creator === 0) alerts.push('Creator posted 0 messages today');
    if (msgs === 0) alerts.push('Zero messages in server today');
    if (leaves > joins && leaves >= 3) alerts.push(`Net negative: ${joins} joins vs ${leaves} leaves`);
    if (members > 5 && active / members < 0.05) alerts.push(`Lurker ratio critical: ${active}/${members} active (${(active/members*100).toFixed(1)}%)`);
    if (alerts.length > 0) {
      try {
        await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: 'Red Flags!A:D', valueInputOption: 'USER_ENTERED', requestBody: { values: alerts.map(a => [date, name, 'Auto', a]) } });
              } catch (err) { console.error('[Squad Monitor] Failed to write red flag:', err.message); }
    }
  }
  counters.clear();
}

function scheduleSnapshot() {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(SNAPSHOT_HOUR, SNAPSHOT_MINUTE, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const ms = target - now;
  console.log(`[Squad Monitor] Next snapshot at ${target.toISOString()} (in ${Math.round(ms/60000)} min)`);
  setTimeout(async () => { await takeSnapshot(); setInterval(takeSnapshot, 24 * 60 * 60 * 1000); }, ms);
}
client.on('messageCreate', async (msg) => {
  if (msg.content === '!snapshot' && msg.member?.permissions?.has('Administrator')) {
    await msg.reply('📸 Taking snapshot...'); await takeSnapshot(); await msg.reply('✅ Snapshot written to Google Sheet.');
  }
  if (msg.content === '!status' && msg.member?.permissions?.has('Administrator')) {
    const guilds = client.guilds.cache;
    let status = `**Squad Monitor Status**
Monitoring ${guilds.size} server(s):
`;
    for (const g of guilds.values()) { const c = counters.get(g.id); status += `• **${g.name}** — ${g.memberCount} members, ${c?.messages||0} msgs today, ${c?.activeUsers?.size||0} active
`; }
    await msg.reply(status);
  }
});
client.login(DISCORD_TOKEN);
