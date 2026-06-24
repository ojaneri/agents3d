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
    // normaliza e anexa status de atividade leve
    foreach ($list as &$a) {
        $a['emoji'] = $a['identityEmoji'] ?? $a['emoji'] ?? '🤖';
        $a['name']  = $a['name'] ?? $a['identityName'] ?? $a['id'];
        $file = latest_session($a['id'] ?? '');
        $a['lastActivity'] = $file ? date('c', filemtime($file)) : null;
        $a['busy'] = $file ? (time() - filemtime($file) < 20) : false;
    }
    unset($a);
    out($list);
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
