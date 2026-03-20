"""
Model Manager: HuggingFace + GitHub repo scanning, local model scanning,
file classification, downloading.
"""
import os
import re
import threading
import uuid
import requests
from pathlib import Path
from typing import Optional

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
    "Lightricks/LTX-Video",
    "Wan-AI/Wan2.1",
    "black-forest-labs/FLUX.1-dev",
    "black-forest-labs/FLUX.1-schnell",
    "stabilityai/stable-diffusion-3.5-large",
    "stabilityai/stable-diffusion-3.5-medium",
    "tencent/HunyuanVideo",
    "genmo/mochi-1-preview",
    "THUDM/CogVideoX-5b",
    "THUDM/CogVideoX-2b",
    "HiDream-ai/HiDream-I1-Full",
    "HiDream-ai/HiDream-I1-Dev",
    "HiDream-ai/HiDream-I1-Fast",
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


def list_all_repos() -> list[dict]:
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
    return all_repos


def list_repo_files(repo_id: str, include_workflows: bool = False) -> list[dict]:
    if not HF_AVAILABLE:
        return []
    api = HfApi()
    try:
        all_files = list(api.list_repo_files(repo_id))
    except Exception as e:
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
    models_dir = get_models_dir()
    if models_dir.exists():
        for folder in models_dir.iterdir():
            if not folder.is_dir():
                continue
            files = [f.name for f in folder.rglob("*")
                     if f.is_file() and f.suffix.lower() in MODEL_EXTENSIONS]
            if files:
                result[folder.name] = files
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
        else:
            p = get_models_dir() / folder / filename
        return p.stat().st_size if p.exists() else None
    except Exception:
        return None


def delete_local_model(folder: str, filename: str) -> bool:
    """Delete a local model file. Returns True on success."""
    try:
        if folder == "workflows":
            target = get_workflows_dir() / filename
        else:
            target = get_models_dir() / folder / filename
        # Safety: resolve and confirm it's inside the expected directory
        target = target.resolve()
        base = (get_workflows_dir() if folder == "workflows" else get_models_dir() / folder).resolve()
        if not str(target).startswith(str(base)):
            return False
        if target.is_file():
            target.unlink()
            return True
        return False
    except Exception as e:
        print(f"[ModelDownloader] Delete error: {e}")
        return False


def get_download_url(repo_id: str, filepath: str, revision: str = "main") -> str:
    return f"https://huggingface.co/{repo_id}/resolve/{revision}/{filepath}"


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
               get_models_dir() / local_folder
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
        headers    = _hf_headers() if "github" not in url else {}
        resume_pos = 0
        if tmp.exists():
            resume_pos = tmp.stat().st_size
            headers["Range"] = f"bytes={resume_pos}-"

        upd(status="downloading")
        resp = requests.get(url, stream=True, headers=headers, timeout=30)

        if resp.status_code == 416:
            resp = requests.get(url, stream=True,
                                headers=_hf_headers() if "github" not in url else {},
                                timeout=30)
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
