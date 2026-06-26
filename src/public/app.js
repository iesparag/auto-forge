const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d) => { try { return new Date(d).toLocaleTimeString(); } catch { return ''; } };
const TERMINAL = ['completed', 'failed', 'stopped'];
const isActive = (s) => s && !TERMINAL.includes(s);

let projects = [];
let selectedId = null;
let evtSource = null;
let streamingRunId = null;
let pollTimer = null;
let npImages = []; // images staged for a new project
let npDocs = []; // extracted docs staged for a new project
let edImages = null; // images staged for an edit (null = leave unchanged)
let edDocs = null; // docs staged for an edit (null = leave unchanged)
let chatImages = []; // images staged for the next chat message
let chatDocs = []; // docs staged for the next chat message

const fileToBase64 = (f) =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(f);
  });

// Process a FileList: images → vision array; other files → /api/extract → docs.
async function ingestFiles(fileList) {
  const images = [];
  const docs = [];
  for (const f of [...fileList]) {
    if (/^image\//.test(f.type)) {
      images.push({ media_type: f.type, data: await fileToBase64(f), name: f.name });
    } else {
      try {
        const data = await fileToBase64(f);
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.name, media_type: f.type, data }),
        });
        const out = await res.json();
        if (out.ok) docs.push({ name: out.name, text: out.text });
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return { images, docs };
}

function renderThumbs(el, images) {
  if (!el) return;
  el.innerHTML = images
    .map((im) => `<img class="thumb" src="data:${im.media_type};base64,${im.data}" title="${esc(im.name)}" />`)
    .join('');
}
function renderChips(el, docs) {
  if (!el) return;
  el.innerHTML = docs.map((d) => `<span class="chip">📄 ${esc(d.name)}</span>`).join('');
}

// ---- Sidebar ----------------------------------------------------------------
async function loadProjects() {
  const res = await fetch('/api/projects');
  const data = await res.json();
  projects = data.projects || [];
  renderSidebar();
}

function renderSidebar() {
  const list = $('projectList');
  if (!projects.length) {
    list.innerHTML = '<div class="muted" style="padding:10px 8px;font-size:13px;">No projects yet. Click “+ New project”.</div>';
    return;
  }
  list.innerHTML = projects
    .map((p) => {
      const st = p.lastRun?.status;
      const dot = isActive(st) ? 'running' : st || '';
      return `<div class="project-item ${p._id === selectedId ? 'active' : ''}" data-id="${p._id}">
        <span class="dot ${dot}"></span><span class="name">${esc(p.name)}</span>
      </div>`;
    })
    .join('');
  list.querySelectorAll('.project-item').forEach((el) => {
    el.addEventListener('click', () => selectProject(el.dataset.id));
  });
}

// ---- New project view -------------------------------------------------------
function showNewProject() {
  selectedId = null;
  renderSidebar();
  stopStream();
  $('workspace').innerHTML = `
    <div class="ws-header"><h2>New project</h2></div>
    <p class="muted">Describe what to build (like a prompt). Each project is independent.</p>
    <div class="card" style="margin-top:12px;">
      <div class="field"><label>Project name</label><input id="np_name" placeholder="e.g. Task Manager API" /></div>
      <div class="field">
        <label>Work mode</label>
        <select id="np_mode">
          <option value="new_idea">New idea — build a brand-new repo from your prompt</option>
          <option value="fix_repo">Fix repo — improve an existing repo you own</option>
          <option value="open_source">Open source — fork a repo &amp; PR upstream</option>
        </select>
      </div>
      <div class="field" id="np_target_wrap" style="display:none;">
        <label>Target repo (owner/name or URL)</label>
        <input id="np_target" placeholder="e.g. iesparag/my-repo" />
      </div>
      <div class="field">
        <label>Prompt / brief (what to build)</label>
        <textarea id="np_brief" rows="6" placeholder="e.g. REST API for a task manager: users, JWT auth, tasks CRUD with status & assignees, SQLite, validation, and tests."></textarea>
      </div>
      <div class="field">
        <label>Attach files (optional) — images, PDF, Excel, Word, CSV. The AI analyzes them. You can also paste an image directly.</label>
        <input type="file" id="np_files" accept="image/*,.pdf,.xlsx,.xls,.docx,.csv,.txt,.md,.json" multiple />
        <div class="thumbs" id="np_thumbs"></div>
        <div class="chips" id="np_docs"></div>
      </div>
      <div class="field" style="max-width:200px;"><label>Max issues (features)</label><input type="number" id="np_max" value="8" min="1" max="25" /></div>
      <button class="btn primary" id="np_create">Create &amp; Build</button>
      <span class="test-result" id="np_msg"></span>
    </div>`;

  npImages = [];
  npDocs = [];
  $('np_mode').addEventListener('change', (e) => {
    $('np_target_wrap').style.display = e.target.value === 'new_idea' ? 'none' : '';
  });
  $('np_files').addEventListener('change', async (e) => {
    const { images, docs } = await ingestFiles(e.target.files);
    npImages = npImages.concat(images).slice(0, 5);
    npDocs = npDocs.concat(docs).slice(0, 10);
    renderThumbs($('np_thumbs'), npImages);
    renderChips($('np_docs'), npDocs);
  });
  // Paste an image straight into the brief.
  $('np_brief').addEventListener('paste', async (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (!imgs.length) return;
    const { images } = await ingestFiles(imgs);
    npImages = npImages.concat(images).slice(0, 5);
    renderThumbs($('np_thumbs'), npImages);
  });
  $('np_create').addEventListener('click', createProject);
}

