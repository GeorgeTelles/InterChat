const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;

// OpenPhone Configuration
const OPENPHONE_API = process.env.OPENPHONE_API || 'https://api.openphone.com/v1';
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;
const OPENPHONE_FROM = process.env.OPENPHONE_FROM;
const OPENPHONE_USER_ID = process.env.OPENPHONE_USER_ID;
const OPENPHONE_WEBHOOK_SECRET = process.env.OPENPHONE_WEBHOOK_SECRET;
const OPENPHONE_WEBHOOK_URL = process.env.OPENPHONE_WEBHOOK_URL;

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
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper Functions
function authHeader() {
  return { Authorization: OPENPHONE_API_KEY };
}

// Verificação de assinatura de webhook OpenPhone (HMAC-SHA256)
function verifyWebhookSignature(req) {
  try {
    const header = req.headers['openphone-signature'];
    if (!OPENPHONE_WEBHOOK_SECRET) {
      return { ok: false, reason: 'missing_secret' };
    }
    if (!header) {
      return { ok: false, reason: 'missing_header' };
    }
    const parts = String(header).split(';');
    if (parts.length < 4 || parts[0] !== 'hmac') {
      return { ok: false, reason: 'invalid_scheme' };
    }
    const timestamp = parts[2];
    const signature = parts[3]?.trim();

    // Preferir corpo bruto; fallback para JSON stringificado
    let raw = req.rawBody;
    if (!raw) {
      try {
        raw = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
      } catch {
        raw = Buffer.from('');
      }
    }

    const rawStr = raw.toString('utf8');

    // Calcular HMAC em ambos formatos (hex e base64), com e sem timestamp
    const digestHex = crypto.createHmac('sha256', OPENPHONE_WEBHOOK_SECRET).update(raw).digest('hex');
    const digestBase64 = crypto.createHmac('sha256', OPENPHONE_WEBHOOK_SECRET).update(raw).digest('base64');
    const digestHexTs = crypto.createHmac('sha256', OPENPHONE_WEBHOOK_SECRET).update(`${timestamp}.${rawStr}`).digest('hex');
    const digestBase64Ts = crypto.createHmac('sha256', OPENPHONE_WEBHOOK_SECRET).update(`${timestamp}.${rawStr}`).digest('base64');

    const ok = [digestHex, digestBase64, digestHexTs, digestBase64Ts].includes(signature);

    return { ok, timestamp, signature, digest1: digestHex, digest2: digestHexTs };
  } catch (err) {
    return { ok: false, reason: 'error', error: err?.message };
  }
}

