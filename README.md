# Advanced Model Manager for ComfyUI

Browse, search, and download models from HuggingFace and GitHub workflow JSONs — all from inside ComfyUI.

## Features

- **Browse** HuggingFace repos grouped by author with family badges
- **Search** across ALL repos and files with multi-word, case-insensitive matching
- **Download** models directly to the correct ComfyUI model folders
- **Workflows** — browse ComfyOrg and Kijai example workflows from GitHub
- **Downloaded tab** — see all local models with delete and open-folder support
- **Node widget** — shows model counts (Diffusion, Text Encoders, VAE, LoRAs) in the graph

## Installation

### Via ComfyUI Manager
Search for **Advanced Model Manager** in the ComfyUI Manager custom nodes list.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/BISAM20/ComfyUI-advanced-model-manager
cd ComfyUI-advanced-model-manager
pip install -r requirements.txt
```

## Usage

1. Add the **Advanced Model Manager** node to your graph, or click the button in the sidebar.
2. Use the search box to find models across all repos.
3. Click a file to download it — it goes straight to the right ComfyUI folder.

## Keyboard Shortcut

`Ctrl + Shift + M` — toggle the model manager panel.

## Requirements

- `huggingface_hub >= 0.20.0`
- `requests >= 2.28.0`
