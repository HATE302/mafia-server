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
// ── Groq API для интеллекта ботов ────────────────────────
// Модель: llama-3.1-8b-instant — ~14,400 запросов/день бесплатно
// Регистрация: console.groq.com (без карты)
// Добавить в Railway Variables: GROQ_API_KEY = gsk_...
const GROQ_KEY = process.env.GROQ_API_KEY || null;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

if (GROQ_KEY) console.log('[Server] Groq AI для ботов: включён ✓ модель:', GROQ_MODEL);
else console.warn('[Server] GROQ_API_KEY не задан — боты используют шаблонные фразы');

async function callGroq(systemPrompt, userPrompt) {
    if (!GROQ_KEY) return null;
    try {
        const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + GROQ_KEY
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt }
                ],
                max_tokens: 80,
                temperature: 0.92
            })
        });
        if (!res.ok) {
            const err = await res.text();
            console.error('[Groq] HTTP', res.status, err.slice(0, 150));
            return null;
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        console.error('[Groq] Ошибка:', e.message);
        return null;
    }
}

const app    = express();
const server = http.createServer(app);

// CORS для HTTP-эндпоинтов (нужно для /rejoin-check)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
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
const MAX_ROOM      = 7;
const BOT_WAIT_MS   = 20000; // 20с ожидания перед добавлением ботов
const GROUP_WAIT_MS = 5000;  // 5с после прихода второго игрока
const VOTE_TIME_MS  = 45000; // 45с на голосование (боты ускоряют)
const NIGHT_TIME_MS = 25000; // 25с на ночные действия (боты ускоряют)
const DAY_DISCUSS_MS = 30000;// 30с обсуждения (боты пишут в чат)
const BOT_NAMES = ['Виктор','Карло','Лоренцо','Анна','Марко','Лучия','Джузеппе','Роза','Энцо','Фиора'];

// ── Резервные фразы (если Claude API недоступен) ─────────
const FALLBACK_PHRASES = {
    discuss:  ['Кто-то ведёт себя подозрительно...','Нужно быть осторожнее с голосованием.','Я наблюдаю за всеми.','Интересная ситуация...'],
    accuse:   ['{name} ведёт себя очень подозрительно!','Я голосую против {name}.','Обратите внимание на {name}.'],
    defend:   ['Я мирный, клянусь!','Не трогайте меня, я вам нужен.','Вы ошибаетесь насчёт меня.'],
    morning:  ['Доброе утро...','Кто пережил ночь?','Нужно найти виновного сегодня.'],
};

function fallbackSay(room, bot, key, replacements) {
    const list = FALLBACK_PHRASES[key] || FALLBACK_PHRASES.discuss;
    let msg = list[Math.floor(Math.random() * list.length)];
    if (replacements) Object.entries(replacements).forEach(([k,v]) => { msg = msg.replace('{'+k+'}', v); });
    roomEmit(room, 'game_log', { msg: bot.name + ': ' + msg, cls: 'chat' });
}

// ── Построить контекст игры для Claude ────────────────────
function buildGameContext(room, bot) {
    const alive = alivePlayers(room);
    const dead  = room.players.filter(p => room.dead.includes(p.uid));
    const mem   = getBotMemory(room, bot.uid);

    const chatHistory = (room.chatLog || []).slice(-15)
        .map(e => `  ${e.name}: ${e.msg}`).join('\n');

    const voteHistory = (room.voteHistory || []).slice(-3)
        .map(r => {
            const myVote = r.votes.find(v => v.voter === bot.name);
            return `День ${r.day}: ${r.votes.map(v => `${v.voter}→${v.target}`).join(' ')} | выбыл: ${r.eliminated || 'никто'}${myVote ? ` (ты голосовал за ${myVote.target})` : ''}`;
        }).join('\n');

    const knowledge = alive.filter(p => p.uid !== bot.uid).map(p => {
        const score = mem.suspects[p.uid] || 0;
        const conf  = mem.confirmed[p.uid];
        let tag = '';
        if (conf === true)   tag = '★МАФИЯ';
        else if (conf === false) tag = '✓чист';
        else if (score > 3)  tag = '⚠подозрен';
        else if (score > 1)  tag = '?сомнит';
        if (bot.role === 'mafia' && p.role === 'mafia') tag = '♦союзник';
        return tag ? `${p.name}[${tag}]` : p.name;
    }).join(', ');

    const roleInstructions = {
        mafia: `Ты МАФИЯ. Скрывай это любой ценой. Ври спокойно, не нервничай. Переводи подозрения на других — особенно на того кто ведёт активное расследование. Если тебя обвиняют — контратакуй: "А сам ты что делал ночью?" Никогда не признавайся.`,
        civilian: `Ты МИРНЫЙ ЖИТЕЛЬ. Ищи противоречия. Обращай внимание на тех кто слишком много говорит ни о чём, или наоборот молчит. Апеллируй к истории голосований — кто за кого голосовал.`,
        doctor: `Ты ДОКТОР. Внешне — обычный мирный. Не раскрывайся без крайней необходимости. Наблюдай, делай выводы, голосуй осторожно.`,
        detective: `Ты ДЕТЕКТИВ. У тебя есть реальные данные о проверках. Используй их: намекай, задавай острые вопросы, раскрывайся когда момент критичен. Не трать козырь слишком рано.`,
    };

    // Уникальные черты характера у каждого бота (по имени)
    const personalities = {
        'Виктор': 'Говоришь коротко и уверенно. Иногда саркастичен.',
        'Карло':  'Нервный, перебиваешь других, говоришь быстро.',
        'Лоренцо':'Рассудительный, ссылаешься на логику и факты.',
        'Анна':   'Дипломатична, иногда уклончива, задаёшь вопросы.',
        'Марко':  'Агрессивный, давишь психологически, громко обвиняешь.',
        'Лучия':  'Тихая, но острая. Замечаешь детали которые другие пропускают.',
        'Джузеппе':'Старый и хитрый. Говоришь притчами, намекаешь.',
        'Роза':   'Эмоциональная, иногда истеричная, искренняя.',
        'Энцо':   'Циничный, не доверяешь никому, всегда ищешь выгоду.',
        'Фиора':  'Холодная и расчётливая. Говоришь факты, без эмоций.',
    };
    const personality = personalities[bot.name] || 'Говоришь по делу, без лишних слов.';

    return {
        systemPrompt: `Ты — ${bot.name}, игрок в Мафию. Характер: ${personality}

${roleInstructions[bot.role] || roleInstructions.civilian}

ЖИВЫЕ: ${alive.map(p => p.name === bot.name ? `[ТЫ]${p.name}` : p.name).join(', ')}
МЕРТВЫЕ: ${dead.map(p => `${p.name}(${p.role})`).join(', ') || 'нет'}
ТВОЯ ОЦЕНКА ИГРОКОВ: ${knowledge || 'нет данных'}

ИСТОРИЯ ГОЛОСОВАНИЙ:
${voteHistory || 'ещё не голосовали'}

ЧАТ (последние реплики):
${chatHistory || '(тишина)'}

СТРОГИЕ ПРАВИЛА:
1. Максимум 1-2 предложения. Не больше 20 слов.
2. НИКОГДА не повторяй свои же предыдущие фразы из чата выше.
3. Реагируй конкретно на последнюю реплику в чате если она есть.
4. Говори В РОЛИ своего характера — кто-то нервный, кто-то холодный.
5. Иногда задавай вопрос вместо утверждения.
6. Без смайликов.`,
    };
}

