<#
.SYNOPSIS
  Screenshots the site at a list of scroll depths, over the DevTools Protocol.
  Used to see the crossing when the normal preview pane is unusable.
#>
[CmdletBinding()]
param(
  [string]$Url = 'http://localhost:5188',
  [int[]] $Vh  = @(860, 890, 900, 910, 940),
  [int]   $Port = 9224,
  [string]$OutDir = "$PSScriptRoot\frames",
  [int]   $Width = 1440,
  [int]   $Height = 900
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cands = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$exe = $null; foreach ($c in $cands) { if (Test-Path $c) { $exe = $c; break } }
if (-not $exe) { throw "No Chrome/Edge found." }

$prof = Join-Path $env:TEMP ("wscap-" + [guid]::NewGuid().ToString('N').Substring(0,8))
$proc = Start-Process $exe -PassThru -ArgumentList @(
  "--remote-debugging-port=$Port", "--user-data-dir=`"$prof`"",
  '--no-first-run','--no-default-browser-check','--disable-extensions',
  "--window-size=$Width,$Height", '--new-window', $Url)

function Get-Target {
  $dl=(Get-Date).AddSeconds(30)
  while((Get-Date) -lt $dl){
    try{ $l=Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 3
      $p=$l|Where-Object{$_.type -eq 'page' -and $_.url -like 'http*'}|Select-Object -First 1
      if($p){return $p} }catch{}
    Start-Sleep -Milliseconds 400
  }
  throw "no debuggable page"
}
$t = Get-Target
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]$t.webSocketDebuggerUrl,[Threading.CancellationToken]::None).Wait()

$script:id = 0
function Send-Cdp {
  param([string]$Method,[hashtable]$Params=@{},[int]$TimeoutSec=120)
  $script:id++; $mine=$script:id
  $json = @{id=$mine;method=$Method;params=$Params} | ConvertTo-Json -Depth 10 -Compress
  $b=[Text.Encoding]::UTF8.GetBytes($json)
  $ws.SendAsync((New-Object ArraySegment[byte] -ArgumentList @(,$b)),
    [Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).Wait()
  $dl=(Get-Date).AddSeconds($TimeoutSec)
  while((Get-Date) -lt $dl){
    $sb=New-Object Text.StringBuilder; $buf=New-Object byte[] 262144
    do{
      $task=$ws.ReceiveAsync((New-Object ArraySegment[byte] -ArgumentList @(,$buf)),
              [Threading.CancellationToken]::None)
      if(-not $task.Wait([timespan]::FromSeconds($TimeoutSec))){throw "recv timeout"}
      $r=$task.Result
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Count))
    } while(-not $r.EndOfMessage)
    $o=$sb.ToString()|ConvertFrom-Json
    if($o.id -eq $mine){return $o}
  }
  throw "no reply for $Method"
}
function Invoke-Js { param([string]$E,[switch]$Await,[int]$TimeoutSec=120)
  $r=Send-Cdp 'Runtime.evaluate' @{expression=$E;returnByValue=$true;awaitPromise=[bool]$Await} $TimeoutSec
  if($r.result.exceptionDetails){throw "JS: $($r.result.exceptionDetails.text)"}
  return $r.result.result.value }

[void](Send-Cdp 'Runtime.enable')
[void](Send-Cdp 'Page.enable')

Write-Host "waiting for scene..." -ForegroundColor DarkGray
for($i=0;$i -lt 60;$i++){
  Start-Sleep -Milliseconds 500
  try{ if(Invoke-Js "!!(document.querySelector('#gl') && window.__lenis)"){break} }catch{}
}
Start-Sleep -Seconds 10   # let flora / GLB / film finish

foreach($v in $Vh){
  $js = @"
new Promise(function(r){
  var y=$v*innerHeight/100;
  if(window.__lenis&&window.__lenis.scrollTo){window.__lenis.scrollTo(y,{immediate:true});}
  else{var e=document.querySelector('#scroll')||document.scrollingElement; if(e)e.scrollTop=y;}
  setTimeout(function(){
    var s={};
    try{ if(window.__dbg){var d=window.__dbg(); s={front:d.front,tris:d.sceneTris,fog:d.fogDensity};} }catch(e){}
    r(JSON.stringify(s));
  },3500);
})
"@
  $st = Invoke-Js $js -Await -TimeoutSec 60
  Write-Host ("{0,5}vh  {1}" -f $v, $st) -ForegroundColor Cyan
  $shot = Send-Cdp 'Page.captureScreenshot' @{format='png'} 60
  $bytes = [Convert]::FromBase64String($shot.result.data)
  $path = Join-Path $OutDir ("vh{0}.png" -f $v)
  [IO.File]::WriteAllBytes($path,$bytes)
}

Write-Host "frames written to $OutDir" -ForegroundColor Green
try{$ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure,'d',[Threading.CancellationToken]::None).Wait(3000)}catch{}
try{if($proc -and -not $proc.HasExited){$proc.Kill()}}catch{}
try{Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue}catch{}
