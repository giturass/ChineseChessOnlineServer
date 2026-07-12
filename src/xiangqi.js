const SIDES = ["RED", "BLACK"];

export function createInitialBoard() {
  const pieces = [];
  addBackRank(pieces, "RED", 9);
  pieces.push(piece("RED", "CANNON", 7, 1), piece("RED", "CANNON", 7, 7));
  for (const col of [0, 2, 4, 6, 8]) pieces.push(piece("RED", "PAWN", 6, col));

  addBackRank(pieces, "BLACK", 0);
  pieces.push(piece("BLACK", "CANNON", 2, 1), piece("BLACK", "CANNON", 2, 7));
  for (const col of [0, 2, 4, 6, 8]) pieces.push(piece("BLACK", "PAWN", 3, col));
  return pieces;
}

export function validMoveShape(move) {
  const values = [move?.fromRow, move?.fromCol, move?.toRow, move?.toCol];
  return values.every(Number.isInteger) &&
    onBoard(move.fromRow, move.fromCol) &&
    onBoard(move.toRow, move.toCol) &&
    (move.fromRow !== move.toRow || move.fromCol !== move.toCol);
}

export function applyLegalMove(board, side, move) {
  if (!SIDES.includes(side) || !validMoveShape(move)) {
    return { ok: false, error: "走法数据无效" };
  }
  const moving = pieceAt(board, move.fromRow, move.fromCol);
  if (!moving || moving.side !== side) {
    return { ok: false, error: "起点没有己方棋子" };
  }
  if (!isLegalMove(board, moving, move)) {
    return { ok: false, error: "该走法不符合象棋规则" };
  }
  const result = makeMove(board, move);
  return { ok: true, captured: result.captured, movingPiece: result.movingPiece };
}

export function evaluateStatus(
  board,
  nextSide,
  movingSide,
  repetitionCount,
  maxMovesReached = false,
) {
  const nextInCheck = isInCheck(board, nextSide);
  if (repetitionCount >= 3 && nextInCheck) return winnerStatus(nextSide);
  if (repetitionCount >= 3) return "DRAW";
  if (!findKing(board, nextSide) || !hasAnyLegalMove(board, nextSide)) {
    return winnerStatus(movingSide);
  }
  if (maxMovesReached) return "DRAW";
  return "PLAYING";
}

export function positionKey(board, sideToMove) {
  const pieces = [...board].sort((a, b) =>
    a.row - b.row || a.col - b.col || a.side.localeCompare(b.side) || a.type.localeCompare(b.type));
  return `${sideToMove}|${pieces.map((item) =>
    `${item.row},${item.col},${item.side},${item.type}`).join(";")}`;
}

export function isInCheck(board, side) {
  const king = findKing(board, side);
  if (!king) return true;
  const opponent = oppositeSide(side);
  return board.some((item) => item.side === opponent && canAttack(board, item, king.row, king.col));
}

function addBackRank(board, side, row) {
  const types = ["ROOK", "KNIGHT", "ELEPHANT", "ADVISOR", "KING", "ADVISOR", "ELEPHANT", "KNIGHT", "ROOK"];
  types.forEach((type, col) => board.push(piece(side, type, row, col)));
}

function piece(side, type, row, col) {
  return { side, type, row, col };
}

function isLegalMove(board, moving, move) {
  const target = pieceAt(board, move.toRow, move.toCol);
  if (target?.side === moving.side || !isPseudoLegalMove(board, moving, move.toRow, move.toCol, target)) {
    return false;
  }

  const applied = makeMove(board, move);
  const leavesKingInCheck = isInCheck(board, moving.side);
  undoMove(board, move, applied);
  return !leavesKingInCheck;
}

