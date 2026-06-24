<?php
/**
 * Agentes — bridge HTTP entre a página 3D e o OpenClaw.
 *
 * Roda como root via `php -S 127.0.0.1:3007 router.php` (systemd: agentes-api).
 * O Apache serve a página estática do diretório e faz proxy de /api/* para cá.
 *
 * Endpoints:
 *   GET  /api/agents              -> lista de agentes (id, nome, emoji, modelo, status)
 *   GET  /api/activity?agent=ID   -> últimas mensagens da sessão mais recente do agente
 *   POST /api/chat {agent,message}-> envia mensagem ao agente e devolve a resposta
 *   GET  /api/health              -> ping
 */

declare(strict_types=1);

const OPENCLAW_BIN = '/usr/local/bin/openclaw';
const OPENCLAW_HOME = '/root';
const AGENTS_DIR = '/root/.openclaw/agents';
const CACHE_DIR = '/run/agentes-api';
const DESIGN_FILE = __DIR__ . '/design.json';        // overrides cosméticos (cor/personagem/voz)
const OPENCLAW_CONFIG = '/root/.openclaw/openclaw.json';

// Modelos permitidos (allowlist) + runtime correspondente. Trocar modelo edita o openclaw.json.
const MODELS = [
    'openai/gpt-5.5'              => 'codex',
    'openai/gpt-5.4'             => 'codex',
    'openai/gpt-5.4-mini'        => 'codex',
    'anthropic/claude-opus-4-8'  => 'claude-cli',
    'anthropic/claude-opus-4-7'  => 'claude-cli',
    'anthropic/claude-opus-4-6'  => 'claude-cli',
    'anthropic/claude-sonnet-4-6'=> 'claude-cli',
];

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// PHP built-in server: deixa que arquivos estáticos existentes sejam servidos direto.
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

function out($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Executa o CLI openclaw com env de root. */
function openclaw(array $args, int $timeout = 600): array {
    $cmd = escapeshellarg(OPENCLAW_BIN);
    foreach ($args as $a) {
        $cmd .= ' ' . escapeshellarg((string)$a);
    }
    $env = [
        'HOME' => OPENCLAW_HOME,
        'PATH' => '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NO_COLOR' => '1',
        'OPENCLAW_HOME' => OPENCLAW_HOME,
    ];
    $desc = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = proc_open('timeout ' . (int)$timeout . ' ' . $cmd, $desc, $pipes, null, $env);
    if (!is_resource($proc)) {
        return ['code' => 127, 'stdout' => '', 'stderr' => 'proc_open falhou'];
    }
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    foreach ($pipes as $p) { if (is_resource($p)) fclose($p); }
    $code = proc_close($proc);
    return ['code' => $code, 'stdout' => $stdout, 'stderr' => $stderr];
}

/** openclaw imprime warnings antes do JSON; extrai o primeiro bloco JSON válido. */
function extract_json(string $s) {
    $s = trim($s);
    foreach (['{', '['] as $open) {
        $start = strpos($s, $open);
        if ($start === false) continue;
        $candidate = substr($s, $start);
        $decoded = json_decode($candidate, true);
        if ($decoded !== null) return $decoded;
    }
    // fallback: tenta linha a linha
    foreach (explode("\n", $s) as $line) {
        $line = trim($line);
        if ($line === '' || ($line[0] !== '{' && $line[0] !== '[')) continue;
        $d = json_decode($line, true);
        if ($d !== null) return $d;
    }
    return null;
}

function agents_list(): array {
    $cacheFile = CACHE_DIR . '/agents.json';
    if (is_file($cacheFile) && (time() - filemtime($cacheFile) < 30)) {
        $cached = json_decode((string)file_get_contents($cacheFile), true);
        if (is_array($cached)) return $cached;
    }
    $r = openclaw(['agents', 'list', '--json'], 30);
    $list = extract_json($r['stdout']);
    if (!is_array($list)) $list = [];
    @mkdir(CACHE_DIR, 0700, true);
    // escrita atômica: evita leitura de arquivo meio-escrito sob concorrência (6 workers)
    $tmp = $cacheFile . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode($list)) !== false) {
        @rename($tmp, $cacheFile);
    }
    return $list;
}

