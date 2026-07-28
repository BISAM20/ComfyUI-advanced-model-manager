"""
Model Manager: HuggingFace + GitHub repo scanning, local model scanning,
file classification, downloading.
"""
import json
import os
import re
import threading
import time
import uuid
import requests
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

_REPO_CACHE_FILE = Path(__file__).parent / ".repo_cache.json"

try:
    from huggingface_hub import HfApi
    HF_AVAILABLE = True
except ImportError:
    HF_AVAILABLE = False

# ── Tracked sources ───────────────────────────────────────────────────────────

# Authors whose FULL repo list is fetched
TRACKED_AUTHORS = ["Comfy-Org", "Kijai", "city96"]

# Specific HuggingFace repos added regardless of author
TRACKED_SPECIFIC_REPOS = [
    "Lightricks/LTX-2.3",
    "Wan-AI/Wan2.1",
    # black-forest-labs repos
    "black-forest-labs/FLUX.1-dev",
    "black-forest-labs/FLUX.1-schnell",
    "black-forest-labs/FLUX.1-dev-FP8",
    "black-forest-labs/FLUX.1-dev-NVFP4",
    "black-forest-labs/FLUX.1-Kontext-dev",
    "black-forest-labs/FLUX.1-Kontext-dev-NVFP4",
    "black-forest-labs/FLUX.1-Kontext-dev-onnx",
    "black-forest-labs/FLUX.1-Krea-dev",
    "black-forest-labs/FLUX.1-Canny-dev",
    "black-forest-labs/FLUX.1-Canny-dev-lora",
    "black-forest-labs/FLUX.1-Canny-dev-onnx",
    "black-forest-labs/FLUX.1-Depth-dev",
    "black-forest-labs/FLUX.1-Depth-dev-lora",
    "black-forest-labs/FLUX.1-Depth-dev-onnx",
    "black-forest-labs/FLUX.1-Fill-dev",
    "black-forest-labs/FLUX.1-Redux-dev",
    "black-forest-labs/FLUX.1-schnell-onnx",
    "black-forest-labs/FLUX.1-dev-onnx",
    "black-forest-labs/FLUX.2-dev",
    "black-forest-labs/FLUX.2-dev-NVFP4",
    "black-forest-labs/FLUX.2-klein-4B",
    "black-forest-labs/FLUX.2-klein-9B",
    "black-forest-labs/FLUX.2-klein-base-4B",
    "black-forest-labs/FLUX.2-klein-base-9B",
    "black-forest-labs/FLUX.2-klein-4b-fp8",
    "black-forest-labs/FLUX.2-klein-9b-fp8",
    "black-forest-labs/FLUX.2-klein-base-4b-fp8",
    "black-forest-labs/FLUX.2-klein-base-9b-fp8",
    "black-forest-labs/FLUX.2-klein-4b-nvfp4",
    "black-forest-labs/FLUX.2-klein-9b-nvfp4",
    "black-forest-labs/FLUX.2-klein-base-4b-nvfp4",
    "black-forest-labs/FLUX.2-klein-base-9b-nvfp4",
    "black-forest-labs/FLUX.2-klein-9b-kv",
    "black-forest-labs/FLUX.2-klein-9b-kv-fp8",
    "stabilityai/stable-diffusion-3.5-large",
    "stabilityai/stable-diffusion-3.5-medium",
    "tencent/HunyuanVideo",
    "genmo/mochi-1-preview",
    "THUDM/CogVideoX-5b",
    "THUDM/CogVideoX-2b",
    "HiDream-ai/HiDream-I1-Full",
    "HiDream-ai/HiDream-I1-Dev",
    "HiDream-ai/HiDream-I1-Fast",
    # Kijai repos
    "Kijai/LTX2.3_comfy",
    "Kijai/WanVideo_comfy",
    "Kijai/WanVideo_comfy_fp8_scaled",
    "Kijai/WanVideo_comfy_GGUF",
    "Kijai/LTXV2_comfy",
    "Kijai/LTXV",
    "Kijai/Gemma3_comfy",
    "Kijai/LongCat-Video_comfy",
    "Kijai/Kandinsky5_comfy",
    "Kijai/Z-Image_comfy_fp8_scaled",
    "Kijai/QwenImage_experimental",
    "Kijai/vitpose_comfy",
    "Kijai/HunyuanVideo_comfy",
    "Kijai/SkyReels-V1-Hunyuan_comfy",
    "Kijai/CogVideoX-comfy",
    "Kijai/CogVideoX-5b-1.5",
    "Kijai/CogVideoX_GGUF",
    "Kijai/Mochi_preview_comfy",
    "Kijai/Cosmos1_ComfyUI",
    "Kijai/Hunyuan3D-2_safetensors",
    "Kijai/MMAudio_safetensors",
    "Kijai/flux-fp8",
    "Kijai/FLUX.1-dev-IP-Adapter-safetensors",
    "Kijai/sam2-safetensors",
    "Kijai/DepthAnythingV2-safetensors",
    "Kijai/MoGe_safetensors",
    "Kijai/LivePortrait_safetensors",
    "Kijai/wav2vec2_safetensors",
    "Kijai/MelBandRoFormer_comfy",
    "Kijai/Wan2.1-Fun-Reward-LoRAs-comfy",
    "Kijai/craftsman3d_safetensors",
    "Kijai/Leapfusion-image2vid-comfy",
    "Kijai/lotus-comfyui",
    "Kijai/SpatialTracer",
    "Kijai/Framer_comfy",
    "Kijai/pyramid-flow-comfy",
    "Kijai/GIMM-VFI_safetensors",
    "Kijai/OpenFLUX-comfy",
    "Kijai/LVCD-pruned",
    "Kijai/CogVideoX-Fun-pruned",
    "Kijai/VEnhancer-fp16",
    "Kijai/ControlNeXt-SVD-V2-Comfy",
    "Kijai/DynamiCrafter_pruned",
    "Kijai/MimicMotion_pruned",
    "Kijai/AnimateLCM-SVD-Comfy",
    "Kijai/ccsr-safetensors",
    "Kijai/SUPIR_pruned",
    "Kijai/BrushNet-fp16",
    "Kijai/FollowYourEmoji-safetensors",
    "Kijai/ChatGLM3-safetensors",
    "Kijai/llava-llama-3-8b-text-encoder-tokenizer",
    "Kijai/t5-large-encoder-only-bf16",
    "Kijai/CLIPVisionModelWithProjection_fp16",
    "Kijai/depth-fm-pruned",
    "Kijai/CogVideoX-VAE",
    "Kijai/CogVideoX-5b-Tora",
    "Kijai/CogVideoX-loras",
    "Kijai/kijai-flux-loras",
    "Kijai/spo-loras-comfyui",
    "Kijai/BasicPBC_safetensors",
    "Kijai/clipseg-rd64-refined-fp16",
    "Kijai/converted_pcm_loras_fp16",
    "Kijai/AnimationGPT_pruned",
    "Kijai/MagicTime-merged-fp16",
    "Kijai/flan-t5-xl-encoder-only-bf16",
    "Kijai/animatediff_motion_director_loras",
    # Comfy-Org repos
    "Comfy-Org/ltx-2",
    "Comfy-Org/Qwen3.5",
    "Comfy-Org/SDPose",
    "Comfy-Org/LongCat-Image",
    "Comfy-Org/HunyuanVideo_1.5_repackaged",
    "Comfy-Org/Qwen-Image-Edit_ComfyUI",
    "Comfy-Org/ace_step_1.5_ComfyUI_files",
    "Comfy-Org/Wan_2.1_ComfyUI_repackaged",
    "Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
    "Comfy-Org/z_image",
    "Comfy-Org/z_image_turbo",
    "Comfy-Org/vae-text-encorder-for-flux-klein-9b",
    "Comfy-Org/vae-text-encorder-for-flux-klein-4b",
    "Comfy-Org/flux1-dev",
    "Comfy-Org/flux2-dev",
    "Comfy-Org/flux1-schnell",
    "Comfy-Org/flux1-kontext-dev_ComfyUI",
    "Comfy-Org/FLUX.1-Krea-dev_ComfyUI",
    "Comfy-Org/Flux1-Redux-Dev",
    "Comfy-Org/Chroma1-HD_repackaged",
    "Comfy-Org/Chroma1-Radiance_Repackaged",
    "Comfy-Org/Qwen-Image_ComfyUI",
    "Comfy-Org/Qwen-Image-Layered_ComfyUI",
    "Comfy-Org/Qwen-Image-InstantX-ControlNets",
    "Comfy-Org/Qwen-Image-DiffSynth-ControlNets",
    "Comfy-Org/HunyuanVideo_repackaged",
    "Comfy-Org/HunyuanVideo_1.5_repackaged",
    "Comfy-Org/HunyuanImage_2.1_ComfyUI",
    "Comfy-Org/HiDream-I1_ComfyUI",
    "Comfy-Org/mochi_preview_repackaged",
    "Comfy-Org/ACE-Step_ComfyUI_repackaged",
    "Comfy-Org/stable-audio-open-1.0_repackaged",
    "Comfy-Org/Cosmos_Predict2_repackaged",
    "Comfy-Org/lotus",
    "Comfy-Org/Omnigen2_ComfyUI_repackaged",
    "Comfy-Org/Real-ESRGAN_repackaged",
    "Comfy-Org/hunyuan3D_2.0_repackaged",
    "Comfy-Org/hunyuan3D_2.1_repackaged",
    "Comfy-Org/HuMo_ComfyUI",
    "Comfy-Org/stable-diffusion-3.5-fp8",
    "Comfy-Org/stable-diffusion-3.5-controlnets_ComfyUI_repackaged",
    "Comfy-Org/stable_diffusion_2.1_repackaged",
    "Comfy-Org/stable_diffusion_2.1_unclip_repackaged",
    "Comfy-Org/stable-diffusion-v1-5-archive",
    "Comfy-Org/sigclip_vision_384",
    "Comfy-Org/CLIP-ViT-H-14-laion2B-s32B-b79K_repackaged",
    "Comfy-Org/T2I-Adapter_ComfyUI_Repackaged",
    "Comfy-Org/Lumina_Image_2.0_Repackaged",
    "Comfy-Org/USO_1.0_Repackaged",
    "Comfy-Org/OneReward_repackaged",
    "Comfy-Org/NewBie-image-Exp0.1_repackaged",
    "Comfy-Org/Ovis-Image",
]

