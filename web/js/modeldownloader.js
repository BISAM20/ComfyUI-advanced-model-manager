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

/**
 * POST JSON and return the parsed object.
 * Turns non-JSON error bodies (aiohttp's "404: Not Found" / "405: Method Not
 * Allowed", HTML error pages) into a readable message instead of a JSON.parse
 * crash — a 404/405 here means the backend routes predate this frontend.
 */
async function postJSON(url, body) {
    const r    = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch(_) {}
    if (data && typeof data === "object") return data;

    if (r.status === 404 || r.status === 405)
        throw new Error(`${url} is not registered (HTTP ${r.status}) — ` +
                        `restart ComfyUI so the server picks up the new backend routes.`);
    throw new Error(`Server returned HTTP ${r.status}: ${text.slice(0, 140)}`);
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

// Destinations offered when correcting where a pasted link should be saved
const DEST_FOLDERS = ["diffusion_models","checkpoints","text_encoders","clip_vision","vae",
                      "loras","controlnet","upscale_models","embeddings","hypernetworks",
                      "style_models","ipadapter","audio_encoders","photomaker","gligen",
                      "diffusers","workflows"];

const MODE_REPO = "repo", MODE_MODEL = "model", MODE_WORKFLOW = "workflow",
      MODE_LOCAL = "local", MODE_WFMODELS = "wfmodels";

const WF_GRAPH_KEY = "__graph__";

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
    folderTargets: null,              // [{folder, path}] a file can be moved into
    wfTemplates: null,                // ComfyUI template index
    wfSelected: null,                 // selected workflow source key
    wfTitle: "",                      // display name of that source
    workflowModelFiles: null,         // models detected in the selected workflow
    collapsedWfCats: new Set(),       // collapsed template categories
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

        this._buildLinkModal();
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
        addOpt(this.modeSelect, MODE_WFMODELS, "🧩 Workflow Models");
        addOpt(this.modeSelect, MODE_LOCAL,    "💾 Downloaded");
        this.modeSelect.addEventListener("change",async()=>{
            S.browseMode = this.modeSelect.value;
            S.selectedRepo = null;
            S.fileSearchResults = null;
            S.hfSearchResults = null;
            S.githubWorkflowFiles = null;
            S.workflowModelFiles = null;
            S.wfSelected = null;
            if (S.browseMode === MODE_WFMODELS) {
                await this._loadTemplateIndex();
                this._renderLeft();
                this._showPlaceholder(true);
            } else if (S.browseMode === MODE_LOCAL) {
                const r = await fetch("/modeldownloader/local_models");
                S.localModels = await r.json();
                await this._loadFolderTargets();
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
            type:"text",placeholder:"🔍  Filter repos…",
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

        // Paste-a-link button
        this.linkBtn = btn("🔗 Paste Link",
            {background:"#1f2f14",border:"1px solid #3d5c26",color:"#a3e635"},
            ()=>this._showLinkModal()
        );
        this.linkBtn.title = "Paste a HuggingFace / GitHub / direct link and download it to the right folder";
        tb.appendChild(this.linkBtn);

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
            if (S.browseMode===MODE_WFMODELS && S.workflowModelFiles)
                this._renderWorkflowModels(S.workflowModelFiles);
            else if (S.githubWorkflowFiles) this._renderGithubWorkflows(S.githubWorkflowFiles);
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

    // ── Paste-a-link modal ─────────────────────────────────────────────────────

    _buildLinkModal() {
        this.linkOverlay = el("div",{
            style:{position:"fixed",inset:"0",background:"rgba(0,0,0,0.6)",zIndex:"10000",
                display:"none",alignItems:"center",justifyContent:"center"},
        });
        this.linkOverlay.addEventListener("click",e=>{
            if (e.target===this.linkOverlay) this._hideLinkModal();
        });

        const box = el("div",{
            className:"mdd-dialog",
            style:{background:"#1a1a2e",color:"#e0e0e0",borderRadius:"12px",
                border:"1px solid #333",width:"min(760px,94vw)",maxHeight:"88vh",
                display:"flex",flexDirection:"column",fontFamily:"system-ui,sans-serif",
                fontSize:"13px",overflow:"hidden",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"},
        });

        // Header
        const h = el("div",{
            style:{padding:"12px 18px",borderBottom:"1px solid #2a2a3e",display:"flex",
                alignItems:"center",gap:"10px",background:"linear-gradient(135deg,#16213e,#0f3460)"},
        });
        h.appendChild(el("span",{style:{fontSize:"18px"}},["🔗"]));
        h.appendChild(el("span",{style:{fontWeight:"700",fontSize:"15px",color:"#fff",flex:"1"}},
            ["Download from Link"]));
        const x = el("button",{style:{background:"none",border:"1px solid #444",borderRadius:"6px",
            color:"#aaa",cursor:"pointer",padding:"3px 10px",fontSize:"13px"}},["✕"]);
        x.addEventListener("click",()=>this._hideLinkModal());
        h.appendChild(x);
        box.appendChild(h);

        // Input area
        const top = el("div",{style:{padding:"14px 18px 10px",borderBottom:"1px solid #22223a"}});
        this.linkInput = el("textarea",{
            rows:"3",
            placeholder:"Paste one link per line…\n"+
                "https://huggingface.co/Comfy-Org/flux1-dev/blob/main/flux1-dev-fp8.safetensors\n"+
                "https://huggingface.co/Comfy-Org/flux1-dev  (a whole repo works too)",
            style:{width:"100%",padding:"9px 12px",background:"#0d1117",
                border:"1px solid #30363d",borderRadius:"8px",color:"#e0e0e0",
                fontSize:"12px",fontFamily:"ui-monospace,monospace",resize:"vertical",
                lineHeight:"1.5"},
        });
        this.linkInput.addEventListener("keydown",e=>{
            if (e.key==="Enter" && (e.ctrlKey||e.metaKey)) { e.preventDefault(); this._resolveLinks(); }
            e.stopPropagation();
        });
        top.appendChild(this.linkInput);

        const hintRow = el("div",{style:{display:"flex",alignItems:"center",gap:"10px",marginTop:"9px"}});
        hintRow.appendChild(el("span",{style:{flex:"1",color:"#556",fontSize:"11px"}},
            ["HuggingFace · GitHub · direct file URL — the folder is detected automatically"]));
        this.linkResolveBtn = btn("🔎 Resolve",
            {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3",padding:"6px 16px"},
            ()=>this._resolveLinks());
        hintRow.appendChild(this.linkResolveBtn);
        top.appendChild(hintRow);
        box.appendChild(top);

        // Results
        this.linkStatus = el("div",{style:{padding:"12px 18px",color:"#556",fontSize:"12px"}},
            ["Paste a link above and press Resolve (or Ctrl+Enter)."]);
        this.linkResults = el("div",{style:{overflowY:"auto",flex:"1",display:"none"}});
        box.appendChild(this.linkStatus);
        box.appendChild(this.linkResults);

        // Footer
        this.linkFooter = el("div",{
            style:{padding:"10px 18px",borderTop:"1px solid #2a2a3e",background:"#12121f",
                display:"none",alignItems:"center",gap:"10px"},
        });
        this.linkSelectAll = el("input",{type:"checkbox",checked:"checked",
            style:{cursor:"pointer",accentColor:"#4a9eff"}});
        this.linkSelectAll.addEventListener("change",()=>{
            for (const r of this._linkRows)
                if (!r.started && !r.file.downloaded) r.checkbox.checked = this.linkSelectAll.checked;
            this._updateLinkFooter();
        });
        this.linkFooter.appendChild(this.linkSelectAll);
        this.linkFooter.appendChild(el("span",{style:{color:"#889",fontSize:"11px",flex:"1"}},["Select all"]));
        this.linkDownloadBtn = btn("⬇ Download selected",
            {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3",padding:"6px 16px"},
            ()=>this._downloadLinkFiles());
        this.linkFooter.appendChild(this.linkDownloadBtn);
        box.appendChild(this.linkFooter);

        this.linkOverlay.appendChild(box);
        document.body.appendChild(this.linkOverlay);

        this._linkRows = [];
        this._linkEscHandler = e=>{
            if (e.key==="Escape" && this.linkOverlay.style.display!=="none") {
                e.stopPropagation();
                this._hideLinkModal();
            }
        };
    }

    _showLinkModal() {
        this.linkOverlay.style.display = "flex";
        document.addEventListener("keydown", this._linkEscHandler, true);
        setTimeout(()=>this.linkInput.focus(), 30);
    }

    _hideLinkModal() {
        this.linkOverlay.style.display = "none";
        document.removeEventListener("keydown", this._linkEscHandler, true);
    }

    _resetLinkResults() {
        this._linkRows = [];
        this.linkResults.innerHTML = "";
        this.linkResults.style.display = "none";
        this.linkFooter.style.display = "none";
    }

    async _resolveLinks() {
        const urls = this.linkInput.value.split(/[\r\n]+/).map(s=>s.trim()).filter(Boolean);
        if (!urls.length) {
            this.linkStatus.textContent = "Paste at least one link first.";
            this.linkStatus.style.color = "#fbbf24";
            return;
        }

        this._resetLinkResults();
        this.linkResolveBtn.disabled = true;
        this.linkResolveBtn.textContent = "🔎 Resolving…";
        this.linkStatus.style.display = "block";
        this.linkStatus.style.color = "#556";

        const results = [];
        for (let i = 0; i < urls.length; i++) {
            this.linkStatus.textContent = `Resolving ${i+1} of ${urls.length}…`;
            try {
                const d = await postJSON("/modeldownloader/resolve_link", {url:urls[i]});
                results.push({url:urls[i], ...d});
            } catch(e) {
                results.push({url:urls[i], error:e.message});
            }
        }

        this.linkResolveBtn.disabled = false;
        this.linkResolveBtn.textContent = "🔎 Resolve";
        this._renderLinkResults(results);
    }

    _renderLinkResults(results) {
        this._resetLinkResults();
        this.linkResults.style.display = "block";

        let fileCount = 0;
        for (const res of results) {
            // Source header
            const hdr = el("div",{
                style:{padding:"8px 18px",background:"#12122a",borderTop:"1px solid #1e1e2e",
                    borderBottom:"1px solid #1e1e2e",display:"flex",alignItems:"center",gap:"9px"}});
            const badge = {huggingface:"🤗 HuggingFace",
                           github:"🐙 GitHub",direct:"🌐 Direct"}[res.source] || "🔗 Link";
            hdr.appendChild(el("span",{
                style:{fontSize:"10px",padding:"2px 7px",background:"#0d1f3a",color:"#7ec8e3",
                    border:"1px solid #1a5276",borderRadius:"10px",whiteSpace:"nowrap"}},[badge]));
            hdr.appendChild(el("span",{
                style:{color:"#c8d6e5",fontSize:"12px",fontWeight:"600",flex:"1",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},
                [res.title || res.url]));
            if (res.page_url) {
                const a = el("a",{href:res.page_url,target:"_blank",rel:"noopener noreferrer",
                    title:"Open source page",
                    style:{color:"#445",textDecoration:"none",fontSize:"12px"}},["🔗"]);
                a.addEventListener("mouseenter",()=>{ a.style.color="#7ec8e3"; });
                a.addEventListener("mouseleave",()=>{ a.style.color="#445"; });
                hdr.appendChild(a);
            }
            this.linkResults.appendChild(hdr);

            if (res.error) {
                this.linkResults.appendChild(el("div",{
                    style:{padding:"10px 18px",color:"#f87171",fontSize:"12px"}},
                    [`⚠ ${res.error}`]));
                this.linkResults.appendChild(el("div",{
                    style:{padding:"0 18px 10px",color:"#445",fontSize:"11px",
                        wordBreak:"break-all"}},[res.url]));
                continue;
            }

            // A whole repository — hand it to the normal repo browser
            if (res.kind === "repo") {
                const row = el("div",{style:{padding:"11px 18px",display:"flex",
                    alignItems:"center",gap:"10px",borderBottom:"1px solid #14141f"}});
                row.appendChild(el("span",{style:{flex:"1",color:"#889",fontSize:"12px"}},
                    ["That is a whole repository — open it to pick files."]));
                row.appendChild(btn("📂 Open repository",
                    {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3"},
                    ()=>{
                        this._hideLinkModal();
                        S.hfSearchResults = null;
                        S.fileSearchResults = null;
                        this.loadRepoFiles(res.repo_id);
                    }));
                this.linkResults.appendChild(row);
                continue;
            }

            for (const f of (res.files || [])) {
                this.linkResults.appendChild(this._linkFileRow(f));
                fileCount++;
            }
        }

        this.linkStatus.style.display = "none";
        if (fileCount) {
            this.linkFooter.style.display = "flex";
            this.linkSelectAll.checked = true;
            this._updateLinkFooter();
        }
    }

    _linkFileRow(f) {
        const row = el("div",{style:{padding:"9px 18px",borderBottom:"1px solid #14141f",
            display:"flex",alignItems:"center",gap:"10px"}});

        const cb = el("input",{type:"checkbox",style:{cursor:"pointer",accentColor:"#4a9eff"}});
        cb.checked  = !f.downloaded;
        cb.disabled = !!f.downloaded;
        cb.addEventListener("change",()=>this._updateLinkFooter());
        row.appendChild(cb);

        const info = el("div",{style:{flex:"1",minWidth:"0"}});
        info.appendChild(el("div",{
            style:{color:f.downloaded?"#86efac":"#c8d6e5",fontSize:"13px",
                fontWeight:f.downloaded?"600":"400",overflow:"hidden",
                textOverflow:"ellipsis",whiteSpace:"nowrap"}},
            [(f.downloaded?"✅ ":"") + f.filename]));
        if (f.note) info.appendChild(el("div",{style:{color:"#445",fontSize:"10px"}},[f.note]));
        row.appendChild(info);

        row.appendChild(el("span",{
            style:{color:f.size?"#7ec8e3":"#333",fontSize:"12px",minWidth:"66px",
                textAlign:"right",fontVariantNumeric:"tabular-nums"}},[fmt(f.size)]));

        // Destination — pre-selected from detection, still editable
        const sel = el("select",{style:{...this._ss(),maxWidth:"165px"}});
        const opts = DEST_FOLDERS.includes(f.local_folder)
            ? DEST_FOLDERS : [f.local_folder, ...DEST_FOLDERS];
        for (const d of opts) addOpt(sel, d, `${CAT_ICON[d]||"📄"} ${d.replace(/_/g," ")}`);
        sel.value = f.local_folder;
        sel.title = "Where this file will be saved";
        row.appendChild(sel);

        const statusEl = el("span",{style:{fontSize:"11px",color:"#445",minWidth:"64px",
            textAlign:"right"}},[f.downloaded?"on disk":""]);
        row.appendChild(statusEl);

        this._linkRows.push({file:f, checkbox:cb, select:sel, statusEl, started:false});
        return row;
    }

    _updateLinkFooter() {
        const n = this._linkRows.filter(r=>r.checkbox.checked && !r.started).length;
        this.linkDownloadBtn.disabled = n === 0;
        this.linkDownloadBtn.style.opacity = n === 0 ? "0.5" : "1";
        this.linkDownloadBtn.textContent = n ? `⬇ Download ${n} file${n!==1?"s":""}` : "⬇ Download selected";
    }

    async _downloadLinkFiles() {
        const picked = this._linkRows.filter(r=>r.checkbox.checked && !r.started);
        if (!picked.length) return;

        this.linkDownloadBtn.disabled = true;
        this.linkDownloadBtn.textContent = "⏳ Starting…";

        for (const r of picked) {
            const file = {...r.file, local_folder: r.select.value, category: r.select.value};
            try {
                const d = await this.startDownload(file);
                if (d.task_id) {
                    r.started = true;
                    r.checkbox.checked = false;
                    r.checkbox.disabled = true;
                    r.select.disabled = true;
                    r.statusEl.textContent = "⬇ queued";
                    r.statusEl.style.color = "#7ec8e3";
                } else {
                    r.statusEl.textContent = "⚠ failed";
                    r.statusEl.style.color = "#f87171";
                    r.statusEl.title = d.error || "";
                }
            } catch(e) {
                r.statusEl.textContent = "⚠ failed";
                r.statusEl.style.color = "#f87171";
                r.statusEl.title = e.message;
            }
        }

        this._updateLinkFooter();
        this.linkStatus.style.display = "block";
        this.linkStatus.style.color = "#86efac";
        this.linkStatus.textContent =
            `${picked.length} download${picked.length!==1?"s":""} started — progress is in the Downloads bar.`;
        this._renderDlBar();
    }

    // ── Data loading ───────────────────────────────────────────────────────────

    async loadAll(force=false) {
        if (!force && S.repos.length) { this._renderLeft(); return; }
        this.leftStatus.textContent="Loading…";
        this.leftStatus.style.display="block";
        this.leftList.innerHTML="";
        try {
            const [rr,lr] = await Promise.all([
                fetch(`/modeldownloader/repos${force ? "?force=1" : ""}`),
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
        if (file.github_raw || file.direct_url) body.direct_url = file.github_raw || file.direct_url;
        const d = await postJSON("/modeldownloader/download", body);
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
        // Search bar is always a local filter only.
        // API searches are triggered exclusively via the dedicated buttons.
        S.hfSearchResults = null;
        S.fileSearchResults = null;
        this._renderLeft();

        if (S.browseMode === MODE_LOCAL && S.localCategory)
            this._renderLocalFiles(S.localCategory);
        else if (S.browseMode === MODE_WFMODELS && S.workflowModelFiles)
            this._renderWorkflowModels(S.workflowModelFiles);
        else if (S.browseMode === MODE_WORKFLOW && S.githubWorkflowFiles)
            this._renderGithubWorkflows(S.githubWorkflowFiles);
        else if (S.selectedRepo && S.repoFiles[S.selectedRepo])
            this._renderFileList(S.repoFiles[S.selectedRepo]);
        else if (!S.searchQuery.trim())
            this._showPlaceholder(true);
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
        else if (S.browseMode===MODE_WFMODELS) this._renderWorkflowSourcesList();
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
                subtitle: "Blueprints, examples & comfy-org workflows",
            },
            {
                group: "kijai",
                icon: "⚙️",
                title: "Kijai Example Workflows",
                subtitle: "WanVideo, HunyuanVideo, LTXVideo, CogVideoX, Mochi, FramePack, FluxTrainer",
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

    // ── Workflow Models ────────────────────────────────────────────────────────

    async _loadTemplateIndex() {
        // Only treat a non-empty result as cached: the index can fail while
        // ComfyUI is still starting up, and caching [] would leave the tab
        // permanently empty for the rest of the session.
        if (S.wfTemplates && S.wfTemplates.length) return S.wfTemplates;
        this.leftStatus.textContent = "Loading ComfyUI templates…";
        this.leftStatus.style.display = "block";
        this._wfTemplateError = null;
        try {
            const r = await fetch("/templates/index.json");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (!Array.isArray(d)) throw new Error("unexpected template index format");
            S.wfTemplates = d;
        } catch(e) {
            S.wfTemplates = [];
            this._wfTemplateError = e.message;
        }
        this.leftStatus.style.display = "none";
        return S.wfTemplates;
    }

    /** Left panel: the current graph plus every ComfyUI template, by category. */
    _renderWorkflowSourcesList() {
        this.leftList.innerHTML = "";
        const q = S.searchQuery.trim().toLowerCase();

        this.leftList.appendChild(this._secHead("Workflow source"));

        // The graph you are looking at right now
        const graphItem = el("div",{
            "data-wf-item": WF_GRAPH_KEY,
            style:{padding:"9px 14px",cursor:"pointer",borderBottom:"1px solid #1a1a2a",
                background:S.wfSelected===WF_GRAPH_KEY?"#1e3a5f":"transparent",
                display:"flex",alignItems:"center",gap:"8px"},
        });
        graphItem.appendChild(el("span",{style:{fontSize:"15px"}},["📌"]));
        const gi = el("div",{style:{flex:"1"}});
        gi.appendChild(el("div",{style:{color:"#c8d6e5",fontWeight:"600",fontSize:"12px"}},
            ["Current graph"]));
        gi.appendChild(el("div",{style:{color:"#445",fontSize:"10px"}},
            ["Scan the workflow open on the canvas"]));
        graphItem.appendChild(gi);
        graphItem.addEventListener("click",()=>this.loadWorkflowModels(WF_GRAPH_KEY,"Current graph"));
        this.leftList.appendChild(graphItem);

        // ComfyUI's bundled templates
        let shown = 0;
        for (const cat of (S.wfTemplates||[])) {
            const templates = (cat.templates||[]).filter(t=>{
                if (!q) return true;
                return `${t.title||""} ${t.name||""} ${t.description||""} ${(t.models||[]).join(" ")}`
                    .toLowerCase().includes(q);
            });
            if (!templates.length) continue;

            const title     = cat.title || cat.category || "Templates";
            const collapsed = S.collapsedWfCats.has(title);
            const head = el("div",{
                style:{padding:"7px 12px 5px",fontSize:"10px",fontWeight:"700",
                    color:"#7ec8e3",textTransform:"uppercase",letterSpacing:"0.8px",
                    borderBottom:"1px solid #1e1e2e",marginTop:"6px",cursor:"pointer",
                    display:"flex",alignItems:"center",gap:"6px",userSelect:"none"},
            });
            head.appendChild(el("span",{style:{fontSize:"11px",
                transform:collapsed?"rotate(-90deg)":"rotate(0deg)"}},["▾"]));
            head.appendChild(el("span",{},[`${title} (${templates.length})`]));
            head.addEventListener("click",()=>{
                if (S.collapsedWfCats.has(title)) S.collapsedWfCats.delete(title);
                else S.collapsedWfCats.add(title);
                this._renderWorkflowSourcesList();
            });
            this.leftList.appendChild(head);
            shown += templates.length;
            if (collapsed) continue;

            for (const t of templates) {
                const key = t.name;
                const item = el("div",{
                    "data-wf-item": key,
                    style:{padding:"7px 14px",cursor:"pointer",borderBottom:"1px solid #1a1a2a",
                        background:S.wfSelected===key?"#1e3a5f":"transparent"},
                });
                item.appendChild(el("div",{style:{color:"#c8d6e5",fontSize:"12px",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},
                    [t.title || t.name]));
                if ((t.models||[]).length)
                    item.appendChild(el("div",{style:{color:"#445",fontSize:"10px",
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},
                        [(t.models||[]).join(", ")]));
                item.addEventListener("mouseenter",()=>{ if(S.wfSelected!==key) item.style.background="#1a2a3a"; });
                item.addEventListener("mouseleave",()=>{ if(S.wfSelected!==key) item.style.background="transparent"; });
                item.addEventListener("click",()=>this.loadWorkflowModels(key, t.title || t.name));
                this.leftList.appendChild(item);
            }
        }

        if (!shown && q) {
            this.leftList.appendChild(el("div",{style:{padding:"18px",color:"#333",
                textAlign:"center",fontSize:"12px"}},["No templates match your filter"]));
        } else if (!(S.wfTemplates||[]).length) {
            // Loading the index can fail transiently during ComfyUI startup —
            // let it be retried instead of leaving the tab looking broken.
            const box = el("div",{style:{padding:"16px 14px",textAlign:"center"}});
            box.appendChild(el("div",{style:{color:"#666",fontSize:"11px",marginBottom:"9px",
                lineHeight:"1.5"}},
                [this._wfTemplateError
                    ? `Could not load ComfyUI templates (${this._wfTemplateError}).`
                    : "No ComfyUI templates found."]));
            box.appendChild(btn("⟳ Retry",
                {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3"},
                async()=>{
                    S.wfTemplates = null;
                    await this._loadTemplateIndex();
                    this._renderWorkflowSourcesList();
                }));
            this.leftList.appendChild(box);
        }
    }

    /** Ask the backend which models a workflow needs, then show them. */
    async loadWorkflowModels(sourceKey, title) {
        S.wfSelected = sourceKey;
        S.wfTitle    = title || sourceKey;
        S.workflowModelFiles = null;
        this._renderWorkflowSourcesList();
        this._showPlaceholder(false);
        this.fileListEl.innerHTML =
            `<div style="padding:30px;text-align:center;color:#555">
                Scanning <b style="color:#7ec8e3">${S.wfTitle}</b> for models…</div>`;

        let body;
        if (sourceKey === WF_GRAPH_KEY) {
            let graph = null;
            try { graph = app.graph?.serialize?.(); } catch(_) {}
            if (!graph) {
                this.fileListEl.innerHTML =
                    `<div style="padding:24px;color:#f87171">⚠ Could not read the current graph.</div>`;
                return;
            }
            body = {workflow: graph};
        } else {
            // Fetch the template from ComfyUI itself, then hand it to the backend
            try {
                const r  = await fetch(`/templates/${encodeURIComponent(sourceKey)}.json`);
                if (!r.ok) throw new Error(`template not found (HTTP ${r.status})`);
                body = {workflow: await r.json()};
            } catch(e) {
                this.fileListEl.innerHTML =
                    `<div style="padding:24px;color:#f87171">⚠ ${e.message}</div>`;
                return;
            }
        }

        try {
            const d = await postJSON("/modeldownloader/workflow_models", body);
            if (d.error) throw new Error(d.error);
            S.workflowModelFiles = d.models || [];
            this._renderWorkflowModels(S.workflowModelFiles);
        } catch(e) {
            this.fileListEl.innerHTML =
                `<div style="padding:24px;color:#f87171">⚠ ${e.message}</div>`;
        }
    }

    _renderWorkflowModels(files) {
        this.fileListEl.innerHTML = "";
        const cf       = S.catFilter;
        const filtered = files.filter(f=>cf==="all" || f.category===cf);
        const missing  = filtered.filter(f=>!f.downloaded);

        const sticky = el("div",{
            style:{padding:"10px 16px",background:"#10101c",borderBottom:"1px solid #1e1e2e",
                display:"flex",alignItems:"center",gap:"10px",position:"sticky",top:"0",zIndex:"10"}});
        sticky.appendChild(el("span",{style:{fontWeight:"700",color:"#7ec8e3",flex:"1",
            fontSize:"13px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},
            [`🧩 ${S.wfTitle}`]));
        sticky.appendChild(el("span",{style:{fontSize:"11px",color:"#445",whiteSpace:"nowrap"}},
            [`${filtered.length-missing.length}/${filtered.length} on disk`]));
        if (missing.length) {
            const allBtn = btn(`⬇ Download all missing (${missing.length})`,
                {background:"#0f3460",border:"1px solid #1a5276",color:"#7ec8e3",
                 whiteSpace:"nowrap"},
                async()=>{
                    allBtn.disabled = true;
                    allBtn.textContent = "⏳ Starting…";
                    for (const f of missing) {
                        const active = Object.values(S.downloads).find(d=>
                            d.repo_id===f.repo_id && d.filepath===f.path &&
                            ["queued","downloading"].includes(d.status));
                        if (active) continue;
                        try { await this.startDownload(f); } catch(_) {}
                    }
                    this._rerender();
                });
            sticky.appendChild(allBtn);
        }
        this.fileListEl.appendChild(sticky);

        if (!filtered.length) {
            this.fileListEl.appendChild(el("div",{
                style:{padding:"34px",color:"#555",textAlign:"center",lineHeight:"1.6"}},
                [files.length
                    ? "No models match the category filter."
                    : "This workflow does not declare any model downloads."]));
            if (!files.length)
                this.fileListEl.appendChild(el("div",{
                    style:{padding:"0 34px 30px",color:"#333",textAlign:"center",fontSize:"11px"}},
                    ["Only templates that embed model metadata can be scanned. " +
                     "Try 🔗 Paste Link for models you already have a URL for."]));
            return;
        }

        const byCat = {};
        for (const f of filtered) (byCat[f.category]=byCat[f.category]||[]).push(f);
        const cats = [...CAT_ORDER.filter(c=>byCat[c]),
                      ...Object.keys(byCat).filter(c=>!CAT_ORDER.includes(c))];
        for (const cat of cats) {
            const col = CAT_COLOR[cat]||"#888";
            this.fileListEl.appendChild(el("div",{
                style:{padding:"5px 16px 3px",fontSize:"10px",fontWeight:"700",color:col,
                    background:"#0e0e1a",borderTop:"1px solid #1a1a2a",
                    borderBottom:"1px solid #1a1a2a",marginTop:"6px",
                    textTransform:"uppercase",letterSpacing:"0.5px"}},
                [`${CAT_ICON[cat]||"📄"}  ${cat.replace(/_/g," ")}`]));
            for (const f of byCat[cat]) this.fileListEl.appendChild(this._fileRow(f));
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
        // The panel starts behind the placeholder; without this the rows render
        // into a hidden container and the tab looks empty.
        this._showPlaceholder(false);
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

            // Move progress / status, hidden until a move starts
            const moveStatus=el("span",{style:{display:"none",fontSize:"11px",
                color:"#7ec8e3",minWidth:"78px",textAlign:"right",
                fontVariantNumeric:"tabular-nums"}});
            row.appendChild(moveStatus);

            // ➜ Move to another model folder (workflows are not model files,
            // so there is no sensible destination for them)
            if (cat !== "workflows")
                row.appendChild(this._moveButton(cat, filename, row, moveStatus));

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

    /** Folder types a file can be moved into (cached for the session). */
    async _loadFolderTargets() {
        if (S.folderTargets) return S.folderTargets;
        try {
            const r = await fetch("/modeldownloader/folder_targets");
            const d = await r.json();
            if (Array.isArray(d) && d.length) S.folderTargets = d;
        } catch(_) {}
        // Fall back to the known model folders if the endpoint is unavailable
        if (!S.folderTargets)
            S.folderTargets = DEST_FOLDERS
                .filter(f=>f!=="workflows")
                .map(f=>({folder:f, path:""}));
        return S.folderTargets;
    }

    async _refreshLocal() {
        try {
            const r = await fetch("/modeldownloader/local_models");
            S.localModels = await r.json();
        } catch(_) {}
    }

    /**
     * Move one downloaded file into another model folder.
     * Same-disk moves finish instantly; a move onto another drive is a copy,
     * so progress is polled and the row shows it.
     */
    async _moveFile(fromFolder, filename, toFolder, row, statusEl) {
        const label = f => f.replace(/_/g," ");
        if (!confirm(`Move "${filename}"\n\nfrom  ${label(fromFolder)}\nto    ${label(toFolder)}?`))
            return false;

        row.style.opacity = "0.6";
        statusEl.style.display = "inline";
        statusEl.style.color = "#7ec8e3";
        statusEl.textContent = "moving…";

        let task;
        try {
            task = await postJSON("/modeldownloader/move_model",
                {from_folder:fromFolder, filename, to_folder:toFolder});
        } catch(e) {
            row.style.opacity = "1";
            statusEl.style.display = "none";
            alert("Move failed: " + e.message);
            return false;
        }
        if (task.error || !task.task_id) {
            row.style.opacity = "1";
            statusEl.style.display = "none";
            alert("Move failed: " + (task.error || "unknown error"));
            return false;
        }

        // Poll until the move settles (instant for same-filesystem moves)
        let state = task;
        for (let i = 0; i < 36000; i++) {
            await new Promise(r=>setTimeout(r, 250));
            try {
                const r2 = await fetch(`/modeldownloader/move_status/${task.task_id}`);
                state = await r2.json();
            } catch(_) { break; }
            if (["done","error","cancelled"].includes(state.status)) break;
            if (state.total_bytes)
                statusEl.textContent = `moving… ${Math.round(state.progress||0)}%`;
        }

        row.style.opacity = "1";
        if (state.status !== "done") {
            statusEl.style.display = "none";
            alert(`Move ${state.status||"failed"}: ${state.error||"see console"}`);
            return false;
        }

        // Refresh and re-render; the source category may now be empty
        await this._refreshLocal();
        if (!S.localModels[S.localCategory])
            S.localCategory = Object.keys(S.localModels)[0] || null;
        this._renderLocalLeft();
        if (S.localCategory) this._renderLocalFiles(S.localCategory);
        else this._showPlaceholder(true);
        return true;
    }

    /** "Move to…" button that opens the searchable folder picker. */
    _moveButton(cat, filename, row, statusEl) {
        const b = btn("➜ Move to…",
            {background:"#0d1117",border:"1px solid #30363d",color:"#c8d6e5",
             fontSize:"11px",padding:"5px 9px",whiteSpace:"nowrap"});
        b.title = "Move this file to a different model folder";
        b.addEventListener("click", e=>{
            e.stopPropagation();
            this._openFolderPicker(b, cat, async folder=>{
                b.disabled = true;
                await this._moveFile(cat, filename, folder, row, statusEl);
                b.disabled = false;
            });
        });
        return b;
    }

    _closeFolderPicker() {
        const p = this._folderPop;
        if (!p) return;
        document.removeEventListener("mousedown", p.onDocDown, true);
        document.removeEventListener("keydown",  p.onKey,      true);
        document.removeEventListener("scroll",   p.reposition, true);
        window.removeEventListener("resize",     p.reposition, true);
        p.elem.remove();
        this._folderPop = null;
    }

    /**
     * Folder picker with a filter box. A native <select> cannot host a search
     * field, and there are too many model folders to scroll comfortably.
     * Positioned fixed so the surrounding scroll panel cannot clip it.
     */
    _openFolderPicker(anchor, excludeFolder, onPick) {
        this._closeFolderPicker();
        const targets = (S.folderTargets||[]).filter(t=>t.folder !== excludeFolder);

        const pop = el("div",{style:{position:"fixed",zIndex:"10001",width:"272px",
            background:"#12121f",border:"1px solid #2a2a3e",borderRadius:"8px",
            boxShadow:"0 12px 32px rgba(0,0,0,0.55)",display:"flex",
            flexDirection:"column",overflow:"hidden"}});

        const input = el("input",{type:"text",placeholder:"🔍  Filter folders…",
            style:{margin:"7px 7px 5px",padding:"6px 9px",background:"#0d1117",
                border:"1px solid #30363d",borderRadius:"6px",color:"#e0e0e0",
                fontSize:"12px",outline:"none"}});
        const list  = el("div",{style:{overflowY:"auto",maxHeight:"248px",paddingBottom:"5px"}});
        const hint  = el("div",{style:{padding:"5px 10px",borderTop:"1px solid #1e1e2e",
            color:"#3a3a4a",fontSize:"10px"}},["↑↓ to move · Enter to pick · Esc to close"]);
        pop.appendChild(input); pop.appendChild(list); pop.appendChild(hint);
        document.body.appendChild(pop);

        let rows = [], active = 0;
        const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g," ");

        const paint = () => rows.forEach((r,i)=>{
            r.style.background = i===active ? "#1e3a5f" : "transparent";
        });

        const choose = folder => { this._closeFolderPicker(); onPick(folder); };

        const render = () => {
            const words = norm(input.value).split(/\s+/).filter(Boolean);
            const hits  = targets.filter(t=>{
                if (!words.length) return true;
                const hay = norm(`${t.folder} ${(t.aliases||[]).join(" ")}`);
                return words.every(w=>hay.includes(w));
            });
            list.innerHTML = ""; rows = []; active = 0;
            if (!hits.length) {
                list.appendChild(el("div",{style:{padding:"14px",color:"#445",
                    fontSize:"11px",textAlign:"center"}},["No folder matches"]));
                return;
            }
            hits.forEach((t,i)=>{
                const it = el("div",{style:{padding:"6px 11px",cursor:"pointer",
                    fontSize:"12px",color:"#c8d6e5",display:"flex",
                    alignItems:"center",gap:"7px"}});
                it.appendChild(el("span",{},[CAT_ICON[t.folder]||"📄"]));
                it.appendChild(el("span",{style:{flex:"1",overflow:"hidden",
                    textOverflow:"ellipsis",whiteSpace:"nowrap"}},
                    [t.folder.replace(/_/g," ")]));
                if (t.path) it.title = t.path;
                it.addEventListener("mouseenter",()=>{ active=i; paint(); });
                it.addEventListener("click",()=>choose(t.folder));
                rows.push(it); list.appendChild(it);
            });
            paint();
        };

        const reposition = () => {
            const r = anchor.getBoundingClientRect();
            const h = pop.offsetHeight || 300, w = pop.offsetWidth || 272;
            let top = r.bottom + 4;
            if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
            let left = Math.min(r.right - w, window.innerWidth - w - 8);
            pop.style.top  = `${Math.max(8, top)}px`;
            pop.style.left = `${Math.max(8, left)}px`;
        };

        const onDocDown = e => { if (!pop.contains(e.target)) this._closeFolderPicker(); };
        const onKey = e => {
            if (e.key === "Escape")      { e.stopPropagation(); this._closeFolderPicker(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); if(rows.length){ active=(active+1)%rows.length; paint(); rows[active].scrollIntoView({block:"nearest"}); } }
            else if (e.key === "ArrowUp")   { e.preventDefault(); if(rows.length){ active=(active-1+rows.length)%rows.length; paint(); rows[active].scrollIntoView({block:"nearest"}); } }
            else if (e.key === "Enter")     { e.preventDefault(); if(rows.length) rows[active].click(); }
        };

        input.addEventListener("input", render);
        // keep ComfyUI's canvas shortcuts from swallowing what is typed here
        input.addEventListener("keydown", e=>e.stopPropagation());
        document.addEventListener("mousedown", onDocDown, true);
        document.addEventListener("keydown",  onKey,      true);
        document.addEventListener("scroll",   reposition, true);
        window.addEventListener("resize",     reposition, true);

        this._folderPop = {elem:pop, anchor, onDocDown, onKey, reposition};
        render();
        reposition();
        setTimeout(()=>input.focus(), 20);
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
                    try {
                        await this.startDownload(f);
                        // re-render so the row immediately switches to progress+stop view
                        this._rerender();
                    } catch(e) {
                        dlBtn.disabled=false; dlBtn.style.opacity="1";
                        dlBtn.textContent="⬇ Download";
                        alert("Could not start download: "+e.message);
                    }
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
        if (S.browseMode===MODE_WFMODELS && S.workflowModelFiles) {
            this._renderWorkflowModels(S.workflowModelFiles);
        } else if (S.githubWorkflowFiles) {
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
            if (S.workflowModelFiles)
                this._applyLocalFlagsToList(S.workflowModelFiles);
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
        this._closeFolderPicker();   // it lives on document.body, not in the dialog
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
