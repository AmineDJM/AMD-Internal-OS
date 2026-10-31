import type { Capture, EcritureCapturee, EffetExterneCapture } from "./magasin";
import { valeurLisible } from "./valeurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DIFF D'UNE SIMULATION (J7, décision 0029) — pur, sans import lourd : la carte (navigateur) le lit tel quel.
 *
 * Ce que la personne lit AVANT de confirmer : « 3 champs modifiés sur la demande X, 1 notification à Karim, 1 pièce
 * déposée » — calculé sur les écritures RÉELLES de l'action jouée dans une transaction annulée, jamais rédigé par un
 * modèle. Les écritures de trace (audit, événements) n'y figurent pas ; les tables techniques d'une pièce (octets,
 * versions) s'y résument en « pièce déposée ».
 *
 * ── L'EMPREINTE ─────────────────────────────────────────────────────────────────────────
 *
 * Elle dit si deux simulations du même geste ont fait LA MÊME CHOSE : mêmes lignes, mêmes champs, mêmes valeurs,
 * mêmes effets. Ce qui change d'un passage à l'autre sans changer le geste est neutralisé : l'identifiant d'une ligne
 * créée (« nouvelle tâche #1 », y compris là où une autre écriture y renvoie), un horodatage posé pendant le geste
 * (« maintenant »), `createdAt` / `updatedAt`. La confirmation rejoue la simulation et compare : une empreinte
 * différente, et rien ne s'exécute — la carte se remontre avec le nouveau diff.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ChampDiff { champ: string; avant: string; apres: string }

export interface LigneDiff {
  modele: string;
  /** « tâche », « notification », « demande RH »… */
  nature: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | "SQL";
  id: string | null;
  /** Le nom lisible de la ligne : son titre, sa référence, son nom — sinon le début de son identifiant. */
  titre: string;
  champs: ChampDiff[];
  /** La phrase de la ligne : « tâche « Stand » créée », « 3 champs modifiés sur la demande X ». */
  phrase: string;
  imbriquee?: boolean;
  cascade?: number;
  nombre?: number;
}

export interface EffetDiff { acte: EffetExterneCapture["acte"]; cible: string; phrase: string; neutralise: boolean }

export interface DiffSimulation {
  statut: "SIMULE" | "ECHEC";
  /** Échec : pourquoi la simulation n'a pas pu aller au bout (l'action a refusé, une erreur, le délai). */
  raison?: string;
  resume: string;
  lignes: LigneDiff[];
  effets: EffetDiff[];
  empreinte: string;
  /** Le nombre de lignes de trace écartées (audit, événements) — pour dire qu'elles existent. */
  ms: number;
}

const NATURES: Readonly<Record<string, string>> = {
  Task: "tâche", Notification: "notification", ValidationRequest: "demande", HrRequest: "demande RH", AdminRequest: "demande administrative",
  Employee: "fiche employé", User: "compte", Comment: "commentaire", TaskComment: "commentaire", DriveNode: "fichier du Drive",
  Document: "document", Piece: "pièce", Message: "message", Conversation: "conversation", CalendarEvent: "rendez-vous",
  Meeting: "réunion", ExpenseOrder: "ordre de dépense", PaymentRequest: "demande de paiement", PurchaseOrder: "bon de commande",
  RegulatoryProduct: "produit réglementaire", Dossier: "dossier", Mission: "travail", Doctor: "médecin", Pharmacy: "pharmacie",
  FieldReport: "compte rendu de visite", OutboundMailIntent: "courriel en file", DeletedRecord: "entrée de corbeille",
  LeaveRequest: "demande de congé", Sponsoring: "sponsoring", Event: "événement", Supplier: "fournisseur",
};

/** Les tables techniques d'une pièce : résumées en « pièce déposée », jamais détaillées. */
const TECHNIQUES = new Set(["FileBlob", "FileBlobChunk", "StoredFile", "FileVersion", "PieceLien", "LecturePiece", "DocumentSequence"]);
const PIECES = /(Attachment|Piece|^Document$|^EmployeeDocument$|^RegulatoryDocument$|^LegalDocument$)$/;
const CHAMPS_TITRE = ["title", "titre", "name", "nom", "subject", "objet", "reference", "numero", "number", "label", "libelle", "code", "fullName"];
const VOLATILS = new Set(["createdAt", "updatedAt", "creeLe", "majLe"]);

export function natureDe(modele: string): string {
  return NATURES[modele] ?? modele.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 && !/[sx]$/.test(mot) ? "s" : ""}`;

function titreDe(e: EcritureCapturee): string {
  const l = e.apres ?? e.avant ?? {};
  for (const c of CHAMPS_TITRE) {
    const v = l[c];
    if (typeof v === "string" && v.trim()) return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  }
  return e.id ? `#${e.id.slice(0, 8)}` : "";
}