/** Caminho da sessão mais recente (.jsonl, ignorando trajetória) de um agente. */
function latest_session(string $agentId): ?string {
    $dir = AGENTS_DIR . '/' . basename($agentId) . '/sessions';
    if (!is_dir($dir)) return null;
    $best = null; $bestT = 0;
    foreach (glob($dir . '/*.jsonl') ?: [] as $f) {
        if (strpos($f, 'trajectory') !== false) continue;
        $t = filemtime($f);
        if ($t > $bestT) { $bestT = $t; $best = $f; }
    }
    return $best;
}

/** Trajetória (.trajectory.jsonl) mais recente de um agente. */
function latest_trajectory(string $agentId): ?string {
    $dir = AGENTS_DIR . '/' . basename($agentId) . '/sessions';
    if (!is_dir($dir)) return null;
    $best = null; $bestT = 0;
    foreach (glob($dir . '/*trajectory*.jsonl') ?: [] as $f) {
        $t = filemtime($f);
        if ($t > $bestT) { $bestT = $t; $best = $f; }
    }
    return $best;
}

// O OpenClaw não expõe o horário de liberação do cooldown; usamos uma janela estimada
// a partir do último evento de rate_limit na trajetória.
const RATE_COOLDOWN = 90; // segundos

/** Estado de rate-limit do agente, derivado do último model.fallback_step rate_limit. */
function rate_state(string $agentId): array {
    $f = latest_trajectory($agentId);
    if ($f === null) return ['rateLimited' => false];
    if (time() - filemtime($f) > RATE_COOLDOWN + 60) return ['rateLimited' => false]; // antigo demais
    $size = filesize($f);
    $fh = fopen($f, 'rb');
    if ($size > 131072) fseek($fh, -131072, SEEK_END);
    $buf = stream_get_contents($fh);
    fclose($fh);
    $lastTs = null;
    foreach (explode("\n", $buf) as $line) {
        if (strpos($line, 'rate_limit') === false) continue;
        $row = json_decode($line, true);
        if (!is_array($row)) continue;
        if (($row['data']['fallbackStepFromFailureReason'] ?? '') === 'rate_limit' && !empty($row['ts'])) {
            $t = strtotime($row['ts']);
            if ($t && (!$lastTs || $t > $lastTs)) $lastTs = $t;
        }
    }
    if ($lastTs === null) return ['rateLimited' => false];
    $until = $lastTs + RATE_COOLDOWN;
    if (time() >= $until) return ['rateLimited' => false];
    return ['rateLimited' => true, 'until' => $until];
}

/** Texto legível a partir de content (string ou array de blocos). */
function content_text($content): string {
    if (is_string($content)) return $content;
    if (is_array($content)) {
        $parts = [];
        foreach ($content as $blk) {
            if (is_array($blk)) {
                if (($blk['type'] ?? '') === 'text' && isset($blk['text'])) {
                    $parts[] = $blk['text'];
                } elseif (($blk['type'] ?? '') === 'tool_use') {
                    $parts[] = '🛠️ ' . ($blk['name'] ?? 'ferramenta');
                } elseif (($blk['type'] ?? '') === 'tool_result') {
                    $parts[] = '↩️ resultado de ferramenta';
                }
            }
        }
        return trim(implode("\n", $parts));
    }
    return '';
}

function activity(string $agentId): array {
    $file = latest_session($agentId);
    if ($file === null) {
        return ['agent' => $agentId, 'messages' => [], 'lastActivity' => null, 'busy' => false];
    }
    // lê só o final do arquivo (até 64KB) para performance
    $size = filesize($file);
    $fh = fopen($file, 'rb');
    if ($size > 65536) fseek($fh, -65536, SEEK_END);
    $buf = stream_get_contents($fh);
    fclose($fh);
    $lines = array_filter(explode("\n", $buf), fn($l) => trim($l) !== '');
    $msgs = [];
    foreach ($lines as $line) {
        $row = json_decode($line, true);
        if (!is_array($row) || ($row['type'] ?? '') !== 'message') continue;
        $m = $row['message'] ?? null;
        if (!is_array($m)) continue;
        $text = content_text($m['content'] ?? '');
        if ($text === '') continue;
        $msgs[] = [
            'role' => $m['role'] ?? 'assistant',
            'text' => mb_substr($text, 0, 2000),
            'ts'   => $row['timestamp'] ?? null,
            'model'=> $m['model'] ?? null,
        ];
    }
    $msgs = array_slice($msgs, -12);
    $lastT = filemtime($file);
    return [
        'agent' => $agentId,
        'messages' => array_values($msgs),
        'lastActivity' => date('c', $lastT),
        'busy' => (time() - $lastT) < 20, // ativo se mexeu nos últimos 20s
    ];
}

