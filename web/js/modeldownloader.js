/**
 * ComfyUI Model Downloader v3.2
 *
 * Browse modes:
 *   📁 Repository  — repos grouped by author
 *   🏷️ By Model    — all repos flat, sorted latest-first, with family badges
 *   📋 Workflows   — HuggingFace + GitHub workflow JSON files
 *
 * Search searches BOTH repo names AND file names across all loaded repos.
 * "Search HuggingFace" button triggers a live HF text search.
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmt = b => {
    if (!b) return "?";
    if (b < 1024)       return b + " B";
    if (b < 1024 ** 2)  return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 ** 3)  return (b / 1024 ** 2).toFixed(2) + " MB";
    return (b / 1024 ** 3).toFixed(2) + " GB";
};

function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === "style" && typeof v === "object") Object.assign(e.style, v);
        else if (k === "className") e.className = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v);
    }
    for (const c of children) {
        if (typeof c === "string") e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
    }
    return e;
}

function addOpt(sel, val, label) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label;
    sel.appendChild(o);
}

function btn(label, style = {}, cb) {
    const b = el("button", {
        style: {
            padding: "5px 12px", cursor: "pointer", borderRadius: "6px",
            fontSize: "12px", fontWeight: "600", border: "1px solid #30363d",
            background: "#0d1117", color: "#c8d6e5", ...style,
        },
    }, [label]);
    if (cb) b.addEventListener("click", cb);
    return b;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CAT_ICON  = { diffusion_models:"🔵",checkpoints:"📦",vae:"🟣",text_encoders:"📝",
                    loras:"🟡",controlnet:"🔶",upscale_models:"🔍",clip_vision:"👁️",
                    audio_encoders:"🔊",ipadapter:"🖼️",workflows:"📋" };
const CAT_COLOR = { diffusion_models:"#4a9eff",checkpoints:"#7ec8e3",vae:"#c084fc",
                    text_encoders:"#6ee7b7",loras:"#fbbf24",controlnet:"#fb923c",
                    upscale_models:"#34d399",clip_vision:"#a78bfa",workflows:"#f472b6" };
const CAT_ORDER = ["diffusion_models","checkpoints","text_encoders","vae","loras",
                   "controlnet","upscale_models","clip_vision","audio_encoders","ipadapter","workflows"];

const MODE_REPO = "repo", MODE_MODEL = "model", MODE_WORKFLOW = "workflow", MODE_LOCAL = "local";

// Keywords used to guess a repo's category when its files haven't been loaded yet
const CAT_KEYWORDS = {
    loras:          ["lora", "locon", "loha", "lycoris"],
    vae:            ["vae"],
    text_encoders:  ["clip", "t5xxl", "t5_", "_t5", "text_encoder", "gemma", "llm", "bert", "qwen", "longt5"],
    controlnet:     ["controlnet", "control_net"],
    upscale_models: ["upscale", "esrgan", "realesrgan", "swin2sr"],
    clip_vision:    ["clip_vision", "siglip", "eva_clip"],
    audio_encoders: ["audio_encoder", "audioldm"],
    ipadapter:      ["ipadapter", "ip_adapter"],
};

/**
 * Returns true if a repo likely contains files of the given category.
 * Uses real file data when already loaded; falls back to name/family heuristics.
 */
function repoMatchesCategory(repo, cat) {
    if (cat === "all") return true;
    // Use real file data if available
    const files = S.repoFiles[repo.id];
    if (files && files.length > 0)
        return files.some(f => f.local_folder === cat || f.category === cat);
    // Heuristic: search repo id + name + model_family for category keywords
    const text = `${repo.id} ${repo.name} ${repo.model_family||""}`.toLowerCase();
    const kws  = CAT_KEYWORDS[cat];
    if (kws) return kws.some(k => text.includes(k));
    // diffusion_models / checkpoints: show everything not matched by specific keywords above
    return true;
}

// ── State ─────────────────────────────────────────────────────────────────────

const S = {
    repos: [], localModels: {}, downloads: {},
    repoFiles: {},                    // repo_id → files[]
    browseMode: MODE_REPO,
    selectedRepo: null,
    searchQuery: "",
    catFilter: "all", authorFilter: "all",
    showWorkflows: false,
    pollingInterval: null,
    fileSearchResults: null,          // null = no search active, [] = results
    fileSearchPending: false,
    hfSearchResults: null,            // repos from HF live search
    githubWorkflowFiles: null,        // cached files for current github workflow group
    collapsedAuthors: new Set(),      // authors whose repo list is collapsed
    localCategory: null,              // selected category in Downloaded tab
};

// ── Dialog ────────────────────────────────────────────────────────────────────

class ModelDownloaderDialog {
    constructor() { this.visible = false; this._build(); }

    // ── Shell ──────────────────────────────────────────────────────────────────

    _build() {
        this.overlay = el("div", {
            style: {
                position:"fixed",inset:"0",background:"rgba(0,0,0,0.65)",
                zIndex:"9998",display:"none",alignItems:"center",justifyContent:"center",
            },
        });
        this.overlay.addEventListener("click", e => { if (e.target===this.overlay) this.hide(); });

        this.dialog = el("div", {
            className:"mdd-dialog",
            style: {
                background:"#1a1a2e",color:"#e0e0e0",borderRadius:"12px",
                border:"1px solid #333",width:"min(1200px,96vw)",height:"min(800px,92vh)",
                display:"flex",flexDirection:"column",fontFamily:"system-ui,sans-serif",
                fontSize:"13px",overflow:"hidden",boxShadow:"0 20px 60px rgba(0,0,0,0.5)",
            },
        });

        this._buildHeader();
        this._buildToolbar();
        this._buildBody();
        this._buildDlBar();

        this.overlay.appendChild(this.dialog);
        document.body.appendChild(this.overlay);
    }

    _buildHeader() {
        const h = el("div", {
            style:{padding:"13px 20px 11px",borderBottom:"1px solid #2a2a3e",
                display:"flex",alignItems:"center",gap:"12px",
                background:"linear-gradient(135deg,#16213e,#0f3460)",flexShrink:"0"},
        });
        h.appendChild(el("span",{style:{fontSize:"20px"}},["📥"]));
        h.appendChild(el("span",{style:{fontWeight:"700",fontSize:"16px",color:"#fff",flex:"1"}},
            ["Model Downloader"]));
        h.appendChild(el("span",{style:{fontSize:"11px",color:"#556",marginRight:"8px"}},
            ["HuggingFace · GitHub · ComfyUI-compatible"]));
        const x = el("button",{style:{background:"none",border:"1px solid #444",borderRadius:"6px",
            color:"#aaa",cursor:"pointer",padding:"4px 12px",fontSize:"14px"}},["✕"]);
        x.addEventListener("click",()=>this.hide());
        h.appendChild(x);
        this.dialog.appendChild(h);
    }

