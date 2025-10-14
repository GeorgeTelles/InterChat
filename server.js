const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;

// OpenPhone Configuration
const OPENPHONE_API = process.env.OPENPHONE_API || 'https://api.openphone.com/v1';
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;
const OPENPHONE_FROM = process.env.OPENPHONE_FROM;
const OPENPHONE_USER_ID = process.env.OPENPHONE_USER_ID;

// Translation Configuration
const TRANSLATE_PROVIDER = process.env.TRANSLATE_PROVIDER || 'LIBRE';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const LIBRE_URL = process.env.LIBRE_URL || 'https://libretranslate.com';
const LIBRE_API_KEY = process.env.LIBRE_API_KEY;
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
// OpenAI (LLM) Configuration for per-message translation
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Middleware
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper Functions
function authHeader() {
  return { Authorization: OPENPHONE_API_KEY };
}

// Translation Module
async function translateText(text, targetLang, sourceLang = 'auto', prompt = '') {
  if (!text || !targetLang) return text;
  
  try {
    switch (TRANSLATE_PROVIDER) {
      case 'DEEPL':
        return await translateWithDeepL(text, targetLang, sourceLang);
      case 'GOOGLE':
        return await translateWithGoogle(text, targetLang, sourceLang);
      case 'OPENAI':
        return await translateWithOpenAI(text, targetLang, prompt);
      case 'LIBRE':
      default:
        return await translateWithLibre(text, targetLang, sourceLang);
    }
  } catch (error) {
    console.error('Translation error:', error);
    return text; // Fallback to original text
  }
}

async function translateWithDeepL(text, targetLang, sourceLang) {
  if (!DEEPL_API_KEY) throw new Error('DEEPL_API_KEY not configured');
  
  const response = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      text,
      target_lang: targetLang.toUpperCase(),
      source_lang: sourceLang === 'auto' ? undefined : sourceLang.toUpperCase(),
    }),
  });
  
  const data = await response.json();
  return data.translations?.[0]?.text || text;
}