async function createProject() {
  const body = {
    name: $('np_name').value.trim(),
    work_mode: $('np_mode').value,
    target_repo: $('np_target').value.trim(),
    brief: $('np_brief').value.trim(),
    max_issues: $('np_max').value,
    images: npImages,
    documents: npDocs,
  };
  if (!body.name) { $('np_msg').textContent = '✗ Name required'; $('np_msg').className = 'test-result err'; return; }
  $('np_create').disabled = true;
  const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.ok) { $('np_msg').textContent = '✗ ' + data.error; $('np_msg').className = 'test-result err'; $('np_create').disabled = false; return; }
  await loadProjects();
  await selectProject(data.project._id);
  // Kick off the first build as the opening chat message.
  if (body.brief) await sendMessage(data.project._id, body.brief);
}

// ---- Project detail view ----------------------------------------------------
async function selectProject(id) {
  selectedId = id;
  renderSidebar();
  const res = await fetch('/api/projects/' + id);
  if (!res.ok) { $('workspace').innerHTML = '<p class="empty-hint">Project not found.</p>'; return; }
  const data = await res.json();
  renderProject(data);
}

function renderMessages(messages) {
  if (!messages || !messages.length) return '<div class="muted" style="padding:8px;">No messages yet. Send your first instruction below.</div>';
  return messages
    .map((m) => {
      const meta =
        m.role === 'assistant' && (m.files?.length || m.prs?.length)
          ? `<div class="chg">${(m.prs || []).map((pr) => `<a href="${esc(pr.url)}" target="_blank">PR #${pr.number} ↗</a>`).join(' · ')}${
              m.files?.length ? `<div class="chg-files">Changed: ${m.files.map((f) => esc(f)).join(', ')}</div>` : ''
            }</div>`
          : '';
      return `<div class="msg ${m.role}"><div class="bubble">${esc(m.text)}${meta}</div></div>`;
    })
    .join('');
}

function renderProject(data) {
  const p = data.project;
  const run = data.current;
  const active = isActive(run?.status);
  const modeLabel = { new_idea: 'New idea', fix_repo: 'Fix repo', open_source: 'Open source' }[p.work_mode] || p.work_mode;

  $('workspace').innerHTML = `
    <div class="ws-header">
      <div><h2>${esc(p.name)}</h2><span class="badge">${esc(modeLabel)}</span>
        ${run?.repoUrl ? ` <a class="badge" href="${esc(run.repoUrl)}" target="_blank">repo ↗</a>` : ''}
        <a href="#" class="badge" id="settingsToggle">⚙ settings</a></div>
      <div class="ws-actions">
        <button class="btn" id="stopBtn" style="${active ? '' : 'display:none'}">⏹ Stop</button>
      </div>
    </div>

    <div class="card" id="settingsPanel" style="margin-bottom:14px;display:none;">
      <div class="grid2">
        <div class="field"><label>Default brief</label><textarea id="ed_brief" rows="3">${esc(p.brief)}</textarea></div>
        <div>
          <div class="field"><label>Mode</label>
            <select id="ed_mode">
              <option value="new_idea" ${p.work_mode === 'new_idea' ? 'selected' : ''}>New idea</option>
              <option value="fix_repo" ${p.work_mode === 'fix_repo' ? 'selected' : ''}>Fix repo</option>
              <option value="open_source" ${p.work_mode === 'open_source' ? 'selected' : ''}>Open source</option>
            </select>
          </div>
          <div class="field"><label>Target repo (fix/open source)</label><input id="ed_target" value="${esc(p.target_repo)}" placeholder="owner/name" /></div>
          <div class="field" style="max-width:160px;"><label>Max tasks</label><input type="number" id="ed_max" value="${p.max_issues}" min="1" max="25" /></div>
        </div>
      </div>
      <button class="btn" id="saveBtn">Save</button>
      <button class="btn" id="deleteBtn" style="float:right;">Delete project</button>
      <span class="test-result" id="ed_msg"></span>
    </div>

    <div class="sec">
      <div class="section-title sec-head">Conversation <span class="caret">▾</span></div>
      <div class="sec-body"><div class="chat" id="chat">${renderMessages(p.messages)}</div></div>
    </div>
    <div id="waitBanner" class="banner ${run?.status === 'waiting_for_reply' ? 'show' : ''}">⏸ Waiting for your email reply…</div>
    <div class="composer">
      <textarea id="chatInput" rows="2" placeholder="${p.builtRepo ? 'Ask for a change… (paste an image or attach files too)' : 'Describe what to build…'}" ${active ? 'disabled' : ''}></textarea>
      <label class="btn attach-btn" for="chatFiles" title="Attach images / files">📎</label>
      <input id="chatFiles" type="file" accept="image/*,.pdf,.xlsx,.xls,.docx,.csv,.txt,.md,.json" multiple style="display:none" />
      <button class="btn primary" id="sendBtn" ${active ? 'disabled' : ''}>${active ? '…' : 'Send'}</button>
    </div>
    <div class="thumbs" id="chatThumbs"></div>
    <div class="chips" id="chatDocs"></div>
    <div class="muted" id="workingHint" style="margin:6px 2px;${active ? '' : 'display:none'}">⚙️ Working… <span id="runStatus">${esc(run?.status || '')}</span></div>

    <div class="sec">
      <div class="section-title sec-head">Activity log <span class="caret">▾</span></div>
      <div class="sec-body"><div id="log"></div></div>
    </div>

    <div class="sec">
      <div class="section-title sec-head">Generated files — browse the code <span class="caret">▾</span></div>
      <div class="sec-body"><div class="card" style="padding:0;">
        <div class="browser">
          <div id="fileTree" class="file-tree"><span class="muted" style="padding:12px;display:block;">No files yet.</span></div>
          <div id="fileView" class="file-view"><span class="muted">Select a file to view its code.</span></div>
        </div>
      </div></div>
    </div>`;

  edImages = null;
  edDocs = null;
  $('settingsToggle').addEventListener('click', (e) => { e.preventDefault(); const el = $('settingsPanel'); el.style.display = el.style.display === 'none' ? '' : 'none'; });
  $('stopBtn').addEventListener('click', stopRun);
  $('saveBtn').addEventListener('click', () => saveProject(p._id));
  $('deleteBtn').addEventListener('click', () => deleteProject(p._id));
  chatImages = [];
  chatDocs = [];
  $('sendBtn').addEventListener('click', () => {
    const text = $('chatInput').value.trim();
    if (!text) return;
    $('chatInput').value = '';
    sendMessage(p._id, text, chatImages, chatDocs);
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('sendBtn').click(); }
  });
  // Attach files / paste images into the composer.
  $('chatFiles').addEventListener('change', async (e) => {
    const { images, docs } = await ingestFiles(e.target.files);
    chatImages = chatImages.concat(images).slice(0, 5);
    chatDocs = chatDocs.concat(docs).slice(0, 10);
    renderThumbs($('chatThumbs'), chatImages);
    renderChips($('chatDocs'), chatDocs);
    e.target.value = '';
  });
  $('chatInput').addEventListener('paste', async (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (!imgs.length) return;
    const { images } = await ingestFiles(imgs);
    chatImages = chatImages.concat(images).slice(0, 5);
    renderThumbs($('chatThumbs'), chatImages);
  });
  // Collapsible sections.
  document.querySelectorAll('.sec-head').forEach((h) => {
    h.addEventListener('click', () => {
      const body = h.nextElementSibling;
      const hidden = body.classList.toggle('hidden');
      const c = h.querySelector('.caret');
      if (c) c.textContent = hidden ? '▸' : '▾';
    });
  });

  const chat = $('chat');
  if (chat) chat.scrollTop = chat.scrollHeight;

  if (run) { startStream(run._id); loadTree(run._id); }
  else stopStream();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (selectedId === p._id) refreshStatus(p._id); }, 4000);
}

let lastActive = false;
async function refreshStatus(id) {
  const res = await fetch('/api/projects/' + id);
  if (!res.ok) return;
  const data = await res.json();
  const run = data.current;
  const active = isActive(run?.status);
  if ($('runStatus')) $('runStatus').textContent = run?.status || '';
  if ($('workingHint')) $('workingHint').style.display = active ? '' : 'none';
  if ($('waitBanner')) $('waitBanner').classList.toggle('show', run?.status === 'waiting_for_reply');
  if ($('stopBtn')) $('stopBtn').style.display = active ? '' : 'none';
  if ($('chatInput')) $('chatInput').disabled = active;
  if ($('sendBtn')) { $('sendBtn').disabled = active; $('sendBtn').textContent = active ? '…' : 'Send'; }
  if (run && run._id !== streamingRunId) { startStream(run._id); loadTree(run._id); }
  // When a run just finished, reload messages (assistant summary was added) + tree.
  if (lastActive && !active) {
    const chat = $('chat');
    if (chat) chat.innerHTML = renderMessages(data.project.messages);
    if (chat) chat.scrollTop = chat.scrollHeight;
    if (run) loadTree(run._id);
    renderSidebar();
  }
  lastActive = active;
  renderSidebarStatus(id, run?.status);
}

async function sendMessage(id, text, images = [], docs = []) {
  // Optimistically show the user's message.
  const chat = $('chat');
  if (chat) {
    if (chat.querySelector('.muted')) chat.innerHTML = '';
    const att = images.length || docs.length ? `<div class="chg-files">📎 ${[...images, ...docs].map((a) => esc(a.name)).join(', ')}</div>` : '';
    chat.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="bubble">${esc(text)}${att}</div></div>`);
    chat.scrollTop = chat.scrollHeight;
  }
  // Clear the staging area.
  chatImages = [];
  chatDocs = [];
  if ($('chatThumbs')) $('chatThumbs').innerHTML = '';
  if ($('chatDocs')) $('chatDocs').innerHTML = '';
  if ($('chatInput')) $('chatInput').disabled = true;
  if ($('sendBtn')) { $('sendBtn').disabled = true; $('sendBtn').textContent = '…'; }
  const res = await fetch('/api/projects/' + id + '/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images, documents: docs }) });
  const data = await res.json();
  if (!data.ok) { alert(data.error || 'Could not send.'); if ($('chatInput')) $('chatInput').disabled = false; if ($('sendBtn')) { $('sendBtn').disabled = false; $('sendBtn').textContent = 'Send'; } return; }
  lastActive = true;
  setTimeout(() => refreshStatus(id), 500);
}

