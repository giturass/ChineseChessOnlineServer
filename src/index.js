import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const rooms = new Map();

const EMPTY_STATE = {
  players: { RED: null, BLACK: null },
  moves: [],
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
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|move|action))?$/);
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

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      ...EMPTY_STATE,
      players: { ...EMPTY_STATE.players },
      moves: [],
      updatedAt: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function join(roomId, room, requestedPlayerId) {
  let side = findPlayerSide(room, requestedPlayerId);
  let playerId = requestedPlayerId;

  if (!side) {
    playerId = randomUUID();
    if (!room.players.RED) {
      room.players.RED = playerId;
      side = "RED";
    } else if (!room.players.BLACK) {
      room.players.BLACK = playerId;
      side = "BLACK";
    } else {
      throw new Error("房间已满");
    }
    room.updatedAt = Date.now();
  }

  return snapshot(roomId, room, playerId, side);
}

function move(roomId, room, playerId, moveData) {
  const side = findPlayerSide(room, playerId);
  if (!side) {
    throw new Error("玩家不在房间中");
  }
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
  room.updatedAt = Date.now();
  return snapshot(roomId, room, playerId, side, "已同步");
}

function action(roomId, room, playerId, actionName) {
  const side = findPlayerSide(room, playerId);
  if (!side) {
    throw new Error("玩家不在房间中");
  }

  if (actionName === "resign") {
    room.status = side === "RED" ? "BLACK_WIN" : "RED_WIN";
  } else if (actionName === "draw") {
    room.status = "DRAW";
  } else if (actionName === "reset") {
    room.moves = [];
    room.status = "PLAYING";
  } else {
    throw new Error("动作无效");
  }

  room.updatedAt = Date.now();
  return snapshot(roomId, room, playerId, side, "已同步");
}

function snapshot(roomId, room, playerId, knownSide) {
  const side = knownSide || findPlayerSide(room, playerId);
  if (!side) {
    throw new Error("玩家不在房间中");
  }

  return {
    roomId,
    playerId,
    side,
    status: room.status,
    moves: room.moves,
    playerCount: playerCount(room),
    message: playerCount(room) < 2 ? "等待对手加入" : "已连接",
  };
}

function normalizeRoomId(roomId) {
  const value = roomId.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,24}$/.test(value) ? value : "";
}

function findPlayerSide(room, playerId) {
  if (!playerId) return null;
  if (room.players.RED === playerId) return "RED";
  if (room.players.BLACK === playerId) return "BLACK";
  return null;
}

function turnSide(moveCount) {
  return moveCount % 2 === 0 ? "RED" : "BLACK";
}

function playerCount(room) {
  return Number(Boolean(room.players.RED)) + Number(Boolean(room.players.BLACK));
}

function validMoveShape(moveData) {
  const values = [moveData?.fromRow, moveData?.fromCol, moveData?.toRow, moveData?.toCol];
  return values.every(Number.isInteger) &&
    moveData.fromRow >= 0 && moveData.fromRow <= 9 &&
    moveData.toRow >= 0 && moveData.toRow <= 9 &&
    moveData.fromCol >= 0 && moveData.fromCol <= 8 &&
    moveData.toCol >= 0 && moveData.toCol <= 8;
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
