const pool = require('./db');

const COLLECTIONS = new Set([
  'users','categories','questions','comments','notifications',
  'suggestions','reports','active_radar'
]);

function nowSql() { return new Date(); }
function isOp(v, name) { return v && typeof v === 'object' && v.__op === name; }
function incValue(v) { return isOp(v, 'increment') ? Number(v.value || 0) : null; }
function serverTime(v) { return isOp(v, 'serverTimestamp') ? nowSql() : v; }
function bool(v) { return v === true || v === 1 || v === '1'; }

async function roleOf(conn, uid) {
  const [rows] = await conn.execute('SELECT role FROM users WHERE id=? LIMIT 1', [uid]);
  return rows[0]?.role || 'user';
}
async function adminLevel(conn, uid) {
  const role = await roleOf(conn, uid);
  return { role, isAdmin: role === 'admin' || role === 'super_admin', isSuperAdmin: role === 'super_admin' };
}

function mapRow(collection, r) {
  if (!r) return null;
  switch (collection) {
    case 'users': return {
      id: String(r.id), displayName: r.display_name, email: r.email, username: r.username,
      photoURL: r.photo_url, xp: Number(r.xp || 0), role: r.role || 'user',
      favorites: r.favorites || [], createdAt: r.created_at
    };
    case 'categories': return {
      id: String(r.id), name: r.name, img: r.img_url, count: Number(r.question_count || 0), timestamp: r.created_at
    };
    case 'questions': return {
      id: String(r.id), userId: r.user_id, category: r.category_name || 'عام', title: r.title,
      user: r.author_name_snapshot, likes: Number(r.likes_count || 0), dislikes: Number(r.dislikes_count || 0),
      bestAnswerId: r.best_answer_comment_id == null ? null : String(r.best_answer_comment_id),
      bestAnswerUserId: r.best_answer_user_id || null,
      timestamp: r.created_at, lastActivity: r.last_activity_at
    };
    case 'comments': return {
      id: String(r.id), questionId: String(r.question_id), parentId: r.parent_id == null ? null : String(r.parent_id),
      userId: r.user_id, userName: r.user_name_snapshot, text: r.text_content || '',
      mediaUrl: r.media_url, mediaType: r.media_type, timestamp: r.created_at
    };
    case 'notifications': return {
      id: String(r.id), ownerId: r.owner_id, type: r.type, fromUser: r.from_user_name_snapshot,
      questionId: String(r.question_id), questionTitle: r.question_title_snapshot,
      commentId: r.comment_id == null ? null : String(r.comment_id), isRead: !!r.is_read, timestamp: r.created_at
    };
    case 'suggestions': return {
      id: String(r.id), userId: r.user_id, catName: r.category_name,
      userName: r.user_name_snapshot, timestamp: r.created_at
    };
    case 'reports': return {
      id: String(r.id), targetId: String(r.target_id), targetType: r.target_type,
      reporterName: r.reporter_name_snapshot, reason: r.reason,
      contentSnippet: r.content_snippet, timestamp: r.created_at
    };
    case 'active_radar': return {
      id: String(r.id), userId: r.user_id, userName: r.user_name_snapshot,
      action: r.action, timestamp: r.created_at
    };
    default: return r;
  }
}

async function getUser(conn, id, actor) {
  const [rows] = await conn.execute('SELECT * FROM users WHERE id=? LIMIT 1', [id]);
  if (!rows[0]) return null;
  const [favRows] = await conn.execute(`
    SELECT c.name FROM user_favorite_categories f
    JOIN categories c ON c.id=f.category_id WHERE f.user_id=? ORDER BY c.name`, [id]);
  const row = { ...rows[0], favorites: favRows.map(x => x.name) };
  const result = mapRow('users', row);
  const actorRole = await roleOf(conn, actor.uid);
  if (actor.uid !== id && actorRole !== 'admin' && actorRole !== 'super_admin') delete result.email;
  return result;
}

