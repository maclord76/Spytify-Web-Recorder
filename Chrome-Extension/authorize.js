// L'ouverture de cette page par l'action Chrome accorde l'accès à l'onglet.
// La capture est créée dans le service de fond puis consommée hors écran :
// fermer cette petite fenêtre n'interrompt donc pas l'enregistrement.
const status = document.querySelector("#authorization-status");
document.querySelector("#authorization-version").textContent =
  `Version ${chrome.runtime.getManifest().version}`;
document.querySelector("#close-authorization").addEventListener("click", () => window.close());

async function authorize() {
  const response = await chrome.runtime.sendMessage({ type: "AUTHORIZE_CAPTURE" });
  if (!response?.ok) throw new Error(response?.error || "La capture n'a pas répondu.");
  if (response.state?.phase === "prepared") {
    window.close();
    return;
  }
  status.textContent = response.state?.message || "Reprenez l'étape 2 dans le panneau Spytify.";
}

authorize().catch(error => {
  status.textContent = error.message;
});
