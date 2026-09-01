# Pergunta por sócio

PWA de pergunta em linguagem natural (mic) sobre lançamentos financeiros, por sócio.
Consome views read-only do Mural Financeiro (`v_socio_empresas`, `v_socio_lancamentos`)
via o role `mural_socio_readonly` — nunca acessa tabelas de auth do Mural.

Pipeline: **Groq Whisper** (transcrição) → **OpenAI GPT** (interpreta a pergunta e escolhe
que dados buscar) → Postgres (consulta filtrada, isolamento por sócio aplicado em código) →
**OpenAI GPT** (compõe a resposta em texto) → **Web Speech API do navegador** (fala a resposta,
grátis, roda no celular do sócio).

## Isolamento por sócio

As views do Mural **não** têm RLS — qualquer credencial com `SELECT` nelas enxerga todos os
sócios e empresas. O isolamento é 100% responsabilidade deste app:

1. O token do link mágico carrega `pessoaId` (assinado com `TOKEN_SECRET`, ver `src/token.js`).
2. `db.empresasDoSocio(pessoaId)` busca em `v_socio_empresas` **só** as empresas vinculadas a esse sócio.
3. A IA (OpenAI) só pode escolher nomes de empresa dentro dessa lista — `server.js` filtra
   qualquer coisa fora dela antes de montar a query em `v_socio_lancamentos`.
4. A IA nunca gera SQL. Ela devolve JSON estruturado; o código monta a query parametrizada.

## Setup

```bash
npm install
cp .env.example .env
# preencher GROQ_API_KEY, OPENAI_API_KEY, MURAL_DB_*, TOKEN_SECRET (gerar um valor aleatório longo)
npm run dev
```

Gerar um link pra um sócio (depois do banco configurado):

```bash
npm run link -- "Nome do sócio"
```

## Pendências conhecidas (v1)

- **Saldo ainda não é calculado.** O desenho original (ver handoff em `claude-sessions-log`)
  previa saldo = último extrato bancário (upload manual semanal) + lançamentos desde então.
  As views atuais só expõem lançamentos, não um extrato-base — falta essa fonte de dado antes
  de implementar saldo. Hoje o app responde só sobre lançamentos; se a pergunta for de saldo,
  avisa que ainda não está disponível. Ver spec de v2 abaixo.
- ~~Credencial do Postgres pendente~~ — recebida do Robson e testada em 2026-08-31 (conexão real
  ao Supabase do Mural, `pessoa_id`/`empresa_id` são `uuid`, não `int` — código ajustado). Fluxo
  completo (empresas do sócio, isolamento, interpretação da pergunta, consulta filtrada) validado
  ponta a ponta com dados reais: Leandro vê Savecore + Macrovisor, Paulo Magalhães só vê Macrovisor,
  batendo com o exemplo do desenho original.
## Spec v2 — saldo com extrato + notificação por chat

Confirmado com o Robson (2026-08-31): ele sobe o extrato bancário manualmente **uma vez por
semana**. Regra de "atualizado": extrato com até ~7 dias é considerado válido pra calcular saldo
(saldo = valor do extrato + soma dos lançamentos registrados depois da data do extrato).

Fluxo quando o sócio pergunta sobre saldo:

1. **Extrato válido (≤7 dias) existe pra empresa dele** → responde o saldo calculado; pergunta se
   ele quer ver o extrato; se sim, entrega o arquivo dentro do próprio app (endpoint de download
   autenticado pelo mesmo token do link mágico).
2. **Extrato ausente ou vencido (>7 dias)** → avisa o sócio que vai pedir pro Robson, e dispara uma
   mensagem pro Robson via **Telegram** (reaproveitando o bot que já existe no Comunicação Direta)
   pedindo pra subir o extrato daquela empresa.
3. **Quando o Robson sobe o extrato** → o app confirma o recebimento pra ele, e manda uma mensagem
   automática de volta pro sócio via **WhatsApp** (Evolution Andrea, `evo-andrea.plataformafacil.com.br`)
   avisando que já pode perguntar de novo.

Tudo isso é self-contained na infra que a Máquina 1 já mantém (Telegram + Evolution Andrea) — não
depende de nada novo da Conta 2/Mural Financeiro. Precisa de uma tabela própria pra guardar
extrato (empresa, data, valor, arquivo) — não vive no Postgres do Mural (role é só leitura) — mais
provavelmente SQLite local nesta app, no mesmo padrão do Comunicação Direta.

**Não implementado ainda** — construir depois do v1 (lançamentos) estar rodando de verdade.

- **Entrega do link** é manual (Robson envia por WhatsApp/e-mail) — sem automação por enquanto.
- Sem testes automatizados ainda.

## Deploy (concluído em 2026-08-31/09-01)

Rodando na VPS Andrea, mesmo padrão do Comunicação Direta:

- Repositório: `github.com/iaprodutividade/pergunta-por-socio` (deploy key read-only `Andrea VPS
  deploy read-only` cadastrada nas Settings do repo — nota: o GitHub bloqueou temporariamente a
  troca do repo pra privado por um cooldown de segurança pós-criação; retomar isso depois, não tem
  segredo nenhum commitado enquanto isso).
- Código em `/opt/pergunta-por-socio` na VPS, `.env` de produção com `chmod 600` (token secret
  próprio de produção, diferente do usado em dev local).
- Container Docker `pergunta-por-socio`, `--restart always`, `127.0.0.1:3200` (não exposto direto).
- Reverse proxy: bloco em `/opt/ia-produtividade/caddy/Caddyfile` pra `socios.plataformafacil.com.br`.
- DNS: registro A em Cloudflare (`socios` → `157.151.22.192`, proxied) — criado pelo Robson (esse
  painel é bloqueado pra automação).
- **Detalhe importante de conexão**: o host direto do Supabase (`db.<ref>.supabase.co`) só resolve
  IPv6, e a VPS Andrea não tem rota IPv6 — por isso o app usa o **Session Pooler** do Supabase
  (`aws-0-sa-east-1.pooler.supabase.com:5432`, usuário no formato `<role>.<project_ref>`), que é
  IPv4. Isso vale pra qualquer outro app que precise conectar direto num Postgres do Supabase a
  partir dessa VPS.
- Testado ponta a ponta via `https://socios.plataformafacil.com.br` com link real do Leandro.

Atualizar o código:

```bash
bash ~/.ssh/hermes_ssh_wrapper.sh "cd /opt/pergunta-por-socio && sudo git pull && sudo docker build -t pergunta-por-socio:latest . && sudo docker rm -f pergunta-por-socio && sudo docker run -d --name pergunta-por-socio --restart always --env-file /opt/pergunta-por-socio/.env -p 127.0.0.1:3200:3200 pergunta-por-socio:latest"
```

Gerar link de um sócio direto na VPS:

```bash
bash ~/.ssh/hermes_ssh_wrapper.sh "sudo docker exec pergunta-por-socio node src/generate-link.js \"Nome do sócio\""
```

## Segredos

Nada de valor real commitado. `.env` está no `.gitignore`. Chave da Groq salva localmente em
`Chaves_e_afins\groq_pergunta_por_socio.txt` (Máquina 1); chave OpenAI reaproveitada de
`Chaves_e_afins\openai_knowledge_base_secret.txt`.
