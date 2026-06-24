# Agents3D

Um **dashboard 3D vivo para seus agentes [OpenClaw](https://openclaw.ai)**. Cada agente é um
personagem 3D (Three.js) orbitando um núcleo; você vê o que cada um está fazendo, conversa
com eles, troca cor/emoji/personagem/modelo, e ouve/fala por voz — tudo no navegador.

![status](https://img.shields.io/badge/openclaw-dashboard-7c9bff)

## Recursos

- **Constelação 3D** dos agentes (Three.js) + **visão em cartões** (toggle).
- **Conversa unificada**: histórico real da sessão do agente como chat; mensagens de
  canais externos (telegram/cron/…) aparecem à esquerda com tag discreta `[canal]`.
- **Fila de mensagens** por agente; **respostas registradas** como balão.
- **Voz** (Web Speech API): ditado por microfone (STT) + leitura em voz alta (TTS) com voz selecionável.
- **Aba Design** por agente: cor, emoji (via `openclaw agents set-identity`), personagem 3D
  (robô/andróide/drone/orbe/tanque), **modelo de LLM** (edita o `openclaw.json` com backup) e voz.
- **Estados visuais**: ocupado (anel girando + plaquinha), ocioso, e **rate-limited dormindo** com contador.
- **Palco do agente** no painel: personagem grande + pet (peixe-robô/cão-android) com ações e zoom.
- **Badge de não lidas** no nó 3D, no dock e nos cartões.
- **Login pelo app** (overlay + cookie de sessão) — sem Basic Auth do servidor.

## Como funciona

```
Navegador (index.html + assets/, Three.js)
        │  HTTPS
   Apache/Nginx  ──── estático (shell) ────► public
        │  proxy /api/*
   Bridge PHP (api/router.php, php -S 127.0.0.1:3007)
        │  CLI + arquivos
   OpenClaw  (~/.openclaw: agents/<id>/sessions, openclaw.json)
```

O bridge fala com o OpenClaw **chamando o CLI** (`openclaw agents list`, `openclaw agent --message`,
`openclaw agents set-identity`), **lendo as sessões** (`~/.openclaw/agents/<id>/sessions/*.jsonl`
e `*.trajectory.jsonl`) e **editando o `openclaw.json`** (modelo/fallbacks, com backup).

## Requisitos

- [OpenClaw](https://openclaw.ai) instalado e configurado (CLI no PATH).
- PHP 8.0+ (`php-cli`).
- Um servidor web com proxy reverso (Apache ou Nginx) — ou só o `php -S` atrás de TLS.
- O bridge deve rodar **como o usuário dono do `~/.openclaw`** (acessa sessões e edita config).

## Instalação

```bash
git clone https://github.com/ojaneri/agents3d.git /var/www/agents3d
cd /var/www/agents3d
cp .env.example .env && $EDITOR .env        # defina AUTH_* e os caminhos do OpenClaw
```

1. **Bridge** (systemd): edite `install/agents3d-api.service` (WorkingDirectory/User) e:
   ```bash
   sudo cp install/agents3d-api.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now agents3d-api
   curl -s http://127.0.0.1:3007/api/health   # {"ok":true,...}
   ```
2. **Web** (Apache): use `install/apache-vhost.conf.example` (ajuste ServerName/DocumentRoot/cert),
   habilite e recarregue.
3. Acesse o domínio, faça login com `AUTH_EMAIL`/`AUTH_PASS`.

## Configuração (`.env`)

| Chave | Default | Descrição |
|------|---------|-----------|
| `AUTH_EMAIL` / `AUTH_PASS` | — | credenciais do login do app (vazio = sem login) |
| `AUTH_SECRET` | `agentes2025` | sal do token de sessão |
| `OPENCLAW_BIN` | `/usr/local/bin/openclaw` | binário do OpenClaw |
| `OPENCLAW_HOME` | `$HOME` ou `/root` | home com o `~/.openclaw` |
| `AGENTS_DIR` | `$OPENCLAW_HOME/.openclaw/agents` | dir das sessões |
| `OPENCLAW_CONFIG` | `$OPENCLAW_HOME/.openclaw/openclaw.json` | config do OpenClaw |
| `CACHE_DIR` | `/run/agents3d` | cache efêmero |

Os **modelos disponíveis** na aba Design ficam na allowlist `MODELS` no topo de `api/router.php` —
ajuste para os modelos do seu OpenClaw.

## Segurança

- O bridge executa o agente com os privilégios do usuário que o roda (frequentemente root) e
  edita o `openclaw.json` — **sempre rode atrás de HTTPS e com o login do app habilitado**.
- `router.php` é negado como estático no vhost; `.env` e `api/design.json` ficam fora do git.

## Licença

MIT — veja [LICENSE](LICENSE).

---

Não-oficial; não afiliado ao OpenClaw. Feito para quem roda agentes OpenClaw e quer vê-los vivos. 🛰️
