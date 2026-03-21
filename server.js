// ═══════════════════════════════════════════════════════════
//  MAFIA: City of Shadows — Railway Game Server
//  Node.js + Socket.io
//
//  Установка:
//    npm install express socket.io firebase-admin
//
//  Деплой на Railway:
//    1. Создать новый проект на railway.app
//    2. Загрузить server.js + package.json
//    3. Railway автоматически запустит сервер
//    4. Скопировать URL вида: https://your-app.up.railway.app
// ═══════════════════════════════════════════════════════════

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const admin      = require('firebase-admin');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: {
        origin: '*',   // при деплое замените на ваш домен
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// ── Firebase Admin (для проверки токенов) ─────────────────
// Скачайте serviceAccountKey.json из Firebase Console →
// Project Settings → Service Accounts → Generate new private key
// Добавьте в Railway как переменную окружения FIREBASE_SERVICE_ACCOUNT
let firebaseReady = false;
try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : null;

    if (serviceAccount) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseReady = true;
        console.log('[Server] Firebase Admin инициализирован ✓');
    } else {
        console.warn('[Server] FIREBASE_SERVICE_ACCOUNT не задан — авторизация отключена');
    }
} catch (e) {
    console.error('[Server] Ошибка Firebase Admin:', e.message);
}

// ── Константы ──────────────────────────────────────────────
const MAX_ROOM     = 7;
const BOT_WAIT_MS  = 20000;  // 20 секунд ожидания перед добавлением ботов
const GROUP_WAIT_MS = 5000;  // 5 секунд после прихода второго игрока
const VOTE_TIME_MS = 40000;  // 40 секунд на голосование
const NIGHT_TIME_MS = 30000; // 30 секунд на ночные действия
const BOT_NAMES = ['Виктор','Карло','Лоренцо','Анна','Марко','Лучия','Джузеппе','Роза','Энцо','Фиора'];

// ── Хранилище состояния ────────────────────────────────────
const queue  = new Map();  // uid → { uid, name, avatar, socketId, joinedAt }
const rooms  = new Map();  // roomId → Room
const sockets = new Map(); // uid → socket

let queueTimer   = null;  // таймер ботов (один игрок)
let groupTimer   = null;  // таймер группового запуска

// ── Хелперы ────────────────────────────────────────────────
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function assignRoles(n) {
    const numMafia = Math.max(1, Math.floor(n / 4));
    const roles = [];
    for (let i = 0; i < numMafia; i++) roles.push('mafia');
    roles.push('doctor');
    roles.push('detective');
    while (roles.length < n) roles.push('civilian');
    return shuffle(roles);
}

