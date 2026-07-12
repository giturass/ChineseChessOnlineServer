import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  applyLegalMove,
  createInitialBoard,
  evaluateStatus,
  positionKey,
  validMoveShape,
} from "./xiangqi.js";

const PORT = envInteger("PORT", 10000, 1, 65535);
const PLAYER_TIMEOUT_MS = envInteger("PLAYER_TIMEOUT_MS", 90_000, 5_000, 24 * 60 * 60_000);
const ROOM_TTL_MS = envInteger("ROOM_TTL_MS", 30 * 60_000, 10_000, 7 * 24 * 60 * 60_000);
const MAX_STATE_WAIT_MS = envInteger("MAX_STATE_WAIT_MS", 15_000, 0, 30_000);
const MAX_WAITERS_PER_ROOM = envInteger("MAX_WAITERS_PER_ROOM", 20, 1, 200);
const MAX_ROOMS = envInteger("MAX_ROOMS", 10_000, 1, 100_000);
const MAX_MOVES_PER_GAME = envInteger("MAX_MOVES_PER_GAME", 600, 20, 10_000);
const MAX_REQUEST_IDS_PER_ROOM = envInteger("MAX_REQUEST_IDS_PER_ROOM", 256, 16, 4096);
const PENDING_ACTION_TTL_MS = envInteger("PENDING_ACTION_TTL_MS", 60_000, 5_000, 10 * 60_000);
const rooms = new Map();

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      send(res, 204, null);
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|move|action|leave))?$/);
    if (!match) {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        send(res, 200, { ok: true, service: "ChineseChessOnline" });
      } else {
        sendError(res, "接口不存在", 404, "NOT_FOUND");
      }
      return;
    }

    const roomId = normalizeRoomId(decodeURIComponent(match[1]));
    if (!roomId) {
      sendError(res, "房间号无效", 400);
      return;
    }

    const command = match[2] || "state";
    const isJoin = command === "join" && req.method === "POST";
    const room = isJoin ? getOrCreateRoom(roomId) : requireRoom(roomId);

    if (isJoin) {
      const body = await readJson(req);
      send(res, 200, join(roomId, room, body.playerId, body.preferredSide));
      return;
    }

    if (command === "move" && req.method === "POST") {
      const body = await readJson(req);
      send(res, 200, move(roomId, room, body));
      return;
    }

    if (command === "action" && req.method === "POST") {
      const body = await readJson(req);
      send(res, 200, action(roomId, room, body));
      return;
    }

    if (command === "leave" && req.method === "POST") {
      const body = await readJson(req);
      send(res, 200, leave(roomId, room, body.playerId));
      return;
    }

    if (command === "state" && req.method === "GET") {
      const playerId = url.searchParams.get("playerId");
      const sinceRevision = parseRevision(url.searchParams.get("since"));
      const waitMs = parseWaitMs(url.searchParams.get("wait"));
      const fromMove = parseMoveOffset(url.searchParams.get("fromMove"));
      let knownSide = null;
      if (sinceRevision != null && waitMs > 0) {
        knownSide = ensureRoomPlayer(room, playerId);
        if (room.revision <= sinceRevision) {
          await waitForRoomChange(res, room, sinceRevision, waitMs);
          if (res.destroyed) return;
        }
      }
      send(res, 200, snapshot(roomId, room, playerId, knownSide, fromMove));
      return;
    }

    sendError(res, "接口不存在", 404);
  } catch (err) {
    if (err instanceof ApiError) {
      sendError(res, err.message, err.status, err.code, err.details);
    } else {
      console.error(err);
      sendError(res, "请求失败", 500, "INTERNAL_ERROR");
    }
  }
});

server.listen(PORT, () => {
  console.log(`Chinese chess online server listening on ${PORT}`);
});

setInterval(
  cleanupRooms,
  Math.min(ROOM_TTL_MS, PLAYER_TIMEOUT_MS, PENDING_ACTION_TTL_MS, 60_000),
).unref();

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) {
      throw new ApiError("ROOM_LIMIT_REACHED", "服务器房间数量已达上限", 503);
    }
    room = createRoom();
    rooms.set(roomId, room);
  }
  maintainRoom(room);
  return room;
}

function requireRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    throw new ApiError("ROOM_NOT_FOUND", "房间不存在", 404);
  }
  maintainRoom(room);
  return room;
}

function createRoom() {
  const board = createInitialBoard();
  return {
    players: { RED: null, BLACK: null },
    moves: [],
    board,
    positionCounts: new Map([[positionKey(board, "RED"), 1]]),
    requestIds: new Map(),
    requestOrder: [],
    pendingAction: null,
    status: "PLAYING",
    revision: 0,
    waiters: [],
    updatedAt: Date.now(),
  };
}

function join(roomId, room, requestedPlayerId, preferredSide) {
  pruneStalePlayers(room);
  if (playerCount(room) === 0) {
    resetRoomState(room, false);
  }

  let side = findPlayerSide(room, requestedPlayerId);
  let playerId = requestedPlayerId;
  const requestedSide = normalizeSide(preferredSide);

  if (!side) {
    playerId = randomUUID();
    if (requestedSide) {
      if (room.players[requestedSide]) {
        throw new ApiError("SIDE_OCCUPIED", "所选方已被占用", 409);
      }
      setPlayer(room, requestedSide, playerId);
      side = requestedSide;
    } else if (!room.players.RED) {
      setPlayer(room, "RED", playerId);
      side = "RED";
    } else if (!room.players.BLACK) {
      setPlayer(room, "BLACK", playerId);
      side = "BLACK";
    } else {
      throw new ApiError("ROOM_FULL", "房间已满", 409);
    }
    bumpRoom(room);
  } else {
    touchPlayer(room, playerId);
  }

  return snapshot(roomId, room, playerId, side);
}

function move(roomId, room, body) {
  const { playerId, move: moveData, requestId, expectedRevision } = body;
  const side = requirePlayerSide(room, playerId);
  touchPlayer(room, playerId);
  const requestKey = prepareMutation(room, playerId, requestId, expectedRevision);
  if (room.requestIds.has(requestKey)) {
    return snapshot(roomId, room, playerId, side, body.knownMoveCount);
  }
  if (room.status !== "PLAYING") {
    throw new ApiError("GAME_FINISHED", "棋局已结束", 409);
  }
  if (playerCount(room) < 2) {
    throw new ApiError("WAITING_FOR_OPPONENT", "等待对手加入", 409);
  }
  if (side !== turnSide(room.moves.length)) {
    throw new ApiError("NOT_YOUR_TURN", "还未轮到你行棋", 409);
  }
  if (room.pendingAction) {
    throw new ApiError("ACTION_PENDING", "请先处理待确认请求", 409);
  }
  if (!validMoveShape(moveData)) {
    throw new ApiError("INVALID_MOVE", "走法数据无效", 422);
  }

  const applied = applyLegalMove(room.board, side, moveData);
  if (!applied.ok) {
    throw new ApiError("INVALID_MOVE", applied.error, 422);
  }
  room.moves.push({
    fromRow: moveData.fromRow,
    fromCol: moveData.fromCol,
    toRow: moveData.toRow,
    toCol: moveData.toCol,
  });
  const nextSide = oppositeSide(side);
  const key = positionKey(room.board, nextSide);
  const repetitionCount = (room.positionCounts.get(key) || 0) + 1;
  room.positionCounts.set(key, repetitionCount);
  room.status = evaluateStatus(
    room.board,
    nextSide,
    side,
    repetitionCount,
    room.moves.length >= MAX_MOVES_PER_GAME,
  );
  bumpRoom(room);
  rememberRequest(room, requestKey);
  return snapshot(roomId, room, playerId, side, body.knownMoveCount);
}

