"""
Extract the models a ComfyUI workflow needs.

ComfyUI templates (and workflows saved from them) annotate loader nodes with a
`properties.models` list holding the download URL and target folder for each
file. This module pulls those out so they can be downloaded in one go.
"""
import ipaddress
import json
import socket
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, unquote

import requests

from .model_manager import classify_file, scan_local_models, url_headers
from .link_resolver import _remote_file_info

# Above this many files, skip the size lookups rather than fire off a HEAD
# request per model and make the tab feel stuck.
_MAX_SIZE_LOOKUPS = 40


def _walk_models(obj, out: list):
    """Collect every properties.models entry, at any depth.

    Subgraphed templates keep their loaders under
    definitions.subgraphs[].nodes[], so scanning workflow["nodes"] alone
    misses them entirely.
    """
    if isinstance(obj, dict):
        props = obj.get("properties")
        if isinstance(props, dict):
            models = props.get("models")
            if isinstance(models, list):
                node_type = obj.get("type") if isinstance(obj.get("type"), str) else ""
                title = obj.get("title") if isinstance(obj.get("title"), str) else ""
                for m in models:
                    if isinstance(m, dict) and m.get("url"):
                        out.append((m, node_type, title))
        for value in obj.values():
            _walk_models(value, out)
    elif isinstance(obj, list):
        for value in obj:
            _walk_models(value, out)


def extract_workflow_models(workflow: dict, with_sizes: bool = True) -> list[dict]:
    """Return the model files a workflow references, ready to download."""
    found: list = []
    _walk_models(workflow, found)

    entries: list[dict] = []
    seen: set = set()
    for meta, node_type, title in found:
        url = str(meta.get("url") or "").strip()
        if not url or urlparse(url).scheme not in ("http", "https"):
            continue

        name = Path(str(meta.get("name") or "")).name
        if not name:
            name = Path(unquote(urlparse(url).path)).name
        if not name:
            continue

        key = (name.lower(), url)
        if key in seen:
            continue
        seen.add(key)

        # The template states where the file belongs; fall back to the same
        # classifier the rest of the plugin uses when it does not.
        folder = str(meta.get("directory") or "").strip()
        guessed = False
        if not folder:
            folder = classify_file(name, "")[0] or "checkpoints"
            guessed = True

        source = node_type or title or "workflow"
        entries.append({
            "filename":     name,
            "path":         name,
            "local_folder": folder,
            "category":     folder,
            "size":         None,
            "direct_url":   url,
            "repo_id":      "workflow",
            "file_type":    "model",
            "downloaded":   False,
            "node_type":    source,
            "note":         f"{source} → {folder}" + ("  (folder guessed)" if guessed else ""),
        })

    _mark_downloaded(entries)
    if with_sizes and 0 < len(entries) <= _MAX_SIZE_LOOKUPS:
        _fill_sizes(entries)
    return entries


def _mark_downloaded(entries: list[dict]) -> None:
    local = scan_local_models()
    for e in entries:
        e["downloaded"] = e["filename"] in (local.get(e["local_folder"]) or [])


def _fill_sizes(entries: list[dict]) -> None:
    """Look up file sizes in parallel; a failure just leaves size as None."""
    def probe(entry: dict):
        try:
            size, _name, status = _remote_file_info(entry["direct_url"])
            if status and status < 400:
                entry["size"] = size
            elif status in (401, 403):
                entry["note"] += "  · needs auth"
            elif status == 404:
                entry["note"] += "  · link is dead (404)"
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(probe, entries))


def _is_public_host(hostname: str) -> bool:
    """Reject hostnames that resolve to loopback/private/link-local addresses
    so a workflow URL can't be used to reach internal network resources
    (e.g. the cloud metadata endpoint at 169.254.169.254)."""
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(hostname, None)}
    except socket.gaierror:
        return False
    return bool(addrs) and all(ipaddress.ip_address(addr).is_global for addr in addrs)


def fetch_workflow(url: str, allow_private: bool = False) -> dict:
    """Load a workflow JSON from a URL (a template path or any http(s) link)."""
    hostname = urlparse(url).hostname or ""
    if not allow_private and not _is_public_host(hostname):
        raise ValueError(f"Refusing to fetch workflow from non-public host: {hostname}")
    resp = requests.get(url, headers={"User-Agent": "ComfyUI-ModelDownloader/1.0",
                                      **url_headers(url)}, timeout=20)
    resp.raise_for_status()
    return resp.json()
