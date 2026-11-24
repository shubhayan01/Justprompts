// Fill the database with 8 weeks of FAKE data so you can explore the dashboard
// without API keys.  Run:  npm run seed   (or: node seed_demo.js)
// Delete the "Demo project (fake data)" from the UI when you're done looking.

import { buildDemoProject } from './src/demo.js';
import { insertProject } from './src/store.js';

const project = await insertProject(buildDemoProject());
const last = project.lastSummary?.brand;
console.log(`\n  ✓ Demo project created (id ${project.id}).`);
console.log(`    ${project.prompts.length} prompts · ${project.runs.length} answers this week · ${project.snapshots.length} weeks of history.`);
if (last) console.log(`    Latest: ${last.shareOfVoice}% share of voice · ${last.mentionRate}% mention rate · rank ${last.rankOverall ?? '—'}.`);
console.log(`\n  Start the app (npm start) and open the Demo project from "Recent".\n`);
