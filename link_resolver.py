"""
Resolve a pasted URL into downloadable model files.

Recognises HuggingFace repo/file links, GitHub blob/raw links and plain
direct URLs, then works out which ComfyUI model folder each file belongs in.
"""
import re
import requests
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, unquote

from .model_manager import (
    MODEL_EXTENSIONS,
    classify_file,
    fetch_readme_hints,
    is_workflow_file,
    scan_local_models,
    url_headers,
)

_UA = {"User-Agent": "ComfyUI-ModelDownloader/1.0"}


# ── Small helpers ─────────────────────────────────────────────────────────────

def _filename_from_disposition(value: str) -> Optional[str]:
    if not value:
        return None
    m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", value, re.I)
    if m:
        return Path(unquote(m.group(1).strip().strip('"'))).name
    m = re.search(r'filename="?([^";]+)"?', value, re.I)
    if m:
        return Path(unquote(m.group(1).strip())).name
    return None


def _remote_file_info(url: str) -> tuple[Optional[int], Optional[str], Optional[int]]:
    """Return (size_bytes, filename, http_status) for a URL.

    Tries HEAD first, falling back to a 1-byte ranged GET for servers that
    reject HEAD. status is None when the host could not be reached at all.
    """
    headers = dict(_UA)
    headers.update(url_headers(url))
    resp = None
    try:
        resp = requests.head(url, headers=headers, allow_redirects=True, timeout=15)
        if resp.status_code >= 400 or not resp.headers.get("Content-Length"):
            resp = requests.get(url, headers={**headers, "Range": "bytes=0-0"},
                                stream=True, allow_redirects=True, timeout=15)
            resp.close()
    except Exception:
        return None, None, None

    if resp.status_code >= 400:
        return None, None, resp.status_code

    size = None
    # HF reports the real LFS size in x-linked-size; Content-Length is the pointer.
    raw = resp.headers.get("x-linked-size") or resp.headers.get("Content-Length")
    if resp.headers.get("Content-Range") and not resp.headers.get("x-linked-size"):
        m = re.search(r"/(\d+)$", resp.headers["Content-Range"])
        raw = m.group(1) if m else raw
    try:
        size = int(raw) if raw else None
    except (TypeError, ValueError):
        size = None

    name = _filename_from_disposition(resp.headers.get("Content-Disposition", ""))
    if not name:
        name = Path(urlparse(resp.url).path).name or None
    return size, name, resp.status_code


def _status_error(status: Optional[int], what: str) -> Optional[str]:
    """Human-readable message for a failed reachability check, else None."""
    if status is None:
        return f"Could not reach {what} — check the link or your connection."
    if status == 404:
        return f"{what} does not exist (HTTP 404) — check the link."
    if status in (401, 403):
        return (f"{what} needs authentication (HTTP {status}) — "
                f"set HF_TOKEN, or accept the model licence on its page first.")
    if status >= 400:
        return f"{what} returned HTTP {status}."
    return None


def _entry(filename: str, path: str, folder: str, direct_url: str,
           repo_id: str, size: Optional[int] = None, note: str = "") -> dict:
    """Build a file dict in the same shape the UI already renders."""
    is_wf = folder == "workflows"
    return {
        "filename":     filename,
        "path":         path,
        "local_folder": folder,
        "category":     folder,
        "size":         size,
        "direct_url":   direct_url,
        "repo_id":      repo_id,
        "file_type":    "workflow" if is_wf else "model",
        "downloaded":   False,
        "note":         note,
    }


def _mark_downloaded(files: list[dict]) -> None:
    local = scan_local_models()
    for f in files:
        f["downloaded"] = f["filename"] in (local.get(f["local_folder"]) or [])


def _classify_by_name(filename: str, repo_id: str = "") -> str:
    if is_workflow_file(filename) and Path(filename).suffix.lower() == ".json":
        return "workflows"
    folder, _ = classify_file(filename, repo_id)
    return folder or "checkpoints"


# ── HuggingFace ───────────────────────────────────────────────────────────────

_HF_HOSTS = ("huggingface.co", "hf.co", "www.huggingface.co")


