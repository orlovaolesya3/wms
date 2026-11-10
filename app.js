// WMS Simulator - Игровая логика

const TILE = 40;
const MAP_W = 26;
const MAP_H = 16;

const API_URL = 'http://localhost:8000/api/think';
const LLM_TIMEOUT_MS = 120000;

const INBOUND = { x: 1, y: 6, w: 3, h: 3 };
const OUTBOUND_ZONES = [
  { id: 1, x: 22, y: 2,  w: 3, h: 3, currentBoxes: 0, maxBoxes: 3 },
  { id: 2, x: 22, y: 7,  w: 3, h: 3, currentBoxes: 0, maxBoxes: 3 },
  { id: 3, x: 22, y: 12, w: 3, h: 3, currentBoxes: 0, maxBoxes: 3 },
];
const CHARGERS = [{ id: 1, x: 4, y: 14 }, { id: 2, x: 20, y: 1 }];

const COLORS = ['#587BD5', '#FFB3D1', '#8FB4FF'];
const T = { FLOOR: 0, CHARGER: 2 };

const BOX_EVERY = 30;
const QUEUE_LIMIT = 7;
const ORDER_TIMEOUT = 90;
const MAX_ACTIVE_ORDERS = 2;
const WALK_COST = 0.5;
const CHARGE_RATE = 5;
const PUSH_COST = 1;
const LOW_BATTERY_ALERTS = [25, 12];
const IDLE_THINK_COOLDOWN = 8; 
const MIN_GAP_BETWEEN_ASKS = 4; 

const DESTINATIONS = [
  { id: 'INBOUND', kind: 'inbound', label: 'Приёмка', rect: INBOUND },
  ...OUTBOUND_ZONES.map(z => ({ id: `OUTBOUND_${z.id}`, kind: 'outbound', zoneId: z.id, label: `Отгрузка #${z.id}`, rect: { x: z.x, y: z.y, w: z.w, h: z.h } })),
  ...CHARGERS.map(c => ({ id: `CHARGER_${c.id}`, kind: 'charger', chargerId: c.id, label: `Зарядка #${c.id}`, rect: { x: c.x, y: c.y, w: 1, h: 1 } })),
  { id: 'GO_TOP', kind: 'edge', label: 'Верхняя стена', rect: { x: 0, y: 1, w: 26, h: 2 } },
  { id: 'GO_BOTTOM', kind: 'edge', label: 'Нижняя стена', rect: { x: 0, y: 13, w: 26, h: 2 } },
];

const STEP_DIRS = {
  N: { dx: 0, dy: -1, name: 'вверх' },
  S: { dx: 0, dy: 1,  name: 'вниз' },
  W: { dx: -1, dy: 0, name: 'влево' },
  E: { dx: 1, dy: 0,  name: 'вправо' },
};

let state = {};
let loopInterval = null;
let canvas, ctx;
let nextBoxId = 1001;

function init() {
  canvas = document.getElementById('warehouseCanvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = MAP_W * TILE * dpr;
  canvas.height = MAP_H * TILE * dpr;
  ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  resetState();
  setupButtons();
  render();
  startLoop();
}

function resetState() {
  nextBoxId = 1001;
  state = {
    tick: 0, paused: false, speed: 1, map: generateMap(),
    agents: [
      createAgent(1, 'Робот-А', COLORS[0], 5, 5),
      createAgent(2, 'Робот-Б', COLORS[1], 5, 10),
      createAgent(3, 'Робот-В', COLORS[2], 9, 8),
    ],
    boxes: [], inboundQueue: [], orders: [],
    outboundZones: JSON.parse(JSON.stringify(OUTBOUND_ZONES)),
    events: [], chat: [], teamScore: 100,
    penaltyInbound: false, penaltyOrder: false,
  };
  generateOrder();
  generateBoxInQueue();
  generateBoxInQueue();
  addLog('Система запущена.', 'info');
  doSystemSay('Конвейер запущен. Счет команды: 100.0');
  renderUI();
}

function createAgent(id, name, color, x, y) {
  return {
    id, name, color, x, y, battery: 100,
    action: 'idle', dest: null, carrying: null,
    isThinking: false, lastThinkTick: -100,
    needsThink: 'start', stuck: null, flags: {},
    walkTicks: 0, deliveryKey: null, charging: false, dead: false,
    lastAction: '—', lastResult: 'Начало смены.', lastSay: '',
    lastLatency: 0, // Инициализация
    knownBoxes: {},
  };
}

function generateMap() {
  const map = [];
  for (let y = 0; y < MAP_H; y++) map.push(new Array(MAP_W).fill(T.FLOOR));
  CHARGERS.forEach(c => { map[c.y][c.x] = T.CHARGER; });
  return map;
}

function generateBoxInQueue() {
  const large = Math.random() > 0.5;
  const w = large ? 2 : 1, h = large ? 2 : 1;
  const boxId = `#${nextBoxId++}`;
  state.inboundQueue.push({ id: boxId, w, h, size: large ? 'large' : 'small' });
  doSystemSay(`На конвейер поступила коробка ${boxId}`);
}

function generateOrder() {
  const nextOrderId = state.orders.length > 0 ? Math.max(...state.orders.map(o => o.id)) + 1 : 101;
  const activeIds = state.orders.filter(o => o.status === 'waiting').flatMap(o => o.requiredIds);
  
  const freeFloorBoxes = state.boxes.filter(b => !activeIds.includes(b.id));
  const freeQueueBoxes = state.inboundQueue.filter(b => !activeIds.includes(b.id));
  const allFreeBoxes = [...freeFloorBoxes, ...freeQueueBoxes].sort(() => Math.random() - 0.5);
  
  const r = Math.random();
  const reqCount = r < 0.3 ? 1 : (r < 0.75 ? 2 : 3);
  
  let reqIds = [];
  for (let i = 0; i < Math.min(reqCount, allFreeBoxes.length); i++) {
      reqIds.push(allFreeBoxes[i].id);
  }
  
  while (reqIds.length < reqCount) {
      const newId = `#${nextBoxId++}`;
      reqIds.push(newId);
      state.inboundQueue.push({ id: newId, w: 1, h: 1, size: 'small' });
      doSystemSay(`В связи с новым заказом на конвейер добавлена коробка ${newId}`);
  }
  
  const zone = OUTBOUND_ZONES[Math.floor(Math.random() * OUTBOUND_ZONES.length)];
  
  state.orders.push({
    id: nextOrderId, requiredIds: reqIds, collectedIds: [], status: 'waiting',
    targetZoneId: zone.id, startTick: state.tick,
  });
  
  addLog(`Создан Заказ #${nextOrderId} (Зона #${zone.id}). Нужны: ${reqIds.join(', ')}`, 'info');
  doSystemSay(`Новый Заказ #${nextOrderId} -> в зону #${zone.id}`);
}

function maybeGenerateOrder() {
  const active = state.orders.filter(o => o.status === 'waiting');
  if (active.length >= MAX_ACTIVE_ORDERS) return;
  
  const chance = active.length === 0 ? 0.02 : 0.008;
  if (Math.random() < chance) {
    generateOrder();
  }
}

const activeOrders = () => state.orders.filter(o => o.status === 'waiting');
const orderForBox = (boxId) => activeOrders().find(o => o.requiredIds.includes(boxId) && !o.collectedIds.includes(boxId));

const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const boxAt = (x, y) => state.boxes.find(b => inRect(x, y, b));
const agentAt = (x, y, except) => state.agents.find(a => a !== except && a.x === x && a.y === y);

function isObstacle(x, y, agent) {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return true;
  if (boxAt(x, y)) return true;
  if (agentAt(x, y, agent)) return true;
  return false;
}

const DIRS = [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]];
const K = (x, y) => y * MAP_W + x;