function renderSidebarStatus(id, status) {
  const item = document.querySelector(`.project-item[data-id="${id}"] .dot`);
  if (item) item.className = 'dot ' + (isActive(status) ? 'running' : status || '');
}

async function buildProject(id) {
  const res = await fetch('/api/projects/' + id + '/run', { method: 'POST' });
  const data = await res.json();
  if (!data.ok) { alert(data.error || 'Could not start build.'); return; }
  setTimeout(() => refreshStatus(id), 600);
}

async function stopRun() {
  const res = await fetch('/api/runs/stop', { method: 'POST' });
  const data = await res.json();
  if (!data.ok) alert(data.error || 'Could not stop.');
  setTimeout(() => selectedId && refreshStatus(selectedId), 600);
}

async function saveProject(id) {
  const body = {
    brief: $('ed_brief').value,
    work_mode: $('ed_mode').value,
    target_repo: $('ed_target').value,
    max_issues: $('ed_max').value,
  };
  if (edImages !== null) body.images = edImages; // only replace if new files chosen
  if (edDocs !== null) body.documents = edDocs;
  const res = await fetch('/api/projects/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  const m = $('ed_msg');
  m.textContent = data.ok ? '✓ Saved' : '✗ ' + data.error;
  m.className = 'test-result ' + (data.ok ? 'ok' : 'err');
  if (data.ok) setTimeout(() => (m.textContent = ''), 2000);
}

async function deleteProject(id) {
  if (!confirm('Delete this project and its run history?')) return;
  await fetch('/api/projects/' + id, { method: 'DELETE' });
  await loadProjects();
  showNewProject();
}

// ---- Live log (SSE) ---------------------------------------------------------
function startStream(runId) {
  if (streamingRunId === runId && evtSource) return;
  stopStream();
  streamingRunId = runId;
  if ($('log')) $('log').innerHTML = '';
  evtSource = new EventSource('/api/logs/stream?runId=' + encodeURIComponent(runId));
  evtSource.onmessage = (e) => {
    try {
      const log = JSON.parse(e.data);
      const box = $('log');
      if (!box) return;
      const el = document.createElement('div');
      el.className = 'log-line log-' + (log.level || 'info');
      el.innerHTML = `<span class="ts">[${fmtTime(log.createdAt)}]</span>${esc(log.message)}`;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    } catch {}
  };
}
function stopStream() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  streamingRunId = null;
}

