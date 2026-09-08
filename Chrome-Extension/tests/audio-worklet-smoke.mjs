const port = Number(process.argv[2]);
if (!port) throw new Error("Indiquez le port de débogage Edge.");

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("Page de test de l'extension introuvable.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await command("Runtime.enable");
await command("Page.enable");
const extensionUrl = "chrome-extension://aggginomgcejlhndlnckdippikjiccpp/offscreen.html";
await command("Page.navigate", { url: extensionUrl });
await new Promise((resolve) => setTimeout(resolve, 500));

const response = await command("Runtime.evaluate", {
  expression: `(async () => {
    const context = new AudioContext();
    await context.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
    const node = new AudioWorkletNode(context, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    node.connect(context.destination);
    node.disconnect();
    await context.close();
    return true;
  })()`,
  awaitPromise: true,
  returnByValue: true
});

if (response.exceptionDetails || response.result.value !== true) {
  throw new Error(`AudioWorklet non chargé: ${JSON.stringify(response.exceptionDetails || response.result)}`);
}

console.log("AudioWorklet chargé dans une vraie page Chromium");
socket.close();
