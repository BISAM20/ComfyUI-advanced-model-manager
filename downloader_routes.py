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
    get_folder_paths_for,
    get_workflows_dir,
    get_local_model_size,
    delete_local_model,
    start_move,
    get_move,
    cancel_move,
    get_folder_bases,
    list_model_folder_targets,
)
from .link_resolver import resolve_link
from .workflow_models import extract_workflow_models, fetch_workflow


async def handle_list_repos(request: web.Request) -> web.Response:
    """GET /modeldownloader/repos  — sorted by lastModified desc.
    Pass ?force=1 to bypass the disk cache and re-fetch from HuggingFace.
    """
    force = request.rel_url.query.get("force", "0") == "1"
    loop  = asyncio.get_event_loop()
    repos = await loop.run_in_executor(None, list_all_repos, force)
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


async def handle_delete_model(request: web.Request) -> web.Response:
    """DELETE /modeldownloader/model?folder=<folder>&file=<filename>"""
    folder   = request.rel_url.query.get("folder", "")
    filename = request.rel_url.query.get("file", "")
    if not folder or not filename:
        return web.json_response({"error": "Missing folder or file"}, status=400)
    loop = asyncio.get_event_loop()
    ok   = await loop.run_in_executor(None, delete_local_model, folder, filename)
    return web.json_response({"ok": ok})


async def handle_move_model(request: web.Request) -> web.Response:
    """POST /modeldownloader/move_model
    {"from_folder": "...", "filename": "...", "to_folder": "..."}

    Starts a background move and returns a task id. Problems the user can fix
    (missing file, name already taken) come back as a 400 straight away.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    from_folder = (body.get("from_folder") or "").strip()
    to_folder   = (body.get("to_folder") or "").strip()
    filename    = (body.get("filename") or "").strip()
    if not from_folder or not to_folder or not filename:
        return web.json_response(
            {"error": "from_folder, to_folder and filename are all required"}, status=400)

    loop = asyncio.get_event_loop()
    try:
        task_id = await loop.run_in_executor(
            None, start_move, from_folder, filename, to_folder)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": f"Could not move file: {e}"}, status=500)

    dest_dir = get_folder_bases(to_folder)[0]
    return web.json_response({"task_id": task_id, "status": "queued",
                              "dest_dir": str(dest_dir)})


async def handle_move_status(request: web.Request) -> web.Response:
    """GET /modeldownloader/move_status/{task_id}"""
    state = get_move(request.match_info["task_id"])
    if state is None:
        return web.json_response({"error": "Not found"}, status=404)
    return web.json_response(state)


async def handle_cancel_move(request: web.Request) -> web.Response:
    """DELETE /modeldownloader/move/{task_id}"""
    return web.json_response({"cancelled": cancel_move(request.match_info["task_id"])})


async def handle_folder_targets(request: web.Request) -> web.Response:
    """GET /modeldownloader/folder_targets — model folders a file can be moved
    into, one entry per distinct directory."""
    loop    = asyncio.get_event_loop()
    targets = await loop.run_in_executor(None, list_model_folder_targets)
    return web.json_response(targets)


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


async def handle_resolve_link(request: web.Request) -> web.Response:
    """POST /modeldownloader/resolve_link  {"url": "..."}

    Recognises a pasted HuggingFace / GitHub / direct link and returns
    the file(s) behind it with the ComfyUI folder each belongs in.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    url = (body.get("url") or "").strip()
    if not url:
        return web.json_response({"error": "Missing url"}, status=400)

    loop   = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, resolve_link, url)
    return web.json_response(result)


async def handle_workflow_models(request: web.Request) -> web.Response:
    """POST /modeldownloader/workflow_models

    Body is either {"workflow": {...}} for a graph the client already has, or
    {"url": "..."} to load one (a /templates/<name>.json path, or any link).
    Returns the model files that workflow needs, with download URLs.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    workflow = body.get("workflow")
    url      = (body.get("url") or "").strip()
    sizes    = body.get("sizes", True)
    loop     = asyncio.get_event_loop()

    if workflow is None and url:
        is_local_template = url.startswith("/")
        if is_local_template:
            url = f"http://127.0.0.1:{request.url.port or 8188}{url}"
        try:
            workflow = await loop.run_in_executor(
                None, fetch_workflow, url, is_local_template)
        except Exception as e:
            return web.json_response({"error": f"Could not load workflow: {e}"}, status=400)

    if not isinstance(workflow, dict):
        return web.json_response({"error": "No workflow given"}, status=400)

    try:
        models = await loop.run_in_executor(
            None, extract_workflow_models, workflow, bool(sizes))
    except Exception as e:
        return web.json_response({"error": f"Could not read workflow: {e}"}, status=500)

    return web.json_response({"models": models, "count": len(models)})


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
        # Use the first configured path, but if a specific file is requested
        # find whichever path it actually lives in.
        paths = get_folder_paths_for(folder_name)
        target_dir = paths[0]
        if filename:
            for p in paths:
                if (p / filename).exists():
                    target_dir = p
                    break

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
        app.router.add_post  ("/modeldownloader/resolve_link",              handle_resolve_link)
        app.router.add_post  ("/modeldownloader/workflow_models",           handle_workflow_models)
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
        app.router.add_post  ("/modeldownloader/move_model",                  handle_move_model)
        app.router.add_get   ("/modeldownloader/move_status/{task_id}",       handle_move_status)
        app.router.add_delete("/modeldownloader/move/{task_id}",              handle_cancel_move)
        app.router.add_get   ("/modeldownloader/folder_targets",              handle_folder_targets)

        print("[ModelDownloader] Routes registered.")
    except Exception as e:
        print(f"[ModelDownloader] Failed to register routes: {e}")
