import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLegalMove,
  createInitialBoard,
  evaluateStatus,
  positionKey,
} from "../src/xiangqi.js";

test("accepts a legal opening pawn move", () => {
  const board = createInitialBoard();
  const result = applyLegalMove(board, "RED", {
    fromRow: 6,
    fromCol: 0,
    toRow: 5,
    toCol: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(board.some((piece) => piece.side === "RED" && piece.type === "PAWN" && piece.row === 5 && piece.col === 0), true);
});

test("rejects moving the opponent piece and illegal pawn movement", () => {
  const board = createInitialBoard();

  assert.equal(applyLegalMove(board, "RED", {
    fromRow: 3,
    fromCol: 0,
    toRow: 4,
    toCol: 0,
  }).ok, false);
  assert.equal(applyLegalMove(board, "RED", {
    fromRow: 6,
    fromCol: 0,
    toRow: 7,
    toCol: 0,
  }).ok, false);
});

test("rejects a move that exposes the flying generals", () => {
  const board = [
    { side: "RED", type: "KING", row: 9, col: 4 },
    { side: "BLACK", type: "KING", row: 0, col: 4 },
    { side: "RED", type: "ROOK", row: 5, col: 4 },
  ];

  const result = applyLegalMove(board, "RED", {
    fromRow: 5,
    fromCol: 4,
    toRow: 5,
    toCol: 3,
  });
  assert.equal(result.ok, false);
});

test("detects a king capture as a win", () => {
  const board = [
    { side: "RED", type: "KING", row: 9, col: 4 },
    { side: "BLACK", type: "KING", row: 0, col: 4 },
    { side: "RED", type: "ROOK", row: 1, col: 4 },
  ];

  const result = applyLegalMove(board, "RED", {
    fromRow: 1,
    fromCol: 4,
    toRow: 0,
    toCol: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(evaluateStatus(board, "BLACK", "RED", 1), "RED_WIN");
});

test("position keys are stable for equivalent boards", () => {
  const board = createInitialBoard();
  assert.equal(positionKey(board, "RED"), positionKey([...board].reverse(), "RED"));
});

test("declares a draw when the configured move limit is reached", () => {
  const board = createInitialBoard();
  assert.equal(evaluateStatus(board, "RED", "BLACK", 1, true), "DRAW");
});