function action(roomId, room, body) {
  const { playerId, action: actionName, requestId, expectedRevision } = body;
  const side = requirePlayerSide(room, playerId);
  touchPlayer(room, playerId);
  const requestKey = prepareMutation(room, playerId, requestId, expectedRevision);
  if (room.requestIds.has(requestKey)) {
    return snapshot(roomId, room, playerId, side, body.knownMoveCount);
  }

  if (["undo", "draw"].includes(actionName)) {
    requestAction(room, side, actionName);
  } else if (actionName === "resign") {
    resign(room, side);
  } else if (actionName === "reset") {
    reset(room);
  } else if (actionName === "accept") {
    acceptAction(room, side);
  } else if (actionName === "reject") {
    rejectAction(room, side);
  } else {
    throw new ApiError("INVALID_ACTION", "动作无效", 422);
  }

  bumpRoom(room);
  rememberRequest(room, requestKey);
  return snapshot(roomId, room, playerId, side, body.knownMoveCount);
}

function resign(room, side) {
  if (playerCount(room) < 2) {
    throw new ApiError("WAITING_FOR_OPPONENT", "等待对手加入", 409);
  }
  if (room.status !== "PLAYING") {
    throw new ApiError("GAME_FINISHED", "棋局已结束", 409);
  }
  room.status = side === "RED" ? "BLACK_WIN" : "RED_WIN";
  room.pendingAction = null;
}

function reset(room) {
  if (playerCount(room) < 2) {
    throw new ApiError("WAITING_FOR_OPPONENT", "等待对手加入", 409);
  }
  resetRoomState(room, false);
}

function leave(roomId, room, playerId) {
  const side = findPlayerSide(room, playerId);
  if (side) {
    room.players[side] = null;
    if (room.pendingAction?.requester === side || room.pendingAction?.target === side) {
      room.pendingAction = null;
    }
    bumpRoom(room);
  }
  if (playerCount(room) === 0) {
    rooms.delete(roomId);
  }
  return { ok: true };
}

function snapshot(roomId, room, playerId, knownSide, fromMove = 0) {
  const side = knownSide || ensureRoomPlayer(room, playerId);
  const moveOffset = Number.isSafeInteger(fromMove) && fromMove >= 0 && fromMove <= room.moves.length
    ? fromMove
    : 0;

  return {
    roomId,
    playerId,
    side,
    status: room.status,
    moves: room.moves.slice(moveOffset),
    moveOffset,
    totalMoves: room.moves.length,
    pendingAction: room.pendingAction,
    playerCount: playerCount(room),
    revision: room.revision,
    message: snapshotMessage(room, side),
  };
}

function requestAction(room, side, type) {
  if (playerCount(room) < 2) {
    throw new ApiError("WAITING_FOR_OPPONENT", "等待对手加入", 409);
  }
  if (room.status !== "PLAYING") {
    throw new ApiError("GAME_FINISHED", "棋局已结束", 409);
  }
  if (room.pendingAction) {
    throw new ApiError("ACTION_PENDING", "已有待处理请求", 409);
  }
  if (type === "undo") {
    if (room.moves.length === 0) {
      throw new ApiError("NO_MOVE_TO_UNDO", "没有可悔棋步", 409);
    }
    if (lastMoveSide(room.moves.length) !== side) {
      throw new ApiError("UNDO_NOT_ALLOWED", "只能请求撤回自己的上一步", 409);
    }
  }

  room.pendingAction = {
    type,
    requester: side,
    target: oppositeSide(side),
    createdAt: Date.now(),
  };
}

function acceptAction(room, side) {
  const pending = room.pendingAction;
  if (!pending) {
    throw new ApiError("NO_PENDING_ACTION", "没有待处理请求", 409);
  }
  if (pending.target !== side) {
    throw new ApiError("ACTION_NOT_ALLOWED", "只能由对方处理请求", 403);
  }

  if (pending.type === "undo") {
    room.moves.pop();
    rebuildRoomGame(room);
  } else if (pending.type === "draw") {
    room.status = "DRAW";
  }
  room.pendingAction = null;
}

