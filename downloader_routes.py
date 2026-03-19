"""aiohttp routes for the Model Downloader backend API."""
import asyncio
import os
import platform
import subprocess
from aiohttp import web

from .model_manager import (
    list_all_repos,
    list_repo_files,
    get_repo_file_sizes,
    scan_local_models,
    start_download,
    cancel_download,
    get_downloads,
    get_download,
    classify_file,
    fetch_readme_hints,
    get_all_github_workflows,
    search_files_across_repos,
    search_hf,
    get_models_dir,
    get_workflows_dir,
    get_local_model_size,
    delete_local_model,
    build_full_index,
    get_index_status,
)


async def handle_list_repos(request: web.Request) -> web.Response:
    """GET /modeldownloader/repos  — sorted by lastModified desc."""
    loop  = asyncio.get_event_loop()
    repos = await loop.run_in_executor(None, list_all_repos)
    return web.json_response(repos)


async def handle_repo_files(request: web.Request) -> web.Response:
    author      = request.match_info["author"]
    repo        = request.match_info["repo"]
    repo_id     = f"{author}/{repo}"
    include_wf  = request.rel_url.query.get("workflows", "0") == "1"

    loop  = asyncio.get_event_loop()
    files = await loop.run_in_executor(None, list_repo_files, repo_id, include_wf)
    sizes = await loop.run_in_executor(None, get_repo_file_sizes, repo_id)
    local = await loop.run_in_executor(None, scan_local_models)

    for f in files:
        f["size"] = sizes.get(f["path"])
        f["downloaded"] = f["filename"] in (local.get(f["local_folder"]) or [])

    return web.json_response(files)


async def handle_local_models(request: web.Request) -> web.Response:
    loop   = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, scan_local_models)
    return web.json_response(result)


async def handle_build_index(request: web.Request) -> web.Response:
    """POST /modeldownloader/build_index — start background full-index build."""
    import threading
    t = threading.Thread(target=build_full_index, daemon=True)
    t.start()
    return web.json_response({"ok": True, "message": "Index build started"})


async def handle_index_status(request: web.Request) -> web.Response:
    """GET /modeldownloader/index_status — progress of full-index build."""
    return web.json_response(get_index_status())


async def handle_delete_model(request: web.Request) -> web.Response:
    """DELETE /modeldownloader/model?folder=<folder>&file=<filename>"""
    folder   = request.rel_url.query.get("folder", "")
    filename = request.rel_url.query.get("file", "")
    if not folder or not filename:
        return web.json_response({"error": "Missing folder or file"}, status=400)
    loop = asyncio.get_event_loop()
    ok   = await loop.run_in_executor(None, delete_local_model, folder, filename)
    return web.json_response({"ok": ok})


async def handle_models_dir(request: web.Request) -> web.Response:
    return web.json_response({
        "models":    str(get_models_dir()),
        "workflows": str(get_workflows_dir()),
    })


