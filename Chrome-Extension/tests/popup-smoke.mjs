const port = Number(process.argv[2]);
if (!port) throw new Error("Indiquez le port de débogage Edge.");

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const popup = targets.find((target) => target.url.endsWith("/popup.html"));
if (!popup) throw new Error("Page popup de l'extension introuvable.");

const socket = new WebSocket(popup.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});

function command(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text);
  }
  return response.result.value;
}

await command("Runtime.enable");
await command("Page.enable");
// Au démarrage, Edge peut tenter l'URL avant d'avoir fini de charger
// l'extension non empaquetée. Une seconde navigation évite ce faux blocage.
await command("Page.navigate", { url: popup.url });
await new Promise((resolve) => setTimeout(resolve, 500));

const initial = await evaluate(`({
  heading: document.querySelector('h1')?.textContent,
  status: document.querySelector('#status-message')?.textContent,
  startVisible: !document.querySelector('#start-recording')?.hidden,
  startText: document.querySelector('#start-recording')?.textContent
})`);
if (
  initial.heading !== "Spytify Web" ||
  !initial.startVisible ||
  !initial.startText?.includes("Préparer le morceau")
) {
  throw new Error(`Interface inattendue: ${JSON.stringify(initial)}`);
}

await evaluate(`import(chrome.runtime.getURL('popup.js')).then((module) => {
  module.renderState({
    phase: 'prepared',
    recording: false,
    elapsedSeconds: 0,
    metadata: { title: 'Titre', artist: 'Artiste' },
    message: 'Morceau préparé'
  });
})`);
await new Promise((resolve) => setTimeout(resolve, 100));
const preparedButton = await evaluate("document.querySelector('#start-recording')?.textContent");
if (!preparedButton.includes("Démarrer l'enregistrement")) {
  throw new Error(`Bouton préparé inattendu: ${preparedButton}`);
}

await evaluate(`(() => {
  document.querySelector('#track-url').value = 'adresse incorrecte';
  document.querySelector('#open-track').click();
})()`);
await new Promise((resolve) => setTimeout(resolve, 150));
const validationMessage = await evaluate("document.querySelector('#status-message')?.textContent");
if (!validationMessage.includes("valide")) {
  throw new Error(`Validation URL absente: ${validationMessage}`);
}

console.log("Popup chargé, service worker joignable et validation URL fonctionnelle");
socket.close();