// -------- design overrides (cosmético: cor / personagem / voz) --------
function load_design(): array {
    if (!is_file(DESIGN_FILE)) return [];
    $d = json_decode((string)file_get_contents(DESIGN_FILE), true);
    return is_array($d) ? $d : [];
}
function save_design(array $d): bool {
    $tmp = DESIGN_FILE . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false) {
        return false;
    }
    return @rename($tmp, DESIGN_FILE);
}

/** Conta respostas (role=assistant, com texto) na sessão mais recente — base do badge de não lidas. */
function assistant_msg_count(string $agentId): int {
    $file = latest_session($agentId);
    if ($file === null) return 0;
    $size = filesize($file);
    $fh = fopen($file, 'rb');
    if ($size > 131072) fseek($fh, -131072, SEEK_END);
    $buf = stream_get_contents($fh);
    fclose($fh);
    $n = 0;
    foreach (explode("\n", $buf) as $line) {
        $line = trim($line);
        if ($line === '') continue;
        $row = json_decode($line, true);
        if (!is_array($row) || ($row['type'] ?? '') !== 'message') continue;
        $m = $row['message'] ?? null;
        if (!is_array($m) || ($m['role'] ?? '') !== 'assistant') continue;
        if (content_text($m['content'] ?? '') === '') continue;
        $n++;
    }
    return $n;
}

function model_label(string $id): string {
    $map = [
        'openai/gpt-5.5'               => 'GPT-5.5',
        'openai/gpt-5.4'              => 'GPT-5.4',
        'openai/gpt-5.4-mini'        => 'GPT-5.4 mini',
        'anthropic/claude-opus-4-8'  => 'Claude Opus 4.8',
        'anthropic/claude-opus-4-7'  => 'Claude Opus 4.7',
        'anthropic/claude-opus-4-6'  => 'Claude Opus 4.6',
        'anthropic/claude-sonnet-4-6'=> 'Claude Sonnet 4.6',
    ];
    return $map[$id] ?? $id;
}

/** Altera o modelo de um agente no openclaw.json (backup + escrita atômica, sem restart).
 *  IMPORTANTE: decodifica em modo OBJETO (não array) para preservar objetos vazios {}.
 *  Em modo array, json_encode converteria {} em [] e invalidaria o schema do OpenClaw. */
function set_agent_model(string $agent, string $model): array {
    if (!isset(MODELS[$model])) return ['ok' => false, 'error' => 'modelo não permitido'];
    $raw = @file_get_contents(OPENCLAW_CONFIG);
    if ($raw === false) return ['ok' => false, 'error' => 'config ilegível'];
    $cfg = json_decode($raw);   // objetos (stdClass) — preserva {}
    if (!($cfg instanceof stdClass) || !isset($cfg->agents->list) || !is_array($cfg->agents->list)) {
        return ['ok' => false, 'error' => 'estrutura inesperada no openclaw.json'];
    }
    $found = false;
    foreach ($cfg->agents->list as $ag) {
        if (($ag->id ?? '') === $agent) {
            $ag->model = $model;
            if (!isset($ag->models) || !($ag->models instanceof stdClass)) $ag->models = new stdClass();
            if (!isset($ag->models->{$model}) || !($ag->models->{$model} instanceof stdClass)) $ag->models->{$model} = new stdClass();
            if (!isset($ag->models->{$model}->agentRuntime) || !($ag->models->{$model}->agentRuntime instanceof stdClass)) $ag->models->{$model}->agentRuntime = new stdClass();
            $ag->models->{$model}->agentRuntime->id = MODELS[$model];
            $found = true;
            break;
        }
    }
    if (!$found) return ['ok' => false, 'error' => 'agente não encontrado na config'];

    @copy(OPENCLAW_CONFIG, OPENCLAW_CONFIG . '.bak-design-' . date('Ymd-His'));
    // poda: mantém só os 5 backups mais recentes
    $baks = glob(OPENCLAW_CONFIG . '.bak-design-*') ?: [];
    if (count($baks) > 5) { sort($baks); foreach (array_slice($baks, 0, -5) as $f) @unlink($f); }
    $json = json_encode($cfg, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) return ['ok' => false, 'error' => 'falha ao serializar config'];
    $tmp = OPENCLAW_CONFIG . '.tmp';
    if (@file_put_contents($tmp, $json) === false || !@rename($tmp, OPENCLAW_CONFIG)) {
        return ['ok' => false, 'error' => 'falha ao gravar config'];
    }
    return ['ok' => true];
}

