$ErrorActionPreference = 'Stop'
$manifest = 'C:\Users\Admin\Documents\firefox_videoplaylist DeepSeek\native-host\videoqueue_host.json'
$regPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\videoqueue_host'
New-Item -Path $regPath -Force | Out-Null
New-ItemProperty -Path $regPath -Name '(default)' -Value $manifest -PropertyType String -Force | Out-Null
Write-Output "Зарегистрирован: $regPath -> $manifest"
Get-ItemProperty -Path $regPath | Select-Object '(default)'