async function translateWithLibre(text, targetLang, sourceLang) {
  const url = `${LIBRE_URL}/translate`;
  const headers = { 'Content-Type': 'application/json' };
  if (LIBRE_API_KEY) headers['Authorization'] = `Bearer ${LIBRE_API_KEY}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      q: text,
      source: sourceLang === 'auto' ? 'auto' : sourceLang,
      target: targetLang,
    }),
  });
  
  const data = await response.json();
  return data.translatedText || text;
}

async function translateWithGoogle(text, targetLang, sourceLang) {
  // Simplified Google Translate implementation
  // In production, use @google-cloud/translate
  throw new Error('Google Translate not implemented in this MVP');
}

// LLM-based translation via OpenAI Chat Completions (gpt-4o-mini)
async function translateWithOpenAI(text, targetLang, prompt) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const systemPrompt = `Você é um tradutor cuidadoso. Traduza para ${targetLang}. Preserve significado e tom. Não traduza trechos em blocos de código Markdown. Responda somente com a tradução.`;
  const userPrompt = (prompt || '') + `\n\nIdioma destino: ${targetLang}\nTexto:\n${text}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI error: ${response.status}`;
    throw new Error(message);
  }
  const translated = data?.choices?.[0]?.message?.content?.trim();
  return translated || text;
}

// Health Check
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes

// GET /api/conversations - List conversations
app.get('/api/conversations', async (req, res) => {
  try {
    const { pageToken, maxResults = 40 } = req.query;
    
    console.log('🔍 Fetching conversations...');
    
    // Build query parameters for OpenPhone API
    const queryParams = new URLSearchParams({
      maxResults: maxResults.toString()
    });
    
    if (pageToken) {
      queryParams.append('pageToken', pageToken);
    }
    
    const apiUrl = `${OPENPHONE_API}/conversations?${queryParams.toString()}`;
    console.log(`   URL: ${apiUrl}`);
    console.log(`   Headers:`, authHeader());
    
    const response = await fetch(apiUrl, {
      headers: authHeader(),
    });
    
    console.log(`   Response status: ${response.status}`);
    
    const data = await response.json();
    console.log(`   Response data:`, data);

    // Filter out group conversations (participants.length > 1)
    if (data && Array.isArray(data.data)) {
      const before = data.data.length;
      data.data = data.data.filter(c => Array.isArray(c.participants) && c.participants.length === 1);
      const after = data.data.length;
      const discarded = before - after;
      console.log(`   🚫 Discarded ${discarded} group conversations (participants.length > 1). Solo remaining: ${after}`);
    }
    
    // Fetch last message for each conversation (no contact enrichment) - only solo after filter
    if (data.data && Array.isArray(data.data)) {
      console.log('🔍 Fetching last messages for conversations...');
      console.log(`   Found ${data.data.length} conversations to process`);
      
      for (let conversation of data.data) {
        try {
          // Build query parameters correctly for OpenPhone API
          const queryParams = new URLSearchParams({
            phoneNumberId: conversation.phoneNumberId,
            maxResults: '1'
          });
          
          // Add participants as separate parameters
          conversation.participants.forEach(participant => {
            queryParams.append('participants', participant);
          });
          
          const messageUrl = `${OPENPHONE_API}/messages?${queryParams.toString()}`;
          console.log(`   Fetching messages for conversation ${conversation.id} from: ${messageUrl}`);
          
          // Get the last message for this conversation
          const messagesResponse = await fetch(messageUrl, {
            headers: authHeader(),
          });
          
          console.log(`   Messages response status for ${conversation.id}: ${messagesResponse.status}`);
          
          if (messagesResponse.ok) {
            const messagesData = await messagesResponse.json();
            console.log(`   Messages data for ${conversation.id}:`, messagesData);
            
            if (messagesData.data && messagesData.data.length > 0) {
              conversation.lastMessage = messagesData.data[0];
              console.log(`   ✅ Added last message for conversation ${conversation.id}:`, messagesData.data[0]);
            } else {
              console.log(`   ⚠️ No messages found for conversation ${conversation.id}`);
            }
          } else {
            console.log(`   ❌ Failed to fetch messages for conversation ${conversation.id}: ${messagesResponse.status}`);
          }
        } catch (error) {
          console.error(`❌ Error fetching last message for conversation ${conversation.id}:`, error);
        }
      }
      console.log('✅ Finished fetching last messages');
    } else {
      console.log('⚠️ No conversation data found or data is not an array');
    }
    
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Falha ao carregar conversas' });
  }
});

// (removed) GET /api/contacts - not needed; returning only numbers as requested

// GET /api/messages - List messages for a conversation
app.get('/api/messages', async (req, res) => {
  try {
    const { phoneNumberId, participants, pageToken, limit = 50 } = req.query;
    
    if (!phoneNumberId || !participants) {
      return res.status(400).json({ error: 'phoneNumberId e participants são obrigatórios' });
    }
    
    const participantsArray = Array.isArray(participants) ? participants : [participants];
    const queryParams = new URLSearchParams({
      phoneNumberId,
      maxResults: String(limit),
    });

    if (pageToken) {
      queryParams.append('pageToken', pageToken);
    }

    // Append participants as separate 'participants' params per OpenPhone API
    participantsArray.forEach(p => queryParams.append('participants', p));

    const response = await fetch(`${OPENPHONE_API}/messages?${queryParams.toString()}`, {
      headers: authHeader(),
    });
    
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Falha ao carregar mensagens' });
  }
});

// POST /api/messages - Send a message
app.post('/api/messages', async (req, res) => {
  try {
    const { text, to, from, targetLang, sourceLang, userId, strict } = req.body;
    
    if (!text || !to) {
      return res.status(400).json({ error: 'text e to são obrigatórios' });
    }
    
    const fromNumber = from || OPENPHONE_FROM;
    if (!fromNumber) {
      return res.status(400).json({ error: 'from ausente. Configure OPENPHONE_FROM ou envie no corpo.' });
    }
    
    // Translate message if target language is specified
    let translatedText = text;
    if (targetLang) {
      if (strict) {
        try {
          translatedText = await translateWithOpenAI(text, targetLang, `Traduza para ${targetLang}, preserve sentido e tom, não traduza blocos de código Markdown, responda somente com a tradução.`);
        } catch (error) {
          console.error('Strict translation failed:', error);
          return res.status(500).json({ error: 'Falha na tradução', provider: 'openai', details: error.message });
        }
      } else {
        translatedText = await translateText(text, targetLang, sourceLang, `Traduza para ${targetLang}, preserve sentido e tom, não traduza blocos de código Markdown, responda somente com a tradução.`);
      }
    }
    
    const payload = {
      content: translatedText,
      from: fromNumber,
      to: Array.isArray(to) ? to : [to]
    };
    
    if (OPENPHONE_USER_ID || userId) {
      payload.userId = userId || OPENPHONE_USER_ID;
    }
    
    const response = await fetch(`${OPENPHONE_API}/messages`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Falha ao enviar mensagem' });
  }
});

// POST /api/translate - Per-message translation using OpenAI
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang, prompt } = req.body || {};
    if (!text || !targetLang) {
      return res.status(400).json({ error: 'text e targetLang são obrigatórios' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY não configurado', provider: 'openai' });
    }

    const translatedText = await translateWithOpenAI(text, targetLang, prompt);
    res.status(200).json({ translatedText, provider: 'openai', model: 'gpt-4o-mini' });
  } catch (error) {
    console.error('Error translating message:', error);
    res.status(500).json({ error: 'Falha na tradução', provider: 'openai', details: error.message });
  }
});

// SSE for real-time updates
const sseClients = new Set();

app.get('/api/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': ORIGIN,
  });
  
  res.write('\n');
  sseClients.add(res);
  
  req.on('close', () => sseClients.delete(res));
});

function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

// Webhook for OpenPhone events
app.post('/webhooks/openphone', async (req, res) => {
  try {
    const event = req.body;
    
    // Validate webhook signature in production
    if (event?.type?.includes('message')) {
      broadcast('openphone', event);
    }
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ ok: false });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Frontend available at: http://localhost:${PORT}`);
  
  // Debug environment variables
  console.log('🔧 Environment check:');
  console.log(`   OPENPHONE_API_KEY: ${OPENPHONE_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   OPENPHONE_FROM: ${OPENPHONE_FROM || '❌ Missing'}`);
  console.log(`   OPENPHONE_API: ${OPENPHONE_API}`);
  console.log(`   OPENAI_API_KEY: ${OPENAI_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  
  if (!OPENPHONE_API_KEY) {
    console.warn('⚠️  OPENPHONE_API_KEY not configured');
  }
  if (!OPENPHONE_FROM) {
    console.warn('⚠️  OPENPHONE_FROM not configured');
  }
});