// ---- File browser -----------------------------------------------------------
// Build a nested {name, path, isFile, children} tree from flat paths.
function buildFileTree(paths) {
  const root = { children: {} };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (!node.children[part]) node.children[part] = { name: part, path: parts.slice(0, i + 1).join('/'), isFile, children: {} };
      node = node.children[part];
    });
  }
  return root;
}
function renderFileNodes(node, depth) {
  const entries = Object.values(node.children);
  entries.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
  return entries
    .map((n) => {
      const pad = 8 + depth * 14;
      if (n.isFile) {
        return `<div class="tnode tfile" data-path="${esc(n.path)}" style="padding-left:${pad}px" title="${esc(n.path)}">📄 ${esc(n.name)}</div>`;
      }
      return `<div class="tnode tdir" style="padding-left:${pad}px"><span class="caret">▾</span>📁 ${esc(n.name)}</div>
        <div class="tchildren">${renderFileNodes(n, depth + 1)}</div>`;
    })
    .join('');
}

async function loadTree(runId) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/tree`);
    if (!res.ok) return;
    const data = await res.json();
    const tree = $('fileTree');
    if (!tree) return;
    const paths = data.paths || [];
    if (!paths.length) { tree.innerHTML = '<span class="muted" style="padding:12px;display:block;">No files yet.</span>'; return; }
    tree.innerHTML = renderFileNodes(buildFileTree(paths), 0);
    // Folder rows: toggle their child container.
    tree.querySelectorAll('.tdir').forEach((dir) => {
      dir.addEventListener('click', () => {
        const children = dir.nextElementSibling;
        if (!children || !children.classList.contains('tchildren')) return;
        const hidden = children.classList.toggle('hidden');
        const c = dir.querySelector('.caret');
        if (c) c.textContent = hidden ? '▸' : '▾';
      });
    });
    // File rows: open in viewer.
    tree.querySelectorAll('.tfile').forEach((row) => row.addEventListener('click', () => openFile(runId, row.dataset.path, row)));
    const first = paths.find((p) => /src\/index|index\.js|README/i.test(p)) || paths[0];
    if (first) openFile(runId, first, [...tree.querySelectorAll('.tfile')].find((r) => r.dataset.path === first));
  } catch {}
}
async function openFile(runId, path, row) {
  document.querySelectorAll('#fileTree .tfile').forEach((r) => r.classList.remove('active'));
  if (row) row.classList.add('active');
  const view = $('fileView');
  if (view) view.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (view) view.textContent = data.content || '(empty file)';
  } catch { if (view) view.textContent = 'Could not load file.'; }
}

// ---- Auth + Boot ------------------------------------------------------------
$('newProjectBtn').addEventListener('click', showNewProject);
$('logoutBtn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

(async () => {
  // Verify session; bounce to login if missing.
  const me = await fetch('/api/auth/me');
  if (!me.ok) { window.location.href = '/login'; return; }
  const { user } = await me.json();
  if ($('userEmail')) $('userEmail').textContent = user.email;
  if ($('userAvatar')) $('userAvatar').textContent = (user.name || user.email || 'U')[0].toUpperCase();

  await loadProjects();
  if (projects.length) selectProject(projects[0]._id);
  else showNewProject();
  setInterval(loadProjects, 12000);
})();
