import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const PLAYER_TIMEOUT_MS = Number(process.env.PLAYER_TIMEOUT_MS || 90_000);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 30 * 60_000);
const rooms = new Map();

const EMPTY_STATE = {
  players: { RED: null, BLACK: null },
  moves: [],
  pendingAction: null,
  status: "PLAYING",
  updatedAt: 0,
};

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
      send(res, 200, { ok: true, service: "ChineseChessOnline" });
      return;
    }

    const roomId = normalizeRoomId(decodeURIComponent(match[1]));
    if (!roomId) {
      sendError(res, "房间号无效", 400);
      return;
    }

    const command = match[2] || "state";
    const room = getRoom(roomId);

    if (command === "join" && req.method === "POST") {
      const body = await readJson(req);
      send(res, 200, join(roomId, room, body.playerId));
      return;
    }

    if (command === "move" && req.method === "POST") {
      const body = await readJson(req);
      send(res, 200, move(roomId, room, body.playerId, body.move));
      return;
    }

    if (command === "action" && req.method === "POST") {
      const body = await readJson(req);
      send(res, 200, action(roomId, room, body.playerId, body.action));
      return;
    }

    if (command === "leave" && req.method === "POST") {
      const body = await readJson(req);
      send(res, 200, leave(roomId, room, body.playerId));
      return;
    }

    if (command === "state" && req.method === "GET") {
      send(res, 200, snapshot(roomId, room, url.searchParams.get("playerId")));
      return;
    }

    sendError(res, "接口不存在", 404);
  } catch (err) {
    sendError(res, err.message || "请求失败", 400);
  }
});

server.listen(PORT, () => {
  console.log(`Chinese chess online server listening on ${PORT}`);
});

setInterval(cleanupRooms, Math.min(ROOM_TTL_MS, 60_000)).unref();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      ...EMPTY_STATE,
      players: { ...EMPTY_STATE.players },
      moves: [],
      updatedAt: Date.now(),
    });
  }
  const room = rooms.get(roomId);
  pruneStalePlayers(room);
  return room;
}

function join(roomId, room, requestedPlayerId) {
  pruneStalePlayers(room);
  if (playerCount(room) === 0) {
    resetRoomState(room);
  }

  let side = findPlayerSide(room, requestedPlayerId);
  let playerId = requestedPlayerId;

  if (!side) {
    playerId = randomUUID();
    if (!room.players.RED) {
      setPlayer(room, "RED", playerId);
      side = "RED";
    } else if (!room.players.BLACK) {
      setPlayer(room, "BLACK", playerId);
      side = "BLACK";
    } else {
      throw new Error("房间已满");
    }
    room.updatedAt = Date.now();
  } else {
    touchPlayer(room, playerId);
  }

  return snapshot(roomId, room, playerId, side);
}

function move(roomId, room, playerId, moveData) {
  pruneStalePlayers(room, playerId);
  const side = findPlayerSide(room, playerId);
  if (!side) {
    throw new Error("玩家不在房间中");
  }
  touchPlayer(room, playerId);
  if (room.status !== "PLAYING") {
    throw new Error("棋局已结束");
  }
  if (playerCount(room) < 2) {
    throw new Error("等待对手加入");
  }
  if (side !== turnSide(room.moves.length)) {
    throw new Error("还未轮到你行棋");
  }
  if (!validMoveShape(moveData)) {
    throw new Error("走法数据无效");
  }

  room.moves.push({
    fromRow: moveData.fromRow,
    fromCol: moveData.fromCol,
    toRow: moveData.toRow,
    toCol: moveData.toCol,
  });
  room.pendingAction = null;
  room.updatedAt = Date.now();
  return snapshot(roomId, room, playerId, side, "已同步");
}

function action(roomId, room, playerId, actionName) {
  pruneStalePlayers(room, playerId);
  const side = findPlayerSide(room, playerId);
  if (!side) {
    throw new Error("玩家不在房间中");
  }
  touchPlayer(room, playerId);

  if (["undo", "draw", "resign", "reset"].includes(actionName)) {
    requestAction(room, side, actionName);
  } else if (actionName === "accept") {
    acceptAction(room, side);
  } else if (actionName === "reject") {
    rejectAction(room, side);
  } else {
    throw new Error("动作无效");
  }

  room.updatedAt = Date.now();
  return snapshot(roomId, room, playerId, side);
}

