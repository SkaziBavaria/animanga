# Ani Web

Lokalt webbgui for `ani-cli` i Termux. Appen kor en liten Node-server pa telefonen och kan installeras som PWA fran Chrome/Android.

## Start

```sh
cd ~/ani-web
npm start
```

Oppna sedan:

```text
http://127.0.0.1:7831
```

Chrome: menyknappen -> `Lagg till pa startskarmen`.

## Vad som sparas

- `~/ani-web/data/state.json`: foljda serier, sedda episoder, installningar och senaste jobb.
- `~/.local/state/ani-cli/ani-hsts`: `ani-cli`-historiken. Ani Web uppdaterar den nar du startar eller markerar ett avsnitt.

## Installningar

- `ANI_WEB_PORT=7832 npm start` byter port.
- `ANI_WEB_HOST=0.0.0.0 npm start` gor servern natverksatkomlig. Anvand bara pa ett nat du litar pa.
- `ANI_CLI_BIN=/path/till/ani-cli npm start` anvander en annan `ani-cli`.
