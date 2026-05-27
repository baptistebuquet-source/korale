require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const path = require('path');
app.get('/hljs/highlight.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/highlight.js/lib/core.js'));
});
app.get('/hljs/github-dark.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/highlight.js/styles/github-dark.css'));
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'korale_secret_key';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      title VARCHAR(255),
      messages JSONB DEFAULT '[]',
      profile JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE REFERENCES users(id),
      skills JSONB DEFAULT '[]',
      projects JSONB DEFAULT '[]',
      traits JSONB DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title VARCHAR(255)`);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}'`);
  console.log('Base de données initialisée');
}

initDB();

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, hash, name]
    );
    const user = result.rows[0];
    await pool.query('INSERT INTO profiles (user_id) VALUES ($1)', [user.id]);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
    res.json({ token, user });
  } catch (e) {
    console.log('Erreur inscription:', e.message);
    if (e.code === '23505') {
      res.status(400).json({ error: 'Email déjà utilisé' });
    } else {
      res.status(500).json({ error: 'Erreur: ' + e.message });
    }
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Identifiants incorrects' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Analyse le profil pour UNE conversation spécifique
async function analyzeConversationProfile(messages) {
  const conversation = messages.map(m => `${m.role}: ${m.content}`).join('\n');

  const analysis = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Analyse cette conversation et extrais le profil de l'utilisateur pour CETTE conversation uniquement.

Conversation:
${conversation}

Réponds UNIQUEMENT en JSON valide:
{
  "skills": ["compétence1", "compétence2"],
  "projects": ["projet1", "projet2"],
  "traits": {
    "vision": 0,
    "technicite": 0,
    "entrepreneuriat": 0,
    "creativite": 0,
    "collaboration": 0,
    "leadership": 0
  },
  "summary": "résumé en une phrase de ce dont parle cette conversation"
}

Maximum 6 compétences, 3 projets. Scores entre 0 et 100 basés uniquement sur cette conversation. JSON uniquement.`
    }]
  });

  try {
    let text = analysis.content[0].text.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(text);
  } catch(e) {
    console.log('Erreur parsing JSON profil conv:', e.message);
    return null;
  }
}

async function generateTitle(messages) {
  if (messages.length < 2) return null;
  const first = messages.slice(0, 2).map(m => `${m.role}: ${m.content}`).join('\n');
  const result = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 50,
    messages: [{ role: 'user', content: `Génère un titre court (4 mots max) pour cette conversation:\n${first}\nRéponds uniquement avec le titre, rien d'autre.` }]
  });
  return result.content[0].text.trim();
}

// Profil global (pour compatibilité - retourne profil de la dernière conv active)
app.get('/api/profile', authMiddleware, async (req, res) => {
  const { conversationId } = req.query;
  if (conversationId) {
    const result = await pool.query(
      'SELECT profile FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, req.user.id]
    );
    if (result.rows[0] && result.rows[0].profile) {
      return res.json(result.rows[0].profile);
    }
  }
  // Fallback: dernière conversation avec profil
  const result = await pool.query(
    `SELECT profile FROM conversations WHERE user_id = $1 AND profile != '{}' ORDER BY updated_at DESC LIMIT 1`,
    [req.user.id]
  );
  res.json(result.rows[0]?.profile || {});
});

// Liste des conversations
app.get('/api/conversations/list', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT id, title, created_at, updated_at, profile FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json(result.rows);
});

// Charger une conversation
app.get('/api/conversations/:id', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Non trouvée' });
  res.json(result.rows[0]);
});