# GitHub repos that provide ComfyUI workflow JSON files
TRACKED_GITHUB_WORKFLOW_REPOS = [
    {
        "id":     "comfyanonymous/ComfyUI",
        "branch": "master",
        "paths":  ["blueprints/"],
        "label":  "ComfyUI Blueprints",
        "group":  "comfyorg",
    },
    {
        "id":     "comfyanonymous/ComfyUI_examples",
        "branch": "master",
        "paths":  [""],
        "label":  "ComfyUI Examples",
        "group":  "comfyorg",
    },
    {
        "id":     "comfy-org/example_workflows",
        "branch": "main",
        "paths":  [""],
        "label":  "comfy-org Example Workflows",
        "group":  "comfyorg",
    },
    {
        "id":     "Kijai/ComfyUI-WanVideoWrapper",
        "branch": "main",
        "paths":  ["example_workflows/"],
        "label":  "WanVideoWrapper Example Workflows",
        "group":  "kijai",
    },
    {
        "id":     "Kijai/ComfyUI-HunyuanVideoWrapper",
        "branch": "main",
        "paths":  ["example_workflows/"],
        "label":  "HunyuanVideoWrapper Example Workflows",
        "group":  "kijai",
    },
    {
        "id":     "Kijai/ComfyUI-LTXVideo",
        "branch": "main",
        "paths":  ["example_workflows/"],
        "label":  "LTXVideo Example Workflows",
        "group":  "kijai",
    },
    {
        "id":     "Kijai/ComfyUI-CogVideoXWrapper",
        "branch": "main",
        "paths":  ["example_workflows/"],
        "label":  "CogVideoXWrapper Example Workflows",
        "group":  "kijai",
    },
    {
        "id":     "Kijai/ComfyUI-MochiWrapper",
        "branch": "main",
        "paths":  ["example_workflows/"],
        "label":  "MochiWrapper Example Workflows",
        "group":  "kijai",
    },
    {
        "id":     "Kijai/ComfyUI-FramePackWrapper",
        "branch": "main",
        "paths":  ["example_workflows/"],
        "label":  "FramePackWrapper Example Workflows",
        "group":  "kijai",
    },
    {
        "id":     "Kijai/ComfyUI-FluxTrainer",
        "branch": "main",
        "paths":  ["example_workflows/"],
        "label":  "FluxTrainer Example Workflows",
        "group":  "kijai",
    },
]

