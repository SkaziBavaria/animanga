import { api, toast } from './api.js';
import { els } from './dom.js';
import { escapeHtml } from './util.js';

export async function loadJobs() {
  const data = await api('/api/jobs');
  const jobs = data.jobs || [];
  els.jobsList.innerHTML = jobs.length ? jobs.map((job) => `
    <article class="job-card">
      <strong>${escapeHtml(job.status)} · ${escapeHtml(job.label)}</strong>
      <span class="show-meta">${escapeHtml(job.startedAt || '')}</span>
      ${job.output ? `<pre>${escapeHtml(job.output)}</pre>` : ''}
      ${job.error ? `<pre>${escapeHtml(job.error)}</pre>` : ''}
    </article>
  `).join('') : '<div class="empty">No jobs.</div>';
}

export async function clearJobs() {
  const ok = window.confirm('Clear all job entries and job log files?');
  if (!ok) return;
  await api('/api/jobs', { method: 'DELETE' });
  els.jobsList.innerHTML = '<div class="empty">No jobs.</div>';
  toast('Jobs cleared');
}
