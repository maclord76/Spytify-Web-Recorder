import { metadataSignature } from "./core.js";

// Événements gardés pour le diagnostic : assez pour couvrir plusieurs morceaux.
const JOURNAL_LENGTH = 80;
// Dernières secondes qu'un morceau terminé peut ne pas afficher, comme pour la
// fin d'un morceau individuel (background.js).
const TRACK_END_TOLERANCE_SECONDS = 3;
// Sans relevé ni PCM pendant ce délai, l'état affiché est stable : le script de
// contenu signale tout changement en 250 ms et Chrome livre les PCM en continu.
const SETTLE_MILLISECONDS = 2000;

// Position incompatible avec la lecture continue depuis le relevé précédent.
function jumped(previous, atMs, position) {
  const expectedMovement = previous.isPlaying ? (atMs - previous.observedAtMs) / 1000 : 0;
  const movement = position - (Number(previous.positionSeconds) || 0);
  return movement < -1.5 || movement > expectedMovement + 3;
}

// Le texte du compteur Spotify n'avance que par secondes entières, à un
// instant quelconque de la seconde : une valeur ronde désigne en moyenne une
// demi-seconde plus loin (coupes à 0,1 s près dans le journal du 10 octobre).
// Dans la dernière seconde, la position réelle ne dépasse pas la durée.
function clockPosition(positionSeconds, durationSeconds = 0) {
  const position = Math.max(0, Number(positionSeconds) || 0);
  if (!Number.isInteger(position) || position === 0) return position;
  const remaining = Number(durationSeconds) > 0 ? Number(durationSeconds) - position : 1;
  return position + Math.max(0, Math.min(1, remaining)) / 2;
}

// Les derniers échantillons restent en PCM pendant huit secondes : un titre
// découvert après le début de son audio peut encore récupérer son début. Après
// une publicité, Spotify affiche parfois le nouveau titre plus de trois
// secondes après son départ (début perdu avec l'ancien tampon de 3 s).
export class MonitoringSession {
  constructor({ sampleRate, startedAtMs, bufferMilliseconds = 8000, create, write, finish }) {
    Object.assign(this, { sampleRate, startedAtMs, bufferMilliseconds, create, write, finish });
    this.pending = [];
    this.intervals = [];
    this.segments = [];
    this.current = null;
    this.lastSnapshot = null;
    this.committedAtMs = startedAtMs;
    this.latestAtMs = startedAtMs;
    this.receivedAtMs = startedAtMs;
    this.closed = false;
    this.advertisement = false;
    this.journal = [];
  }

  // Chaque coupe et chaque relevé écarté reste lisible dans le diagnostic.
  log(event, snapshot, details = {}) {
    this.journal.push({
      atMs: Number(snapshot?.observedAtMs) || this.latestAtMs, event,
      title: snapshot?.metadata?.title || null,
      positionSeconds: Number.isFinite(Number(snapshot?.positionSeconds)) ? Number(snapshot.positionSeconds) : null,
      durationSeconds: Number(snapshot?.durationSeconds) || null,
      positionSource: snapshot?.positionSource ?? null,
      ...details
    });
    if (this.journal.length > JOURNAL_LENGTH) this.journal.splice(0, this.journal.length - JOURNAL_LENGTH);
  }