async def handle_start_download(request: web.Request) -> web.Response:
    try:
        body         = await request.json()
        repo_id      = body["repo_id"]
        filepath     = body["filepath"]
        local_folder = body.get("local_folder")
        filename     = body.get("filename")
        direct_url   = body.get("direct_url")   # for GitHub files

        if not local_folder or not filename:
            folder, fname = classify_file(filepath, repo_id)
            local_folder  = local_folder or folder or "checkpoints"
            filename      = filename or fname

        task_id = start_download(repo_id, filepath, local_folder, filename, direct_url)
        return web.json_response({"task_id": task_id, "status": "queued"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)


async def handle_download_status(request: web.Request) -> web.Response:
    task_id = request.match_info["task_id"]
    state   = get_download(task_id)
    if state is None:
        return web.json_response({"error": "Not found"}, status=404)
    return web.json_response(state)


async def handle_all_downloads(request: web.Request) -> web.Response:
    return web.json_response(get_downloads())


async def handle_cancel_download(request: web.Request) -> web.Response:
    task_id = request.match_info["task_id"]
    ok      = cancel_download(task_id)
    return web.json_response({"cancelled": ok})


async def handle_search(request: web.Request) -> web.Response:
    """GET /modeldownloader/search?q=...  — search repo names."""
    q             = request.rel_url.query.get("q", "").lower()
    author_filter = request.rel_url.query.get("author", "").lower()
    loop  = asyncio.get_event_loop()
    repos = await loop.run_in_executor(None, list_all_repos)
    if author_filter:
        repos = [r for r in repos if r["author"].lower() == author_filter]
    if q:
        repos = [r for r in repos if q in r["name"].lower() or q in r["id"].lower()]
    return web.json_response(repos)


async def handle_search_files(request: web.Request) -> web.Response:
    """GET /modeldownloader/search_files?q=...  — search file names across repos."""
    q = request.rel_url.query.get("q", "").strip()
    if len(q) < 2:
        return web.json_response([])
    loop    = asyncio.get_event_loop()
    results = await loop.run_in_executor(None, search_files_across_repos, q)
    return web.json_response(results[:200])   # cap at 200 results


async def handle_hf_search(request: web.Request) -> web.Response:
    """GET /modeldownloader/hf_search?q=...  — search HuggingFace directly."""
    q = request.rel_url.query.get("q", "").strip()
    if len(q) < 2:
        return web.json_response([])
    loop    = asyncio.get_event_loop()
    results = await loop.run_in_executor(None, search_hf, q)
    return web.json_response(results)


async def handle_github_workflows(request: web.Request) -> web.Response:
    """GET /modeldownloader/github_workflows?group=comfyorg|kijai  — workflow JSONs from GitHub."""
    group = request.rel_url.query.get("group", "")
    loop  = asyncio.get_event_loop()
    files = await loop.run_in_executor(None, get_all_github_workflows, group)
    local = await loop.run_in_executor(None, scan_local_models)
    for f in files:
        f["downloaded"] = f["filename"] in (local.get("workflows") or [])
    return web.json_response(files)


async def handle_readme_hints(request: web.Request) -> web.Response:
    author  = request.match_info["author"]
    repo    = request.match_info["repo"]
    loop    = asyncio.get_event_loop()
    hints   = await loop.run_in_executor(None, fetch_readme_hints, f"{author}/{repo}")
    return web.json_response(hints)


async def handle_open_folder(request: web.Request) -> web.Response:
    """GET /modeldownloader/open_folder?folder=<category>&file=<filename>
    Opens the containing folder in the OS file manager.
    """
    folder_name = request.rel_url.query.get("folder", "")
    filename    = request.rel_url.query.get("file", "")
    if not folder_name:
        return web.json_response({"error": "Missing folder"}, status=400)

    if folder_name == "workflows":
        target_dir = get_workflows_dir()
    else:
        target_dir = get_models_dir() / folder_name

    if not target_dir.exists():
        return web.json_response({"error": f"Folder not found: {target_dir}"}, status=404)

    folder_path = str(target_dir)
    try:
        system = platform.system()
        if system == "Windows":
            if filename:
                subprocess.Popen(["explorer", "/select,", str(target_dir / filename)])
            else:
                subprocess.Popen(["explorer", folder_path])
        elif system == "Darwin":
            if filename:
                subprocess.Popen(["open", "-R", str(target_dir / filename)])
            else:
                subprocess.Popen(["open", folder_path])
        else:
            # ComfyUI server process may not have DISPLAY set — build a GUI-capable env.
            import glob as _glob
            gui_env = os.environ.copy()
            if not gui_env.get("DISPLAY"):
                # Find an active X display: prefer :0, then scan lock files
                display = ":0"
                for candidate in [":0", ":1"] + [
                    ":" + f.replace("/tmp/.X", "").replace("-lock", "")
                    for f in sorted(_glob.glob("/tmp/.X*-lock"))
                ]:
                    if os.path.exists(f"/tmp/.X{candidate.lstrip(':')}-lock"):
                        display = candidate
                        break
                gui_env["DISPLAY"] = display
            # Pass DBUS address so nautilus/xdg-open can connect to the session bus
            if not gui_env.get("DBUS_SESSION_BUS_ADDRESS"):
                import getpass as _gp
                uid = os.getuid()
                gui_env.setdefault("DBUS_SESSION_BUS_ADDRESS",
                                   f"unix:path=/run/user/{uid}/bus")

            file_path_str = str(target_dir / filename) if filename else folder_path
            launched = False
            for fm_cmd in [
                ["nautilus", "--select", file_path_str],
                ["dolphin", "--select", file_path_str],
                ["nemo", file_path_str],
                ["xdg-open", folder_path],
            ]:
                try:
                    subprocess.Popen(fm_cmd, env=gui_env)
                    launched = True
                    break
                except FileNotFoundError:
                    continue
            if not launched:
                return web.json_response({"error": "No file manager found"}, status=500)
        return web.json_response({"ok": True, "folder": folder_path})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


def setup_routes():
    try:
        from server import PromptServer
        app = PromptServer.instance.app

        app.router.add_get   ("/modeldownloader/repos",                     handle_list_repos)
        app.router.add_get   ("/modeldownloader/repo/{author}/{repo:.*}",   handle_repo_files)
        app.router.add_get   ("/modeldownloader/local_models",              handle_local_models)
        app.router.add_get   ("/modeldownloader/models_dir",                handle_models_dir)
        app.router.add_post  ("/modeldownloader/download",                  handle_start_download)
        app.router.add_get   ("/modeldownloader/download_status/{task_id}", handle_download_status)
        app.router.add_get   ("/modeldownloader/downloads",                 handle_all_downloads)
        app.router.add_delete("/modeldownloader/download/{task_id}",        handle_cancel_download)
        app.router.add_get   ("/modeldownloader/search",                    handle_search)
        app.router.add_get   ("/modeldownloader/search_files",              handle_search_files)
        app.router.add_get   ("/modeldownloader/hf_search",                 handle_hf_search)
        app.router.add_get   ("/modeldownloader/github_workflows",          handle_github_workflows)
        app.router.add_get   ("/modeldownloader/readme/{author}/{repo:.*}", handle_readme_hints)
        app.router.add_get   ("/modeldownloader/open_folder",               handle_open_folder)
        app.router.add_delete("/modeldownloader/model",                      handle_delete_model)
        app.router.add_post  ("/modeldownloader/build_index",                handle_build_index)
        app.router.add_get   ("/modeldownloader/index_status",               handle_index_status)

        print("[ModelDownloader] Routes registered.")
    except Exception as e:
        print(f"[ModelDownloader] Failed to register routes: {e}")
