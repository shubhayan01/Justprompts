// Tiny JSON-file datastore. No native dependencies (works everywhere Node does).
// Everything lives in data/db.json. For a single-user local tool this is plenty,
// and it keeps the whole history in one portable, inspectable file.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets a host (e.g. a Render persistent disk mounted at /data) override
// where the database lives. Falls back to the local ./data folder.
const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'db.json');

let cache = null;

async function load() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    try { cache = JSON.parse(await readFile(DB_PATH, 'utf8')); } catch { cache = { projects: [] }; }
  } else {
    cache = { projects: [] };
  }
  if (!cache.projects) cache.projects = [];
  return cache;
}

async function persist() {
  const tmp = DB_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(tmp, DB_PATH); // atomic on same volume
}

export const uid = () => randomUUID().slice(0, 8);

export async function listProjects() {
  const db = await load();
  return db.projects.map((p) => ({
    id: p.id, name: p.name, brandName: p.brandName, brandDomain: p.brandDomain,
    competitors: p.competitors?.length || 0, prompts: p.prompts?.length || 0,
    runs: p.runs?.length || 0, snapshots: p.snapshots?.length || 0, updatedAt: p.updatedAt,
  }));
}

export async function getProject(id) {
  const db = await load();
  return db.projects.find((p) => p.id === id) || null;
}

export async function createProject(data) {
  const db = await load();
  const now = new Date().toISOString();
  const project = {
    id: uid(),
    name: data.name || data.brandName || 'Untitled project',
    brandName: data.brandName || '',
    brandDomain: data.brandDomain || '',
    brandAliases: data.brandAliases || [],
    competitors: data.competitors || [],      // [{name, domain}]
    preferFree: data.preferFree !== false,
    pages: [],                                 // crawled pages
    keywords: [],                              // mined keywords/themes
    prompts: [],                               // generated prompts [{id,text,intent,keyword}]
    runs: [],                                  // individual engine runs
    snapshots: [],                             // scored summaries over time
    createdAt: now,
    updatedAt: now,
  };
  db.projects.push(project);
  await persist();
  return project;
}

export async function updateProject(id, patch) {
  const db = await load();
  const p = db.projects.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return p;
}

export async function deleteProject(id) {
  const db = await load();
  const before = db.projects.length;
  db.projects = db.projects.filter((p) => p.id !== id);
  await persist();
  return db.projects.length < before;
}

// Mutate a project via a callback, then persist. Returns the project.
export async function mutate(id, fn) {
  const db = await load();
  const p = db.projects.find((x) => x.id === id);
  if (!p) return null;
  await fn(p);
  p.updatedAt = new Date().toISOString();
  await persist();
  return p;
}
