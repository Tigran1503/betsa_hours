// server.js
import express    from 'express';
import dotenv     from 'dotenv';
import fetch      from 'node-fetch';
import formidable from 'formidable';
import fs         from 'fs';
import FormData   from 'form-data';

dotenv.config();

/* ------------------------------------------------------------------ */
/* 0. Konstanten & Helper                                             */
/* ------------------------------------------------------------------ */
const app        = express();
const PORT       = process.env.PORT || 3000;
const MONDAY_URL = 'https://api.monday.com/v2';
const BOARD_ID   = process.env.BOARD_ID;                 // Stunden-Board
const EXPENSES_BOARD_ID = process.env.EXPENSES_BOARD_ID; // Ausgaben-Board
const TOKEN      = process.env.MONDAY_API_TOKEN;

/** nimmt bei Arrays immer nur das erste Element */
const first = v => Array.isArray(v) ? v[0] : v;

/* ---------- Monday-Wrapper mit Logging ---------- */
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
/* 1. Board-Spalten cachen                                            */
/* ------------------------------------------------------------------ */
const boardColumns = {};  // { boardId: { Titel → { id, settings } } }

async function getBoardColumns(boardId) {
  if (boardColumns[boardId]) return boardColumns[boardId];

  const data = await monday(`
    query ($b:[ID!]) {
      boards(ids:$b){ columns{ id title settings_str } }
    }`, { b:[boardId] }, 'getBoardColumns');

  const map = {};
  for (const c of data.boards[0].columns) {
    map[c.title] = { id: c.id, settings: JSON.parse(c.settings_str || '{}') };
  }
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
/* 2. Initialisierung                                                 */
/* ------------------------------------------------------------------ */
const mainColumns    = {};   // Stunden-Board
const expenseColumns = {};   // Ausgaben-Board
let   employeeBoardId = null;

async function init() {
  /* Stunden-Board */
  const cols = await getBoardColumns(BOARD_ID);
  for (const [t, o] of Object.entries(cols)) mainColumns[t] = o.id;

  /* Ausgaben-Board */
  if (!EXPENSES_BOARD_ID) throw new Error('❌ EXPENSES_BOARD_ID nicht definiert');
  const expCols = await getBoardColumns(EXPENSES_BOARD_ID);
  for (const [t, o] of Object.entries(expCols)) expenseColumns[t] = o.id;

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
/* 3. Express-Setup                                                   */
/* ------------------------------------------------------------------ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

/* ---------- Dropdown: Mitarbeiter ---------- */
app.get('/options/mitarbeiter', async (_, res) => {
  try {
    const items = await fetchAllItems(employeeBoardId);
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Dropdown: Projekte je Mitarbeiter ---------- */
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
/* 4. Item anlegen (Stunden)                                          */
/* ------------------------------------------------------------------ */
app.post('/create-item', async (req, res) => {
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

/* ------------------------------------------------------------------ */
/* 5. Expense anlegen (inkl. mehrfacher Beleg-Upload)                 */
/* ------------------------------------------------------------------ */
app.post('/create-expense', (req, res) => {
  const form = formidable({
    /*  ⇢ mehrere Datei-Inputs pro Feld zulassen  */
    multiples: true,
    keepExtensions: true,
    allowEmptyFiles: true,
    filter: p => !(p.originalFilename === '' ||
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

    /* ---------- Spaltenwerte ---------- */
    const vals = {
      [expenseColumns['Beschreibung']]          : { text: clean.beschreibung || '' },
      [expenseColumns['Summe von Ausgabe [€]']] : clean.betrag.toString(),
      [expenseColumns['Projekt']]               : { item_ids:[Number(clean.projectId)] },
      [expenseColumns['Mitarbeiter']]           : { item_ids:[Number(clean.mitarbeiterId)] }
    };

    /* ---------- Item anlegen ---------- */
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

    /* ---------- Dateien hochladen (0-n Stück) ---------- */
    const rawBeleg = files.beleg ?? [];                       // kann fehlen
    const belegFiles = Array.isArray(rawBeleg) ? rawBeleg     // array v3
                                               : [rawBeleg];  // einzelnes Objekt

    for (const bf of belegFiles.filter(f => f && f.size > 0)) {
      try {
        const fd = new FormData();

        // 1) GraphQL-Query mit Variablen-Platzhaltern
        fd.append(
          'query',
          `mutation ($file: File!, $item: ID!, $col: String!) {
             add_file_to_column(item_id:$item, column_id:$col, file:$file){ id }
           }`
        );

        // 2) Variablen-Payload (file = null, wird via map ersetzt)
        fd.append(
          'variables',
          JSON.stringify({
            file : null,
            item : itemId,
            col  : expenseColumns['Beleg']
          })
        );

        // 3) map-Teil
        fd.append('map', '{"file":["variables.file"]}');

        // 4) eigentliche Datei
        fd.append(
          'file',
          fs.createReadStream(bf.filepath),
          bf.originalFilename
        );

        const up = await fetch('https://api.monday.com/v2/file', {
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
/* 6. Server-Start         <… unverändert …>                          */
/* ------------------------------------------------------------------ */
init()
  .then(() => app.listen(PORT, () =>
    console.log(`🚀  Server läuft auf http://localhost:${PORT}`)))
  .catch(e => {
    console.error('Startup-Fehler:', e);
    process.exit(1);
  });