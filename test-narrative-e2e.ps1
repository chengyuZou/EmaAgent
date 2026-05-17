# End-to-end narrative test: DeepSeek LLM + SiliconFlow embed
param(
    [switch]$StartServers,
    [string]$CoreUrl  = "http://localhost:3421",
    [string]$UserInput = "第三周目里希罗揭露了哪些人的禁忌？"
)

$ErrorActionPreference = "Stop"

$DEEPSEEK_KEY    = "sk-48f0e582ccfa46ae85ad62917fbc9c09"
$SILICONFLOW_KEY = "sk-phfezkdmvncnhkszybktohrcccvwchhfkrvcncidwrfzheev"

function Post-Json([string]$Url, [hashtable]$Body) {
    $json  = $Body | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req   = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method        = "POST"
    $req.ContentType   = "application/json; charset=utf-8"
    $req.ContentLength = $bytes.Length
    $req.Timeout       = 30000
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    $resp   = $req.GetResponse()
    $reader = [System.IO.StreamReader]::new($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text   = $reader.ReadToEnd(); $reader.Close(); $resp.Close()
    return $text | ConvertFrom-Json
}

function Put-Json([string]$Url, [hashtable]$Body) {
    $json  = $Body | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req   = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method        = "PUT"
    $req.ContentType   = "application/json; charset=utf-8"
    $req.ContentLength = $bytes.Length
    $req.Timeout       = 15000
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    $resp   = $req.GetResponse()
    $reader = [System.IO.StreamReader]::new($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text   = $reader.ReadToEnd(); $reader.Close(); $resp.Close()
    return $text | ConvertFrom-Json
}

function Get-JsonSimple([string]$Url) {
    $req    = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method  = "GET"
    $req.Timeout = 10000
    $resp   = $req.GetResponse()
    $reader = [System.IO.StreamReader]::new($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text   = $reader.ReadToEnd(); $reader.Close(); $resp.Close()
    return $text | ConvertFrom-Json
}

# 1. Health
Write-Host "`n-- 1. Health check" -ForegroundColor Yellow
try {
    $health = Get-JsonSimple "$CoreUrl/health"
    Write-Host "   Core status: $($health.status)" -ForegroundColor Green
} catch {
    Write-Host "ERROR: core not reachable at $CoreUrl" -ForegroundColor Red
    exit 1
}

# 2. Register DeepSeek
Write-Host "`n-- 2. Register DeepSeek provider" -ForegroundColor Yellow
$ds = Post-Json "$CoreUrl/api/providers" @{
    definitionId = "deepseek"
    displayName  = "DeepSeek (test)"
    apiKey       = $DEEPSEEK_KEY
    baseUrl      = "https://api.deepseek.com"
    capabilities = @("llm")
    config       = @{}
}
$dsId = $ds.id
Write-Host "   id=$dsId" -ForegroundColor Green

# 3. Register SiliconFlow
Write-Host "`n-- 3. Register SiliconFlow provider" -ForegroundColor Yellow
$sf = Post-Json "$CoreUrl/api/providers" @{
    definitionId = "siliconflow"
    displayName  = "SiliconFlow (test)"
    apiKey       = $SILICONFLOW_KEY
    baseUrl      = "https://api.siliconflow.cn/v1"
    capabilities = @("embed")
    config       = @{}
}
$sfId = $sf.id
Write-Host "   id=$sfId" -ForegroundColor Green

# 4. Model bindings
Write-Host "`n-- 4. Set model bindings" -ForegroundColor Yellow
Put-Json "$CoreUrl/api/model-bindings/narrative"    @{ providerConfigId=$dsId; model="deepseek-chat" } | Out-Null
Write-Host "   narrative    -> deepseek-chat" -ForegroundColor Green
Put-Json "$CoreUrl/api/model-bindings/lightrag-llm" @{ providerConfigId=$dsId; model="deepseek-chat" } | Out-Null
Write-Host "   lightrag-llm -> deepseek-chat" -ForegroundColor Green
Put-Json "$CoreUrl/api/model-bindings/embed"        @{ providerConfigId=$sfId; model="Pro/BAAI/bge-m3" } | Out-Null
Write-Host "   embed        -> Pro/BAAI/bge-m3" -ForegroundColor Green

# 5. POST turn
Write-Host "`n-- 5. Start narrative turn" -ForegroundColor Yellow
Write-Host "   Query: $UserInput"
$turn      = Post-Json "$CoreUrl/api/turns" @{ mode="narrative"; userInput=$UserInput }
$turnId    = $turn.turnId
$sessionId = $turn.sessionId
Write-Host "   turnId=$turnId  sessionId=$sessionId" -ForegroundColor Green

# 6. Stream SSE
Write-Host "`n-- 6. Streaming SSE (Ctrl+C to abort)" -ForegroundColor Yellow
Write-Host ""

$sseUrl = "$CoreUrl/api/turns/$turnId/events"
$req2   = [System.Net.HttpWebRequest]::Create($sseUrl)
$req2.Method             = "GET"
$req2.Timeout            = 120000
$req2.ReadWriteTimeout   = 120000
$req2.Headers.Add("Accept", "text/event-stream")

$resp2  = $req2.GetResponse()
$reader2 = [System.IO.StreamReader]::new($resp2.GetResponseStream(), [System.Text.Encoding]::UTF8)

$done     = $false
$buf      = ""
$fullText = ""

try {
    while (-not $done -and -not $reader2.EndOfStream) {
        $line = $reader2.ReadLine()
        if ($null -eq $line) { break }

        if ($line.StartsWith("data: ")) {
            $buf += $line.Substring(6)
        } elseif ($line -eq "") {
            if ($buf.Trim() -ne "" -and $buf.Trim() -ne "{}") {
                try {
                    $ev = $buf | ConvertFrom-Json
                    $t  = $ev.type

                    if ($t -eq "turn_started") {
                        Write-Host "[turn_started] mode=$($ev.mode)" -ForegroundColor Cyan
                    } elseif ($t -eq "narrative_route_resolved") {
                        $tl = $ev.timelines -join ", "
                        Write-Host "[narrative_route_resolved] timelines: $tl" -ForegroundColor Magenta
                    } elseif ($t -eq "narrative_timeline_complete") {
                        Write-Host "[narrative_timeline_complete] $($ev.timeline) -- $($ev.charCount) chars -- $($ev.snippet)" -ForegroundColor Magenta
                    } elseif ($t -eq "recall_evidence") {
                        $src = $ev.sources -join ", "
                        Write-Host "[recall_evidence] sources=$src count=$($ev.itemCount)" -ForegroundColor DarkMagenta
                    } elseif ($t -eq "output_text_delta") {
                        Write-Host -NoNewline $ev.delta
                        $fullText += $ev.delta
                    } elseif ($t -eq "output_text_complete") {
                        Write-Host ""
                    } elseif ($t -eq "system_warning") {
                        Write-Host "`n[system_warning] [$($ev.level)] $($ev.message)" -ForegroundColor DarkYellow
                    } elseif ($t -eq "turn_completed") {
                        Write-Host "`n[turn_completed] in=$($ev.usage.inputTokens) out=$($ev.usage.outputTokens)" -ForegroundColor Green
                        $done = $true
                    } elseif ($t -eq "turn_failed") {
                        Write-Host "`n[turn_failed] $($ev.code): $($ev.message)" -ForegroundColor Red
                        $done = $true
                    } elseif ($t -eq "turn_aborted") {
                        Write-Host "`n[turn_aborted] $($ev.reason)" -ForegroundColor DarkYellow
                        $done = $true
                    } elseif ($t -ne "heartbeat" -and $t -ne "emotion_changed") {
                        Write-Host "[${t}]" -ForegroundColor DarkGray
                    }
                } catch { }
            }
            $buf = ""
        }
    }
} finally {
    $reader2.Close()
    $resp2.Close()
}

Write-Host "`n-- Done" -ForegroundColor Yellow
if ($fullText.Length -gt 0) {
    Write-Host "Response ($($fullText.Length) chars total)" -ForegroundColor Cyan
}