async function getOne(collection, id, actor) {
  if (!COLLECTIONS.has(collection)) return null;
  const conn = await pool.getConnection();
  try {
    if (collection === 'users') return await getUser(conn, id, actor);
    let sql, params = [id];
    switch (collection) {
      case 'categories':
        sql = `SELECT c.*, COUNT(q.id) question_count FROM categories c LEFT JOIN questions q ON q.category_id=c.id WHERE c.id=? GROUP BY c.id`;
        break;
      case 'questions':
        sql = `SELECT q.*, c.name category_name FROM questions q LEFT JOIN categories c ON c.id=q.category_id WHERE q.id=? LIMIT 1`;
        break;
      case 'comments': sql = 'SELECT * FROM comments WHERE id=? LIMIT 1'; break;
      case 'notifications': sql = 'SELECT * FROM notifications WHERE id=? LIMIT 1'; break;
      case 'suggestions': sql = 'SELECT * FROM suggestions WHERE id=? LIMIT 1'; break;
      case 'reports': sql = 'SELECT * FROM reports WHERE id=? LIMIT 1'; break;
      case 'active_radar': sql = 'SELECT * FROM active_radar WHERE id=? LIMIT 1'; break;
    }
    const [rows] = await conn.execute(sql, params);
    if (!rows[0]) return null;
    const row = mapRow(collection, rows[0]);
    if (collection === 'notifications') {
      const { isAdmin } = await adminLevel(conn, actor.uid);
      if (row.ownerId !== actor.uid && !isAdmin) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    }
    if (['reports','active_radar','suggestions'].includes(collection)) {
      const { isAdmin } = await adminLevel(conn, actor.uid);
      if (!isAdmin && !(collection === 'suggestions' && row.userId === actor.uid)) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    }
    return row;
  } finally { conn.release(); }
}

const queryFieldMap = {
  users: { id:'u.id', email:'u.email', username:'u.username', role:'u.role' },
  categories: { name:'c.name' },
  questions: { userId:'q.user_id', category:'c.name' },
  comments: { questionId:'x.question_id', userId:'x.user_id', parentId:'x.parent_id' },
  notifications: { ownerId:'n.owner_id', isRead:'n.is_read', questionId:'n.question_id' },
  suggestions: { userId:'s.user_id', catName:'s.category_name' },
  reports: { targetId:'r.target_id', targetType:'r.target_type' },
  active_radar: { userId:'a.user_id' }
};
const orderFieldMap = {
  users: { createdAt:'u.created_at', xp:'u.xp' }, categories:{ name:'c.name', timestamp:'c.created_at' },
  questions:{ timestamp:'q.created_at', lastActivity:'q.last_activity_at' }, comments:{ timestamp:'x.created_at' },
  notifications:{ timestamp:'n.created_at' }, suggestions:{ timestamp:'s.created_at' }, reports:{ timestamp:'r.created_at' },
  active_radar:{ timestamp:'a.created_at' }
};

