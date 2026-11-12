import { api, state, icon, escapeHtml as esc, timeAgo, toast, go, emptyState } from '../assets/core.js';

export async function renderNotifications() {
  const data = await api('/api/notifications?limit=60');
  const items = data.notifications ?? [];
  state.bootstrap.stats.notificationsUnread = data.unread;
  const rows = items
    .map(
      (item) => `<div class="notification-item ${item.readAt ? '' : 'unread'}">
        <span class="notification-icon">${icon(item.kind === 'review' ? 'check' : item.kind === 'comment' ? 'comment' : 'bell', 16)}</span>
        <div class="notification-body">
          <div class="title">${esc(item.title)}</div>
          ${item.body ? `<div class="desc">${esc(item.body)}</div>` : ''}
          <div class="time">${timeAgo(item.createdAt)}${item.actorName ? ` · ${esc(item.actorName)}` : ''}${item.readAt ? ' · 已读' : ''}</div>
        </div>
        <div class="btn-row">
          ${item.link ? `<a class="btn btn-sm" href="${esc(item.link)}">打开</a>` : ''}
          ${item.readAt ? '' : `<button class="btn btn-sm btn-ghost" data-read-notification="${esc(item.id)}">标为已读</button>`}
        </div>
      </div>`,
    )
    .join('');
  return `
    <div class="between" style="align-items:flex-end;margin-bottom:18px">
      <div><div class="eyebrow">INBOX · REVIEW · COMMENTS</div><h1 style="font-size:40px;letter-spacing:-.03em;margin:6px 0 4px">通知</h1><p class="muted" style="margin:0">校对、评论与协作提醒；已接入企业微信应用消息。</p></div>
      <div class="btn-row"><button class="btn btn-sm" id="read-all-notifications">${icon('check', 14)} 全部标为已读</button></div>
    </div>
    <div class="notification-list">${rows || emptyState('没有通知', '当有人评论、退回或批准知识页时，提醒会出现在这里。')}</div>`;
}

export function mountNotifications() {
  document.getElementById('read-all-notifications')?.addEventListener('click', async () => {
    try {
      await api('/api/notifications/read-all', { method: 'POST' });
      if (state.bootstrap?.stats) state.bootstrap.stats.notificationsUnread = 0;
      toast('已全部标记为已读', 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.querySelectorAll('[data-read-notification]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const result = await api(`/api/notifications/${encodeURIComponent(button.dataset.readNotification)}/read`, { method: 'POST' });
        if (state.bootstrap?.stats) state.bootstrap.stats.notificationsUnread = result.unread ?? 0;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}
