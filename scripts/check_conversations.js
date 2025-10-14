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

async function fetchPage(pageToken, maxResults = 50) {
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

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name, def) => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    if (!found) return def;
    const val = found.split('=')[1];
    return val ?? def;
  };
  const report = get('report', 'counts'); // counts | full
  const out = get('out', '');
  const limitPages = Number(get('limitPages', '10'));
  const pageSize = Number(get('pageSize', '50'));
  const writeArg = get('write', 'true');
  const write = writeArg === 'true';
  return { report, out, limitPages, pageSize, write };
}

async function fetchAllConversations(limitPages = 10, pageSize = 50) {
  let token = undefined;
  let pages = 0;
  const all = [];
  while (pages < limitPages) {
    const data = await fetchPage(token, pageSize);
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

function classifyConversations(convs) {
  const withContacts = [];
  const withoutContacts = [];
  const typeStats = { stringParticipants: 0, objectParticipants: 0, mixedParticipants: 0 };
  const groups = [];
  const solo = [];

  for (const c of convs) {
    const hasContacts = Array.isArray(c.participantContacts) && c.participantContacts.length > 0;
    const types = Array.isArray(c.participants) ? c.participants.map(p => typeof p) : [];
    const hasObj = types.includes('object');
    const hasStr = types.includes('string');
    if (hasObj && hasStr) typeStats.mixedParticipants++;
    else if (hasObj) typeStats.objectParticipants++;
    else if (hasStr) typeStats.stringParticipants++;

    if (hasContacts) withContacts.push(c);
    else withoutContacts.push(c);

    const count = Array.isArray(c.participants) ? c.participants.length : 0;
    if (count > 1) groups.push(c); else solo.push(c);
  }

  return { withContacts, withoutContacts, typeStats, groups, solo };
}

function pickSampleFields(c) {
  const contact = Array.isArray(c.participantContacts) ? c.participantContacts[0] : null;
  return {
    id: c.id,
    phoneNumberId: c.phoneNumberId,
    participants: c.participants,
    participantContacts: contact ? { displayName: contact.displayName, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, role: contact.role, phoneNumbers: contact.phoneNumbers } : null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastActivityAt: c.lastActivityAt
  };
}

function summarize(withContacts, withoutContacts) {
  const keysWith = new Set();
  const keysWithout = new Set();
  withContacts.forEach(c => Object.keys(c).forEach(k => keysWith.add(k)));
  withoutContacts.forEach(c => Object.keys(c).forEach(k => keysWithout.add(k)));

  const onlyInWith = [...keysWith].filter(k => !keysWithout.has(k));
  const onlyInWithout = [...keysWithout].filter(k => !keysWith.has(k));

  return { onlyInWith, onlyInWithout, commonKeys: [...keysWith].filter(k => keysWithout.has(k)) };
}

function mapDuplicatesByNumber(convs) {
  const map = new Map();
  for (const c of convs) {
    const parts = Array.isArray(c.participants) ? c.participants : [];
    for (const p of parts) {
      const arr = map.get(p) || [];
      arr.push(c.id);
      map.set(p, arr);
    }
  }
  const duplicates = {};
  for (const [num, ids] of map.entries()) {
    if (ids.length > 1) duplicates[num] = ids;
  }
  return { duplicates, counts: Object.fromEntries([...map.entries()].map(([n, ids]) => [n, ids.length])) };
}

(async function main() {
  try {
    const { report, out, limitPages, pageSize, write } = parseArgs();
    console.log('🔍 Carregando conversas do OpenPhone...');
    const conversations = await fetchAllConversations(limitPages, pageSize);
    console.log(`📦 Total de conversas: ${conversations.length}`);
    const { withContacts, withoutContacts, typeStats, groups, solo } = classifyConversations(conversations);

    // Report simples: apenas contagens
    if (report === 'counts') {
      const counts = {
        totalConversations: conversations.length,
        groupsCount: groups.length,
        soloCount: solo.length,
        participantsTypes: typeStats,
        examples: {
          groups: groups.slice(0, 5).map(c => ({ id: c.id, phoneNumberId: c.phoneNumberId, participants: c.participants })),
          solo: solo.slice(0, 5).map(c => ({ id: c.id, phoneNumberId: c.phoneNumberId, participants: c.participants }))
        }
      };
      console.log('👥 Conversas com mais de um participante (groups):', counts.groupsCount);
      console.log('🧑‍🤝‍🧑 Conversas 1:1 (solo):', counts.soloCount);
      if (write) {
        const outPath = path.join(__dirname, out || 'conversations_counts.json');
        fs.writeFileSync(outPath, JSON.stringify(counts, null, 2), 'utf8');
        console.log(`💾 Contagens salvas em: ${outPath}`);
      }
      return; // encerra aqui para o relatório simples
    }

    // Report completo: preserva comportamento anterior (resumo amplo)
    const summaryKeys = summarize(withContacts, withoutContacts);
    const dupMap = mapDuplicatesByNumber(conversations);
    const result = {
      stats: {
        total: conversations.length,
        withContacts: withContacts.length,
        withoutContacts: withoutContacts.length,
        groups: groups.length,
        solo: solo.length,
        typeStats
      },
      keyDiffs: summaryKeys,
      distribution: {
        participantsCount: {
          one: solo.length,
          moreThanOne: groups.length
        }
      },
      duplicatesByNumber: dupMap,
      all: {
        raw: conversations,
        reduced: conversations.map(pickSampleFields)
      },
      groups: {
        raw: groups,
        reduced: groups.map(pickSampleFields)
      },
      solo: {
        raw: solo,
        reduced: solo.map(pickSampleFields)
      }
    };
    const outPath = path.join(__dirname, out || 'conversations_dump.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`💾 Relatório completo salvo em: ${outPath}`);
  } catch (err) {
    console.error('❌ Falha:', err.message);
    process.exit(1);
  }
})();