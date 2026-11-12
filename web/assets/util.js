export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtNumber(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '0';
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`;
  return number.toLocaleString('zh-CN');
}

export function timeAgo(value) {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function fmtBytes(value) {
  const size = Number(value ?? 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name) {
  const text = String(name ?? '').trim();
  if (!text) return '?';
  if (/[\u4e00-\u9fff]/.test(text)) return text.slice(-2);
  return text
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function roleLabel(role) {
  return { owner: '所有者', editor: '编辑者', viewer: '只读' }[role] ?? role;
}

export function classColor(color) {
  return (
    {
      jade: 'var(--jade)',
      clay: 'var(--clay)',
      ochre: 'var(--ochre)',
      indigo: 'var(--indigo)',
      teal: 'var(--teal)',
      plum: 'var(--plum)',
      slate: 'var(--slate)',
      ink: 'var(--ink)',
    }[color] ?? 'var(--jade)'
  );
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(query ?? '') };
}