app.post('/api/chat', authMiddleware, async (req, res) => {
  const { messages, conversationId } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: "Tu es Korale, un assistant IA personnel intelligent. Tu aides l'utilisateur dans ses projets, idées, code et réflexions. Tu es chaleureux, précis et utile. IMPORTANT: Pour toutes les équations mathématiques, utilise TOUJOURS la notation LaTeX : $...$ pour les équations inline et $$...$$ pour les équations centrées sur leur propre ligne. N'utilise JAMAIS de blocs code pour les équations mathématiques.",
    messages: messages,
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      fullResponse += chunk.delta.text;
      res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
    }
  }

  if (conversationId) {
    const allMessages = messages.concat([{ role: 'assistant', content: fullResponse }]);
    await pool.query(
      'UPDATE conversations SET messages = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
      [JSON.stringify(allMessages), conversationId, req.user.id]
    );

    // Générer titre si première réponse
    if (messages.length === 1) {
      generateTitle(allMessages).then(title => {
        if (title) pool.query('UPDATE conversations SET title = $1 WHERE id = $2', [title, conversationId]);
      }).catch(console.error);
    }

    // Analyser le profil de CETTE conversation
    analyzeConversationProfile(allMessages)
      .then(async (profile) => {
        if (profile) {
          await pool.query(
            'UPDATE conversations SET profile = $1 WHERE id = $2 AND user_id = $3',
            [JSON.stringify(profile), conversationId, req.user.id]
          );
        }
      }).catch(e => console.log('Erreur analyse conv:', e.message));
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/conversations', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'INSERT INTO conversations (user_id, messages) VALUES ($1, $2) RETURNING id',
    [req.user.id, '[]']
  );
  res.json({ id: result.rows[0].id });
});

// Matching basé sur le profil de la conversation courante
app.get('/api/matching', authMiddleware, async (req, res) => {
  const { context, conversationId } = req.query;

  // Récupérer le profil de la conversation courante
  let myProfile = {};
  if (conversationId) {
    const convResult = await pool.query(
      'SELECT profile FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, req.user.id]
    );
    myProfile = convResult.rows[0]?.profile || {};
  }

  // Fallback sur dernière conv avec profil
  if (!myProfile.skills) {
    const fallback = await pool.query(
      `SELECT profile FROM conversations WHERE user_id = $1 AND profile != '{}' ORDER BY updated_at DESC LIMIT 1`,
      [req.user.id]
    );
    myProfile = fallback.rows[0]?.profile || {};
  }

  if (!myProfile.skills || myProfile.skills.length === 0) return res.json([]);

  // Récupérer profils des autres utilisateurs (via leur dernière conv avec profil)
  const others = await pool.query(`
    SELECT DISTINCT ON (c.user_id) c.profile, u.name, u.id as user_id, c.id as conv_id
    FROM conversations c
    JOIN users u ON c.user_id = u.id
    WHERE c.user_id != $1
      AND c.profile != '{}'
      AND c.profile IS NOT NULL
    ORDER BY c.user_id, c.updated_at DESC
  `, [req.user.id]);

  if (others.rows.length === 0) return res.json([]);

  const mySkills = Array.isArray(myProfile.skills) ? myProfile.skills : [];
  const myTraits = myProfile.traits || {};

  const profilesText = others.rows.map(p => {
    const prof = p.profile || {};
    const skills = Array.isArray(prof.skills) ? prof.skills : [];
    const traits = prof.traits || {};
    return `- ${p.name}: compétences=[${skills.join(', ')}], vision=${traits.vision||0}%, technicité=${traits.technicite||0}%, entrepreneuriat=${traits.entrepreneuriat||0}%, créativité=${traits.creativite||0}%, collaboration=${traits.collaboration||0}%, leadership=${traits.leadership||0}%`;
  }).join('\n');

  const analysis = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Tu es un moteur de matching pour Korale, une plateforme de collaboration.

Profil de l'utilisateur pour cette conversation:
- Compétences: ${mySkills.join(', ')}
- Vision: ${myTraits.vision||0}%, Technicité: ${myTraits.technicite||0}%, Entrepreneuriat: ${myTraits.entrepreneuriat||0}%, Créativité: ${myTraits.creativite||0}%, Collaboration: ${myTraits.collaboration||0}%, Leadership: ${myTraits.leadership||0}%
- Résumé: ${myProfile.summary || 'non disponible'}

Contexte de la conversation: "${context || 'général'}"

Profils disponibles:
${profilesText}

Calcule un score de compatibilité (0-100) pour chaque profil en tenant compte:
1. De la complémentarité des compétences
2. De l'équilibre des traits
3. Du contexte de la conversation

Réponds UNIQUEMENT en JSON:
[
  {"name": "prénom", "score": 85, "reason": "raison courte en 5 mots max"},
  ...
]
Trie par score décroissant. JSON uniquement.`
    }]
  });

  try {
    let text = analysis.content[0].text.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const matches = JSON.parse(text);
    res.json(matches.slice(0, 3));
  } catch(e) {
    res.json([]);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Korale running on port ${PORT}`));