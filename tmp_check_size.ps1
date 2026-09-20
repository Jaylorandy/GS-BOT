Get-ChildItem 'e:\GS Bot-app\release' -File | ForEach-Object {
    $sizeMB = [math]::Round($_.Length/1MB, 1)
    Write-Output "$sizeMB MB  $($_.Name)"
} | Sort-Object -Descending
