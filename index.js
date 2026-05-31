require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public/app.html')));
app.get('/hljs/highlight.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/highlight.js/lib/core.js')));
app.get('/hljs/github-dark.css', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/highlight.js/styles/github-dark.css')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'korale_secret_key';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL, name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      title VARCHAR(255), messages JSONB DEFAULT '[]',
      profile JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id),
      skills JSONB DEFAULT '[]', projects JSONB DEFAULT '[]',
      traits JSONB DEFAULT '{}', updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS connection_requests (
      id SERIAL PRIMARY KEY, sender_id INTEGER REFERENCES users(id),
      receiver_id INTEGER REFERENCES users(id),
      sender_conv_id INTEGER REFERENCES conversations(id),
      receiver_conv_id INTEGER REFERENCES conversations(id),
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(sender_id, receiver_id, sender_conv_id)
    );
    CREATE TABLE IF NOT EXISTS shared_conversations (
      id SERIAL PRIMARY KEY, request_id INTEGER REFERENCES connection_requests(id),
      user1_id INTEGER REFERENCES users(id), user2_id INTEGER REFERENCES users(id),
      user1_conv_id INTEGER REFERENCES conversations(id), user2_conv_id INTEGER REFERENCES conversations(id),
      messages JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title VARCHAR(255)`);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}'`);
  console.log('DB ready');
}
initDB();

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return '';
}

// Prépare les messages pour la BDD : retire les base64 images, garde les refs
// Les images sont stockées avec leur dataUrl (pour persistance affichage)
// Les fichiers sont stockés comme file_ref (nom seulement, pas le contenu extrait)
function prepareForStorage(displayMessages) {
  if (!Array.isArray(displayMessages)) return [];
  return displayMessages.map(m => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content === 'string') return m;
    if (Array.isArray(m.content)) {
      // Déjà au format display (image_saved, file_ref, text) - on garde tel quel
      // Sauf qu'on ne retire pas le dataUrl des image_saved (on veut le garder en BDD)
      return m;
    }
    return m;
  });
}

async function analyzeConversationProfile(messages) {
  const conversation = messages
    .map(m => `${m.role}: ${extractText(m.content)}`)
    .filter(line => line.trim().length > line.split(':')[0].length + 1)
    .join('\n');
  if (!conversation.trim()) return null;
  const analysis = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 1024,
    messages: [{ role: 'user', content: `Analyse cette conversation et extrais le profil utilisateur.\n\n${conversation}\n\nRéponds UNIQUEMENT en JSON:\n{"skills":[],"projects":[],"traits":{"vision":0,"technicite":0,"entrepreneuriat":0,"creativite":0,"collaboration":0,"leadership":0},"summary":"résumé en une phrase"}\n\nMax 6 compétences, 3 projets. Scores 0-100. JSON uniquement.` }]
  });
  try {
    let text = analysis.content[0].text.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    return JSON.parse(text);
  } catch(e) { return null; }
}

async function generateTitle(messages) {
  if (messages.length < 2) return null;
  const first = messages.slice(0,2).map(m => `${m.role}: ${extractText(m.content)}`).join('\n');
  const result = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 50,
    messages: [{ role: 'user', content: `Titre court (4 mots max) pour:\n${first}\nTitre uniquement.` }]
  });
  return result.content[0].text.trim();
}

// AUTH
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (email,password,name) VALUES ($1,$2,$3) RETURNING id,email,name', [email,hash,name]);
    const user = result.rows[0];
    await pool.query('INSERT INTO profiles (user_id) VALUES ($1)', [user.id]);
    res.json({ token: jwt.sign({id:user.id,email:user.email}, JWT_SECRET), user });
  } catch(e) {
    if (e.code==='23505') res.status(400).json({error:'Email déjà utilisé'});
    else res.status(500).json({error:e.message});
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({error:'Identifiants incorrects'});
    res.json({ token: jwt.sign({id:user.id,email:user.email}, JWT_SECRET), user:{id:user.id,email:user.email,name:user.name} });
  } catch(e) { res.status(500).json({error:'Erreur serveur'}); }
});

