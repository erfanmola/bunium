$p = 'C:\Users\Erfan Mola\Documents\bunium\vendor\cef-windows-x64\Resources\icudtl.dat'
Get-Item $p | Select-Object FullName, Length
try {
  $f = [System.IO.File]::OpenRead($p)
  Write-Host 'OPEN OK'
  $f.Dispose()
} catch {
  Write-Host ('OPEN FAIL: ' + $_.Exception.Message)
}