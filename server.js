// server.js
import express from 'express';
import dotenv  from 'dotenv';
import fetch   from 'node-fetch';

dotenv.config();

const app        = express();
const PORT       = process.env.PORT || 3000;
const MONDAY_URL = 'https://api.monday.com/v2';
const BOARD_ID   = process.env.BOARD_ID;          // Haupt-Board
const TOKEN      = process.env.MONDAY_API_TOKEN;

/* ------------------------------------------------------------------ */
/* 0. Helper: monday() mit Logging                                    */
/* ------------------------------------------------------------------ */
async function monday(query, variables = {}, label = '') {
  console.log(`\n🚧 monday(${label || 'no-label'})`);
  if (Object.keys(variables).length) console.log('   → Vars:', variables);

  const res  = await fetch(MONDAY_URL, {
    method : 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': TOKEN },
    body   : JSON.stringify({ query, variables })
  });
  const json = await res.json();

  if (json.errors) {
    console.error('   ❌ GraphQL-Error:', json.errors);
    throw new Error(JSON.stringify(json.errors));
  }
  console.log('   ✅ ok');
  return json.data;
}

/* ------------------------------------------------------------------ */
/* 1. Caches & Board-Infos                                            */
/* ------------------------------------------------------------------ */
const boardColumns = {};                      // { boardId: {title → {id, settings}} }
async function getBoardColumns(boardId) {
  if (boardColumns[boardId]) return boardColumns[boardId];

  const data = await monday(`
    query ($b:[ID!]) {
      boards(ids:$b){ columns{ id title settings_str } }
    }`, { b:[boardId] }, 'getBoardColumns');

  const map = {};
  for (const c of data.boards[0].columns) {
    map[c.title] = { id: c.id, settings: JSON.parse(c.settings_str||'{}') };
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
const mainColumns = {};  // Stunden-Board
let employeeBoardId = null;

async function init() {
  const cols = await getBoardColumns(BOARD_ID);
  for (const [t,o] of Object.entries(cols)) mainColumns[t] = o.id;

  const mitSettings = cols['Mitarbeiter']?.settings;
  employeeBoardId   =
        mitSettings?.boardIds?.[0] ||
        mitSettings?.linkedBoardIds?.[0] || null;

  if (!employeeBoardId) throw new Error('❌ Mitarbeiter-Board nicht gefunden');

  console.log('✅ Main-Columns:', mainColumns);
  console.log('✅ Employee Board ID:', employeeBoardId);
}

/* ------------------------------------------------------------------ */
/* 3. Express-Setup                                                   */
/* ------------------------------------------------------------------ */
app.use(express.json());
app.use(express.static('public'));

/* ---------- Mitarbeiter-Dropdown ---------- */
app.get('/options/mitarbeiter', async (_,res)=>{
  try{
    const items = await fetchAllItems(employeeBoardId);
    res.json({items});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

/* ---------- Projekt-Dropdown abhängig von Mitarbeiter ---------- */
app.get('/options/project', async (req,res)=>{
  const empId = req.query.mitarbeiterId;
  if (!empId) return res.status(400).json({error:'mitarbeiterId fehlt'});

  console.log(`\n🔎  Projekte für Mitarbeiter-Item ${empId}`);

  try {
    /* 1. Relation-Spalte „Beteiligung“ ermitteln */
    const empCols   = await getBoardColumns(employeeBoardId);
    const beteilCol = empCols['Beteiligung'];
    if (!beteilCol) throw new Error('Spalte „Beteiligung“ nicht gefunden');

    const betId = beteilCol.id;
    console.log('   → Beteiligung-Spalten-ID:', betId);

    /* 2. Ziel-Board der Relation bestimmen (Projekt-Board) */
    const projBoardId =
          beteilCol.settings?.boardIds?.[0] ||
          beteilCol.settings?.linkedBoardIds?.[0] || null;

    if (!projBoardId) throw new Error('Projekt-Board-ID aus Spalten-Settings nicht ermittelbar');

    console.log('   → Projekt-Board-ID:', projBoardId);

    /* 3. Item + verlinkte Projekte in EINEM Call holen */
    const data = await monday(`
      query ($item:[ID!], $rel:String!, $pBoard:ID!){
        items(ids:$item){
          id
          name
          linked_items(
            link_to_item_column_id:$rel,
            linked_board_id:$pBoard
          ){
            id
            name
            board{ id name }
          }
        }
      }`, { item:[empId], rel:betId, pBoard:projBoardId }, 'mitarbeiter+projekte');

    const projects = data.items[0]?.linked_items || [];

    console.log(`   → ${projects.length} Projekte geliefert`);
    res.json({items:projects});
  }catch(e){
    console.error('   ❌ Fehler:', e);
    res.status(500).json({error:e.message});
  }
});

/* ---------- Item anlegen (unverändert) ---------- */
app.post('/create-item', async (req,res)=>{
  try{
    const {itemName,startDate,endDate,pauseMins,projectId,mitarbeiterId}=req.body;
    if(![itemName,startDate,endDate,projectId,mitarbeiterId].every(Boolean))
      return res.status(400).json({error:'Pflichtfelder fehlen'});

    const toUtc = l=>{
      const d=new Date(l), iso=d.toISOString();
      return {date:iso.slice(0,10), time:iso.slice(11,19)};
    };
    const s=toUtc(startDate), e=toUtc(endDate);

    const vals={
      [mainColumns['Anfang Datum']]  :{date:s.date,time:s.time},
      [mainColumns['Ende Datum']]    :{date:e.date,time:e.time},
      [mainColumns['Pause in Mins']] :pauseMins.toString(),
      [mainColumns['Projekt']]       :{linkedPulseIds:[{linkedPulseId:projectId}]},
      [mainColumns['Mitarbeiter']]   :{linkedPulseIds:[{linkedPulseId:mitarbeiterId}]}
    };

    const cvs = JSON.stringify(vals).replace(/"/g,'\\"');
    const mut = `
      mutation{
        create_item(board_id:${BOARD_ID},
          item_name:"${itemName}",
          column_values:"${cvs}"){ id }
      }`;

    const r = await monday(mut, {}, 'create_item');
    res.json({data:r});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

/* ------------------------------------------------------------------ */
/* 4. Server-Start                                                    */
/* ------------------------------------------------------------------ */
init()
  .then(()=>app.listen(PORT,()=>console.log(`🚀  Server läuft auf http://localhost:${PORT}`)))
  .catch(e=>{
    console.error('Startup-Fehler:',e);
    process.exit(1);
  });