# Model families for the "By Model" view badge colours
MODEL_TAXONOMY = [
    {"name": "Flux",             "icon": "⚡", "keywords": ["flux"]},
    {"name": "WanVideo",         "icon": "🎬", "keywords": ["wan", "wanvideo", "wan2"]},
    {"name": "HunyuanVideo",     "icon": "🎬", "keywords": ["hunyuan"]},
    {"name": "LTX Video",        "icon": "🎞️", "keywords": ["ltx", "ltxv", "ltx2", "ltx-2"]},
    {"name": "Stable Diffusion 3","icon": "🎨", "keywords": ["sd3", "stable-diffusion-3"]},
    {"name": "CogVideo",         "icon": "📹", "keywords": ["cogvideo"]},
    {"name": "Mochi",            "icon": "🍡", "keywords": ["mochi"]},
    {"name": "HiDream",          "icon": "🌸", "keywords": ["hidream"]},
    {"name": "AceStep",          "icon": "🎵", "keywords": ["ace_step", "acestep"]},
    {"name": "Omnigen",          "icon": "🌐", "keywords": ["omnigen"]},
    {"name": "Qwen",             "icon": "🤖", "keywords": ["qwen"]},
    {"name": "Real-ESRGAN",      "icon": "🔍", "keywords": ["esrgan", "real-esrgan", "realesrgan"]},
    {"name": "SDXL",             "icon": "🎨", "keywords": ["sdxl", "stable-diffusion-xl"]},
    {"name": "SD 1.5",           "icon": "🎨", "keywords": ["stable-diffusion-v1", "sd-v1"]},
    {"name": "Cosmos",           "icon": "🌌", "keywords": ["cosmos"]},
    {"name": "FramePack",        "icon": "🎞️", "keywords": ["framepack"]},
    {"name": "Chroma",           "icon": "🎨", "keywords": ["chroma"]},
    {"name": "PixArt",           "icon": "🖼️", "keywords": ["pixart"]},
]

def repo_taxonomy(repo_id: str) -> str:
    lower = repo_id.lower()
    for cat in MODEL_TAXONOMY:
        if any(kw in lower for kw in cat["keywords"]):
            return cat["name"]
    return ""


# ── File classification ────────────────────────────────────────────────────────

MODEL_EXTENSIONS    = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".ggml"}
WORKFLOW_EXTENSIONS = {".json"}

FOLDER_MAP = [
    ("diffusion_models", "diffusion_models"),
    ("diffusion_model",  "diffusion_models"),
    ("transformer",      "diffusion_models"),
    ("text_encoders",    "text_encoders"),
    ("text_encoder",     "text_encoders"),
    ("clip_vision",      "clip_vision"),
    ("clip",             "text_encoders"),
    ("vae",              "vae"),
    ("loras",            "loras"),
    ("lora",             "loras"),
    ("controlnet",       "controlnet"),
    ("control_net",      "controlnet"),
    ("upscale_models",   "upscale_models"),
    ("upscale",          "upscale_models"),
    ("checkpoints",      "checkpoints"),
    ("ipadapter",        "ipadapter"),
    ("audio_encoders",   "audio_encoders"),
]

FILENAME_MAP = [
    ("lora",             "loras"),
    ("adapter",          "loras"),
    ("_vae",             "vae"),
    ("-vae",             "vae"),
    ("vae_",             "vae"),
    ("vae-",             "vae"),
    ("_ae.",             "vae"),
    ("-ae.",             "vae"),
    ("text_encoder",     "text_encoders"),
    ("clip_l",           "text_encoders"),
    ("clip_g",           "text_encoders"),
    ("t5xxl",            "text_encoders"),
    ("t5_xxl",           "text_encoders"),
    ("t5-xxl",           "text_encoders"),
    ("umt5",             "text_encoders"),
    ("t5_",              "text_encoders"),
    ("gemma",            "text_encoders"),
    ("paligemma",        "text_encoders"),
    ("llava_llama",      "text_encoders"),
    ("llava-llama",      "text_encoders"),
    ("chatglm",          "text_encoders"),
    ("qwen_vl",          "text_encoders"),
    ("mt5",              "text_encoders"),
    ("controlnet",       "controlnet"),
    ("control_net",      "controlnet"),
    ("esrgan",           "upscale_models"),
    ("swinir",           "upscale_models"),
    ("realesr",          "upscale_models"),
    ("upscale",          "upscale_models"),
    ("unet",             "diffusion_models"),
    ("diffusion_model",  "diffusion_models"),
    ("dit",              "diffusion_models"),
]