function rejectAction(room, side) {
  const pending = room.pendingAction;
  if (!pending) {
    throw new ApiError("NO_PENDING_ACTION", "没有待处理请求", 409);
  }
  if (pending.target !== side && pending.requester !== side) {
    throw new ApiError("ACTION_NOT_ALLOWED", "只能由房间玩家处理请求", 403);
  }
  room.pendingAction = null;
}

function resetRoomState(room, notify = true) {
  const board = createInitialBoard();
  room.moves = [];
  room.board = board;
  room.positionCounts = new Map([[positionKey(board, "RED"), 1]]);
  room.pendingAction = null;
  room.status = "PLAYING";
  if (notify) {
    bumpRoom(room);
  } else {
    room.updatedAt = Date.now();
  }
}

function rebuildRoomGame(room) {
  const board = createInitialBoard();
  const counts = new Map([[positionKey(board, "RED"), 1]]);
  let status = "PLAYING";

  room.moves.forEach((storedMove, index) => {
    if (status !== "PLAYING") {
      throw new ApiError("CORRUPT_ROOM_STATE", "房间棋局状态损坏", 500);
    }
    const side = turnSide(index);
    const applied = applyLegalMove(board, side, storedMove);
    if (!applied.ok) {
      throw new ApiError("CORRUPT_ROOM_STATE", "房间走法历史损坏", 500);
    }
    const nextSide = oppositeSide(side);
    const key = positionKey(board, nextSide);
    const repetitionCount = (counts.get(key) || 0) + 1;
    counts.set(key, repetitionCount);
    status = evaluateStatus(
      board,
      nextSide,
      side,
      repetitionCount,
      index + 1 >= MAX_MOVES_PER_GAME,
    );
  });

  room.board = board;
  room.positionCounts = counts;
  room.status = status;
}

function snapshotMessage(room, side) {
  if (playerCount(room) < 2) {
    return "等待对手加入";
  }
  if (!room.pendingAction) {
    return "已连接";
  }
  const label = actionLabel(room.pendingAction.type);
  return room.pendingAction.target === side
    ? `对方请求${label}`
    : `等待对方处理${label}请求`;
}

function actionLabel(type) {
  if (type === "undo") return "悔棋";
  if (type === "draw") return "求和";
  return "操作";
}

function normalizeRoomId(roomId) {
  const value = roomId.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,24}$/.test(value) ? value : "";
}

function normalizeSide(side) {
  const value = String(side || "").trim().toUpperCase();
  return value === "RED" || value === "BLACK" ? value : null;
}

function findPlayerSide(room, playerId) {
  if (!playerId) return null;
  if (getPlayerId(room.players.RED) === playerId) return "RED";
  if (getPlayerId(room.players.BLACK) === playerId) return "BLACK";
  return null;
}

function setPlayer(room, side, playerId) {
  room.players[side] = {
    id: playerId,
    lastSeen: Date.now(),
  };
}

function touchPlayer(room, playerId) {
  const side = findPlayerSide(room, playerId);
  if (!side) return;
  const player = room.players[side];
  if (typeof player === "string") {
    setPlayer(room, side, player);
  } else if (player) {
    player.lastSeen = Date.now();
  }
  room.updatedAt = Date.now();
}

function maintainRoom(room) {
  pruneStalePlayers(room);
  expirePendingAction(room);
}

function pruneStalePlayers(room) {
  const now = Date.now();
  let changed = false;
  for (const side of ["RED", "BLACK"]) {
    const player = room.players[side];
    if (!player) continue;
    const lastSeen = typeof player === "string" ? room.updatedAt : player.lastSeen;
    if (now - lastSeen > PLAYER_TIMEOUT_MS) {
      room.players[side] = null;
      if (room.pendingAction?.requester === side || room.pendingAction?.target === side) {
        room.pendingAction = null;
      }
      changed = true;
    }
  }
  if (changed) {
    bumpRoom(room);
  }
}

function expirePendingAction(room, now = Date.now()) {
  if (!room.pendingAction || now - room.pendingAction.createdAt <= PENDING_ACTION_TTL_MS) return false;
  room.pendingAction = null;
  bumpRoom(room);
  return true;
}

