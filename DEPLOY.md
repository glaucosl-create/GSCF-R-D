# Publicacao gratuita com PostgreSQL

Este projeto esta preparado para rodar localmente com SQLite e em producao com PostgreSQL quando a variavel `DATABASE_URL` estiver configurada.

## Opcao recomendada

- App web: Render Free Web Service com Docker.
- Banco: Neon PostgreSQL Free.

Essa combinacao evita depender de SQLite em producao e mantem suporte a leitura de faturas em PDF, porque o Dockerfile instala Python e Poppler.

## 1. Criar o banco PostgreSQL

1. Crie uma conta em `https://neon.tech`.
2. Crie um projeto PostgreSQL.
3. Clique em **Connect** no painel do projeto.
4. Copie a connection string no formato:

```text
postgresql://usuario:senha@host-pooler/registros?sslmode=require&channel_binding=require
```

Essa string sera usada como `DATABASE_URL`.

## 2. Publicar o app

1. Suba esta pasta para um repositorio GitHub privado.
2. Crie uma conta em `https://render.com`.
3. No Render, clique em **New > Web Service**.
4. Conecte o repositorio GitHub.
5. Escolha Docker como runtime. O Render usara o `Dockerfile`.
6. Defina as variaveis:

```text
DATABASE_URL=postgresql://...
APP_BASE_URL=https://seu-app.onrender.com
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=usuario
SMTP_PASS=senha
SMTP_FROM=usuario@dominio.com
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM=CF-RD <onboarding@resend.dev>
```

As variaveis SMTP podem ficar vazias enquanto voce estiver apenas testando o deploy, mas o cadastro por email real so envia link quando SMTP estiver configurado.

Se o plano gratuito bloquear SMTP, use `RESEND_API_KEY` e `RESEND_FROM` para envio por API HTTPS.

## 3. Migrar os dados locais

Depois que o banco Neon existir, rode localmente:

```powershell
$env:DATABASE_URL="postgresql://..."
pnpm migrate:postgres
```

O script copia os dados de `data/financeiro.sqlite` para o PostgreSQL.

## 4. Teste apos publicar

1. Abra a URL publica do Render.
2. Crie uma conta.
3. Confirme o email.
4. Entre como administrador e libere o usuario.
5. Cadastre categorias, receitas, despesas e cartoes.
6. Envie uma fatura PDF de teste.

## Observacoes importantes

- Servidores gratuitos podem hibernar quando ficam sem acesso por algum tempo.
- Uploads salvos no disco do servidor gratuito podem ser temporarios. O banco PostgreSQL guarda os dados principais, mas os PDFs enviados devem futuramente ir para storage externo se o app virar producao real.
- Para venda comercial, usar plano pago melhora estabilidade, backup e tempo de resposta.
