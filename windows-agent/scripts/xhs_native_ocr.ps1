param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$StorageFileType = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$StreamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$DecoderType = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$BitmapType = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$OcrType = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$ResultType = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$LanguageType = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$AwaitMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await([object]$Operation,[Type]$Type) {
    $Task = $AwaitMethod.MakeGenericMethod($Type).Invoke($null,@($Operation))
    if (-not $Task.Wait(12000)) { throw 'native_ocr_operation_timeout' }
    return $Task.GetAwaiter().GetResult()
}
$engine = $OcrType::TryCreateFromLanguage($LanguageType::new('zh-Hans-CN'))
if ($null -eq $engine) { throw 'native_chinese_ocr_unavailable' }
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($request.images).Count -lt 1 -or @($request.images).Count -gt 128) { throw 'native_ocr_batch_size_invalid' }
$output = @($request.images | ForEach-Object {
    $item = $_
    $file = Await ($StorageFileType::GetFileFromPathAsync($item.path)) $StorageFileType
    $stream = Await ($file.OpenReadAsync()) $StreamType
    try {
        $decoder = Await ($DecoderType::CreateAsync($stream)) $DecoderType
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) $BitmapType
        try {
            if ($bitmap.PixelWidth -gt $OcrType::MaxImageDimension -or $bitmap.PixelHeight -gt $OcrType::MaxImageDimension) { throw 'native_ocr_image_too_large' }
            $result = Await ($engine.RecognizeAsync($bitmap)) $ResultType
            $lines = @($result.Lines | ForEach-Object {
                $words = @($_.Words | ForEach-Object {
                    [ordered]@{ text=$_.Text; x=$_.BoundingRect.X; y=$_.BoundingRect.Y; width=$_.BoundingRect.Width; height=$_.BoundingRect.Height }
                })
                [ordered]@{ text=$_.Text; words=$words }
            })
            [ordered]@{ id=$item.id; width=$bitmap.PixelWidth; height=$bitmap.PixelHeight; language=$engine.RecognizerLanguage.LanguageTag; textAngle=$result.TextAngle; lines=$lines }
        } finally { if ($null -ne $bitmap) { $bitmap.Dispose() } }
    } finally { $stream.Dispose() }
})
[ordered]@{ protocol='windows_native_ocr_v1'; images=$output } | ConvertTo-Json -Depth 9 -Compress