    _buildToolbar() {
        const tb = el("div",{
            style:{padding:"9px 14px",borderBottom:"1px solid #2a2a3e",display:"flex",
                gap:"7px",alignItems:"center",background:"#16213e",flexWrap:"wrap",flexShrink:"0"},
        });

        // Browse mode
        tb.appendChild(el("span",{style:{color:"#556",fontSize:"11px",whiteSpace:"nowrap"}},["Browse by:"]));
        this.modeSelect = el("select",{style:this._ss()});
        addOpt(this.modeSelect, MODE_REPO,     "📁 Repository");
        addOpt(this.modeSelect, MODE_MODEL,    "🏷️ By Model");
        addOpt(this.modeSelect, MODE_WORKFLOW, "📋 Workflows");
        addOpt(this.modeSelect, MODE_LOCAL,    "💾 Downloaded");
        this.modeSelect.addEventListener("change",async()=>{
            S.browseMode = this.modeSelect.value;
            S.selectedRepo = null;
            S.fileSearchResults = null;
            S.hfSearchResults = null;
            S.githubWorkflowFiles = null;
            if (S.browseMode === MODE_LOCAL) {
                const r = await fetch("/modeldownloader/local_models");
                S.localModels = await r.json();
                S.localCategory = Object.keys(S.localModels)[0] || null;
                this._renderLeft();
                if (S.localCategory) this._renderLocalFiles(S.localCategory);
                else this._showPlaceholder(true);
            } else {
                this._renderLeft();
                this._showPlaceholder(true);
            }
        });
        tb.appendChild(this.modeSelect);

        // Search box
        this.searchInput = el("input",{
            type:"text",placeholder:"🔍  Search repos or files…",
            style:{flex:"1",minWidth:"160px",padding:"6px 12px",
                background:"#0d1117",border:"1px solid #30363d",
                borderRadius:"8px",color:"#e0e0e0",fontSize:"13px"},
        });
        this._searchTimer = null;
        this.searchInput.addEventListener("input",()=>{
            S.searchQuery = this.searchInput.value;
            clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(()=>this._onSearch(), 350);
        });
        tb.appendChild(this.searchInput);

        // Search files button
        this.searchFilesBtn = btn("🔍 Search Files",
            {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3"},
            ()=>this._triggerFileSearch()
        );
        this.searchFilesBtn.title = "Search file names across all repos (loads uncached repos)";
        tb.appendChild(this.searchFilesBtn);

        // HF live search button
        this.hfSearchBtn = btn("🌐 Search HuggingFace",
            {background:"#0f3460",border:"1px solid #1a5276",color:"#f472b6"},
            ()=>this._triggerHFSearch()
        );
        this.hfSearchBtn.title = "Search HuggingFace for repos matching your query";
        tb.appendChild(this.hfSearchBtn);

        // Author filter
        this.authorSelect = el("select",{style:this._ss()});
        addOpt(this.authorSelect,"all","All Authors");
        for (const a of ["Comfy-Org","Kijai","city96","Lightricks","Wan-AI",
                         "black-forest-labs","stabilityai","tencent","THUDM","HiDream-ai"])
            addOpt(this.authorSelect,a,a);
        this.authorSelect.addEventListener("change",()=>{
            S.authorFilter = this.authorSelect.value;
            this._renderLeft();
        });
        tb.appendChild(this.authorSelect);

        // Category filter
        this.catSelect = el("select",{style:this._ss()});
        addOpt(this.catSelect,"all","All Categories");
        for (const c of CAT_ORDER)
            addOpt(this.catSelect,c,`${CAT_ICON[c]||"📄"} ${c.replace(/_/g," ")}`);
        this.catSelect.addEventListener("change",()=>{
            S.catFilter = this.catSelect.value;
            this._renderLeft();
            if (S.githubWorkflowFiles) this._renderGithubWorkflows(S.githubWorkflowFiles);
            else if (S.selectedRepo && S.repoFiles[S.selectedRepo])
                this._renderFileList(S.repoFiles[S.selectedRepo]);
        });
        tb.appendChild(this.catSelect);

        // Refresh + build full index
        this.refreshBtn = btn("⟳ Refresh",
            {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3"},
            ()=>this._refreshAndIndex()
        );
        tb.appendChild(this.refreshBtn);

        this.dialog.appendChild(tb);
    }

    _ss() {   // shared select style
        return {padding:"6px 9px",background:"#0d1117",border:"1px solid #30363d",
                borderRadius:"8px",color:"#e0e0e0",fontSize:"12px",cursor:"pointer"};
    }

    _buildBody() {
        const body = el("div",{style:{flex:"1",display:"flex",overflow:"hidden"}});

        this.leftPanel = el("div",{
            style:{width:"290px",minWidth:"210px",borderRight:"1px solid #2a2a3e",
                overflowY:"auto",background:"#12121f",display:"flex",flexDirection:"column"},
        });
        this.leftStatus = el("div",{
            style:{padding:"14px",color:"#555",textAlign:"center",fontSize:"12px"}},
            ["Loading…"]);
        this.leftList = el("div");
        this.leftPanel.appendChild(this.leftStatus);
        this.leftPanel.appendChild(this.leftList);

        this.rightPanel = el("div",{
            style:{flex:"1",overflowY:"auto",background:"#0d0d1a",display:"flex",flexDirection:"column"}});
        this.placeholder = el("div",{
            style:{flex:"1",display:"flex",alignItems:"center",justifyContent:"center",
                color:"#333",fontSize:"15px",flexDirection:"column",gap:"12px"}},
            [el("span",{style:{fontSize:"44px"}},["📦"]),
             el("span",{},["Select a repo or model · or use Search Files"])]);
        this.fileListEl = el("div",{style:{display:"none"}});
        this.rightPanel.appendChild(this.placeholder);
        this.rightPanel.appendChild(this.fileListEl);

        body.appendChild(this.leftPanel);
        body.appendChild(this.rightPanel);
        this.dialog.appendChild(body);
    }

    _buildDlBar() {
        this.dlBar = el("div",{
            style:{borderTop:"1px solid #2a2a3e",background:"#12121f",
                padding:"6px 16px",maxHeight:"120px",overflowY:"auto",flexShrink:"0"}});
        this.dlBar.appendChild(el("div",{
            style:{fontSize:"10px",color:"#333",marginBottom:"3px",
                textTransform:"uppercase",letterSpacing:"0.5px"}},["Downloads"]));
        this.dlInner = el("div",{style:{display:"flex",flexDirection:"column",gap:"2px"}});
        this.dlBar.appendChild(this.dlInner);
        this.dialog.appendChild(this.dlBar);
    }

    // ── Data loading ───────────────────────────────────────────────────────────

    async loadAll(force=false) {
        if (!force && S.repos.length) { this._renderLeft(); return; }
        this.leftStatus.textContent="Loading…";
        this.leftStatus.style.display="block";
        this.leftList.innerHTML="";
        try {
            const [rr,lr] = await Promise.all([
                fetch("/modeldownloader/repos"),
                fetch("/modeldownloader/local_models"),
            ]);
            S.repos      = await rr.json();
            S.localModels = await lr.json();
            if (force) S.repoFiles={};
            this.leftStatus.style.display="none";
            this._renderLeft();
        } catch(e) {
            this.leftStatus.textContent="⚠ Server unreachable.";
        }
    }

    async _refreshAndIndex() {
        this.refreshBtn.disabled=true;
        this.refreshBtn.textContent="⟳ Refreshing…";
        await this.loadAll(true);
        // Start full index build in background
        this.refreshBtn.textContent="⟳ Indexing…";
        await fetch("/modeldownloader/build_index",{method:"POST"}).catch(()=>{});
        // Poll until done
        const poll = setInterval(async()=>{
            try {
                const r=await fetch("/modeldownloader/index_status");
                const s=await r.json();
                if (s.running) {
                    this.refreshBtn.textContent=`⟳ ${s.done}/${s.total} repos`;
                } else {
                    clearInterval(poll);
                    this.refreshBtn.disabled=false;
                    this.refreshBtn.textContent="⟳ Refresh";
                    this.leftStatus.textContent=`Index complete — ${s.total} repos indexed`;
                    this.leftStatus.style.display="block";
                    setTimeout(()=>{ this.leftStatus.style.display="none"; },3000);
                }
            } catch(_){ clearInterval(poll); this.refreshBtn.disabled=false; this.refreshBtn.textContent="⟳ Refresh"; }
        },1000);
    }

    async loadRepoFiles(repoId, keepFileSearch=false) {
        S.selectedRepo = repoId;
        if (!keepFileSearch) S.fileSearchResults = null;
        S.githubWorkflowFiles = null;
        this._showPlaceholder(false);
        this.fileListEl.innerHTML=`<div style="padding:30px;text-align:center;color:#555">
            Loading <b style="color:#7ec8e3">${repoId}</b>…</div>`;
        try {
            if (!S.repoFiles[repoId]) {
                const [a,...rest] = repoId.split("/");
                const r = await fetch(`/modeldownloader/repo/${a}/${rest.join("/")}?workflows=${S.showWorkflows?1:0}`);
                S.repoFiles[repoId] = await r.json();
            }
            this._applyLocalFlags(S.repoFiles[repoId]);
            this._renderFileList(S.repoFiles[repoId]);
        } catch(e) {
            this.fileListEl.innerHTML=`<div style="padding:20px;color:#f87171">⚠ ${e.message}</div>`;
        }
    }

    async loadGithubWorkflows(group) {
        S.selectedRepo = `__github__${group}`;
        S.githubWorkflowFiles = null;
        this._showPlaceholder(false);
        this.fileListEl.innerHTML=`<div style="padding:30px;text-align:center;color:#555">Loading GitHub workflows…</div>`;
        try {
            const r = await fetch(`/modeldownloader/github_workflows?group=${encodeURIComponent(group)}`);
            const files = await r.json();
            if (!files.length) {
                this.fileListEl.innerHTML=`<div style="padding:20px;color:#555;text-align:center">No workflows found on GitHub.</div>`;
                return;
            }
            S.githubWorkflowFiles = files;
            this._renderGithubWorkflows(files);
        } catch(e) {
            this.fileListEl.innerHTML=`<div style="padding:20px;color:#f87171">⚠ ${e.message}</div>`;
        }
    }

    async startDownload(file) {
        const body = {
            repo_id:file.repo_id, filepath:file.path,
            local_folder:file.local_folder, filename:file.filename,
        };
        if (file.github_raw) body.direct_url = file.github_raw;
        const r  = await fetch("/modeldownloader/download",{
            method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        const d  = await r.json();
        if (d.task_id) {
            // Merge server response with local file info so activeDl matching works immediately
            S.downloads[d.task_id] = {
                ...d,
                repo_id: file.repo_id,
                filepath: file.path,
                filename: file.filename,
                local_folder: file.local_folder,
            };
            this._startPolling();
        }
        return d;
    }

    async cancelDownload(tid) {
        await fetch(`/modeldownloader/download/${tid}`,{method:"DELETE"});
        if (S.downloads[tid]) S.downloads[tid].status="cancelled";
        this._renderDlBar();
    }

    // ── Search ─────────────────────────────────────────────────────────────────

    _onSearch() {
        S.hfSearchResults = null;
        const q = S.searchQuery.trim();

        // LOCAL mode: just filter in place
        if (S.browseMode === MODE_LOCAL) {
            S.fileSearchResults = null;
            this._renderLeft();
            if (S.localCategory) this._renderLocalFiles(S.localCategory);
            return;
        }

        // WORKFLOW mode: just filter in place
        if (S.browseMode === MODE_WORKFLOW) {
            S.fileSearchResults = null;
            this._renderLeft();
            if (S.githubWorkflowFiles) this._renderGithubWorkflows(S.githubWorkflowFiles);
            return;
        }

        // Empty query → clear search, go back to normal view
        if (!q) {
            S.fileSearchResults = null;
            this._renderLeft();
            if (S.selectedRepo && S.repoFiles[S.selectedRepo])
                this._renderFileList(S.repoFiles[S.selectedRepo]);
            else this._showPlaceholder(true);
            return;
        }

        // Otherwise auto-search across all repos
        this._triggerFileSearch();
    }

    async _triggerFileSearch() {
        const q = S.searchQuery.trim();
        if (q.length < 2) return;

        this._showPlaceholder(false);
        this.fileListEl.innerHTML=`<div style="padding:30px;text-align:center;color:#555">
            Searching file names for <b style="color:#7ec8e3">"${q}"</b>…<br>
            <small style="color:#333">Loading uncached repos — this may take a moment</small></div>`;

        S.fileSearchPending = true;
        try {
            const r = await fetch(`/modeldownloader/search_files?q=${encodeURIComponent(q)}`);
            S.fileSearchResults = await r.json();
        } catch(e) {
            S.fileSearchResults = [];
        }
        S.fileSearchPending = false;

        if (!S.fileSearchResults.length) {
            this._renderLeft();
            this.fileListEl.innerHTML=`<div style="padding:30px;color:#555;text-align:center">
                No files found for <b style="color:#7ec8e3">"${q}"</b><br>
                <small style="color:#333">Try 🌐 Search HuggingFace to discover new repos.</small></div>`;
            return;
        }

        // Show matching repos in left panel; auto-open the first one
        this._renderLeft();
        const firstRepoId = S.fileSearchResults[0].repo_id;
        this.loadRepoFiles(firstRepoId, /*keepFileSearch=*/true);
        // Highlight the auto-selected repo in left panel
        setTimeout(()=>{
            const it=this.leftList.querySelector(`[data-repo-item="${firstRepoId}"]`);
            if (it) { it.style.background="#1e3a5f"; it.scrollIntoView({block:"nearest"}); }
        },80);
    }

    async _triggerHFSearch() {
        const q = S.searchQuery.trim();
        if (q.length < 2) { alert("Type at least 2 characters for HuggingFace search."); return; }

        this.leftStatus.textContent = `Searching HF for "${q}"…`;
        this.leftStatus.style.display = "block";
        try {
            const r  = await fetch(`/modeldownloader/hf_search?q=${encodeURIComponent(q)}`);
            S.hfSearchResults = await r.json();
        } catch(e) {
            S.hfSearchResults = [];
        }
        this.leftStatus.style.display = "none";
        this._renderHFSearchResults(S.hfSearchResults, q);
    }

    // ── Left panel ─────────────────────────────────────────────────────────────

    _renderLeft() {
        if (S.hfSearchResults !== null) {
            this._renderHFSearchResults(S.hfSearchResults, S.searchQuery.trim());
            return;
        }
        if (S.fileSearchResults !== null) {
            this._renderFileSearchLeft();
            return;
        }
        if      (S.browseMode===MODE_REPO)     this._renderRepoList();
        else if (S.browseMode===MODE_MODEL)    this._renderModelList();
        else if (S.browseMode===MODE_WORKFLOW) this._renderWorkflowSources();
        else if (S.browseMode===MODE_LOCAL)    this._renderLocalLeft();
    }

    /** Left panel for file search: repos that contain matching files */
    _renderFileSearchLeft() {
        this.leftList.innerHTML="";
        const byRepo={};
        for (const f of S.fileSearchResults)
            (byRepo[f.repo_id]=byRepo[f.repo_id]||[]).push(f);

        const repoIds = Object.keys(byRepo);
        this.leftList.appendChild(this._secHead(
            `🔍 "${S.searchQuery}" — ${repoIds.length} repo${repoIds.length!==1?"s":""}`));

        const clearBtn = el("div",{
            style:{padding:"5px 14px 8px",cursor:"pointer",color:"#445",fontSize:"11px",
                borderBottom:"1px solid #1e1e2e"},
            onclick:()=>{
                S.fileSearchResults=null;
                this._renderLeft();
                if (S.selectedRepo && S.repoFiles[S.selectedRepo])
                    this._renderFileList(S.repoFiles[S.selectedRepo]);
                else this._showPlaceholder(true);
            }
        },["✕ Clear file search"]);
        clearBtn.addEventListener("mouseenter",()=>{ clearBtn.style.color="#7ec8e3"; });
        clearBtn.addEventListener("mouseleave",()=>{ clearBtn.style.color="#445"; });
        this.leftList.appendChild(clearBtn);

        for (const repoId of repoIds) {
            const count = byRepo[repoId].length;
            const known = S.repos.find(r=>r.id===repoId);
            const repo = known || {
                id: repoId,
                name: repoId.split("/").pop(),
                author: repoId.split("/")[0],
                model_family: "",
            };
            const isSelected = S.selectedRepo===repoId;
            const item = el("div",{
                "data-repo-item": repoId,
                style:{padding:"8px 14px",cursor:"pointer",borderBottom:"1px solid #1a1a2a",
                    background:isSelected?"#1e3a5f":"transparent",transition:"background 0.12s"},
            });
            const row=el("div",{style:{display:"flex",alignItems:"center",gap:"6px"}});
            row.appendChild(el("span",{style:{flex:"1",color:"#c8d6e5",fontSize:"12px",wordBreak:"break-word"}},[repo.name]));
            row.appendChild(el("span",{style:{fontSize:"10px",color:"#4a9eff",background:"#0d1f3a",
                padding:"1px 6px",borderRadius:"10px",whiteSpace:"nowrap"}},[`${count} file${count!==1?"s":""}`]));
            item.appendChild(row);
            item.appendChild(el("div",{style:{fontSize:"10px",color:"#445",marginTop:"1px"}},[repo.author]));
            item.addEventListener("mouseenter",()=>{ if(S.selectedRepo!==repoId) item.style.background="#1a2a3a"; });
            item.addEventListener("mouseleave",()=>{ if(S.selectedRepo!==repoId) item.style.background=isSelected?"#1e3a5f":"transparent"; });
            item.addEventListener("click",()=>{
                this.leftList.querySelectorAll("[data-repo-item]").forEach(e=>e.style.background="transparent");
                item.style.background="#1e3a5f";
                this.loadRepoFiles(repoId, /*keepFileSearch=*/true);
            });
            this.leftList.appendChild(item);
        }
    }

    /** Classic grouped-by-author repo list with collapsible sections */
    _renderRepoList() {
        this.leftList.innerHTML="";
        const q  = S.searchQuery.toLowerCase();
        const af = S.authorFilter;
        const cf = S.catFilter;
        const filtered = S.repos.filter(r=>
            (af==="all"||r.author===af) &&
            (!q || r.name.toLowerCase().includes(q)||r.id.toLowerCase().includes(q)) &&
            repoMatchesCategory(r, cf)
        );
        const byAuthor={};
        for (const r of filtered) (byAuthor[r.author]=byAuthor[r.author]||[]).push(r);

        for (const [author, repos] of Object.entries(byAuthor)) {
            const collapsed = S.collapsedAuthors.has(author);

            // Clickable section header
            const head = el("div",{
                style:{padding:"7px 12px 5px",fontSize:"10px",fontWeight:"700",
                    color:"#7ec8e3",textTransform:"uppercase",letterSpacing:"0.8px",
                    borderBottom:"1px solid #1e1e2e",marginTop:"6px",
                    cursor:"pointer",display:"flex",alignItems:"center",gap:"6px",
                    userSelect:"none"},
            });
            head.appendChild(el("span",{style:{fontSize:"11px",transition:"transform 0.15s",
                transform:collapsed?"rotate(-90deg)":"rotate(0deg)"}},["▾"]));
            head.appendChild(el("span",{},[`${author} (${repos.length})`]));
            head.addEventListener("click",()=>{
                if (S.collapsedAuthors.has(author)) S.collapsedAuthors.delete(author);
                else S.collapsedAuthors.add(author);
                this._renderRepoList();
            });
            this.leftList.appendChild(head);

            if (!collapsed) {
                for (const repo of repos) this.leftList.appendChild(this._repoItem(repo));
            }
        }
        if (!filtered.length) this.leftList.appendChild(
            el("div",{style:{padding:"20px",color:"#333",textAlign:"center"}},["No repos found"])
        );
    }

    /**
     * "By Model" view — flat list of ALL repos sorted latest-first.
     * No "Other" grouping; every repo shown with its family badge.
     */
    _renderModelList() {
        this.leftList.innerHTML="";
        const q  = S.searchQuery.toLowerCase();
        const af = S.authorFilter;
        const cf = S.catFilter;
        const filtered = S.repos.filter(r=>
            (af==="all"||r.author===af) &&
            (!q || r.name.toLowerCase().includes(q)||r.id.toLowerCase().includes(q)||
             (r.model_family||"").toLowerCase().includes(q)) &&
            repoMatchesCategory(r, cf)
        );

        if (!filtered.length) {
            this.leftList.appendChild(el("div",{
                style:{padding:"20px",color:"#333",textAlign:"center"}},["No models found"]));
            return;
        }

        this.leftList.appendChild(this._secHead(`All Models (${filtered.length}) — latest first`));
        for (const repo of filtered)    // already sorted latest-first from backend
            this.leftList.appendChild(this._repoItem(repo, /*showAuthor=*/true));
    }

    /** Workflow sources — GitHub only (ComfyOrg + Kijai) */
    _renderWorkflowSources() {
        this.leftList.innerHTML="";
        this.leftList.appendChild(this._secHead("GitHub Workflow Examples"));

        const sources = [
            {
                group: "comfyorg",
                icon: "🧩",
                title: "Comfy-Org Workflows",
                subtitle: "Blueprints & examples from comfyanonymous",
            },
            {
                group: "kijai",
                icon: "⚙️",
                title: "Kijai Example Workflows",
                subtitle: "WanVideoWrapper example workflows",
            },
        ];

        for (const src of sources) {
            const key = `__github__${src.group}`;
            const isSelected = S.selectedRepo === key;
            const item = el("div",{
                style:{padding:"9px 14px",cursor:"pointer",borderBottom:"1px solid #1a1a2a",
                    background:isSelected?"#1e3a5f":"transparent",
                    display:"flex",alignItems:"center",gap:"8px",transition:"background 0.12s"},
            });
            item.appendChild(el("span",{style:{fontSize:"15px"}},[src.icon]));
            const info=el("div",{style:{flex:"1"}});
            info.appendChild(el("div",{style:{color:"#c8d6e5",fontWeight:"600",fontSize:"12px"}},[src.title]));
            info.appendChild(el("div",{style:{color:"#445",fontSize:"10px"}},[src.subtitle]));
            item.appendChild(info);
            item.addEventListener("mouseenter",()=>{ if(S.selectedRepo!==key) item.style.background="#1a2a3a"; });
            item.addEventListener("mouseleave",()=>{ if(S.selectedRepo!==key) item.style.background=S.selectedRepo===key?"#1e3a5f":"transparent"; });
            item.addEventListener("click",()=>{
                this.leftList.querySelectorAll("div[style]").forEach(e=>{
                    if(e.style.background==="rgb(30, 58, 95)") e.style.background="transparent";
                });
                item.style.background="#1e3a5f";
                this.loadGithubWorkflows(src.group);
            });
            this.leftList.appendChild(item);
        }
    }

    /** Downloaded tab — left panel: category list with counts */
    _renderLocalLeft() {
        this.leftList.innerHTML="";
        this.leftList.appendChild(this._secHead("💾 Downloaded Models"));
        const q = S.searchQuery.toLowerCase();
        for (const [cat, files] of Object.entries(S.localModels)) {
            const filtered = q ? files.filter(f=>f.toLowerCase().includes(q)) : files;
            if (!filtered.length) continue;
            const isSelected = S.localCategory===cat;
            const item=el("div",{
                style:{padding:"8px 14px",cursor:"pointer",borderBottom:"1px solid #1a1a2a",
                    background:isSelected?"#1e3a5f":"transparent",
                    display:"flex",alignItems:"center",gap:"8px",transition:"background 0.12s"},
            });
            item.appendChild(el("span",{style:{fontSize:"13px"}},[CAT_ICON[cat]||"📄"]));
            item.appendChild(el("span",{style:{flex:"1",color:"#c8d6e5",fontSize:"12px"}},[cat.replace(/_/g," ")]));
            item.appendChild(el("span",{style:{fontSize:"10px",color:"#4a9eff",background:"#0d1f3a",
                padding:"1px 6px",borderRadius:"10px"}},[String(filtered.length)]));
            item.addEventListener("mouseenter",()=>{ if(S.localCategory!==cat) item.style.background="#1a2a3a"; });
            item.addEventListener("mouseleave",()=>{ if(S.localCategory!==cat) item.style.background="transparent"; });
            item.addEventListener("click",()=>{
                this.leftList.querySelectorAll("[data-local-cat]").forEach(e=>e.style.background="transparent");
                item.style.background="#1e3a5f";
                S.localCategory=cat;
                this._renderLocalFiles(cat);
            });
            item.setAttribute("data-local-cat",cat);
            this.leftList.appendChild(item);
        }
    }

    /** Downloaded tab — right panel: files with size + delete button */
    _renderLocalFiles(cat) {
        this.fileListEl.innerHTML="";
        const allFiles = S.localModels[cat]||[];
        const q = S.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
        const files = q.length
            ? allFiles.filter(f=>{ const t=f.toLowerCase().replace(/[_\-\.]/g," "); return q.every(w=>t.includes(w)||f.toLowerCase().includes(w)); })
            : allFiles;

        const sticky=el("div",{style:{padding:"10px 16px",background:"#10101c",borderBottom:"1px solid #1e1e2e",
            display:"flex",alignItems:"center",position:"sticky",top:"0",zIndex:"10"}});
        sticky.appendChild(el("span",{style:{fontWeight:"700",color:"#7ec8e3",flex:"1",fontSize:"13px"}},
            [`${CAT_ICON[cat]||"📄"} ${cat.replace(/_/g," ")} (${files.length})`]));
        this.fileListEl.appendChild(sticky);

        if (!files.length) {
            this.fileListEl.appendChild(el("div",{style:{padding:"30px",color:"#333",textAlign:"center"}},["No files found."]));
            return;
        }

        for (const filename of [...files].sort()) {
            const row=el("div",{style:{padding:"8px 16px",borderBottom:"1px solid #14141f",
                display:"flex",alignItems:"center",gap:"10px",transition:"background 0.1s"}});
            row.addEventListener("mouseenter",()=>{ row.style.background="#151525"; });
            row.addEventListener("mouseleave",()=>{ row.style.background="transparent"; });

            row.appendChild(el("span",{style:{fontSize:"13px",minWidth:"18px"}},["✅"]));

            const nameEl=el("div",{style:{flex:"1",color:"#86efac",fontSize:"13px",
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},
                [filename]);
            row.appendChild(nameEl);

            // 📂 Open folder button
            const folderBtn=btn("📂",
                {background:"none",border:"1px solid #2a2a3a",color:"#7ec8e3",
                    padding:"3px 7px",fontSize:"12px",title:"Open containing folder"},
                async()=>{
                    folderBtn.style.opacity="0.5";
                    try {
                        const resp=await fetch(`/modeldownloader/open_folder?folder=${encodeURIComponent(cat)}&file=${encodeURIComponent(filename)}`);
                        if (!resp.ok) { const d=await resp.json().catch(()=>({})); alert("Could not open folder: "+(d.error||resp.statusText)); }
                    } catch(e){ alert("Could not open folder: "+e.message); }
                    setTimeout(()=>{ folderBtn.style.opacity="1"; },600);
                });
            row.appendChild(folderBtn);

            const delBtn=btn("🗑 Delete",
                {background:"#3d0f0f",border:"1px solid #7c2020",color:"#f87171",
                    padding:"4px 10px",fontSize:"11px",whiteSpace:"nowrap"},
                async()=>{
                    if (!confirm(`Delete "${filename}" from ${cat}?\nThis cannot be undone.`)) return;
                    delBtn.disabled=true; delBtn.textContent="Deleting…";
                    try {
                        const resp=await fetch(`/modeldownloader/model?folder=${encodeURIComponent(cat)}&file=${encodeURIComponent(filename)}`,{method:"DELETE"});
                        const d=await resp.json();
                        if (d.ok) {
                            S.localModels[cat]=(S.localModels[cat]||[]).filter(f=>f!==filename);
                            if (!S.localModels[cat].length) delete S.localModels[cat];
                            this._renderLocalLeft();
                            this._renderLocalFiles(cat);
                        } else { alert("Delete failed: "+(d.error||"unknown error")); delBtn.disabled=false; delBtn.textContent="🗑 Delete"; }
                    } catch(e){ alert("Delete failed: "+e.message); delBtn.disabled=false; delBtn.textContent="🗑 Delete"; }
                });
            row.appendChild(delBtn);
            this.fileListEl.appendChild(row);
        }
    }

    _secHead(txt) {
        return el("div",{
            style:{padding:"7px 12px 3px",fontSize:"10px",fontWeight:"700",
                color:"#7ec8e3",textTransform:"uppercase",letterSpacing:"0.8px",
                borderBottom:"1px solid #1e1e2e",marginTop:"6px"}},
            [txt]);
    }

    _repoItem(repo, showAuthor=false, forceWorkflows=false) {
        const isSelected = S.selectedRepo===repo.id;
        const item = el("div",{
            style:{padding:"8px 14px",cursor:"pointer",borderBottom:"1px solid #1a1a2a",
                background:isSelected?"#1e3a5f":"transparent",
                transition:"background 0.12s"},
        });

        const row = el("div",{style:{display:"flex",alignItems:"center",gap:"6px"}});
        row.appendChild(el("span",{style:{flex:"1",color:"#c8d6e5",fontSize:"12px",wordBreak:"break-word"}},
            [repo.name]));

        if (repo.model_family) {
            const fam = repo.model_family;
            row.appendChild(el("span",{
                style:{fontSize:"9px",padding:"1px 5px",background:"#1a3a5f",
                    color:"#7ec8e3",border:"1px solid #2a5a8f",borderRadius:"4px",whiteSpace:"nowrap"},
            },[fam]));
        }

        // HuggingFace link button
        const hfUrl = repo.id.startsWith("github:")
            ? `https://github.com/${repo.id.replace("github:","")}`
            : `https://huggingface.co/${repo.id}`;
        const linkBtn = el("a", {
            href: hfUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            title: "Open on HuggingFace",
            style: {
                fontSize:"12px", color:"#445", textDecoration:"none", lineHeight:"1",
                padding:"2px 4px", borderRadius:"3px", flexShrink:"0",
                transition:"color 0.1s",
            },
        }, ["🔗"]);
        linkBtn.addEventListener("mouseenter", ()=>{ linkBtn.style.color="#7ec8e3"; });
        linkBtn.addEventListener("mouseleave", ()=>{ linkBtn.style.color="#445"; });
        // Prevent the link click from also triggering the repo load
        linkBtn.addEventListener("click", e=>e.stopPropagation());
        row.appendChild(linkBtn);

        item.appendChild(row);

        if (showAuthor) {
            item.appendChild(el("div",{style:{fontSize:"10px",color:"#445",marginTop:"1px"}},
                [repo.author]));
        }

        item.setAttribute("data-repo-item",repo.id);
        item.addEventListener("mouseenter",()=>{ if(S.selectedRepo!==repo.id) item.style.background="#1a2a3a"; });
        item.addEventListener("mouseleave",()=>{ if(S.selectedRepo!==repo.id) item.style.background="transparent"; });
        item.addEventListener("click",()=>{
            this.leftList.querySelectorAll("[data-repo-item]").forEach(e=>e.style.background="transparent");
            item.style.background="#1e3a5f";
            if (forceWorkflows) {
                const prevWf = S.showWorkflows;
                S.showWorkflows = true;
                this.loadRepoFiles(repo.id).then(()=>{ if(!prevWf) S.showWorkflows=false; });
            } else {
                this.loadRepoFiles(repo.id);
            }
        });
        return item;
    }

    // ── Right panel: file list ─────────────────────────────────────────────────

    _renderFileList(files) {
        this.fileListEl.innerHTML="";
        const cf = S.catFilter;
        const q  = S.searchQuery.toLowerCase();

        // Only filter files by search query when browsing a repo normally (not during HF search)
        // Normalize query: replace non-alphanumeric with space, split into words
        const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g," ");
        const words = S.hfSearchResults === null
            ? normalize(q).split(/\s+/).filter(Boolean)
            : [];

        const fileMatch = f => {
            if (!words.length) return true;
            const raw  = (f.filename + " " + f.path).toLowerCase();
            const norm = normalize(raw);
            return words.every(w => norm.includes(w) || raw.includes(w));
        };

        let filtered;
        if (S.browseMode===MODE_WORKFLOW) {
            filtered = files.filter(f=>f.file_type==="workflow");
        } else {
            filtered = files.filter(f=>
                (cf==="all"||f.category===cf) &&
                fileMatch(f) &&
                (S.showWorkflows ? true : f.file_type!=="workflow"||cf==="workflows")
            );
        }

        if (!filtered.length) {
            this.fileListEl.appendChild(el("div",{
                style:{padding:"30px",color:"#333",textAlign:"center"}},
                ["No files match the current filter."]));
            return;
        }

        // Sticky header
        const dlCount = filtered.filter(f=>f.downloaded).length;
        const sticky = el("div",{
            style:{padding:"10px 16px",background:"#10101c",borderBottom:"1px solid #1e1e2e",
                display:"flex",alignItems:"center",position:"sticky",top:"0",zIndex:"10"}});
        sticky.appendChild(el("span",{style:{fontWeight:"700",color:"#7ec8e3",flex:"1",fontSize:"13px"}},[S.selectedRepo||""]));
        sticky.appendChild(el("span",{style:{fontSize:"11px",color:"#445"}},[`${dlCount}/${filtered.length} downloaded`]));
        this.fileListEl.appendChild(sticky);

        // Companion warnings
        const warns = this._detectMissing(files);
        if (warns.length) {
            const wb=el("div",{style:{margin:"10px 14px 0",padding:"10px 14px",
                background:"#2d1b00",border:"1px solid #7c4a03",borderRadius:"8px",
                color:"#fbbf24",fontSize:"12px"}});
            wb.appendChild(el("div",{style:{fontWeight:"700",marginBottom:"4px"}},["⚠ Missing companion files:"]));
            for (const w of warns) wb.appendChild(el("div",{style:{paddingLeft:"10px"}},[`• ${w}`]));
            this.fileListEl.appendChild(wb);
        }

        // Group by category
        const byCat={};
        for (const f of filtered) (byCat[f.category]=byCat[f.category]||[]).push(f);
        const cats=[...CAT_ORDER.filter(c=>byCat[c]),...Object.keys(byCat).filter(c=>!CAT_ORDER.includes(c))];

        for (const cat of cats) {
            const col=CAT_COLOR[cat]||"#888";
            this.fileListEl.appendChild(el("div",{
                style:{padding:"5px 16px 3px",fontSize:"10px",fontWeight:"700",
                    color:col,background:"#0e0e1a",borderTop:"1px solid #1a1a2a",
                    borderBottom:"1px solid #1a1a2a",marginTop:"6px",
                    textTransform:"uppercase",letterSpacing:"0.5px"}},
                [`${CAT_ICON[cat]||"📄"}  ${cat.replace(/_/g," ")}`]));
            for (const f of byCat[cat]) this.fileListEl.appendChild(this._fileRow(f));
        }
    }

    /** GitHub workflow list (separate render, all in "workflows" category) */
    _renderGithubWorkflows(files) {
        this.fileListEl.innerHTML="";
        const q = S.searchQuery.toLowerCase();

        // Group by label (repo source)
        const byLabel={};
        for (const f of files) {
            if (q && !f.filename.toLowerCase().includes(q) && !f.path.toLowerCase().includes(q)) continue;
            (byLabel[f.label]=byLabel[f.label]||[]).push(f);
        }

        const sticky = el("div",{
            style:{padding:"10px 16px",background:"#10101c",borderBottom:"1px solid #1e1e2e",
                display:"flex",alignItems:"center",position:"sticky",top:"0",zIndex:"10"}});
        sticky.appendChild(el("span",{style:{fontWeight:"700",color:"#f472b6",flex:"1",fontSize:"13px"}},
            ["GitHub Workflow Files"]));
        const total = Object.values(byLabel).flat();
        const dlC   = total.filter(f=>f.downloaded).length;
        sticky.appendChild(el("span",{style:{fontSize:"11px",color:"#445"}},[`${dlC}/${total.length} downloaded`]));
        this.fileListEl.appendChild(sticky);

        for (const [label, labelFiles] of Object.entries(byLabel)) {
            this.fileListEl.appendChild(el("div",{
                style:{padding:"5px 16px 3px",fontSize:"10px",fontWeight:"700",color:"#f472b6",
                    background:"#0e0e1a",borderTop:"1px solid #1a1a2a",
                    borderBottom:"1px solid #1a1a2a",marginTop:"6px",textTransform:"uppercase",
                    letterSpacing:"0.5px"}},
                [`📋  ${label}`]));
            for (const f of labelFiles) this.fileListEl.appendChild(this._fileRow(f));
        }

        if (!Object.keys(byLabel).length) {
            this.fileListEl.appendChild(el("div",{style:{padding:"20px",color:"#333",textAlign:"center"}},
                ["No workflows match search."]));
        }
    }

    /** File search results panel */
    _renderFileSearchResults(files, query) {
        this.fileListEl.innerHTML="";

        const sticky = el("div",{
            style:{padding:"10px 16px",background:"#10101c",borderBottom:"1px solid #1e1e2e",
                display:"flex",alignItems:"center",gap:"10px",
                position:"sticky",top:"0",zIndex:"10"}});
        sticky.appendChild(el("span",{style:{fontWeight:"700",color:"#7ec8e3",flex:"1",fontSize:"13px"}},
            [`🔍 File search: "${query}"`]));
        sticky.appendChild(el("span",{style:{fontSize:"11px",color:"#445"}},[`${files.length} files found`]));
        const clearBtn = btn("✕ Clear",{fontSize:"11px"},()=>{
            S.fileSearchResults=null;
            if (S.selectedRepo && S.repoFiles[S.selectedRepo])
                this._renderFileList(S.repoFiles[S.selectedRepo]);
            else
                this._showPlaceholder(true);
        });
        sticky.appendChild(clearBtn);
        this.fileListEl.appendChild(sticky);

        if (!files.length) {
            this.fileListEl.appendChild(el("div",{style:{padding:"30px",color:"#555",textAlign:"center"}},
                ["No files found matching \""+query+"\"\n\nTry 🌐 Search HuggingFace to discover new repos."]));
            return;
        }

        // Group by repo
        const byRepo={};
        for (const f of files) (byRepo[f.repo_id]=byRepo[f.repo_id]||[]).push(f);

        for (const [repoId, repoFiles] of Object.entries(byRepo)) {
            const dlC = repoFiles.filter(f=>f.downloaded).length;
            const rHdr = el("div",{
                style:{padding:"7px 16px",background:"#12122a",borderTop:"1px solid #1e1e2e",
                    borderBottom:"1px solid #1e1e2e",display:"flex",alignItems:"center",gap:"10px",
                    cursor:"pointer",marginTop:"6px"},
            });
            rHdr.appendChild(el("span",{style:{color:"#7ec8e3",fontWeight:"600",fontSize:"12px",flex:"1"}},[repoId]));
            rHdr.appendChild(el("span",{style:{color:"#445",fontSize:"10px"}},[`${dlC}/${repoFiles.length}`]));
            const openBtn = btn("Open Repo",{fontSize:"10px",padding:"3px 8px"},()=>{
                // Switch to repo mode and open this repo
                S.browseMode=MODE_REPO;
                this.modeSelect.value=MODE_REPO;
                this._renderLeft();
                this.loadRepoFiles(repoId);
                setTimeout(()=>{
                    const it=this.leftList.querySelector(`[data-repo-item="${repoId}"]`);
                    if (it) { it.scrollIntoView({block:"nearest"}); it.click(); }
                },100);
            });
            rHdr.appendChild(openBtn);
            this.fileListEl.appendChild(rHdr);

            // Apply local flags
            this._applyLocalFlagsToList(repoFiles);
            for (const f of repoFiles) this.fileListEl.appendChild(this._fileRow(f));
        }
    }

    /** HuggingFace live search results added to left panel */
    _renderHFSearchResults(repos, query) {
        this.leftList.innerHTML="";
        const cf = S.catFilter;
        const filtered = repos.filter(r => repoMatchesCategory(r, cf));
        this.leftList.appendChild(this._secHead(`🌐 HF search: "${query}" (${filtered.length}${filtered.length!==repos.length?` of ${repos.length}`:""})`));
        if (!filtered.length) {
            this.leftList.appendChild(el("div",{style:{padding:"16px",color:"#445",fontSize:"12px"}},
                [cf==="all" ? "No repos found on HuggingFace." : `No ${cf.replace(/_/g," ")} repos found.`]));
            return;
        }
        for (const repo of filtered) this.leftList.appendChild(this._repoItem(repo, true));
    }

    // ── File row ───────────────────────────────────────────────────────────────

    _fileRow(f) {
        const activeDl = Object.values(S.downloads).find(d=>
            d.repo_id===f.repo_id && d.filepath===f.path &&
            ["queued","downloading"].includes(d.status));

        const rowBg = activeDl ? "#142a4a" : "transparent";
        const rowBorder = activeDl ? "1px solid #2a5a8f" : "1px solid #14141f";
        const row = el("div",{
            "data-file-row":f.path,
            style:{padding:"7px 16px",borderBottom:rowBorder,
                display:"flex",alignItems:"center",gap:"9px",transition:"background 0.1s",
                background:rowBg}});
        row.addEventListener("mouseenter",()=>{ row.style.background=activeDl?"#1a3a60":"#151525"; });
        row.addEventListener("mouseleave",()=>{ row.style.background=rowBg; });

        // Status icon
        const si=el("span",{style:{fontSize:"14px",minWidth:"18px",textAlign:"center"}});
        if      (f.downloaded){ si.textContent="✅"; si.title="Downloaded — click filename to open folder"; }
        else if (activeDl)    { si.textContent="⏬"; si.title="In progress"; }
        else                  { si.textContent="⬜"; si.title="Not downloaded"; }
        row.appendChild(si);

        // Info block
        const info=el("div",{style:{flex:"1",minWidth:"0"}});

        // Filename — clickable when downloaded to open folder
        const nameEl=el("div",{
            style:{
                color:f.downloaded?"#86efac":"#c8d6e5",
                fontSize:"13px",fontWeight:f.downloaded?"600":"400",
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                cursor:f.downloaded?"pointer":"default",
            },
        },[f.filename]);
        if (f.downloaded) {
            nameEl.title="📂 Click to open containing folder";
            nameEl.addEventListener("click", async()=>{
                nameEl.style.opacity="0.6";
                try {
                    const resp = await fetch(`/modeldownloader/open_folder?folder=${encodeURIComponent(f.local_folder)}&file=${encodeURIComponent(f.filename)}`);
                    if (!resp.ok) {
                        const d = await resp.json().catch(()=>({}));
                        alert("Could not open folder: " + (d.error || resp.statusText));
                    }
                } catch(e){ alert("Could not open folder: " + e.message); }
                setTimeout(()=>{ nameEl.style.opacity="1"; }, 600);
            });
        }
        info.appendChild(nameEl);

        // Sub-path (folder within repo)
        const sub=f.path.includes("/")?f.path.split("/").slice(0,-1).join("/"):"";
        if (sub) info.appendChild(el("div",{style:{color:"#333",fontSize:"10px"}},[sub+"/"]));

        // Destination badge
        const col=CAT_COLOR[f.local_folder]||"#888";
        const dest=f.file_type==="workflow"?"→ workflows/": `→ models/${f.local_folder}/`;
        info.appendChild(el("span",{
            style:{fontSize:"10px",padding:"1px 5px",background:col+"22",color:col,
                border:`1px solid ${col}44`,borderRadius:"4px",marginTop:"2px",display:"inline-block"}},
            [dest]));
        row.appendChild(info);

        // File size — shown prominently
        const sizeVal = fmt(f.size);
        row.appendChild(el("span",{
            style:{
                color: f.size ? "#7ec8e3" : "#333",
                fontSize:"12px",minWidth:"62px",textAlign:"right",fontVariantNumeric:"tabular-nums",
            },
        },[sizeVal]));

        // ── Action area ──────────────────────────────────────────────────────

        if (activeDl) {
            // Show progress bar + stop button for BOTH queued and downloading
            const isDownloading = activeDl.status==="downloading";
            const pct = activeDl.progress||0;

            if (isDownloading) {
                row.appendChild(el("span",{
                    style:{fontSize:"11px",padding:"3px 8px",background:"#1a4a7a",
                        border:"1px solid #4a9eff",borderRadius:"6px",color:"#7ec8e3",
                        whiteSpace:"nowrap",fontWeight:"600"}},["⬇ Downloading"]));
                const wrap=el("div",{style:{minWidth:"80px",background:"#1a1a2a",borderRadius:"4px",height:"6px",overflow:"hidden"}});
                wrap.appendChild(el("div",{
                    className:"mdd-prog","data-tid":activeDl.task_id,
                    style:{height:"100%",width:`${pct}%`,
                        background:"linear-gradient(90deg,#4a9eff,#7ec8e3)",transition:"width 0.3s"}}));
                const pctEl=el("span",{
                    className:"mdd-pct","data-tid":activeDl.task_id,
                    style:{fontSize:"10px",color:"#7ec8e3",minWidth:"32px",textAlign:"right"}},
                    [`${Math.round(pct)}%`]);
                row.appendChild(wrap);
                row.appendChild(pctEl);
            } else {
                row.appendChild(el("span",{
                    style:{fontSize:"11px",padding:"3px 8px",background:"#2a1a00",
                        border:"1px solid #fbbf24",borderRadius:"6px",color:"#fbbf24",
                        whiteSpace:"nowrap",fontWeight:"600"}},["⏳ Queued"]));
            }

            // Stop button — always shown for active downloads
            const stopBtn=btn("⏹ Stop",
                {background:"#3d0f0f",border:"1px solid #7c2020",color:"#f87171",
                    padding:"4px 10px",whiteSpace:"nowrap"},
                ()=>this.cancelDownload(activeDl.task_id));
            row.appendChild(stopBtn);

        } else if (!f.downloaded) {
            const dlBtn=btn("⬇ Download",
                {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3",whiteSpace:"nowrap"},
                async()=>{
                    dlBtn.disabled=true; dlBtn.textContent="⏳…";
                    dlBtn.style.opacity="0.5";
                    const result=await this.startDownload(f);
                    // re-render so the row immediately switches to progress+stop view
                    this._rerender();
                });
            dlBtn.addEventListener("mouseenter",()=>{ dlBtn.style.background="#1a5276"; });
            dlBtn.addEventListener("mouseleave",()=>{ dlBtn.style.background="#0f3460"; });
            row.appendChild(dlBtn);

        } else {
            // Downloaded — folder open hint
            const openBtn=btn("📂",
                {background:"none",border:"1px solid #2a2a3a",color:"#7ec8e3",
                    padding:"4px 8px",title:"Open folder"},
                async()=>{
                    openBtn.style.opacity="0.5";
                    try {
                        const resp = await fetch(`/modeldownloader/open_folder?folder=${encodeURIComponent(f.local_folder)}&file=${encodeURIComponent(f.filename)}`);
                        if (!resp.ok) {
                            const d = await resp.json().catch(()=>({}));
                            alert("Could not open folder: " + (d.error || resp.statusText));
                        }
                    } catch(e){ alert("Could not open folder: " + e.message); }
                    setTimeout(()=>{ openBtn.style.opacity="1"; },600);
                });
            openBtn.title="Open containing folder";
            row.appendChild(openBtn);
        }
        return row;
    }

    /** Re-render the current view (file list or search results). */
    _rerender() {
        if (S.githubWorkflowFiles) {
            this._renderGithubWorkflows(S.githubWorkflowFiles);
        } else if (S.selectedRepo && S.repoFiles[S.selectedRepo]) {
            this._renderFileList(S.repoFiles[S.selectedRepo]);
        }
    }

    // ── Download bar ───────────────────────────────────────────────────────────

    _renderDlBar() {
        this.dlInner.innerHTML="";
        const all=Object.values(S.downloads);
        if (!all.length) {
            this.dlInner.appendChild(el("span",{style:{color:"#222",fontSize:"11px"}},["No downloads yet"]));
            return;
        }
        for (const d of all.slice(-8).reverse()) {
            const row=el("div",{style:{display:"flex",alignItems:"center",gap:"7px",fontSize:"11px",padding:"2px 0"}});
            const sym={done:"✅",error:"❌",cancelled:"✕",downloading:"⬇",queued:"⏳"}[d.status]||"•";
            const col={done:"#4ade80",error:"#f87171",cancelled:"#fbbf24",downloading:"#7ec8e3",queued:"#aaa"}[d.status]||"#888";
            row.appendChild(el("span",{},[sym]));
            row.appendChild(el("span",{
                style:{color:"#c8d6e5",flex:"1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},
                [d.filename]));
            if (d.status==="downloading") {
                const pct=d.progress||0;
                const bar=el("div",{style:{width:"90px",background:"#1a1a2a",borderRadius:"3px",height:"5px",overflow:"hidden"}});
                bar.appendChild(el("div",{style:{height:"100%",width:`${pct}%`,background:"linear-gradient(90deg,#4a9eff,#7ec8e3)"}}));
                row.appendChild(bar);
                row.appendChild(el("span",{style:{color:col,minWidth:"32px"}},[`${Math.round(pct)}%`]));
                row.appendChild(el("span",{style:{color:"#445"}},[fmt(d.downloaded_bytes)+"/"+fmt(d.total_bytes)]));
                // Stop button in the dl bar
                const s=btn("⏹",{background:"#3d0f0f",border:"1px solid #7c2020",
                    color:"#f87171",padding:"1px 6px",fontSize:"11px"},
                    ()=>this.cancelDownload(d.task_id));
                row.appendChild(s);
            } else if (d.status==="queued") {
                row.appendChild(el("span",{style:{color:col,minWidth:"50px"}},["queued"]));
                const s=btn("⏹",{background:"#3d0f0f",border:"1px solid #7c2020",
                    color:"#f87171",padding:"1px 6px",fontSize:"11px"},
                    ()=>this.cancelDownload(d.task_id));
                row.appendChild(s);
            } else {
                row.appendChild(el("span",{style:{color:col}},[d.status]));
                if (d.error) row.appendChild(el("span",{style:{color:"#f87171",fontSize:"10px"}},[d.error.slice(0,55)]));
            }
            this.dlInner.appendChild(row);
        }
    }

    _refreshProgressBars() {
        for (const [tid,d] of Object.entries(S.downloads)) {
            const fill=this.fileListEl.querySelector(`.mdd-prog[data-tid="${tid}"]`);
            const pct =this.fileListEl.querySelector(`.mdd-pct[data-tid="${tid}"]`);
            if (fill) fill.style.width=`${d.progress||0}%`;
            if (pct)  pct.textContent=`${Math.round(d.progress||0)}%`;
        }
    }

    // ── Polling ────────────────────────────────────────────────────────────────

    _startPolling() {
        if (S.pollingInterval) return;
        S.pollingInterval=setInterval(()=>this._poll(),900);
    }

    async _poll() {
        const active=Object.values(S.downloads).filter(d=>["queued","downloading"].includes(d.status));
        if (!active.length) {
            clearInterval(S.pollingInterval); S.pollingInterval=null;
            const r=await fetch("/modeldownloader/local_models");
            S.localModels=await r.json();
            if (S.selectedRepo&&S.selectedRepo!=="__github__"&&S.repoFiles[S.selectedRepo])
                this._applyLocalFlags(S.repoFiles[S.selectedRepo]);
            if (S.fileSearchResults)
                this._applyLocalFlagsToList(S.fileSearchResults);
            this._rerender();
            this._renderDlBar();
            return;
        }
        try {
            const r=await fetch("/modeldownloader/downloads");
            const fresh=await r.json();
            // Merge preserving our locally-set repo_id/filepath fields
            for (const [tid,d] of Object.entries(fresh)) {
                S.downloads[tid]={...(S.downloads[tid]||{}), ...d};
            }
        } catch(_){}
        this._renderDlBar();
        this._rerender();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    _applyLocalFlags(files) {
        for (const f of files)
            f.downloaded=(S.localModels[f.local_folder]||[]).includes(f.filename);
    }

    _applyLocalFlagsToList(files) { this._applyLocalFlags(files); }

    _detectMissing(files) {
        const warns=[], byCat={};
        for (const f of files) (byCat[f.category]=byCat[f.category]||[]).push(f);
        const has=c=>(byCat[c]||[]).length>0;
        const anyDl=c=>(byCat[c]||[]).some(f=>f.downloaded);
        const local=c=>(S.localModels[c]||[]).length>0;
        if ((has("diffusion_models")||has("checkpoints"))&&(anyDl("diffusion_models")||anyDl("checkpoints"))) {
            if (has("text_encoders")&&!anyDl("text_encoders")&&!local("text_encoders"))
                warns.push("Text encoders not downloaded (required)");
            if (has("vae")&&!anyDl("vae")&&!local("vae"))
                warns.push("VAE not downloaded (required)");
            if (has("clip_vision")&&!anyDl("clip_vision")&&!local("clip_vision"))
                warns.push("CLIP Vision not downloaded (may be required)");
        }
        return warns;
    }

    _showPlaceholder(show=true) {
        this.placeholder.style.display = show?"flex":"none";
        this.fileListEl.style.display  = show?"none":"block";
    }

    show() {
        this.overlay.style.display="flex";
        this.visible=true;
        this.loadAll();
        this._renderDlBar();
    }

    hide() {
        this.overlay.style.display="none";
        this.visible=false;
    }
}

// ── Register extension ────────────────────────────────────────────────────────

let _dlg=null;
const getDialog=()=>{ if(!_dlg) _dlg=new ModelDownloaderDialog(); return _dlg; };

app.registerExtension({
    name:"ComfyUI.ModelDownloader",

    async setup() {
        try {
            const {ComfyButton}      = await import("/scripts/ui/components/button.js");
            const {ComfyButtonGroup} = await import("/scripts/ui/components/buttonGroup.js");
            const grp=new ComfyButtonGroup(
                new ComfyButton({
                    icon:"download",
                    action:()=>getDialog().show(),
                    tooltip:"Model Downloader (Ctrl+Shift+M)",
                    content:"Model Downloader",
                    classList:"comfyui-button comfyui-menu-mobile-collapse",
                }).element
            );
            const menu=document.querySelector(".comfy-menu");
            if (menu) { menu.append(document.createElement("hr")); menu.append(grp.element); }
        } catch(_) {
            const attach=()=>{
                const menu=document.querySelector(".comfy-menu");
                if (!menu) { setTimeout(attach,600); return; }
                const b=document.createElement("button");
                b.textContent="📥 Model Downloader";
                b.title="Open Model Downloader (Ctrl+Shift+M)";
                Object.assign(b.style,{
                    margin:"4px 0",padding:"6px 10px",width:"100%",
                    background:"linear-gradient(135deg,#0f3460,#16213e)",
                    border:"1px solid #1a5276",borderRadius:"8px",
                    color:"#7ec8e3",cursor:"pointer",fontWeight:"700",fontSize:"12px",
                });
                b.addEventListener("click",()=>getDialog().show());
                menu.appendChild(b);
            };
            attach();
        }
        document.addEventListener("keydown",e=>{
            if(e.ctrlKey&&e.shiftKey&&e.key==="M"){
                e.preventDefault();
                const d=getDialog(); d.visible?d.hide():d.show();
            }
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name!=="ModelDownloader") return;
        _patchMDNode(nodeType.prototype);
    },

    registerCustomNodes() {
        // Belt-and-suspenders: patch prototype after all types are registered
        const nt = LiteGraph.registered_node_types["model_management/ModelDownloader"];
        if (nt) _patchMDNode(nt.prototype);
    },

    nodeCreated(node) {
        if (node.comfyClass!=="ModelDownloader") return;
        _setupMDNodeInstance(node);
    },
});

function _patchMDNode(proto) {
    const orig = proto.onNodeCreated;
    proto.onNodeCreated = function() {
        orig?.call(this);
        _setupMDNodeInstance(this);
    };
    proto.onRemoved = function() {
        clearInterval(this._mdTimer);
    };
    proto.computeSize = function() { return [240, 145]; };
    proto.onDrawForeground = function(ctx) {
        if (this.flags?.collapsed) return;
        const s = this._mdStats || {};
        const lines = [
            ["🎨", "Diffusion / Checkpoints", s.diffusion || 0],
            ["📝", "Text Encoders",            s.text_encoders || 0],
            ["🔧", "VAE",                      s.vae || 0],
            ["💡", "LoRAs",                    s.loras || 0],
        ];
        const startY = 78, rowH = 17;
        ctx.save();
        ctx.font = "12px monospace";
        lines.forEach(([icon, label, count], i) => {
            const y = startY + i * rowH;
            ctx.fillStyle = "#aab";
            ctx.fillText(icon + " " + label, 10, y);
            ctx.fillStyle = count > 0 ? "#7ec8e3" : "#556";
            ctx.textAlign = "right";
            ctx.fillText(String(count), this.size[0] - 10, y);
            ctx.textAlign = "left";
        });
        ctx.restore();
    };
}

function _setupMDNodeInstance(node) {
    if (node._mdInitialized) return;
    node._mdInitialized = true;

    // Clear any auto-generated widgets; node has no Python inputs
    if (node.widgets && node.widgets.length > 0) node.widgets.length = 0;

    node.size = [240, 145];
    node._mdStats = { diffusion: 0, text_encoders: 0, vae: 0, loras: 0 };

    node.addWidget("button", "📥 Open Model Downloader", null, () => getDialog().show());

    const refreshStats = async () => {
        try {
            const r = await fetch("/modeldownloader/local_models");
            const local = await r.json();
            node._mdStats = {
                diffusion: (local.diffusion_models || []).length + (local.checkpoints || []).length,
                text_encoders: (local.text_encoders || []).length,
                vae: (local.vae || []).length,
                loras: (local.loras || []).length,
            };
            app.graph?.setDirtyCanvas(true, true);
        } catch(_) {}
    };
    refreshStats();
    node._mdTimer = setInterval(refreshStats, 8000);
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css=document.createElement("style");
css.textContent=`
.mdd-dialog *{box-sizing:border-box;}
.mdd-dialog input,.mdd-dialog select{outline:none;}
.mdd-dialog input:focus,.mdd-dialog select:focus{border-color:#4a9eff!important;}
.mdd-dialog ::-webkit-scrollbar{width:5px;height:5px;}
.mdd-dialog ::-webkit-scrollbar-track{background:#0d0d1a;}
.mdd-dialog ::-webkit-scrollbar-thumb{background:#2a2a4a;border-radius:3px;}
`;
document.head.appendChild(css);