function makeRoomId() {
    return 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function broadcastQueueSize() {
    const sz = queue.size;
    io.emit('queue_update', { size: sz, max: MAX_ROOM });
}

// ── Матчмейкинг ────────────────────────────────────────────
function cancelQueueTimers() {
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    if (groupTimer) { clearTimeout(groupTimer); groupTimer = null; }
}

function scheduleGroupLaunch() {
    cancelQueueTimers();
    // Отправить всем в очереди обратный отсчёт
    const players = [...queue.values()];
    players.forEach(p => {
        const sock = sockets.get(p.uid);
        if (sock) sock.emit('countdown', { seconds: GROUP_WAIT_MS / 1000, reason: 'group' });
    });
    groupTimer = setTimeout(() => launchRoom([...queue.values()]), GROUP_WAIT_MS);
}

function scheduleBotLaunch() {
    cancelQueueTimers();
    const players = [...queue.values()];
    players.forEach(p => {
        const sock = sockets.get(p.uid);
        if (sock) sock.emit('countdown', { seconds: BOT_WAIT_MS / 1000, reason: 'bots' });
    });
    queueTimer = setTimeout(() => launchRoom([...queue.values()]), BOT_WAIT_MS);
}

function addToQueue(playerInfo) {
    const prev = queue.size;
    queue.set(playerInfo.uid, playerInfo);
    broadcastQueueSize();
    console.log(`[Queue] +${playerInfo.uid.slice(0,8)} | Размер: ${queue.size}`);

    if (queue.size >= MAX_ROOM) {
        // Комната полная — запускаем немедленно
        cancelQueueTimers();
        launchRoom([...queue.values()].slice(0, MAX_ROOM));
    } else if (queue.size >= 2) {
        // Новый игрок — сбрасываем таймер ожидания группы
        scheduleGroupLaunch();
    } else if (queue.size === 1) {
        // Первый игрок — запускаем таймер ботов
        scheduleBotLaunch();
    }
}

function removeFromQueue(uid) {
    if (!queue.has(uid)) return;
    queue.delete(uid);
    broadcastQueueSize();
    console.log(`[Queue] -${uid.slice(0,8)} | Размер: ${queue.size}`);

    if (queue.size === 0) {
        cancelQueueTimers();
    } else if (queue.size === 1) {
        // Остался один — запускаем таймер ботов
        scheduleBotLaunch();
    }
}

async function launchRoom(realPlayers) {
    // Убираем игроков из очереди
    realPlayers.forEach(p => queue.delete(p.uid));
    cancelQueueTimers();
    broadcastQueueSize();

    // Добавляем ботов если нужно
    const allPlayers = [...realPlayers];
    const need = MAX_ROOM - allPlayers.length;
    for (let i = 0; i < need; i++) {
        allPlayers.push({
            uid:    'bot_' + i,
            name:   BOT_NAMES[i % BOT_NAMES.length],
            avatar: '🤖',
            isBot:  true
        });
    }

    // Назначаем роли
    const roles = assignRoles(allPlayers.length);
    allPlayers.forEach((p, i) => { p.role = roles[i]; p.slot = i; });

    const roomId = makeRoomId();
    const room = {
        id:      roomId,
        players: allPlayers,
        phase:   'setup',
        day:     0,
        dead:    [],
        actions: {},
        timers:  []
    };
    rooms.set(roomId, room);

    console.log(`[Room] Создана ${roomId} | ${realPlayers.length} игроков + ${need} ботов`);

    // Рассылаем каждому игроку его данные
    realPlayers.forEach(p => {
        const sock = sockets.get(p.uid);
        if (!sock) return;
        sock.join(roomId);
        sock.emit('game_start', {
            roomId,
            myUid: p.uid,
            myRole: p.role,
            players: allPlayers.map(pl => ({
                uid:    pl.uid,
                name:   pl.name,
                avatar: pl.avatar || '🎩',
                slot:   pl.slot,
                isBot:  !!pl.isBot,
                // роль не раскрываем кроме союзников по мафии
                role: (pl.uid === p.uid || (p.role === 'mafia' && pl.role === 'mafia'))
                    ? pl.role
                    : null
            }))
        });
    });

    // Запускаем игру через 3 секунды
    const t = setTimeout(() => startIntroductions(room), 3000);
    room.timers.push(t);
}

// ── Игровая логика ─────────────────────────────────────────
function roomEmit(room, event, data) {
    io.to(room.id).emit(event, data);
}

function alivePlayers(room) {
    return room.players.filter(p => !room.dead.includes(p.uid));
}

function aliveHumans(room) {
    return room.players.filter(p => !p.isBot && !room.dead.includes(p.uid));
}

function checkWin(room) {
    const alive = alivePlayers(room);
    const aliveMafia = alive.filter(p => p.role === 'mafia');
    const aliveCiv   = alive.filter(p => p.role !== 'mafia');

    console.log('[checkWin] alive=' + alive.length + ' mafia=' + aliveMafia.length + ' civ=' + aliveCiv.length);

    // Защита: не объявлять победу до первого убийства
    if (room.dead.length === 0) return null;

    if (aliveMafia.length === 0) return 'civ';
    if (aliveMafia.length >= aliveCiv.length) return 'mafia';
    return null;
}

function eliminatePlayer(room, uid, reason) {
    if (room.dead.includes(uid)) return;
    room.dead.push(uid);
    const p = room.players.find(p => p.uid === uid);
    const name = p ? p.name : uid;
    roomEmit(room, 'eliminated', { uid, name, reason });
    console.log(`[Room ${room.id}] Выбыл: ${name} (${p ? p.role : '?'}) — ${reason}`);
}

function startIntroductions(room) {
    roomEmit(room, 'game_log', { msg: '🎭 Добро пожаловать в Мафию! Город засыпает...', cls: 'system' });

    // Сообщить мафии друг о друге перед первой ночью
    const mafiaPlayers = room.players.filter(p => p.role === 'mafia' && !p.isBot);
    const mafiaNames = room.players.filter(p => p.role === 'mafia').map(p => p.name).join(', ');
    mafiaPlayers.forEach(p => {
        const sock = sockets.get(p.uid);
        if (sock) sock.emit('game_log', { msg: '🔴 Ваши союзники по мафии: ' + mafiaNames, cls: 'system' });
    });

    const t = setTimeout(() => startNight(room), 4000);
    room.timers.push(t);
}

function startDay(room) {
    room.phase = 'day';
    room.day++;
    room.actions = {};
    roomEmit(room, 'day_start', { day: room.day });
    roomEmit(room, 'game_log', { msg: `☀️ День ${room.day}. Обсуждайте, кто из вас мафия.`, cls: 'system' });

    const t = setTimeout(() => startVote(room), 60000); // 60с обсуждение
    room.timers.push(t);
}

function startVote(room) {
    room.phase = 'vote';
    room.actions = {};
    roomEmit(room, 'vote_start', { timeMs: VOTE_TIME_MS });
    roomEmit(room, 'game_log', { msg: '🗳️ Голосуйте! Кто подозреваемый?', cls: 'system' });

    // Боты голосуют случайно
    const aliveList = alivePlayers(room);
    room.players.filter(p => p.isBot && !room.dead.includes(p.uid)).forEach(bot => {
        const targets = aliveList.filter(p => p.uid !== bot.uid);
        if (targets.length > 0) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            setTimeout(() => recordVote(room, bot.uid, target.uid), Math.random() * 5000 + 2000);
        }
    });

    const t = setTimeout(() => resolveVote(room), VOTE_TIME_MS);
    room.timers.push(t);
}

