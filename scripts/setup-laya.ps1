$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Creating Python virtual environment in .venv ..."
  py -m venv .venv
}

$Python = Join-Path $Root ".venv\Scripts\python.exe"
& $Python -m pip install --upgrade pip

# Laya is dramatically faster on an NVIDIA GPU. PyPI's default Windows torch wheel can be
# CPU-only, so install the official CUDA 13.0 build first when an NVIDIA driver is present.
# Set LAYA_SETUP_CPU=1 to deliberately keep a CPU-only environment.
$Nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($Nvidia -and $env:LAYA_SETUP_CPU -ne "1") {
  Write-Host "NVIDIA GPU detected; installing PyTorch CUDA 13.0 build ..."
  try {
    & $Python -m pip install --upgrade "torch==2.14.0+cu130" --index-url https://download.pytorch.org/whl/cu130
    if ($LASTEXITCODE -ne 0) { throw "CUDA PyTorch installer exited with $LASTEXITCODE" }
  } catch {
    Write-Warning "CUDA PyTorch install failed; falling back to the default CPU build. $_"
  }
} else {
  Write-Host "Using the default PyTorch build (CPU mode)."
}

& $Python -m pip install "laya[serve]"
& $Python -m pip install --upgrade "transformers>=5.0" huggingface_hub fastapi uvicorn safetensors
& $Python -I -c "import laya; print('Laya', laya.__version__)"
& $Python -I -c "import torch; print('PyTorch', torch.__version__, '| CUDA available:', torch.cuda.is_available())"

Write-Host "Laya browser runtime is installed. The first start downloads cklxx/laya-browser from Hugging Face."
