Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*prepare-vector*' } |
  ForEach-Object { $_.ProcessId }
