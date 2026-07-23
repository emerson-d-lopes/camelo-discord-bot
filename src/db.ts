import { mkdirSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';

mkdirSync('data', { recursive: true });

export const db = new Database('data/bot.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    url TEXT NOT NULL,
    selector TEXT,
    title TEXT NOT NULL,
    currency TEXT,
    last_price REAL,
    target_price REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked TEXT
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS music_state (
    guild_id TEXT PRIMARY KEY,
    queue_json TEXT NOT NULL DEFAULT '[]',
    loop_mode TEXT NOT NULL DEFAULT 'off',
    autoplay INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    welcome_channel_id TEXT,
    welcome_message TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conv_channel ON conversations(channel_id, id);

  CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Additive migrations for columns introduced after first release.
const watchCols = (db.prepare(`PRAGMA table_info(watches)`).all() as { name: string }[]).map((c) => c.name);
if (!watchCols.includes('interval_minutes')) {
  db.exec(`ALTER TABLE watches ADD COLUMN interval_minutes INTEGER`);
}
if (!watchCols.includes('min_drop_pct')) {
  db.exec(`ALTER TABLE watches ADD COLUMN min_drop_pct REAL`);
}
if (!watchCols.includes('fail_count')) {
  db.exec(`ALTER TABLE watches ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`);
}
if (!watchCols.includes('fail_notified')) {
  db.exec(`ALTER TABLE watches ADD COLUMN fail_notified INTEGER NOT NULL DEFAULT 0`);
}

const settingsCols = (db.prepare(`PRAGMA table_info(guild_settings)`).all() as { name: string }[]).map(
  (c) => c.name,
);
if (!settingsCols.includes('music_channel_id')) {
  db.exec(`ALTER TABLE guild_settings ADD COLUMN music_channel_id TEXT`);
}
if (!settingsCols.includes('chat_channel_id')) {
  db.exec(`ALTER TABLE guild_settings ADD COLUMN chat_channel_id TEXT`);
}

export interface Watch {
  id: number;
  user_id: string;
  channel_id: string;
  url: string;
  selector: string | null;
  title: string;
  currency: string | null;
  last_price: number | null;
  target_price: number | null;
  created_at: string;
  last_checked: string | null;
  interval_minutes: number | null;
  min_drop_pct: number | null;
  fail_count: number;
  fail_notified: number;
}

const insertWatchStmt = db.prepare(`
  INSERT INTO watches (user_id, channel_id, url, selector, title, currency, last_price, target_price, interval_minutes, min_drop_pct)
  VALUES (@user_id, @channel_id, @url, @selector, @title, @currency, @last_price, @target_price, @interval_minutes, @min_drop_pct)
`);

export function insertWatch(
  w: Omit<Watch, 'id' | 'created_at' | 'last_checked' | 'fail_count' | 'fail_notified'>,
): number {
  return Number(insertWatchStmt.run(w).lastInsertRowid);
}

export function listWatches(userId: string): Watch[] {
  return db.prepare('SELECT * FROM watches WHERE user_id = ? ORDER BY id').all(userId) as Watch[];
}

export function allWatches(): Watch[] {
  return db.prepare('SELECT * FROM watches ORDER BY id').all() as Watch[];
}

/** Total watches across every user — for a process-wide abuse ceiling. */
export function totalWatches(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM watches').get() as { c: number }).c;
}

export function getWatch(id: number): Watch | undefined {
  return db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch | undefined;
}

export function deleteWatch(id: number): void {
  db.prepare('DELETE FROM watches WHERE id = ?').run(id);
}

export function updateWatchPrice(id: number, price: number, currency: string | null): void {
  db.prepare(
    `UPDATE watches SET last_price = ?, currency = COALESCE(?, currency), last_checked = datetime('now'), fail_count = 0, fail_notified = 0 WHERE id = ?`,
  ).run(price, currency, id);
  db.prepare('INSERT INTO price_history (watch_id, price) VALUES (?, ?)').run(id, price);
  // Cap history per watch — /history only reads the last 60.
  db.prepare(
    `DELETE FROM price_history WHERE watch_id = ? AND id NOT IN
       (SELECT id FROM price_history WHERE watch_id = ? ORDER BY id DESC LIMIT 200)`,
  ).run(id, id);
}

export function touchWatch(id: number): void {
  db.prepare(
    `UPDATE watches SET last_checked = datetime('now'), fail_count = 0, fail_notified = 0 WHERE id = ?`,
  ).run(id);
}

export function recordWatchFailure(id: number): number {
  db.prepare(
    `UPDATE watches SET last_checked = datetime('now'), fail_count = fail_count + 1 WHERE id = ?`,
  ).run(id);
  const row = db.prepare('SELECT fail_count FROM watches WHERE id = ?').get(id) as
    | { fail_count: number }
    | undefined;
  return row?.fail_count ?? 0;
}

export function markFailNotified(id: number): void {
  db.prepare('UPDATE watches SET fail_notified = 1 WHERE id = ?').run(id);
}

export interface PricePoint {
  price: number;
  checked_at: string;
}

export function priceHistory(watchId: number, limit = 60): PricePoint[] {
  return db
    .prepare('SELECT price, checked_at FROM price_history WHERE watch_id = ? ORDER BY id DESC LIMIT ?')
    .all(watchId, limit)
    .reverse() as PricePoint[];
}

// --- music persistence ---

export interface MusicState {
  queue_json: string;
  loop_mode: string;
  autoplay: number;
}

export function saveMusicState(
  guildId: string,
  queueJson: string,
  loopMode: string,
  autoplay: boolean,
): void {
  db.prepare(
    `INSERT INTO music_state (guild_id, queue_json, loop_mode, autoplay) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET queue_json = excluded.queue_json, loop_mode = excluded.loop_mode, autoplay = excluded.autoplay`,
  ).run(guildId, queueJson, loopMode, autoplay ? 1 : 0);
}

export function loadMusicState(guildId: string): MusicState | undefined {
  return db
    .prepare('SELECT queue_json, loop_mode, autoplay FROM music_state WHERE guild_id = ?')
    .get(guildId) as MusicState | undefined;
}

// --- reminders ---

export interface Reminder {
  id: number;
  user_id: string;
  channel_id: string;
  message: string;
  due_at: number;
}

export function insertReminder(r: Omit<Reminder, 'id'>): number {
  return Number(
    db
      .prepare('INSERT INTO reminders (user_id, channel_id, message, due_at) VALUES (?, ?, ?, ?)')
      .run(r.user_id, r.channel_id, r.message, r.due_at).lastInsertRowid,
  );
}

export function dueReminders(now: number): Reminder[] {
  return db.prepare('SELECT * FROM reminders WHERE due_at <= ?').all(now) as Reminder[];
}

export function listReminders(userId: string): Reminder[] {
  return db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at').all(userId) as Reminder[];
}

/** Total reminders across every user — for a process-wide abuse ceiling. */
export function totalReminders(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM reminders').get() as { c: number }).c;
}

export function getReminder(id: number): Reminder | undefined {
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | undefined;
}

export function deleteReminder(id: number): void {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
}

// --- guild settings ---

export interface GuildSettings {
  guild_id: string;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  music_channel_id: string | null;
  chat_channel_id: string | null;
}

export function getGuildSettings(guildId: string): GuildSettings | undefined {
  return db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as
    | GuildSettings
    | undefined;
}

export function setWelcome(guildId: string, channelId: string | null, message: string | null): void {
  db.prepare(
    `INSERT INTO guild_settings (guild_id, welcome_channel_id, welcome_message) VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET welcome_channel_id = excluded.welcome_channel_id, welcome_message = excluded.welcome_message`,
  ).run(guildId, channelId, message);
}

// --- play history (feeds recommendations) ---

let playInserts = 0;
export function recordPlay(guildId: string, userId: string, title: string): void {
  db.prepare('INSERT INTO play_history (guild_id, user_id, title) VALUES (?, ?, ?)').run(
    guildId,
    userId,
    title.slice(0, 300),
  );
  // Amortized pruning: keep the newest 5000 rows so the table can't grow without
  // bound under autoplay.
  if (++playInserts % 200 === 0) {
    db.prepare(
      `DELETE FROM play_history WHERE id NOT IN (SELECT id FROM play_history ORDER BY id DESC LIMIT 5000)`,
    ).run();
  }
}

/** Recent distinct titles for a user; falls back to the whole guild when the user has none. */
export function recentPlays(guildId: string, userId: string, limit = 15): string[] {
  const own = db
    .prepare(
      'SELECT DISTINCT title FROM play_history WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(guildId, userId, limit) as { title: string }[];
  if (own.length >= 3) return own.map((r) => r.title);
  const guild = db
    .prepare('SELECT DISTINCT title FROM play_history WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit) as { title: string }[];
  return guild.map((r) => r.title);
}

// --- per-channel conversation memory (for the AI chat surface) ---

// Kept until explicitly cleared, but capped so context stays fast and coherent.
const MAX_CONV_TURNS = 24;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function addConversationTurn(channelId: string, role: 'user' | 'assistant', content: string): void {
  db.prepare('INSERT INTO conversations (channel_id, role, content) VALUES (?, ?, ?)').run(
    channelId,
    role,
    content.slice(0, 2000),
  );
  db.prepare(
    `DELETE FROM conversations WHERE channel_id = ? AND id NOT IN
       (SELECT id FROM conversations WHERE channel_id = ? ORDER BY id DESC LIMIT ?)`,
  ).run(channelId, channelId, MAX_CONV_TURNS);
}

export function getConversation(channelId: string, limit = MAX_CONV_TURNS): ConversationTurn[] {
  return (
    db
      .prepare('SELECT role, content FROM conversations WHERE channel_id = ? ORDER BY id DESC LIMIT ?')
      .all(channelId, limit) as ConversationTurn[]
  ).reverse();
}

export function clearConversation(channelId: string): number {
  return db.prepare('DELETE FROM conversations WHERE channel_id = ?').run(channelId).changes;
}

/** Row counts and on-disk size for monitoring. */
export function dbStats(): {
  watches: number;
  reminders: number;
  playHistory: number;
  sizeBytes: number;
} {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  let sizeBytes = 0;
  try {
    // Include the WAL file — it can hold a lot before a checkpoint.
    sizeBytes = statSync('data/bot.db').size;
    try {
      sizeBytes += statSync('data/bot.db-wal').size;
    } catch {
      // no WAL file yet
    }
  } catch {
    // db not on disk yet
  }
  return {
    watches: count('watches'),
    reminders: count('reminders'),
    playHistory: count('play_history'),
    sizeBytes,
  };
}

export function setMusicChannel(guildId: string, channelId: string | null): void {
  db.prepare(
    `INSERT INTO guild_settings (guild_id, music_channel_id) VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET music_channel_id = excluded.music_channel_id`,
  ).run(guildId, channelId);
}

export function setChatChannel(guildId: string, channelId: string | null): void {
  db.prepare(
    `INSERT INTO guild_settings (guild_id, chat_channel_id) VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET chat_channel_id = excluded.chat_channel_id`,
  ).run(guildId, channelId);
}
