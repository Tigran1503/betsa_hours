// server.js
/* ------------------------------------------------------------------ */
/* 0. Imports & Grund­konfiguration                                   */
/* ------------------------------------------------------------------ */
import express       from 'express';
import dotenv        from 'dotenv';
import fetch         from 'node-fetch';
import formidable    from 'formidable';
import fs            from 'fs';
import FormData      from 'form-data';
import cookieParser  from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';
import path          from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

/* ------------------------------------------------------------------ */
/* 1. Konstanten & Helper                                             */
/* ------------------------------------------------------------------ */
const app  = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// erst DANACH die Routen definieren:
app.post('/auth/set', (req, res) => {
  const { access_token } = req.body || {};
  if (!access_token) return res.status(400).send('missing token');

  res.cookie('sb-access-token', access_token, {
    httpOnly : true,
    secure   : process.env.NODE_ENV === 'production',
    sameSite : 'lax',
    maxAge   : 60 * 60 * 1000         // 1 h
  });
  res.sendStatus(200);
});

app.post('/auth/logout', (_, res) => {
  res.clearCookie('sb-access-token', { sameSite:'lax' });
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

/* ---- Monday ------------------------------------------------------ */
const MONDAY_URL        = 'https://api.monday.com/v2';
const BOARD_ID          = process.env.BOARD_ID;          // Stunden-Board
const EXPENSES_BOARD_ID = process.env.EXPENSES_BOARD_ID; // Ausgaben-Board
const TOKEN             = process.env.MONDAY_API_TOKEN;

/* ---- Supabase ---------------------------------------------------- */
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

/* Helper */
const first = v => Array.isArray(v) ? v[0] : v;

/* ------------------------------------------------------------------ */
/* 2. Supabase-Client + Auth-Middleware                               */
/* ------------------------------------------------------------------ */
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }   // wir wollen nur Tokens prüfen
);

const requireAuth = async (req, res, next) => {
  const token = req.cookies['sb-access-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });

  req.user = data.user;          // User-Objekt für nachfolgende Routen
  next();
};

/* ------------------------------------------------------------------ */
/* 3. Routen für Login-/Logout-Cookie                                 */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* 4. Monday-Wrapper & Hilfsfunktionen                                */
/* ------------------------------------------------------------------ */
async function monday(query, variables = {}, label = '') {
  console.log(`\n🚧 monday(${label || 'no-label'})`);
  if (Object.keys(variables).length) console.log('   → Vars:', variables);
  console.log('   → Query:\n', query);

  const res  = await fetch(MONDAY_URL, {
    method : 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': TOKEN },
    body   : JSON.stringify({ query, variables })
  });
  const json = await res.json();

  if (json.errors) {
    console.error('   ❌ GraphQL-Response:\n', JSON.stringify(json, null, 2));
    throw new Error(JSON.stringify(json.errors));
  }
  console.log('   ✅ ok');
  return json.data;
}

/* ------------------------------------------------------------------ */
/* 5. Boards / Spalten cachen                                         */
/* ------------------------------------------------------------------ */
const boardColumns = {};  // { boardId: { Titel → { id, settings } } }

async function getBoardColumns(boardId) {
  if (boardColumns[boardId]) return boardColumns[boardId];

  const data = await monday(`
    query ($b:[ID!]) {
      boards(ids:$b){ columns{ id title settings_str } }
    }`, { b:[boardId] }, 'getBoardColumns');

  const map = {};
  for (const c of data.boards[0].columns)
    map[c.title] = { id: c.id, settings: JSON.parse(c.settings_str || '{}') };

  boardColumns[boardId] = map;
  console.log(`🗂  Board ${boardId}: ${Object.keys(map).length} Spalten gecached`);
  return map;
}

async function fetchAllItems(boardId) {
  let all = [], cursor = null, page = 1;
  do {
    const data = await monday(`
      query ($b:[ID!],$c:String){
        boards(ids:$b){
          items_page(limit:500,cursor:$c){
            items{ id name } cursor
          }
        }
      }`, { b:[boardId], c:cursor }, `items_page#${page}`);

    const slice = data.boards[0].items_page;
    all.push(...slice.items);
    cursor = slice.cursor;
    page++;
  } while (cursor);
  console.log(`📄 Board ${boardId}: ${all.length} Items geladen`);
  return all;
}

/* ------------------------------------------------------------------ */
/* 6. Initialisierung (Spalten-IDs u. s. w.)                          */
/* ------------------------------------------------------------------ */
const mainColumns     = {};   // Stunden-Board
const expenseColumns  = {};   // Ausgaben-Board
let   employeeBoardId = null;

async function init() {
  /* Stunden-Board */
  const cols = await getBoardColumns(BOARD_ID);
  Object.entries(cols).forEach(([t, o]) => (mainColumns[t] = o.id));

  /* Ausgaben-Board */
  if (!EXPENSES_BOARD_ID) throw new Error('❌ EXPENSES_BOARD_ID nicht definiert');
  const expCols = await getBoardColumns(EXPENSES_BOARD_ID);
  Object.entries(expCols).forEach(([t, o]) => (expenseColumns[t] = o.id));

  /* verlinktes Mitarbeiter-Board bestimmen */
  const mitSettings = cols['Mitarbeiter']?.settings;
  employeeBoardId =
        mitSettings?.boardIds?.[0] ||
        mitSettings?.linkedBoardIds?.[0] || null;

  if (!employeeBoardId) throw new Error('❌ Mitarbeiter-Board nicht gefunden');

  console.log('✅ Main-Columns   :', mainColumns);
  console.log('✅ Expense-Columns:', expenseColumns);
  console.log('✅ Employee Board :', employeeBoardId);
}

/* ------------------------------------------------------------------ */
/* 7. Express-Middleware                                              */
/* ------------------------------------------------------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

app.use(express.json());
app.use(express.urlencoded({ extended:true }));
app.use(cookieParser());

/* -------- Auth-Gate (WHITELIST) ----------------------------------- */
const authGate = async (req, res, next) => {
  if (req.method !== 'GET') return next();  // nur HTML-Abrufe prüfen

  // immer zugänglich:
  if (
    req.path.startsWith('/login.html')  ||
    req.path.startsWith('/register.html') ||
    req.path.startsWith('/favicon.ico') ||
    req.path.startsWith('/auth/') ||
    req.path.startsWith('/js/')  ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/img/') ||
    req.path.startsWith('/assets/')
  ) {
    return next();
  }

  // JWT-Cookie prüfen
  const token = req.cookies['sb-access-token'];
  if (!token) return res.redirect('/login.html');

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.redirect('/login.html');
  } catch (e) {
    return res.redirect('/login.html');
  }

  next();
};