async function queryCollection(spec, actor) {
  const { collection, filters = [], order, limit } = spec || {};
  if (!COLLECTIONS.has(collection)) throw Object.assign(new Error('UNKNOWN_COLLECTION'), { status: 400 });
  const conn = await pool.getConnection();
  try {
    const actorAccess = await adminLevel(conn, actor.uid);
    if (collection === 'users' && !actorAccess.isAdmin) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    if (['reports','active_radar'].includes(collection) && !actorAccess.isAdmin) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    if (collection === 'notifications' && !actorAccess.isAdmin) {
      const ownerFilter = filters.find(f => f.field === 'ownerId' && f.op === '==');
      if (!ownerFilter || String(ownerFilter.value) !== actor.uid) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    }
    if (collection === 'suggestions' && !actorAccess.isAdmin) {
      const userFilter = filters.find(f => f.field === 'userId' && f.op === '==');
      if (!userFilter || String(userFilter.value) !== actor.uid) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    }

    let base;
    switch (collection) {
      case 'users': base='SELECT u.* FROM users u'; break;
      case 'categories': base='SELECT c.*, COUNT(q.id) question_count FROM categories c LEFT JOIN questions q ON q.category_id=c.id'; break;
      case 'questions': base='SELECT q.*, c.name category_name FROM questions q LEFT JOIN categories c ON c.id=q.category_id'; break;
      case 'comments': base='SELECT x.* FROM comments x'; break;
      case 'notifications': base='SELECT n.* FROM notifications n'; break;
      case 'suggestions': base='SELECT s.* FROM suggestions s'; break;
      case 'reports': base='SELECT r.* FROM reports r'; break;
      case 'active_radar': base='SELECT a.* FROM active_radar a'; break;
    }
    const clauses=[]; const params=[];
    for (const f of filters) {
      const col = queryFieldMap[collection]?.[f.field];
      if (!col || f.op !== '==') throw Object.assign(new Error(`UNSUPPORTED_FILTER:${f.field}`), { status: 400 });
      if (f.value === null) clauses.push(`${col} IS NULL`);
      else { clauses.push(`${col}=?`); params.push(typeof f.value === 'boolean' ? (f.value?1:0) : f.value); }
    }
    let sql = base + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '');
    if (collection === 'categories') sql += ' GROUP BY c.id';
    if (order) {
      const col = orderFieldMap[collection]?.[order.field];
      if (!col) throw Object.assign(new Error(`UNSUPPORTED_ORDER:${order.field}`), { status: 400 });
      sql += ` ORDER BY ${col} ${String(order.direction).toLowerCase()==='desc'?'DESC':'ASC'}`;
    }
    if (limit != null) {
      const n = Math.max(1, Math.min(500, Number(limit)||1));
      sql += ` LIMIT ${n}`;
    }
    const [rows] = await conn.execute(sql, params);
    const mapped = rows.map(r => mapRow(collection, r));
    if (collection === 'users') {
      // Admin console only needs basic fields; no N+1 favorites lookup here.
      mapped.forEach(x => { x.favorites = []; });
    }
    return mapped;
  } finally { conn.release(); }
}

async function ensureProfile(conn, uid) {
  const [rows] = await conn.execute('SELECT * FROM users WHERE id=? LIMIT 1', [uid]);
  if (!rows[0]) throw Object.assign(new Error('USER_PROFILE_NOT_FOUND'), { status: 409 });
  return rows[0];
}