// -------- auth --------
function load_env(string $path): array {
    $env = [];
    if (!is_file($path)) return $env;
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = ltrim($line);
        if ($line === '' || $line[0] === '#') continue;
        [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
        $env[trim($k)] = trim($v);
    }
    return $env;
}
$env = load_env(__DIR__ . '/../.env');
$authEnabled = !empty($env['AUTH_EMAIL']) && !empty($env['AUTH_PASS']);

function _tok(array $e): string {
    return hash('sha256', ($e['AUTH_EMAIL'] ?? '') . '|' . ($e['AUTH_PASS'] ?? '') . '|' . ($e['AUTH_SECRET'] ?? 'agentes2025'));
}
function auth_ok(array $e): bool {
    $want = _tok($e);
    $got  = $_COOKIE['agentes_sess'] ?? ($_SERVER['HTTP_X_AGENTES_TOKEN'] ?? '');
    return $got !== '' && hash_equals($want, (string)$got);
}

if ($uri === '/api/login' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    if (!$authEnabled) out(['ok' => true]);
    $b = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    if (trim($b['email'] ?? '') === $env['AUTH_EMAIL'] && trim($b['pass'] ?? '') === $env['AUTH_PASS']) {
        setcookie('agentes_sess', _tok($env), ['expires' => time() + 86400 * 30, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
        out(['ok' => true]);
    }
    out(['ok' => false, 'error' => 'Credenciais inválidas.'], 401);
}
if ($uri === '/api/logout') {
    setcookie('agentes_sess', '', ['expires' => time() - 3600, 'path' => '/']);
    out(['ok' => true]);
}
if ($authEnabled && str_starts_with($uri, '/api/') && !in_array($uri, ['/api/health', '/api/login', '/api/logout'], true)) {
    if (!auth_ok($env)) out(['error' => 'Não autenticado.', 'auth_required' => true], 401);
}

// -------- roteamento --------
if ($uri === '/api/health' || $uri === '/health') {
    out(['ok' => true, 'time' => date('c')]);
}

if ($uri === '/api/agents') {
    $list = agents_list();
    $design = load_design();
    // normaliza e anexa status de atividade leve + overrides de design
    foreach ($list as &$a) {
        $id = $a['id'] ?? '';
        $a['emoji'] = $a['identityEmoji'] ?? $a['emoji'] ?? '🤖';
        $a['name']  = $a['name'] ?? $a['identityName'] ?? $id;
        $file = latest_session($id);
        $a['lastActivity'] = $file ? date('c', filemtime($file)) : null;
        $a['busy'] = $file ? (time() - filemtime($file) < 20) : false;
        $a['msgCount'] = assistant_msg_count($id);
        $rs = rate_state($id);
        $a['rateLimited'] = $rs['rateLimited'];
        // segundos restantes (o cliente ancora no próprio relógio — evita skew servidor/navegador)
        if (!empty($rs['until'])) $a['rateRemaining'] = max(0, $rs['until'] - time());
        $ov = $design[$id] ?? null;
        if (is_array($ov)) {
            if (!empty($ov['color']))            $a['color'] = $ov['color'];
            if (isset($ov['character']))         $a['character'] = $ov['character'];
            if (isset($ov['voice']))             $a['voice'] = $ov['voice'];
        }
    }
    unset($a);
    out($list);
}

if ($uri === '/api/models') {
    $models = [];
    foreach (MODELS as $id => $rt) {
        $models[] = ['id' => $id, 'runtime' => $rt, 'label' => model_label($id)];
    }
    out(['models' => $models]);
}

if ($uri === '/api/design') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') out(['error' => 'use POST'], 405);
    $b = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    $agent = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($b['agent'] ?? ''));
    if ($agent === '') out(['error' => 'agent obrigatório'], 400);
    // valida o agente. Se o CLI do OpenClaw estiver fora (lista vazia), ainda
    // permitimos salvar overrides cosméticos (cor/personagem/voz) — só emoji/modelo
    // dependem do CLI/config.
    $ids = array_map(fn($a) => $a['id'] ?? '', agents_list());
    $cliUp = count($ids) > 0;
    $needsCli = !empty($b['emoji']) || !empty($b['model']);
    if ($cliUp) {
        if (!in_array($agent, $ids, true)) out(['error' => 'agente desconhecido'], 404);
    } elseif ($needsCli) {
        out(['error' => 'OpenClaw indisponível agora para alterar emoji/modelo'], 503);
    }

    $design = load_design();
    $entry  = is_array($design[$agent] ?? null) ? $design[$agent] : [];
    $applied = [];
    $errors  = [];
    $restartNeeded = false;

    // cor (#rgb / #rrggbb)
    if (array_key_exists('color', $b)) {
        $c = strtolower(trim((string)$b['color']));
        if (preg_match('/^#([0-9a-f]{3}|[0-9a-f]{6})$/', $c)) { $entry['color'] = $c; $applied[] = 'color'; }
        else $errors[] = 'cor inválida';
    }
    // personagem
    if (array_key_exists('character', $b)) {
        $ch = preg_replace('/[^a-z0-9_\-]/', '', strtolower((string)$b['character']));
        if ($ch !== '') { $entry['character'] = $ch; $applied[] = 'character'; }
    }
    // voz (nome da voz do navegador)
    if (array_key_exists('voice', $b)) {
        $entry['voice'] = mb_substr((string)$b['voice'], 0, 120);
        $applied[] = 'voice';
    }
    $design[$agent] = $entry;
    if (!save_design($design)) $errors[] = 'falha ao salvar design';

    // emoji → via CLI set-identity (persiste na identidade real do OpenClaw)
    if (!empty($b['emoji'])) {
        $emoji = mb_substr(trim((string)$b['emoji']), 0, 8);
        $r = openclaw(['agents', 'set-identity', '--agent', $agent, '--emoji', $emoji, '--json'], 30);
        if ($r['code'] === 0) { $applied[] = 'emoji'; @unlink(CACHE_DIR . '/agents.json'); }
        else $errors[] = 'falha ao definir emoji';
    }

    // modelo → edita openclaw.json (com backup, sem restart)
    if (!empty($b['model'])) {
        $res = set_agent_model($agent, (string)$b['model']);
        if ($res['ok']) { $applied[] = 'model'; $restartNeeded = true; @unlink(CACHE_DIR . '/agents.json'); }
        else $errors[] = $res['error'] ?? 'falha ao definir modelo';
    }

    out([
        'ok'            => empty($errors),
        'applied'       => $applied,
        'errors'        => $errors,
        'restartNeeded' => $restartNeeded,
    ], empty($errors) ? 200 : 207);
}