def _resolve_huggingface(parsed) -> dict:
    parts = [p for p in parsed.path.split("/") if p]
    if not parts:
        return {"error": "No HuggingFace repository in that link."}

    # datasets/spaces live under a type prefix; models are bare owner/name
    prefix = ""
    if parts[0] in ("datasets", "spaces"):
        prefix = parts[0] + "/"
        parts = parts[1:]

    if len(parts) < 2:
        return {"error": "That HuggingFace link has no repository name."}

    repo_id  = f"{parts[0]}/{parts[1]}"
    full_id  = prefix + repo_id
    rest     = parts[2:]
    page_url = f"https://huggingface.co/{full_id}"

    # .../resolve/<rev>/<path>  or  .../blob/<rev>/<path>  → a single file
    if len(rest) >= 3 and rest[0] in ("resolve", "blob", "raw"):
        revision = rest[1]
        filepath = "/".join(rest[2:])
        direct   = f"https://huggingface.co/{full_id}/resolve/{revision}/{filepath}"
        hints    = fetch_readme_hints(repo_id) if not prefix else {}
        folder, filename = classify_file(filepath, repo_id, hints)
        if folder is None:
            folder = "workflows" if is_workflow_file(filepath) else "checkpoints"
        size, _, status = _remote_file_info(direct)
        err = _status_error(status, f"{filename} on HuggingFace")
        if err:
            return {"error": err}
        return {
            "kind":   "files",
            "source": "huggingface",
            "title":  f"{full_id} · {filename}",
            "page_url": f"{page_url}/blob/{revision}/{filepath}",
            "files":  [_entry(filename, filepath, folder, direct, full_id, size,
                              f"HuggingFace file from {full_id}")],
        }

    # .../tree/<rev>/<dir>  or  the plain repo page → let the normal repo view handle it
    if prefix:
        return {"error": f"Only HuggingFace model repos are supported (got {prefix.rstrip('/')})."}

    subpath = "/".join(rest[2:]) if len(rest) >= 2 and rest[0] == "tree" else ""
    return {
        "kind":     "repo",
        "source":   "huggingface",
        "repo_id":  repo_id,
        "title":    repo_id,
        "page_url": page_url,
        "subpath":  subpath,
    }


# ── GitHub ────────────────────────────────────────────────────────────────────

def _resolve_github(parsed) -> dict:
    host  = parsed.netloc.lower()
    parts = [p for p in parsed.path.split("/") if p]

    if host.endswith("raw.githubusercontent.com"):
        direct = parsed.geturl()
        repo   = "/".join(parts[:2]) if len(parts) >= 2 else "github"
        path   = "/".join(parts[4:]) if len(parts) > 4 else Path(parsed.path).name
    elif len(parts) >= 5 and parts[2] in ("blob", "raw"):
        repo   = f"{parts[0]}/{parts[1]}"
        branch = parts[3]
        path   = "/".join(parts[4:])
        direct = f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
    else:
        return {"error": "Paste a link to a specific file on GitHub (a /blob/ or raw URL)."}

    filename = Path(path).name
    folder   = _classify_by_name(path)
    size, _, status = _remote_file_info(direct)
    err = _status_error(status, f"{filename} on GitHub")
    if err:
        return {"error": err}
    return {
        "kind":     "files",
        "source":   "github",
        "title":    f"{repo} · {filename}",
        "page_url": parsed.geturl(),
        "files":    [_entry(filename, path, folder, direct, f"github:{repo}", size,
                            f"GitHub file from {repo}")],
    }


# ── Plain direct URL ──────────────────────────────────────────────────────────

def _resolve_direct(parsed) -> dict:
    url      = parsed.geturl()
    filename = Path(unquote(parsed.path)).name
    size, header_name, status = _remote_file_info(url)
    err = _status_error(status, f"That link ({parsed.netloc})")
    if err:
        return {"error": err}
    if header_name and (not filename or Path(filename).suffix.lower() not in MODEL_EXTENSIONS):
        filename = header_name
    if not filename:
        return {"error": "Could not work out a filename from that link."}

    ext = Path(filename).suffix.lower()
    if ext not in MODEL_EXTENSIONS and ext != ".json":
        return {"error": f"'{filename}' is not a model file "
                         f"({', '.join(sorted(MODEL_EXTENSIONS))} or .json)."}

    folder = _classify_by_name(filename)
    return {
        "kind":     "files",
        "source":   "direct",
        "title":    filename,
        "page_url": url,
        "files":    [_entry(filename, filename, folder, url, "link", size,
                            f"Direct download from {parsed.netloc}")],
    }


# ── Entry point ───────────────────────────────────────────────────────────────

def resolve_link(raw_url: str) -> dict:
    """Turn a pasted link into {kind, source, title, files|repo_id} or {error}."""
    url = (raw_url or "").strip().strip("<>\"'")
    if not url:
        return {"error": "No link given."}

    # Bare "owner/repo" or "owner/repo/file.safetensors" is treated as HuggingFace
    if "://" not in url:
        if url.startswith("hf:"):
            url = url[3:]
        if re.fullmatch(r"[\w.\-]+/[\w.\-]+(/[^\s]*)?", url):
            url = "https://huggingface.co/" + url.lstrip("/")
        elif re.fullmatch(r"[\w\-]+(\.[\w\-]+)+(/[^\s]*)?", url):
            url = "https://" + url
        else:
            return {"error": f"'{raw_url.strip()}' is not a link. "
                             "Paste a full URL, or a HuggingFace repo id like Comfy-Org/flux1-dev."}

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return {"error": "Only http(s) links are supported."}

    host = parsed.netloc.lower()
    try:
        if any(host == h or host.endswith("." + h) for h in _HF_HOSTS):
            result = _resolve_huggingface(parsed)
        elif host.endswith("github.com") or host.endswith("githubusercontent.com"):
            result = _resolve_github(parsed)
        else:
            result = _resolve_direct(parsed)
    except Exception as e:
        return {"error": f"Could not resolve that link: {e}"}

    if result.get("files"):
        _mark_downloaded(result["files"])
    result.setdefault("url", url)
    return result
