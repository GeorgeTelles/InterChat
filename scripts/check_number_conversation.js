const fs = require('fs');
const path = require('path');
require('dotenv').config();

const OPENPHONE_API = process.env.OPENPHONE_API || 'https://api.openphone.com/v1';
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;

if (!OPENPHONE_API_KEY) {
  console.error('❌ OPENPHONE_API_KEY não configurado no .env');
  process.exit(1);
}

function authHeader() {
  return { Authorization: OPENPHONE_API_KEY };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name, def) => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    if (!found) return def;
    const val = found.split('=')[1];
    return val ?? def;
  };
  const number = (get('number', '') || '').trim();
  const limitPages = Number(get('limitPages', '10'));
  const pageSize = Number(get('pageSize', '50'));
  const recentHours = Number(get('recentHours', '168')); // 7 dias por padrão
  const out = get('out', '');
  return { number, limitPages, pageSize, recentHours, out };
}

async function fetchConversationsPage(pageToken, maxResults = 50) {
  const url = new URL(`${OPENPHONE_API}/conversations`);
  url.searchParams.set('maxResults', String(maxResults));
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url, { headers: authHeader() });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Erro ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function fetchAllConversations(limitPages = 10, pageSize = 50) {
  let token = undefined;
  let pages = 0;
  const all = [];
  while (pages < limitPages) {
    const data = await fetchConversationsPage(token, pageSize);
    const arr = Array.isArray(data.data) ? data.data : [];
    all.push(...arr);
    pages++;
    if (data.nextPageToken) {
      token = data.nextPageToken;
    } else {
      break;
    }
  }
  return all;
}

function findSoloByNumber(convs, number) {
  return convs.filter(c => Array.isArray(c.participants) && c.participants.length === 1 && c.participants[0] === number);
}

function findGroupsByNumber(convs, number) {
  return convs.filter(c => Array.isArray(c.participants) && c.participants.length > 1 && c.participants.includes(number));
}

async function fetchRecentMessages(phoneNumberId, participants, maxResults = 10) {
  const params = new URLSearchParams({ phoneNumberId, maxResults: String(maxResults) });
  participants.forEach(p => params.append('participants', p));
  const url = `${OPENPHONE_API}/messages?${params.toString()}`;
  const res = await fetch(url, { headers: authHeader() });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Erro mensagens ${res.status}: ${JSON.stringify(data)}`);
  }
  return Array.isArray(data.data) ? data.data : [];
}

function isRecent(dateStr, hours) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  return diffHours <= hours;
}

(async function main() {
  try {
    const { number, limitPages, pageSize, recentHours, out } = parseArgs();
    if (!number) {
      console.error('❌ Informe o número com --number="+E164"');
      process.exit(1);
    }

    console.log(`🔎 Verificando conversa 1:1 para ${number} ...`);
    const conversations = await fetchAllConversations(limitPages, pageSize);
    console.log(`📦 Conversas carregadas: ${conversations.length}`);

    const soloConvs = findSoloByNumber(conversations, number);
    const groupConvs = findGroupsByNumber(conversations, number);
    console.log(`🧑‍🤝‍🧑 Solo encontradas: ${soloConvs.length}`);
    console.log(`👥 Grupos encontrados: ${groupConvs.length}`);

    // Tentar validar "atual" pela última atividade e pelas mensagens do endpoint
    const results = [];
    const uniquePhoneNumberIds = new Set(conversations.map(c => c.phoneNumberId).filter(Boolean));

    // Verificar cada conversa solo diretamente
    for (const conv of soloConvs) {
      const msgs = await fetchRecentMessages(conv.phoneNumberId, conv.participants, 5);
      const latestMsg = msgs[0] || null;
      const latestTime = latestMsg?.createdAt || conv.lastActivityAt || conv.updatedAt || conv.createdAt;
      results.push({
        source: 'conversation',
        conversationId: conv.id,
        phoneNumberId: conv.phoneNumberId,
        participants: conv.participants,
        lastActivityAt: conv.lastActivityAt,
        latestMessageAt: latestMsg?.createdAt || null,
        isRecent: isRecent(latestTime, recentHours),
        messagesSample: msgs.slice(0, 3)
      });
    }

    // Caso não haja conversa solo listada, tentar diretamente o endpoint de mensagens por cada número de telefone
    if (soloConvs.length === 0) {
      console.log('🔁 Sem conversa 1:1 listada. Tentando via /messages com phoneNumberIds conhecidos...');
      for (const pni of uniquePhoneNumberIds) {
        try {
          const msgs = await fetchRecentMessages(pni, [number], 5);
          if (msgs.length > 0) {
            const latestMsg = msgs[0];
            results.push({
              source: 'messagesProbe',
              conversationId: null,
              phoneNumberId: pni,
              participants: [number],
              lastActivityAt: null,
              latestMessageAt: latestMsg?.createdAt || null,
              isRecent: isRecent(latestMsg?.createdAt, recentHours),
              messagesSample: msgs.slice(0, 3)
            });
          }
        } catch (err) {
          console.log(`   ⚠️ Falha ao consultar mensagens em ${pni}: ${err.message}`);
        }
      }
    }

    const summary = {
      number,
      totals: {
        conversationsLoaded: conversations.length,
        soloFound: soloConvs.length,
        groupsFound: groupConvs.length,
        probesWithMessages: results.filter(r => r.source === 'messagesProbe' && r.messagesSample && r.messagesSample.length > 0).length
      },
      soloConversations: soloConvs.map(c => ({ id: c.id, phoneNumberId: c.phoneNumberId, participants: c.participants, lastActivityAt: c.lastActivityAt, updatedAt: c.updatedAt })),
      groupConversations: groupConvs.map(c => ({ id: c.id, phoneNumberId: c.phoneNumberId, participants: c.participants, name: c.name || null, lastActivityAt: c.lastActivityAt })),
      recentWindowHours: recentHours,
      checks: results
    };

    const defaultOut = `check_number_${number.replace(/[^\d+]/g, '') || 'unknown'}.json`;
    const outPath = path.join(__dirname, out || defaultOut);
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`💾 Resultado salvo em: ${outPath}`);

    const hasRecent = summary.checks.some(r => r.isRecent);
    if (summary.soloConversations.length > 0) {
      console.log(`✅ Existe conversa 1:1 listada para ${number}. Recente: ${hasRecent ? 'sim' : 'não'}`);
    } else if (hasRecent) {
      console.log(`✅ Não há conversa 1:1 listada, mas há mensagens recentes via probe em /messages.`);
    } else {
      console.log(`⚠️ Não foi possível confirmar conversa 1:1 atual para ${number}.`);
    }
  } catch (err) {
    console.error('❌ Falha:', err.message);
    process.exit(1);
  }
})();