function bfs(agent, goals) {
  const start = K(agent.x, agent.y);
  const prev = new Int32Array(MAP_W * MAP_H).fill(-2);
  prev[start] = -1;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const cx = cur % MAP_W, cy = (cur / MAP_W) | 0;
    if (cur !== start && goals.has(cur)) {
      const path = [];
      for (let c = cur; c !== start; c = prev[c]) path.push({ x: c % MAP_W, y: (c / MAP_W) | 0 });
      return path.reverse();
    }
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (isObstacle(nx, ny, agent) || prev[K(nx, ny)] !== -2) continue;
      if (dx !== 0 && dy !== 0 && (isObstacle(cx + dx, cy, agent) || isObstacle(cx, cy + dy, agent))) continue;
      prev[K(nx, ny)] = cur;
      q.push(K(nx, ny));
    }
  }
  return null;
}

function planRoute(agent, rect) {
  if (inRect(agent.x, agent.y, rect)) return { status: 'here', path: [], partial: false };
  const goals = new Set();
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++)
      if (!isObstacle(x, y, agent)) goals.add(K(x, y));
  let partial = false;
  if (goals.size === 0) {
    partial = true;
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++)
        for (const [dx, dy] of DIRS.slice(0, 4)) {
          const nx = x + dx, ny = y + dy;
          if (!inRect(nx, ny, rect) && !isObstacle(nx, ny, agent)) goals.add(K(nx, ny));
        }
    if (goals.size === 0) return { status: 'nopath', path: null, partial };
    if (goals.has(K(agent.x, agent.y))) return { status: 'here', path: [], partial };
  }
  const path = bfs(agent, goals);
  return path ? { status: 'ok', path, partial } : { status: 'nopath', path: null, partial };
}

function stepTarget(agent, key) {
  const d = STEP_DIRS[key];
  let x = agent.x, y = agent.y, k = 0;
  while (k < 3 && !isObstacle(x + d.dx, y + d.dy, agent)) { x += d.dx; y += d.dy; k++; }
  return k > 0 ? { x, y, k } : null;
}

const inAnyZone = (x, y) => inRect(x, y, INBOUND) || state.outboundZones.some(z => inRect(x, y, z));

function freeSides(agent) {
  return Object.keys(STEP_DIRS).filter(k => !isObstacle(agent.x + STEP_DIRS[k].dx, agent.y + STEP_DIRS[k].dy, agent));
}
const isBoxedIn = (agent) => freeSides(agent).length === 0;

function pushInfo(agent, key) {
  const d = STEP_DIRS[key];
  const box = boxAt(agent.x + d.dx, agent.y + d.dy);
  if (!box) return null;
  const nx = box.x + d.dx, ny = box.y + d.dy;
  for (let yy = 0; yy < box.h; yy++) for (let xx = 0; xx < box.w; xx++) {
    const cx = nx + xx, cy = ny + yy;
    if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return null;
    const other = boxAt(cx, cy);
    if (other && other !== box) return null;
    if (agentAt(cx, cy, agent)) return null;
    if (inAnyZone(cx, cy)) return null;
  }
  return { box, nx, ny, d };
}

function doPush(agent, key) {
  const info = pushInfo(agent, key);
  agent.action = 'idle'; agent.dest = null; agent.walkTicks = 0;
  if (!info) { agent.lastResult = 'Сдвинуть не удалось: за коробкой нет места.'; agent.needsThink = 'refused'; return; }
  const { box, nx, ny, d } = info;
  box.x = nx; box.y = ny;
  agent.x += d.dx; agent.y += d.dy;
  agent.battery = Math.max(0, agent.battery - PUSH_COST);
  agent.knownBoxes[box.id] = { x: nx, y: ny, w: box.w, h: box.h };
  agent.deliveryKey = null;
  agent.lastResult = `Сдвинул ${box.id} ${d.name} и шагнул на её место.`;
  agent.needsThink = 'pushed';
  addLog(`${agent.name} сдвинул ${box.id} ${d.name}`, 'info');
}

function footprintFree(x, y, w, h) {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
    const cx = x + dx, cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return false;
    if (boxAt(cx, cy)) return false;
    if (state.agents.some(a => a.x === cx && a.y === cy)) return false;
  }
  return true;
}

