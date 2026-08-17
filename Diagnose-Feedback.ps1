<#
.SYNOPSIS
  Finds the mesh causing the WebGL "Feedback loop formed between Framebuffer
  and active Texture" error that is collapsing the work-spine scene.

.DESCRIPTION
  PowerShell cannot inspect a running page's WebGL state, so this drives a
  browser over the Chrome DevTools Protocol instead:

    1. launches Chrome (or Edge) with remote debugging on a throwaway profile
    2. loads the site and waits for it to finish building the scene
    3. scrolls to the depth where the warnings appear
    4. wraps the real GL draw calls and, whenever GL_INVALID_OPERATION fires,
       reads back the shader program that was bound and extracts its sampler
       uniform names plus the bound render target's size -- which names the
       offending material directly
    5. prints the report here and closes the browser it started

  Needs NO debug globals (window.__water / window.__scene) -- it works purely
  off the GL context, so it still runs if those were never assigned. It reads
  GL state only and mutates nothing; it runs in a throwaway browser profile,
  so your own browser, your profile and the project files are untouched.

.EXAMPLE
  .\Diagnose-Feedback.ps1
  .\Diagnose-Feedback.ps1 -Url http://localhost:5188 -Vh 880
#>
[CmdletBinding()]
param(
  [string]$Url  = 'http://localhost:5188',
  [int]   $Vh   = 880,     # scroll depth to test, in vh
  [int]   $Port = 9223,    # debug port (not 9222, to avoid a running browser)
  [int]   $LoadWaitSec = 20
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- browser
function Find-Browser {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "No Chrome or Edge found. Pass -BrowserPath or install one."
}

$exe = Find-Browser
Write-Host "browser : $exe" -ForegroundColor DarkGray
Write-Host "url     : $Url" -ForegroundColor DarkGray

$profileDir = Join-Path $env:TEMP ("wsfb-" + [guid]::NewGuid().ToString('N').Substring(0,8))
$browserArgs = @(
  "--remote-debugging-port=$Port"
  "--user-data-dir=`"$profileDir`""
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-extensions'
  '--new-window'
  $Url
)
$proc = Start-Process -FilePath $exe -ArgumentList $browserArgs -PassThru

# ---------------------------------------------------------------- CDP wiring
function Get-PageTarget {
  param([int]$Port, [int]$TimeoutSec = 25)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $list = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3
      $page = $list | Where-Object { $_.type -eq 'page' -and $_.url -like 'http*' } | Select-Object -First 1
      if ($page) { return $page }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  throw "Browser never exposed a debuggable page on port $Port."
}

$target = Get-PageTarget -Port $Port
Write-Host "target  : $($target.url)" -ForegroundColor DarkGray

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()

$script:cdpId = 0
function Send-Cdp {
  param([string]$Method, [hashtable]$Params = @{}, [int]$TimeoutSec = 180)
  $script:cdpId++
  $myId = $script:cdpId
  $msg  = @{ id = $myId; method = $Method; params = $Params } | ConvertTo-Json -Depth 12 -Compress
  $buf  = [Text.Encoding]::UTF8.GetBytes($msg)
  $seg  = New-Object ArraySegment[byte] -ArgumentList @(,$buf)
  $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true,
                [Threading.CancellationToken]::None).Wait()

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $sb  = New-Object Text.StringBuilder
    $rbuf = New-Object byte[] 65536
    do {
      $rseg = New-Object ArraySegment[byte] -ArgumentList @(,$rbuf)
      $task = $ws.ReceiveAsync($rseg, [Threading.CancellationToken]::None)
      if (-not $task.Wait([timespan]::FromSeconds($TimeoutSec))) { throw "CDP receive timed out." }
      $res  = $task.Result
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($rbuf, 0, $res.Count))
    } while (-not $res.EndOfMessage)

    $obj = $sb.ToString() | ConvertFrom-Json
    if ($obj.id -eq $myId) { return $obj }   # skip protocol events
  }
  throw "No CDP reply for $Method."
}

function Invoke-Js {
  param([string]$Expression, [switch]$Await, [int]$TimeoutSec = 180)
  $p = @{
    expression    = $Expression
    returnByValue = $true
    awaitPromise  = [bool]$Await
  }
  $r = Send-Cdp -Method 'Runtime.evaluate' -Params $p -TimeoutSec $TimeoutSec
  if ($r.result.exceptionDetails) {
    $t = $r.result.exceptionDetails.exception.description
    if (-not $t) { $t = $r.result.exceptionDetails.text }
    throw "JS error: $t"
  }
  return $r.result.result.value
}

[void](Send-Cdp -Method 'Runtime.enable')

# ---------------------------------------------------------------- wait for canvas
Write-Host "waiting for the scene to build..." -ForegroundColor DarkGray
$ready = $false
for ($i = 0; $i -lt ($LoadWaitSec * 2); $i++) {
  Start-Sleep -Milliseconds 500
  try {
    # only the canvas is required -- the GL-level probe needs no debug globals
    $ok = Invoke-Js -Expression "!!document.querySelector('#gl')"
    if ($ok) { $ready = $true; break }
  } catch { }
}
if (-not $ready) { Write-Warning "No #gl canvas appeared; continuing anyway." }
Start-Sleep -Seconds 6   # let async assets finish building

# ---------------------------------------------------------------- scroll
# Uses __lenis when present, and falls back to scrolling the real container,
# so this still works if the debug handles were never assigned.
$scrollJs = @"
new Promise(function(r){
  var y = $Vh * innerHeight / 100;
  if (window.__lenis && window.__lenis.scrollTo) { window.__lenis.scrollTo(y,{immediate:true}); }
  else {
    var el = document.querySelector('#scroll') || document.scrollingElement;
    if (el) { el.scrollTop = y; }
    window.scrollTo(0, y);
  }
  setTimeout(function(){
    var s = {};
    try { if (window.__dbg) { s = { front: window.__dbg().front, tris: window.__dbg().sceneTris }; } } catch(e) {}
    s.handles = { water: !!window.__water, scene: !!window.__scene, lenis: !!window.__lenis };
    r(JSON.stringify(s));
  }, 3000);
})
"@
$state = Invoke-Js -Expression $scrollJs -Await -TimeoutSec 60
Write-Host "at ${Vh}vh : $state" -ForegroundColor DarkGray

# ---------------------------------------------------------------- the bisector
# Returns a report STRING (rather than console.log) so it comes straight back
# through CDP into this terminal.
$bisector = @'
(function(){
  const L=[]; const log=(...a)=>L.push(a.join(' '));
  const c=document.querySelector('#gl');
  if(!c) return Promise.resolve('ERROR: no #gl canvas');
  const gl=c.getContext('webgl2')||c.getContext('webgl');
  if(!gl) return Promise.resolve('ERROR: no GL context');
  const INVALID=1282, hits=new Map(), wrap=[];

  /* Identify the offending draw WITHOUT needing any scene globals: read back
     the shader program that is bound when the error fires, pull its sampler
     uniform names out of the fragment source, and record which render target
     is bound (by viewport size). Distinctive names name the material:
       tMirrorReflection -> the water surface
       tRefraction       -> cards / emblem / columns / jelly
     Viewport 512x512 -> the planar mirror pass. */
  function grab(){
    let samplers=[], vp='?';
    try{
      const v=gl.getParameter(gl.VIEWPORT); vp=v[2]+'x'+v[3];
      const prog=gl.getParameter(gl.CURRENT_PROGRAM);
      if(prog){
        let frag='';
        for(const sh of (gl.getAttachedShaders(prog)||[])){
          const src=gl.getShaderSource(sh)||'';
          if(src.indexOf('gl_Position')<0) frag=src;   // the fragment stage
        }
        const m=frag.match(/uniform\s+sampler(?:2D|Cube)\s+(\w+)/g)||[];
        samplers=[...new Set(m.map(x=>x.split(/\s+/).pop()))];
      }
    }catch(e){}
    const fbBound = !!gl.getParameter(gl.FRAMEBUFFER_BINDING);
    return 'target='+vp+(fbBound?' (RT)':' (screen)')+'  samplers=['+samplers.join(',')+']';
  }

  for(const n of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){
    if(typeof gl[n]!=='function') continue;
    const o=gl[n].bind(gl);
    gl[n]=function(){ o.apply(null,arguments);
      if(gl.getError()===INVALID){ const k=grab(); hits.set(k,(hits.get(k)||0)+1); } };
    wrap.push([n,o]);
  }

  return new Promise(function(res){
    let f=0;
    const tick=function(){
      if(++f<45){ requestAnimationFrame(tick); return; }
      for(const [n,o] of wrap) gl[n]=o;
      log('=== FEEDBACK SOURCES (45 frames) ===');
      if(!hits.size){ log('none captured at this scroll position'); }
      const rows=[...hits.entries()].sort((a,b)=>b[1]-a[1]);
      for(const [k,v] of rows) log(String(v).padStart(6)+' x  '+k);
      log('');
      log('READING IT: the samplers list names the material that was drawing');
      log('while a render target was bound. tMirrorReflection = the water');
      log('surface; tRefraction = cards/emblem/columns/jelly. A 512x512');
      log('target means the planar mirror pass was the one bound.');
      res(L.join('\n'));
    };
    requestAnimationFrame(tick);
  });
})()
'@

Write-Host ""
Write-Host "running bisector (this takes 30-90s)..." -ForegroundColor Cyan
$report = Invoke-Js -Expression $bisector -Await -TimeoutSec 300

Write-Host ""
Write-Host "================ FEEDBACK REPORT ================" -ForegroundColor Green
Write-Host $report
Write-Host "=================================================" -ForegroundColor Green

$outFile = Join-Path $PSScriptRoot 'feedback-report.txt'
$report | Out-File -FilePath $outFile -Encoding utf8
Write-Host ""
Write-Host "saved to: $outFile" -ForegroundColor Yellow

# ---------------------------------------------------------------- cleanup
try { $ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure,'done',
      [Threading.CancellationToken]::None).Wait(3000) } catch { }
try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch { }
try { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