  snapshot(snapshot) {
    if (this.closed) return;
    const atMs = Number(snapshot.observedAtMs);
    if (!Number.isFinite(atMs) || atMs < this.startedAtMs || atMs < (this.lastSnapshot?.observedAtMs ?? 0)) return;
    // Le signal publicitaire est prioritaire, même lorsque Spotify conserve
    // l'ancien titre ou ne fournit aucun artiste pour la publicité.
    if (snapshot.isAdvertisement) {
      this.pendingChange = null;
      this.pendingSeek = null;
      this.pendingAfterAdvertisement = null;
      if (!this.advertisement) {
        this.log("advertisement", snapshot, { hasTrackMetadata: snapshot.hasTrackMetadata ?? null });
        this.inheritedClockLogged = false;
      }
      this.advertisement = true;
      if (this.current) {
        // Le compteur affiché au début d'une pub n'est pas fiable : Spotify y
        // laisse celui du morceau, ou affiche déjà 30 s sur 30 (fin de GLBTM
        // coupée de 5 s). La fin se déduit du compteur du morceau lui-même.
        // Un compteur resté figé sur la dernière seconde n'en dit pas plus que
        // le dernier relevé : le morceau était fini avant le repérage (« Awake »,
        // 23 octobre 2026, 1,2 s de pub gardées à la fin).
        const last = this.lastSnapshot;
        const duration = this.current.durationSeconds;
        const position = Number(snapshot.positionSeconds) || 0;
        const projected = last?.isPlaying && duration > 0
          ? Math.min(atMs, last.observedAtMs + Math.max(0, duration - clockPosition(last.positionSeconds, duration)) * 1000)
          : null;
        const estimate = this.continuesClock(atMs, position) &&
          (projected === null || position > (Number(last.positionSeconds) || 0)) ? atMs
          : projected ?? atMs - Math.min(Math.max(0, position) * 1000, 3000);
        const boundary = Math.max(this.committedAtMs, this.startedAtMs, estimate);
        // La pub est repérée quelques centièmes après son premier son (0,09 s
        // restait à la fin du morceau) : la coupe reculera jusqu'à ce son dès
        // que les PCM de l'instant du repérage seront arrivés.
        if (this.open) this.pendingTrim = { segment: this.current, interval: this.open, toMs: boundary };
        this.closeInterval(boundary);
        this.current.finalAtMs = boundary;
        this.current.reason = "advertisement";
        this.log("cut", snapshot, { reason: "advertisement", previousTitle: this.current.metadata.title,
          previousPositionSeconds: this.lastSnapshot?.positionSeconds ?? null, boundaryOffsetMs: Math.round(atMs - boundary) });
        this.current = null;
        this.trimAdvertisementStart();
      }
      this.lastSnapshot = { ...snapshot, observedAtMs: atMs, isPlaying: false };
      this.drain(this.latestAtMs - this.bufferMilliseconds);
      return;
    }
    let key = metadataSignature(snapshot.metadata);
    // Un relevé sans artiste, au titre vide ou identique, décrit encore le
    // morceau en cours. Écarté, il laissait le morceau ouvert après sa fin :
    // en pause à 0:00, Spotify ne nommait plus que la page (« Emerald Rush »,
    // 23 octobre 2026, 1 min 35 s de silence ajoutées jusqu'à l'arrêt).
    if (!key && this.current && (!snapshot.metadata?.title ||
        metadataSignature({ ...this.current.metadata, title: snapshot.metadata.title }) === this.current.key)) {
      snapshot = { ...snapshot, metadata: { ...this.current.metadata } };
      key = this.current.key;
      if (!this.current.identityInherited) {
        this.current.identityInherited = true;
        this.log("identity_inherited", snapshot, { isPlaying: Boolean(snapshot.isPlaying) });
      }
    }
    const position = Math.max(0, Number(snapshot.positionSeconds) || 0);
    let transition = snapshot;
    if (this.advertisement) {
      // Le titre peut réapparaître avant la remise à zéro de l'horloge. Ne
      // créer aucun encodeur avant deux observations musicales cohérentes.
      const duration = Number(snapshot.durationSeconds) || 0;
      const adDuration = Number(this.lastSnapshot?.durationSeconds) || 0;
      const adPosition = Number(this.lastSnapshot?.positionSeconds) || 0;
      const sinceAd = (atMs - (this.lastSnapshot?.observedAtMs ?? atMs)) / 1000;
      const inheritedAdClock = duration > 0 && adDuration > 0 && Math.abs(duration - adDuration) < 2 &&
        position > 1 && Math.abs(position - adPosition - sinceAd) < 1.5;
      if (!key || snapshot.hasTrackMetadata === false || !snapshot.isPlaying || snapshot.ended ||
          inheritedAdClock || (duration > 0 && position >= duration - 0.25)) {
        // Une seule entrée par publicité : ce refus se répète à chaque relevé.
        if (inheritedAdClock && key && !this.inheritedClockLogged) {
          this.inheritedClockLogged = true;
          this.log("ad_clock_inherited", snapshot, { adPositionSeconds: adPosition, adDurationSeconds: adDuration });
        }
        this.pendingAfterAdvertisement = null;
        return;
      }
      const pending = this.pendingAfterAdvertisement;
      const movement = position - (Number(pending?.snapshot.positionSeconds) || 0);
      const elapsed = pending ? (atMs - pending.snapshot.observedAtMs) / 1000 : 0;
      if (!pending || pending.key !== key || movement < -1.25 || movement > elapsed + 1.5 ||
          Math.abs(duration - (Number(pending.snapshot.durationSeconds) || 0)) > 2) {
        this.pendingAfterAdvertisement = { key, snapshot };
        return;
      }
      if (elapsed < 0.2) return;
      transition = pending.snapshot;
      this.pendingAfterAdvertisement = null;
    }
    // Un titre temporairement vide pendant le rendu n'est pas une séparation.
    if (!key) return;
    const followingAdvertisement = this.advertisement;
    this.advertisement = false;
    if (this.current && key !== this.current.key) {
      if (this.pendingChange?.key !== key) {
        this.pendingChange = { key, snapshot };
        return;
      }
      const waitedMs = atMs - this.pendingChange.snapshot.observedAtMs;
      if (waitedMs < 200) return;
      // Le nouveau titre s'affiche d'abord avec le compteur de l'ancien (250 s
      // pour GLBTM après Doin' It Right) : attendre sa remise à zéro, qui situe
      // le début, tant que le tampon permet encore de le rattraper.
      if (this.continuesClock(atMs, position) && waitedMs < this.bufferMilliseconds - 2000) return;
      transition = this.pendingChange.snapshot;
    }
    this.pendingChange = null;
    const previous = this.lastSnapshot;
    const jump = Boolean(this.current) && !followingAdvertisement && previous &&
      key === metadataSignature(previous.metadata) && jumped(previous, atMs, position);
    // Spotify n'affiche pas la fin d'un morceau terminé : il revient aussitôt à
    // 0:00 en pause, et aucun autre relevé ne confirmerait ce saut. Le MP3
    // attendait l'arrêt de la surveillance (« As Grace Descends », 20 octobre 2026).
    const endSeconds = Number(snapshot.durationSeconds) || this.current?.durationSeconds || 0;
    const reachedSeconds = Number(previous?.positionSeconds) || 0;
    const wrapped = Boolean(jump) && !snapshot.isPlaying && endSeconds > 0 &&
      reachedSeconds >= endSeconds - TRACK_END_TOLERANCE_SECONDS &&
      position < reachedSeconds - TRACK_END_TOLERANCE_SECONDS;
    const seek = jump && !wrapped;
    // Une seule position aberrante coupait le morceau deux fois, à l'aller puis
    // au retour. Comme un changement de titre, un saut doit être confirmé par un
    // second relevé qui poursuit la nouvelle position.
    if (seek) {
      const pending = this.pendingSeek;
      if (!pending || pending.key !== key || jumped(pending.snapshot, atMs, position)) {
        this.pendingSeek = { key, snapshot: { ...snapshot, observedAtMs: atMs, positionSeconds: position } };
        this.log("seek_pending", this.pendingSeek.snapshot, { previousPositionSeconds: previous.positionSeconds });
        return;
      }
      if (atMs - pending.snapshot.observedAtMs < 200) return;
      transition = pending.snapshot;
    } else if (this.pendingSeek) {
      this.log("seek_ignored", { ...snapshot, positionSeconds: position },
        { ignoredPositionSeconds: this.pendingSeek.snapshot.positionSeconds });
    }
    this.pendingSeek = null;
    const changed = this.current && (key !== this.current.key || seek ||
      (this.current.ended && snapshot.isPlaying && position < 2));
    // Début du titre d'après un relevé, s'il reste rattrapable dans le tampon.
    const clockStart = (observedAtMs, positionSeconds) => {
      const elapsedMs = clockPosition(positionSeconds) * 1000;
      return elapsedMs <= this.bufferMilliseconds ? observedAtMs - elapsedMs : observedAtMs;
    };
    // Un « 0:00 » couvre toute la première seconde : le relevé de confirmation
    // situe souvent mieux le début (Episode 6, environ 1 s perdue après la pub).
    let changeBoundary = followingAdvertisement ? Math.max(this.committedAtMs, this.startedAtMs,
      this.lastSnapshot?.observedAtMs ?? this.startedAtMs,
      Math.min(clockStart(transition.observedAtMs, transition.positionSeconds), clockStart(atMs, position))) : null;

    if (changed) {
      // Le saut a eu lieu au relevé en attente, ou à la reprise s'il était en pause.
      // Un nouveau titre se situe d'après son compteur remis à zéro, à défaut
      // d'après son premier affichage.
      const freshClock = !seek && position * 1000 <= this.bufferMilliseconds && !this.continuesClock(atMs, position);
      const estimate = seek ? (transition.isPlaying ? transition.observedAtMs : atMs)
        : freshClock ? atMs - clockPosition(position) * 1000
          : transition.observedAtMs - Math.min(Number(transition.positionSeconds) || 0, 3) * 1000;
      const boundary = Math.max(this.committedAtMs, this.startedAtMs, estimate);
      changeBoundary = boundary;
      this.closeInterval(boundary);
      this.current.finalAtMs = boundary;
      this.current.reason = seek ? "seek" : "track_changed";
      this.log("cut", transition, { reason: this.current.reason, previousTitle: this.current.metadata.title,
        previousPositionSeconds: previous?.positionSeconds ?? null, boundaryOffsetMs: Math.round(atMs - boundary) });
      this.current = null;
    }

    if (!this.current && snapshot.isPlaying) {
      const estimate = previous?.isPlaying ? atMs - Math.min(position, 3) * 1000
        : Math.max(previous?.observedAtMs ?? this.startedAtMs, atMs - 3000);
      const fromMs = changeBoundary ?? Math.max(this.committedAtMs, this.startedAtMs,
        previous?.isPlaying ? estimate : this.audioOnset(estimate, atMs) ?? atMs);
      this.current = {
        key, metadata: { ...snapshot.metadata }, durationSeconds: Number(snapshot.durationSeconds) || 0,
        samples: 0, hasAudio: false, partial: position - Math.max(0, (atMs - fromMs) / 1000) > 1,
        data: this.create(snapshot.metadata), finalAtMs: null, ended: false
      };
      this.segments.push(this.current);
      this.openInterval(fromMs);
      this.log("start", { ...snapshot, positionSeconds: position }, { afterAdvertisement: followingAdvertisement,
        recoveredMs: Math.round(atMs - fromMs), partial: this.current.partial });
    } else if (this.current) {
      this.current.metadata = { ...snapshot.metadata };
      this.current.durationSeconds = Number(snapshot.durationSeconds) || this.current.durationSeconds;
      if (snapshot.isPlaying && !this.open) {
        // Récupérer les échantillons déjà arrivés depuis la dernière observation
        // en pause, sans inclure la longue attente silencieuse.
        const earliest = Math.max(this.committedAtMs, previous?.observedAtMs ?? atMs, atMs - 1000);
        this.openInterval(this.audioOnset(earliest, atMs) ?? atMs);
      } else if (!snapshot.isPlaying && this.open) {
        this.closeInterval(atMs);
      }
      if (snapshot.ended || wrapped) {
        this.closeInterval(atMs);
        this.current.finalAtMs = atMs;
        this.current.reason = "track_ended";
        this.log("cut", { ...snapshot, positionSeconds: position }, { reason: "track_ended",
          previousPositionSeconds: previous?.positionSeconds ?? null });
        this.current = null;
      }
    }
    this.lastSnapshot = { ...snapshot, observedAtMs: atMs, positionSeconds: position };
    this.drain(this.latestAtMs - this.bufferMilliseconds);
  }

