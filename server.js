const express = require('express');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3500;
const DB_PATH = path.join(__dirname, 'schedule.db');
const DAYS_HE = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    arrive TEXT NOT NULL,
    leave_time TEXT NOT NULL,
    note TEXT DEFAULT '',
    recurring INTEGER NOT NULL DEFAULT 0,
    recurring_day INTEGER DEFAULT NULL,
    recurring_group TEXT DEFAULT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    slot_id INTEGER,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    read_status INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    sender TEXT DEFAULT '',
    timestamp INTEGER NOT NULL,
    read_by_partner INTEGER NOT NULL DEFAULT 0,
    read_by_viewer INTEGER NOT NULL DEFAULT 0
  )`);
  // Migrate: add recurring columns if missing
  try { db.run('ALTER TABLE slots ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0'); } catch(e){}
  try { db.run('ALTER TABLE slots ADD COLUMN recurring_day INTEGER DEFAULT NULL'); } catch(e){}
  try { db.run('ALTER TABLE slots ADD COLUMN recurring_group TEXT DEFAULT NULL'); } catch(e){}
  persist();
  // Generate recurring slots for next 12 weeks
  generateRecurring();
}

function persist() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function query(sql, params) {
  if (params && params.length) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  }
  const rows = db.exec(sql);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = r[i]);
    return obj;
  });
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function generateRecurring() {
  // Find all recurring templates (the original slots with recurring=1)
  const templates = query('SELECT id, date, arrive, leave_time, note, recurring_day, recurring_group FROM slots WHERE recurring = 1 AND recurring_group IS NOT NULL');
  // Group by recurring_group to find the original
  const groups = {};
  for (const t of templates) {
    if (!groups[t.recurring_group]) groups[t.recurring_group] = t;
  }
  
  const today = new Date();
  today.setHours(0,0,0,0);
  
  for (const [groupId, tmpl] of Object.entries(groups)) {
    const dayOfWeek = tmpl.recurring_day;
    // Generate for next 12 weeks from today
    for (let w = 0; w < 12; w++) {
      const d = new Date(today);
      const diff = (dayOfWeek - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + diff + (w * 7));
      const dk = dateKey(d);
      
      // Check if slot already exists for this date+group
      const exists = query('SELECT id FROM slots WHERE date = ? AND recurring_group = ?', [dk, groupId]);
      if (exists.length) continue;
      
      // Check overlap
      const existing = query('SELECT arrive, leave_time FROM slots WHERE date = ?', [dk]);
      let overlap = false;
      for (const s of existing) {
        if (tmpl.arrive < s.leave_time && tmpl.leave_time > s.arrive) { overlap = true; break; }
      }
      if (overlap) continue;
      
      db.run('INSERT INTO slots (date, arrive, leave_time, note, recurring, recurring_day, recurring_group, updated_at) VALUES (?,?,?,?,1,?,?,?)',
        [dk, tmpl.arrive, tmpl.leave_time, tmpl.note || '', dayOfWeek, groupId, Date.now()]);
    }
  }
  persist();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE ──────────────────────────────────────────────
const clients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('data: {"type":"connected"}\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ─── Slots API ────────────────────────────────────────
app.get('/api/slots', (req, res) => {
  const rows = query('SELECT id, date, arrive, leave_time, note, recurring, recurring_group FROM slots ORDER BY date, arrive');
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.date]) grouped[r.date] = [];
    grouped[r.date].push({ id: r.id, arrive: r.arrive, leave: r.leave_time, note: r.note || '', recurring: r.recurring || 0, recurringGroup: r.recurring_group || null });
  }
  res.json(grouped);
});

app.post('/api/slots', (req, res) => {
  try {
    const { date, arrive, leave, note, recurring } = req.body;
    if (!date || !arrive || !leave) return res.status(400).json({ error: 'missing fields' });
    if (arrive >= leave) return res.status(400).json({ error: 'arrive must be before leave' });

    const existing = query('SELECT id, arrive, leave_time FROM slots WHERE date = ?', [date]);
    for (const s of existing) {
      if (arrive < s.leave_time && leave > s.arrive) return res.status(400).json({ error: 'overlap', with: s });
    }

    const now = Date.now();
    const isRecurring = recurring ? 1 : 0;
    const parsedDate = new Date(date + 'T00:00:00');
    const dayOfWeek = parsedDate.getDay();
    const groupId = isRecurring ? `rec_${now}` : null;

    db.run('INSERT INTO slots (date, arrive, leave_time, note, recurring, recurring_day, recurring_group, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [date, arrive, leave, note || '', isRecurring, isRecurring ? dayOfWeek : null, groupId, now]);
    const id = query('SELECT last_insert_rowid() as id')[0].id;

    // If recurring, generate future slots
    if (isRecurring) generateRecurring();

    db.run('INSERT INTO notifications (date, action, detail, sender, timestamp) VALUES (?,?,?,?,?)',
      [date, 'add', `${arrive}–${leave}${isRecurring ? ' (קבוע)' : ''}`, 'partner', now]);
    persist();

    // Refetch all to broadcast
    const allSlots = query('SELECT id, date, arrive, leave_time, note, recurring, recurring_group FROM slots ORDER BY date, arrive');
    broadcast({ type: 'full_refresh', slots: allSlots });
    res.json({ ok: true, id });
  } catch(e) {
    console.error('POST /api/slots error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.put('/api/slots/:id', (req, res) => {
  try {
    const { arrive, leave, note, recurring } = req.body;
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    if (!arrive || !leave) return res.status(400).json({ error: 'missing fields' });
    if (arrive >= leave) return res.status(400).json({ error: 'arrive must be before leave' });

    const slot = query('SELECT date, recurring, recurring_group FROM slots WHERE id = ?', [id]);
    if (!slot.length) return res.status(404).json({ error: 'not found' });
    const date = slot[0].date;
    const wasRecurring = slot[0].recurring;
    const oldGroup = slot[0].recurring_group;
    const isRecurring = recurring !== undefined ? (recurring ? 1 : 0) : wasRecurring;

    const existing = query('SELECT id, arrive, leave_time FROM slots WHERE date = ? AND id != ?', [date, id]);
    for (const s of existing) {
      if (arrive < s.leave_time && leave > s.arrive) return res.status(400).json({ error: 'overlap', with: s });
    }

    const now = Date.now();
    const parsedDate = new Date(date + 'T00:00:00');
    const dayOfWeek = parsedDate.getDay();

    if (!wasRecurring && isRecurring) {
      // Changed from one-time to recurring — create group and generate future slots
      const groupId = `rec_${now}`;
      db.run('UPDATE slots SET arrive=?, leave_time=?, note=?, recurring=1, recurring_day=?, recurring_group=?, updated_at=? WHERE id=?',
        [arrive, leave, note || '', dayOfWeek, groupId, now, id]);
      generateRecurring();
    } else if (wasRecurring && !isRecurring) {
      // Changed from recurring to one-time — remove future slots in same group, clear group on this one
      if (oldGroup) {
        db.run('DELETE FROM slots WHERE recurring_group = ? AND date > ?', [oldGroup, date]);
      }
      db.run('UPDATE slots SET arrive=?, leave_time=?, note=?, recurring=0, recurring_day=NULL, recurring_group=NULL, updated_at=? WHERE id=?',
        [arrive, leave, note || '', now, id]);
    } else {
      // No change in recurring status
      db.run('UPDATE slots SET arrive=?, leave_time=?, note=?, updated_at=? WHERE id=?',
        [arrive, leave, note || '', now, id]);
    }

    db.run('INSERT INTO notifications (date, action, detail, sender, timestamp) VALUES (?,?,?,?,?)',
      [date, 'edit', `${arrive}–${leave}${isRecurring ? ' (קבוע)' : ''}`, 'partner', now]);
    persist();

    const allSlots = query('SELECT id, date, arrive, leave_time, note, recurring, recurring_group FROM slots ORDER BY date, arrive');
    broadcast({ type: 'full_refresh', slots: allSlots });
    res.json({ ok: true });
  } catch(e) {
    console.error('PUT error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.delete('/api/slots/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const deleteFuture = req.query.future === '1';
    const slot = query('SELECT date, arrive, leave_time, recurring, recurring_group FROM slots WHERE id = ?', [id]);
    if (!slot.length) return res.status(404).json({ error: 'not found' });
    const { date, arrive, leave_time, recurring, recurring_group } = slot[0];
    const now = Date.now();

    if (deleteFuture && recurring) {
      if (recurring_group) {
        // Has a group — delete all in group from this date forward
        db.run('DELETE FROM slots WHERE recurring_group = ? AND date >= ?', [recurring_group, date]);
      } else {
        // No group (e.g. imported) — match by day-of-week + same time + recurring flag
        const parsedDate = new Date(date + 'T00:00:00');
        const dayOfWeek = parsedDate.getDay();
        // Get all recurring slots on same weekday with same times, on or after this date
        const candidates = query(
          'SELECT id FROM slots WHERE recurring = 1 AND arrive = ? AND leave_time = ? AND date >= ?',
          [arrive, leave_time, date]
        );
        const matchIds = candidates
          .filter(c => { const d = new Date(c.date || date); return true; }) // all matching
          .map(c => c.id);
        // Delete matching slots that fall on the same weekday
        for (const cid of matchIds) {
          const cs = query('SELECT date FROM slots WHERE id = ?', [cid]);
          if (cs.length) {
            const cd = new Date(cs[0].date + 'T00:00:00');
            if (cd.getDay() === dayOfWeek) {
              db.run('DELETE FROM slots WHERE id = ?', [cid]);
            }
          }
        }
        // Also delete the current one in case it wasn't caught
        db.run('DELETE FROM slots WHERE id = ?', [id]);
      }
    } else {
      db.run('DELETE FROM slots WHERE id = ?', [id]);
    }

    db.run('INSERT INTO notifications (date, action, detail, sender, timestamp) VALUES (?,?,?,?,?)',
      [date, 'delete', `${arrive}–${leave_time}`, 'partner', now]);
    persist();
    const allSlots = query('SELECT id, date, arrive, leave_time, note, recurring, recurring_group FROM slots ORDER BY date, arrive');
    broadcast({ type: 'full_refresh', slots: allSlots });
    res.json({ ok: true });
  } catch(e) {
    console.error('DELETE error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// ─── Excel Export ─────────────────────────────────────
app.get('/api/export', async (req, res) => {
  try {
    const rows = query('SELECT date, arrive, leave_time, recurring FROM slots ORDER BY date, arrive');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('לו״ז משרד');

    ws.columns = [
      { header: 'תאריך', key: 'date', width: 14 },
      { header: 'יום בשבוע', key: 'day', width: 12 },
      { header: 'שעת התחלה', key: 'arrive', width: 14 },
      { header: 'שעת סיום', key: 'leave', width: 14 },
      { header: 'סוג', key: 'type', width: 14 },
    ];

    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' }, size: 12 };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0540F2' } };
    ws.getRow(1).alignment = { horizontal: 'center' };

    for (const r of rows) {
      const d = new Date(r.date + 'T00:00:00');
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const yyyy = d.getFullYear();
      ws.addRow({
        date: `${dd}/${mm}/${yyyy}`,
        day: DAYS_HE[d.getDay()],
        arrive: r.arrive,
        leave: r.leave_time,
        type: r.recurring ? 'קבוע' : 'חד פעמי',
      });
    }

    ws.eachRow((row, num) => {
      if (num > 1) {
        row.alignment = { horizontal: 'center' };
        if (num % 2 === 0) {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EEF3FF' } };
        }
      }
    });

    ws.views = [{ rightToLeft: true }];

    const arrayBuffer = await wb.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const filename = `office-schedule-${new Date().toISOString().slice(0,10)}.xlsx`;
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(buffer);
  } catch(e) {
    console.error('Export error:', e);
    res.status(500).send('Export failed');
  }
});

// ─── Excel Import ─────────────────────────────────────
app.post('/api/import', express.raw({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', limit: '10mb' }), async (req, res) => {
  try {
    const mode = req.query.mode || 'merge'; // 'merge' or 'rebuild'
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.body);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'no worksheet found' });

    let imported = 0, skipped = 0, deleted = 0, errors = [];
    const now = Date.now();

    // First, parse all rows from Excel into a clean list
    const excelSlots = [];
    ws.eachRow((row, num) => {
      if (num === 1) return;
      try {
        const vals = row.values;
        let rawDate = vals[1];
        let rawArrive = vals[3];
        let rawLeave = vals[4];
        const typeStr = String(vals[5] || '').trim();

        if (!rawDate || !rawArrive || !rawLeave) { skipped++; return; }

        let isoDate;
        if (rawDate instanceof Date) {
          const d = rawDate;
          isoDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        } else {
          const dateStr = String(rawDate).trim();
          if (dateStr.includes('/')) {
            const parts = dateStr.split('/');
            if (parts.length === 3) {
              const [dd, mm, yyyy] = parts;
              isoDate = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
            }
          } else if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
            isoDate = dateStr.slice(0, 10);
          }
        }
        if (!isoDate) { skipped++; return; }

        function parseTime(raw) {
          if (raw === null || raw === undefined) return null;
          if (raw instanceof Date) {
            return `${String(raw.getUTCHours()).padStart(2,'0')}:${String(raw.getUTCMinutes()).padStart(2,'0')}`;
          }
          if (typeof raw === 'number' && raw >= 0 && raw < 1) {
            const totalMinutes = Math.round(raw * 24 * 60);
            const h = Math.floor(totalMinutes / 60);
            const m = totalMinutes % 60;
            return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
          }
          const s = String(raw).trim();
          const match = s.match(/^(\d{1,2}):(\d{2})/);
          if (match) return `${match[1].padStart(2,'0')}:${match[2]}`;
          return null;
        }

        const arrive = parseTime(rawArrive);
        const leave = parseTime(rawLeave);
        if (!arrive || !leave) { skipped++; return; }
        if (arrive >= leave) { skipped++; return; }

        const isRecurring = (typeStr === 'קבוע') ? 1 : 0;
        excelSlots.push({ date: isoDate, arrive, leave, recurring: isRecurring });
      } catch(e) {
        errors.push(`שורה ${num}: ${e.message}`);
        skipped++;
      }
    });

    if (mode === 'rebuild') {
      // Delete all slots that are NOT in the Excel file
      const allExisting = query('SELECT id, date, arrive, leave_time FROM slots');
      for (const ex of allExisting) {
        const match = excelSlots.find(es => es.date === ex.date && es.arrive === ex.arrive && es.leave === ex.leave_time);
        if (!match) {
          db.run('DELETE FROM slots WHERE id = ?', [ex.id]);
          deleted++;
        }
      }
    }

    // Insert new slots from Excel (skip existing duplicates and overlaps)
    for (const es of excelSlots) {
      // Check if exact slot already exists
      const dup = query('SELECT id FROM slots WHERE date = ? AND arrive = ? AND leave_time = ?', [es.date, es.arrive, es.leave]);
      if (dup.length) { skipped++; continue; }

      // Check overlap
      const existing = query('SELECT arrive, leave_time FROM slots WHERE date = ?', [es.date]);
      let overlap = false;
      for (const s of existing) {
        if (es.arrive < s.leave_time && es.leave > s.arrive) { overlap = true; break; }
      }
      if (overlap) { skipped++; continue; }

      db.run('INSERT INTO slots (date, arrive, leave_time, note, recurring, recurring_day, recurring_group, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [es.date, es.arrive, es.leave, '', es.recurring, null, null, now]);
      imported++;
    }

    persist();

    const allSlots = query('SELECT id, date, arrive, leave_time, note, recurring, recurring_group FROM slots ORDER BY date, arrive');
    broadcast({ type: 'full_refresh', slots: allSlots });

    const detail = mode === 'rebuild'
      ? `בנייה מחדש: ${imported} יובאו, ${deleted} נמחקו`
      : `יובאו ${imported} רשומות`;
    db.run('INSERT INTO notifications (date, action, detail, sender, timestamp) VALUES (?,?,?,?,?)',
      ['import', 'import', detail, 'partner', now]);
    persist();

    res.json({ ok: true, imported, skipped, deleted, errors: errors.slice(0, 5) });
  } catch(e) {
    console.error('Import error:', e);
    res.status(500).json({ error: 'import failed: ' + e.message });
  }
});

// ─── Messages API ─────────────────────────────────────
app.get('/api/messages', (req, res) => {
  const rows = query('SELECT id, date, slot_id, sender, text, read_status, timestamp FROM messages ORDER BY timestamp DESC LIMIT 100');
  res.json(rows);
});

app.post('/api/messages', (req, res) => {
  try {
    const { date, slot_id, sender, text } = req.body;
    if (!date || !sender || !text) return res.status(400).json({ error: 'missing fields' });
    const now = Date.now();
    db.run('INSERT INTO messages (date, slot_id, sender, text, timestamp) VALUES (?,?,?,?,?)',
      [date, slot_id || null, sender, text, now]);
    const id = query('SELECT last_insert_rowid() as id')[0].id;
    db.run('INSERT INTO notifications (date, action, detail, sender, timestamp) VALUES (?,?,?,?,?)',
      [date, 'message', text, sender, now]);
    persist();
    broadcast({ type: 'message', msg: { id, date, slot_id: slot_id || null, sender, text, read_status: 0, timestamp: now } });
    res.json({ ok: true, id });
  } catch(e) {
    console.error('POST message error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/messages/read', (req, res) => {
  const { reader } = req.body;
  if (!reader) return res.status(400).json({ error: 'missing reader' });
  const otherSender = reader === 'partner' ? 'viewer' : 'partner';
  db.run('UPDATE messages SET read_status = 1 WHERE sender = ? AND read_status = 0', [otherSender]);
  persist();
  broadcast({ type: 'messages_read', reader });
  res.json({ ok: true });
});

// ─── Notifications API ───────────────────────────────
app.get('/api/notifications', (req, res) => {
  const rows = query('SELECT id, date, action, detail, sender, timestamp, read_by_partner, read_by_viewer FROM notifications ORDER BY timestamp DESC LIMIT 50');
  res.json(rows);
});

app.post('/api/notifications/read', (req, res) => {
  const { role } = req.body;
  if (role === 'partner') db.run('UPDATE notifications SET read_by_partner = 1');
  else db.run('UPDATE notifications SET read_by_viewer = 1');
  persist();
  res.json({ ok: true });
});

app.use((err, req, res, next) => { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); });
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => { console.log(`🏢 Office Schedule running at http://localhost:${PORT}`); });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