function getPlayerId(player) {
  if (!player) return null;
  return typeof player === "string" ? player : player.id;
}

function turnSide(moveCount) {
  return moveCount % 2 === 0 ? "RED" : "BLACK";
}

function lastMoveSide(moveCount) {
  return moveCount % 2 === 1 ? "RED" : "BLACK";
}

function oppositeSide(side) {
  return side === "RED" ? "BLACK" : "RED";
}

function playerCount(room) {
  return Number(Boolean(getPlayerId(room.players.RED))) + Number(Boolean(getPlayerId(room.players.BLACK)));
}

function ensureRoomPlayer(room, playerId) {
  const side = requirePlayerSide(room, playerId);
  touchPlayer(room, playerId);
  return side;
}

function requirePlayerSide(room, playerId) {
  const side = findPlayerSide(room, playerId);
  if (!side) {
    throw new ApiError("SESSION_EXPIRED", "玩家会话已失效", 410);
  }
  return side;
}

function prepareMutation(room, playerId, requestId, expectedRevision) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw new ApiError("INVALID_REQUEST_ID", "请求标识无效", 400);
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ApiError("INVALID_REVISION", "状态版本无效", 400);
  }
  const requestKey = `${playerId}:${requestId}`;
  if (!room.requestIds.has(requestKey) && expectedRevision !== room.revision) {
    throw new ApiError(
      "REVISION_CONFLICT",
      "棋局状态已更新，请同步后重试",
      409,
      { currentRevision: room.revision },
    );
  }
  return requestKey;
}

function rememberRequest(room, requestKey) {
  room.requestIds.set(requestKey, Date.now());
  room.requestOrder.push(requestKey);
  while (room.requestOrder.length > MAX_REQUEST_IDS_PER_ROOM) {
    const oldest = room.requestOrder.shift();
    if (oldest) room.requestIds.delete(oldest);
  }
}

function bumpRoom(room) {
  room.revision += 1;
  room.updatedAt = Date.now();
  notifyWaiters(room);
}

function waitForRoomChange(res, room, sinceRevision, waitMs) {
  if (room.revision > sinceRevision || waitMs <= 0) {
    return Promise.resolve();
  }
  if (room.waiters.length >= MAX_WAITERS_PER_ROOM) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const waiter = { sinceRevision, finish: null };
    let finished = false;
    const timer = setTimeout(finish, waitMs);

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      res.off("close", finish);
      const index = room.waiters.indexOf(waiter);
      if (index >= 0) {
        room.waiters.splice(index, 1);
      }
      resolve();
    }

    waiter.finish = finish;
    res.on("close", finish);
    room.waiters.push(waiter);
  });
}

function notifyWaiters(room) {
  if (!room.waiters.length) return;
  const pending = [];
  const ready = [];
  for (const waiter of room.waiters) {
    if (room.revision > waiter.sinceRevision) {
      ready.push(waiter);
    } else {
      pending.push(waiter);
    }
  }
  room.waiters = pending;
  for (const waiter of ready) {
    waiter.finish();
  }
}

function parseRevision(value) {
  if (value == null || value === "") return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function parseWaitMs(value) {
  const wait = Number(value || 0);
  if (!Number.isFinite(wait) || wait <= 0) return 0;
  return Math.min(wait, MAX_STATE_WAIT_MS);
}

function parseMoveOffset(value) {
  if (value == null || value === "") return 0;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function cleanupRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    maintainRoom(room);
    if (playerCount(room) === 0 && now - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > 8192) {
        fail(new ApiError("BODY_TOO_LARGE", "请求体过大", 413));
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new ApiError("INVALID_JSON", "JSON 无效", 400));
      }
    });
    req.on("error", fail);
  });
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body == null ? "" : JSON.stringify(body));
}

function sendError(res, message, status, code = "REQUEST_ERROR", details = undefined) {
  send(res, status, { error: message, code, details });
}

function envInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

class ApiError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
