/** 轻量力导向图：无外部依赖，支持缩放、拖动、悬停与点击。 */
export function mountGraph(canvas, input, options = {}) {
  const ctx = canvas.getContext('2d');
  const nodes = input.nodes.map((node, index) => ({
    ...node,
    x: Math.cos((index / Math.max(1, input.nodes.length)) * Math.PI * 2) * 220 + (Math.random() - 0.5) * 40,
    y: Math.sin((index / Math.max(1, input.nodes.length)) * Math.PI * 2) * 220 + (Math.random() - 0.5) * 40,
    vx: 0,
    vy: 0,
    radius: 5 + Math.min(13, Math.sqrt(node.degree ?? 1) * 2.6),
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = input.edges
    .map((edge) => ({ ...edge, a: byId.get(edge.source), b: byId.get(edge.target) }))
    .filter((edge) => edge.a && edge.b);

  let width = 800;
  let height = 600;
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = null;
  let panning = null;
  let hover = null;
  let animation = 0;
  let alpha = 0.9;

  const palette = {
    jade: '#2f6a58',
    clay: '#9b3d2c',
    ochre: '#b8892f',
    indigo: '#4b5b8f',
    teal: '#2d7b7b',
    plum: '#7b4f6b',
    slate: '#6b6b6b',
    ink: '#24211c',
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(320, rect.width);
    height = Math.max(320, rect.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function toWorld(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - width / 2 - offsetX) / scale,
      y: (event.clientY - rect.top - height / 2 - offsetY) / scale,
    };
  }

  function step() {
    const count = nodes.length;
    if (alpha > 0.02) {
      for (let i = 0; i < count; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < count; j += 1) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const strength = Math.min(900, (5200 / (distance * distance)) * alpha);
          dx = (dx / distance) * strength;
          dy = (dy / distance) * strength;
          a.vx += dx;
          a.vy += dy;
          b.vx -= dx;
          b.vy -= dy;
        }
      }
      for (const edge of edges) {
        const dx = edge.b.x - edge.a.x;
        const dy = edge.b.y - edge.a.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const desired = 120 + (edge.a.radius + edge.b.radius) * 3;
        const force = ((distance - desired) / distance) * 0.012 * alpha;
        edge.a.vx += dx * force;
        edge.a.vy += dy * force;
        edge.b.vx -= dx * force;
        edge.b.vy -= dy * force;
      }
      for (const node of nodes) {
        node.vx -= node.x * 0.0018 * alpha;
        node.vy -= node.y * 0.0018 * alpha;
        node.vx *= 0.86;
        node.vy *= 0.86;
        if (node !== dragging) {
          node.x += node.vx;
          node.y += node.vy;
        }
      }
      alpha *= 0.985;
    }
    draw();
    animation = requestAnimationFrame(step);
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2 + offsetX, height / 2 + offsetY);
    ctx.scale(scale, scale);

    for (const edge of edges) {
      const highlighted = hover && (edge.a === hover || edge.b === hover);
      ctx.beginPath();
      ctx.moveTo(edge.a.x, edge.a.y);
      ctx.lineTo(edge.b.x, edge.b.y);
      ctx.strokeStyle = highlighted ? 'rgba(155,61,44,0.5)' : 'rgba(36,33,28,0.11)';
      ctx.lineWidth = highlighted ? 1.6 : 0.8;
      ctx.stroke();
    }

    for (const node of nodes) {
      const color = palette[node.color] ?? palette.jade;
      const active = node === hover || (hover && edges.some((e) => (e.a === node && e.b === hover) || (e.b === node && e.a === hover)));
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + (active ? 2 : 0), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = active ? 1 : 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (node.status === 'draft') {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(184,137,47,0.8)';
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (node === hover) {
        ctx.fillStyle = 'rgba(36,33,28,0.9)';
        ctx.font = '600 12px -apple-system, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        const title = node.title.length > 22 ? `${node.title.slice(0, 22)}…` : node.title;
        ctx.fillText(title, node.x, node.y - node.radius - 10);
      } else if ((node.degree ?? 0) >= 4 && nodes.length < 120) {
        ctx.fillStyle = 'rgba(36,33,28,0.62)';
        ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        const title = node.title.length > 16 ? `${node.title.slice(0, 16)}…` : node.title;
        ctx.fillText(title, node.x, node.y + node.radius + 14);
      }
    }
    ctx.restore();
  }

  function nodeAt(event) {
    const point = toWorld(event);
    let closest = null;
    let best = Infinity;
    for (const node of nodes) {
      const distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance < node.radius + 6 && distance < best) {
        closest = node;
        best = distance;
      }
    }
    return closest;
  }

  function onPointerDown(event) {
    const node = nodeAt(event);
    if (node) {
      dragging = node;
      node.fixed = true;
      canvas.setPointerCapture(event.pointerId);
    } else {
      panning = { x: event.clientX - offsetX, y: event.clientY - offsetY };
    }
    alpha = Math.max(alpha, 0.15);
  }

  function onPointerMove(event) {
    if (dragging) {
      const point = toWorld(event);
      dragging.x = point.x;
      dragging.y = point.y;
      dragging.vx = 0;
      dragging.vy = 0;
      return;
    }
    if (panning) {
      offsetX = event.clientX - panning.x;
      offsetY = event.clientY - panning.y;
      return;
    }
    const next = nodeAt(event);
    if (next !== hover) {
      hover = next;
      canvas.style.cursor = next ? 'pointer' : 'grab';
    }
  }

  function onPointerUp(event) {
    if (dragging) {
      const moved = Math.hypot(dragging.vx, dragging.vy);
      if (moved < 1 && options.onSelect) options.onSelect(dragging);
      dragging.fixed = false;
      dragging = null;
    }
    panning = null;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  function onClick(event) {
    const node = nodeAt(event);
    if (node && options.onSelect && !panning) options.onSelect(node);
  }

  function onWheel(event) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    scale = Math.max(0.35, Math.min(2.8, scale * factor));
  }

  resize();
  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  animation = requestAnimationFrame(step);

  return {
    destroy() {
      cancelAnimationFrame(animation);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('wheel', onWheel);
    },
    fit() {
      scale = 1;
      offsetX = 0;
      offsetY = 0;
    },
  };
}