function findDropSpot(agent, urgent = false) {
  if (!agent.carrying) return null;
  const { w, h } = agent.carrying;
  const cands = [];
  
  for (let y = agent.y - 2; y <= agent.y + 2; y++) {
    for (let x = agent.x - 2; x <= agent.x + 2; x++) {
      const dx = Math.max(x - agent.x, 0, agent.x - (x + w - 1));
      const dy = Math.max(y - agent.y, 0, agent.y - (y + h - 1));
      
      if (dx === 0 && dy === 0) continue;
      if (dx > 2 || dy > 2) continue;
      
      if (x < 0 || y < 0 || x + w > MAP_W || y + h > MAP_H) continue;

      const distToInbound = Math.max(Math.abs(x - 2), Math.abs(y - 7));
      if (distToInbound < 4 && !urgent) continue;

      let inBadZone = false;
      for (let by = 0; by < h; by++) {
        for (let bx = 0; bx < w; bx++) {
          const cx = x + bx, cy = y + by;
          if (inRect(cx, cy, INBOUND) || state.outboundZones.some(z => inRect(cx, cy, z))) { inBadZone = true; break; }
        }
        if (inBadZone) break;
      }
      if (inBadZone && !urgent) continue;
      
      if (!footprintFree(x, y, w, h)) continue;
      
      const distToWall = Math.min(y, MAP_H - (y + h)); 
      let score = Math.pow(distToWall, 2) * 100; 
      
      const distToOutbound = Math.min(...state.outboundZones.map(z => Math.max(Math.abs(x - (z.x+1)), Math.abs(y - (z.y+1)))));
      if (distToOutbound < 3) score += 1000;
      
      const distToAgent = Math.abs(x - agent.x) + Math.abs(y - agent.y);
      score += distToAgent * 10;
      
      cands.push({ x, y, score, distToWall });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  return cands[0] || null;
}

function scanSurroundings(agent) {
  const radius = 6;
  
  state.boxes.forEach(box => {
    const dist = Math.max(Math.abs(agent.x - box.x), Math.abs(agent.y - box.y));
    if (dist <= radius) {
      agent.knownBoxes[box.id] = { x: box.x, y: box.y, w: box.w, h: box.h };
    }
  });
  
  for (const [id, info] of Object.entries(agent.knownBoxes)) {
    const distToInfo = Math.max(Math.abs(agent.x - info.x), Math.abs(agent.y - info.y));
    if (distToInfo <= radius) {
        const exists = state.boxes.some(b => b.id === id && b.x === info.x && b.y === info.y);
        if (!exists) {
            delete agent.knownBoxes[id];
        }
    }
  }
}

function syncMemoryFromChat(agent) {
  const recentMessages = state.chat.slice(-20);
  recentMessages.forEach(msg => {
    if (msg.agent === agent.name) return;

    const dropMatch = msg.text.match(/сбросил (#\d+) на \((\d+),(\d+)\)/);
    if (dropMatch) {
      const boxId = dropMatch[1];
      const x = parseInt(dropMatch[2]);
      const y = parseInt(dropMatch[3]);
      const old = agent.knownBoxes[boxId];
      agent.knownBoxes[boxId] = { x, y, w: old ? old.w : 1, h: old ? old.h : 1 };
    }

    const pickMatch = msg.text.match(/(?:подобрал|получил) (#\d+)/);
    if (pickMatch) {
      delete agent.knownBoxes[pickMatch[1]];
    }
  });
}

function buildOptions(agent) {
  const options = [], unavailable = [];
  const carrying = !!agent.carrying;
  const allOrders = activeOrders();

  for (const d of DESTINATIONS) {
    if (d.kind === 'inbound' && carrying) continue;
    if (d.kind === 'outbound' && !carrying) continue;
    if (d.kind === 'charger' && agent.battery > 30 && !agent.charging) continue;

    const route = planRoute(agent, d.rect);
    if (route.status === 'here' && !route.partial) continue;
    if (route.status === 'here' && route.partial) continue;
    if (route.status === 'nopath') { unavailable.push(`${d.id} (${d.label}): путь не найден`); continue; }

    let note = `${route.path.length} шагов`;
    if (d.kind === 'inbound') note += `; в очереди ${state.inboundQueue.length}`;
    if (d.kind === 'outbound') {
      const orderHere = allOrders.find(o => o.targetZoneId === d.zoneId);
      if (orderHere) note += `; ЗОНА ЗАКАЗА #${orderHere.id}`;
    }
    
    options.push({ id: d.id, label: d.label, note });
  }

  for (const order of allOrders) {
    const neededIds = order.requiredIds.filter(id => !order.collectedIds.includes(id));
    for (const id of neededIds) {
      const info = agent.knownBoxes[id];
      if (!info) continue;
      
      const dx = Math.max(info.x - agent.x, 0, agent.x - (info.x + info.w - 1));
      const dy = Math.max(info.y - agent.y, 0, agent.y - (info.y + info.h - 1));
      const isAdjacent = (dx <= 2 && dy <= 2);

      if (!carrying) {
        if (isAdjacent) {
          options.push({ id: `PICK_${id}`, label: `Подобрать ${id}`, note: `нужна (заказ #${order.id}, рядом)` });
        } else {
          const route = planRoute(agent, { x: info.x, y: info.y, w: info.w, h: info.h });
          if (route.status === 'ok') {
            options.push({ id: `GO_PICK_${id}`, label: `Ехать к ${id}`, note: `нужна (заказ #${order.id}, ${route.path.length} шагов)` });
          }
        }
      } else if (isAdjacent && findDropSpot(agent)) {
        options.push({ id: `SWAP_${id}`, label: `Скинуть текущую и взять ${id}`, note: 'срочно нужна' });
      }
    }
  }

  if (carrying) {
    const spot = findDropSpot(agent);
    if (spot) {
      let note = spot.distToWall <= 3 ? 'безопасно (у стены)' : 'ШТРАФ -15 очков (далеко от стены!)';
      options.push({ id: 'DROP', label: 'Сбросить коробку рядом', note: note });
    } else {
      unavailable.push('DROP: рядом нет места или ты слишком близко к Приемке');
    }
  }

  if (agent.stuck) {
    options.push({ id: 'SAY_HELP', label: 'Крикнуть в рацию: "Уступите!"', note: 'переговоры' });
    for (const key of Object.keys(STEP_DIRS)) {
      const t = stepTarget(agent, key);
      if (t) options.push({ id: `STEP_${key}`, label: `Сдвинуться ${STEP_DIRS[key].name} на ${t.k} кл.`, note: 'объезд' });
    }
  }

  const noPath = unavailable.some(u => u.includes('путь не найден'));
  if (agent.stuck || noPath || isBoxedIn(agent)) {
    for (const key of Object.keys(STEP_DIRS)) {
      const pi = pushInfo(agent, key);
      if (pi) options.push({ id: `PUSH_${key}`, label: `Оттолкнуть коробку ${pi.box.id} ${STEP_DIRS[key].name}`, note: 'освободит клетку, ты шагнёшь на её место' });
    }
  }

  const nearbyRobot = state.agents.find(a => a !== agent && Math.abs(a.x - agent.x) <= 2 && Math.abs(a.y - agent.y) <= 2);
  if (nearbyRobot) options.push({ id: 'YIELD', label: `Уступить дорогу ${nearbyRobot.name}`, note: 'отъехать' });

  options.push({ id: 'WAIT', label: 'Ждать на месте', note: '' });
  return { options, unavailable };
}

function resolveDestination(agent, id) {
  const d = DESTINATIONS.find(x => x.id === id);
  if (d) return { id: d.id, label: d.label, rect: d.rect };
  const m = /^STEP_([NSWE])$/.exec(id);
  if (m) {
    const t = stepTarget(agent, m[1]);
    if (t) return { id, label: `клетка (${t.x},${t.y})`, rect: { x: t.x, y: t.y, w: 1, h: 1 } };
  }
  return null;
}

function buildRadar(agent) {
  const r = 3; let grid = '';
  for (let dy = -r; dy <= r; dy++) {
    let row = '';
    for (let dx = -r; dx <= r; dx++) {
      const nx = agent.x + dx, ny = agent.y + dy;
      if (dx === 0 && dy === 0) row += 'A';
      else if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) row += 'X';
      else if (boxAt(nx, ny)) row += 'B';
      else if (agentAt(nx, ny, agent)) row += 'R';
      else if (state.map[ny][nx] === T.CHARGER) row += 'C';
      else if (inRect(nx, ny, INBOUND)) row += 'I';
      else if (state.outboundZones.some(z => inRect(nx, ny, z))) row += 'O';
      else row += '.';
    }
    grid += row + '\n';
  }
  return grid;
}

function placeLabel(agent) {
  if (inRect(agent.x, agent.y, INBOUND)) return 'приёмка';
  const oz = state.outboundZones.find(z => inRect(agent.x, agent.y, z));
  if (oz) return `отгрузка #${oz.id}`;
  const ch = CHARGERS.find(c => c.x === agent.x && c.y === agent.y);
  if (ch) return `зарядка #${ch.id}`;
  return 'проход';
}

function tick() {
  if (state.paused) return;
  state.tick++;

  if (state.tick % BOX_EVERY === 0) generateBoxInQueue();
  maybeGenerateOrder();

  state.penaltyInbound = false;
  state.penaltyOrder = false;
  if (state.inboundQueue.length > QUEUE_LIMIT) { state.teamScore -= 1; state.penaltyInbound = true; }
  
  for (const o of state.orders) {
    if (o.status === 'waiting' && (state.tick - o.startTick) > ORDER_TIMEOUT) {
      state.teamScore -= 1;
      state.penaltyOrder = true;
    }
  }

  [...state.agents].sort(() => Math.random() - 0.5).forEach(stepAgent);
  renderUI();
}

function stepAgent(agent) {
  if (agent.dead) return;
  if (agent.battery <= 0) {
    agent.dead = true; agent.action = 'idle'; agent.dest = null; agent.isThinking = false;
    addLog(`${agent.name} разрядился`, 'danger');
    return;
  }

  scanSurroundings(agent);
  syncMemoryFromChat(agent);

  const onCharger = CHARGERS.some(c => c.x === agent.x && c.y === agent.y);
  if (onCharger && agent.battery >= 100) {
      agent.charging = false;
      agent.needsThink = 'idle'; 
  }
  
  agent.charging = onCharger && agent.action === 'idle';
  if (agent.charging && agent.battery < 100) agent.battery = Math.min(100, agent.battery + CHARGE_RATE);

  if (agent.action === 'walk' && agent.dest && !agent.stuck) moveAgent(agent);
  if (!agent.stuck && agent.action === 'idle' && isBoxedIn(agent)) {
    agent.stuck = { reason: 'окружён коробками со всех сторон', tick: state.tick };
    agent.lastResult = 'Окружён: свободных сторон нет.';
    addLog(`${agent.name}: окружён коробками`, 'danger');
  }
  applyZoneEffects(agent);
  maybeThink(agent);
}

function moveAgent(agent) {
  agent.walkTicks++;
  if (agent.walkTicks > 60) { setStuck(agent, `слишком долго еду`); return; }

  const route = planRoute(agent, agent.dest.rect);
  if (route.status === 'here') { arrive(agent, route.partial); return; }
  if (route.status === 'nopath') { setStuck(agent, `нет пути до цели`); return; }

  const step = route.path[0];
  agent.x = step.x; agent.y = step.y;
  agent.battery = Math.max(0, agent.battery - WALK_COST);
  agent.deliveryKey = null;
  if (route.path.length === 1) arrive(agent, route.partial);
}

function setStuck(agent, reason) {
  agent.stuck = { reason, tick: state.tick };
  agent.lastResult = `Остановился: ${reason}.`;
  addLog(`${agent.name}: ${reason}`, 'danger');
}

function arrive(agent, partial) {
  const dest = agent.dest;
  agent.action = 'idle'; agent.dest = null; agent.walkTicks = 0; agent.needsThink = 'arrived';
  if (partial) agent.lastResult = `Подъехал к цели, но она занята.`;
  else agent.lastResult = `Прибыл: ${dest.label}.`;
}

function applyZoneEffects(agent) {
  if (agent.action !== 'idle') return;

  if (!agent.carrying && inRect(agent.x, agent.y, INBOUND)) {
    if (state.inboundQueue.length > 0) {
      agent.carrying = state.inboundQueue.shift();
      agent.deliveryKey = null;
      agent.needsThink = 'picked';
      agent.lastResult = `Получил в приёмке ${agent.carrying.id}.`;
      doSystemSay(`${agent.name} получил ${agent.carrying.id} в приёмке`);
    }
    return;
  }

  if (agent.carrying) {
    const zone = state.outboundZones.find(z => inRect(agent.x, agent.y, z));
    if (!zone) return;
    const box = agent.carrying;
    const key = `${box.id}@${zone.id}`;
    if (agent.deliveryKey === key) return;
    agent.deliveryKey = key;

    const order = orderForBox(box.id);
    
    if (!order) {
      agent.lastResult = `Отгрузка отказала: ${box.id} — это мусор.`;
      agent.needsThink = 'refused';
      return;
    }
    
    if (zone.id !== order.targetZoneId) {
      agent.lastResult = `Отгрузка отказала: нужна зона #${order.targetZoneId}.`;
      agent.needsThink = 'refused';
      return;
    }

    zone.currentBoxes++; 
    order.collectedIds.push(box.id);
    doSystemSay(`${agent.name} сдал ${box.id} в Заказ #${order.id}`);
    agent.lastResult = `Сдал ${box.id} в Заказ #${order.id}.`;
    
    if (order.collectedIds.length === order.requiredIds.length) {
      order.status = 'ready'; 
      state.teamScore += 20;
      doSystemSay(`Заказ #${order.id} собран. +20 очков.`);
      const stillUsed = activeOrders().some(o => o.targetZoneId === zone.id);
      if (!stillUsed) zone.currentBoxes = 0;
    }
    
    agent.carrying = null; 
    agent.needsThink = 'delivered';
  }
}

function maybeThink(agent) {
  if (agent.isThinking) return;
  if (state.tick - agent.lastThinkTick < MIN_GAP_BETWEEN_ASKS) return;

  let reason = null;
  if (agent.stuck) reason = 'stuck';
  else if (agent.needsThink) reason = agent.needsThink;
  else if (agent.action === 'idle' && state.tick - agent.lastThinkTick >= IDLE_THINK_COOLDOWN) reason = 'idle';
  else if (agent.action === 'walk') reason = detectInterrupt(agent);

  if (reason) askLLM(agent, reason);
}

function detectInterrupt(agent) {
  for (const th of LOW_BATTERY_ALERTS) {
    const key = `bat${th}`;
    if (agent.battery < th && !agent.flags[key]) { agent.flags[key] = true; return 'battery_low'; }
  }
  if (agent.battery >= 40) LOW_BATTERY_ALERTS.forEach(th => agent.flags[`bat${th}`] = false);

  if (state.penaltyInbound && !agent.flags.penIn) { agent.flags.penIn = true; return 'inbound_overflow'; }
  if (!state.penaltyInbound) agent.flags.penIn = false;
  return null;
}

function buildPayload(agent, reason) {
  const allOrders = activeOrders();
  const { options, unavailable } = buildOptions(agent);
  const c = agent.carrying;

  const head = state.inboundQueue[0] || null;
  const inOrder = id => !!orderForBox(id);

  return {
    name: agent.name, x: agent.x, y: agent.y,
    battery: Math.round(agent.battery * 10) / 10,
    charging: agent.charging, place: placeLabel(agent),
    carrying: c ? { id: c.id, size: `${c.w}x${c.h}`, in_order: inOrder(c.id), order_zone: orderForBox(c.id)?.targetZoneId || null } : null,
    reason, stuck_reason: agent.stuck ? agent.stuck.reason : null,
    radar: agent.stuck ? buildRadar(agent) : null,
    free_sides: freeSides(agent).join(','),
    orders: allOrders.map(o => ({
      id: o.id, required: o.requiredIds, collected: o.collectedIds,
      zone: o.targetZoneId, ticks_left: Math.max(0, ORDER_TIMEOUT - (state.tick - o.startTick)),
    })),
    inbound: { queue: state.inboundQueue.length, head: head ? head.id : null, head_in_order: head ? inOrder(head.id) : false },
    team_score: state.teamScore,
    penalty_inbound: state.penaltyInbound, penalty_order: state.penaltyOrder,
    options, unavailable,
    others: [], 
    recent_chat: state.chat.filter(m => m.agent !== 'Диспетчер').slice(-3).map(m => `${m.agent}: ${m.text}`),
    last_action: agent.lastAction, last_result: agent.lastResult,
  };
}

async function askLLM(agent, reason) {
  const payload = buildPayload(agent, reason);
  const carryingAtAsk = agent.carrying ? agent.carrying.id : null;

  agent.isThinking = true; agent.lastThinkTick = state.tick; agent.needsThink = null;
  const t0 = performance.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const decision = await res.json();

    if (!state.agents.includes(agent)) return;

    const nowCarrying = agent.carrying ? agent.carrying.id : null;
    const stillValid = buildOptions(agent).options.some(o => o.id === decision.action);
    
    if (nowCarrying !== carryingAtAsk || !stillValid) {
      agent.needsThink = 'stale';
      agent.lastResult = 'Ситуация изменилась - реши заново.';
      return;
    }

    if (decision.say) { agent.lastSay = decision.say; doSay(agent, decision.say); }
    applyDecision(agent, decision.action);
  } catch (err) {
    agent.lastResult = `Связь с мозгом пропала.`;
  } finally {
    clearTimeout(timer);
    agent.lastLatency = performance.now() - t0;
    agent.isThinking = false;
    renderUI();
  }
}

function applyDecision(agent, actionId) {
  agent.lastAction = actionId; agent.stuck = null;

  if (actionId === 'WAIT') {
    agent.action = 'idle'; agent.dest = null; agent.walkTicks = 0;
    agent.lastResult = 'Ждешь на месте.';
    return;
  }
  
  if (actionId === 'SAY_HELP') {
    doSay(agent, `Уступите, я застрял на (${agent.x},${agent.y})!`);
    agent.lastResult = 'Попросил помощи.';
    agent.action = 'idle';
    agent.stuck = { reason: 'Жду помощи', tick: state.tick }; 
    return;
  }

  if (actionId === 'YIELD') {
    const free = stepTarget(agent, 'E') || stepTarget(agent, 'W') || stepTarget(agent, 'N') || stepTarget(agent, 'S');
    if (free) {
      agent.dest = { id: 'YIELD', label: 'уступаю', rect: { x: free.x, y: free.y, w: 1, h: 1 } };
      agent.action = 'walk';
      agent.lastResult = `Уступаю дорогу.`;
      doSay(agent, 'Уступаю дорогу.');
    } else {
      agent.lastResult = 'Некуда уступать.';
    }
    return;
  }

  if (actionId === 'DROP') { doDrop(agent); return; }

  if (actionId.startsWith('GO_PICK_')) {
    const boxId = actionId.replace('GO_PICK_', '');
    const info = agent.knownBoxes[boxId];
    if (info) {
      agent.dest = { id: 'GO_PICK', label: `коробка ${boxId}`, rect: { x: info.x, y: info.y, w: info.w, h: info.h } };
      agent.action = 'walk';
      agent.walkTicks = 0;
      agent.lastResult = `Еду к ${boxId}.`;
      return;
    }
  }

  if (actionId.startsWith('SWAP_')) {
    const boxId = actionId.replace('SWAP_', '');
    const spot = findDropSpot(agent);
    if (spot && agent.carrying) {
        state.boxes.push({ ...agent.carrying, x: spot.x, y: spot.y, rx: spot.x, ry: spot.y });
        agent.carrying = null;
        
        const boxIndex = state.boxes.findIndex(b => b.id === boxId);
        if (boxIndex !== -1) {
            agent.carrying = state.boxes.splice(boxIndex, 1)[0];
            delete agent.knownBoxes[boxId];
            agent.needsThink = 'picked';
            agent.lastResult = `Обменял коробку на ${boxId}.`;
            agent.action = 'idle';
            doSystemSay(`${agent.name} подобрал ${boxId} (обмен)`);
            return;
        }
    }
    agent.lastResult = `Не удалось обменять коробку.`;
    agent.needsThink = 'refused';
    agent.action = 'idle';
    return;
  }

  if (actionId.startsWith('PICK_')) {
    const boxId = actionId.replace('PICK_', '');
    const boxIndex = state.boxes.findIndex(b => b.id === boxId);
    if (boxIndex !== -1) {
        const b = state.boxes[boxIndex];
        const dx = Math.max(b.x - agent.x, 0, agent.x - (b.x + b.w - 1));
        const dy = Math.max(b.y - agent.y, 0, agent.y - (b.y + b.h - 1));
        if (dx <= 2 && dy <= 2) {
            agent.carrying = state.boxes.splice(boxIndex, 1)[0];
            delete agent.knownBoxes[boxId];
            agent.needsThink = 'picked';
            agent.lastResult = `Подобрал ${boxId} с пола.`;
            agent.action = 'idle';
            doSystemSay(`${agent.name} подобрал ${boxId} с (${b.x},${b.y})`);
            return;
        }
    }
    agent.lastResult = `Не удалось подобрать ${boxId}.`;
    agent.needsThink = 'refused';
    agent.action = 'idle';
    return;
  }

  const pm = /^PUSH_([NSWE])$/.exec(actionId);
  if (pm) { doPush(agent, pm[1]); return; }

  const dest = resolveDestination(agent, actionId);
  if (!dest) {
    agent.action = 'idle'; agent.dest = null;
    agent.lastResult = `Команда ${actionId} не выполнена.`;
    agent.needsThink = 'refused';
    return;
  }
  agent.dest = dest; agent.action = 'walk'; agent.walkTicks = 0;
  agent.lastResult = `Ты едешь: ${dest.label}.`;
}

function doDrop(agent) {
  agent.action = 'idle'; agent.dest = null;
  const spot = findDropSpot(agent);
  if (!agent.carrying || !spot) {
    agent.lastResult = 'Сбросить не удалось (нет места рядом).';
    agent.needsThink = 'refused';
    return;
  }
  const box = agent.carrying;
  state.boxes.push({ ...box, x: spot.x, y: spot.y, rx: spot.x, ry: spot.y });
  agent.knownBoxes[box.id] = { x: spot.x, y: spot.y, w: box.w, h: box.h };
  
  if (spot.distToWall > 3) {
      state.teamScore -= 15;
      agent.lastResult = `Сбросил ${box.id}, но получил штраф -15 за сброс в проходе.`;
      doSystemSay(`${agent.name} сбросил ${box.id} в проходе. Штраф -15 очков.`);
  } else {
      agent.lastResult = `Сбросил ${box.id} (безопасно).`;
      doSystemSay(`${agent.name} сбросил ${box.id} на (${spot.x},${spot.y})`);
  }
  
  agent.carrying = null; agent.deliveryKey = null; agent.needsThink = 'dropped';
}

// --- Отрисовка ---
const PAL = { ink: '#2D2F6F', blue: '#587BD5', sky: '#8FB4FF', pink: '#FFB3D1', peach: '#FFD6A8', lilac: '#D9C9FF' };
const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

function glide(o) {
  if (o.rx === undefined) { o.rx = o.x; o.ry = o.y; }
  o.rx += (o.x - o.rx) * 0.28; o.ry += (o.y - o.ry) * 0.28;
  if (Math.abs(o.x - o.rx) < 0.01) o.rx = o.x;
  if (Math.abs(o.y - o.ry) < 0.01) o.ry = o.y;
}

function render() {
  const now = performance.now() / 1000;
  drawFloor();

  drawZone(INBOUND, '88,123,213', 'Приёмка');
  const q = state.inboundQueue.length;
  ctx.fillStyle = state.penaltyInbound ? '#f472b6' : PAL.blue;
  ctx.font = '700 13px JetBrains Mono'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`Очередь: ${q}`, (INBOUND.x + INBOUND.w / 2) * TILE, (INBOUND.y + 1.2) * TILE);
  for (let i = 0; i < Math.min(q, 10); i++) {
    ctx.fillStyle = i >= QUEUE_LIMIT ? '#f472b6' : PAL.peach;
    rr((INBOUND.x + 0.35) * TILE + i * 10, (INBOUND.y + 2) * TILE, 8, 8, 2); ctx.fill();
  }

  state.outboundZones.forEach(z => {
    drawZone(z, '240,130,175', `Отгрузка #${z.id}`);
    ctx.fillStyle = PAL.blue; ctx.font = '700 12px JetBrains Mono'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${z.currentBoxes} / ${z.maxBoxes}`, (z.x + z.w / 2) * TILE, (z.y + 1.2) * TILE);
    for (let i = 0; i < z.maxBoxes; i++) {
      ctx.fillStyle = i < z.currentBoxes ? PAL.blue : 'rgba(88,123,213,0.15)';
      ctx.beginPath(); ctx.arc((z.x + z.w / 2 - 0.4 + i * 0.4) * TILE, (z.y + 2.1) * TILE, 5, 0, Math.PI * 2); ctx.fill();
    }
  });

  CHARGERS.forEach(c => {
    const cx = c.x * TILE + TILE / 2, cy = c.y * TILE + TILE / 2;
    const busy = state.agents.some(a => a.charging && a.x === c.x && a.y === c.y);
    const pulse = busy ? 0.5 + 0.5 * Math.sin(now * 4) : 0;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, TILE * 0.85);
    g.addColorStop(0, `rgba(255,214,168,${0.55 + 0.35 * pulse})`); g.addColorStop(1, 'rgba(255,214,168,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, TILE * 0.85, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PAL.peach; ctx.beginPath(); ctx.arc(cx, cy, TILE / 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PAL.ink; ctx.font = '15px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⚡', cx, cy + 1);
  });

  state.boxes.forEach(box => { glide(box); paintBox(box.rx * TILE + 2, box.ry * TILE + 2, box.w * TILE - 4, box.h * TILE - 4, box.w === 2, box.id, true); });

  state.agents.forEach(a => drawAgent(a, now));
  
  state.agents.forEach(a => {
    if (a.dead) return;
    const cx = a.rx * TILE + TILE / 2, cy = a.ry * TILE + TILE / 2;
    const top = a.carrying ? cy - TILE / 2 - (a.carrying.h * TILE - 4) + 6 : cy - TILE / 3 - 12;
    if (a.isThinking) drawBubble(cx, top, null, a.color);
    else if (a.bubble && state.tick - (a.bubbleTick ?? -99) < 5) drawBubble(cx, top, a.bubble, a.color);
  });
  requestAnimationFrame(render);
}

function drawFloor() {
  const W = MAP_W * TILE, H = MAP_H * TILE;
  ctx.fillStyle = '#FAFBFF'; ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if ((x + y) % 2) { ctx.fillStyle = 'rgba(143,180,255,0.07)'; ctx.fillRect(x * TILE, y * TILE, TILE, TILE); }
  }
}

function drawZone(z, rgb, label) {
  const px = z.x * TILE, py = z.y * TILE, w = z.w * TILE, h = z.h * TILE;
  ctx.fillStyle = `rgba(${rgb},0.12)`; rr(px, py, w, h, 12); ctx.fill();
  ctx.strokeStyle = `rgba(${rgb},0.9)`; ctx.lineWidth = 2; ctx.setLineDash([7, 5]); rr(px + 1, py + 1, w - 2, h - 2, 12); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = PAL.ink; ctx.font = '600 11px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, px + w / 2, py - 7);
}

function paintBox(px, py, bw, bh, big, id, shadow) {
  if (shadow) { ctx.shadowColor = 'rgba(45,47,111,0.18)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3; }
  ctx.fillStyle = big ? PAL.lilac : PAL.peach; rr(px, py, bw, bh, 7); ctx.fill();
  ctx.shadowColor = 'transparent'; // Сбрасываем тень
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(px + bw / 2 - 4, py + 1, 8, bh - 2);
  ctx.strokeStyle = 'rgba(45,47,111,0.3)'; ctx.lineWidth = 1.5; rr(px, py, bw, bh, 7); ctx.stroke();
  ctx.fillStyle = PAL.ink; ctx.font = '700 10px JetBrains Mono'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(id, px + bw / 2, py + bh / 2);
}

function drawAgent(a, now) {
  const dxv = a.x - (a.rx ?? a.x);
  glide(a);
  if (Math.abs(dxv) > 0.05) a.face = Math.sign(dxv);
  const face = a.face || 1;
  const cx = a.rx * TILE + TILE / 2, cy = a.ry * TILE + TILE / 2, r = TILE / 3;

  if (a.dead) {
    ctx.fillStyle = '#cbd5e1'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 14px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('✖', cx, cy);
    return;
  }

  if (a.action === 'walk' && a.dest) {
    const tx = (a.dest.rect.x + a.dest.rect.w / 2) * TILE, ty = (a.dest.rect.y + a.dest.rect.h / 2) * TILE;
    ctx.strokeStyle = a.color; ctx.globalAlpha = 0.35; ctx.setLineDash([4, 6]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(tx, ty, 4, 0, Math.PI * 2); ctx.fillStyle = a.color; ctx.fill(); ctx.globalAlpha = 1;
  }

  // Тень под роботом
  ctx.fillStyle = 'rgba(45,47,111,0.14)'; ctx.beginPath(); ctx.ellipse(cx, cy + r + 2, r * 0.9, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();

  // Кольцо батареи
  const bat = Math.max(0, Math.min(1, a.battery / 100));
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(45,47,111,0.1)'; ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = a.battery < 20 ? '#F472B6' : PAL.sky; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * bat); ctx.stroke(); ctx.lineCap = 'butt';

  if (a.stuck) {
    ctx.strokeStyle = 'rgba(244,114,182,0.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r + 8 + Math.sin(now * 6) * 1.5, 0, Math.PI * 2); ctx.stroke();
  }

  // КОШАЧЬИ УШКИ (под телом)
  ctx.fillStyle = a.color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  
  // Левое
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.95, cy - r * 0.3);
  ctx.lineTo(cx - r * 0.55, cy - r * 1.3);
  ctx.lineTo(cx - r * 0.1, cy - r * 0.7);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  // Правое
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.95, cy - r * 0.3);
  ctx.lineTo(cx + r * 0.55, cy - r * 1.3);
  ctx.lineTo(cx + r * 0.1, cy - r * 0.7);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  // Внутренняя часть
  ctx.fillStyle = PAL.pink;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.75, cy - r * 0.4);
  ctx.lineTo(cx - r * 0.5, cy - r * 1.1);
  ctx.lineTo(cx - r * 0.25, cy - r * 0.65);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.75, cy - r * 0.4);
  ctx.lineTo(cx + r * 0.5, cy - r * 1.1);
  ctx.lineTo(cx + r * 0.25, cy - r * 0.65);
  ctx.closePath(); ctx.fill();

  // ТЕЛО (с тенью и градиентом)
  ctx.shadowColor = 'rgba(45,47,111,0.25)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
  ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent'; // ОЧЕНЬ ВАЖНО: сброс тени
  
  const hl = ctx.createRadialGradient(cx - 4, cy - 5, 1, cx, cy, r);
  hl.addColorStop(0, 'rgba(255,255,255,0.5)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

  // Лицо
  ctx.fillStyle = PAL.ink; rr(cx - 8 + face * 1.5, cy - 4, 16, 9, 4.5); ctx.fill();
  const blink = ((now * 1000 + a.id * 1300) % 4200) < 110;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  [-3.5, 3.5].forEach(ox => {
    const ex = cx + ox + face * 2.5, ey = cy + 0.5;
    if (blink) { ctx.beginPath(); ctx.moveTo(ex - 1.8, ey); ctx.lineTo(ex + 1.8, ey); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(ex, ey, 1.8, 0, Math.PI * 2); ctx.fill(); }
  });

  if (a.charging) { ctx.font = '12px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⚡', cx + 13, cy + 13); }

  if (a.carrying) {
    const bw = a.carrying.w * TILE - 4, bh = a.carrying.h * TILE - 4;
    paintBox(cx - bw / 2, cy - TILE / 2 - bh + 6, bw, bh, a.carrying.w === 2, a.carrying.id, true);
  }
}

function drawBubble(cx, bottomY, text, color) {
  const now = performance.now() / 1000;
  ctx.font = '500 11px Inter';
  const w = text === null ? 44 : Math.min(ctx.measureText(text).width, 170) + 16, h = 22;
  const bx = Math.max(4, Math.min(cx - w / 2, MAP_W * TILE - w - 4)), by = Math.max(4, bottomY - h - 6);
  
  ctx.shadowColor = 'rgba(45,47,111,0.18)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#fff'; rr(bx, by, w, h, 11); ctx.fill(); 
  ctx.shadowColor = 'transparent'; // Сброс тени
  
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; rr(bx, by, w, h, 11); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(cx - 4, by + h - 0.5); ctx.lineTo(cx, by + h + 5); ctx.lineTo(cx + 4, by + h - 0.5); ctx.fill();
  
  if (text === null) {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(now * 6 - i * 1.2));
      ctx.fillStyle = PAL.ink; ctx.beginPath(); ctx.arc(bx + w / 2 - 10 + i * 10, by + h / 2, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = PAL.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + 8, by + h / 2 + 0.5, 170);
  }
}

function renderUI() {
  document.getElementById('tickInfo').textContent = state.tick;
  const scoreEl = document.getElementById('teamScore');
  if (scoreEl) {
    scoreEl.textContent = state.teamScore.toFixed(1);
    scoreEl.style.color = state.penaltyInbound || state.penaltyOrder ? '#f472b6' : '#587BD5';
  }
  
  const displayOrders = [...state.orders].sort((a, b) => {
    if (a.status === 'waiting' && b.status !== 'waiting') return -1;
    if (a.status !== 'waiting' && b.status === 'waiting') return 1;
    return b.id - a.id;
  }).slice(0, 4);
  
  document.getElementById('ordersList').innerHTML = displayOrders.map(o => {
    const isReady = o.status === 'ready';
    const timeLeft = Math.max(0, ORDER_TIMEOUT - (state.tick - o.startTick));
    const penaltyStyle = timeLeft === 0 && !isReady ? 'color: #f472b6;' : 'color: var(--text-muted);';
    return `<div class="order-card" style="border-left-color: ${isReady ? 'var(--success)' : 'var(--primary)'}">
      <div class="order-header"><span>Заказ #${o.id} -> зона ${o.targetZoneId}</span><span style="${penaltyStyle} font-size:10px;">${isReady ? 'ГОТОВ' : 'Осталось: ' + timeLeft}</span></div>
      <div style="margin-top: 4px;">Нужно: <b>${o.requiredIds.join(', ')}</b></div><div>Собрано: ${o.collectedIds.length} / ${o.requiredIds.length}</div></div>`;
  }).join('');
  
  document.getElementById('agentsList').innerHTML = state.agents.map(a => {
    if (a.dead) return `<div class="agent-card dead"><div class="agent-color" style="background:#cbd5e1"></div><div class="agent-info"><div class="agent-name">${a.name}</div><span class="chip dead">разряжен</span></div></div>`;
    const [status, kind] = a.isThinking ? ['думает', 'think'] : a.stuck ? ['застрял', 'stuck'] : a.charging ? ['заряжается', 'charge']
      : a.action === 'walk' && a.dest ? [`едет: ${a.dest.label}`, 'walk'] : ['стоит', 'idle'];
    const cargo = a.carrying ? a.carrying.id : 'пусто';
    const lat = a.lastLatency ? ` · мозг ${(a.lastLatency / 1000).toFixed(1)} с` : '';
    return `<div class="agent-card"><div class="agent-color" style="background:${a.color}"></div>
      <div class="agent-info"><div class="agent-name">${a.name}</div>
      <div class="battery-bar"><div class="battery-fill ${a.battery < 20 ? 'low' : ''}" style="width:${a.battery}%"></div></div>
      <div class="agent-meta"><span class="chip ${kind}">${status}</span><span>груз: ${cargo}${lat}</span></div></div>
      <div class="agent-pct">${Math.round(a.battery)}%</div></div>`;
  }).join('');
  
  document.getElementById('eventLog').innerHTML = state.events.slice(-8).reverse().map(e => `
    <div class="log-item"><span class="log-time">[${e.tick}]</span><span class="log-msg ${e.type}">${e.text}</span></div>`).join('');
    
  const chatEl = document.getElementById('chatLog');
  if (chatEl) {
    chatEl.innerHTML = state.chat.slice(-8).reverse().map(c => `
      <div class="log-item" style="border-bottom: none;"><span style="color:${c.color}; font-weight:bold;">${c.agent}:</span> <span style="font-size: 11px;">${c.text}</span></div>`).join('');
  }
}

function addLog(text, type = 'info') { state.events.push({ tick: state.tick, text, type }); if (state.events.length > 50) state.events.shift(); }
function doSay(agent, text) { text = String(text).slice(0, 90); agent.bubble = text; agent.bubbleTick = state.tick; const last = state.chat[state.chat.length - 1]; if (last && last.agent === agent.name && last.text === text) return; state.chat.push({ tick: state.tick, agent: agent.name, color: agent.color, text }); if (state.chat.length > 30) state.chat.shift(); }
function doSystemSay(text) { state.chat.push({ tick: state.tick, agent: 'Диспетчер', color: '#64748b', text }); if (state.chat.length > 30) state.chat.shift(); }

function setupButtons() {
  document.getElementById('pauseBtn').onclick = () => { state.paused = true; document.getElementById('pauseBtn').classList.add('active'); document.getElementById('playBtn').classList.remove('active'); };
  document.getElementById('playBtn').onclick = () => { state.paused = false; document.getElementById('playBtn').classList.add('active'); document.getElementById('pauseBtn').classList.remove('active'); };
  ['1', '2', '5'].forEach(s => { document.getElementById(`speed${s}`).onclick = () => { state.speed = parseInt(s); document.querySelectorAll('.speed').forEach(b => b.classList.remove('active')); document.getElementById(`speed${s}`).classList.add('active'); startLoop(); }; });
  document.getElementById('resetBtn').onclick = () => { resetState(); document.querySelectorAll('.speed').forEach(b => b.classList.remove('active')); document.getElementById('speed1').classList.add('active'); startLoop(); };
  document.getElementById('incidentBtn').onclick = () => { const alive = state.agents.filter(a => !a.dead && a.battery > 0); if (alive.length > 0) { const victim = alive[Math.floor(Math.random() * alive.length)]; victim.battery = 5; addLog(`АВАРИЯ: У ${victim.name} критический разряд.`, 'danger'); } };
}
function startLoop() { if (loopInterval) clearInterval(loopInterval); loopInterval = setInterval(tick, 1500 / state.speed); }
window.onload = init;