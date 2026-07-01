# Ani Web

Lokalt webbgui for `ani-cli` i Termux. Appen kor en liten Node-server pa telefonen och kan installeras som PWA fran Chrome/Android.

Pa PC kan du kora samma app i Docker med inbyggd webblasarspelare.

## Start (Termux)

```sh
cd ~/ani-web
npm start
```

Oppna sedan:

```text
http://127.0.0.1:7831
```

Chrome: menyknappen -> `Lagg till pa startskarmen`.

## Start (Docker / PC)

Kräver Docker. I WSL eller Linux:

```sh
cd ani-web
docker compose up --build
```

Oppna i webblasaren:

```text
http://localhost:7831
```

Uppspelning sker i webblasaren via ani-cli debug-lage och en stream-proxy.

All data sparas i mappen `data/` bredvid `docker-compose.yml` (bind-mount till `/data` i containern). Den overlever `docker compose up`, `down` och ombyggen. Vill du borja om helt: stoppa och radera mappen `data/`.

## Projektstruktur

```text
server.js          Startpunkt (HTTP-server)
lib/               Servermoduler (API, nedladdningar, proxy, m.m.)
public/
  index.html       PWA-skal
  styles.css       UI
  sw.js            Service worker
  js/
    app.js         Frontend-startpunkt
    state.js       Delad app-state
    dom.js         DOM-referenser
    api.js         fetch, toast, withBusy
    util.js        Hjälpfunktioner (episoder, HTML)
    status.js      Serverstatus, uppspelningsläge
    playback.js    Webbläsare + MPV-uppspelning
    download-helpers.js  Nedladdningsstatus
    downloads.js   Nedladdningskö och UI
    shows.js       Show-kort och relaterade serier
    library.js     Bibliotek, track/remove
    discover.js    Sök, popular, rekommendationer
    episodes.js    Avsnittsdialog
    details.js     Om-serie-dialog
    jobs.js        Jobbloggar
    release-watches.js  Release-bevakning
    events.js      Event listeners
```

## Vad som sparas (persistent)

I Docker ligger allt under `data/` i projektet:

```text
data/
  app/
    state.json     Foljda serier, sedda avsnitt, installningar,
                   watch-list, nedladdningsposter, tittarpositioner
    job-logs/      Loggar for nedladdnings-/kommandojobb
  ani-cli/
    ani-hsts       ani-cli-historiken
  downloads/       Nedladdade avsnitt (.mp4)
```

Allt detta overlever `docker compose up/down` och `--build`. Ingenting behover konfigureras extra.

I Termux (utan Docker) sparas state i `data/state.json` i projektet och historiken i `~/.local/state/ani-cli/ani-hsts`.

## Installningar

- `ANI_WEB_PORT=7832 npm start` byter port.
- `ANI_WEB_HOST=0.0.0.0 npm start` gor servern natverksatkomlig. Anvand bara pa ett nat du litar pa.
- `ANI_CLI_BIN=/path/till/ani-cli npm start` anvander en annan `ani-cli`.
- `ANI_WEB_CLIENT_PLAYBACK=1` tvingar webblasarspelare (satt automatiskt i Docker).
- `ANI_CLI_DOWNLOAD_DIR=/path/till/nedladdningar` styr var avsnitt sparas.