  // Position encore issue du compteur du morceau en cours plutôt que du début
  // d'une publicité.
  continuesClock(atMs, positionSeconds) {
    const position = Number(positionSeconds) || 0;
    const previous = this.lastSnapshot;
    return Boolean(this.current && previous?.isPlaying && position > 3 &&
      !jumped(previous, atMs, position));
  }

  openInterval(fromMs) {
    this.open = { fromMs, toMs: Infinity, segment: this.current };
    this.intervals.push(this.open);
  }

  audioOnset(fromMs, toMs) {
    for (const block of this.pending) {
      const from = Math.max(block.offset, Math.ceil((fromMs - block.startAtMs) * this.sampleRate / 1000));
      const to = Math.min(block.left.length, Math.ceil((toMs - block.startAtMs) * this.sampleRate / 1000));
      for (let index = from; index < to; index += 1) {
        if (Math.abs(block.left[index]) > 0.000001 || Math.abs(block.right[index]) > 0.000001) {
          return block.startAtMs + index * 1000 / this.sampleRate;
        }
      }
    }
    return null;
  }

  closeInterval(atMs) {
    if (this.open) this.open.toMs = Math.max(this.open.fromMs, atMs);
    this.open = null;
  }

  // Premier son suivant au moins 100 ms de silence (sous −60 dB) dans la
  // fenêtre, le plus tardif s'il y en a plusieurs.
  lastOnsetAfterSilence(fromMs, toMs, minSilenceMs = 100, threshold = 0.001) {
    let silentSince = null;
    let onset = null;
    for (const block of this.pending) {
      const from = Math.max(block.offset, Math.ceil((fromMs - block.startAtMs) * this.sampleRate / 1000));
      const to = Math.min(block.left.length, Math.ceil((toMs - block.startAtMs) * this.sampleRate / 1000));
      for (let index = from; index < to; index += 1) {
        const atMs = block.startAtMs + index * 1000 / this.sampleRate;
        if (Math.abs(block.left[index]) < threshold && Math.abs(block.right[index]) < threshold) {
          silentSince ??= atMs;
        } else {
          if (silentSince !== null && atMs - silentSince >= minSilenceMs) onset = atMs;
          silentSince = null;
        }
      }
    }
    return onset;
  }