// PROFILE
app.get('/api/profile', authMiddleware, async (req, res) => {
  const { conversationId } = req.query;
  if (conversationId) {
    const r = await pool.query('SELECT profile FROM conversations WHERE id=$1 AND user_id=$2', [conversationId, req.user.id]);
    if (r.rows[0]?.profile) return res.json(r.rows[0].profile);
  }
  const r = await pool.query(`SELECT profile FROM conversations WHERE user_id=$1 AND profile!='{}' ORDER BY updated_at DESC LIMIT 1`, [req.user.id]);
  res.json(r.rows[0]?.profile || {});
});

// CONVERSATIONS
app.get('/api/conversations/list', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT id,title,created_at,updated_at,profile FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50', [req.user.id]);
  res.json(r.rows);
});
app.get('/api/conversations/:id', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT * FROM conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({error:'Non trouvée'});
  res.json(r.rows[0]);
});
app.post('/api/conversations', authMiddleware, async (req, res) => {
  const r = await pool.query("INSERT INTO conversations (user_id,messages) VALUES ($1,'[]') RETURNING id", [req.user.id]);
  res.json({id: r.rows[0].id});
});

// SUPPRESSION CONVERSATION IA
app.delete('/api/conversations/:id', authMiddleware, async (req, res) => {
  try {
    // Nettoyer les dépendances (FK) avant suppression
    await pool.query('DELETE FROM shared_conversations WHERE user1_conv_id=$1 OR user2_conv_id=$1', [req.params.id]);
    await pool.query('DELETE FROM connection_requests WHERE sender_conv_id=$1 OR receiver_conv_id=$1', [req.params.id]);
    const r = await pool.query('DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Non trouvée' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CHAT
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { messages, saveMessage, conversationId, baseMessages } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: "Tu es Korale, un assistant IA personnel intelligent. Tu aides l'utilisateur dans ses projets, idées, code et réflexions. Tu es chaleureux, précis et utile. Pour les équations mathématiques, utilise LaTeX: $...$ inline et $$...$$ centré. Si l'utilisateur partage une image, décris-la et réponds en fonction. Si l'utilisateur partage un fichier, analyse-le.",
      messages: messages,
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta') {
        fullResponse += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    if (conversationId && saveMessage) {
      let priorMsgs;
      if (Array.isArray(baseMessages)) {
        priorMsgs = baseMessages; // édition : on repart de la base tronquée
      } else {
        const existing = await pool.query('SELECT messages FROM conversations WHERE id=$1 AND user_id=$2', [conversationId, req.user.id]);
        priorMsgs = Array.isArray(existing.rows[0]?.messages) ? existing.rows[0].messages : [];
      }
      const allMessages = [...priorMsgs, saveMessage, { role: 'assistant', content: fullResponse }];

      await pool.query('UPDATE conversations SET messages=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3',
        [JSON.stringify(allMessages), conversationId, req.user.id]);

      if (priorMsgs.length === 0) {
        generateTitle(allMessages).then(t => {
          if (t) pool.query('UPDATE conversations SET title=$1 WHERE id=$2', [t, conversationId]);
        }).catch(()=>{});
      }
      analyzeConversationProfile(allMessages).then(async profile => {
        if (profile) await pool.query('UPDATE conversations SET profile=$1 WHERE id=$2 AND user_id=$3',
          [JSON.stringify(profile), conversationId, req.user.id]);
      }).catch(()=>{});
    }
  } catch(err) {
    console.error('Chat error:', err.message);
    res.write(`data: ${JSON.stringify({ text: '[Erreur: '+err.message+']' })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// MATCHING
app.get('/api/matching', authMiddleware, async (req, res) => {
  const { context, conversationId } = req.query;
  let myProfile = {};
  if (conversationId) {
    const r = await pool.query('SELECT profile FROM conversations WHERE id=$1 AND user_id=$2', [conversationId, req.user.id]);
    myProfile = r.rows[0]?.profile || {};
  }
  if (!myProfile.skills) {
    const r = await pool.query(`SELECT profile FROM conversations WHERE user_id=$1 AND profile!='{}' ORDER BY updated_at DESC LIMIT 1`, [req.user.id]);
    myProfile = r.rows[0]?.profile || {};
  }
  if (!myProfile.skills?.length) return res.json([]);

  const others = await pool.query(`
    SELECT DISTINCT ON (c.user_id) c.profile, u.name, u.id as user_id, c.id as conv_id
    FROM conversations c JOIN users u ON c.user_id=u.id
    WHERE c.user_id!=$1 AND c.profile!='{}' AND c.profile IS NOT NULL
    ORDER BY c.user_id, c.updated_at DESC
  `, [req.user.id]);
  if (!others.rows.length) return res.json([]);

  const mySkills = myProfile.skills || [];
  const myTraits = myProfile.traits || {};
  const profilesText = others.rows.map(p => {
    const prof = p.profile || {};
    const skills = prof.skills || [];
    const traits = prof.traits || {};
    return `- ${p.name}: [${skills.join(', ')}], vision=${traits.vision||0}%, technicité=${traits.technicite||0}%, entrepreneuriat=${traits.entrepreneuriat||0}%, créativité=${traits.creativite||0}%, collaboration=${traits.collaboration||0}%, leadership=${traits.leadership||0}%`;
  }).join('\n');

  try {
    const analysis = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 512,
      messages: [{ role: 'user', content: `Matching Korale.\nMoi: ${mySkills.join(', ')}, vision=${myTraits.vision||0}%, technicité=${myTraits.technicite||0}%, entrepreneuriat=${myTraits.entrepreneuriat||0}%\nContexte: "${context||'général'}"\n\nProfils:\n${profilesText}\n\nJSON uniquement:\n[{"name":"prénom","score":85,"reason":"raison 5 mots"}]\nTrié par score. JSON uniquement.` }]
    });
    let text = analysis.content[0].text.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    res.json(JSON.parse(text).slice(0,3));
  } catch(e) { res.json([]); }
});

// USER PROFILES
app.get('/api/user-profile-by-name/:name', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT DISTINCT ON (c.user_id) c.id as conv_id, c.profile, u.name, u.id as user_id
    FROM conversations c JOIN users u ON c.user_id=u.id
    WHERE u.name=$1 AND c.profile!='{}' AND c.profile IS NOT NULL
    ORDER BY c.user_id, c.updated_at DESC
  `, [req.params.name]);
  if (!r.rows[0]) return res.status(404).json({error:'Non trouvé'});
  res.json(r.rows[0]);
});

// CONNECTION REQUESTS
app.post('/api/connection-requests', authMiddleware, async (req, res) => {
  const { receiverId, senderConvId, receiverConvId } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO connection_requests (sender_id,receiver_id,sender_conv_id,receiver_conv_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT (sender_id,receiver_id,sender_conv_id) DO NOTHING RETURNING *`,
      [req.user.id, receiverId, senderConvId, receiverConvId]
    );
    res.json({ success: true, request: r.rows[0] });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/connection-requests/received', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT cr.*, u.name as sender_name, c.profile as sender_profile, c.title as sender_conv_title
    FROM connection_requests cr
    JOIN users u ON cr.sender_id=u.id JOIN conversations c ON cr.sender_conv_id=c.id
    WHERE cr.receiver_id=$1 AND cr.status='pending' ORDER BY cr.created_at DESC
  `, [req.user.id]);
  res.json(r.rows);
});

app.get('/api/connection-requests/sent', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT cr.*, u.name as receiver_name
    FROM connection_requests cr JOIN users u ON cr.receiver_id=u.id
    WHERE cr.sender_id=$1 ORDER BY cr.created_at DESC
  `, [req.user.id]);
  res.json(r.rows);
});

app.patch('/api/connection-requests/:id', authMiddleware, async (req, res) => {
  const { status } = req.body;
  const r = await pool.query(
    `UPDATE connection_requests SET status=$1, updated_at=NOW() WHERE id=$2 AND receiver_id=$3 RETURNING *`,
    [status, req.params.id, req.user.id]
  );
  const request = r.rows[0];
  if (!request) return res.status(404).json({error:'Non trouvée'});
  if (status === 'accepted') {
    await pool.query(
      `INSERT INTO shared_conversations (request_id,user1_id,user2_id,user1_conv_id,user2_conv_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [request.id, request.sender_id, request.receiver_id, request.sender_conv_id, request.receiver_conv_id]
    );
  }
  res.json(request);
});