app.use(authGate);                                   // ← zuerst Gate
app.use(express.static(path.join(__dirname, 'public'))); // danach Dateien

/* ------------------------------------------------------------------ */
/* 8. Öffentliche Routen                                              */
/* ------------------------------------------------------------------ */
app.get('/options/mitarbeiter', async (_, res) => {
  try {
    const items = await fetchAllItems(employeeBoardId);
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/options/project', async (req, res) => {
  const empId = req.query.mitarbeiterId;
  if (!empId) return res.status(400).json({ error: 'mitarbeiterId fehlt' });

  try {
    const empCols   = await getBoardColumns(employeeBoardId);
    const beteilCol = empCols['Beteiligung'];
    if (!beteilCol) throw new Error('Spalte „Beteiligung“ nicht gefunden');

    const projBoardId =
          beteilCol.settings?.boardIds?.[0] ||
          beteilCol.settings?.linkedBoardIds?.[0];
    if (!projBoardId) throw new Error('Projekt-Board-ID nicht ermittelbar');

    const data = await monday(`
      query ($item:[ID!],$rel:String!,$p:ID!){
        items(ids:$item){
          linked_items(link_to_item_column_id:$rel,linked_board_id:$p){ id name }
        }
      }`, { item:[empId], rel:beteilCol.id, p:projBoardId }, 'mitarbeiter+projekte');

    res.json({ items: data.items[0]?.linked_items || [] });
  } catch (e) {
    console.error('   ❌ Fehler:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* 9. Geschützte Routen (erfordern requireAuth)                       */
/* ------------------------------------------------------------------ */
app.post('/create-item', requireAuth, async (req, res) => {
  try {
    const itemName      = first(req.body.itemName);
    const startDate     = first(req.body.startDate);
    const endDate       = first(req.body.endDate);
    const pauseMins     = first(req.body.pauseMins);
    const projectId     = first(req.body.projectId);
    const mitarbeiterId = first(req.body.mitarbeiterId);

    if (![itemName, startDate, endDate, projectId, mitarbeiterId].every(Boolean))
      return res.status(400).json({ error: 'Pflichtfelder fehlen' });

    const toUtc = d => {
      const iso = new Date(d).toISOString();
      return { date: iso.slice(0,10), time: iso.slice(11,19) };
    };
    const s = toUtc(startDate);
    const e = toUtc(endDate);

    const vals = {
      [mainColumns['Anfang Datum']]  : { date: s.date, time: s.time },
      [mainColumns['Ende Datum']]    : { date: e.date, time: e.time },
      [mainColumns['Pause in Mins']] : pauseMins ? Number(pauseMins) : 0,
      [mainColumns['Projekt']]       : { item_ids:[Number(projectId)] },
      [mainColumns['Mitarbeiter']]   : { item_ids:[Number(mitarbeiterId)] }
    };

    const mutation = `
      mutation ($board:ID!, $name:String!, $vals:JSON!) {
        create_item(board_id:$board, item_name:$name, column_values:$vals){ id }
      }`;
    await monday(mutation,
      { board: BOARD_ID, name: itemName, vals: JSON.stringify(vals) },
      'create_item');

    res.redirect(303, '/thanks.html');
  } catch (err) {
    console.error(err);
    res.status(500).send('Interner Serverfehler');
  }
});

app.post('/create-expense', requireAuth, (req, res) => {
  const form = formidable({
    multiples       : true,
    keepExtensions  : true,
    allowEmptyFiles : true,
    filter : p => !(p.originalFilename === '' ||
                    (p.mimetype === 'application/octet-stream' && p.size === 0))
  });

  form.parse(req, async (err, fieldsMulti, files) => {
    if (err) return res.status(400).json({ error: 'Ungültige Formulardaten' });

    const clean = {
      itemName     : first(fieldsMulti.itemName),
      beschreibung : first(fieldsMulti.beschreibung),
      betrag       : first(fieldsMulti.betrag),
      projectId    : first(fieldsMulti.projectId),
      mitarbeiterId: first(fieldsMulti.mitarbeiterId)
    };

    if (![clean.itemName, clean.betrag, clean.projectId, clean.mitarbeiterId].every(Boolean))
      return res.status(400).json({ error: 'Pflichtfelder fehlen' });

    /* Spaltenwerte */
    const vals = {
      [expenseColumns['Beschreibung']]          : { text: clean.beschreibung || '' },
      [expenseColumns['Summe von Ausgabe [€]']] : clean.betrag.toString(),
      [expenseColumns['Projekt']]               : { item_ids:[Number(clean.projectId)] },
      [expenseColumns['Mitarbeiter']]           : { item_ids:[Number(clean.mitarbeiterId)] }
    };

    /* Item anlegen */
    let itemId;
    try {
      const mutation = `
        mutation ($board:ID!, $name:String!, $vals:JSON!) {
          create_item(board_id:$board, item_name:$name, column_values:$vals){ id }
        }`;
      const data = await monday(mutation,
        { board: EXPENSES_BOARD_ID, name: clean.itemName, vals: JSON.stringify(vals) },
        'create_expense');
      itemId = data.create_item.id;
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Fehler beim Anlegen des Items' });
    }

    /* Dateien hochladen (0-n) */
    const rawBeleg   = files.beleg ?? [];
    const belegFiles = Array.isArray(rawBeleg) ? rawBeleg : [rawBeleg];

    for (const bf of belegFiles.filter(f => f && f.size > 0)) {
      try {
        const fd = new FormData();

        fd.append(
          'query',
          `mutation ($file: File!, $item: ID!, $col: String!) {
             add_file_to_column(item_id:$item, column_id:$col, file:$file){ id }
           }`
        );
        fd.append(
          'variables',
          JSON.stringify({
            file : null,
            item : itemId,
            col  : expenseColumns['Beleg']
          })
        );
        fd.append('map', '{"file":["variables.file"]}');
        fd.append(
          'file',
          fs.createReadStream(bf.filepath),
          bf.originalFilename
        );

        const up     = await fetch('https://api.monday.com/v2/file', {
          method : 'POST',
          headers: { Authorization: TOKEN },
          body   : fd
        });
        const upJson = await up.json();
        console.log('Upload-Antwort:', JSON.stringify(upJson, null, 2));
        if (!upJson.data?.add_file_to_column?.id)
          throw new Error(JSON.stringify(upJson, null, 2));
      } catch (e) {
        console.error(`Beleg-Upload fehlgeschlagen (${bf.originalFilename}):`, e);
        return res.status(500).json({ error: 'Fehler beim Datei-Upload' });
      }
    }

    res.redirect(303, '/thanks.html');
  });
});

/* ------------------------------------------------------------------ */
/* 10. Server-Start                                                   */
/* ------------------------------------------------------------------ */
init()
  .then(() => app.listen(PORT, () =>
    console.log(`🚀  Server läuft auf http://localhost:${PORT}`)))
  .catch(e => {
    console.error('Startup-Fehler:', e);
    process.exit(1);
  });