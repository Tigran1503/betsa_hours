// server.js
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app        = express();
const PORT       = process.env.PORT || 3000;
const MONDAY_URL = 'https://api.monday.com/v2';
const BOARD_ID   = process.env.BOARD_ID;
const TOKEN      = process.env.MONDAY_API_TOKEN;

// Caches
const columnIdByTitle   = {};
const columnMetaByTitle = {};

/** 1️⃣ Spalten‐Meta laden */
async function loadColumnIds() {
  const query = `
    query {
      boards(ids: ["${BOARD_ID}"]) {
        columns { id title settings_str }
      }
    }
  `;
  const resp = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': TOKEN },
    body: JSON.stringify({ query })
  });
  const { data, errors } = await resp.json();
  if (errors) throw errors;

  for (const col of data.boards[0].columns) {
    columnIdByTitle[col.title] = col.id;
    try {
      columnMetaByTitle[col.title] = JSON.parse(col.settings_str || '{}');
    } catch {
      columnMetaByTitle[col.title] = {};
    }
  }
  console.log('🎉 Spalten‐Meta geladen:', columnIdByTitle);
}

/** 2️⃣ Pagination für Items */
async function fetchAllItemsFromBoard(boardId) {
  let all = [], cursor = null;
  do {
    const q = `
      query {
        boards(ids: ["${boardId}"]) {
          items_page(limit: 500${cursor ? `, cursor: "${cursor}"` : ''}) {
            items { id name }
            cursor
          }
        }
      }
    `;
    const res = await fetch(MONDAY_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': TOKEN },
      body: JSON.stringify({ query: q })
    });
    const { data, errors } = await res.json();
    if (errors) throw errors;
    all.push(...data.boards[0].items_page.items);
    cursor = data.boards[0].items_page.cursor;
  } while (cursor);
  return all;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

/** 3️⃣ Optionen‐Endpoints */
app.get('/options/:which', async (req, res) => {
  const map = { project: 'Projekt', mitarbeiter: 'Mitarbeiter' };
  const title = map[req.params.which];
  if (!title) return res.status(404).end();

  try {
    const meta = columnMetaByTitle[title] || {};
    const linkedBoard = (meta.boardIds && meta.boardIds[0]) 
                      || (meta.linkedBoardIds && meta.linkedBoardIds[0]);
    if (!linkedBoard) throw new Error(`Linked‐Board für "${title}" nicht gefunden`);

    const items = await fetchAllItemsFromBoard(linkedBoard);
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  }
});

/** 4️⃣ Item‐Erstellen */
app.post('/create-item', async (req, res) => {
  try {
    const { itemName, startDate, endDate, pauseMins, projectId, mitarbeiterId } = req.body;
    if (![itemName, startDate, endDate, projectId, mitarbeiterId].every(Boolean)) {
      return res.status(400).json({ error: 'Alle Felder erforderlich' });
    }

    const START_ID = columnIdByTitle['Anfang Datum'];
    const END_ID   = columnIdByTitle['Ende Datum'];
    const PAUSE_ID = columnIdByTitle['Pause in Mins'];
    const PROJ_ID  = columnIdByTitle['Projekt'];
    const MIT_ID   = columnIdByTitle['Mitarbeiter'];

    const toUtc = local => {
      const dt = new Date(local);
      const iso = dt.toISOString();
      return { date: iso.slice(0,10), time: iso.slice(11,19) };
    };
    const s = toUtc(startDate), e = toUtc(endDate);

    // **Hier**: linkedPulseIds als Array von Objekten mit linkedPulseId
    const columnValues = {
      [START_ID]: { date: s.date, time: s.time },
      [END_ID]:   { date: e.date, time: e.time },
      [PAUSE_ID]: pauseMins.toString(),
      [PROJ_ID]:  { linkedPulseIds: [ { linkedPulseId: projectId } ] },
      [MIT_ID]:   { linkedPulseIds: [ { linkedPulseId: mitarbeiterId } ] }
    };

    // JSON escapen
    const cvs = JSON.stringify(columnValues).replace(/"/g,'\\"');
    const mutation = `
      mutation {
        create_item(
          board_id: ${BOARD_ID},
          item_name: "${itemName}",
          column_values: "${cvs}"
        ) { id }
      }
    `;
    console.log('▶︎ Mutation:', mutation);

    const apiRes = await fetch(MONDAY_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': TOKEN },
      body: JSON.stringify({ query: mutation })
    });
    const apiJson = await apiRes.json();

    if (apiJson.errors) {
      console.error('GraphQL Errors:', apiJson.errors);
      return res.status(500).json({ error: apiJson.errors });
    }

    res.json(apiJson);
  } catch (err) {
    console.error('❌ Fehler beim Erstellen:', err);
    res.status(500).json({ error: err.toString() });
  }
});

/** 5️⃣ Server‐Start */
loadColumnIds()
  .then(() => app.listen(PORT, () => console.log(`🟢 Auf http://localhost:${PORT}`)))
  .catch(err => {
    console.error('Init-Error:', err);
    process.exit(1);
  });
