require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
      messages JSONB DEFAULT '[]',
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
  console.log('Base de données initialisée');
}

initDB();

// Middleware auth
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

// Inscription
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
  } 
 catch (e) {
    console.log('Erreur inscription:', e.message);
    if (e.code === '23505') {
      res.status(400).json({ error: 'Email déjà utilisé' });
    } else {
      res.status(500).json({ error: 'Erreur: ' + e.message });
    }
  }
});

// Connexion
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

// Chat
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { messages, conversationId } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: "Tu es Korale, un assistant IA personnel intelligent. Tu aides l'utilisateur dans ses projets, idées, code et réflexions. Tu es chaleureux, précis et utile.",
    messages: messages,
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      fullResponse += chunk.delta.text;
      res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
    }
  }

  // Sauvegarde conversation
  if (conversationId) {
    await pool.query(
      'UPDATE conversations SET messages = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
      [JSON.stringify(messages.concat([{ role: 'assistant', content: fullResponse }])), conversationId, req.user.id]
    );
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// Nouvelle conversation
app.post('/api/conversations', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'INSERT INTO conversations (user_id, messages) VALUES ($1, $2) RETURNING id',
    [req.user.id, '[]']
  );
  res.json({ id: result.rows[0].id });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Korale running on port ${PORT}`));