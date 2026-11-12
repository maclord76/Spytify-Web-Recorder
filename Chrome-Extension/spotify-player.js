// Connaissance partagée du lecteur Spotify Web, utilisée par le script de
// contenu, le service de fond, le panneau et le pilotage par le débogueur.
//
// Libellés du bouton lecture/pause de Spotify Web dans ses 69 langues, relevés
// le 9 octobre 2026 dans ses traductions officielles (clés play, pause,
// playback-control.play et playback-control.pause). Aucun libellé n'a un sens
// différent d'une langue à l'autre : un bouton qui propose « Pause » signale
// une lecture en cours, un bouton qui propose « Lecture » un lecteur arrêté.
//
// Script classique : chargé avant content.js comme script de contenu, et
// importé pour ses effets par les modules (service de fond, panneau).
(() => {
  const normalize = (value) => String(value ?? "").normalize("NFC").trim().toLowerCase();
  const PAUSE_LABELS = [
    "duraklat", "fasilə ver", "gera hlé", "i-pause", "jeda", "laat wag", "mettre en pause",
    "pausa", "pausar", "pausatu", "pause", "pauza", "pauzeren", "pauziraj", "pauziranje",
    "pauză", "pauzēt", "peata", "phumuza", "posa en pausa", "pozastavit", "pozastaviť",
    "pristabdyti", "sett på pause", "sitisha", "szünet", "szüneteltetés", "sæt på pause",
    "tauko", "tạm dừng", "ustavi", "παύση", "пауза", "паузирај", "השהיה", "إيقاف مؤقت",
    "إيقاف مؤقّت", "توقيف مؤقت", "موقوف کریں", "مکث", "وقف", "तात्काळ थांबवा",
    "पज गर्नुहोस्", "रोकें", "পজ করুন", "ਰੋਕੋ", "થોભાવો", "થોભો", "இடைநிறுத்து",
    "పాజ్", "ವಿರಾಮ", "തൽക്കാലം നിർത്തുക", "หยุดชั่วคราว", "ለአፍታ አቁም", "一時停止",
    "暂停", "暫停", "일시 정지하기"
  ];
  const PLAY_LABELS = [
    "afspelen", "afspil", "atskaņot", "cheza", "dlala", "erreproduzitu", "esita", "i-play",
    "lecture", "leisti", "lejátszás", "main", "odtwórz", "oxut", "phát", "play",
    "predvajaj", "prehrať", "pusti", "putar", "přehrát", "redă", "reproducir",
    "reproduciraj", "reprodueix", "reprodukcija", "reproduzir", "speel", "spela upp",
    "spila", "spill av", "toista", "toisto", "çal", "αναπαραγωγή", "відтворити",
    "пуснете", "пушти", "слушать", "נגן", "استمع", "تشغيل", "خدّم", "پخش", "پلے کریں",
    "चलाएँ", "प्ले करा", "प्ले गर्नुहोस्", "চালান", "ਚਲਾਓ", "વગાડો", "இயக்கு", "ప్లే",
    "ಪ್ಲೇ", "പ്ലേ ചെയ്യുക", "เล่น", "አጫውት", "再生", "播放", "재생하기"
  ];
  const pause = new Set(PAUSE_LABELS.map(normalize));
  const play = new Set(PLAY_LABELS.map(normalize));

  globalThis.SpytifyPlayer = Object.freeze({
    labels: Object.freeze({ pause: Object.freeze([...pause]), play: Object.freeze([...play]) }),
    // Titre du morceau dans le lecteur inférieur, du plus précis au plus large.
    TITLE_SELECTORS: Object.freeze([
      '[data-testid="context-item-info-title"] a',
      '[data-testid="now-playing-widget"] [data-testid="context-item-link"]',
      '[data-testid="context-item-link"]'
    ]),
    // true : le bouton propose la pause, la lecture est en cours.
    // false : le bouton propose la lecture. null : libellé inconnu.
    isPlayingLabel(label) {
      const value = normalize(label);
      return pause.has(value) ? true : play.has(value) ? false : null;
    },
    normalizeTitle(value) {
      return String(value || "").normalize("NFC").trim().toLocaleLowerCase("fr");
    },
    // « 3:07 » ou « 1:02:03 » en secondes ; 0 pour une valeur illisible.
    parseTime(value) {
      const parts = String(value || "").trim().split(":").map(Number);
      if (!parts.length || parts.some(Number.isNaN)) return 0;
      return parts.reduce((seconds, part) => seconds * 60 + part, 0);
    }
  });
})();
