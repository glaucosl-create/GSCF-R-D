# Controle Financeiro Pessoal

Aplicacao local para controle de receitas, despesas, cartoes de credito, faturas em PDF e previsao mensal de parcelas.

## Como rodar

Use o Node embutido no Codex:

```powershell
& "C:\Users\limag\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --experimental-sqlite server.js
```

O app tambem usa o Python embutido no Codex para extrair texto das faturas em PDF.

Abra:

```text
http://localhost:3060
```

## Recursos

- Cadastro e login por email e senha.
- Confirmacao de cadastro por link de verificacao de email.
- Alteracao de senha pelo usuario logado.
- Lancamentos editaveis de receitas e despesas.
- Categorias livres, com sugestoes iniciais.
- Cadastro, edicao e exclusao de cartoes.
- Despesas parceladas no cartao geram previsao mensal futura.
- Upload de fatura em PDF com leitura local do texto e sugestao de lancamentos.
- OCR automatico para faturas em PDF que sao imagem/scan.
- Revisao dos itens detectados antes de importar.
- Deteccao de parcelas no formato `4/12`, `01/10` etc. e previsao das parcelas futuras.
- Dashboard com receitas, despesas, saldo, gastos por categoria e previsao das parcelas.
- Cadastro de telefone e canais de aviso para fechamento e vencimento de cartoes por WhatsApp ou SMS, com envio desligado ate configuracao do provedor.
- Area Admin para liberar, bloquear e definir validade de acesso de usuarios.
- Recebimento inicial de webhook de vendas do Mercado Livre para auditoria e futura automacao.

## Dados

O banco SQLite fica em `data/financeiro.sqlite`.
Os PDFs enviados ficam em `data/uploads`.

Em producao, configure `DATABASE_URL` para usar PostgreSQL. O app detecta essa variavel automaticamente e cria as tabelas no PostgreSQL.

## Observacao sobre faturas PDF

Cada banco/cartao tem um layout diferente. A leitura atual extrai linhas com data, descricao e valor em formato brasileiro. Os itens detectados podem ser editados antes e depois da importacao.

## Envio de email

Para envio real do link de verificacao, configure estas variaveis antes de iniciar o servidor:

```powershell
$env:APP_BASE_URL="http://localhost:3060"
$env:SMTP_HOST="smtp.seuprovedor.com"
$env:SMTP_PORT="587"
$env:SMTP_USER="usuario"
$env:SMTP_PASS="senha"
$env:SMTP_FROM="usuario@dominio.com"
```

Sem SMTP configurado, o app mostra o link de verificacao na tela para uso local.

Em hospedagens gratuitas que bloqueiam portas SMTP, como pode acontecer com portas 25, 465 e 587, use envio por API HTTPS:

```powershell
$env:RESEND_API_KEY="re_xxxxxxxxx"
$env:RESEND_FROM="CF-RD <onboarding@resend.dev>"
```

Quando `RESEND_API_KEY` estiver configurado, o app usa a API de email antes de tentar SMTP.

## Controle de acesso e vendas

Novas contas ficam com status `aguardando pagamento` depois da verificacao de email. Um administrador precisa liberar o acesso na tela **Admin** ou configurar a automacao de venda.

O usuario `glaucosl@gmail.com` e marcado como administrador quando existir no banco. Se nao existir nenhum administrador, o primeiro usuario cadastrado vira administrador.

Para receber notificacoes do Mercado Livre, configure um segredo e cadastre a URL publica do webhook no painel do Mercado Livre:

```powershell
$env:ML_WEBHOOK_SECRET="um-segredo-forte"
```

Endpoint do webhook:

```text
POST /api/webhooks/mercado-livre
Header: x-cf-webhook-secret: um-segredo-forte
```

Para ativar liberacao automatica apos pagamento, ainda e necessario configurar a aplicacao do Mercado Livre com `client_id`, `client_secret`, URL publica do servidor e validacao oficial do pedido/pagamento pela API da sua conta de vendedor.

## Publicacao

Os arquivos `Dockerfile`, `render.yaml`, `requirements.txt` e `DEPLOY.md` preparam o app para publicacao gratuita com Render + Neon PostgreSQL.

Para migrar os dados locais para PostgreSQL:

```powershell
$env:DATABASE_URL="postgresql://..."
pnpm migrate:postgres
```
