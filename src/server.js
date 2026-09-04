require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const token = require('./token');
const groq = require('./groq');
const openai = require('./openai');
const db = require('./db');
const srty = require('./srty');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// A Cloudflare (proxy na frente do site) cacheia .js/.css na borda por horas,
// ignorando o Cache-Control que o Express manda — então cache-busting por
// header não adianta. A saída é o endereço mudar a cada deploy: injeta
// ?v=<timestamp do boot> no HTML, assim o navegador (e a Cloudflare) sempre
// buscam de novo depois de publicar algo. Foi o que deixou o toggle de tema
// "quebrado" pro Robson — ele estava com o app.js de antes do redesenho.
const ASSET_VERSION = Date.now();
const INDEX_HTML = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace('/style.css', `/style.css?v=${ASSET_VERSION}`)
  .replace('/app.js', `/app.js?v=${ASSET_VERSION}`);

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.use(express.json());

// Middleware: valida o token do link mágico (header Authorization: Bearer <token>).
function autenticar(req, res, next) {
  const header = req.headers.authorization || '';
  const t = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = t && token.verify(t);
  if (!payload) return res.status(401).json({ erro: 'Link inválido ou expirado. Peça um novo link.' });
  req.socio = payload; // { pessoaId, pessoaNome, exp }
  next();
}

// Página do sócio: serve o HTML com a versão dos assets embutida (ver ASSET_VERSION
// acima). O token fica só no client (localStorage), nunca em log de servidor.
app.get(['/', '/s/:token'], (req, res) => {
  res.type('html').send(INDEX_HTML);
});

