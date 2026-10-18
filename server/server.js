require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const { requireAuth } = require('./auth');
const { getOne, queryCollection, createDocument, updateDocument, deleteDocument } = require('./data-service');

const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.resolve(__dirname, '..');

const allowed = new Set([
  'http://localhost:3000','http://127.0.0.1:3000','http://localhost','http://127.0.0.1',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
]);
app.use(cors({ origin(origin, cb){ if(!origin || allowed.has(origin)) return cb(null,true); cb(new Error('Origin not allowed by CORS')); } }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req,res) => {
  try { await pool.query('SELECT 1'); res.json({ ok:true, database:'connected' }); }
  catch(e){ res.status(500).json({ ok:false, database:'error', error:e.message }); }
});

app.use('/api', requireAuth);

app.post('/api/query', async (req,res,next) => {
  try { res.json({ docs: await queryCollection(req.body, req.auth) }); } catch(e){ next(e); }
});
app.get('/api/doc/:collection/:id', async (req,res,next) => {
  try { const doc=await getOne(req.params.collection,req.params.id,req.auth); if(!doc)return res.status(404).json({error:'NOT_FOUND'}); res.json({doc}); } catch(e){ next(e); }
});
app.post('/api/doc', async (req,res,next) => {
  try { const id=await createDocument(req.body.collection,req.body.data||{},req.auth,null); res.status(201).json({id}); } catch(e){ next(e); }
});
app.put('/api/doc/:collection/:id', async (req,res,next) => {
  try {
    // Firestore setDoc semantics used by GamesPlot: create user by explicit UID, otherwise update existing doc.
    if(req.params.collection==='users') {
      const existing=await getOne('users',req.params.id,req.auth).catch(()=>null);
      if(!existing){ const id=await createDocument('users',req.body.data||{},req.auth,req.params.id); return res.json({id}); }
    }
    await updateDocument(req.params.collection,req.params.id,req.body.data||{},req.auth); res.json({ok:true});
  } catch(e){ next(e); }
});
app.patch('/api/doc/:collection/:id', async (req,res,next) => {
  try { const doc=await updateDocument(req.params.collection,req.params.id,req.body.data||{},req.auth); res.json({ok:true,doc}); } catch(e){ next(e); }
});
app.delete('/api/doc/:collection/:id', async (req,res,next) => {
  try { await deleteDocument(req.params.collection,req.params.id,req.auth); res.json({ok:true}); } catch(e){ next(e); }
});

app.use('/api', (_req,res) => res.status(404).json({error:'API_ROUTE_NOT_FOUND'}));

// Never expose backend source or local SQL files while serving the frontend locally.
app.use('/server', (_req,res) => res.status(404).end());
app.get(/\.sql$/i, (_req,res) => res.status(404).end());
app.use(express.static(root, { dotfiles:'ignore', extensions:['html'] }));
app.get('/', (_req,res) => res.sendFile(path.join(root,'index.html')));

app.use((err,_req,res,_next) => {
  console.error(err);
  const status=err.status || (err.code==='ER_DUP_ENTRY'?409:500);
  res.status(status).json({ error: err.message || 'SERVER_ERROR' });
});

app.listen(port, async () => {
  try { await pool.query('SELECT 1'); console.log(`GamesPlot API: http://localhost:${port}`); console.log('MySQL: connected'); }
  catch(e){ console.error('MySQL connection failed:',e.message); console.error('Check server/.env and WampServer.'); }
});