async function createDocument(collection, data, actor, explicitId = null) {
  if (!COLLECTIONS.has(collection)) throw Object.assign(new Error('UNKNOWN_COLLECTION'), { status: 400 });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const access = await adminLevel(conn, actor.uid);
    let id;

    if (collection === 'users') {
      id = explicitId || actor.uid;
      if (id !== actor.uid && !access.isAdmin) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
      if (id !== actor.uid && !access.isAdmin) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
      const role = (access.isSuperAdmin && data.role) ? data.role : 'user';
      const displayName = String(data.displayName || actor.displayName || 'عضو').slice(0,100);
      const email = String(actor.email || data.email || '').slice(0,255);
      if (!email) throw Object.assign(new Error('EMAIL_REQUIRED'), { status: 400 });
      let username = data.username ? String(data.username).slice(0,80) : null;
      if (username) {
        const [dupe] = await conn.execute('SELECT id FROM users WHERE username=? AND id<>? LIMIT 1',[username,id]);
        if (dupe.length) username = `${username}_${Math.floor(Math.random()*10000)}`.slice(0,80);
      }
      await conn.execute(`INSERT INTO users (id,display_name,email,username,photo_url,xp,role,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), photo_url=COALESCE(VALUES(photo_url),photo_url), updated_at=CURRENT_TIMESTAMP(3)`,
        [id,displayName,email,username,data.photoURL||actor.photoURL||null,0,role,serverTime(data.createdAt)||nowSql()]);
    }
    else if (collection === 'categories') {
      if (!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
      const name=String(data.name||'').trim().slice(0,100); if(!name) throw Object.assign(new Error('CATEGORY_NAME_REQUIRED'),{status:400});
      const [r] = await conn.execute('INSERT INTO categories (name,img_url) VALUES (?,?)',[name,data.img||data.imgUrl||null]); id=r.insertId;
    }
    else if (collection === 'questions') {
      const profile = await ensureProfile(conn, actor.uid);
      const title=String(data.title||'').trim();
      if(title.length<10 || title.length>200) throw Object.assign(new Error('INVALID_TITLE_LENGTH'),{status:400});
      const [recent] = await conn.execute('SELECT created_at FROM questions WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[actor.uid]);
      if(recent[0] && Date.now()-new Date(recent[0].created_at).getTime()<60000) throw Object.assign(new Error('QUESTION_COOLDOWN'),{status:429});
      const catName=String(data.category||'عام').trim()||'عام';
      let [cats]=await conn.execute('SELECT id FROM categories WHERE name=? LIMIT 1',[catName]);
      if(!cats[0]) [cats]=await conn.execute("SELECT id FROM categories WHERE name='عام' LIMIT 1");
      const [r]=await conn.execute(`INSERT INTO questions (user_id,category_id,title,author_name_snapshot,likes_count,dislikes_count,created_at)
        VALUES (?,?,?,?,0,0,?)`,[actor.uid,cats[0]?.id||null,title,profile.display_name,nowSql()]); id=r.insertId;
      await conn.execute('UPDATE users SET xp=GREATEST(0,xp+10) WHERE id=?',[actor.uid]);
    }
    else if (collection === 'comments') {
      const profile=await ensureProfile(conn,actor.uid);
      const qid=Number(data.questionId); if(!Number.isInteger(qid)) throw Object.assign(new Error('INVALID_QUESTION'),{status:400});
      const [qs]=await conn.execute('SELECT * FROM questions WHERE id=? LIMIT 1',[qid]); if(!qs[0]) throw Object.assign(new Error('QUESTION_NOT_FOUND'),{status:404});
      const parent=data.parentId==null?null:Number(data.parentId);
      if(parent!==null){ const [ps]=await conn.execute('SELECT question_id FROM comments WHERE id=? LIMIT 1',[parent]); if(!ps[0]||Number(ps[0].question_id)!==qid) throw Object.assign(new Error('INVALID_PARENT'),{status:400}); }
      if(parent===null){ const [recent]=await conn.execute('SELECT created_at FROM comments WHERE question_id=? AND user_id=? AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1',[qid,actor.uid]); if(recent[0]&&Date.now()-new Date(recent[0].created_at).getTime()<60000) throw Object.assign(new Error('COMMENT_COOLDOWN'),{status:429}); }
      const text=String(data.text||'').trim(); if(!text && !data.mediaUrl) throw Object.assign(new Error('EMPTY_COMMENT'),{status:400});
      const [r]=await conn.execute(`INSERT INTO comments (question_id,parent_id,user_id,user_name_snapshot,text_content,media_url,media_type,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,[qid,parent,actor.uid,profile.display_name,text,data.mediaUrl||null,data.mediaType||null,nowSql()]); id=r.insertId;
      await conn.execute('UPDATE questions SET last_activity_at=CURRENT_TIMESTAMP(3) WHERE id=?',[qid]);
      await conn.execute('UPDATE users SET xp=GREATEST(0,xp+?) WHERE id=?',[parent?2:5,actor.uid]);
    }
    else if (collection === 'notifications') {
      const profile=await ensureProfile(conn,actor.uid);
      const qid=Number(data.questionId); const [qs]=await conn.execute('SELECT * FROM questions WHERE id=? LIMIT 1',[qid]); if(!qs[0]) throw Object.assign(new Error('QUESTION_NOT_FOUND'),{status:404});
      let owner=String(data.ownerId||''); const type=String(data.type||'comment').slice(0,50);
      if(type==='comment') owner=qs[0].user_id;
      if(type==='best_answer' && qs[0].user_id!==actor.uid) throw Object.assign(new Error('FORBIDDEN'),{status:403});
      const commentId = data.commentId && data.commentId!=='new' ? Number(data.commentId) : null;
      const [r]=await conn.execute(`INSERT INTO notifications (owner_id,from_user_id,type,from_user_name_snapshot,question_id,question_title_snapshot,comment_id,is_read,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,[owner,actor.uid,type,profile.display_name,qid,qs[0].title,Number.isInteger(commentId)?commentId:null,bool(data.isRead)?1:0,nowSql()]); id=r.insertId;
    }
    else if (collection === 'suggestions') {
      const profile=await ensureProfile(conn,actor.uid); const name=String(data.catName||'').trim().slice(0,100); if(!name) throw Object.assign(new Error('CATEGORY_NAME_REQUIRED'),{status:400});
      try { const [r]=await conn.execute('INSERT INTO suggestions (user_id,category_name,user_name_snapshot,created_at) VALUES (?,?,?,?)',[actor.uid,name,profile.display_name,nowSql()]); id=r.insertId; }
      catch(e){ if(e.code==='ER_DUP_ENTRY') throw Object.assign(new Error('DUPLICATE_SUGGESTION'),{status:409}); throw e; }
    }
    else if (collection === 'reports') {
      const profile=await ensureProfile(conn,actor.uid); const reason=String(data.reason||'').trim().slice(0,1000); if(!reason) throw Object.assign(new Error('REASON_REQUIRED'),{status:400});
      const [r]=await conn.execute('INSERT INTO reports (target_id,target_type,reporter_user_id,reporter_name_snapshot,reason,content_snippet,created_at) VALUES (?,?,?,?,?,?,?)',
        [String(data.targetId||''),String(data.targetType||'').slice(0,30),actor.uid,profile.display_name,reason,String(data.contentSnippet||'').slice(0,255)||null,nowSql()]); id=r.insertId;
    }
    else if (collection === 'active_radar') {
      const profile=await ensureProfile(conn,actor.uid); const [r]=await conn.execute('INSERT INTO active_radar (user_id,user_name_snapshot,action,created_at) VALUES (?,?,?,?)',[actor.uid,profile.display_name,String(data.action||'').slice(0,255),nowSql()]); id=r.insertId;
    }

    await conn.commit();
    return String(id);
  } catch(e){ await conn.rollback(); throw e; } finally { conn.release(); }
}

async function updateDocument(collection,id,data,actor) {
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const access=await adminLevel(conn,actor.uid);
    let result;
    if(collection==='users'){
      const [rows]=await conn.execute('SELECT * FROM users WHERE id=? LIMIT 1',[id]); if(!rows[0]) throw Object.assign(new Error('NOT_FOUND'),{status:404});
      const onlyXp=Object.keys(data).every(k=>k==='xp');
      if(onlyXp && !access.isAdmin){ await conn.commit(); return await getUser(conn,id,actor); }
      if('role' in data){ if(!access.isSuperAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); const role=['user','admin','super_admin'].includes(data.role)?data.role:'user'; await conn.execute('UPDATE users SET role=? WHERE id=?',[role,id]); }
      if('xp' in data){ if(!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); const delta=incValue(data.xp); if(delta!==null) await conn.execute('UPDATE users SET xp=GREATEST(0,xp+?) WHERE id=?',[delta,id]); else await conn.execute('UPDATE users SET xp=GREATEST(0,?) WHERE id=?',[Number(data.xp)||0,id]); }
      const profileKeys=['displayName','photoURL'];
      if(profileKeys.some(k=>k in data)){
        if(actor.uid!==id && !access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403});
        if('displayName' in data){ const n=String(data.displayName||'').trim().slice(0,100); if(!n) throw Object.assign(new Error('DISPLAY_NAME_REQUIRED'),{status:400}); await conn.execute('UPDATE users SET display_name=? WHERE id=?',[n,id]); }
        if('photoURL' in data) await conn.execute('UPDATE users SET photo_url=? WHERE id=?',[data.photoURL||null,id]);
      }
      if('favorites' in data){
        if(actor.uid!==id) throw Object.assign(new Error('FORBIDDEN'),{status:403});
        const names=Array.isArray(data.favorites)?data.favorites.map(String):[];
        await conn.execute('DELETE FROM user_favorite_categories WHERE user_id=?',[id]);
        if(names.length){ const placeholders=names.map(()=>'?').join(','); const [cats]=await conn.execute(`SELECT id FROM categories WHERE name IN (${placeholders})`,names); for(const c of cats) await conn.execute('INSERT IGNORE INTO user_favorite_categories (user_id,category_id) VALUES (?,?)',[id,c.id]); }
      }
      result=await getUser(conn,id,actor);
    }
    else if(collection==='categories'){
      if(!access.isAdmin){ if('count' in data){ await conn.commit(); return await getOne('categories',id,actor); } throw Object.assign(new Error('FORBIDDEN'),{status:403}); }
      if('count' in data && Object.keys(data).length===1){ await conn.commit(); return await getOne('categories',id,actor); }
      if('name' in data) await conn.execute('UPDATE categories SET name=? WHERE id=?',[String(data.name).slice(0,100),id]);
      if('img' in data || 'imgUrl' in data) await conn.execute('UPDATE categories SET img_url=? WHERE id=?',[data.img??data.imgUrl??null,id]);
    }
    else if(collection==='questions'){
      const [qs]=await conn.execute('SELECT * FROM questions WHERE id=? LIMIT 1',[id]); const q=qs[0]; if(!q) throw Object.assign(new Error('NOT_FOUND'),{status:404});
      // Voting updates are recognized by increment markers.
      if('likes' in data || 'dislikes' in data){
        const ld=incValue(data.likes)??0, dd=incValue(data.dislikes)??0;
        let desired;
        if(ld>0 || dd<0) desired='up'; else if(dd>0 || ld<0) desired='down';
        if((ld<0&&dd===0)||(dd<0&&ld===0)) desired=null;
        const [vr]=await conn.execute('SELECT vote FROM question_votes WHERE question_id=? AND user_id=?',[id,actor.uid]);
        const prev=vr[0]?.vote||null;
        if(desired===null){ await conn.execute('DELETE FROM question_votes WHERE question_id=? AND user_id=?',[id,actor.uid]); }
        else await conn.execute('INSERT INTO question_votes (question_id,user_id,vote) VALUES (?,?,?) ON DUPLICATE KEY UPDATE vote=VALUES(vote),updated_at=CURRENT_TIMESTAMP(3)',[id,actor.uid,desired]);
        if(prev!==desired){
          const likeDelta=(desired==='up'?1:0)-(prev==='up'?1:0); const dislikeDelta=(desired==='down'?1:0)-(prev==='down'?1:0);
          await conn.execute('UPDATE questions SET likes_count=GREATEST(0,likes_count+?), dislikes_count=GREATEST(0,dislikes_count+?) WHERE id=?',[likeDelta,dislikeDelta,id]);
        }
      }
      if('lastActivity' in data) await conn.execute('UPDATE questions SET last_activity_at=CURRENT_TIMESTAMP(3) WHERE id=?',[id]);
      if('bestAnswerId' in data || 'bestAnswerUserId' in data){
        if(q.user_id!==actor.uid && !access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403});
        const newBest=data.bestAnswerId==null?null:Number(data.bestAnswerId);
        if(newBest===null){
          if(q.best_answer_user_id) await conn.execute('UPDATE users SET xp=GREATEST(0,xp-50) WHERE id=?',[q.best_answer_user_id]);
          await conn.execute('UPDATE questions SET best_answer_comment_id=NULL,best_answer_user_id=NULL WHERE id=?',[id]);
        } else {
          const [cs]=await conn.execute('SELECT * FROM comments WHERE id=? AND question_id=? LIMIT 1',[newBest,id]); const c=cs[0]; if(!c) throw Object.assign(new Error('INVALID_BEST_ANSWER'),{status:400});
          if(q.best_answer_comment_id && Number(q.best_answer_comment_id)!==newBest && q.best_answer_user_id) await conn.execute('UPDATE users SET xp=GREATEST(0,xp-50) WHERE id=?',[q.best_answer_user_id]);
          if(!q.best_answer_comment_id || Number(q.best_answer_comment_id)!==newBest) await conn.execute('UPDATE users SET xp=xp+50 WHERE id=?',[c.user_id]);
          await conn.execute('UPDATE questions SET best_answer_comment_id=?,best_answer_user_id=? WHERE id=?',[newBest,c.user_id,id]);
        }
      }
    }
    else if(collection==='notifications'){
      const [rows]=await conn.execute('SELECT owner_id FROM notifications WHERE id=? LIMIT 1',[id]); if(!rows[0]) throw Object.assign(new Error('NOT_FOUND'),{status:404});
      if(rows[0].owner_id!==actor.uid && !access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403});
      if('isRead' in data) await conn.execute('UPDATE notifications SET is_read=? WHERE id=?',[bool(data.isRead)?1:0,id]);
    }
    else { throw Object.assign(new Error('UPDATE_NOT_ALLOWED'),{status:400}); }
    await conn.commit();
    return result||null;
  }catch(e){ await conn.rollback(); throw e; }finally{ conn.release(); }
}