// SHARED CONVERSATIONS
app.get('/api/shared-conversations', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT sc.*, u1.name as user1_name, u1.email as user1_email,
      u2.name as user2_name, u2.email as user2_email,
      c1.profile as user1_profile, c2.profile as user2_profile
    FROM shared_conversations sc
    JOIN users u1 ON sc.user1_id=u1.id JOIN users u2 ON sc.user2_id=u2.id
    JOIN conversations c1 ON sc.user1_conv_id=c1.id JOIN conversations c2 ON sc.user2_conv_id=c2.id
    WHERE sc.user1_id=$1 OR sc.user2_id=$1 ORDER BY sc.updated_at DESC
  `, [req.user.id]);
  res.json(r.rows);
});

app.get('/api/shared-conversations/:id', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT sc.*, u1.name as user1_name, u1.email as user1_email,
      u2.name as user2_name, u2.email as user2_email,
      c1.profile as user1_profile, c2.profile as user2_profile
    FROM shared_conversations sc
    JOIN users u1 ON sc.user1_id=u1.id JOIN users u2 ON sc.user2_id=u2.id
    JOIN conversations c1 ON sc.user1_conv_id=c1.id JOIN conversations c2 ON sc.user2_conv_id=c2.id
    WHERE sc.id=$1 AND (sc.user1_id=$2 OR sc.user2_id=$2)
  `, [req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({error:'Non trouvée'});
  res.json(r.rows[0]);
});