function ligneDe(e: EcritureCapturee, noms: ReadonlyMap<string, string>): LigneDiff {
  const nature = natureDe(e.modele);
  const titre = titreDe(e);
  const nomme = titre ? ` « ${titre} »` : "";
  if (e.operation === "SQL") {
    return { modele: e.modele, nature: "écriture SQL", operation: "SQL", id: null, titre: "", champs: [], phrase: `une écriture SQL directe${e.modele !== "SQL" ? ` sur ${natureDe(e.modele)}` : ""} (non détaillée)`, nombre: e.nombre };
  }
  if (e.id === null && e.nombre !== undefined) {
    const verbe = e.operation === "CREATE" ? "créée(s)" : e.operation === "DELETE" ? "supprimée(s)" : "modifiée(s)";
    return { modele: e.modele, nature, operation: e.operation, id: null, titre: "", champs: [], phrase: `${e.nombre} ligne(s) de ${nature} ${verbe} en lot`, nombre: e.nombre };
  }
  if (e.modele === "Notification" && e.operation === "CREATE") {
    const qui = noms.get(String(e.apres?.userId ?? "")) ?? "une personne";
    return { modele: e.modele, nature, operation: e.operation, id: e.id, titre, champs: [], phrase: `notification à ${qui}${nomme}` };
  }
  const champsVisibles = e.champs.filter((c) => !VOLATILS.has(c) && c !== "id");
  if (e.operation === "UPDATE") {
    const champs = champsVisibles.map((c) => ({ champ: c, avant: valeurLisible(e.avant?.[c]), apres: valeurLisible(e.apres?.[c]) }));
    return {
      modele: e.modele, nature, operation: e.operation, id: e.id, titre, champs, imbriquee: e.imbriquee,
      phrase: `${pluriel(champs.length, "champ")} modifié${champs.length > 1 ? "s" : ""} sur ${nature}${nomme}`,
    };
  }
  if (e.operation === "CREATE") {
    const champs = champsVisibles.filter((c) => e.apres?.[c] !== null && e.apres?.[c] !== "" && !(Array.isArray(e.apres?.[c]) && (e.apres?.[c] as unknown[]).length === 0))
      .slice(0, 8).map((c) => ({ champ: c, avant: "", apres: valeurLisible(e.apres?.[c]) }));
    return { modele: e.modele, nature, operation: e.operation, id: e.id, titre, champs, imbriquee: e.imbriquee, phrase: `${nature}${nomme} créé(e)` };
  }
  return {
    modele: e.modele, nature, operation: e.operation, id: e.id, titre, champs: [], cascade: e.cascade,
    phrase: `${nature}${nomme} supprimé(e)${e.cascade ? `, avec ${e.cascade} élément(s) lié(s) en cascade` : ""}`,
  };
}

const ACTES: Readonly<Record<EffetExterneCapture["acte"], string>> = {
  COURRIEL: "courriel", NOTIFICATION_PUSH: "notification poussée", INVITATION_AGENDA: "invitation d'agenda",
  ECRITURE_EXTERNE: "écriture sur le site", PAIEMENT: "ordre de paiement", STOCKAGE: "écriture au stockage", RESEAU: "appel sortant",
};

function effetDe(f: EffetExterneCapture, noms: ReadonlyMap<string, string>): EffetDiff {
  const cible = f.acte === "NOTIFICATION_PUSH" ? noms.get(f.cible) ?? "une personne" : f.cible;
  const suite = f.neutralise ? " — non envoyé (simulation)" : "";
  const phrase = f.acte === "STOCKAGE" ? `${f.apercu ?? "écriture"} au stockage${suite}` : `${ACTES[f.acte]} à ${cible}${f.apercu ? ` ${f.apercu}` : ""}${suite}`;
  return { acte: f.acte, cible, phrase, neutralise: f.neutralise };
}

/** Les écritures visibles (sans les tables techniques d'une pièce), consolidées par ligne (un « avant », un « après »). */
export function consolider(ecritures: readonly EcritureCapturee[]): EcritureCapturee[] {
  const parLigne = new Map<string, EcritureCapturee>();
  const out: EcritureCapturee[] = [];
  for (const e of ecritures) {
    if (!e.id || e.operation === "SQL") { out.push(e); continue; }
    const k = `${e.modele}|${e.id}`;
    const deja = parLigne.get(k);
    if (!deja) { const copie = { ...e, champs: [...e.champs] }; parLigne.set(k, copie); out.push(copie); continue; }
    // Une ligne créée puis supprimée dans le même geste n'a rien laissé ; créée puis modifiée reste une création.
    if (deja.operation === "CREATE" && e.operation === "DELETE") { deja.operation = "SQL"; deja.modele = "__neutre__"; continue; }
    if (e.operation === "DELETE") { deja.operation = "DELETE"; deja.apres = null; deja.cascade = e.cascade; continue; }
    deja.apres = e.apres;
    deja.imbriquee = deja.imbriquee || e.imbriquee;
    if (deja.operation === "UPDATE") {
      const cles = new Set([...Object.keys(deja.avant ?? {}), ...Object.keys(deja.apres ?? {})]);
      deja.champs = [...cles].filter((c) => JSON.stringify(deja.avant?.[c] ?? null) !== JSON.stringify(deja.apres?.[c] ?? null)).sort();
    } else {
      deja.champs = Object.keys(deja.apres ?? {}).sort();
    }
  }
  return out.filter((e) => e.modele !== "__neutre__" && !(e.operation === "UPDATE" && e.id && e.champs.length === 0));
}