// ── Основная функция: бот говорит через Claude ────────────
async function botSayAI(room, bot, situation, extra) {
    // Логируем чат для контекста
    if (!room.chatLog) room.chatLog = [];

    if (!GROQ_KEY) {
        if (situation === 'accuse' && extra && extra.name) fallbackSay(room, bot, 'accuse', extra);
        else if (situation === 'defend') fallbackSay(room, bot, 'defend');
        else fallbackSay(room, bot, 'discuss');
        return;
    }

    const ctx = buildGameContext(room, bot);
    let userPrompt = '';

    // Рандомные вариации промптов чтобы ответы не повторялись
    const r = Math.floor(Math.random() * 3);
    switch (situation) {
        case 'discuss':
            userPrompt = [
                'Фаза обсуждения. Выскажись — что замечаешь в поведении игроков?',
                'Твоя очередь говорить. Что тебя беспокоит в этой игре прямо сейчас?',
                'Поделись мыслями. На кого падает твоё подозрение и почему?',
            ][r];
            break;
        case 'accuse':
            userPrompt = extra && extra.name ? [
                `Обвини ${extra.name}. Приведи конкретный аргумент — ссылайся на голосования или поведение.`,
                `Выскажись против ${extra.name}. Почему именно он/она тебя беспокоит?`,
                `Атакуй ${extra.name} словесно. Давай, убеди других.`,
            ][r] : 'Обвини кого-то из живых — конкретно и с аргументом.';
            break;
        case 'defend':
            userPrompt = extra && extra.accuser ? [
                `${extra.accuser} только что обвинил тебя публично. Защищайся — контратакуй или объясняйся.`,
                `${extra.accuser} указал на тебя. Как реагируешь? Можешь переключить внимание на него.`,
                `Тебя обвинили. Ответь резко или спокойно — по характеру.`,
            ][r] : 'Тебя подозревают. Защитись.';
            break;
        case 'react_accusation':
            userPrompt = extra && extra.accused ? [
                `${extra.accuser} обвинил ${extra.accused}. Ты согласен? Поддержи или опровергни.`,
                `Только что атаковали ${extra.accused}. Как ты к этому относишься?`,
                `${extra.accuser} говорит что ${extra.accused} подозрителен. Твоё мнение?`,
            ][r] : 'Кто-то обвинил другого. Твоя реакция?';
            break;
        case 'morning':
            userPrompt = extra && extra.victim ? [
                `Ночью погиб ${extra.victim}. Первая реакция утром — что думаешь?`,
                `${extra.victim} мёртв. Что это говорит нам о мафии?`,
                `Потеряли ${extra.victim}. Как это меняет твою стратегию?`,
            ][r] : [
                'Новый день. Что скажешь первым делом?',
                'Утро. Поделись мыслями о ситуации.',
                'День начался. Твои наблюдения?',
            ][r];
            break;
        case 'detective_reveal':
            userPrompt = [
                `Ты точно знаешь что ${extra.name} — мафия. Реши прямо сейчас: раскрыться публично детективом или намекнуть косвенно?`,
                `У тебя есть доказательство на ${extra.name}. Как будешь действовать — в открытую или хитростью?`,
                `${extra.name} мафия — ты уверен. Самый важный момент. Что говоришь остальным?`,
            ][r];
            break;
        default:
            userPrompt = ['Что скажешь?', 'Твой ход.', 'Выскажись.'][r];
    }

    try {
        const text = await callGroq(ctx.systemPrompt, userPrompt);
        if (!text) throw new Error('empty response');

        let msg = text.replace(/^["«»]|["«»]$/g, '').trim();
        if (msg.length > 120) msg = msg.substring(0, msg.lastIndexOf(' ', 120)) + '...';

        room.chatLog.push({ name: bot.name, msg, ts: Date.now() });
        if (room.chatLog.length > 50) room.chatLog = room.chatLog.slice(-50);

        roomEmit(room, 'game_log', { msg: bot.name + ': ' + msg, cls: 'chat' });
    } catch (e) {
        console.error('[Groq Bot] Ошибка:', e.message);
        fallbackSay(room, bot, situation === 'accuse' ? 'accuse' : 'discuss', extra);
    }
}

// Сохранять сообщения людей в историю чата комнаты
function logHumanChat(room, playerName, msg) {
    if (!room.chatLog) room.chatLog = [];
    room.chatLog.push({ name: playerName, msg, ts: Date.now() });
    if (room.chatLog.length > 50) room.chatLog = room.chatLog.slice(-50);
}

// ── Хранилище состояния ────────────────────────────────────
const queue  = new Map();  // uid → { uid, name, avatar, skinId, socketId, joinedAt }
const rooms  = new Map();  // roomId → Room
const sockets = new Map(); // uid → socket
const reconnectTimers = new Map(); // uid → { timer, roomId }
const rejoinedPlayers = new Set();  // uid → вернулся В ИГРУ (не просто открыл сайт)

let queueTimer   = null;  // таймер ботов (один игрок)
let groupTimer   = null;  // таймер группового запуска