// Normalização de payloads de mensagem do OpenPhone
function normalizeMessageEvent(event) {
  if (!event) return null;
  const type = event.type || event.event?.type || event?.detail?.type || '';
  
  // OpenPhone v4 API: dados estão em event.data.object
  const m = event?.data?.object || event?.data?.message || event?.message || event?.data || event?.payload?.message || event?.payload || event;
  
  if (!m) return null;

  // Extrair campos de IDs e conteúdo de forma robusta
  const id = m.id || m.messageId || event.messageId || event.id;
  const content = m.text || m.content || m.body || m.message || '';

  // Extrair números de forma robusta (string ou objeto)
  const from = typeof m.from === 'string' ? m.from : (m.from?.phoneNumber || m.from?.number || m.from?.id);
  let to = [];
  if (Array.isArray(m.to)) {
    to = m.to.map(t => (typeof t === 'string' ? t : (t?.phoneNumber || t?.number || t?.id))).filter(Boolean);
  } else if (m.to) {
    to = [typeof m.to === 'string' ? m.to : (m.to?.phoneNumber || m.to?.number || m.to?.id)].filter(Boolean);
  }

  // Participantes (remoto) e direção
  let direction = m.direction || (to.length ? 'outgoing' : 'incoming');
  let participants = Array.isArray(m.participants) ? m.participants : (m.participants ? [m.participants] : []);
  if (!participants.length) {
    if (direction === 'incoming' && from) participants = [from];
    if (direction === 'outgoing' && to.length) participants = [to[0]];
  }

  const createdAt = m.createdAt || m.created_at || event.createdAt || new Date().toISOString();
  const phoneNumberId = m.phoneNumberId || m.phone_number_id || m.phoneNumberId;
  const status = m.status || (type === 'message.delivered' ? 'delivered' : undefined);

  const message = { id, direction, content, from, to, participants, createdAt, phoneNumberId, status };
  return { type, data: message };
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
      // After populating last messages, filter out conversations without any messages
      if (data && Array.isArray(data.data)) {
        const beforeCount = data.data.length;
        data.data = data.data.filter(c => c.lastMessage);
        const afterCount = data.data.length;
        console.log(`   🧹 Removed ${beforeCount - afterCount} conversations with no messages`);
      }
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

// GET /api/search - Search conversations (local JSON fallback)
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q é obrigatório' });

    const fs = require('fs');
    const dumpPath = path.join(__dirname, 'scripts', 'conversations_dump.json');
    let results = [];

    if (fs.existsSync(dumpPath)) {
      const raw = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
      const all = Array.isArray(raw?.all?.raw) ? raw.all.raw : [];
      const qLower = q.toLowerCase();
      results = all.filter(c => {
        const num = Array.isArray(c.participants) ? (c.participants[0] || '') : '';
        const hay = `${c.id || ''} ${c.name || ''} ${num}`.toLowerCase();
        return hay.includes(qLower);
      }).map(c => ({
        id: c.id,
        participants: c.participants,
        phoneNumberId: c.phoneNumberId,
        lastActivityAt: c.lastActivityAt,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        name: c.name || null
      }));
    } else {
      // Fallback: query remote conversations and filter client-side
      const url = `${OPENPHONE_API}/conversations?maxResults=50`;
      const resp = await fetch(url, { headers: authHeader() });
      const data = await resp.json().catch(() => ({}));
      const list = Array.isArray(data?.data) ? data.data : [];
      const qLower = q.toLowerCase();
      results = list.filter(c => {
        const num = Array.isArray(c.participants) ? (c.participants[0] || '') : '';
        const hay = `${c.id || ''} ${c.name || ''} ${num}`.toLowerCase();
        return hay.includes(qLower);
      });
    }

    res.status(200).json({ data: results });
  } catch (err) {
    console.error('Error in /api/search:', err);
    res.status(500).json({ error: 'Falha na busca' });
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
const sseHeartbeats = new Map();

app.get('/api/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': ORIGIN,
  });

  // Hint client reconnection interval
  res.write('retry: 3000\n\n');
  // Initial ping to confirm open
  res.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);

  sseClients.add(res);
  console.log(`🔌 SSE client connected. Total: ${sseClients.size}`);

  // Heartbeat every 25s to keep connection alive through proxies
  const interval = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
    } catch (err) {
      console.warn('⚠️ SSE heartbeat write failed:', err?.message);
    }
  }, 25000);
  sseHeartbeats.set(res, interval);

  req.on('close', () => {
    sseClients.delete(res);
    const hb = sseHeartbeats.get(res);
    if (hb) clearInterval(hb);
    sseHeartbeats.delete(res);
    console.log(`🔌 SSE client disconnected. Total: ${sseClients.size}`);
  });
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
    // Verificar assinatura (não bloquear caso falhe)
    const verification = verifyWebhookSignature(req);
    if (!verification.ok) {
      console.warn('🔐 Assinatura de webhook inválida ou ausente:', verification);
    }

    const event = req.body;
    
    // Log completo do payload para debug
    console.log('🔍 PAYLOAD COMPLETO:', JSON.stringify(event, null, 2));
    
    const normalized = normalizeMessageEvent(event);
    console.log('🔄 NORMALIZADO:', JSON.stringify(normalized, null, 2));

    // Difundir somente eventos de mensagem
    if (normalized?.type?.includes('message')) {
      // Logs estruturados
      console.log('📬 Evento:', { type: normalized.type, id: normalized?.data?.id, to: normalized?.data?.to, from: normalized?.data?.from });
      broadcast('openphone', normalized);
    } else {
      console.log('⚠️ Evento não é de mensagem ou não foi normalizado:', normalized?.type || 'tipo indefinido');
    }

    // Responder 2xx rapidamente
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ ok: false });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler (last middleware)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
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
  // Tentar registrar webhooks automaticamente, se configurado
  ensureOpenPhoneWebhooks();
});

// Registro automático opcional de webhooks de mensagens
async function ensureOpenPhoneWebhooks() {
  try {
    if (!OPENPHONE_WEBHOOK_URL) {
      console.log('ℹ️ OPENPHONE_WEBHOOK_URL não definido; pulando criação automática de webhooks.');
      return;
    }
    console.log('🔧 Verificando webhooks existentes no OpenPhone...');
    const listResp = await fetch(`${OPENPHONE_API}/webhooks`, { headers: authHeader() });
    const list = await listResp.json().catch(() => ({}));
    const exists = Array.isArray(list?.data) && list.data.some(w => w.url === OPENPHONE_WEBHOOK_URL);
    if (exists) {
      console.log('✅ Webhook já existe:', OPENPHONE_WEBHOOK_URL);
      return;
    }
    console.log('🪝 Criando webhook de mensagens:', OPENPHONE_WEBHOOK_URL);
    const createResp = await fetch(`${OPENPHONE_API}/webhooks/messages`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: ['message.received', 'message.delivered'],
        url: OPENPHONE_WEBHOOK_URL
      })
    });
    const created = await createResp.json().catch(() => ({}));
    if (!createResp.ok) {
      console.warn('⚠️ Falha ao criar webhook:', createResp.status, created);
    } else {
      console.log('🎉 Webhook criado com sucesso:', created?.id || created);
    }
  } catch (err) {
    console.warn('⚠️ Erro ao garantir webhooks:', err?.message);
  }
}