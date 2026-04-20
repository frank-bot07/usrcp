const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), '.openclaw', 'workspace', 'usrcp-ledger.db');
const db = new Database(dbPath);

db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    stream TEXT,
    type TEXT,
    data TEXT,
    source TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

try {
    db.prepare(`INSERT INTO events (stream, type, data) VALUES (?, ?, ?)`).run(
        'global',
        'user_intent',
        '{"action":"test_cross_channel_memory","channels":"multiple","creator":"Chad"}'
    );

    db.prepare(`INSERT INTO events (stream, type, data, source) VALUES (?, ?, ?, ?)`).run(
        'global',
        'user_message',
        '{"content":"Quiet all of a sudden","sender":"Chad"}',
        'discord'
    );
} catch (e) {
    console.error("Insert error:", e.message);
}

const rows = db.prepare(`SELECT * FROM events WHERE stream='global' ORDER BY id`).all();
console.log(JSON.stringify({ table: 'events', count: rows.length, events: rows }, null, 2));