README_SECTION_RE = [
    (re.compile(r'text.?encoder|clip|t5|llm', re.I), "text_encoders"),
    (re.compile(r'\bvae\b',                   re.I), "vae"),
    (re.compile(r'lora',                      re.I), "loras"),
    (re.compile(r'controlnet|control.net',    re.I), "controlnet"),
    (re.compile(r'upscale|super.resol',       re.I), "upscale_models"),
    (re.compile(r'checkpoint',                re.I), "checkpoints"),
    (re.compile(r'diffusion.model|transformer|unet', re.I), "diffusion_models"),
]

_readme_cache: dict[str, dict] = {}

# Global file search index: {repo_id: [file_dict, ...]}
_file_index: dict[str, list] = {}
_file_index_lock = threading.Lock()

# Background index build status
_index_status: dict = {"total": 0, "done": 0, "running": False, "error": None}


def _normalize(text: str) -> str:
    """Lowercase and replace all non-alphanumeric chars with space for fuzzy matching."""
    return re.sub(r'[^a-z0-9]', ' ', text.lower())


def build_full_index() -> None:
    """Load file lists for ALL tracked repos into _file_index (runs in a thread)."""
    global _index_status
    if _index_status.get("running"):
        return
    _index_status = {"total": 0, "done": 0, "running": True, "error": None}
    try:
        all_repos = list_all_repos()
        _index_status["total"] = len(all_repos)
        for repo in all_repos:
            try:
                list_repo_files(repo["id"])   # populates _file_index as a side-effect
            except Exception:
                pass
            _index_status["done"] += 1
            time.sleep(1.5)   # ~2 HF API calls per repo; stay well under 500 req/300s limit
    except Exception as e:
        _index_status["error"] = str(e)
    finally:
        _index_status["running"] = False


def get_index_status() -> dict:
    return dict(_index_status)


def classify_file(filepath: str, repo_id: str,
                  readme_hints: Optional[dict] = None) -> tuple[Optional[str], str]:
    parts        = filepath.replace("\\", "/").split("/")
    filename     = parts[-1]
    relevant     = [p for p in parts[:-1] if p not in ("split_files", "")]
    folder_str   = "/".join(relevant).lower()
    lower_name   = filename.lower()

    if any(x in lower_name for x in ("incl_clips", "incl_t5", "_checkpoint", "all_in_one")):
        return "checkpoints", filename
    if readme_hints and filename in readme_hints:
        return readme_hints[filename], filename
    for keyword, dest in FOLDER_MAP:
        if keyword in folder_str:
            return dest, filename
    for keyword, dest in FILENAME_MAP:
        if keyword in lower_name:
            return dest, filename
    if Path(filename).suffix.lower() in MODEL_EXTENSIONS:
        return "diffusion_models", filename
    return None, filename


def is_workflow_file(filepath: str) -> bool:
    if not filepath.endswith(".json"):
        return False
    lower = filepath.lower()
    excluded = ("config", "index", "tokenizer", "scheduler", "model_index",
                "special_tokens", "added_tokens", "vocab", "clip_config",
                "clip_vision", "sd1_", "sd2_", "t5_config", "umt5_config")
    return not any(ex in lower for ex in excluded)


# ── README parsing ────────────────────────────────────────────────────────────

def fetch_readme_hints(repo_id: str) -> dict[str, str]:
    if repo_id in _readme_cache:
        return _readme_cache[repo_id]
    result: dict[str, str] = {}
    url = f"https://huggingface.co/{repo_id}/resolve/main/README.md"
    try:
        resp = requests.get(url, headers=_hf_headers(), timeout=10)
        if resp.status_code != 200:
            _readme_cache[repo_id] = result
            return result
        text = resp.text
    except Exception:
        _readme_cache[repo_id] = result
        return result

    file_pat = re.compile(
        r'(?:^|[\s`\'"|(\[])([^\s`\'"|)\]]+\.(?:safetensors|ckpt|pt|pth|bin|gguf|ggml))'
        r'(?:$|[\s`\'"|)\]])', re.I
    )
    current_cat: Optional[str] = None
    for line in text.split("\n"):
        hm = re.match(r"^#{1,4}\s+(.+)", line)
        if hm:
            current_cat = None
            for pat, cat in README_SECTION_RE:
                if pat.search(hm.group(1)):
                    current_cat = cat
                    break
            continue
        for fm in file_pat.finditer(line):
            fname = Path(fm.group(1)).name
            if current_cat:
                result[fname] = current_cat
            else:
                for pat, cat in README_SECTION_RE:
                    if pat.search(line):
                        result[fname] = cat
                        break

    _readme_cache[repo_id] = result
    return result


# ── HuggingFace helpers ───────────────────────────────────────────────────────

def _hf_token() -> Optional[str]:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")


def _hf_headers() -> dict:
    token = _hf_token()
    return {"Authorization": f"Bearer {token}"} if token else {}


def url_headers(url: str) -> dict:
    """Auth headers appropriate for the host the URL points at.

    Chosen by hostname so the HuggingFace token is only ever sent to
    HuggingFace, never to whatever host a pasted link happens to name.
    """
    host = (urlparse(url).netloc or "").lower()
    if host.endswith("huggingface.co") or host.endswith("hf.co"):
        return _hf_headers()
    return {}