function isPseudoLegalMove(board, moving, targetRow, targetCol, target) {
  const dr = targetRow - moving.row;
  const dc = targetCol - moving.col;
  const absDr = Math.abs(dr);
  const absDc = Math.abs(dc);

  if (moving.type === "KING") {
    const flyingKing = target?.type === "KING" && target.side !== moving.side && dc === 0 &&
      countBetweenColumn(board, moving.col, moving.row, targetRow) === 0;
    return flyingKing || (insidePalace(targetRow, targetCol, moving.side) && absDr + absDc === 1);
  }
  if (moving.type === "ADVISOR") {
    return insidePalace(targetRow, targetCol, moving.side) && absDr === 1 && absDc === 1;
  }
  if (moving.type === "ELEPHANT") {
    const validRows = moving.side === "RED" ? targetRow >= 5 : targetRow <= 4;
    return validRows && absDr === 2 && absDc === 2 &&
      !pieceAt(board, moving.row + dr / 2, moving.col + dc / 2);
  }
  if (moving.type === "ROOK") {
    if ((dr === 0) === (dc === 0)) return false;
    return dr === 0
      ? countBetweenRow(board, moving.row, moving.col, targetCol) === 0
      : countBetweenColumn(board, moving.col, moving.row, targetRow) === 0;
  }
  if (moving.type === "KNIGHT") {
    if (!((absDr === 2 && absDc === 1) || (absDr === 1 && absDc === 2))) return false;
    const legRow = absDr === 2 ? moving.row + dr / 2 : moving.row;
    const legCol = absDc === 2 ? moving.col + dc / 2 : moving.col;
    return !pieceAt(board, legRow, legCol);
  }
  if (moving.type === "CANNON") {
    if ((dr === 0) === (dc === 0)) return false;
    const between = dr === 0
      ? countBetweenRow(board, moving.row, moving.col, targetCol)
      : countBetweenColumn(board, moving.col, moving.row, targetRow);
    return target ? between === 1 : between === 0;
  }
  if (moving.type === "PAWN") {
    const forward = moving.side === "RED" ? -1 : 1;
    const crossedRiver = moving.side === "RED" ? moving.row <= 4 : moving.row >= 5;
    return (dr === forward && dc === 0) || (crossedRiver && dr === 0 && absDc === 1);
  }
  return false;
}

function canAttack(board, moving, targetRow, targetCol) {
  const target = pieceAt(board, targetRow, targetCol);
  return isPseudoLegalMove(board, moving, targetRow, targetCol, target);
}

function hasAnyLegalMove(board, side) {
  for (const moving of board.filter((item) => item.side === side)) {
    for (let row = 0; row <= 9; row += 1) {
      for (let col = 0; col <= 8; col += 1) {
        if (isLegalMove(board, moving, {
          fromRow: moving.row,
          fromCol: moving.col,
          toRow: row,
          toCol: col,
        })) return true;
      }
    }
  }
  return false;
}

function makeMove(board, move) {
  let movingIndex = board.findIndex((item) => item.row === move.fromRow && item.col === move.fromCol);
  const movingPiece = board[movingIndex];
  const capturedIndex = board.findIndex((item) => item.row === move.toRow && item.col === move.toCol);
  const captured = capturedIndex >= 0 ? board[capturedIndex] : null;
  if (capturedIndex >= 0) {
    board.splice(capturedIndex, 1);
    if (capturedIndex < movingIndex) movingIndex -= 1;
  }
  board[movingIndex] = { ...movingPiece, row: move.toRow, col: move.toCol };
  return { movingPiece, captured };
}

function undoMove(board, move, applied) {
  const movedIndex = board.findIndex((item) =>
    item.row === move.toRow && item.col === move.toCol && item.side === applied.movingPiece.side);
  board[movedIndex] = applied.movingPiece;
  if (applied.captured) board.push(applied.captured);
}

function findKing(board, side) {
  return board.find((item) => item.side === side && item.type === "KING") || null;
}

function pieceAt(board, row, col) {
  return board.find((item) => item.row === row && item.col === col) || null;
}

function insidePalace(row, col, side) {
  if (col < 3 || col > 5) return false;
  return side === "RED" ? row >= 7 && row <= 9 : row >= 0 && row <= 2;
}

function onBoard(row, col) {
  return row >= 0 && row <= 9 && col >= 0 && col <= 8;
}

function countBetweenRow(board, row, firstCol, secondCol) {
  const min = Math.min(firstCol, secondCol);
  const max = Math.max(firstCol, secondCol);
  let count = 0;
  for (let col = min + 1; col < max; col += 1) {
    if (pieceAt(board, row, col)) count += 1;
  }
  return count;
}

function countBetweenColumn(board, col, firstRow, secondRow) {
  const min = Math.min(firstRow, secondRow);
  const max = Math.max(firstRow, secondRow);
  let count = 0;
  for (let row = min + 1; row < max; row += 1) {
    if (pieceAt(board, row, col)) count += 1;
  }
  return count;
}

function oppositeSide(side) {
  return side === "RED" ? "BLACK" : "RED";
}

function winnerStatus(side) {
  return side === "RED" ? "RED_WIN" : "BLACK_WIN";
}