const RECONNECT_TIMEOUT_MS = 20000; // 20 секунд на реконнект

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
    console.log(`[Queue] +${playerInfo.uid.slice(0,8)} MMR:${playerInfo.mmr} | Размер: ${queue.size}`);

    if (queue.size >= MAX_ROOM) {
        cancelQueueTimers();
        // ── MMR-aware lobby selection ──
        // Pick MAX_ROOM players with closest MMR spread (minimise max-min range)
        const all = [...queue.values()];
        let bestGroup = all.slice(0, MAX_ROOM);
        if (all.length > MAX_ROOM) {
            // Sort by MMR and use a sliding window to find tightest cluster
            const sorted = all.slice().sort((a, b) => (a.mmr || 500) - (b.mmr || 500));
            let minSpread = Infinity;
            for (let i = 0; i <= sorted.length - MAX_ROOM; i++) {
                const window = sorted.slice(i, i + MAX_ROOM);
                const spread = (window[MAX_ROOM - 1].mmr || 500) - (window[0].mmr || 500);
                if (spread < minSpread) { minSpread = spread; bestGroup = window; }
            }
        }
        launchRoom(bestGroup);
    } else if (queue.size >= 2) {
        scheduleGroupLaunch();
    } else if (queue.size === 1) {
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

    // ── Watchdog: если фаза зависла >2мин — принудительно продвигаем ──
    const watchdog = setInterval(() => {
        if (!rooms.has(roomId)) { clearInterval(watchdog); return; }
        const r = rooms.get(roomId);
        if (r.phase === 'over') { clearInterval(watchdog); return; }
        const now = Date.now();
        const elapsed = now - (r._phaseStart || now);
        if (elapsed > 120000) { // 2 минуты
            console.warn(`[Watchdog] Комната ${roomId} зависла в фазе '${r.phase}' (${Math.round(elapsed/1000)}с) — принудительный переход`);
            r._resolving = false;
            r._voteResolvePending = false;
            r._nightResolvePending = false;
            if (r.phase === 'night' || r.phase === 'resolving') {
                resolveNight(r);
            } else if (r.phase === 'vote') {
                resolveVote(r);
            } else if (r.phase === 'day') {
                startVote(r);
            }
        }
    }, 15000);

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
                uid:               pl.uid,
                name:              pl.name,
                avatar:            pl.avatar   || '🎩',
                photoURL:          pl.avatarImg || pl.photoURL || null,
                skinId:            pl.skinId   || 'classic',
                slot:              pl.slot,
                isBot:             !!pl.isBot,
                wins:              pl.wins     || 0,
                losses:            pl.losses   || 0,
                mmr:               pl.mmr      || 500,
                calibDone:         !!pl.calibDone,
                calibrationPlayed: pl.calibrationPlayed || 0,
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
    const role = p ? p.role : null;
    const roleLabels = { mafia: 'Мафия', civilian: 'Мирный', doctor: 'Доктор', detective: 'Детектив' };
    const roleLabel = roleLabels[role] || role;

    // Всем — факт выбывания и роль
    roomEmit(room, 'eliminated', { uid, name, role, reason, msg: `💀 ${name} выбыл. Роль: ${roleLabel}` });

    // Мафии дополнительно — кем был убитый если убийство ночью
    if (reason === 'night') {
        room.players.filter(q => q.role === 'mafia' && !q.isBot && !room.dead.includes(q.uid)).forEach(mafioso => {
            const sock = sockets.get(mafioso.uid);
            if (sock) sock.emit('game_log', {
                msg: `🔴 [Мафия] Вы устранили ${name} — он был ${roleLabel}`,
                cls: 'system'
            });
        });
    }

    console.log(`[Room ${room.id}] Выбыл: ${name} (${role}) — ${reason}`);

    // ── Разблокировать текущую фазу если она ждала этого игрока ──
    // Вызываем после dead.push, чтобы aliveCount/aliveNonBot уже не включал выбывшего
    if (room.phase === 'vote') {
        // Засчитать пропуск если не голосовал
        if (room.actions[uid] === undefined) room.actions[uid] = null;
        const aliveCount = alivePlayers(room).length;
        const voted = Object.keys(room.actions).length;
        console.log(`[Vote] После выбывания ${name}: ${voted} голосов / ${aliveCount} живых`);
        if (voted >= aliveCount && !room._voteResolvePending && !room._resolving) {
            room._voteResolvePending = true;
            const t = setTimeout(() => resolveVote(room), 1500);
            room.timers.push(t);
        }
    }
    if (room.phase === 'night') {
        // Засчитать пропуск если не действовал
        const roleActionMap = { mafia: 'kill', doctor: 'save', detective: 'investigate' };
        const actionKey = roleActionMap[role];
        if (actionKey) {
            if (!room.actions[actionKey]) room.actions[actionKey] = {};
            if (room.actions[actionKey][uid] === undefined) {
                room.actions[actionKey][uid] = '__skip__';
            }
        }
        checkNightComplete(room);
    }
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

// ── Вспомогательные функции для ботов ────────────────────

// Случайная задержка в диапазоне
function rndDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

// Проверить: все живые боты выполнили нужное действие?
function allBotsDone(room, phase, actionKey) {
    const aliveBots = room.players.filter(p => p.isBot && !room.dead.includes(p.uid));
    if (phase === 'vote') {
        return aliveBots.every(b => room.actions[b.uid] !== undefined);
    }
    if (actionKey) {
        const done = room.actions[actionKey] || {};
        const botsWithRole = aliveBots.filter(b => {
            if (actionKey === 'kill') return b.role === 'mafia';
            if (actionKey === 'save') return b.role === 'doctor';
            if (actionKey === 'investigate') return b.role === 'detective';
            return false;
        });
        return botsWithRole.every(b => done[b.uid]);
    }
    return false;
}

// Ускорить фазу если все живые люди уже проголосовали/действовали
function tryFastForward(room, phase, resolveFunc, delayMs) {
    const aliveHumansList = aliveHumans(room);
    const allHumansDone = aliveHumansList.every(p => {
        if (phase === 'vote') return room.actions[p.uid] !== undefined;
        // для ночи — хватит что мафия среди людей выбрала
        return true;
    });
    if (allHumansDone && allBotsDone(room, phase)) {
        // Все действовали — можно ускорить
        const t = setTimeout(() => resolveFunc(room), delayMs || 2000);
        room.timers.push(t);
        return true;
    }
    return false;
}

// ── Память ботов ──────────────────────────────────────────
// room.botMemory = { [botUid]: { suspects: {uid: score}, confirmed: {uid: bool} } }
function getBotMemory(room, botUid) {
    if (!room.botMemory) room.botMemory = {};
    if (!room.botMemory[botUid]) {
        room.botMemory[botUid] = { suspects: {}, confirmed: {} };
    }
    return room.botMemory[botUid];
}

function botSuspectScore(room, botUid, targetUid) {
    const mem = getBotMemory(room, botUid);
    return mem.suspects[targetUid] || 0;
}

function botAddSuspicion(room, botUid, targetUid, delta) {
    const mem = getBotMemory(room, botUid);
    mem.suspects[targetUid] = (mem.suspects[targetUid] || 0) + delta;
}

// Выбрать лучшую цель для бота с учётом памяти
function botPickTarget(room, bot, candidates) {
    if (candidates.length === 0) return null;
    const mem = getBotMemory(room, bot.uid);
    // Сначала — подтверждённые мафиози (от детектива)
    const confirmed = candidates.find(p => mem.confirmed[p.uid] === true);
    if (confirmed) return confirmed;
    // Затем — наиболее подозреваемый
    const sorted = [...candidates].sort((a, b) =>
        (mem.suspects[b.uid] || 0) - (mem.suspects[a.uid] || 0)
    );
    // 70% шанс выбрать наиболее подозреваемого, 30% — случайного (реализм)
    if (Math.random() < 0.7 && (mem.suspects[sorted[0].uid] || 0) > 0) {
        return sorted[0];
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
}

// ── День ──────────────────────────────────────────────────
function startDay(room) {
    room.phase = 'day';
    room._phaseStart = Date.now();
    room._resolving = false;
    room._voteResolvePending = false;
    room._nightResolvePending = false;
    room.day++;
    room.actions = {};
    roomEmit(room, 'day_start', { day: room.day, discussionSeconds: 30 });
    roomEmit(room, 'game_log', { msg: `☀️ День ${room.day}. Обсуждайте, кто из вас мафия.`, cls: 'system' });

    // Боты пишут в чат через Claude AI
    const aliveBots = room.players.filter(p => p.isBot && !room.dead.includes(p.uid));
    const aliveList = alivePlayers(room);

    // Утреннее сообщение если кто-то погиб ночью
    const lastVictim = room._lastNightVictim;
    room._lastNightVictim = null;

    aliveBots.forEach((bot, botIdx) => {
        const mem = getBotMemory(room, bot.uid);

        // Первое сообщение — реакция на утро / жертву ночи
        const firstDelay = rndDelay(2000 + botIdx * 1500, 5000 + botIdx * 1500);
        const t1 = setTimeout(async () => {
            if (room.phase !== 'day' || room.dead.includes(bot.uid)) return;
            await botSayAI(room, bot, 'morning', lastVictim ? { victim: lastVictim } : null);
        }, firstDelay);
        room.timers.push(t1);

        // Второе сообщение — обвинение или обсуждение
        const secondDelay = rndDelay(10000 + botIdx * 2000, 20000 + botIdx * 2000);
        const t2 = setTimeout(async () => {
            if (room.phase !== 'day' || room.dead.includes(bot.uid)) return;

            // Детектив: решает раскрыться или намекнуть
            if (bot.role === 'detective') {
                const foundMafia = Object.entries(mem.confirmed).find(([uid, isMafia]) => isMafia);
                if (foundMafia) {
                    const target = aliveList.find(p => p.uid === foundMafia[0] && !room.dead.includes(p.uid));
                    if (target) {
                        await botSayAI(room, bot, 'detective_reveal', { name: target.name });
                        botAddSuspicion(room, bot.uid, target.uid, 10);
                        // Подталкивает других ботов
                        aliveBots.filter(b => b.uid !== bot.uid && b.role !== 'mafia').forEach(ally => {
                            botAddSuspicion(room, ally.uid, target.uid, 3);
                        });
                        return;
                    }
                }
            }

            // Мафия: обвиняет мирного (предпочтительно детектива/доктора)
            if (bot.role === 'mafia') {
                const innocents = aliveList.filter(p => p.uid !== bot.uid && p.role !== 'mafia');
                if (innocents.length > 0 && Math.random() < 0.65) {
                    const priority = innocents.filter(p => p.role === 'detective' || p.role === 'doctor');
                    const target = priority.length > 0 && Math.random() < 0.5
                        ? priority[Math.floor(Math.random() * priority.length)]
                        : innocents[Math.floor(Math.random() * innocents.length)];
                    await botSayAI(room, bot, 'accuse', { name: target.name });
                    // Мафия сеет подозрение у других ботов
                    aliveBots.filter(b => b.uid !== bot.uid && b.role !== 'mafia').forEach(ally => {
                        botAddSuspicion(room, ally.uid, target.uid, 1);
                    });
                    return;
                }
            }

            // Остальные: обвиняют подозреваемого или просто обсуждают
            const topSuspect = aliveList
                .filter(p => p.uid !== bot.uid && !room.dead.includes(p.uid) && (mem.suspects[p.uid] || 0) > 0)
                .sort((a, b) => (mem.suspects[b.uid] || 0) - (mem.suspects[a.uid] || 0))[0];

            if (topSuspect && Math.random() < 0.65) {
                await botSayAI(room, bot, 'accuse', { name: topSuspect.name });
            } else {
                await botSayAI(room, bot, 'discuss');
            }
        }, secondDelay);
        room.timers.push(t2);

        // Третье сообщение — реакция на обвинение или доп. аргумент (50% шанс)
        if (Math.random() < 0.5) {
            const thirdDelay = rndDelay(22000 + botIdx * 1000, DAY_DISCUSS_MS - 3000);
            const t3 = setTimeout(async () => {
                if (room.phase !== 'day' || room.dead.includes(bot.uid)) return;
                // Если бота недавно обвинили — защищается
                if (room._recentAccusations && room._recentAccusations[bot.uid]) {
                    await botSayAI(room, bot, 'defend', { accuser: room._recentAccusations[bot.uid] });
                    delete room._recentAccusations[bot.uid];
                } else {
                    await botSayAI(room, bot, 'discuss');
                }
            }, thirdDelay);
            room.timers.push(t3);
        }
    });

    const t = setTimeout(() => startVote(room), DAY_DISCUSS_MS);
    room.timers.push(t);
}

// ── Голосование ───────────────────────────────────────────
function startVote(room) {
    if (room.phase === 'over') return;
    room.phase = 'vote';
    room.actions = {};
    roomEmit(room, 'vote_start', { timeMs: VOTE_TIME_MS });
    roomEmit(room, 'game_log', { msg: '🗳️ Голосование! Кто подозреваемый?', cls: 'system' });

    const aliveList = alivePlayers(room);

    // Боты голосуют с умом
    room.players.filter(p => p.isBot && !room.dead.includes(p.uid)).forEach(bot => {
        const delay = rndDelay(2000, 8000);
        const t = setTimeout(() => {
            if (room.phase !== 'vote' || room.dead.includes(bot.uid)) return;
            const candidates = aliveList.filter(p => p.uid !== bot.uid);
            if (candidates.length === 0) return;

            let target;
            if (bot.role === 'mafia') {
                // Мафия голосует за мирных, предпочитая детектива/доктора
                const priority = candidates.filter(p => p.role === 'detective' || p.role === 'doctor');
                target = priority.length > 0 && Math.random() < 0.6
                    ? priority[Math.floor(Math.random() * priority.length)]
                    : botPickTarget(room, bot, candidates.filter(p => p.role !== 'mafia'));
            } else {
                target = botPickTarget(room, bot, candidates);
            }

            if (target) {
                recordVote(room, bot.uid, target.uid);
                // Добавить подозрение соседним ботам на цель
                if (bot.role !== 'mafia') {
                    aliveList.filter(p => p.isBot && p.uid !== bot.uid && p.role !== 'mafia').forEach(ally => {
                        botAddSuspicion(room, ally.uid, target.uid, 0.5);
                    });
                }
            }
        }, delay);
        room.timers.push(t);
    });

    const t = setTimeout(() => resolveVote(room), VOTE_TIME_MS);
    room.timers.push(t);
}

function recordVote(room, voterUid, targetUid) {
    if (room.phase !== 'vote') return;

    // Конвертировать числовой id в uid
    if (typeof targetUid === 'number') {
        const p = room.players.find(p => p.id === targetUid || p.slot === targetUid);
        if (p) targetUid = p.uid;
    }

    room.actions[voterUid] = targetUid;
    roomEmit(room, 'vote_cast', { voterUid, targetUid });
    const tStr = targetUid ? String(targetUid).slice(0,8) : 'skip';
    console.log(`[Vote] ${String(voterUid).slice(0,8)} → ${tStr}`);
    // Ускорить если все проголосовали
    const aliveCount = alivePlayers(room).length;
    const voteCount = Object.keys(room.actions).length;
    if (voteCount >= aliveCount && !room._voteResolvePending && !room._resolving) {
        room._voteResolvePending = true;
        const t = setTimeout(() => resolveVote(room), 1500);
        room.timers.push(t);
    }
}

function resolveVote(room) {
    if (room.phase !== 'vote' && room.phase !== 'resolving') return;
    if (room._resolving) return;
    room._resolving = true;
    room._voteResolvePending = false;

    const counts = {};
    Object.values(room.actions).forEach(uid => {
        if (uid) counts[uid] = (counts[uid] || 0) + 1;
    });

    let maxVotes = 0;
    let eliminated = null;
    Object.entries(counts).forEach(([uid, cnt]) => {
        if (cnt > maxVotes) { maxVotes = cnt; eliminated = uid; }
    });

    // Проверка ничьей
    const topCount = Object.values(counts).filter(c => c === maxVotes).length;
    if (topCount > 1 || maxVotes === 0) {
        room._resolving = false;
        roomEmit(room, 'game_log', { msg: '🤷 Голоса разделились — ничья. Никто не выбыл.', cls: 'system' });
        const t = setTimeout(() => startNight(room), 3000);
        room.timers.push(t);
        return;
    }

    // Сохранить историю голосований
    if (!room.voteHistory) room.voteHistory = [];
    room.voteHistory.push({
        day: room.day,
        votes: Object.entries(room.actions).map(([voterUid, targetUid]) => {
            const voter = room.players.find(p => p.uid === voterUid);
            const target = room.players.find(p => p.uid === targetUid);
            return { voter: voter ? voter.name : voterUid, target: target ? target.name : targetUid };
        }),
        eliminated: null // заполним ниже
    });

    if (eliminated && maxVotes > 0) {
        const victim = room.players.find(p => p.uid === eliminated);
        // Обновить историю
        room.voteHistory[room.voteHistory.length - 1].eliminated = victim ? victim.name : eliminated;

        if (victim && victim.role !== 'mafia') {
            // Голосовавшие против мирного — подозреваемые
            Object.entries(room.actions).forEach(([voterUid, targetUid]) => {
                if (targetUid === eliminated) {
                    room.players.filter(p => p.isBot && !room.dead.includes(p.uid) && p.role !== 'mafia').forEach(bot => {
                        botAddSuspicion(room, bot.uid, voterUid, 1.5);
                    });
                }
            });
        }
        eliminatePlayer(room, eliminated, 'vote');
        const winner = checkWin(room);
        if (winner) return endGame(room, winner);
    } else {
        roomEmit(room, 'game_log', { msg: '🤷 Никто не набрал большинства. Никто не выбыл.', cls: 'system' });
    }

    room._resolving = false;
    roomEmit(room, 'vote_resolved', {});
    const t = setTimeout(() => startNight(room), 3000);
    room.timers.push(t);
}

// ── Ночь ──────────────────────────────────────────────────
function startNight(room) {
    room.phase = 'night';
    room._phaseStart = Date.now();
    room._resolving = false;
    room._voteResolvePending = false;
    room._nightResolvePending = false;
    room.night = (room.night || 0) + 1;
    room.actions = {};
    roomEmit(room, 'night_start', {});
    roomEmit(room, 'game_log', { msg: `🌙 Ночь ${room.night}. Город засыпает...`, cls: 'system' });

    const aliveList = alivePlayers(room);

    // Мафия-боты координируются: выбирают одну цель
    const mafiaBot = room.players.filter(p => p.isBot && p.role === 'mafia' && !room.dead.includes(p.uid));
    if (mafiaBot.length > 0) {
        // Все мафия-боты голосуют за одну цель (детектив/доктор приоритет)
        const nonMafia = aliveList.filter(p => p.role !== 'mafia');
        if (nonMafia.length > 0) {
            const priority = nonMafia.filter(p => p.role === 'detective' || p.role === 'doctor');
            const killTarget = priority.length > 0 && Math.random() < 0.65
                ? priority[Math.floor(Math.random() * priority.length)]
                : botPickTarget(room, mafiaBot[0], nonMafia);

            mafiaBot.forEach(bot => {
                const delay = rndDelay(2000, 6000);
                const t = setTimeout(() => {
                    if (room.phase !== 'night') return;
                    recordNightAction(room, bot.uid, 'kill', killTarget.uid);
                }, delay);
                room.timers.push(t);
            });
        }
    }

    // Доктор-бот: лечит себя или подозреваемого-не-мафию
    room.players.filter(p => p.isBot && p.role === 'doctor' && !room.dead.includes(p.uid)).forEach(bot => {
        const delay = rndDelay(2000, 6000);
        const t = setTimeout(() => {
            if (room.phase !== 'night') return;
            // 40% — лечит себя, иначе кого-то из мирных
            const target = Math.random() < 0.4
                ? bot
                : aliveList.filter(p => p.role !== 'mafia')[Math.floor(Math.random() * aliveList.filter(p => p.role !== 'mafia').length)] || bot;
            recordNightAction(room, bot.uid, 'save', target.uid);
        }, delay);
        room.timers.push(t);
    });

    // Детектив-бот: проверяет наиболее подозреваемого
    room.players.filter(p => p.isBot && p.role === 'detective' && !room.dead.includes(p.uid)).forEach(bot => {
        const delay = rndDelay(2000, 5000);
        const t = setTimeout(() => {
            if (room.phase !== 'night') return;
            const mem = getBotMemory(room, bot.uid);
            // Проверяем того кого ещё не проверяли
            const unchecked = aliveList.filter(p => p.uid !== bot.uid && mem.confirmed[p.uid] === undefined);
            // Приоритет — наиболее подозреваемые непроверенные
            const target = unchecked.length > 0
                ? botPickTarget(room, bot, unchecked)
                : aliveList.filter(p => p.uid !== bot.uid)[0];
            if (target) {
                recordNightAction(room, bot.uid, 'investigate', target.uid);
                // Сохранить результат в память
                mem.confirmed[target.uid] = (target.role === 'mafia');
                if (target.role === 'mafia') {
                    // Нашли мафию — максимальное подозрение на следующий день
                    botAddSuspicion(room, bot.uid, target.uid, 10);
                }
            }
        }, delay);
        room.timers.push(t);
    });

    const t = setTimeout(() => resolveNight(room), NIGHT_TIME_MS);
    room.timers.push(t);
}

function recordNightAction(room, uid, type, targetUid) {
    if (room.phase !== 'night') return;

    // Конвертировать числовой id в uid если клиент прислал число
    if (typeof targetUid === 'number') {
        const p = room.players.find(p => p.id === targetUid || p.slot === targetUid);
        if (p) targetUid = p.uid;
        else { console.warn('[Night] targetUid число но игрок не найден:', targetUid); return; }
    }
    if (!targetUid || typeof targetUid !== 'string') {
        console.warn('[Night] некорректный targetUid:', targetUid);
        return;
    }

    if (!room.actions[type]) room.actions[type] = {};
    room.actions[type][uid] = targetUid;
    const sock = sockets.get(uid);
    if (sock) sock.emit('action_confirmed', { type });
    console.log(`[Night] ${String(uid).slice(0,8)} → ${type} → ${String(targetUid).slice(0,8)}`);

    checkNightComplete(room);
}

function checkNightComplete(room) {
    if (room.phase !== 'night' || room._resolving || room._nightResolvePending) return;

    const aliveList = alivePlayers(room);

    // Для каждой роли — нужно ли её действие и выполнено ли
    const roleDone = (role, actionKey) => {
        const players = aliveList.filter(p => p.role === role);
        if (players.length === 0) return true; // нет таких игроков — не нужно
        const actions = room.actions[actionKey] || {};
        return players.every(p => actions[p.uid] !== undefined);
    };

    const allDone = roleDone('mafia', 'kill')
        && roleDone('doctor', 'save')
        && roleDone('detective', 'investigate');

    if (allDone && !room._nightResolvePending) {
        room._nightResolvePending = true;
        console.log('[Night] Все действия выполнены — завершаем через 1.5с');
        const fast = setTimeout(() => resolveNight(room), 1500);
        room.timers.push(fast);
    }
}

function resolveNight(room) {
    if (room.phase !== 'night' && room.phase !== 'resolving') return;
    if (room._resolving) return;
    room._resolving = true;
    room._nightResolvePending = false;

    const killVotes = room.actions['kill'] || {};
    const counts = {};
    Object.values(killVotes).forEach(uid => { counts[uid] = (counts[uid] || 0) + 1; });
    let killTarget = null;
    let maxKills = 0;
    Object.entries(counts).forEach(([uid, cnt]) => {
        if (cnt > maxKills) { maxKills = cnt; killTarget = uid; }
    });

    const saveVotes = room.actions['save'] || {};
    const savedUids = new Set(Object.values(saveVotes));

    // Расследование — раскрыть детективам-людям
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
        const victim = room.players.find(p => p.uid === killTarget);
        // Боты запоминают: кого убила мафия (повышает подозрение к тем кто не реагировал)
        room.players.filter(p => p.isBot && !room.dead.includes(p.uid) && p.role !== 'mafia').forEach(bot => {
            botAddSuspicion(room, bot.uid, killTarget, -5); // жертва точно не мафия
        });
        const victimPlayer = room.players.find(p => p.uid === killTarget);
        room._lastNightVictim = victimPlayer ? victimPlayer.name : null;
        eliminatePlayer(room, killTarget, 'night');
        const winner = checkWin(room);
        if (winner) return endGame(room, winner);
    } else if (killTarget && savedUids.has(killTarget)) {
        roomEmit(room, 'game_log', { msg: '💊 Доктор спас кого-то этой ночью!', cls: 'system' });
    } else {
        roomEmit(room, 'game_log', { msg: '🌙 Тихая ночь. Никто не погиб.', cls: 'system' });
    }

    room._resolving = false;
    roomEmit(room, 'night_resolved', {
        killed: (killTarget && !savedUids.has(killTarget)) ? killTarget : null,
        saved:  (killTarget && savedUids.has(killTarget))  ? killTarget : null,
        day:    room.day
    });
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

    // Раскрываем все роли + alive статус + avatar для post-match экрана
    const roleReveal = room.players.map(p => ({
        uid:    p.uid,
        name:   p.name,
        role:   p.role,
        alive:  !room.dead.includes(p.uid),
        isBot:  !!p.isBot,
        avatar: p.avatar || '🎩',
    }));

    room._lastWinner = winner; // сохраняем для повторной отправки при rejoin
    console.log(`[Room ${room.id}] Игра окончена: ${winner} | игроков: ${room.players.length}`);
    roomEmit(room, 'game_over', { winner, msg, roles: roleReveal });

    // Удалить комнату через 60 секунд (больше времени для post-match экрана)
    setTimeout(() => rooms.delete(room.id), 60000);
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

        // Заменяем старый сокет если был
        const oldSock = sockets.get(uid);
        if (oldSock && oldSock.id !== socket.id) {
            console.log(`[WS] Заменяем старый сокет для ${uid.slice(0,8)}`);
            oldSock.disconnect(true);
        }

        socket.uid = uid;
        sockets.set(uid, socket);

        // Автоматически re-join в socket.io комнату если игрок был в игре
        // Это критично: новый сокет должен получать roomEmit события
        let rejoinedRoom = null;
        rooms.forEach(room => {
            const p = room.players.find(p => p.uid === uid);
            if (p && room.phase !== 'over') {
                socket.join(room.id);
                rejoinedRoom = room;
                console.log(`[WS] Авто-rejoin сокета ${uid.slice(0,8)} в комнату ${room.id} (фаза: ${room.phase})`);
            }
        });

        socket.emit('auth_ok', { uid });
        console.log(`[WS] Авторизован: ${uid.slice(0,8)}`);

        // Если переподключился во время активной игры — отменяем таймер выбывания
        if (rejoinedRoom && reconnectTimers.has(uid)) {
            const { timer, countdown } = reconnectTimers.get(uid);
            clearTimeout(timer);
            clearInterval(countdown);
            reconnectTimers.delete(uid);
            rejoinedPlayers.add(uid);
            console.log(`[Reconnect] ${uid.slice(0,8)} авто-реконнект через auth`);
        }
    });

    // ── Войти в очередь ───────────────────────────────────
    socket.on('join_queue', ({ name, avatar, skinId, photoURL, wins, losses, mmr, calibDone, calibrationPlayed }) => {
        if (!socket.uid) { socket.emit('error', { msg: 'Не авторизован' }); return; }
        addToQueue({
            uid: socket.uid, name: name || 'Игрок', avatar: avatar || '🎩',
            skinId: skinId || 'classic', socketId: socket.id, joinedAt: Date.now(),
            photoURL: photoURL || null,
            wins:              typeof wins              === 'number' ? wins              : 0,
            losses:            typeof losses            === 'number' ? losses            : 0,
            mmr:               typeof mmr               === 'number' ? mmr               : 500,
            calibDone:         !!calibDone,
            calibrationPlayed: typeof calibrationPlayed === 'number' ? calibrationPlayed : 0,
        });
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

        const sender = room.players.find(p => p.uid === socket.uid);

        if (room.phase === 'night' && sender && sender.role === 'mafia') {
            room.players.filter(p => p.role === 'mafia' && !p.isBot).forEach(p => {
                const sock = sockets.get(p.uid);
                if (sock) sock.emit('game_log', { msg: `[Мафия] ${playerName}: ${msg}`, cls: 'chat mafia' });
            });
        } else if (room.phase === 'day') {
            logHumanChat(room, playerName, msg);
            io.to(roomId).emit('game_log', { msg: `${playerName}: ${msg}`, cls: 'chat' });

            // Боты реагируют на сообщения людей (30% шанс)
            const aliveBots = room.players.filter(p => p.isBot && !room.dead.includes(p.uid));
            aliveBots.forEach(bot => {
                if (Math.random() > 0.3) return;
                const delay = rndDelay(4000, 12000);
                const t = setTimeout(async () => {
                    if (room.phase !== 'day' || room.dead.includes(bot.uid)) return;
                    const botMentioned = msg.toLowerCase().includes(bot.name.toLowerCase());
                    if (botMentioned) {
                        if (!room._recentAccusations) room._recentAccusations = {};
                        room._recentAccusations[bot.uid] = playerName;
                        await botSayAI(room, bot, 'defend', { accuser: playerName });
                    } else {
                        const otherMentioned = aliveBots.find(b => b.uid !== bot.uid && msg.toLowerCase().includes(b.name.toLowerCase()));
                        if (otherMentioned) {
                            await botSayAI(room, bot, 'react_accusation', { accuser: playerName, accused: otherMentioned.name });
                        } else {
                            await botSayAI(room, bot, 'discuss');
                        }
                    }
                }, delay);
                room.timers.push(t);
            });
        }
    });

    // ── Отключение ────────────────────────────────────────
    socket.on('disconnect', () => {
        const uid = socket.uid;
        console.log(`[WS] Отключение: ${socket.id}${uid ? ' uid:' + uid.slice(0,8) : ''}`);

        if (uid) {
            removeFromQueue(uid);
            // Only delete from sockets if this IS the current socket for this uid
            // (a reconnected socket may have already replaced it)
            if (sockets.get(uid) === socket) sockets.delete(uid);
            rejoinedPlayers.delete(uid);

            // Найти комнату игрока
            let playerRoom = null;
            let playerInRoom = null;
            rooms.forEach(room => {
                const p = room.players.find(p => p.uid === uid);
                if (p && !room.dead.includes(uid) && room.phase !== 'over') {
                    playerRoom = room;
                    playerInRoom = p;
                }
            });

            if (playerRoom && playerInRoom) {
                // Уведомить всех — даём 10 секунд
                roomEmit(playerRoom, 'game_log', {
                    msg: `⚠️ ${playerInRoom.name} отключился. 20 секунд на возврат...`,
                    cls: 'system'
                });
                roomEmit(playerRoom, 'player_disconnected', { uid, name: playerInRoom.name, seconds: 20 });

                // Отсчёт для игрока
                let sec = 20;
                const countdown = setInterval(() => {
                    sec--;
                    roomEmit(playerRoom, 'reconnect_countdown', { uid, seconds: sec });
                }, 1000);

                const timer = setTimeout(() => {
                    clearInterval(countdown);
                    // Проверяем — вернулся ли игрок ИМЕННО В ИГРУ (rejoin), не просто открыл сайт
                    if (rejoinedPlayers.has(uid)) {
                        rejoinedPlayers.delete(uid);
                        console.log(`[Reconnect] ${uid.slice(0,8)} вернулся в игру вовремя`);
                        return;
                    }
                    // Не вернулся — выбываем
                    const room = playerRoom;
                    if (!room || room.phase === 'over') return;
                    const p = room.players.find(p => p.uid === uid);
                    if (!p || room.dead.includes(uid)) return;

                    console.log(`[Reconnect] ${uid.slice(0,8)} не вернулся — выбывает`);
                    roomEmit(room, 'game_log', {
                        msg: `🚪 ${p.name} покинул игру (отключение).`,
                        cls: 'system'
                    });
                    eliminatePlayer(room, uid, 'disconnect');
                    reconnectTimers.delete(uid);

                    // Проверить победу
                    const winner = checkWin(room);
                    if (winner) { endGame(room, winner); return; }

                    // Разблокировка фазы встроена в eliminatePlayer — дополнительного кода не нужно
                }, RECONNECT_TIMEOUT_MS);

                reconnectTimers.set(uid, { timer, countdown, roomId: playerRoom.id });
            }
        }
    });

    // ── Отказ от возврата в игру ────────────────────────
    socket.on('decline_rejoin', ({ roomId }) => {
        const uid = socket.uid;
        if (!uid) return;

        // Отменить таймер реконнекта если ещё тикает
        if (reconnectTimers.has(uid)) {
            const { timer, countdown } = reconnectTimers.get(uid);
            clearTimeout(timer);
            clearInterval(countdown);
            reconnectTimers.delete(uid);
        }

        const room = rooms.get(roomId);
        if (!room || room.phase === 'over') return;
        const p = room.players.find(p => p.uid === uid);
        if (!p || room.dead.includes(uid)) return;

        console.log(`[Decline] uid=${uid.slice(0,8)} roomId=${roomId} phase=${room.phase}`);
        roomEmit(room, 'game_log', {
            msg: `🚪 ${p.name} покинул игру.`,
            cls: 'system'
        });
        eliminatePlayer(room, uid, 'disconnect');

        const winner = checkWin(room);
        if (winner) { endGame(room, winner); return; }

        // Разблокировка фазы встроена в eliminatePlayer
    });

    // ── Реконнект ────────────────────────────────────────
    socket.on('rejoin', ({ roomId }) => {
        const uid = socket.uid;
        if (!uid) return;

        // Пометить что игрок РЕАЛЬНО вернулся в игру
        rejoinedPlayers.add(uid);

        // Отменить таймер выбывания
        if (reconnectTimers.has(uid)) {
            const { timer, countdown } = reconnectTimers.get(uid);
            clearTimeout(timer);
            clearInterval(countdown);
            reconnectTimers.delete(uid);
        }

        const room = rooms.get(roomId);
        if (!room) return;

        // Если игра уже закончилась — повторно отправить game_over этому игроку
        if (room.phase === 'over') {
            const msg = room._lastWinner === 'mafia'
                ? '🔴 Мафия победила! Город под контролем преступников.'
                : '🟢 Мирные жители победили! Мафия уничтожена.';
            const roleReveal = room.players.map(p => ({
                uid: p.uid, name: p.name, role: p.role,
                alive: !room.dead.includes(p.uid),
                isBot: !!p.isBot, avatar: p.avatar || '🎩',
            }));
            socket.emit('game_over', { winner: room._lastWinner || 'civ', msg, roles: roleReveal });
            console.log(`[Rejoin] ${uid.slice(0,8)} — игра уже окончена, повторяем game_over`);
            return;
        }

        const p = room.players.find(p => p.uid === uid);
        if (!p || room.dead.includes(uid)) return;

        // Переподключаем
        sockets.set(uid, socket);
        socket.join(roomId);
        console.log(`[Reconnect] ${uid.slice(0,8)} вернулся в комнату ${roomId}`);

        roomEmit(room, 'game_log', { msg: `✅ ${p.name} вернулся в игру.`, cls: 'system' });

        // Отправить текущее состояние игры реконнектнувшемуся
        socket.emit('game_rejoin', {
            roomId,
            myUid:   uid,
            myRole:  p.role,
            phase:   room.phase,
            day:     room.day,
            dead:    room.dead,
            players: room.players.map(pl => ({
                uid:   pl.uid,
                name:  pl.name,
                slot:  pl.slot,
                isBot: pl.isBot,
                role:  (pl.uid === uid || (p.role === 'mafia' && pl.role === 'mafia')) ? pl.role : null
            }))
        });
    });
});

// ── Health check endpoint ──────────────────────────────────
app.get('/', (req, res) => res.json({
    status: 'ok',
    queue: queue.size,
    rooms: rooms.size
}));

// ── Проверка активной комнаты для реконнекта ───────────────
// GET /rejoin-check?uid=XXX
// Возвращает: { found: true, roomId, phase, day } или { found: false }
app.get('/rejoin-check', (req, res) => {
    const uid = req.query.uid;
    if (!uid) return res.json({ found: false });
    let found = false;
    rooms.forEach(room => {
        if (found) return;
        const p = room.players.find(p => p.uid === uid);
        if (p && !room.dead.includes(uid) && room.phase !== 'over') {
            found = true;
            res.json({
                found: true,
                roomId: room.id,
                phase: room.phase,
                day: room.day,
                playerName: p.name
            });
        }
    });
    if (!found) res.json({ found: false });
});

server.listen(PORT, () => console.log(`[Server] Запущен на порту ${PORT}`));
