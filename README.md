# Chinese Chess Online Server

Standalone container-friendly online room service for the Android app. It can run on Render, Fly.io, Railway, or any platform that exposes a web container.

## Run Locally

```sh
npm start
```

The server listens on `PORT`, defaulting to `10000`.

## Deploy On Render

1. Create a new Web Service.
2. Point Render at this `ChineseChessOnlineServer` project.
3. Use the included `render.yaml`, Docker deployment, or use:
   - Build command: empty
   - Start command: `npm start`
4. Open the Android app, choose `双人对战 -> 联机对战`, then enter the Render service URL.

Rooms are kept in process memory. For one Render instance this is enough for lightweight play, but rooms reset when the service restarts.

## API

- `POST /api/rooms/{roomId}/join`
- `GET /api/rooms/{roomId}?playerId={playerId}`
- `POST /api/rooms/{roomId}/move`
- `POST /api/rooms/{roomId}/action`

The online control bar now exposes `undo`, a disabled client-side hint button, and `new_game`. `undo` creates a request that the opponent accepts or rejects. `new_game` starts a fresh game immediately after the initiating player confirms it locally. The legacy `reset` action remains accepted as an alias for compatibility with existing Android builds. `draw` and `resign` are no longer accepted.

Move and action requests include a unique `requestId` and the client's `expectedRevision`. Duplicate requests are idempotent, while stale revisions return `REVISION_CONFLICT`.

State requests may include `fromMove`. Responses contain `moveOffset` and `totalMoves`, allowing clients to apply only new moves instead of downloading the full history every poll.

The server validates piece movement, flying generals, self-check, checkmate, stalemate, repeated positions, turn order, and the configured maximum game length.

Important error codes include `ROOM_NOT_FOUND`, `SESSION_EXPIRED`, `REVISION_CONFLICT`, `INVALID_MOVE`, and `ACTION_PENDING`.

## License

MIT