  // Retirer du morceau le début de la pub repérée en retard. Seul un son
  // précédé d'un silence et à moins de 300 ms de la coupe est la pub : au-delà,
  // ou sans silence, la coupe ne bouge pas pour ne jamais rogner la musique.
  trimAdvertisementStart(force = false) {
    const trim = this.pendingTrim;
    if (!trim || (!force && this.latestAtMs < trim.toMs)) return;
    this.pendingTrim = null;
    const fromMs = Math.max(this.committedAtMs, trim.interval.fromMs, trim.toMs - 300);
    const onset = this.lastOnsetAfterSilence(fromMs - 100, trim.toMs);
    if (onset === null || onset < fromMs || onset >= trim.toMs) return;
    trim.interval.toMs = onset;
    trim.segment.finalAtMs = onset;
    this.log("advertisement_trim", { metadata: trim.segment.metadata, observedAtMs: onset },
      { trimmedMs: Math.round(trim.toMs - onset) });
  }

  // receivedAtMs : instant de réception, mesuré sur l'horloge des relevés et non
  // sur celle de l'AudioContext, qui dérive au fil des heures.
  pcm(left, right, startAtMs, receivedAtMs = null) {
    if (this.closed || !left.length) return;
    const endAtMs = startAtMs + left.length * 1000 / this.sampleRate;
    this.pending.push({ left, right, startAtMs, endAtMs, offset: 0 });
    this.latestAtMs = Math.max(this.latestAtMs, endAtMs);
    this.receivedAtMs = Math.max(this.receivedAtMs, receivedAtMs ?? endAtMs);
    this.trimAdvertisementStart();
    this.drain(this.latestAtMs - this.bufferMilliseconds);
  }