// Endpoint interno: o Mural Financeiro chama isso no backend dele (nunca do navegador
// do sócio) pra montar o botão "Pergunte por voz" já apontando pro link mágico da
// pessoa logada, sem ela precisar colar nada. Protegido por segredo compartilhado
// nos dois lados (INTERNAL_LINK_SECRET), separado do TOKEN_SECRET que assina os
// links em si — assim o Mural Financeiro nunca precisa saber como o token é assinado.
app.get('/api/link-para-pessoa/:pessoaId', async (req, res) => {
  const segredo = req.headers['x-internal-secret'];
  if (!process.env.INTERNAL_LINK_SECRET || segredo !== process.env.INTERNAL_LINK_SECRET) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }
  try {
    const pessoaNome = await db.nomeDoSocio(req.params.pessoaId);
    if (!pessoaNome) return res.status(404).json({ erro: 'Pessoa não é sócio.' });

    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${base}/s/${token.signStavel({ pessoaId: req.params.pessoaId, pessoaNome })}`;
    res.json({ url: link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao gerar link.' });
  }
});

app.get('/api/me', autenticar, async (req, res) => {
  try {
    const empresas = await db.empresasDoSocio(req.socio.pessoaId);
    res.json({ nome: req.socio.pessoaNome, pessoaId: req.socio.pessoaId, empresas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao carregar empresas do sócio.' });
  }
});

app.post('/api/ask', autenticar, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Áudio não recebido.' });

    const empresasPermitidas = await db.empresasDoSocio(req.socio.pessoaId);
    if (empresasPermitidas.length === 0) {
      return res.status(403).json({ erro: 'Nenhuma empresa vinculada a este sócio.' });
    }

    const pergunta = await groq.transcrever(req.file.buffer, req.file.mimetype, req.file.originalname || 'audio.webm');
    if (!pergunta) return res.status(422).json({ erro: 'Não entendi o áudio. Tente falar de novo.' });

    const interpretacao = await openai.interpretarPergunta(pergunta, empresasPermitidas);

    if (!interpretacao.pergunta_valida) {
      // Não deixa o sócio num beco sem saída: mostra os lançamentos mais recentes dele
      // (dado real, sem IA — não precisa interpretar nada) e sugere como perguntar.
      const recentes = await db.lancamentos({
        empresaIds: empresasPermitidas.map((e) => e.empresa_id),
        limite: 3,
      });
      const formatador = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
      const dicas = 'Você pode perguntar, por exemplo: "o que foi lançado hoje", "o que foi lançado esse mês" ou "quais foram os últimos lançamentos".';

      const resposta = recentes.length
        ? `Não entendi uma pergunta financeira aí. Enquanto isso, seus lançamentos mais recentes: ${recentes
            .map((l) => `${l.empresa_nome} — ${l.descricao} (${formatador.format(l.valor)})`)
            .join('; ')}. ${dicas}`
        : `Não entendi uma pergunta financeira aí. ${dicas}`;

      return res.json({ pergunta, resposta, quantidade: recentes.length });
    }

    // Isolamento por sócio garantido AQUI: só aceita nomes que já estão na lista autorizada,
    // nunca confia no que o modelo devolveu além disso.
    const nomesPermitidos = new Set(empresasPermitidas.map((e) => e.empresa_nome));
    const empresasEscolhidas = (interpretacao.empresas || []).filter((nome) => nomesPermitidos.has(nome));
    const empresaIds = (
      empresasEscolhidas.length > 0
        ? empresasPermitidas.filter((e) => empresasEscolhidas.includes(e.empresa_nome))
        : empresasPermitidas
    ).map((e) => e.empresa_id);

    const registros = await db.lancamentos({
      empresaIds,
      dataInicio: interpretacao.data_inicio || null,
      dataFim: interpretacao.data_fim || null,
      natureza: interpretacao.natureza || null,
    });

    // "status" (pendente/confirmado) é controle interno do escritório, não interessa ao sócio —
    // nem entra nos dados que a IA recebe, pra não ter risco de mencionar por engano.
    const lancamentosParaIA = registros.slice(0, 50).map(({ status, ...resto }) => resto);

    const contexto = {
      empresas_consultadas: empresasPermitidas.filter((e) => empresaIds.includes(e.empresa_id)).map((e) => e.empresa_nome),
      quantidade_lancamentos: registros.length,
      lancamentos: lancamentosParaIA,
      aviso: interpretacao.pedido_tipo === 'saldo'
        ? 'Cálculo de saldo (extrato bancário + lançamentos) ainda não está disponível neste app — só lançamentos.'
        : null,
    };

    const respostaTexto = await openai.responderComDados(pergunta, contexto);

    res.json({ pergunta, resposta: respostaTexto, quantidade: registros.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao processar a pergunta.' });
  }
});

// Fala a resposta em voz — só chamado quando o sócio toca no alto-falante, nunca automático.
app.post('/api/tts', autenticar, async (req, res) => {
  try {
    const texto = String(req.body?.texto || '').slice(0, 1000);
    if (!texto) return res.status(400).json({ erro: 'Texto vazio.' });

    const audio = await openai.sintetizarVoz(texto);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao gerar áudio.' });
  }
});

// Página administrativa (só o Robson, protegida por basic auth no Caddy — ver README) com os
// links de cada sócio prontos pra copiar e mandar por WhatsApp. Token estável (não muda a cada
// carregamento) pra ele poder comparar com o que já mandou antes.
app.get('/admin/socios', async (req, res) => {
  try {
    const socios = await db.todosOsSocios();
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    const CORES = ['cor-0', 'cor-1', 'cor-2', 'cor-3'];
    const ICONE_PREDIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1"/></svg>';

    const cards = socios
      .map((s, i) => {
        const link = `${base}/s/${token.signStavel({ pessoaId: s.pessoaId, pessoaNome: s.pessoaNome })}`;
        const badges = s.empresas
          .map((nome, j) => `<span class="icone-selo rotulo ${CORES[j % 4]}" style="width:auto;height:auto;padding:4px 10px;border-radius:999px;font-size:12px;margin:0 6px 6px 0">${nome}</span>`)
          .join('');
        return `
          <div class="card-empresa">
            <p class="nome-empresa" style="margin-bottom:10px">${s.pessoaNome}</p>
            <div style="display:flex;flex-wrap:wrap;margin-bottom:12px">${badges}</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <code id="link-${s.pessoaId}" style="flex:1;display:block;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:11px;word-break:break-all;color:var(--text-secondary)">${link}</code>
              <button class="botao-copia-inline" onclick="copiar('link-${s.pessoaId}', this)" title="Copiar link" aria-label="Copiar link">
                <svg class="icone-copia" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <svg class="icone-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
            </div>
            <div style="display:flex;gap:14px">
              <div class="acao-tile">
                <button class="icone-selo azul-grande pequeno" onclick="copiar('link-${s.pessoaId}', this)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <span class="acao-tile-rotulo" id="rotulo-copiar-${s.pessoaId}">Copiar</span>
              </div>
              <div class="acao-tile">
                <button class="icone-selo violeta-grande pequeno" onclick="encurtar('${s.pessoaId}', this)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7a5 5 0 1 1 0-10h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                </button>
                <span class="acao-tile-rotulo" id="rotulo-encurtar-${s.pessoaId}">Encurtar</span>
              </div>
              <div class="acao-tile">
                <button class="icone-selo ambar-grande pequeno" onclick="personalizar('${s.pessoaId}', this)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </button>
                <span class="acao-tile-rotulo" id="rotulo-personalizar-${s.pessoaId}">Personalizar</span>
              </div>
            </div>
          </div>`;
      })
      .join('');

    res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#050505" />
<title>Links dos sócios</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}" />
<script>
  try {
    var t = localStorage.getItem('tema');
    if (t === 'claro' || t === 'intermediario') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
</script>
</head>
<body>
  <div class="fundo-ambiente"><div class="mancha-ambar"></div><div class="grade-ambiente"></div></div>
  <div class="tela">
    <header class="topo">
      <div class="avatar">A</div>
      <div class="topo-textos">
        <p class="rotulo-topo">Mural Financeiro</p>
        <p class="titulo-topo">Links dos sócios</p>
      </div>
      <div class="topo-acoes">
        <button class="botao-tema" data-tema="claro" aria-label="Tema claro" title="Tema claro">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button class="botao-tema" data-tema="intermediario" aria-label="Tema intermediário" title="Tema intermediário">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>
        </button>
        <button class="botao-tema" data-tema="escuro" aria-label="Tema escuro" title="Tema escuro">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
        </button>
      </div>
    </header>
    <p class="secao-rotulo">Copiar e mandar por WhatsApp</p>
    <div class="grid-socios">${cards}</div>
    <p class="status" style="margin-top:8px">Links estáveis, não expiram até 2030. Você não tem link próprio — já tem acesso direto ao Mural Financeiro.</p>
  </div>
  <script>
    function copiar(id, btn) {
      const texto = document.getElementById(id).textContent;
      const pessoaId = id.replace('link-', '');
      const rotulo = document.getElementById('rotulo-copiar-' + pessoaId);
      navigator.clipboard.writeText(texto).then(function () {
        const original = rotulo.textContent;
        rotulo.textContent = 'Copiado!';
        btn.classList.add('copiado');
        setTimeout(function () { rotulo.textContent = original; btn.classList.remove('copiado'); }, 1500);
      });
    }

    // Usada tanto pelo botão "Encurtar" (slug automático) quanto "Personalizar"
    // (slug escolhido pelo Robson) — só muda o corpo enviado e o texto de feedback.
    function chamarEncurtar(pessoaId, btn, rotuloId, customSlug) {
      const rotulo = document.getElementById(rotuloId);
      const original = rotulo.textContent;
      const classeSucesso = customSlug ? 'personalizado' : 'encurtado';
      const corpo = { pessoaId: pessoaId };
      if (customSlug) corpo.customSlug = customSlug;

      btn.disabled = true;
      rotulo.textContent = customSlug ? 'Salvando...' : 'Encurtando...';
      fetch('/admin/encurtar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      })
        .then(function (r) { return r.json(); })
        .then(function (dados) {
          btn.disabled = false;
          if (dados.erro) {
            btn.classList.add('falhou');
            rotulo.textContent = dados.erro;
            setTimeout(function () { btn.classList.remove('falhou'); rotulo.textContent = original; }, 2400);
            return;
          }
          document.getElementById('link-' + pessoaId).textContent = dados.shortUrl;
          navigator.clipboard.writeText(dados.shortUrl).catch(function () {});
          btn.classList.add(classeSucesso);
          rotulo.textContent = customSlug ? 'Salvo e copiado!' : 'Encurtado e copiado!';
          setTimeout(function () { btn.classList.remove(classeSucesso); rotulo.textContent = original; }, 1800);
        })
        .catch(function () {
          btn.disabled = false;
          btn.classList.add('falhou');
          rotulo.textContent = 'Falhou';
          setTimeout(function () { btn.classList.remove('falhou'); rotulo.textContent = original; }, 1800);
        });
    }

    function encurtar(pessoaId, btn) {
      chamarEncurtar(pessoaId, btn, 'rotulo-encurtar-' + pessoaId, null);
    }

    function personalizar(pessoaId, btn) {
      const digitado = window.prompt('Final do link (ex: leandro) — vira srty.com.br/<valor>:');
      if (!digitado) return;
      const slug = digitado.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!slug) return;
      chamarEncurtar(pessoaId, btn, 'rotulo-personalizar-' + pessoaId, slug);
    }

    var botoesTema = document.querySelectorAll('.botao-tema');
    function aplicarTema(tema) {
      if (tema === 'claro' || tema === 'intermediario') {
        document.documentElement.setAttribute('data-theme', tema);
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      botoesTema.forEach(function (b) { b.classList.toggle('ativo', b.dataset.tema === tema); });
      localStorage.setItem('tema', tema);
    }
    botoesTema.forEach(function (b) { b.addEventListener('click', function () { aplicarTema(b.dataset.tema); }); });
    aplicarTema(localStorage.getItem('tema') || 'escuro');
  </script>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Falha ao carregar sócios.');
  }
});

// Encurta o link de um sócio (mesma proteção do /admin/socios — basic auth no Caddy).
// Recebe só o pessoaId e reconstrói o link no servidor, em vez de confiar numa URL
// vinda do cliente, mesmo essa página já sendo de acesso restrito.
app.post('/admin/encurtar', async (req, res) => {
  try {
    const pessoaId = String(req.body?.pessoaId || '');
    const customSlug = req.body?.customSlug ? String(req.body.customSlug) : undefined;
    const pessoaNome = await db.nomeDoSocio(pessoaId);
    if (!pessoaNome) return res.status(404).json({ erro: 'Sócio não encontrado.' });

    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${base}/s/${token.signStavel({ pessoaId, pessoaNome })}`;
    const resultado = await srty.encurtarLink(link, customSlug);

    if (!resultado.ok) return res.status(502).json({ erro: resultado.erro });
    res.json({ shortUrl: resultado.shortUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao encurtar o link.' });
  }
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => console.log(`pergunta-por-socio rodando na porta ${PORT}`));