function leave(roomId, room, playerId) {
  const side = findPlayerSide(room, playerId);
  if (side) {
    room.players[side] = null;
    if (room.pendingAction?.requester === side || room.pendingAction?.target === side) {
      room.pendingAction = null;
    }
    room.updatedAt = Date.now();
  }
  if (playerCount(room) === 0) {
    rooms.delete(roomId);
  }
  return { ok: true };
}

function snapshot(roomId, room, playerId, knownSide) {
  pruneStalePlayers(room, playerId);
  const side = knownSide || findPlayerSide(room, playerId);
  if (!side) {
    throw new Error("玩家不在房间中");
  }
  touchPlayer(room, playerId);

  return {
    roomId,
    playerId,
    side,
    status: room.status,
    moves: room.moves,
    pendingAction: room.pendingAction,
    playerCount: playerCount(room),
    message: snapshotMessage(room, side),
  };
}

function requestAction(room, side, type) {
  if (playerCount(room) < 2) {
    throw new Error("等待对手加入");
  }
  if (type !== "reset" && room.status !== "PLAYING") {
    throw new Error("棋局已结束");
  }
  if (type === "undo") {
    if (room.moves.length === 0) {
      throw new Error("没有可悔棋步");
    }
    if (lastMoveSide(room.moves.length) !== side) {
      throw new Error("只能请求撤回自己的上一步");
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
    throw new Error("没有待处理请求");
  }
  if (pending.target !== side) {
    throw new Error("只能由对方处理请求");
  }

  if (pending.type === "undo") {
    room.moves.pop();
    room.status = "PLAYING";
  } else if (pending.type === "draw") {
    room.status = "DRAW";
  } else if (pending.type === "resign") {
    room.status = pending.requester === "RED" ? "BLACK_WIN" : "RED_WIN";
  } else if (pending.type === "reset") {
    room.moves = [];
    room.status = "PLAYING";
  }
  room.pendingAction = null;
}

function rejectAction(room, side) {
  const pending = room.pendingAction;
  if (!pending) {
    throw new Error("没有待处理请求");
  }
  if (pending.target !== side && pending.requester !== side) {
    throw new Error("只能由房间玩家处理请求");
  }
  room.pendingAction = null;
}

function resetRoomState(room) {
  room.moves = [];
  room.pendingAction = null;
  room.status = "PLAYING";
  room.updatedAt = Date.now();
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
  if (type === "resign") return "认输";
  if (type === "reset") return "重置";
  return "操作";
}

function normalizeRoomId(roomId) {
  const value = roomId.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,24}$/.test(value) ? value : "";
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

function pruneStalePlayers(room, activePlayerId = null) {
  const now = Date.now();
  for (const side of ["RED", "BLACK"]) {
    const player = room.players[side];
    if (!player || getPlayerId(player) === activePlayerId) continue;
    const lastSeen = typeof player === "string" ? room.updatedAt : player.lastSeen;
    if (now - lastSeen > PLAYER_TIMEOUT_MS) {
      room.players[side] = null;
      if (room.pendingAction?.requester === side || room.pendingAction?.target === side) {
        room.pendingAction = null;
      }
      room.updatedAt = now;
    }
  }
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

function validMoveShape(moveData) {
  const values = [moveData?.fromRow, moveData?.fromCol, moveData?.toRow, moveData?.toCol];
  return values.every(Number.isInteger) &&
    moveData.fromRow >= 0 && moveData.fromRow <= 9 &&
    moveData.toRow >= 0 && moveData.toRow <= 9 &&
    moveData.fromCol >= 0 && moveData.fromCol <= 8 &&
    moveData.toCol >= 0 && moveData.toCol <= 8;
}

function cleanupRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    pruneStalePlayers(room);
    if (playerCount(room) === 0 && now - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) {
        req.destroy();
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 无效"));
      }
    });
    req.on("error", reject);
  });
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(body == null ? "" : JSON.stringify(body));
}

function sendError(res, message, status) {
  send(res, status, { error: message });
}
