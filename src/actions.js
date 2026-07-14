const ACTION_ALIASES = new Map([
  ["undo", "undo"],
  ["new_game", "new_game"],
  ["reset", "new_game"],
  ["accept", "accept"],
  ["reject", "reject"],
]);

export function normalizeActionName(value) {
  return typeof value === "string" ? ACTION_ALIASES.get(value) || null : null;
}