if ($uri === '/api/activity') {
    $agent = preg_replace('/[^a-zA-Z0-9_\-]/', '', $_GET['agent'] ?? '');
    if ($agent === '') out(['error' => 'agent obrigatório'], 400);
    out(activity($agent));
}

if ($uri === '/api/chat') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') out(['error' => 'use POST'], 405);
    $body = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    $agent = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($body['agent'] ?? ''));
    $message = trim((string)($body['message'] ?? ''));
    if ($agent === '' || $message === '') out(['error' => 'agent e message obrigatórios'], 400);

    $r = openclaw(['agent', '--agent', $agent, '--message', $message, '--json'], 600);
    $json = extract_json($r['stdout']);
    $reply = '';
    $status = null;
    if (is_array($json)) {
        $status = $json['status'] ?? null;
        // shape do openclaw agent --json
        $reply = $json['result']['meta']['finalAssistantVisibleText'] ?? '';
        if ($reply === '' && !empty($json['result']['payloads'][0]['text'])) {
            $reply = $json['result']['payloads'][0]['text'];
        }
        // fallbacks genéricos
        if ($reply === '') {
            foreach (['reply', 'text', 'message', 'output', 'response'] as $k) {
                if (!empty($json[$k]) && is_string($json[$k])) { $reply = $json[$k]; break; }
            }
        }
        if ($reply === '' && isset($json['result'])) {
            $reply = is_string($json['result']) ? $json['result'] : content_text($json['result']);
        }
    }
    $err = null;
    if ($reply === '') {
        // erro do CLI não vem em JSON (ex.: provider em cooldown)
        $err = trim($r['stderr']) !== '' ? trim($r['stderr']) : trim($r['stdout']);
        // remove linhas de warning de migração
        $err = preg_replace('/^\[state-migrations\].*$/mi', '', (string)$err);
        $err = preg_replace('/^- Left plugin install.*$/mi', '', (string)$err);
        $err = trim($err);
    }
    out([
        'agent' => $agent,
        'reply' => $reply,
        'status' => $status,
        'error' => $err ?: null,
        'code' => $r['code'],
    ]);
}

out(['error' => 'rota não encontrada', 'uri' => $uri], 404);
