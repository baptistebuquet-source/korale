require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: "Tu es Korale, un assistant IA personnel intelligent. Tu aides l'utilisateur dans ses projets, idées, code et réflexions. Tu es chaleureux, précis et utile.",
    messages: messages,
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Korale running on port ${PORT}`));