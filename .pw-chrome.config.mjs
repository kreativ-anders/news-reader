import base from './playwright.config.mjs';
export default { ...base, projects: base.projects.map((p) => ({ ...p, use: { ...p.use, channel: 'chrome' } })) };
