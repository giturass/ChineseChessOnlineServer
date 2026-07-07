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

## License

MIT
