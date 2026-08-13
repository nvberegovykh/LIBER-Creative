param(
  [Parameter(Mandatory=$true)][string]$WorkbookPath,
  [Parameter(Mandatory=$true)][string]$PdfPath
)

$ErrorActionPreference = 'Stop'
$excel = $null
$book = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $book = $excel.Workbooks.Open((Resolve-Path $WorkbookPath).Path, 0, $false)
  $excel.CalculateFullRebuild()
  $book.ExportAsFixedFormat(0, $PdfPath, 0, $true, $false)
  $book.Save()
}
finally {
  if ($book -ne $null) { $book.Close($false) }
  if ($excel -ne $null) { $excel.Quit() }
  if ($book -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($book) }
  if ($excel -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
