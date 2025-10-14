# InterChat MVP - SMS/MMS Chat Platform

MVP de chat que recebe e envia SMS/MMS via OpenPhone (Quo API) com tradução automática e interface multilíngue.

## Funcionalidades

- ✅ **Chat SMS/MMS**: Integração completa com OpenPhone API
- ✅ **Interface Multilíngue**: UI traduzida com i18next (PT, EN, ES, FR)
- ✅ **Tradução Automática**: Mensagens traduzidas automaticamente (DEEPL, LibreTranslate, Google)
- ✅ **Tempo Real**: Atualizações via Server-Sent Events (SSE)
- ✅ **Responsivo**: Interface adaptável para desktop e mobile
- ✅ **Deploy Ready**: Configurado para Render com Docker

## Tecnologias

- **Frontend**: HTML5, CSS3, JavaScript (Vanilla), i18next
- **Backend**: Node.js, Express
- **APIs**: OpenPhone, DeepL, LibreTranslate
- **Deploy**: Docker, Render

## Configuração

### 1. Instalar Dependências

```bash
npm install
```

### 2. Configurar Variáveis de Ambiente

Copie `.env.example` para `.env` e configure:

```bash
# OpenPhone API
OPENPHONE_API_KEY=OP-KEY...
OPENPHONE_FROM=+15551234567
OPENPHONE_USER_ID=USxxxx

# Tradução (escolha um)
TRANSLATE_PROVIDER=DEEPL  # ou LIBRE ou GOOGLE

# DeepL (se usando DEEPL)
DEEPL_API_KEY=...

# LibreTranslate (se usando LIBRE)
LIBRE_URL=https://libretranslate.com
LIBRE_API_KEY=  # opcional

# Servidor
PORT=3000
ORIGIN=http://localhost:3000
```

### 3. Executar

```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

Acesse: http://localhost:3000

## Estrutura do Projeto

```
interchat/
├── server.js              # Servidor Express
├── package.json           # Dependências
├── Dockerfile             # Container Docker
├── render.yaml            # Configuração Render
├── .env.example           # Exemplo de variáveis
└── public/
    └── index.html         # Frontend completo
```

## APIs Disponíveis

### Backend Endpoints

- `GET /api/conversations` - Lista conversas
- `GET /api/messages` - Lista mensagens de uma conversa
- `POST /api/messages` - Envia mensagem (com tradução opcional)
- `GET /api/sse` - Server-Sent Events para tempo real
- `POST /webhooks/openphone` - Webhook para eventos OpenPhone
- `GET /healthz` - Health check

### Parâmetros de Tradução

```javascript
// Enviar mensagem com tradução
POST /api/messages
{
  "text": "Hello world",
  "to": "+15551234567",
  "targetLang": "pt",  // Traduzir para português
  "sourceLang": "en"   // Opcional: idioma origem
}
```

## Deploy no Render

### Opção 1: Via GitHub

1. Faça push do código para GitHub
2. Conecte o repositório no Render
3. Configure as variáveis de ambiente
4. Deploy automático

### Opção 2: Via Docker

```bash
# Build
docker build -t interchat .

# Run
docker run -p 3000:3000 --env-file .env interchat
```

### Variáveis de Ambiente no Render

Configure no painel do Render:

- `OPENPHONE_API_KEY` - Sua chave da API OpenPhone
- `OPENPHONE_FROM` - Número remetente (+15551234567)
- `TRANSLATE_PROVIDER` - DEEPL, LIBRE ou GOOGLE
- `DEEPL_API_KEY` - Se usando DeepL
- `LIBRE_URL` - URL do LibreTranslate (padrão: https://libretranslate.com)

## Uso

### Interface

1. **Lista de Conversas** (esquerda): Clique em uma conversa para abrir
2. **Chat** (centro): Visualize histórico e envie mensagens
3. **Configurações** (direita): 
   - Idioma da Interface: Muda toda a UI
   - Idioma de Saída: Traduz mensagens enviadas

### Tradução

- **Interface**: Muda instantaneamente sem recarregar
- **Mensagens**: Apenas as enviadas são traduzidas
- **Persistência**: Configurações salvas no localStorage

### Tempo Real

- Mensagens recebidas aparecem automaticamente
- Status de conexão visível nas configurações
- Notificações visuais para novas mensagens

## Desenvolvimento

### Estrutura do Código

- `server.js`: APIs, proxy OpenPhone, tradução, SSE
- `public/index.html`: Frontend completo com i18next
- Sem frameworks: Apenas HTML/CSS/JS vanilla

### Adicionar Idiomas

1. Edite `translations` em `public/index.html`
2. Adicione novo idioma no select `uiLang`
3. Configure mapeamento no provedor de tradução

### Provedores de Tradução

Implemente novos provedores em `translateText()`:

```javascript
case 'NOVO_PROVIDER':
  return await translateWithNovoProvider(text, targetLang, sourceLang);
```

## Limitações do MVP

- Sem autenticação (adicionar Basic Auth em produção)
- Sem verificação de assinatura do webhook
- Sem suporte a MMS/anexos
- Sem busca ou filtros avançados
- Sem notificações push

## Próximos Passos

- [ ] Botão "Traduzir" em mensagens recebidas
- [ ] Suporte a MMS (imagens/anexos)
- [ ] Estados de entrega/leitura
- [ ] Busca e filtros
- [ ] Autenticação e segurança
- [ ] Notificações push
- [ ] Múltiplos números de envio

## Suporte

Para problemas com:
- **OpenPhone**: Verifique API key e configuração
- **Tradução**: Teste provedores individualmente
- **Deploy**: Verifique logs no Render
- **SSE**: Confirme CORS e origem

## Licença

MIT License