function resumer(lignes: readonly LigneDiff[], effets: readonly EffetDiff[], pieces: number): string {
  const parts: string[] = [];
  for (const l of lignes) if (!TECHNIQUES.has(l.modele) && !PIECES.test(l.modele)) parts.push(l.phrase);
  if (pieces) parts.push(pieces > 1 ? `${pieces} pièces déposées` : "1 pièce déposée");
  for (const f of effets) if (f.acte !== "STOCKAGE") parts.push(f.phrase);
  if (!parts.length) return "La simulation n'a rien écrit.";
  const vus = new Map<string, number>();
  for (const p of parts) vus.set(p, (vus.get(p) ?? 0) + 1);
  return [...vus].map(([p, n]) => (n > 1 ? `${n} × ${p}` : p)).join(", ") + ".";
}

/** Une empreinte courte et STABLE d'un texte (cyrb53) — pure, identique au serveur et au navigateur. */
export function hacher(texte: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * L'EMPREINTE d'une capture : les identifiants créés deviennent « nouveau:Modèle#k », les dates posées pendant le geste
 * « maintenant », les horodatages de ligne disparaissent.
 */
export function empreinteDe(capture: Capture, fenetre: { debut: number; fin: number }): string {
  const ecritures = consolider(capture.ecritures);
  const jetons = new Map<string, string>();
  const parModele = new Map<string, number>();
  for (const e of ecritures) {
    if (e.operation !== "CREATE" || !e.id) continue;
    const k = (parModele.get(e.modele) ?? 0) + 1;
    parModele.set(e.modele, k);
    jetons.set(e.id, `nouveau:${e.modele}#${k}`);
  }
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") {
      const exact = jetons.get(v);
      if (exact) return exact;
      // Un lien qui porte l'identifiant créé (« /taches/cm3… ») le remplace aussi.
      let s = v;
      for (const [id, jeton] of jetons) if (id.length >= 8 && s.includes(id)) s = s.split(id).join(jeton);
      return s;
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.$date === "string") {
        const t = Date.parse(o.$date);
        return t >= fenetre.debut - 5_000 && t <= fenetre.fin + 5_000 ? "@maintenant" : o.$date;
      }
      return Object.fromEntries(Object.keys(o).sort().map((c) => [c, norm(o[c])]));
    }
    return v ?? null;
  };
  const ligne = (e: EcritureCapturee) => {
    const champs = e.champs.filter((c) => !VOLATILS.has(c) && c !== "id");
    // AVANT et APRÈS : la carte montre « LOW → HIGH » ; si LOW a changé depuis, ce n'est plus ce qu'elle montrait.
    return [e.modele, e.operation, e.id ? norm(e.id) : `lot:${e.nombre ?? "?"}`, champs.map((c) => [c, norm(e.avant?.[c] ?? null), norm(e.apres?.[c] ?? null)]), e.cascade ?? 0];
  };
  const lignes = ecritures.map((e) => JSON.stringify(ligne(e))).sort();
  const effets = capture.effets.map((f) => JSON.stringify([f.acte, f.cible])).sort();
  return hacher(JSON.stringify({ lignes, effets }));
}

/** LE DIFF LISIBLE d'une capture. `noms` : les personnes nommées (destinataires d'une notification, d'une poussée). */
export function construireDiff(
  capture: Capture,
  fenetre: { debut: number; fin: number },
  noms: ReadonlyMap<string, string> = new Map(),
  echec?: string,
): DiffSimulation {
  const ecritures = consolider(capture.ecritures);
  const lignes = ecritures.map((e) => ligneDe(e, noms));
  const effets = capture.effets.map((f) => effetDe(f, noms));
  const fichiers = lignes.filter((l) => l.operation === "CREATE" && (PIECES.test(l.modele) || l.modele === "DriveNode")).length;
  const pieces = fichiers || lignes.filter((l) => l.operation === "CREATE" && l.modele === "FileBlob").length;
  return {
    statut: echec ? "ECHEC" : "SIMULE",
    ...(echec ? { raison: echec } : {}),
    resume: echec ? `La simulation n'a pas abouti : ${echec}` : resumer(lignes.filter((l) => l.modele !== "DriveNode"), effets, pieces),
    lignes: lignes.filter((l) => !TECHNIQUES.has(l.modele)),
    effets,
    empreinte: empreinteDe(capture, fenetre),
    ms: Math.max(0, fenetre.fin - fenetre.debut),
  };
}