function recordVote(room, voterUid, targetUid) {
    if (room.phase !== 'vote') return;
    room.actions[voterUid] = targetUid;
    roomEmit(room, 'vote_cast', { voterUid, targetUid });
}

function resolveVote(room) {
    if (room.phase !== 'vote') return;

    // Подсчёт голосов
    const counts = {};
    Object.values(room.actions).forEach(uid => {
        if (uid) counts[uid] = (counts[uid] || 0) + 1;
    });

    let maxVotes = 0;
    let eliminated = null;
    Object.entries(counts).forEach(([uid, cnt]) => {
        if (cnt > maxVotes) { maxVotes = cnt; eliminated = uid; }
    });

    if (eliminated && maxVotes > 0) {
        eliminatePlayer(room, eliminated, 'vote');
        const winner = checkWin(room);
        if (winner) return endGame(room, winner);
    } else {
        roomEmit(room, 'game_log', { msg: '🤷 Голоса разделились. Никто не выбыл.', cls: 'system' });
    }

    const t = setTimeout(() => startNight(room), 3000);
    room.timers.push(t);
}

function startNight(room) {
    room.phase = 'night';
    room.night = (room.night || 0) + 1;
    room.actions = {};
    roomEmit(room, 'night_start', {});
    roomEmit(room, 'game_log', { msg: '🌙 Ночь ' + room.night + '. Город засыпает... Мафия просыпается.', cls: 'system' });

    // Боты делают ночные действия
    const aliveList = alivePlayers(room);

    // Мафия-боты убивают
    room.players.filter(p => p.isBot && p.role === 'mafia' && !room.dead.includes(p.uid)).forEach(bot => {
        const targets = aliveList.filter(p => p.role !== 'mafia');
        if (targets.length > 0) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            setTimeout(() => recordNightAction(room, bot.uid, 'kill', target.uid), Math.random() * 5000 + 2000);
        }
    });

    // Доктор-бот лечит случайного
    room.players.filter(p => p.isBot && p.role === 'doctor' && !room.dead.includes(p.uid)).forEach(bot => {
        if (aliveList.length > 0) {
            const target = aliveList[Math.floor(Math.random() * aliveList.length)];
            setTimeout(() => recordNightAction(room, bot.uid, 'save', target.uid), Math.random() * 5000 + 2000);
        }
    });

    // Детектив-бот проверяет случайного
    room.players.filter(p => p.isBot && p.role === 'detective' && !room.dead.includes(p.uid)).forEach(bot => {
        const targets = aliveList.filter(p => p.uid !== bot.uid);
        if (targets.length > 0) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            setTimeout(() => recordNightAction(room, bot.uid, 'investigate', target.uid), Math.random() * 5000 + 2000);
        }
    });

    const t = setTimeout(() => resolveNight(room), NIGHT_TIME_MS);
    room.timers.push(t);
}