def list_author_repos(author: str) -> list[dict]:
    if not HF_AVAILABLE:
        return []
    api = HfApi()
    try:
        models = list(api.list_models(author=author, sort="lastModified",
                                      direction=-1, limit=100))
        return [
            {
                "id":           m.id,
                "name":         m.id.split("/", 1)[-1],
                "author":       author,
                "lastModified": str(getattr(m, "last_modified", "") or ""),
                "model_family": repo_taxonomy(m.id),
                "specific":     False,
            }
            for m in models
        ]
    except Exception as e:
        print(f"[ModelDownloader] Error listing repos for {author}: {e}")
        return []


def get_specific_repo_info(repo_id: str) -> dict:
    author, name = repo_id.split("/", 1)
    # Try to get real lastModified
    last_mod = ""
    if HF_AVAILABLE:
        try:
            info = HfApi().repo_info(repo_id)
            last_mod = str(getattr(info, "last_modified", "") or "")
        except Exception:
            pass
    return {
        "id":           repo_id,
        "name":         name,
        "author":       author,
        "lastModified": last_mod,
        "model_family": repo_taxonomy(repo_id),
        "specific":     True,
    }


def list_all_repos(force: bool = False) -> list[dict]:
    # Return cached result unless a forced refresh is requested
    if not force and _REPO_CACHE_FILE.exists():
        try:
            return json.loads(_REPO_CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass

    all_repos: list[dict] = []
    seen: set[str] = set()
    for author in TRACKED_AUTHORS:
        for r in list_author_repos(author):
            if r["id"] not in seen:
                all_repos.append(r)
                seen.add(r["id"])
    for repo_id in TRACKED_SPECIFIC_REPOS:
        if repo_id not in seen:
            all_repos.append(get_specific_repo_info(repo_id))
            seen.add(repo_id)
    # Sort by lastModified descending (blank strings sort last)
    all_repos.sort(key=lambda r: r.get("lastModified") or "", reverse=True)

    # Persist to disk cache
    try:
        _REPO_CACHE_FILE.write_text(json.dumps(all_repos, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

    return all_repos


def list_repo_files(repo_id: str, include_workflows: bool = False) -> list[dict]:
    if not HF_AVAILABLE:
        return []
    api = HfApi()
    try:
        all_files = list(api.list_repo_files(repo_id))
    except Exception as e:
        err_str = str(e)
        if "429" in err_str:
            # Extract retry-after seconds if present, default to 60
            import re as _re
            m = _re.search(r"Retry after (\d+) seconds", err_str)
            wait = int(m.group(1)) if m else 60
            print(f"[ModelDownloader] Rate limited on {repo_id}, retrying after {wait}s…")
            time.sleep(wait)
            try:
                all_files = list(api.list_repo_files(repo_id))
            except Exception as e2:
                print(f"[ModelDownloader] Error listing files for {repo_id} after retry: {e2}")
                return []
        else:
            print(f"[ModelDownloader] Error listing files for {repo_id}: {e}")
            return []

    readme_hints = fetch_readme_hints(repo_id)
    result = []
    for filepath in all_files:
        ext = Path(filepath).suffix.lower()
        if ext in MODEL_EXTENSIONS:
            folder, fname = classify_file(filepath, repo_id, readme_hints)
            if folder is None:
                folder = "checkpoints"
            entry = {
                "path": filepath, "filename": fname,
                "local_folder": folder, "repo_id": repo_id,
                "size": None, "category": folder, "file_type": "model",
            }
            result.append(entry)
        elif include_workflows and is_workflow_file(filepath):
            result.append({
                "path": filepath, "filename": Path(filepath).name,
                "local_folder": "workflows", "repo_id": repo_id,
                "size": None, "category": "workflows", "file_type": "workflow",
            })

    # Cache in file index
    with _file_index_lock:
        _file_index[repo_id] = result

    return result


def get_repo_file_sizes(repo_id: str) -> dict[str, int]:
    if not HF_AVAILABLE:
        return {}
    api = HfApi()
    try:
        info = api.repo_info(repo_id, files_metadata=True)
        return {
            s.rfilename: s.size
            for s in (info.siblings or [])
            if getattr(s, "size", None) is not None
        }
    except Exception as e:
        print(f"[ModelDownloader] Error getting file sizes for {repo_id}: {e}")
        return {}


def search_files_across_repos(query: str) -> list[dict]:
    """
    Search filename/path across all repos.
    Repos not yet loaded are loaded on demand (expensive first call, cached after).
    Returns list of file dicts with repo context.
    """
    # Split query into words; normalize so commas/underscores/dots don't matter
    words = [w for w in _normalize(query).split() if w]
    if not words:
        return []

    def matches(f: dict) -> bool:
        raw  = (f["filename"] + " " + f["path"]).lower()
        norm = _normalize(raw)
        return all(w in norm or w in raw for w in words)

    results = []

    # Search already-cached repos first
    with _file_index_lock:
        cached_ids = set(_file_index.keys())

    for rid, files in list(_file_index.items()):
        for f in files:
            if matches(f):
                results.append(dict(f))

    # Load remaining uncached repos — all of them if index wasn't pre-built
    all_repos = list_all_repos()
    uncached  = [r["id"] for r in all_repos if r["id"] not in cached_ids]
    for repo_id in uncached:
        try:
            files = list_repo_files(repo_id)
            for f in files:
                if matches(f):
                    results.append(dict(f))
        except Exception:
            pass

    return results


# ── GitHub workflow helpers ───────────────────────────────────────────────────

_gh_headers = {"User-Agent": "ComfyUI-ModelDownloader/1.0"}
_github_cache: dict[str, list] = {}


def list_github_workflows(repo_id: str, branch: str, paths: list[str],
                          label: str) -> list[dict]:
    cache_key = f"{repo_id}@{branch}"
    if cache_key in _github_cache:
        return _github_cache[cache_key]

    result = []
    try:
        url  = f"https://api.github.com/repos/{repo_id}/git/trees/{branch}?recursive=1"
        resp = requests.get(url, headers=_gh_headers, timeout=15)
        resp.raise_for_status()
        tree = resp.json().get("tree", [])

        excluded = ("config", "index", "tokenizer", "scheduler", "vocab",
                    "special_tokens", "added_tokens", "clip_config", "clip_vision",
                    "sd1_", "sd2_", "t5_config", "comfy/")

        for item in tree:
            fp = item.get("path", "")
            if not fp.endswith(".json"):
                continue
            if any(ex in fp.lower() for ex in excluded):
                continue
            # Check if under one of the requested paths
            under = any(fp.startswith(p) for p in paths) if any(paths) else True
            if not under:
                continue

            result.append({
                "path":         fp,
                "filename":     Path(fp).name,
                "local_folder": "workflows",
                "repo_id":      f"github:{repo_id}",
                "size":         item.get("size"),
                "category":     "workflows",
                "file_type":    "workflow",
                "github_raw":   f"https://raw.githubusercontent.com/{repo_id}/{branch}/{fp}",
                "label":        label,
            })
    except Exception as e:
        print(f"[ModelDownloader] GitHub error for {repo_id}: {e}")

    _github_cache[cache_key] = result
    return result


def get_all_github_workflows(group: str = "") -> list[dict]:
    result = []
    for cfg in TRACKED_GITHUB_WORKFLOW_REPOS:
        if group and cfg.get("group", "") != group:
            continue
        result.extend(list_github_workflows(
            cfg["id"], cfg["branch"], cfg["paths"], cfg["label"]
        ))
    return result


def search_hf(query: str, limit: int = 30) -> list[dict]:
    """Search HuggingFace models by query string."""
    try:
        url  = f"https://huggingface.co/api/models?search={query}&sort=lastModified&direction=-1&limit={limit}"
        resp = requests.get(url, headers=_hf_headers(), timeout=10)
        resp.raise_for_status()
        models = resp.json()
        return [
            {
                "id":           m.get("modelId", m.get("id", "")),
                "name":         m.get("modelId", m.get("id", "")).split("/")[-1],
                "author":       m.get("modelId", "").split("/")[0],
                "lastModified": m.get("lastModified", ""),
                "model_family": repo_taxonomy(m.get("modelId", "")),
                "specific":     True,
                "hf_search":    True,
            }
            for m in models
            if m.get("modelId") or m.get("id")
        ]
    except Exception as e:
        print(f"[ModelDownloader] HF search error: {e}")
        return []


# ── Local model scanning ──────────────────────────────────────────────────────

def get_models_dir() -> Path:
    try:
        import sys
        comfyui_root = Path(__file__).parent.parent.parent
        sys.path.insert(0, str(comfyui_root))
        import folder_paths
        return Path(folder_paths.models_dir)
    except Exception:
        return Path(__file__).parent.parent.parent / "models"


def get_folder_paths_for(folder_name: str) -> list[Path]:
    """Return all configured paths for a ComfyUI folder type.

    Checks folder_paths.get_folder_paths() first (which includes any paths
    defined in extra_model_paths.yaml), then falls back to the default
    models_dir / folder_name.
    """
    try:
        import folder_paths
        paths = folder_paths.get_folder_paths(folder_name)
        if paths:
            return [Path(p) for p in paths]
    except Exception:
        pass
    return [get_models_dir() / folder_name]


def get_workflows_dir() -> Path:
    root = Path(__file__).parent.parent.parent
    for c in [root / "user" / "default" / "workflows", root / "workflows"]:
        if c.exists():
            return c
    cand = root / "user" / "default" / "workflows"
    cand.mkdir(parents=True, exist_ok=True)
    return cand


def scan_local_models() -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}

    # Collect all known folder names: registered ComfyUI types + subfolders of models_dir
    folder_names: set[str] = set()
    try:
        import folder_paths
        folder_names.update(folder_paths.folder_names_and_paths.keys())
    except Exception:
        pass
    models_dir = get_models_dir()
    if models_dir.exists():
        for d in models_dir.iterdir():
            if d.is_dir():
                folder_names.add(d.name)

    for folder_name in folder_names:
        files: list[str] = []
        for path in get_folder_paths_for(folder_name):
            if path.exists():
                files.extend(
                    f.name for f in path.rglob("*")
                    if f.is_file() and f.suffix.lower() in MODEL_EXTENSIONS
                )
        if files:
            result[folder_name] = files

    wf_dir = get_workflows_dir()
    if wf_dir.exists():
        wf_files = [f.name for f in wf_dir.iterdir()
                    if f.is_file() and f.suffix.lower() == ".json"]
        if wf_files:
            result["workflows"] = wf_files
    return result


def get_local_model_size(folder: str, filename: str) -> int | None:
    """Return file size in bytes, or None if not found."""
    try:
        if folder == "workflows":
            p = get_workflows_dir() / filename
            return p.stat().st_size if p.exists() else None
        for path in get_folder_paths_for(folder):
            p = path / filename
            if p.exists():
                return p.stat().st_size
        return None
    except Exception:
        return None


# Folder types that are not model stores, so never a move destination
NON_MODEL_FOLDERS = {"custom_nodes", "configs", "workflows"}

# When several folder types alias the same directory, prefer these names —
# they are what the rest of the UI calls those destinations.
CANONICAL_FOLDERS = [
    "diffusion_models", "checkpoints", "text_encoders", "clip_vision", "vae",
    "loras", "controlnet", "upscale_models", "embeddings", "hypernetworks",
    "style_models", "ipadapter", "audio_encoders", "photomaker", "gligen",
    "diffusers", "model_patches", "vae_approx", "classifiers",
]


def _preferred_alias(aliases: list[str], path: Path) -> str:
    """Pick one display name for a directory several folder types point at."""
    for canonical in CANONICAL_FOLDERS:
        if canonical in aliases:
            return canonical
    if path.name in aliases:
        return path.name
    return sorted(aliases, key=lambda a: (len(a), a))[0]


def list_model_folder_targets() -> list[dict]:
    """Folder types a model file can be moved into.

    Limited to directories inside the ComfyUI models folder, plus anything on
    a separate drive configured through extra_model_paths.yaml. This keeps out
    non-model locations such as custom_nodes/, per-node asset directories and
    user/default/workflows/. Folder types that alias the same directory (e.g.
    diffusion_models / unet / unet_gguf) collapse into a single entry, so the
    same destination is never offered more than once.
    """
    models_dir = get_models_dir()
    try:
        models_root = models_dir.resolve()
        base_dir    = models_root.parent
    except Exception:
        return []

    names: set[str] = set()
    try:
        import folder_paths
        names.update(folder_paths.folder_names_and_paths.keys())
    except Exception:
        pass
    if models_dir.exists():
        names.update(d.name for d in models_dir.iterdir() if d.is_dir())
    names -= NON_MODEL_FOLDERS

    by_path: dict[Path, list[str]] = {}
    for name in names:
        try:
            resolved = get_folder_bases(name)[0].resolve()
        except Exception:
            continue
        inside_models = resolved.is_relative_to(models_root)
        # A path outside the ComfyUI install is an extra_model_paths drive;
        # one inside the install but outside models/ is not a model store.
        external = not resolved.is_relative_to(base_dir)
        if inside_models or external:
            by_path.setdefault(resolved, []).append(name)

    targets = [
        {"folder": _preferred_alias(aliases, path),
         "path":   str(path),
         "aliases": sorted(aliases)}
        for path, aliases in by_path.items()
    ]
    targets.sort(key=lambda t: t["folder"].lower())
    return targets


def _is_within(candidate: Path, base: Path) -> bool:
    """True if candidate sits inside base (no string-prefix false positives)."""
    try:
        return candidate.resolve().is_relative_to(base.resolve())
    except Exception:
        return False


def get_folder_bases(folder: str) -> list[Path]:
    """Every directory a given ComfyUI folder type can live in."""
    if folder == "workflows":
        return [get_workflows_dir()]
    return get_folder_paths_for(folder)


def locate_local_file(folder: str, filename: str) -> Optional[Path]:
    """Find an existing file in one of `folder`'s configured paths.

    `filename` must be a bare name — anything with path separators is rejected
    rather than resolved, so a crafted name cannot escape the model folders.

    scan_local_models() lists nested files (models/loras/flux/x.safetensors)
    by their bare name, so a top-level miss falls back to a recursive walk;
    otherwise files shown in the UI would not be actionable. The walk compares
    names exactly rather than globbing, because model filenames routinely
    contain glob metacharacters — names like
    "Abstract Painting - Style [LoRA].safetensors" are common.
    """
    name = Path(filename).name
    if not name or name != filename:
        return None

    bases = get_folder_bases(folder)
    for base in bases:
        candidate = base / name
        if candidate.is_file() and _is_within(candidate, base):
            return candidate

    for base in bases:
        if not base.is_dir():
            continue
        for dirpath, _dirs, files in os.walk(base):
            if name in files:
                candidate = Path(dirpath) / name
                if candidate.is_file() and _is_within(candidate, base):
                    return candidate
    return None


def delete_local_model(folder: str, filename: str) -> bool:
    """Delete a local model file. Returns True on success."""
    try:
        target = locate_local_file(folder, filename)
        if target is None:
            return False
        target.unlink()
        return True
    except Exception as e:
        print(f"[ModelDownloader] Delete error: {e}")
        return False


def get_download_url(repo_id: str, filepath: str, revision: str = "main") -> str:
    return f"https://huggingface.co/{repo_id}/resolve/{revision}/{filepath}"


# ── Moving files between model folders ────────────────────────────────────────

_moves: dict = {}
_moves_lock = threading.Lock()

_MOVE_CHUNK = 8 * 1024 * 1024


def get_moves() -> dict:
    with _moves_lock:
        return dict(_moves)


def get_move(task_id: str) -> Optional[dict]:
    with _moves_lock:
        return _moves.get(task_id)


def cancel_move(task_id: str) -> bool:
    """Cancel an in-progress cross-filesystem copy. A same-disk move is atomic
    and finishes before this can take effect."""
    with _moves_lock:
        if task_id in _moves and _moves[task_id]["status"] in ("queued", "moving"):
            _moves[task_id]["status"] = "cancelled"
            return True
    return False


def plan_move(from_folder: str, filename: str, to_folder: str) -> dict:
    """Validate a move and return {src, dest}. Raises ValueError if not possible."""
    if not to_folder:
        raise ValueError("No destination folder given.")
    if from_folder == to_folder:
        raise ValueError(f"'{filename}' is already in {to_folder}.")

    src = locate_local_file(from_folder, filename)
    if src is None:
        raise ValueError(f"'{filename}' was not found in {from_folder}.")

    dest_dir = get_folder_bases(to_folder)[0]
    dest     = dest_dir / src.name
    if not _is_within(dest_dir / src.name, dest_dir):
        raise ValueError("Invalid destination.")
    if dest.exists():
        raise ValueError(f"'{src.name}' already exists in {to_folder}.")
    if src.resolve() == dest.resolve():
        raise ValueError(f"'{src.name}' is already in that location.")
    return {"src": src, "dest": dest, "dest_dir": dest_dir}


def start_move(from_folder: str, filename: str, to_folder: str) -> str:
    """Begin moving a local file to another model folder. Returns a task id.

    Raises ValueError for problems the user can act on (missing source, name
    collision), so those surface immediately instead of as a failed task.
    """
    plan    = plan_move(from_folder, filename, to_folder)
    task_id = str(uuid.uuid4())
    state = {
        "task_id": task_id, "filename": plan["src"].name,
        "from_folder": from_folder, "to_folder": to_folder,
        "src": str(plan["src"]), "dest": str(plan["dest"]),
        "status": "queued", "progress": 0.0,
        "moved_bytes": 0, "total_bytes": plan["src"].stat().st_size,
        "error": None,
    }
    with _moves_lock:
        _moves[task_id] = state

    threading.Thread(target=_move_worker, args=(task_id,), daemon=True).start()
    return task_id


def _move_worker(task_id: str):
    import errno
    import shutil

    with _moves_lock:
        state = _moves.get(task_id)
    if not state:
        return

    src  = Path(state["src"])
    dest = Path(state["dest"])
    tmp  = Path(str(dest) + ".part")

    def upd(**kw):
        with _moves_lock:
            if task_id in _moves:
                _moves[task_id].update(kw)

    def cancelled() -> bool:
        with _moves_lock:
            return _moves.get(task_id, {}).get("status") == "cancelled"

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        upd(status="moving")

        # Same filesystem — instant, and the file is never duplicated on disk.
        try:
            os.replace(src, dest)
            upd(status="done", progress=100.0, moved_bytes=state["total_bytes"])
            return
        except OSError as e:
            if e.errno != errno.EXDEV:
                raise

        # Different filesystem (e.g. an extra_model_paths.yaml drive): copy in
        # chunks to a .part file so an interruption never leaves a truncated
        # model sitting where ComfyUI would try to load it.
        total  = state["total_bytes"]
        copied = 0
        with open(src, "rb") as fi, open(tmp, "wb") as fo:
            while True:
                chunk = fi.read(_MOVE_CHUNK)
                if not chunk:
                    break
                if cancelled():
                    fo.close()
                    tmp.unlink(missing_ok=True)
                    return
                fo.write(chunk)
                copied += len(chunk)
                upd(moved_bytes=copied,
                    progress=min(copied / total * 100, 100) if total else 0)

        shutil.copystat(src, tmp)
        tmp.rename(dest)
        src.unlink()                      # only remove the source once the copy landed
        upd(status="done", progress=100.0)

    except Exception as e:
        tmp.unlink(missing_ok=True)
        upd(status="error", error=str(e))
        print(f"[ModelDownloader] Move error for {task_id}: {e}")


# ── Download state ────────────────────────────────────────────────────────────

_downloads: dict = {}
_downloads_lock  = threading.Lock()


def get_downloads() -> dict:
    with _downloads_lock:
        return dict(_downloads)


def get_download(task_id: str) -> Optional[dict]:
    with _downloads_lock:
        return _downloads.get(task_id)


def start_download(repo_id: str, filepath: str,
                   local_folder: str, filename: str,
                   direct_url: Optional[str] = None) -> str:
    task_id = str(uuid.uuid4())

    dest_dir = get_workflows_dir() if local_folder == "workflows" else \
               get_folder_paths_for(local_folder)[0]
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / filename

    url = direct_url or get_download_url(repo_id.replace("github:", ""), filepath)

    state = {
        "task_id": task_id, "repo_id": repo_id,
        "filepath": filepath, "filename": filename,
        "local_folder": local_folder, "dest": str(dest_path),
        "url": url, "status": "queued",
        "progress": 0.0, "downloaded_bytes": 0, "total_bytes": 0, "error": None,
    }
    with _downloads_lock:
        _downloads[task_id] = state

    threading.Thread(target=_download_worker, args=(task_id,), daemon=True).start()
    return task_id


def cancel_download(task_id: str) -> bool:
    with _downloads_lock:
        if task_id in _downloads:
            _downloads[task_id]["status"] = "cancelled"
            return True
    return False


def _download_worker(task_id: str):
    with _downloads_lock:
        state = _downloads.get(task_id)
    if not state:
        return

    url   = state["url"]
    dest  = Path(state["dest"])
    tmp   = Path(str(dest) + ".part")

    def upd(**kw):
        with _downloads_lock:
            if task_id in _downloads:
                _downloads[task_id].update(kw)

    try:
        headers    = url_headers(url)
        resume_pos = 0
        if tmp.exists():
            resume_pos = tmp.stat().st_size
            headers["Range"] = f"bytes={resume_pos}-"

        upd(status="downloading")
        resp = requests.get(url, stream=True, headers=headers, timeout=30)

        if resp.status_code == 416:
            resp = requests.get(url, stream=True, headers=url_headers(url), timeout=30)
            resume_pos = 0

        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0)) + resume_pos
        upd(total_bytes=total, downloaded_bytes=resume_pos)

        with open(tmp, "ab" if resume_pos else "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                with _downloads_lock:
                    if _downloads.get(task_id, {}).get("status") == "cancelled":
                        return
                if chunk:
                    f.write(chunk)
                    resume_pos += len(chunk)
                    pct = (resume_pos / total * 100) if total > 0 else 0
                    upd(downloaded_bytes=resume_pos, progress=min(pct, 100))

        tmp.rename(dest)
        upd(status="done", progress=100.0)

    except Exception as e:
        upd(status="error", error=str(e))
        print(f"[ModelDownloader] Download error for {task_id}: {e}")