  drain(untilMs) {
    while (this.pending.length) {
      const block = this.pending[0];
      const limit = Math.min(block.left.length, Math.max(0,
        Math.floor((untilMs - block.startAtMs) * this.sampleRate / 1000 + 0.00001)));
      if (limit <= block.offset) break;
      for (const interval of this.intervals) {
        const from = Math.max(block.offset, Math.ceil((interval.fromMs - block.startAtMs) * this.sampleRate / 1000 - 0.00001));
        const to = Math.min(limit, Math.ceil((interval.toMs - block.startAtMs) * this.sampleRate / 1000 - 0.00001));
        if (to <= from) continue;
        const left = block.left.subarray(from, to);
        const right = block.right.subarray(from, to);
        this.write(interval.segment.data, left, right);
        interval.segment.samples += left.length;
        interval.segment.hasAudio ||= left.some((value) => Math.abs(value) > 0.000001) || right.some((value) => Math.abs(value) > 0.000001);
      }
      block.offset = limit;
      this.committedAtMs = Math.max(this.committedAtMs, block.startAtMs + limit * 1000 / this.sampleRate);
      if (limit === block.left.length) this.pending.shift();
      else break;
    }
    this.finishReady();
    this.intervals = this.intervals.filter((interval) => interval.toMs > this.committedAtMs);
  }