app.post('/api/shared-conversations/:id/messages', authMiddleware, async (req, res) => {
  const { text, attachments } = req.body;
  const hasText = text && text.trim();
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!hasText && !hasAttachments) return res.status(400).json({error:'Message vide'});

  const conv = await pool.query('SELECT * FROM shared_conversations WHERE id=$1 AND (user1_id=$2 OR user2_id=$2)', [req.params.id, req.user.id]);
  if (!conv.rows[0]) return res.status(404).json({error:'Non trouvée'});

  const messages = Array.isArray(conv.rows[0].messages) ? conv.rows[0].messages : [];
  messages.push({
    sender_id: req.user.id,
    sender_name: req.user.name || req.user.email,
    text: hasText ? text.trim() : '',
    attachments: hasAttachments ? attachments.map(a => ({ name:a.name, type:a.type, isImage:a.isImage, dataUrl:a.dataUrl })) : [],
    created_at: new Date().toISOString()
  });
  await pool.query('UPDATE shared_conversations SET messages=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(messages), req.params.id]);
  res.json({ ok: true });
});

// SUPPRESSION CONTACT PRIVÉ (déconnexion mutuelle)
app.delete('/api/shared-conversations/:id', authMiddleware, async (req, res) => {
  try {
    const conv = await pool.query('SELECT * FROM shared_conversations WHERE id=$1 AND (user1_id=$2 OR user2_id=$2)', [req.params.id, req.user.id]);
    if (!conv.rows[0]) return res.status(404).json({ error: 'Non trouvée' });
    const requestId = conv.rows[0].request_id;
    await pool.query('DELETE FROM shared_conversations WHERE id=$1', [req.params.id]);
    // On supprime aussi la demande pour permettre une reconnexion ultérieure
    if (requestId) await pool.query('DELETE FROM connection_requests WHERE id=$1', [requestId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Korale on port ${PORT}`));