function recordNightAction(room, uid, type, targetUid) {
    if (room.phase !== 'night') return;
    if (!room.actions[type]) room.actions[type] = {};
    room.actions[type][uid] = targetUid;
    // Подтвердить получение действия игроку
    const sock = sockets.get(uid);
    if (sock) sock.emit('action_confirmed', { type });
}

function resolveNight(room) {
    if (room.phase !== 'night') return;

    // Найти жертву мафии
    const killVotes = room.actions['kill'] || {};
    const counts = {};
    Object.values(killVotes).forEach(uid => { counts[uid] = (counts[uid] || 0) + 1; });
    let killTarget = null;
    let maxKills = 0;
    Object.entries(counts).forEach(([uid, cnt]) => {
        if (cnt > maxKills) { maxKills = cnt; killTarget = uid; }
    });

    // Проверить спасение
    const saveVotes = room.actions['save'] || {};
    const savedUids = new Set(Object.values(saveVotes));

    // Результат расследования
    const investVotes = room.actions['investigate'] || {};
    Object.entries(investVotes).forEach(([detUid, targetUid]) => {
        const target = room.players.find(p => p.uid === targetUid);
        const sock = sockets.get(detUid);
        if (sock && target) {
            sock.emit('investigate_result', {
                targetUid,
                targetName: target.name,
                isMafia: target.role === 'mafia'
            });
        }
    });

    if (killTarget && !savedUids.has(killTarget)) {
        eliminatePlayer(room, killTarget, 'night');
        const winner = checkWin(room);
        if (winner) return endGame(room, winner);
    } else if (killTarget && savedUids.has(killTarget)) {
        roomEmit(room, 'game_log', { msg: '💊 Доктор спас кого-то этой ночью!', cls: 'system' });
    } else {
        roomEmit(room, 'game_log', { msg: '🌙 Тихая ночь. Никто не погиб.', cls: 'system' });
    }

    const t = setTimeout(() => startDay(room), 3000);
    room.timers.push(t);
}

function endGame(room, winner) {
    room.phase = 'over';
    room.timers.forEach(t => clearTimeout(t));
    room.timers = [];

    const msg = winner === 'mafia'
        ? '🔴 Мафия победила! Город под контролем преступников.'
        : '🟢 Мирные жители победили! Мафия уничтожена.';

    // Раскрываем все роли
    const roleReveal = room.players.map(p => ({ uid: p.uid, name: p.name, role: p.role }));

    roomEmit(room, 'game_over', { winner, msg, roles: roleReveal });
    console.log(`[Room ${room.id}] Игра окончена: ${winner}`);

    // Удалить комнату через 30 секунд
    setTimeout(() => rooms.delete(room.id), 30000);
}