  finishReady(force = false) {
    this.segments = this.segments.filter((segment) => {
      if (segment.finalAtMs === null || (!force && segment.finalAtMs > this.committedAtMs)) return true;
      if (segment.hasAudio && segment.samples > 0) {
        const durationSeconds = segment.samples / this.sampleRate;
        // La progression du premier relevé peut être transitoire. Lorsque la
        // durée est connue, les PCM effectivement récupérés décident du suffixe
        // avec la même tolérance de deux secondes que pour la fin du morceau.
        // L'estimation du début reste utile si Spotify n'a fourni aucune durée.
        const partial = segment.durationSeconds > 0
          ? durationSeconds < segment.durationSeconds - 2
          : segment.partial;
        this.finish({ ...segment, metadata: { ...segment.metadata, partial }, durationSeconds,
          expectedDurationSeconds: segment.durationSeconds || null });
      }
      return false;
    });
  }

  // Appelée chaque seconde. Spotify en pause n'envoie plus aucun relevé et
  // Chrome plus aucun PCM tant que l'onglet se tait : sans cette horloge, un
  // changement affiché à l'arrêt restait en attente et la fin du dernier
  // morceau dans le tampon, jusqu'au son suivant ou à l'arrêt.
  settle(nowMs) {
    if (this.closed) return;
    const pending = this.pendingSeek ?? this.pendingChange;
    if (pending && !pending.snapshot.isPlaying && nowMs - pending.snapshot.observedAtMs >= SETTLE_MILLISECONDS) {
      this.snapshot({ ...pending.snapshot, observedAtMs: nowMs });
    }
    if (nowMs - this.receivedAtMs < SETTLE_MILLISECONDS) return;
    // Un PCM produit plus de deux secondes avant serait déjà arrivé : le
    // tampon se vide et les morceaux terminés sont exportés.
    this.trimAdvertisementStart(true);
    this.committedAtMs = Math.max(this.committedAtMs, nowMs - SETTLE_MILLISECONDS);
    this.drain(Infinity);
  }

  stop(reason = "manual") {
    if (this.closed) return;
    this.closed = true;
    if (this.current) this.log("cut", { metadata: this.current.metadata, observedAtMs: this.latestAtMs }, { reason });
    this.closeInterval(this.latestAtMs);
    this.trimAdvertisementStart(true);
    for (const segment of this.segments) {
      segment.finalAtMs ??= this.latestAtMs;
      segment.reason ??= reason;
    }
    this.drain(Infinity);
    this.finishReady(true);
    this.pending = [];
    this.intervals = [];
    this.current = null;
    this.advertisement = false;
    this.pendingAfterAdvertisement = null;
    this.pendingSeek = null;
  }

  status() {
    // Le compteur inclut les PCM du morceau encore dans le tampon. L'encodage
    // différé de quelques secondes ne doit pas retarder le temps affiché.
    let samples = this.current?.samples ?? 0;
    if (this.current) {
      for (const block of this.pending) {
        for (const interval of this.intervals) {
          if (interval.segment !== this.current) continue;
          const from = Math.max(block.offset, Math.ceil((interval.fromMs - block.startAtMs) * this.sampleRate / 1000 - 0.00001));
          const to = Math.min(block.left.length, Math.ceil((interval.toMs - block.startAtMs) * this.sampleRate / 1000 - 0.00001));
          samples += Math.max(0, to - from);
        }
      }
    }
    return {
      metadata: this.current?.metadata ?? null,
      advertisement: this.advertisement,
      recording: Boolean(this.current && this.open),
      elapsedSeconds: Math.floor(samples / this.sampleRate)
    };
  }
}
