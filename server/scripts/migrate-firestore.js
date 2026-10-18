require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const pool = require('../db');

function dateOf(v) {
  if (!v) return new Date();
  if (typeof v.toDate === 'function') return v.toDate();
  const d = new Date(v); return Number.isNaN(d.getTime()) ? new Date() : d;
}
function val(doc) { return { id: doc.id, ...doc.data() }; }

async function main() {
  const keyPath = path.resolve(__dirname, '..', process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account file not found: ${keyPath}\nPut serviceAccountKey.json inside server/ and set FIREBASE_SERVICE_ACCOUNT_PATH in .env.`);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id });
  const fsdb = admin.firestore();

  const names = ['users','categories','questions','comments','notifications','suggestions','reports','active_radar'];
  const data = {};
  for (const name of names) {
    const snap = await fsdb.collection(name).get();
    data[name] = snap.docs.map(val);
    console.log(`Firestore ${name}: ${data[name].length}`);
  }

  const conn = await pool.getConnection();
  try {
    const [[countRow]] = await conn.query('SELECT (SELECT COUNT(*) FROM users)+(SELECT COUNT(*) FROM questions)+(SELECT COUNT(*) FROM comments) AS n');
    if (Number(countRow.n) > 0 && process.env.MIGRATION_CLEAR_SQL !== 'true') {
      throw new Error('MySQL already contains GamesPlot data. Migration stopped to prevent duplicates. Set MIGRATION_CLEAR_SQL=true only if you intentionally want to clear SQL data and re-import Firestore.');
    }

    await conn.beginTransaction();
    if (process.env.MIGRATION_CLEAR_SQL === 'true') {
      await conn.query('SET FOREIGN_KEY_CHECKS=0');
      for (const t of ['question_votes','user_favorite_categories','notifications','active_radar','reports','suggestions','comments','questions','categories','users']) await conn.query(`TRUNCATE TABLE ${t}`);
      await conn.query('SET FOREIGN_KEY_CHECKS=1');
    }

    // Users keep their Firebase UID, so Auth continues to work unchanged.
    const userSet = new Set(data.users.map(u => u.id));
    for (const u of data.users) {
      let email = u.email || null, displayName = u.displayName || 'عضو', photoURL = u.photoURL || null;
      if (!email) {
        try {
          const au = await admin.auth().getUser(u.id);
          email = au.email || `${u.id}@missing.local`; displayName = u.displayName || au.displayName || 'عضو'; photoURL = u.photoURL || au.photoURL || null;
        } catch { email = `${u.id}@missing.local`; }
      }
      await conn.execute(`INSERT INTO users (id,display_name,email,username,photo_url,xp,role,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),email=VALUES(email),username=VALUES(username),photo_url=VALUES(photo_url),xp=VALUES(xp),role=VALUES(role)`,
        [u.id,String(displayName).slice(0,100),String(email).slice(0,255),u.username||null,photoURL,Number(u.xp||0),['admin','super_admin'].includes(u.role)?u.role:'user',dateOf(u.createdAt)]);
    }

    const categoryByName = new Map();
    for (const c of data.categories) {
      await conn.execute('INSERT INTO categories (name,img_url,created_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE img_url=VALUES(img_url)',[String(c.name||'').slice(0,100),c.img||null,dateOf(c.timestamp||c.createdAt)]);
    }
    await conn.execute("INSERT IGNORE INTO categories (name,img_url) VALUES ('عام',NULL)");
    const [catRows] = await conn.query('SELECT id,name FROM categories'); catRows.forEach(r=>categoryByName.set(r.name,Number(r.id)));

    const questionMap = new Map();
    for (const q of data.questions) {
      if (!q.userId || !userSet.has(q.userId)) continue;
      const catId = categoryByName.get(q.category) || categoryByName.get('عام') || null;
      const [r] = await conn.execute(`INSERT INTO questions (user_id,category_id,title,author_name_snapshot,likes_count,dislikes_count,created_at,last_activity_at)
        VALUES (?,?,?,?,?,?,?,?)`,[q.userId,catId,String(q.title||'').slice(0,200),String(q.user||'عضو').slice(0,100),Math.max(0,Number(q.likes||0)),Math.max(0,Number(q.dislikes||0)),dateOf(q.timestamp),q.lastActivity?dateOf(q.lastActivity):null]);
      questionMap.set(q.id,Number(r.insertId));
    }

    const commentMap = new Map();
    for (const c of data.comments) {
      const qid=questionMap.get(String(c.questionId)); if(!qid || !c.userId || !userSet.has(c.userId)) continue;
      const [r]=await conn.execute(`INSERT INTO comments (question_id,parent_id,user_id,user_name_snapshot,text_content,media_url,media_type,created_at)
        VALUES (?,NULL,?,?,?,?,?,?)`,[qid,c.userId,String(c.userName||'عضو').slice(0,100),c.text||'',c.mediaUrl||null,c.mediaType||null,dateOf(c.timestamp)]);
      commentMap.set(c.id,Number(r.insertId));
    }
    for (const c of data.comments) {
      if(!c.parentId) continue; const id=commentMap.get(c.id), parent=commentMap.get(String(c.parentId)); if(id&&parent) await conn.execute('UPDATE comments SET parent_id=? WHERE id=?',[parent,id]);
    }
    for (const q of data.questions) {
      const id=questionMap.get(q.id); if(!id) continue;
      const best=q.bestAnswerId?commentMap.get(String(q.bestAnswerId)):null;
      if(best) {
        const bestUser = q.bestAnswerUserId && userSet.has(q.bestAnswerUserId) ? q.bestAnswerUserId : null;
        await conn.execute('UPDATE questions SET best_answer_comment_id=?,best_answer_user_id=? WHERE id=?',[best,bestUser,id]);
      }
    }

    // Favorites are normalized from users.favorites[] into a relation table.
    for (const u of data.users) {
      for (const name of (Array.isArray(u.favorites)?u.favorites:[])) {
        const cid=categoryByName.get(String(name)); if(cid) await conn.execute('INSERT IGNORE INTO user_favorite_categories (user_id,category_id) VALUES (?,?)',[u.id,cid]);
      }
    }

    for (const n of data.notifications) {
      const qid=questionMap.get(String(n.questionId)); if(!qid || !n.ownerId || !userSet.has(n.ownerId)) continue;
      const cid=n.commentId && n.commentId!=='new' ? commentMap.get(String(n.commentId)) : null;
      await conn.execute(`INSERT INTO notifications (owner_id,from_user_id,type,from_user_name_snapshot,question_id,question_title_snapshot,comment_id,is_read,created_at)
        VALUES (?,NULL,?,?,?,?,?,?,?)`,[n.ownerId,String(n.type||'comment').slice(0,50),n.fromUser||null,qid,String(n.questionTitle||'سؤال').slice(0,200),cid||null,n.isRead?1:0,dateOf(n.timestamp)]);
    }
    for (const s of data.suggestions) {
      if(!s.userId || !userSet.has(s.userId)) continue;
      await conn.execute('INSERT IGNORE INTO suggestions (user_id,category_name,user_name_snapshot,created_at) VALUES (?,?,?,?)',[s.userId,String(s.catName||'').slice(0,100),String(s.userName||'عضو').slice(0,100),dateOf(s.timestamp)]);
    }
    for (const r of data.reports) {
      let target=String(r.targetId||''); const type=String(r.targetType||'').toLowerCase();
      if(type.includes('تعليق')||type.includes('comment')) target=String(commentMap.get(target)||target);
      else if(type.includes('سؤال')||type.includes('question')) target=String(questionMap.get(target)||target);
      await conn.execute('INSERT INTO reports (target_id,target_type,reporter_user_id,reporter_name_snapshot,reason,content_snippet,created_at) VALUES (?,?,?,?,?,?,?)',
        [target,String(r.targetType||'').slice(0,30),null,String(r.reporterName||'عضو').slice(0,100),String(r.reason||'').slice(0,1000),r.contentSnippet||null,dateOf(r.timestamp)]);
    }
    for (const a of data.active_radar) {
      if(!a.userId || !userSet.has(a.userId)) continue;
      await conn.execute('INSERT INTO active_radar (user_id,user_name_snapshot,action,created_at) VALUES (?,?,?,?)',[a.userId,String(a.userName||'عضو').slice(0,100),String(a.action||'').slice(0,255),dateOf(a.timestamp)]);
    }

    await conn.commit();
    console.log('\nMigration completed successfully.');
    console.log('Note: old per-user vote choices cannot be migrated because the old site stored them in browser localStorage. Existing like/dislike COUNTS were preserved.');
  } catch(e) { await conn.rollback(); throw e; }
  finally { conn.release(); await pool.end(); }
}

main().catch(e => { console.error('\nMigration failed:', e.message); process.exitCode=1; });