// ── Socket.io события ──────────────────────────────────────
io.on('connection', async (socket) => {
    console.log(`[WS] Подключение: ${socket.id}`);

    // ── Авторизация через Firebase токен ─────────────────
    socket.on('auth', async ({ token, name, avatar }) => {
        let uid = null;

        if (firebaseReady && token) {
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                uid = decoded.uid;
            } catch (e) {
                socket.emit('auth_error', { msg: 'Неверный токен' });
                return;
            }
        } else {
            // Режим без Firebase (для разработки)
            uid = 'guest_' + socket.id.slice(0, 8);
        }

        socket.uid = uid;
        sockets.set(uid, socket);
        socket.emit('auth_ok', { uid });
        console.log(`[WS] Авторизован: ${uid.slice(0,8)}`);
    });

    // ── Войти в очередь ───────────────────────────────────
    socket.on('join_queue', ({ name, avatar }) => {
        if (!socket.uid) { socket.emit('error', { msg: 'Не авторизован' }); return; }
        addToQueue({ uid: socket.uid, name: name || 'Игрок', avatar: avatar || '🎩', socketId: socket.id, joinedAt: Date.now() });
        socket.emit('joined_queue', { uid: socket.uid });
    });

    // ── Выйти из очереди ──────────────────────────────────
    socket.on('leave_queue', () => {
        if (socket.uid) removeFromQueue(socket.uid);
    });

    // ── Ночное действие ───────────────────────────────────
    socket.on('night_action', ({ roomId, type, targetUid }) => {
        const room = rooms.get(roomId);
        if (!room || room.phase !== 'night') return;
        if (!socket.uid || room.dead.includes(socket.uid)) return;
        recordNightAction(room, socket.uid, type, targetUid);
    });

    // ── Голосование ───────────────────────────────────────
    socket.on('vote', ({ roomId, targetUid }) => {
        const room = rooms.get(roomId);
        if (!room || room.phase !== 'vote') return;
        if (!socket.uid || room.dead.includes(socket.uid)) return;
        recordVote(room, socket.uid, targetUid);
    });

    // ── Чат ───────────────────────────────────────────────
    socket.on('chat', ({ roomId, msg, playerName }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (!socket.uid || room.dead.includes(socket.uid)) return;

        // Мафийный чат: только для мафии ночью
        const sender = room.players.find(p => p.uid === socket.uid);
        if (room.phase === 'night' && sender && sender.role === 'mafia') {
            // Рассылаем только мафии
            room.players.filter(p => p.role === 'mafia' && !p.isBot).forEach(p => {
                const sock = sockets.get(p.uid);
                if (sock) sock.emit('game_log', { msg: `[Мафия] ${playerName}: ${msg}`, cls: 'chat mafia' });
            });
        } else if (room.phase === 'day') {
            io.to(roomId).emit('game_log', { msg: `${playerName}: ${msg}`, cls: 'chat' });
        }
    });

    // ── Отключение ────────────────────────────────────────
    socket.on('disconnect', () => {
        if (socket.uid) {
            removeFromQueue(socket.uid);
            sockets.delete(socket.uid);
            // Уведомить комнату если игрок был в игре
            rooms.forEach(room => {
                const p = room.players.find(p => p.uid === socket.uid);
                if (p && !room.dead.includes(socket.uid) && room.phase !== 'over') {
                    roomEmit(room, 'game_log', { msg: `⚠️ ${p.name} отключился.`, cls: 'system' });
                }
            });
        }
        console.log(`[WS] Отключение: ${socket.id}`);
    });
});

// ── Health check endpoint ──────────────────────────────────
app.get('/', (req, res) => res.json({
    status: 'ok',
    queue: queue.size,
    rooms: rooms.size
}));

server.listen(PORT, () => console.log(`[Server] Запущен на порту ${PORT}`));
