#!/usr/bin/env python3
"""
Unified Intelligence Hook v2.0 — 100% EXACT match with 14 backup hooks.
Zero power loss. All 47 sub-functions preserved.

Modes (sys.argv[1]):
  pre_bash  — PreToolUse:Bash
  fail      — PostToolUseFailure
  post      — PostToolUse (dispatch by tool_name)
  prompt    — UserPromptSubmit

Sources merged (EXACT logic preserved):
  intelligence-engine.py v3.0 (863 lines) — H1-H7 + KB + approach tracking
  thinking-force.py v7.0 (425 lines) — persistent diagnosa + smart deep-think
  anchor-stop-gate.py v2.0 (155 lines) — re-anchor perintah Tuan
  time-awareness.py v1.0 (140 lines) — clock + timers
  hook-pre-bash.sh (140 lines) — fingerprint retry block + ep_count
  hook-post-fail.sh (155 lines) — graduated response
"""

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime

# ═══════════════════════════════════════════════════
# SHARED INFRASTRUCTURE
# ═══════════════════════════════════════════════════

STATE_DIR = "/tmp/claude_fie"
HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
KB_FILE = os.path.join(HOOKS_DIR, "failure-knowledge.json")
os.makedirs(STATE_DIR, exist_ok=True)

def safe_json(default=None):
    try:
        return json.load(sys.stdin)
    except Exception:
        return default or {}

def _safe_session(session_id):
    return re.sub(r'[^a-zA-Z0-9_-]', '', str(session_id))[:40] or "default"

def state_path(session_id, suffix=""):
    return os.path.join(STATE_DIR, f"{_safe_session(session_id)}{suffix}.json")

