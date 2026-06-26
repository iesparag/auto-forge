import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  addProjectMessage,
  listRunsByProject,
  getProjectCurrentRun,
} from '../db/repo.js';
import { startManualRun } from '../services/schedulerService.js';
import { extractText, isImage } from '../utils/extract.js';

const router = express.Router();

// Strip heavy data; keep lightweight metadata for the UI.
function lightImages(images) {
  return (images || []).map((im) => ({ name: im.name, media_type: im.media_type }));
}
function lightDocs(docs) {
  return (docs || []).map((d) => ({ name: d.name, chars: (d.text || '').length }));
}

// Extract text from an uploaded non-image file (PDF/Excel/Word/CSV/txt).
router.post('/extract', async (req, res) => {
  try {
    const { name, media_type, data } = req.body || {};
    if (!data) return res.status(400).json({ ok: false, error: 'No file data.' });
    if (isImage(media_type, name)) return res.status(400).json({ ok: false, error: 'Use the image path for images.' });
    const text = await extractText({ name, media_type, data });
    res.json({ ok: true, name, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List all projects (with their latest run status for the sidebar).
// Load a project and 403 unless it belongs to the current user.
async function ownedProject(req, res) {
  const project = await getProject(req.params.id);
  if (!project) { res.status(404).json({ error: 'not found' }); return null; }
  if (project.ownerId !== req.userId) { res.status(403).json({ error: 'forbidden' }); return null; }
  return project;
}

router.get('/projects', async (req, res) => {
  const projects = await listProjects(req.userId);
  const withRun = await Promise.all(
    projects.map(async (p) => {
      const run = await getProjectCurrentRun(p._id);
      return {
        ...p,
        images: lightImages(p.images),
        documents: lightDocs(p.documents),
        lastRun: run ? { id: run._id, status: run.status, repoUrl: run.repoUrl } : null,
      };
    })
  );
  res.json({ projects: withRun });
});

// Create a project.
router.post('/projects', async (req, res) => {
  try {
    const { name, brief, work_mode, target_repo, domain, max_issues, images, documents } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Name is required.' });
    const id = uuidv4();
    const project = await createProject({
      id,
      ownerId: req.userId,
      name: name.trim(),
      brief,
      work_mode,
      target_repo,
      domain,
      max_issues: parseInt(max_issues, 10) || 8,
      images: sanitizeImages(images),
      documents: sanitizeDocs(documents),
    });
    const obj = project.toObject();
    res.json({ ok: true, project: { ...obj, images: lightImages(obj.images), documents: lightDocs(obj.documents) } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get one project + its runs. Images returned as metadata only (no base64).
router.get('/projects/:id', async (req, res) => {
  const project = await ownedProject(req, res);
  if (!project) return;
  const runs = await listRunsByProject(req.params.id);
  const current = await getProjectCurrentRun(req.params.id);
  res.json({
    project: { ...project, images: lightImages(project.images), documents: lightDocs(project.documents) },
    runs,
    current,
  });
});

// Update a project's config.
router.post('/projects/:id', async (req, res) => {
  try {
    if (!(await ownedProject(req, res))) return;
    const allowed = ['name', 'brief', 'work_mode', 'target_repo', 'domain', 'max_issues'];
    const fields = {};
    for (const k of allowed) if (req.body[k] !== undefined) fields[k] = req.body[k];
    if (fields.max_issues !== undefined) fields.max_issues = parseInt(fields.max_issues, 10) || 8;
    // Images/documents: only replace when an array is explicitly provided.
    if (Array.isArray(req.body.images)) fields.images = sanitizeImages(req.body.images);
    if (Array.isArray(req.body.documents)) fields.documents = sanitizeDocs(req.body.documents);
    const project = await updateProject(req.params.id, fields);
    res.json({ ok: true, project: { ...project, images: lightImages(project.images), documents: lightDocs(project.documents) } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Keep only valid image entries, capped.
function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((im) => im && im.data && /^image\//.test(im.media_type || ''))
    .slice(0, 5)
    .map((im) => ({ media_type: im.media_type, data: im.data, name: (im.name || 'image').slice(0, 80) }));
}

// Keep valid extracted documents, capped.
function sanitizeDocs(docs) {
  if (!Array.isArray(docs)) return [];
  return docs
    .filter((d) => d && d.text)
    .slice(0, 10)
    .map((d) => ({ name: (d.name || 'doc').slice(0, 120), text: String(d.text).slice(0, 20000) }));
}

router.delete('/projects/:id', async (req, res) => {
  if (!(await ownedProject(req, res))) return;
  await deleteProject(req.params.id);
  res.json({ ok: true });
});

// Send a chat message → append it and run (first message builds, later ones
// change the existing repo, with full conversation history).
router.post('/projects/:id/message', async (req, res) => {
  const project = await ownedProject(req, res);
  if (!project) return;
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Message is empty.' });

  const kind = project.builtRepo && project.work_mode !== 'open_source' ? 'change' : 'build';
  const images = sanitizeImages(req.body.images);
  const documents = sanitizeDocs(req.body.documents);
  await addProjectMessage(req.params.id, { role: 'user', text });
  const result = await startManualRun(req.params.id, { userMessage: text, kind, images, documents });
  if (result.error) return res.status(409).json({ ok: false, error: result.error });
  res.json({ ok: true, runId: result.runId, kind });
});

// Re-run with the saved brief (kept for compatibility / "rebuild").
router.post('/projects/:id/run', async (req, res) => {
  const project = await ownedProject(req, res);
  if (!project) return;
  const kind = project.builtRepo && project.work_mode !== 'open_source' ? 'change' : 'build';
  const result = await startManualRun(req.params.id, { userMessage: project.brief, kind });
  if (result.error) return res.status(409).json({ ok: false, error: result.error });
  res.json({ ok: true, runId: result.runId });
});

export default router;
