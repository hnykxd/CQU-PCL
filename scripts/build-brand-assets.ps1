param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBrand = Join-Path $taskRoot 'public/brand'
New-Item -ItemType Directory -Path $taskBrand -Force | Out-Null
Copy-Item -LiteralPath $Source -Destination (Join-Path $taskBrand 'naiwa-university.jpg') -Force
$taskImage = [System.Drawing.Image]::FromFile($Source)
function New-BrandBitmap([int]$Size) {
    $taskBitmap = New-Object System.Drawing.Bitmap($Size,$Size,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
    $taskGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $taskGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $taskGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $taskCircle = New-Object System.Drawing.Drawing2D.GraphicsPath
    $taskCircle.AddEllipse(0,0,$Size,$Size)
    $taskGraphics.SetClip($taskCircle)
    $taskGraphics.DrawImage($taskImage,0,0,$Size,$Size)
    $taskCircle.Dispose(); $taskGraphics.Dispose()
    return $taskBitmap
}
foreach ($taskSpec in @(@(512,'brand/logo.png'),@(256,'icon.png'),@(64,'favicon.png'))) {
    $taskBitmap = New-BrandBitmap $taskSpec[0]
    $taskBitmap.Save((Join-Path $taskRoot ('public/' + $taskSpec[1])),[System.Drawing.Imaging.ImageFormat]::Png)
    $taskBitmap.Dispose()
}
# Uncompressed BGRA icon frames work with both the Windows shell and WPF's decoder.
$taskFrames = @()
foreach ($taskSize in @(16,24,32,48,64,128,256)) {
    $taskBitmap = New-BrandBitmap $taskSize
    $taskBytes = New-Object System.IO.MemoryStream
    $taskWriter = New-Object System.IO.BinaryWriter($taskBytes)
    $taskMaskStride = [int]([Math]::Ceiling($taskSize / 32.0) * 4)
    $taskPixelsLength = $taskSize * $taskSize * 4
    $taskWriter.Write([int]40); $taskWriter.Write([int]$taskSize); $taskWriter.Write([int]($taskSize*2))
    $taskWriter.Write([int16]1); $taskWriter.Write([int16]32); $taskWriter.Write([int]0)
    $taskWriter.Write([int]($taskPixelsLength + $taskMaskStride*$taskSize))
    $taskWriter.Write([int]0); $taskWriter.Write([int]0); $taskWriter.Write([int]0); $taskWriter.Write([int]0)
    for ($taskY=$taskSize-1; $taskY -ge 0; $taskY--) {
        for ($taskX=0; $taskX -lt $taskSize; $taskX++) {
            $taskPixel = $taskBitmap.GetPixel($taskX,$taskY)
            $taskWriter.Write([byte]$taskPixel.B); $taskWriter.Write([byte]$taskPixel.G); $taskWriter.Write([byte]$taskPixel.R); $taskWriter.Write([byte]$taskPixel.A)
        }
    }
    $taskWriter.Write((New-Object byte[] ($taskMaskStride*$taskSize)))
    $taskWriter.Flush(); $taskFrames += ,@($taskSize,$taskBytes.ToArray())
    $taskWriter.Dispose(); $taskBytes.Dispose(); $taskBitmap.Dispose()
}
$taskOutput = [System.IO.File]::Create((Join-Path $taskRoot 'public/icon.ico'))
$taskWriter = New-Object System.IO.BinaryWriter($taskOutput)
$taskWriter.Write([int16]0); $taskWriter.Write([int16]1); $taskWriter.Write([int16]$taskFrames.Count)
$taskOffset = 6 + 16*$taskFrames.Count
foreach ($taskFrame in $taskFrames) {
    $taskDimension = if ($taskFrame[0] -eq 256) { 0 } else { $taskFrame[0] }
    $taskWriter.Write([byte]$taskDimension); $taskWriter.Write([byte]$taskDimension); $taskWriter.Write([byte]0); $taskWriter.Write([byte]0)
    $taskWriter.Write([int16]1); $taskWriter.Write([int16]32); $taskWriter.Write([int]$taskFrame[1].Length); $taskWriter.Write([int]$taskOffset)
    $taskOffset += $taskFrame[1].Length
}
foreach ($taskFrame in $taskFrames) { $taskWriter.Write([byte[]]$taskFrame[1]) }
$taskWriter.Dispose(); $taskOutput.Dispose(); $taskImage.Dispose()
Write-Output 'Generated university logo and 7 Windows icon sizes.'
