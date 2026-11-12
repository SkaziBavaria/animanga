export function isDownloadListed(item) {
  if (!item) return false;
  const status = item.status;
  return status === 'running'
    || status === 'queued'
    || status === 'failed'
    || status === 'cancelled'
    || (status === 'done' && Boolean(item.file));
}