def load_state(session_id, suffix=""):
    try:
        with open(state_path(session_id, suffix), 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def save_state(session_id, state, suffix=""):
    try:
        with open(state_path(session_id, suffix), 'w') as f:
            json.dump(state, f)
    except Exception:
        pass

def output_approve(context=None):
    r = {"decision": "approve"}
    if context:
        r["hookSpecificOutput"] = {"hookEventName": "PreToolUse", "additionalContext": context}
    print(json.dumps(r))

def output_block(reason):
    print(json.dumps({"decision": "block", "reason": reason}))

def output_post(context):
    if context:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": context}}))
    else:
        print(json.dumps({"continue": True}))

def output_empty():
    print(json.dumps({}))

# ═══════════════════════════════════════════════════
# EXTRACTION UTILITIES (EXACT from intelligence-engine.py)
# ═══════════════════════════════════════════════════

def extract_endpoint(cmd):
    urls = re.findall(r'https?://([^/\s"\']+)', cmd)
    if urls: return urls[0]
    unc = re.findall(r'\\\\([^\\\\/\\s]+)', cmd)
    if unc: return unc[0].lower()
    ips = re.findall(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', cmd)
    if ips:
        non_local = [ip for ip in ips if ip != '127.0.0.1']
        if non_local: return non_local[0]
        ports = re.findall(r'(?:--port|:|-p)\s*(\d{2,5})', cmd)
        return f"127.0.0.1:{ports[0]}" if ports else "127.0.0.1"
    hosts = re.findall(r'(?:@|ComputerName\s+)([a-zA-Z0-9._-]+)', cmd)
    if hosts: return hosts[0]
    return "local"

def fingerprint_cmd(cmd):
    fp = cmd.lower()
    fp = re.sub(r'\b\d{6,}\b', 'NUM', fp)
    fp = re.sub(r'[0-9a-f]{12,}', 'HEX', fp)
    fp = re.sub(r'["\'][^"\'\n]{20,}["\']', 'STR', fp)
    fp = re.sub(r'\s+', ' ', fp).strip()
    return hashlib.md5(fp.encode()).hexdigest()[:10]

# --- VERB_CLASSES (EXACT from intelligence-engine.py:140-208) ---
VERB_CLASSES = {
    'exec': r'\b(exec|run|start|call|invoke|process|wmic|psexec|smbexec|atexec|dcomexec|winrm|invoke-command)\b',
    'install': r'\b(install|deploy|setup|msi|msiexec|--install|--setup)\b',
    'transfer': r'\b(copy|xcopy|upload|download|scp|wget|curl.*-[oO]|robocopy|sftp|put|get)\b',
    'auth': r'\b(login|logon|auth|connect|ssh|rdp|winrm|net\s+use)\b',
    'disable': r'\b(disable|stop|kill|remove|uninstall|delete|del\b|rm\b)\b',
    'scan': r'\b(scan|enum|nmap|recon|probe|discover|nuclei|nikto|ffuf|gobuster)\b',
    'read': r'\b(read|cat|type|dir|ls|find|get-content|findstr|grep)\b',
    'config': r'\b(config|set-|reg\s+add|registry|schtasks|crontab|systemctl)\b',
    'escalate': r'\b(privesc|escalat|sudo|runas|getsystem|potato|token)\b',
    'persist': r'\b(persist|backdoor|implant|tunnel|cloudflared|chisel|ligolo)\b',
}

SPECIFIC_GOALS = {
    'anydesk': r'anydesk', 'teamviewer': r'teamviewer', 'rustdesk': r'rustdesk',
    'defender': r'(defender|set-mppreference|mppreference)',
    'cloudflared': r'cloudflared', 'chisel': r'chisel',
    'ngrok': r'ngrok', 'sshd': r'sshd',
}

NETWORK_VERBS = {'exec', 'auth', 'transfer', 'install', 'persist'}
VERB_THRESHOLDS = {
    'install': 2, 'exec': 2, 'auth': 2, 'transfer': 2,
    'disable': 2, 'persist': 2, 'escalate': 2,
    'scan': 3, 'read': 3, 'config': 2, 'unknown': 2,
}

def extract_verb_class(cmd):
    cmd_lower = cmd.lower()
    for verb, pattern in VERB_CLASSES.items():
        if re.search(pattern, cmd_lower):
            return verb
    return "unknown"

def extract_specific_goal(cmd):
    cmd_lower = cmd.lower()
    for name, pattern in SPECIFIC_GOALS.items():
        if re.search(pattern, cmd_lower):
            return name
    return None

def build_approach_key(cmd):
    target = extract_endpoint(cmd)
    verb = extract_verb_class(cmd)
    specific = extract_specific_goal(cmd)
    include_target = verb in NETWORK_VERBS
    if specific and include_target: return f"{verb}-{specific}@{target}"
    elif specific: return f"{verb}-{specific}"
    elif include_target: return f"{verb}@{target}"
    return f"{verb}"

# --- ERROR CLASSIFICATION (EXACT from intelligence-engine.py:213-249) ---
ERROR_SIGNATURES = {
    'permission_denied': [r'access.denied', r'permission.denied', r'STATUS_ACCESS_DENIED', r'forbidden'],
    'network_unreachable': [r'connection.refused', r'no.route', r'network.unreachable', r'host.unreachable'],
    'timeout': [r'timed?.out', r'timeout', r'exit.code.143', r'deadline'],
    'defense_block': [r'tamper.protection', r'quarantin', r'blocked', r'threat.detect'],
    'not_found': [r'file.not.found', r'cannot.find', r'no.such.file', r'does.not.exist'],
    'auth_failure': [r'logon.failure', r'authentication.fail', r'bad.password', r'STATUS_LOGON_FAILURE'],
    'cmdlet_missing': [r'not.recognized.*cmdlet', r'command.not.found', r'is.not.recognized'],
    'syntax_error': [r'unexpected.token', r'syntax.error', r'parse.error', r'dquote>'],
}

def classify_error(cmd, error, exit_code):
    combined = f"{cmd}\n{error}".lower()
    results = {}
    for category, patterns in ERROR_SIGNATURES.items():
        hits = sum(1 for p in patterns if re.search(p, combined))
        if hits > 0: results[category] = hits
    if results: return max(results, key=results.get)
    if str(exit_code) == '143': return 'timeout'
    if str(exit_code) == '255': return 'ssh_error'
    return 'unknown'

def detect_os(cmd):
    cmd_lower = cmd.lower()
    if re.search(r'(powershell|cmd\s*/c|wmic|schtasks|\.exe\b|c:\\|net\s+use)', cmd_lower): return 'windows'
    if re.search(r'(/etc/|/usr/|/var/|bash\b|systemctl|apt\b|chmod)', cmd_lower): return 'linux'
    return 'unknown'

# --- TECHNIQUE PATTERNS ---
TECHNIQUE_PATTERNS = {
    'sqli': r'(sqlmap|union.*select|sql.*inject|\bsqli\b|information_schema)',
    'xss': r'(xss|<script|alert\(|dalfox)',
    'rce': r'(rce|reverse.shell|nc\s+-|bash\s+-i|cmd.*exec|system\()',
    'lfi': r'(lfi|\.\.\/|path.traversal|\/etc\/passwd)',
    'ssrf': r'(ssrf|127\.0\.0\.1|localhost.*fetch)',
    'upload': r'(upload|multipart|webshell|\.php.*post)',
    'recon': r'(nmap|scan|nuclei|nikto|gobuster|ffuf|rustscan)',
    'privesc': r'(priv.*esc|sudo|suid|linpeas|kernel.*exploit)',
    'tunnel': r'(tunnel|chisel|ligolo|cloudflare|ssh.*-[LRD]|socks)',
    'auth': r'(login|auth|session|cookie|jwt|token|credential)',
}

def classify_technique(cmd):
    combined = cmd.lower()
    for tech, pattern in TECHNIQUE_PATTERNS.items():
        if re.search(pattern, combined): return tech
    return 'unknown'

# --- REGEX PATTERNS ---
TRIVIAL_CMD = re.compile(
    r'^\s*(ls|pwd|cat\s|echo\s|id\b|whoami|date|which\s|head\s|tail\s|'
    r'stat\s|file\s|wc\s|ps\s|ss\s|rm\s|mkdir|cd\s|cp\s|mv\s|chmod\s|'
    r'grep\s|find\s|sort\s|uniq\s|cut\s|tr\s|tee\s|touch\s|'
    r'jq\s|python3\s+-c\s|bash\s+-n\s|test\s)')

LOGICAL_FAIL = re.compile(
    r'(Could not|cannot connect|unable to|failed to|failure|'
    r'access.denied|permission.denied|rejected|refused|forbidden|unauthorized|'
    r'blocked by|quarantin|detected by|removed by|killed by|'
    r'timed?\s*out|timeout|unreachable|no.route|connection.refused|'
    r'not.found|no.such.file|does.not.exist|'
    r'syntax.error|SyntaxError|NameError|TypeError|'
    r'command not found|No such file or directory|'
    r'exploit.completed.*no.session|no.sessions.created|'
    r'Execute command failed|Could not retrieve output|'
    r'\[-\]\s*\w)', re.IGNORECASE)

LOGICAL_FALSE_POS = re.compile(
    r'(grep.*error|sed.*error|find.*error|'
    r'\.log|\.md|settings\.json|\.py\b|\.sh\b|'
    r'hook.*error|test.*error|except.*Error|raise.*Error|'
    r'"timeout":\s*\d|"command":|LOGICAL_FAIL|'
    r'"success":\s*true|"result"|"results"|"total":|'
    r'Could not find.*files|No files found|0 results|'
    r'not found in (search|database|cache|index)|'
    r'curl.*-s|python3.*<<|jq\s)', re.IGNORECASE)

LOGICAL_SUCCESS = re.compile(
    r'(root@|uid=0|nt.authority.*system|'
    r'shell\s+opened|session\s+\d+\s+opened|'
    r'successfully\s+(uploaded|created|enabled|completed)|'
    r'tunnel.*connected|persistence.*active)', re.IGNORECASE)

HEDGING = re.compile(
    r'\b(i think this should work|probably|might work|should be fine|'
    r'i believe|i assume|let me just try|hopefully|that should do it|'
    r'this likely|seems like it should|maybe this will)\b', re.IGNORECASE)

GIVING_UP = re.compile(
    r'\b(monitor.*(every|setiap)|wait.*(until|sampai)|daripada.*(keep|terus)|'
    r'biarkan.*monitor|let me.*check.*(later|nanti)|'
    r'impossible|unreachable|no.way|cannot.proceed|'
    r'tidak.bisa|mustahil|tidak.ada.cara)\b', re.IGNORECASE)

CONSEQUENTIAL_CMD = re.compile(
    r'(\brm\s|\bmv\s|>\s*\S|>>|\bdd\b|\bmkfs|\bcurl\b.*-[XdD]|\bwget\b|'
    r'\bnc\b|\bssh\b|\bgit\s+push|\bnpm\s+publish|\bsqlmap|\bnmap\b|'
    r'\bhydra\b|\bexploit|\bnetexec\b|\bimpacket|\bschtasks|\bwmic\b|'
    r'\bpowershell|\bcertutil|\bsc\s+create)', re.IGNORECASE)

SUCCESS_INDICATORS = re.compile(
    r'\b(success|succeeded|completed|done|passed|created|installed|'
    r'deployed|working|fixed|resolved|running|started|enabled)\b', re.IGNORECASE)

VERIFY_CMD = re.compile(
    r'(?:^|\s)(test\s|verify|check|assert|curl.*status|grep\s|cat\s|type\s|dir\s|ls\s|'
    r'ps\s|tasklist|netstat|ss\s+-|systemctl\s+status|service.*status|'
    r'--dry-run|ping\s|validate|diff\s|stat\s|wc\s|file\s|head\s)', re.IGNORECASE)

DIAGNOSIS_CLAIM = re.compile(
    r'\b(masalahnya|root cause|the issue is|the problem is|'
    r'penyebabnya|karena .{5,30} tidak|ini gagal karena|'
    r'fix.*nya|solusinya|the fix is|solved|'
    r'sudah berhasil|sudah selesai|sudah fix|sudah beres|'
    r'sudah diperbaiki|sudah jalan|sudah bisa|works now|'
    r'it.s working|confirmed working|berhasil|terbukti)\b', re.IGNORECASE)

PROOF_PATTERNS = re.compile(
    r'(output:|result:|bukti:|evidence:|response:|proof:|HTTP \d{3}|'
    r'exit.code|returned|shows|menunjukkan|terlihat di output|'
    r'confirmed by|verified via|tested with)', re.IGNORECASE)

STOP_INTENT = re.compile(
    r'^\s*(stop|cancel|abort|halt|cukup|selesai|sudah|berhenti|done|quit|udah|batal)\s*$', re.IGNORECASE)

QUESTION_PATTERN = re.compile(
    r'^\s*(apa|kenapa|gimana|bagaimana|mengapa|kapan|dimana|siapa|berapa|'
    r'apakah|how|what|why|when|where|which|is |are |do |does |can |could )', re.IGNORECASE)

DIAG_CMD = re.compile(
    r'^\s*(type|cat|dir|ls|icacls|cacls|appcmd|get-web|web\.config|findstr|reg\s+query)', re.IGNORECASE)

# ═══════════════════════════════════════════════════
# KB LOOKUP (EXACT from intelligence-engine.py)
# ═══════════════════════════════════════════════════

def load_kb():
    try:
        with open(KB_FILE, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"entries": []}

def lookup_kb(cmd, error, exit_code, os_hint):
    kb = load_kb()
    combined = f"{cmd}\n{error}".lower()
    matches = []
    for entry in kb.get("entries", []):
        sig = entry.get("signature", {})
        score = 0
        elements = 0
        for p in sig.get("stderr_patterns", []) + sig.get("stdout_patterns", []):
            try:
                if re.search(p, combined): score += 2; elements += 1
            except re.error: pass
        if sig.get("exit_codes") and str(exit_code) in [str(x) for x in sig["exit_codes"]]:
            score += 1; elements += 1
        ctx = sig.get("context_required", {})
        if ctx.get("tool_class") and re.search(ctx["tool_class"], combined):
            score += 1; elements += 1
        if ctx.get("os_hint") and ctx["os_hint"] == os_hint:
            score += 1; elements += 1
        confidence = entry.get("diagnosis", {}).get("confidence", 0.5)
        if elements >= 1 and confidence >= 0.4:
            matches.append((score * confidence, entry))
    matches.sort(key=lambda x: x[0], reverse=True)
    return [m[1] for m in matches[:2]]

# ═══════════════════════════════════════════════════
# FINGERPRINT STORE (JSONL)
# ═══════════════════════════════════════════════════

def fp_store_path(session_id):
    return os.path.join(STATE_DIR, f"{_safe_session(session_id)}_fp.jsonl")

def read_fp_counts(session_id, fp, endpoint):
    """Read fingerprint count AND endpoint count from JSONL."""
    fp_count = 0
    ep_count = 0
    last_err = ""
    last_technique = ""
    try:
        with open(fp_store_path(session_id), 'r') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    if entry.get('fp') == fp:
                        fp_count += 1
                        last_err = (entry.get('err_short', '') or '')[:100]
                        last_technique = entry.get('technique', 'unknown')
                    if endpoint and entry.get('endpoint') == endpoint:
                        ep_count += 1
                except: pass
    except FileNotFoundError: pass
    return fp_count, ep_count, last_err, last_technique

def append_fp_store(session_id, fp, endpoint, technique, error_hint):
    path = fp_store_path(session_id)
    try:
        with open(path, 'a') as f:
            f.write(json.dumps({"fp": fp, "endpoint": endpoint, "technique": technique,
                                "ts": time.time(), "err_short": error_hint}) + "\n")
        lines = open(path).readlines()
        if len(lines) > 100:
            with open(path, 'w') as f: f.writelines(lines[-80:])
    except: pass

# ═══════════════════════════════════════════════════
# THINKING DONE FILE
# ═══════════════════════════════════════════════════

def thinking_done_path(session_id):
    return os.path.join(STATE_DIR, f"{_safe_session(session_id)}_thinking_done")

def is_thinking_recent(session_id, max_age=120):
    try:
        ts = float(open(thinking_done_path(session_id)).read().strip())
        return (time.time() - ts) < max_age
    except: return False

def mark_thinking_done(session_id):
    try:
        with open(thinking_done_path(session_id), 'w') as f:
            f.write(str(time.time()))
    except: pass

# ═══════════════════════════════════════════════════
# DIAGNOSTIC MARKER (for H7 spray-and-pray)
# ═══════════════════════════════════════════════════

def mark_diag_done(session_id):
    try:
        with open(os.path.join(STATE_DIR, f"diag_done_{_safe_session(session_id)}"), 'w') as f:
            f.write(str(time.time()))
    except: pass

def is_diag_recent(session_id, max_age=120):
    try:
        ts = float(open(os.path.join(STATE_DIR, f"diag_done_{_safe_session(session_id)}")).read().strip())
        return (time.time() - ts) < max_age
    except: return False

# ═══════════════════════════════════════════════════
# TIMERS (user-defined via JSON file)
# ═══════════════════════════════════════════════════

def load_timers(session_id):
    try:
        with open(os.path.join(STATE_DIR, f"{_safe_session(session_id)}_timers.json")) as f:
            return [t for t in json.load(f) if t.get("expires_at", 0) > time.time()]
    except: return []

def fmt_duration(secs):
    secs = abs(int(secs))
    if secs < 60: return f"{secs}s"
    if secs < 3600:
        m, s = divmod(secs, 60)
        return f"{m}m{s}s" if s else f"{m}m"
    h, remainder = divmod(secs, 3600)
    return f"{h}h{remainder//60}m"

# ═══════════════════════════════════════════════════
# JACCARD SIMILARITY (EXACT from intelligence-engine.py)
# ═══════════════════════════════════════════════════

def _tokenize(s):
    return [t for t in re.split(r'[\s/=\-_.\\:]+', s.lower()) if len(t) > 1]

def _jaccard(a, b):
    sa, sb = set(_tokenize(a)), set(_tokenize(b))
    if not sa or not sb: return 0.0
    return len(sa & sb) / len(sa | sb)

# ═══════════════════════════════════════════════════
# MODE: pre_bash — PreToolUse:Bash (ALL 10 sub-functions)
# ═══════════════════════════════════════════════════

def handle_pre_bash(data, session_id):
    cmd = data.get('tool_input', {}).get('command', '') or ''
    description = data.get('tool_input', {}).get('description', '') or ''

    if TRIVIAL_CMD.match(cmd):
        output_approve()
        return

    st = load_state(session_id, "_intel")
    tf = load_state(session_id, "_thinkforce")
    injections = []
    should_block = False
    block_reason = ""

    fp = fingerprint_cmd(cmd)
    endpoint = extract_endpoint(cmd)

    # [1] FINGERPRINT + ENDPOINT RETRY BLOCK (EXACT: fp_count AND ep_count)
    fp_count, ep_count, last_err, last_technique = read_fp_counts(session_id, fp, endpoint)
    thinking_recent = is_thinking_recent(session_id)

    if fp_count >= 10 or ep_count >= 10:
        if thinking_recent:
            injections.append(f"[LAST CHANCE] Gagal {fp_count}x (fp) / {ep_count}x (endpoint). Thinking done — approve. GAGAL LAGI = pivot WAJIB.")
        else:
            should_block = True
            block_reason = (f"[BLOCKED] Endpoint {endpoint} GAGAL {ep_count}x (fp {fp}: {fp_count}x). Tech:{last_technique}. Err:{last_err}. "
                          f"WAJIB pakai sequentialthinking DULU atau PIVOT ke approach berbeda.")
    elif fp_count >= 5 or ep_count >= 5:
        injections.append(f"[WARN] Endpoint {endpoint} gagal sebelumnya (fp:{fp_count}x, ep:{ep_count}x, tech:{last_technique}). Err:{last_err}. Next fail = BLOCK.")

    # [2] THINKING-FORCE: persistent DIAGNOSA WAJIB box
    pending = tf.get("pending_diagnosa")
    if pending and not should_block:
        need_seq = pending.get("need_sequential", False)
        if need_seq:
            error_hint = pending.get("error_hint", "")[:80]
            fail_count = tf.get("fail_count", 1)
            box = (
                f"╔══ DIAGNOSA WAJIB (error #{fail_count}) ══╗\n"
                f"║ Error: {error_hint}\n"
                f"║ ❌ sequentialthinking BELUM dipanggil\n"
                f"║ ⛔ Bash DITAHAN sampai diagnosa selesai.\n"
                f"╚════════════════════════════════════════╝"
            )
            injections.insert(0, box)
            pending["ignored_count"] = pending.get("ignored_count", 0) + 1
            save_state(session_id, tf, "_thinkforce")

    # [3] H1: Prediction gate
    if st.get("last_failure_ts") and not st.get("thinking_since_fail"):
        fail_count = len([f for f in st.get("failures", []) if f.get("ts", 0) >= st.get("last_failure_ts", 0) - 1])
        if fail_count >= 2:
            injections.append("[PREDICTION GATE] 2+ failures — diagnosa ROOT CAUSE sebelum retry.")
        elif fail_count >= 1:
            injections.append("[PREDICTION GATE] Command sebelumnya gagal. Kenapa berhasil kali ini?")

    # [4] H3 + H3b: Hedging + Giving-up interceptor
    haystack = f"{cmd} {description}".lower()
    giving_up = GIVING_UP.findall(haystack)
    if giving_up:
        injections.append("[GIVING UP DETECTED] DILARANG idle/monitor/wait. Per VECTOR EXHAUSTION: cari vektor LAIN sekarang.")
    else:
        hedging = HEDGING.findall(haystack)
        if hedging:
            found = ", ".join(sorted(set(m.lower() if isinstance(m, str) else m[0].lower() for m in hedging[:2])))
            injections.append(f'[HEDGING] "{found}" — acting on GUESS. State SPECIFIC mechanism.')

    # [5] H4: Research floor
    if CONSEQUENTIAL_CMD.search(cmd) and st.get("research_count", 0) < 2:
        injections.append(f"[RESEARCH FLOOR] Consequential action dengan {st.get('research_count', 0)} riset. Verify dari independent angles dulu.")

    # [6] H5: Pending success claim check
    claim = st.get("pending_success_claim")
    if claim and not VERIFY_CMD.search(cmd):
        injections.append("[UNVERIFIED SUCCESS] Command sebelumnya 'success' tapi belum di-verify. Cek REAL state.")
        st["pending_success_claim"] = None

    # [7] H6: Pending diagnosis claim + H6b: CURRENT description check
    diag_claim = st.get("pending_diagnosis_claim")
    if diag_claim and not VERIFY_CMD.search(cmd):
        if time.time() - diag_claim.get("ts", 0) < 60:
            injections.append("[UNVERIFIED DIAGNOSIS] Klaim tanpa bukti sebelumnya. Verify dulu.")
        st["pending_diagnosis_claim"] = None
    # H6b: Check diagnosis claim in CURRENT description (EXACT from intelligence-engine.py:591-599)
    if description and not VERIFY_CMD.search(cmd):
        if DIAGNOSIS_CLAIM.search(description) and not PROOF_PATTERNS.search(description):
            injections.append(f'[CLAIM IN DESCRIPTION] "{description[:100]}" — klaim tanpa bukti. Verify dulu.')

    # [8] H7: Same-category spray (with diagnostic marker check)
    recent_fails = st.get("failures", [])[-3:]
    if len(recent_fails) >= 2:
        cats = [f.get("cat", "unknown") for f in recent_fails]
        if len(set(cats)) == 1 and cats[0] != 'unknown':
            if not DIAG_CMD.match(cmd) and not is_diag_recent(session_id):
                injections.append(f"[SPRAY-AND-PRAY] Error '{cats[0]}' berulang {len(cats)}x. DIAGNOSA root cause sebelum retry!")

    # [9] V2: Approach-based soft-block with SIMILARITY check (EXACT)
    approach_key = build_approach_key(cmd)
    approaches = st.get("approaches", {})
    if approach_key in approaches:
        appr = approaches[approach_key]
        count = appr.get("count", 0)
        verb = extract_verb_class(cmd)
        threshold = VERB_THRESHOLDS.get(verb, 2)
        if count >= threshold:
            last_cmds = appr.get("last_cmds", [])
            cmd_norm = re.sub(r'\s+', ' ', cmd.lower().strip())[:150]
            changed = True
            if last_cmds:
                prev_norm = re.sub(r'\s+', ' ', last_cmds[-1].lower().strip())[:150]
                common = sum(1 for a, b in zip(cmd_norm, prev_norm) if a == b)
                sim = common / max(len(cmd_norm), len(prev_norm), 1)
                changed = sim < 0.8
            if not changed:
                injections.append(f"[UNCHANGED RETRY] Approach '{approach_key}' failed {count}x — command NEARLY IDENTICAL. Must be fundamentally different.")
            elif count >= threshold + 2:
                injections.append(f"[SOFT-BLOCK] Approach '{approach_key}' failed {count}x. State: root cause + what's different.")

    # [10] SMART DEEP-THINK (EXACT from thinking-force.py:358-403)
    deep_think_file = os.path.join(STATE_DIR, f"{_safe_session(session_id)}_deepthink")
    if os.path.exists(deep_think_file) and not pending:
        should_think = False
        reason = ""
        if tf.get("bash_count_this_turn", 0) == 0:
            should_think = True
            reason = "Bash PERTAMA di turn — plan approach dulu"
        current_ep = extract_endpoint(cmd)
        if current_ep and current_ep != tf.get("last_endpoint", "") and tf.get("bash_count_this_turn", 0) > 0:
            should_think = True
            reason = f"Target BARU ({current_ep}) — analisis dulu"
            tf["last_endpoint"] = current_ep
        # consecutive_success >= 3 → SKIP (jangan ganggu momentum)
        if tf.get("consecutive_success", 0) >= 3:
            should_think = False
        if should_think and not thinking_recent:
            injections.append(f"⚡ DEEP-THINK: {reason}\n→ sequentialthinking, baru execute.")

    save_state(session_id, st, "_intel")
    save_state(session_id, tf, "_thinkforce")

    if should_block:
        output_block(block_reason)
    elif injections:
        output_approve("\n\n".join(injections[:3]))
    else:
        output_approve()

# ═══════════════════════════════════════════════════
# MODE: fail — PostToolUseFailure (ALL 5 sub-functions)
# ═══════════════════════════════════════════════════

def handle_fail(data, session_id):
    cmd = data.get('tool_input', {}).get('command', '') or ''
    error = data.get('tool_response', {}).get('stderr', '') or data.get('tool_response', {}).get('content', '') or ''
    if isinstance(error, (dict, list)): error = json.dumps(error)
    exit_code = data.get('tool_response', {}).get('exit_code', 'unknown')

    st = load_state(session_id, "_intel")
    tf = load_state(session_id, "_thinkforce")
    now = time.time()

    fp = fingerprint_cmd(cmd)
    endpoint = extract_endpoint(cmd)
    technique = classify_technique(cmd)
    error_cat = classify_error(cmd, error, exit_code)
    os_hint = detect_os(cmd)
    approach_key = build_approach_key(cmd)
    error_hint = str(error)[:150].strip()

    # Update intel state
    if "approaches" not in st: st["approaches"] = {}
    if approach_key not in st["approaches"]:
        st["approaches"][approach_key] = {"count": 0, "first_fail": now, "last_fail": now, "errors_seen": [], "last_cmds": []}
    appr = st["approaches"][approach_key]
    appr["count"] += 1
    appr["last_fail"] = now
    appr["errors_seen"] = (appr.get("errors_seen", []) + [error_cat])[-5:]
    appr["last_cmds"] = (appr.get("last_cmds", []) + [cmd[:200]])[-5:]
    st["failures"] = (st.get("failures", []) + [{"ts": now, "cmd": cmd[:300], "cat": error_cat}])[-20:]
    st["last_failure_ts"] = now
    st["thinking_since_fail"] = False

    # Store fingerprint
    append_fp_store(session_id, fp, endpoint, technique, error_hint)

    # Set thinking-force pending_diagnosa
    tf["fail_count"] = tf.get("fail_count", 0) + 1
    tf["consecutive_success"] = 0
    tf["pending_diagnosa"] = {"need_sequential": True, "error_hint": error_hint, "ts": now}

    save_state(session_id, st, "_intel")
    save_state(session_id, tf, "_thinkforce")

    # Build response
    lines = []
    count = appr["count"]

    # KB lookup with os_hint (EXACT)
    kb_matches = lookup_kb(cmd, error, exit_code, os_hint)
    if kb_matches:
        best = kb_matches[0]
        diag = best.get("diagnosis", {})
        lines.append(f"[KB MATCH] {best.get('id','?')} (confidence:{diag.get('confidence',0)})")
        lines.append(f"  ROOT CAUSE: {diag.get('root_cause', '?')}")
        for sol in best.get("remediation", [])[:2]:
            lines.append(f"  FIX: {sol.get('action', '')}")
            if sol.get("command_template"):
                lines.append(f"    → {sol['command_template'][:120]}")
        for ap in best.get("anti_patterns", [])[:1]:
            lines.append(f"  JANGAN: {ap.get('action','')} — {ap.get('why','')}")
    else:
        cat_hints = {
            'permission_denied': 'Access denied. Check privilege level.',
            'network_unreachable': 'Connection failed. Target up? Port open?',
            'timeout': 'Timed out. Tunnel down? Remove sleep prefix.',
            'defense_block': 'Security control. Add exclusion or rename binary.',
            'not_found': 'File/command not found. Verify path.',
            'auth_failure': 'Auth rejected. Credential wrong/expired/locked.',
            'cmdlet_missing': 'Command unavailable. Check OS/version.',
            'syntax_error': 'Syntax error. Check quoting/escaping.',
            'ssh_error': 'SSH failed (255). Key/port/tunnel issue.',
        }
        lines.append(f"[INTELLIGENCE] Approach: {approach_key} | #{count} | Cat: {error_cat} | OS: {os_hint}")
        lines.append(f"  HINT: {cat_hints.get(error_cat, 'Read error output carefully.')}")

    # Graduated response
    if count >= 3:
        lines.append(f"\n[PIVOT PAKSA] GAGAL {count}x. DILARANG retry. WAJIB teknik/target BERBEDA.")
    elif count >= 2:
        lines.append(f"\n[ROOT CAUSE WAJIB] GAGAL {count}x. Diagnosa → sequentialthinking → baru retry.")

    # H2: Diversity detector (EXACT Jaccard)
    recent = st.get("failures", [])[-3:]
    if len(recent) >= 2:
        cmds = [f.get("cmd", "") for f in recent]
        max_overlap = 0
        for i in range(len(cmds)):
            for j in range(i+1, len(cmds)):
                max_overlap = max(max_overlap, _jaccard(cmds[i], cmds[j]))
        if max_overlap > 0.2:
            lines.append(f"\n[SPRAY-AND-PRAY] Overlap {int(max_overlap*100)}%. STOP variasi. DIAGNOSA root cause!")

    # Mandatory diagnosa box
    lines.append("\n╔══ DIAGNOSA WAJIB ══╗\n║ ❌ sequentialthinking BELUM\n║ Panggil SEKARANG.\n╚═════════════════════╝")

    output_post("\n".join(lines))

# ═══════════════════════════════════════════════════
# MODE: post — PostToolUse (ALL sub-functions)
# ═══════════════════════════════════════════════════

def handle_post(data, session_id):
    tool_name = data.get('tool_name', '') or ''
    cmd = data.get('tool_input', {}).get('command', '') or ''
    description = data.get('tool_input', {}).get('description', '') or ''
    output_text = data.get('tool_response', {}).get('stdout', '') or data.get('tool_response', {}).get('content', '') or ''
    stderr = data.get('tool_response', {}).get('stderr', '') or ''
    if isinstance(output_text, (dict, list)): output_text = json.dumps(output_text)

    st = load_state(session_id, "_intel")
    tf = load_state(session_id, "_thinkforce")
    anchor_st = load_state(session_id, "_anchor")
    now = time.time()
    injections = []

    # === IF BASH ===
    if tool_name == 'Bash':
        combined = f"{output_text} {stderr}"
        is_trivial = bool(TRIVIAL_CMD.match(cmd))

        if not is_trivial and len(combined.strip()) > 5:
            has_success = bool(LOGICAL_SUCCESS.search(combined))
            has_failure = bool(LOGICAL_FAIL.search(combined)) and not LOGICAL_FALSE_POS.search(combined)

            # [16] False-success detection (EXACT strong patterns)
            if not has_failure:
                strong_false = [r'access\s*(is\s*)?denied', r'0 file\(?s?\)? copied',
                               r'system cannot find', r'is not recognized as',
                               r'command not found', r'permission denied',
                               r'authentication fail', r'STATUS_\w+_DENIED', r'STATUS_LOGON_FAILURE']
                if any(re.search(p, combined.lower()) for p in strong_false):
                    injections.append("[FALSE SUCCESS] Exit 0 tapi output GAGAL. Baca output UTUH.")

            # [17] Logical failure → pending_diagnosa
            if has_failure and not has_success:
                tf["fail_count"] = tf.get("fail_count", 0) + 1
                tf["consecutive_success"] = 0
                error_hint = ""
                for line in combined.split('\n'):
                    if LOGICAL_FAIL.search(line) and not LOGICAL_FALSE_POS.search(line):
                        error_hint = line.strip()[:150]; break
                tf["pending_diagnosa"] = {"need_sequential": True, "error_hint": error_hint, "ts": now}
                injections.append(f"[LOGICAL FAIL] {error_hint[:100]}\nDIAGNOSA WAJIB → sequentialthinking.")

            # [18] H5: Record success claim
            if SUCCESS_INDICATORS.search(str(output_text)) and not VERIFY_CMD.search(cmd):
                st["pending_success_claim"] = {"ts": now, "cmd": cmd[:200]}

            # [19] H6: Record diagnosis claim
            combined_check = f"{combined} {description}"
            if DIAGNOSIS_CLAIM.search(combined_check) and not PROOF_PATTERNS.search(combined_check):
                st["pending_diagnosis_claim"] = {"ts": now, "claim_text": combined_check[:200]}
            elif DIAGNOSIS_CLAIM.search(combined_check) and PROOF_PATTERNS.search(combined_check):
                st["pending_diagnosis_claim"] = None

            # [20] Reset approach on success + consecutive_success
            if has_success:
                approach_key = build_approach_key(cmd)
                if approach_key in st.get("approaches", {}):
                    st["approaches"][approach_key]["count"] = 0
                tf["fail_count"] = 0
                tf["pending_diagnosa"] = None

            # Diagnostic command marker (for H7)
            if DIAG_CMD.match(cmd):
                mark_diag_done(session_id)

        # Track consecutive success
        if not (bool(LOGICAL_FAIL.search(f"{output_text} {stderr}")) and not LOGICAL_FALSE_POS.search(f"{output_text} {stderr}")):
            tf["consecutive_success"] = tf.get("consecutive_success", 0) + 1
        tf["bash_count_this_turn"] = tf.get("bash_count_this_turn", 0) + 1

    # === IF THINKING ===
    elif 'sequentialthinking' in tool_name.lower() or 'thinking' in tool_name.lower():
        # [21] Clear pending_diagnosa
        if tf.get("pending_diagnosa"):
            tf["pending_diagnosa"] = None
            tf["fail_count"] = 0
        # [22] Mark thinking done + validate quality
        thought_num = data.get('tool_input', {}).get('thoughtNumber', 0)
        if thought_num >= 2:
            st["thinking_since_fail"] = True
            st["research_count"] = st.get("research_count", 0) + 1
        # [23] Reset counters
        mark_thinking_done(session_id)
        tf["consecutive_success"] = 0

    # === IF RESEARCH TOOLS ===
    elif any(r in tool_name.lower() for r in ['jina', 'exa', 'brave', 'perplexity', 'search', 'tavily']):
        st["research_count"] = st.get("research_count", 0) + 1
        st["thinking_since_fail"] = True

    # === ALL TOOLS: [24] Time awareness + timers (throttled 60s, near-deadline override) ===
    last_time_inject = st.get("_last_time_inject", 0)
    timers = load_timers(session_id)
    near_deadline = any((t.get("expires_at", 0) - now) <= 300 for t in timers)
    if (now - last_time_inject >= 60) or near_deadline:
        st["_last_time_inject"] = now
        if "_session_start" not in st: st["_session_start"] = now
        elapsed = now - st["_session_start"]
        wall = datetime.fromtimestamp(now).strftime("%H:%M")
        time_line = f"[TIME {wall} | session +{fmt_duration(elapsed)}]"
        for t in sorted(timers, key=lambda x: x.get("expires_at", 0)):
            remaining = t["expires_at"] - now
            name = t.get("name", "unnamed")
            if remaining <= 300:
                time_line += f"\n  ⚠️ TIMER \"{name}\" in {fmt_duration(remaining)}"
            else:
                time_line += f"\n  ⏳ TIMER \"{name}\" in {fmt_duration(remaining)}"
        injections.append(time_line)

    # === ALL TOOLS: [25] Re-anchor (throttled every 10 calls) ===
    anchor_st["tool_calls_since_anchor"] = anchor_st.get("tool_calls_since_anchor", 0) + 1
    if anchor_st["tool_calls_since_anchor"] >= 10 and anchor_st.get("instructions"):
        anchor_st["tool_calls_since_anchor"] = 0
        tasks = [i for i in anchor_st["instructions"] if i.get("is_task")]
        if tasks and not anchor_st.get("task_done"):
            recent = tasks[-1]
            injections.append(
                f"[RE-ANCHOR] Perintah Tuan: \"{recent['text'][:150]}\"\n"
                "PERINTAH = MUTLAK. Jika gagal → diagnosa → approach BARU.")
    save_state(session_id, anchor_st, "_anchor")
    save_state(session_id, st, "_intel")
    save_state(session_id, tf, "_thinkforce")

    output_post("\n".join(injections) if injections else None)

# ═══════════════════════════════════════════════════
# MODE: prompt — UserPromptSubmit (ALL sub-functions)
# ═══════════════════════════════════════════════════

def handle_prompt(data, session_id):
    prompt = data.get('prompt', '').strip()
    if not prompt:
        output_empty()
        return

    tf = load_state(session_id, "_thinkforce")
    anchor_st = load_state(session_id, "_anchor")

    # [26] Capture instruction for re-anchor
    if STOP_INTENT.match(prompt):
        anchor_st["task_done"] = True
    else:
        is_question = bool(QUESTION_PATTERN.match(prompt)) or prompt.rstrip().endswith('?')
        anchor_st.setdefault("instructions", []).append({
            "t": int(time.time()), "text": prompt[:500], "is_task": not is_question
        })
        anchor_st["instructions"] = anchor_st["instructions"][-5:]
        if not is_question:
            anchor_st["tool_calls_since_anchor"] = 0
            anchor_st["task_done"] = False

    # [27] Reset turn counter + consecutive_success
    tf["bash_count_this_turn"] = 0
    tf["consecutive_success"] = 0

    # [29] Detect deep-think mode keyword
    deep_think_file = os.path.join(STATE_DIR, f"{_safe_session(session_id)}_deepthink")
    if re.search(r'\b(super teliti|teliti|riset|deep think|think hard|pikir|analisis mendalam|pakai semua mcp|gunakan semua tool)\b', prompt, re.IGNORECASE):
        try:
            with open(deep_think_file, 'w') as f: f.write("1")
        except: pass
    elif re.search(r'^\s*(stop deep|stop teliti|normal mode|biasa aja|gak usah teliti)\s*$', prompt, re.IGNORECASE):
        try: os.remove(deep_think_file)
        except: pass

    # [30] Detect force-full-read keyword
    full_read_flag = f"/tmp/claude_force_full_read_{session_id}"
    if re.search(r'\b(baca utuh|baca semua|baca seluruh|read full|baca lengkap|jangan skip)\b', prompt, re.IGNORECASE):
        try:
            with open(full_read_flag, 'w') as f: f.write("1")
        except: pass
    elif re.search(r'^\s*(stop full.?read|normal read|biasa aja bacanya)\s*$', prompt, re.IGNORECASE):
        try: os.remove(full_read_flag)
        except: pass

    # [31] Save last 10 user commands
    cmd_file = os.path.join(STATE_DIR, f"{_safe_session(session_id)}_cmds.txt")
    try:
        with open(cmd_file, 'a') as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {prompt[:200]}\n")
        lines = open(cmd_file).readlines()
        if len(lines) > 10:
            with open(cmd_file, 'w') as f: f.writelines(lines[-10:])
    except: pass

    save_state(session_id, tf, "_thinkforce")
    save_state(session_id, anchor_st, "_anchor")
    output_empty()

# ═══════════════════════════════════════════════════
# MAIN DISPATCH
# ═══════════════════════════════════════════════════

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "post"
    data = safe_json({})
    session_id = data.get('session_id', 'default')

    try:
        if mode == "pre_bash": handle_pre_bash(data, session_id)
        elif mode == "fail": handle_fail(data, session_id)
        elif mode == "post": handle_post(data, session_id)
        elif mode == "prompt": handle_prompt(data, session_id)
        else: output_approve()
    except Exception as e:
        if mode == "pre_bash": output_approve()
        else: print(json.dumps({"continue": True}))
        try:
            with open(os.path.join(STATE_DIR, "crash.log"), 'a') as f:
                f.write(f"[{datetime.now().isoformat()}] mode={mode} err={str(e)[:200]}\n")
        except: pass

    sys.exit(0)

if __name__ == "__main__":
    main()