async function deleteDocument(collection,id,actor){
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction(); const access=await adminLevel(conn,actor.uid);
    if(collection==='users'){
      if(!access.isAdmin && actor.uid!==id) throw Object.assign(new Error('FORBIDDEN'),{status:403});
      await conn.execute('DELETE FROM users WHERE id=?',[id]);
    } else if(collection==='categories'){
      if(!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); await conn.execute('DELETE FROM categories WHERE id=?',[id]);
    } else if(collection==='questions'){
      const [rows]=await conn.execute('SELECT user_id FROM questions WHERE id=? LIMIT 1',[id]); if(!rows[0]){await conn.commit();return;}
      if(rows[0].user_id!==actor.uid&&!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); await conn.execute('DELETE FROM questions WHERE id=?',[id]);
    } else if(collection==='comments'){
      const [rows]=await conn.execute('SELECT c.user_id,q.best_answer_comment_id,q.best_answer_user_id,q.id question_id FROM comments c JOIN questions q ON q.id=c.question_id WHERE c.id=? LIMIT 1',[id]); if(!rows[0]){await conn.commit();return;}
      const r=rows[0]; if(r.user_id!==actor.uid&&!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403});
      if(Number(r.best_answer_comment_id)===Number(id)){ if(r.best_answer_user_id) await conn.execute('UPDATE users SET xp=GREATEST(0,xp-50) WHERE id=?',[r.best_answer_user_id]); await conn.execute('UPDATE questions SET best_answer_comment_id=NULL,best_answer_user_id=NULL WHERE id=?',[r.question_id]); }
      await conn.execute('DELETE FROM comments WHERE id=?',[id]);
    } else if(collection==='notifications'){
      const [rows]=await conn.execute('SELECT owner_id FROM notifications WHERE id=? LIMIT 1',[id]); if(!rows[0]){await conn.commit();return;} if(rows[0].owner_id!==actor.uid&&!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); await conn.execute('DELETE FROM notifications WHERE id=?',[id]);
    } else if(collection==='suggestions'){
      const [rows]=await conn.execute('SELECT user_id FROM suggestions WHERE id=? LIMIT 1',[id]); if(!rows[0]){await conn.commit();return;} if(rows[0].user_id!==actor.uid&&!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); await conn.execute('DELETE FROM suggestions WHERE id=?',[id]);
    } else if(collection==='reports'){
      if(!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); await conn.execute('DELETE FROM reports WHERE id=?',[id]);
    } else if(collection==='active_radar'){
      if(!access.isAdmin) throw Object.assign(new Error('FORBIDDEN'),{status:403}); await conn.execute('DELETE FROM active_radar WHERE id=?',[id]);
    } else throw Object.assign(new Error('UNKNOWN_COLLECTION'),{status:400});
    await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
}

module.exports={ getOne, queryCollection, createDocument, updateDocument, deleteDocument };
