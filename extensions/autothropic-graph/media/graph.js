// @ts-check
/// <reference lib="dom" />

/**
 * Agent Graph — interactive node graph for multi-agent orchestration.
 * Ported from autothropic's GraphView.tsx + GraphNode.tsx + GraphEdge.tsx.
 *
 * Runs inside a VS Code webview. Communicates with the extension host
 * via vscode.postMessage / onDidReceiveMessage.
 */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const NODE_W = 240;
  const NODE_H = 110;
  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 2;
  const PORT_GAP = 20;
  const BACKWARD_MARGIN = 40;

  const CONDITION_LABELS = { all: '', 'code-changes': 'code', errors: 'err', 'summary-only': 'sum' };
  const AGENT_COLORS = ['#d97757','#539bf5','#57ab5a','#9d4edd','#D4A574','#f28482','#4cc9f0','#d4876a'];

  const ROLE_PRESETS = [
    { label: 'Leader', prompt: 'You are the team leader. Coordinate work across agents. Break down tasks, delegate to workers, and synthesize their outputs into a cohesive result.' },
    { label: 'Reviewer', prompt: 'You are a strict code reviewer. Review code for bugs, security issues, performance, and quality. Provide clear, actionable feedback.' },
    { label: 'Builder', prompt: 'You are a builder/implementer. Write clean, working code to complete the assigned task. Follow best practices and write tests when appropriate.' },
    { label: 'Tester', prompt: 'You are a QA tester. Write comprehensive tests, verify edge cases, and ensure code correctness. Report failures clearly with reproduction steps.' },
    { label: 'Debugger', prompt: 'You are a debugger. Investigate issues, trace root causes, and fix bugs. Use systematic debugging approaches and explain your findings.' },
    { label: 'Architect', prompt: 'You are a software architect. Design system architecture, define interfaces, plan technical approaches, and ensure consistency across the codebase.' },
    { label: 'Verifier', prompt: 'You are a verifier. Check that implementations match requirements, validate outputs, and confirm correctness before signing off.' },
    { label: 'Minion', prompt: 'You are a task executor. Follow instructions precisely, complete assigned work thoroughly, and report results concisely.' },
  ];

  /** @type {any[]} */ let sessions = [];
  /** @type {any[]} */ let edges = [];
  /** @type {Record<string, string[]>} */ let outputPreviews = {};
  let zoom = 1;
  let panX = 0, panY = 0;
  let selectedId = null;
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panStartPanX = 0, panStartPanY = 0;

  // Edge connection drag state
  let connectFromId = null;
  let connectMouseX = 0, connectMouseY = 0;
  let reconnectingEdgeId = null; // edge being reconnected via drag

  // Node drag state
  let dragNodeId = null;
  let dragStartX = 0, dragStartY = 0, dragOrigX = 0, dragOrigY = 0;

  // Pulse state
  const pulsingEdges = new Map(); // key -> timer

  // DOM refs
  const container = document.getElementById('graph-container');
  const edgeLayer = document.getElementById('edge-layer');
  const nodeLayer = document.getElementById('node-layer');
  const zoomLabel = document.getElementById('zoom-level');
  const statsEl = document.getElementById('stats');
  const instructionsEl = document.getElementById('instructions');
  const presetsDropdown = document.getElementById('presets-dropdown');
  const edgeMenu = document.getElementById('edge-menu');
  const contextMenu = document.getElementById('context-menu');
  const broadcastInput = document.getElementById('broadcast-input');
  const idleCountEl = document.getElementById('idle-count');

  // --- Init ---
  vscode.postMessage({ type: 'ready' });

  // --- Message handling ---
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'update':
        sessions = msg.sessions || [];
        edges = msg.edges || [];
        outputPreviews = msg.outputPreviews || {};
        render();
        break;
      case 'edgePulse':
        pulseEdge(msg.fromId, msg.toId);
        break;
    }
  });

  // --- Render ---
  function render() {
    renderNodes();
    renderEdges();
    updateStats();
    updateInstructions();
  }

  function renderNodes() {
    nodeLayer.innerHTML = '';
    for (const session of sessions) {
      const node = createNodeElement(session);
      nodeLayer.appendChild(node);
    }
  }

  function createNodeElement(session) {
    const isOrch = session.isOrchestrator;
    const needsInput = session.needsInput;
    let classes = 'graph-node';
    if (session.id === selectedId) classes += ' selected';
    if (session.status === 'paused') classes += ' paused';
    if (isOrch) classes += ' orchestrator';
    if (needsInput) classes += ' needs-input';
    const el = document.createElement('div');
    el.className = classes;
    el.style.left = session.graphPosition.x + 'px';
    el.style.top = session.graphPosition.y + 'px';
    el.dataset.nodeId = session.id;
    el.style.setProperty('--node-color', session.color);

    if (needsInput || session.status === 'input_needed') {
      el.style.animation = 'input-pulse 1.5s ease-in-out infinite';
      el.style.setProperty('--pulse-color', '#d4a04a66');
    } else if (session.status === 'running') {
      el.style.animation = 'node-pulse 2s ease-in-out infinite';
      el.style.setProperty('--pulse-color', session.color + '66');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'node-header';
    header.style.backgroundColor = session.color + '15';
    header.style.borderBottom = '1px solid ' + session.color + '30';

    // Orchestrator crown icon
    if (isOrch) {
      const crown = document.createElement('span');
      crown.className = 'orchestrator-icon';
      crown.textContent = '★';
      header.appendChild(crown);
    }

    const dot = document.createElement('span');
    dot.className = 'status-dot' + (session.status === 'running' ? ' running' : session.status === 'input_needed' ? ' running' : '');
    dot.style.background = statusColor(session.status);
    header.appendChild(dot);

    // Needs-input bell icon (from needsInput flag or input_needed status)
    if (needsInput || session.status === 'input_needed') {
      const bell = document.createElement('span');
      bell.className = 'input-bell';
      bell.textContent = '🔔';
      bell.title = 'Needs your input';
      bell.addEventListener('click', (e) => {
        e.stopPropagation();
        showInputModal(session);
      });
      header.appendChild(bell);
    }

    if (session.humanInLoop) {
      const eye = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      eye.setAttribute('width', '9');
      eye.setAttribute('height', '9');
      eye.setAttribute('viewBox', '0 0 24 24');
      eye.setAttribute('fill', 'none');
      eye.setAttribute('stroke', '#d4a04a');
      eye.setAttribute('stroke-width', '2.5');
      eye.setAttribute('stroke-linecap', 'round');
      eye.setAttribute('stroke-linejoin', 'round');
      eye.classList.add('hitl-icon');
      eye.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
      header.appendChild(eye);
    }

    const name = document.createElement('span');
    name.className = 'node-name';
    name.textContent = session.name;
    header.appendChild(name);

    const status = document.createElement('span');
    status.className = 'node-status';
    status.textContent = session.status === 'input_needed' ? 'input needed' : session.status;
    header.appendChild(status);

    el.appendChild(header);

    // Body — live output, exited banner, or fallback
    const body = document.createElement('div');
    body.className = 'node-body';
    if (session.status === 'exited') {
      const exitedBanner = document.createElement('div');
      exitedBanner.className = 'node-exited';
      exitedBanner.textContent = 'Claude exited';
      body.appendChild(exitedBanner);
      const restartBtn = document.createElement('button');
      restartBtn.className = 'node-restart-btn';
      restartBtn.textContent = 'Restart';
      restartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'restartSession', id: session.id });
      });
      body.appendChild(restartBtn);
    } else {
      const lines = outputPreviews[session.id];
      if (lines && lines.length > 0) {
        const output = document.createElement('div');
        output.className = 'node-output';
        for (const line of lines.slice(-3)) {
          const lineEl = document.createElement('div');
          lineEl.className = 'line';
          lineEl.textContent = line.slice(0, 120);
          output.appendChild(lineEl);
        }
        body.appendChild(output);
      } else {
        const empty = document.createElement('div');
        empty.className = 'node-empty';
        empty.textContent = session.systemPrompt ? session.systemPrompt.slice(0, 80) + (session.systemPrompt.length > 80 ? '...' : '') : 'Idle';
        body.appendChild(empty);
      }
    }
    el.appendChild(body);

    // Input port
    const inputPort = document.createElement('div');
    inputPort.className = 'port input';
    inputPort.dataset.port = 'input';
    inputPort.dataset.nodeId = session.id;
    el.appendChild(inputPort);

    // Output port
    const outputPort = document.createElement('div');
    outputPort.className = 'port output';
    outputPort.dataset.port = 'output';
    outputPort.dataset.nodeId = session.id;
    el.appendChild(outputPort);

    // Event listeners
    el.addEventListener('mousedown', (e) => onNodeMouseDown(e, session));
    el.addEventListener('dblclick', () => {
      vscode.postMessage({ type: 'focusTerminal', id: session.id });
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedId = session.id;
      renderNodes();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, session);
    });

    inputPort.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      if (connectFromId && connectFromId !== session.id) {
        vscode.postMessage({ type: 'addEdge', from: connectFromId, to: session.id });
        connectFromId = null;
        renderEdges();
      }
    });

    outputPort.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      connectFromId = session.id;
      const canvasPos = screenToCanvas(e.clientX, e.clientY);
      connectMouseX = canvasPos.x;
      connectMouseY = canvasPos.y;
    });

    return el;
  }

  function renderEdges() {
    // Use SVG namespace
    const ns = 'http://www.w3.org/2000/svg';
    edgeLayer.innerHTML = '';

    // Defs
    const defs = document.createElementNS(ns, 'defs');
    // Arrowhead markers are created per-edge color below

    // Grid pattern
    const pattern = document.createElementNS(ns, 'pattern');
    pattern.setAttribute('id', 'grid');
    pattern.setAttribute('width', '20');
    pattern.setAttribute('height', '20');
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    const gridPath = document.createElementNS(ns, 'path');
    gridPath.setAttribute('d', 'M 20 0 L 0 0 0 20');
    gridPath.setAttribute('fill', 'none');
    gridPath.setAttribute('stroke', getComputedStyle(document.documentElement).getPropertyValue('--g-border').trim() || '#232320');
    gridPath.setAttribute('stroke-width', '0.5');
    pattern.appendChild(gridPath);
    defs.appendChild(pattern);
    edgeLayer.appendChild(defs);

    // Apply transform to SVG
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);

    // Grid background
    const gridRect = document.createElementNS(ns, 'rect');
    gridRect.setAttribute('x', '-5000');
    gridRect.setAttribute('y', '-5000');
    gridRect.setAttribute('width', '10000');
    gridRect.setAttribute('height', '10000');
    gridRect.setAttribute('fill', 'url(#grid)');
    g.appendChild(gridRect);

    // Orange chevron arrowhead — always visible
    const arrowId = 'arrow-chevron';
    const arrowMarker = document.createElementNS(ns, 'marker');
    arrowMarker.setAttribute('id', arrowId);
    arrowMarker.setAttribute('markerWidth', '12');
    arrowMarker.setAttribute('markerHeight', '12');
    arrowMarker.setAttribute('refX', '10');
    arrowMarker.setAttribute('refY', '6');
    arrowMarker.setAttribute('orient', 'auto');
    arrowMarker.setAttribute('markerUnits', 'userSpaceOnUse');
    const chevron = document.createElementNS(ns, 'polyline');
    chevron.setAttribute('points', '3,2 10,6 3,10');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('stroke', '#d97757');
    chevron.setAttribute('stroke-width', '2');
    chevron.setAttribute('stroke-linecap', 'round');
    chevron.setAttribute('stroke-linejoin', 'round');
    arrowMarker.appendChild(chevron);
    defs.appendChild(arrowMarker);

    // Edges
    for (const edge of edges) {
      const from = sessions.find(s => s.id === edge.from);
      const to = sessions.find(s => s.id === edge.to);
      if (!from || !to) continue;

      const x1 = from.graphPosition.x + NODE_W;
      const y1 = from.graphPosition.y + NODE_H / 2;
      const x2 = to.graphPosition.x;
      const y2 = to.graphPosition.y + NODE_H / 2;

      const pathD = buildEdgePath(x1, y1, x2, y2, from, to);
      const edgeKey = edge.from + '->' + edge.to;
      const isActive = pulsingEdges.has(edgeKey);
      const edgeColor = from.color || '#d97757';
      const pathLen = (() => {
        const tmp = document.createElementNS(ns, 'path');
        tmp.setAttribute('d', pathD);
        edgeLayer.appendChild(tmp);
        const len = tmp.getTotalLength();
        edgeLayer.removeChild(tmp);
        return len;
      })();

      // Hit area
      const hitArea = document.createElementNS(ns, 'path');
      hitArea.setAttribute('d', pathD);
      hitArea.setAttribute('fill', 'none');
      hitArea.setAttribute('stroke', 'transparent');
      hitArea.setAttribute('stroke-width', '14');
      hitArea.style.cursor = 'context-menu';
      hitArea.style.pointerEvents = 'stroke';
      hitArea.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showEdgeMenu(e.clientX, e.clientY, edge);
      });
      hitArea.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: 'removeEdge', edgeId: edge.id });
      });
      hitArea.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Start reconnecting: remove old edge, begin connect-from source
        reconnectingEdgeId = edge.id;
        connectFromId = edge.from;
        const canvasPos = screenToCanvas(e.clientX, e.clientY);
        connectMouseX = canvasPos.x;
        connectMouseY = canvasPos.y;
        // Remove edge immediately so preview line shows
        vscode.postMessage({ type: 'removeEdge', edgeId: edge.id });
      });
      g.appendChild(hitArea);

      // Base dotted line — always present
      const basePath = document.createElementNS(ns, 'path');
      basePath.setAttribute('d', pathD);
      basePath.setAttribute('fill', 'none');
      basePath.setAttribute('stroke', '#d97757');
      basePath.setAttribute('stroke-width', '1.5');
      basePath.setAttribute('stroke-opacity', isActive ? '0.55' : '0.4');
      basePath.setAttribute('stroke-dasharray', '3 4');
      basePath.setAttribute('stroke-linecap', 'round');
      basePath.setAttribute('marker-end', `url(#${arrowId})`);
      basePath.style.pointerEvents = 'none';
      g.appendChild(basePath);

      // Shimmer pulse: bright orange segment that travels along the path
      if (isActive) {
        // Glow underneath
        const glow = document.createElementNS(ns, 'path');
        glow.setAttribute('d', pathD);
        glow.setAttribute('fill', 'none');
        glow.setAttribute('stroke', '#c4845e');
        glow.setAttribute('stroke-width', '5');
        glow.setAttribute('stroke-opacity', '0.08');
        glow.setAttribute('stroke-linecap', 'round');
        glow.style.pointerEvents = 'none';
        g.appendChild(glow);

        // Bright traveling segment — a clipped portion of the path that sweeps forward
        const segLen = Math.min(pathLen * 0.35, 120);
        const shimmer = document.createElementNS(ns, 'path');
        shimmer.setAttribute('d', pathD);
        shimmer.setAttribute('fill', 'none');
        shimmer.setAttribute('stroke', '#c4845e');
        shimmer.setAttribute('stroke-width', '2');
        shimmer.setAttribute('stroke-linecap', 'round');
        shimmer.setAttribute('stroke-dasharray', `${segLen} ${pathLen}`);
        shimmer.setAttribute('stroke-dashoffset', String(segLen));
        shimmer.style.pointerEvents = 'none';
        // Animate dashoffset to sweep the bright segment along
        const anim = document.createElementNS(ns, 'animate');
        anim.setAttribute('attributeName', 'stroke-dashoffset');
        anim.setAttribute('from', String(segLen));
        anim.setAttribute('to', String(-pathLen));
        anim.setAttribute('dur', '0.6s');
        anim.setAttribute('repeatCount', 'indefinite');
        shimmer.appendChild(anim);
        g.appendChild(shimmer);
      }

      // Condition / iteration label
      const condLabel = CONDITION_LABELS[edge.condition] || '';
      const iterLabel = edge.maxIterations > 0 ? `${edge.iterationCount}/${edge.maxIterations}` : '';
      const label = [condLabel, iterLabel].filter(Boolean).join(' ');
      if (label) {
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2 - 8;
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', String(midX));
        text.setAttribute('y', String(midY));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'rgba(255,255,255,0.35)');
        text.setAttribute('font-size', '9');
        text.style.pointerEvents = 'none';
        text.textContent = label;
        g.appendChild(text);
      }
    }

    // Connect drag preview line
    if (connectFromId) {
      const from = sessions.find(s => s.id === connectFromId);
      if (from) {
        const x1 = from.graphPosition.x + NODE_W;
        const y1 = from.graphPosition.y + NODE_H / 2;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('y1', String(y1));
        line.setAttribute('x2', String(connectMouseX));
        line.setAttribute('y2', String(connectMouseY));
        line.setAttribute('stroke', 'rgba(255,255,255,0.2)');
        line.setAttribute('stroke-width', String(1.5 / zoom));
        line.setAttribute('stroke-linecap', 'round');
        g.appendChild(line);
      }
    }

    edgeLayer.appendChild(g);
  }

  function buildEdgePath(x1, y1, x2, y2, from, to) {
    const dx = x2 - x1;
    if (dx > -PORT_GAP) {
      const cpOffset = Math.max(Math.abs(dx) * 0.4, 40);
      return `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`;
    }

    const fromTop = from.graphPosition.y;
    const fromBot = from.graphPosition.y + NODE_H;
    const toTop = to.graphPosition.y;
    const toBot = to.graphPosition.y + NODE_H;

    let minY = Infinity, maxY = -Infinity;
    for (const s of sessions) {
      minY = Math.min(minY, s.graphPosition.y);
      maxY = Math.max(maxY, s.graphPosition.y + NODE_H);
    }

    const spaceAbove = Math.min(fromTop, toTop) - minY;
    const spaceBelow = maxY - Math.max(fromBot, toBot);
    const routeAbove = spaceAbove >= spaceBelow - 20;

    const routeY = routeAbove
      ? Math.min(fromTop, toTop) - BACKWARD_MARGIN
      : Math.max(fromBot, toBot) + BACKWARD_MARGIN;

    const exitX = x1 + PORT_GAP;
    const entryX = x2 - PORT_GAP;
    const cornerR = 16;
    const vDir = routeAbove ? -1 : 1;

    return [
      `M ${x1} ${y1}`,
      `L ${exitX} ${y1}`,
      `Q ${exitX + cornerR} ${y1}, ${exitX + cornerR} ${y1 + vDir * cornerR}`,
      `L ${exitX + cornerR} ${routeY + (-vDir * cornerR)}`,
      `Q ${exitX + cornerR} ${routeY}, ${exitX} ${routeY}`,
      `L ${entryX} ${routeY}`,
      `Q ${entryX - cornerR} ${routeY}, ${entryX - cornerR} ${routeY + (-vDir * cornerR)}`,
      `L ${entryX - cornerR} ${y2 + (vDir * cornerR)}`,
      `Q ${entryX - cornerR} ${y2}, ${entryX} ${y2}`,
      `L ${x2} ${y2}`,
    ].join(' ');
  }

  // --- Interactions ---

  function screenToCanvas(sx, sy) {
    const rect = container.getBoundingClientRect();
    return {
      x: (sx - rect.left - panX) / zoom,
      y: (sy - rect.top - panY) / zoom,
    };
  }

  // Pan: mousedown on background
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest('.graph-node') || target.closest('.port')) return;

    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartPanX = panX;
    panStartPanY = panY;
    document.body.classList.add('grabbing');
    hideMenus();
  });

  window.addEventListener('mousemove', (e) => {
    if (isPanning) {
      panX = panStartPanX + (e.clientX - panStartX);
      panY = panStartPanY + (e.clientY - panStartY);
      applyTransform();
    }
    if (dragNodeId) {
      const dx = (e.clientX - dragStartX) / zoom;
      const dy = (e.clientY - dragStartY) / zoom;
      const session = sessions.find(s => s.id === dragNodeId);
      if (session) {
        session.graphPosition.x = Math.max(0, dragOrigX + dx);
        session.graphPosition.y = Math.max(0, dragOrigY + dy);
        const nodeEl = document.querySelector(`[data-node-id="${dragNodeId}"]`);
        if (nodeEl) {
          nodeEl.style.left = session.graphPosition.x + 'px';
          nodeEl.style.top = session.graphPosition.y + 'px';
        }
        renderEdges();
      }
    }
    if (connectFromId) {
      const canvasPos = screenToCanvas(e.clientX, e.clientY);
      connectMouseX = canvasPos.x;
      connectMouseY = canvasPos.y;
      renderEdges();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (isPanning) {
      isPanning = false;
      document.body.classList.remove('grabbing');
    }
    if (dragNodeId) {
      const session = sessions.find(s => s.id === dragNodeId);
      if (session) {
        vscode.postMessage({ type: 'updatePosition', id: dragNodeId, x: session.graphPosition.x, y: session.graphPosition.y });
      }
      dragNodeId = null;
    }
    if (connectFromId) {
      connectFromId = null;
      reconnectingEdgeId = null;
      renderEdges();
    }
  });

  function onNodeMouseDown(e, session) {
    if (e.target.closest('.port')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragNodeId = session.id;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOrigX = session.graphPosition.x;
    dragOrigY = session.graphPosition.y;
    hideMenus();
  }

  // Wheel: zoom / pan
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const zoomFactor = 1 - e.deltaY * 0.005;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * zoomFactor));
      const scale = newZoom / zoom;
      panX = mouseX - scale * (mouseX - panX);
      panY = mouseY - scale * (mouseY - panY);
      zoom = newZoom;
    } else {
      panX -= e.deltaX;
      panY -= e.deltaY;
    }
    applyTransform();
  }, { passive: false });

  function applyTransform() {
    nodeLayer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    renderEdges();
  }

  // --- Fit to view ---
  function fitToView() {
    if (sessions.length === 0) return;
    const rect = container.getBoundingClientRect();
    const padX = 60, padY = 40;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of sessions) {
      minX = Math.min(minX, s.graphPosition.x);
      minY = Math.min(minY, s.graphPosition.y);
      maxX = Math.max(maxX, s.graphPosition.x + NODE_W);
      maxY = Math.max(maxY, s.graphPosition.y + NODE_H);
    }

    const contentW = maxX - minX || 1;
    const contentH = maxY - minY || 1;
    const scaleX = (rect.width - padX * 2) / contentW;
    const scaleY = (rect.height - padY * 2) / contentH;
    zoom = Math.min(scaleX, scaleY, MAX_ZOOM, 1);

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    panX = rect.width / 2 - cx * zoom;
    panY = rect.height / 2 - cy * zoom;
    applyTransform();
    renderNodes();
  }

  // --- Toolbar ---
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const newZoom = Math.min(MAX_ZOOM, zoom * 1.3);
    const s = newZoom / zoom;
    panX = cx - s * (cx - panX);
    panY = cy - s * (cy - panY);
    zoom = newZoom;
    applyTransform();
    renderNodes();
  });

  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const newZoom = Math.max(MIN_ZOOM, zoom / 1.3);
    const s = newZoom / zoom;
    panX = cx - s * (cx - panX);
    panY = cy - s * (cy - panY);
    zoom = newZoom;
    applyTransform();
    renderNodes();
  });

  document.getElementById('btn-fit').addEventListener('click', fitToView);

  document.getElementById('btn-add-agent').addEventListener('click', () => {
    vscode.postMessage({ type: 'spawnAgent' });
  });

  // --- Presets ---
  document.getElementById('btn-presets').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!presetsDropdown.classList.contains('hidden')) {
      presetsDropdown.classList.add('hidden');
      return;
    }
    presetsDropdown.innerHTML = '';
    const presets = [
      { id: 'pipeline', label: 'Pipeline', description: 'Sequential: A → B → C' },
      { id: 'star', label: 'Star (Leader + Workers)', description: 'Leader delegates to N workers' },
      { id: 'fan-out-fan-in', label: 'Fan-out / Fan-in', description: 'Source → parallel Workers → Aggregator' },
      { id: 'review-loop', label: 'Review Loop', description: 'Builder ↔ Reviewer with iteration cap' },
    ];
    for (const p of presets) {
      const btn = document.createElement('button');
      btn.className = 'preset-item';
      btn.innerHTML = `<div class="preset-label">${p.label}</div><div class="preset-desc">${p.description}</div>`;
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'applyTopology', presetId: p.id });
        presetsDropdown.classList.add('hidden');
        setTimeout(fitToView, 200);
      });
      presetsDropdown.appendChild(btn);
    }
    presetsDropdown.classList.remove('hidden');
  });

  // --- Broadcast bar ---
  document.getElementById('btn-pause-all').addEventListener('click', () => {
    vscode.postMessage({ type: 'pauseAll' });
  });
  document.getElementById('btn-resume-all').addEventListener('click', () => {
    vscode.postMessage({ type: 'resumeAll' });
  });
  document.getElementById('btn-send-all').addEventListener('click', () => {
    const msg = broadcastInput.value.trim();
    if (msg) {
      vscode.postMessage({ type: 'broadcast', message: msg });
      broadcastInput.value = '';
    }
  });
  broadcastInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const msg = broadcastInput.value.trim();
      if (msg) {
        vscode.postMessage({ type: 'broadcast', message: msg });
        broadcastInput.value = '';
      }
    }
  });

  // --- Edge context menu ---
  function showEdgeMenu(x, y, edge) {
    hideMenus();
    edgeMenu.innerHTML = '';

    const conditions = [
      { value: 'all', label: 'All output', desc: 'Always forward' },
      { value: 'code-changes', label: 'Code changes', desc: 'File modifications only' },
      { value: 'errors', label: 'Errors only', desc: 'Error/failure output' },
      { value: 'summary-only', label: 'Summary only', desc: 'Aggressive summarization' },
    ];

    const section1 = document.createElement('div');
    section1.className = 'menu-section';
    section1.textContent = 'CONDITION';
    edgeMenu.appendChild(section1);

    for (const c of conditions) {
      const btn = document.createElement('button');
      btn.className = 'menu-item' + (edge.condition === c.value ? ' active' : '');
      btn.textContent = c.label;
      btn.title = c.desc;
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'updateEdge', edgeId: edge.id, patch: { condition: c.value } });
        hideMenus();
      });
      edgeMenu.appendChild(btn);
    }

    edgeMenu.appendChild(createDivider());

    const section2 = document.createElement('div');
    section2.className = 'menu-section';
    section2.textContent = 'MAX ITERATIONS';
    edgeMenu.appendChild(section2);

    const iters = [0, 1, 2, 3, 5, 10];
    for (const n of iters) {
      const btn = document.createElement('button');
      btn.className = 'menu-item' + (edge.maxIterations === n ? ' active' : '');
      btn.textContent = n === 0 ? '∞ Unlimited' : String(n);
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'updateEdge', edgeId: edge.id, patch: { maxIterations: n } });
        hideMenus();
      });
      edgeMenu.appendChild(btn);
    }

    edgeMenu.appendChild(createDivider());

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'menu-item destructive';
    deleteBtn.textContent = 'Disconnect';
    deleteBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'removeEdge', edgeId: edge.id });
      hideMenus();
    });
    edgeMenu.appendChild(deleteBtn);

    edgeMenu.classList.remove('hidden');
    clampMenuToViewport(edgeMenu, x, y);
  }

  // --- Node context menu ---
  function showContextMenu(x, y, session) {
    hideMenus();
    contextMenu.innerHTML = '';

    // Rename — inline input (prompt() doesn't work in webviews)
    const renameBtn = document.createElement('button');
    renameBtn.className = 'menu-item';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrapper = document.createElement('div');
      wrapper.className = 'custom-role-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'New name...';
      input.value = session.name;
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '✓';
      confirmBtn.title = 'Rename';
      wrapper.appendChild(input);
      wrapper.appendChild(confirmBtn);
      renameBtn.replaceWith(wrapper);
      input.focus();
      input.select();
      const submit = () => {
        const name = input.value.trim();
        if (name) {
          vscode.postMessage({ type: 'renameSession', id: session.id, name });
        }
        hideMenus();
      };
      confirmBtn.addEventListener('click', (ev) => { ev.stopPropagation(); submit(); });
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') submit();
        if (ev.key === 'Escape') hideMenus();
      });
      input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    });
    contextMenu.appendChild(renameBtn);

    // Set Role — section header
    const roleSection = document.createElement('div');
    roleSection.className = 'menu-section';
    roleSection.textContent = 'ROLE';
    contextMenu.appendChild(roleSection);

    // Role preset grid
    const roleGrid = document.createElement('div');
    roleGrid.className = 'role-grid';
    for (const preset of ROLE_PRESETS) {
      const chip = document.createElement('button');
      chip.className = 'role-chip';
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        vscode.postMessage({ type: 'setRole', id: session.id, role: preset.prompt });
        vscode.postMessage({ type: 'renameSession', id: session.id, name: preset.label });
        hideMenus();
      });
      roleGrid.appendChild(chip);
    }
    contextMenu.appendChild(roleGrid);

    // Custom role — inline input (prompt() doesn't work in webviews)
    const customRoleBtn = document.createElement('button');
    customRoleBtn.className = 'menu-item';
    customRoleBtn.textContent = 'Custom Role...';
    customRoleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Replace button with inline input
      const wrapper = document.createElement('div');
      wrapper.className = 'custom-role-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'System prompt...';
      input.value = session.systemPrompt || '';
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '✓';
      confirmBtn.title = 'Set role';
      wrapper.appendChild(input);
      wrapper.appendChild(confirmBtn);
      customRoleBtn.replaceWith(wrapper);
      input.focus();
      input.select();
      const submit = () => {
        const role = input.value.trim();
        if (role) {
          vscode.postMessage({ type: 'setRole', id: session.id, role });
        }
        hideMenus();
      };
      confirmBtn.addEventListener('click', (ev) => { ev.stopPropagation(); submit(); });
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') submit();
        if (ev.key === 'Escape') hideMenus();
      });
      input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    });
    contextMenu.appendChild(customRoleBtn);

    contextMenu.appendChild(createDivider());

    // Colors
    for (const c of AGENT_COLORS) {
      const btn = document.createElement('button');
      btn.className = 'menu-item' + (session.color === c ? ' active' : '');
      btn.textContent = '● ' + c;
      btn.style.color = c;
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'setColor', id: session.id, color: c });
        hideMenus();
      });
      contextMenu.appendChild(btn);
    }

    contextMenu.appendChild(createDivider());

    // HITL
    const hitlBtn = document.createElement('button');
    hitlBtn.className = 'menu-item';
    hitlBtn.textContent = session.humanInLoop ? '✓ HITL Enabled' : 'Enable HITL';
    hitlBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggleHITL', id: session.id, enabled: !session.humanInLoop });
      hideMenus();
    });
    contextMenu.appendChild(hitlBtn);

    // Fanout mode toggle
    const fanoutBtn = document.createElement('button');
    fanoutBtn.className = 'menu-item';
    const isSplit = session.fanoutMode === 'split';
    fanoutBtn.textContent = isSplit ? '✓ Split Output' : 'Split Output';
    fanoutBtn.title = isSplit ? 'Currently splitting tasks across downstream agents. Click to broadcast instead.' : 'Split numbered/bullet list items across downstream agents instead of broadcasting.';
    fanoutBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setFanoutMode', id: session.id, mode: isSplit ? 'broadcast' : 'split' });
      hideMenus();
    });
    contextMenu.appendChild(fanoutBtn);

    contextMenu.appendChild(createDivider());

    // Delete
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'menu-item destructive';
    deleteBtn.textContent = 'Delete Agent';
    deleteBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'removeSession', id: session.id });
      hideMenus();
    });
    contextMenu.appendChild(deleteBtn);

    contextMenu.classList.remove('hidden');
    clampMenuToViewport(contextMenu, x, y);
  }

  function clampMenuToViewport(menu, x, y) {
    // Position first so we can measure
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) x -= rect.right - vw + 4;
    if (rect.bottom > vh) y -= rect.bottom - vh + 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function createDivider() {
    const div = document.createElement('div');
    div.className = 'menu-divider';
    return div;
  }

  function hideMenus() {
    edgeMenu.classList.add('hidden');
    contextMenu.classList.add('hidden');
    presetsDropdown.classList.add('hidden');
  }

  // Hide menus on click outside
  document.addEventListener('mousedown', (e) => {
    if (!edgeMenu.contains(e.target) && !contextMenu.contains(e.target) && !presetsDropdown.contains(e.target)) {
      hideMenus();
    }
  });

  // --- Edge pulse ---
  function pulseEdge(fromId, toId) {
    const key = fromId + '->' + toId;
    const existing = pulsingEdges.get(key);
    if (existing) clearTimeout(existing);
    pulsingEdges.set(key, setTimeout(() => {
      pulsingEdges.delete(key);
      renderEdges();
    }, 800));
    renderEdges();
  }

  // --- Stats ---
  function updateStats() {
    const active = sessions.filter(s => s.status === 'running').length;
    const idle = sessions.filter(s => s.status === 'waiting').length;
    const inputNeeded = sessions.filter(s => s.status === 'input_needed').length;
    let statsText = `${active} active · ${idle} idle`;
    if (inputNeeded > 0) { statsText += ` · ${inputNeeded} input needed`; }
    statsEl.textContent = statsText;
    idleCountEl.textContent = `${idle} idle`;
  }

  function updateInstructions() {
    if (sessions.length > 0 && edges.length === 0) {
      instructionsEl.classList.remove('hidden');
    } else {
      instructionsEl.classList.add('hidden');
    }
  }

  // --- Input Modal ---
  function showInputModal(session) {
    // Remove existing modal if any
    let existing = document.getElementById('input-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'input-modal';

    const lines = outputPreviews[session.id] || [];
    const context = lines.slice(-3).join('\n') || 'Agent is waiting for input...';

    modal.innerHTML = `
      <div class="input-modal-header">
        <span class="input-modal-dot" style="background: ${session.color}"></span>
        <span class="input-modal-name">${session.name}</span>
        <button class="input-modal-close">✕</button>
      </div>
      <div class="input-modal-context">${escapeHtml(context)}</div>
      <div class="input-modal-row">
        <input class="input-modal-field" type="text" placeholder="Type your response..." autofocus />
        <button class="input-modal-send">Send</button>
      </div>
      <button class="input-modal-terminal">Open Terminal</button>
    `;

    document.body.appendChild(modal);

    const input = modal.querySelector('.input-modal-field');
    const sendBtn = modal.querySelector('.input-modal-send');
    const closeBtn = modal.querySelector('.input-modal-close');
    const termBtn = modal.querySelector('.input-modal-terminal');

    const send = () => {
      const val = input.value.trim();
      if (val) {
        vscode.postMessage({ type: 'sendInput', sessionId: session.id, input: val });
        modal.remove();
      }
    };

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
      if (e.key === 'Escape') modal.remove();
    });
    closeBtn.addEventListener('click', () => modal.remove());
    termBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'focusTerminal', id: session.id });
      modal.remove();
    });

    setTimeout(() => input.focus(), 50);
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Helpers ---
  function statusColor(status) {
    switch (status) {
      case 'running': return '#57ab5a';
      case 'waiting': return '#539bf5';
      case 'input_needed': return '#d4a04a';
      case 'paused': return '#d4a04a';
      case 'error': return '#e5534b';
      case 'exited': return '#e5534b';
      default: return '#7a7870';
    }
  }

  // Initial fit after first data load
  let firstLoad = true;
  const originalRender = render;
  render = function () {
    originalRender();
    if (firstLoad && sessions.length > 0) {
      firstLoad = false;
      setTimeout(fitToView, 50);
    }
  };
})();
