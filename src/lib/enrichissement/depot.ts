/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPÔT D'UNE PIÈCE — la part PURE de l'étape 1 du moteur d'enrichissement (§3-E).
 *
 * Module sans import : il valide ce qu'un point de dépôt annonce, calcule les clés
 * d'idempotence et compose la charge du fait `PIECE_DEPOSEE`. L'écriture au registre vit dans
 * `evenements.ts` ; l'inventaire des points de dépôt dans
 * `docs/architecture/refonte-p4-points-de-depot.md`.
 *
 * ── CE QUE LE FAIT PORTE, ET CE QU'IL NE PORTE JAMAIS ────────────────────────────────────
 *
 * Le registre se lit largement (`BusinessEvent.payload`) : il porte l'empreinte, le blob, le
 * type MIME, la taille, la source, les rattachements et la confidentialité — JAMAIS le contenu.
 * Le nom d'un fichier CONFIDENTIEL (« passeport_benali.pdf », « paie_mars.xlsx ») en dit déjà
 * trop : il est réduit à son extension. Le classement relira le blob, pas le nom.
 *
 * ── L'IDEMPOTENCE, PAR (EMPREINTE, RATTACHEMENT) ─────────────────────────────────────────
 *
 * Le même PDF re-téléversé sur le même poste ne doit pas relancer l'extraction ; le même PDF
 * joint à un SECOND poste, si : c'est un nouveau lien (`PieceLien`), et le moteur doit pouvoir
 * proposer les faits à ce sujet-là aussi. La clé est donc « empreinte|TYPE:id|rôle ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TYPE_PIECE_DEPOSEE = "PIECE_DEPOSEE";
/** Le domaine émetteur au registre — le moteur d'enrichissement, quel que soit l'écran de dépôt. */
export const DOMAINE_ENRICHISSEMENT = "ENRICHISSEMENT";
/** Version de la charge : un consommateur refuse ce qu'il ne sait pas lire, plutôt que de le deviner. */
export const VERSION_CHARGE = 1;

/** D'où vient la pièce — le « source » de `Piece` (R5). Fermé : une source nouvelle s'ajoute ici. */
export const SOURCES_DEPOT = [
  "DRIVE",
  "DRIVE_VERSION",
  "MESSAGERIE",
  "EMAIL_GMAIL",
  "EMAIL_M365",
  "PORTAIL_FOURNISSEUR",
  "ADPRO",
  "RH",
  "LEGAL",
  "REGULATORY",
  "PCH",
  "MATERIEL_PROMO",
  "ASSISTANT_ADAM",
  "ASSISTANT_IA",
  "IMPORT_EXCEL",
  "AUTRE_MODULE",
] as const;
export type SourceDepot = (typeof SOURCES_DEPOT)[number];

/** Le vocabulaire de `Confidentiality` (Prisma), recopié pour rester sans import. */
export const CONFIDENTIALITES = ["INTERNAL", "RESTRICTED", "CONFIDENTIAL"] as const;
export type ConfidentialitePiece = (typeof CONFIDENTIALITES)[number];

export interface Rattachement {
  /** Un `EntityType` du registre (« AD_PRO_ITEM », « EMPLOYEE »), ou un type hors enum (« CONVERSATION », « EMAIL »). */
  type: string;
  id: string;
  /** Le rôle de la pièce pour ce sujet : « devis », « passeport », « pièce-jointe », « version »… */
  role: string;
}

export interface PieceDeposeeInput {
  /** `FileBlob.id` (Drive, messagerie — rendu par `putBlob`), ou `Document.fileKey` pour une pièce de module. */
  blobId: string;
  /**
   * SHA-256 hexadécimal du contenu — l'identité de la pièce (`PutBlobResult.sha256`). Le marqueur
   * `direct:<clé>` du dépôt direct au bucket n'en est PAS un : il est refusé, l'empreinte se calcule
   * d'abord (voir l'inventaire).
   */
  empreinte: string;
  nomFichier: string;
  mime: string;
  taille: number;
  source: SourceDepot;
  /** `null` : déposée par un système (e-mail entrant, portail, synchronisation). */
  deposeParId: string | null;
  rattachements: Rattachement[];
  confidentialite: ConfidentialitePiece;
  /** Quand le dépôt a eu lieu, s'il est ANTÉRIEUR à l'émission (rattrapage P4). */
  deposeLe?: Date;
}

/** Ce qu'un consommateur lit dans `BusinessEvent.payload`. */
export interface ChargePieceDeposee {
  v: number;
  blobId: string;
  empreinte: string;
  /** Le nom, ou seulement « *.pdf » pour une pièce confidentielle. */
  nomFichier: string;
  mime: string;
  taille: number;
  source: SourceDepot;
  confidentialite: ConfidentialitePiece;
  /** Les rattachements NOUVEAUX de ce fait — ceux qui n'avaient jamais été émis pour cette empreinte. */
  rattachements: Rattachement[];
  /** Leurs clés d'idempotence, dans le même ordre. */
  cles: string[];
}

export type DepotValide = { ok: true; depot: PieceDeposeeInput } | { ok: false; raison: string };

const EMPREINTE_RE = /^[0-9a-f]{64}$/;
const TYPE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const borne = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** Normalise une empreinte (casse, préfixe « sha256: ») — ou `null` si ce n'est pas un SHA-256. */
export function normaliserEmpreinte(brute: string): string | null {
  const e = brute.trim().toLowerCase().replace(/^sha256:/, "");
  return EMPREINTE_RE.test(e) ? e : null;
}

const normaliserRole = (r: string): string => borne(r.trim().toLowerCase().replace(/\s+/g, "-"), 48) || "piece";

export function cleRattachement(empreinte: string, r: Rattachement): string {
  return `${empreinte}|${r.type}:${r.id}|${normaliserRole(r.role)}`;
}

/** La corrélation qui relie tous les dépôts d'un même contenu — indexée au registre. */
export const correlationPiece = (empreinte: string): string => `piece:${empreinte}`;

/**
 * VALIDE ce qu'un point de dépôt annonce. Un dépôt invalide n'émet RIEN (et le dit) : un fait
 * sans empreinte ni rattachement ne pourrait être ni dédoublonné ni relié à une fiche.
 */
export function validerDepot(input: PieceDeposeeInput): DepotValide {
  const empreinte = normaliserEmpreinte(input.empreinte ?? "");
  if (!empreinte) return { ok: false, raison: "empreinte absente ou non SHA-256" };
  const blobId = (input.blobId ?? "").trim();
  if (!blobId) return { ok: false, raison: "blob absent" };
  if (!(SOURCES_DEPOT as readonly string[]).includes(input.source)) return { ok: false, raison: `source inconnue : ${input.source}` };
  if (!(CONFIDENTIALITES as readonly string[]).includes(input.confidentialite)) {
    return { ok: false, raison: `confidentialité inconnue : ${input.confidentialite}` };
  }
  if (!Number.isFinite(input.taille) || input.taille < 0) return { ok: false, raison: "taille invalide" };

  const vus = new Set<string>();
  const rattachements: Rattachement[] = [];
  for (const r of input.rattachements ?? []) {
    const type = (r.type ?? "").trim().toUpperCase();
    const id = (r.id ?? "").trim();
    if (!TYPE_RE.test(type) || !id) return { ok: false, raison: `rattachement invalide : ${r.type}:${r.id}` };
    const propre = { type, id: borne(id, 128), role: normaliserRole(r.role ?? "") };
    const cle = cleRattachement(empreinte, propre);
    if (vus.has(cle)) continue;
    vus.add(cle);
    rattachements.push(propre);
  }
  if (rattachements.length === 0) return { ok: false, raison: "aucun rattachement" };

  return {
    ok: true,
    depot: {
      ...input,
      blobId: borne(blobId, 512),
      empreinte,
      nomFichier: borne((input.nomFichier ?? "").trim() || "sans-nom", 255),
      mime: borne((input.mime ?? "").trim().toLowerCase() || "application/octet-stream", 128),
      taille: Math.round(input.taille),
      rattachements,
    },
  };
}

/** Le nom tel qu'il peut figurer au registre : intact, ou réduit à son extension s'il est confidentiel. */
export function nomPourRegistre(nom: string, c: ConfidentialitePiece): string {
  if (c !== "CONFIDENTIAL") return nom;
  const ext = /\.([a-z0-9]{1,8})$/i.exec(nom)?.[1];
  return ext ? `*.${ext.toLowerCase()}` : "*";
}

export interface PlanEmission {
  /** Les rattachements à émettre — vide : tout a déjà été émis, rien à faire. */
  nouveaux: Rattachement[];
  cles: string[];
  dejaEmis: number;
}

/** DÉCIDE ce qui reste à émettre, d'après les clés déjà présentes au registre pour cette empreinte. */
export function planifierEmission(depot: PieceDeposeeInput, clesExistantes: Iterable<string>): PlanEmission {
  const existantes = new Set(clesExistantes);
  const nouveaux: Rattachement[] = [];
  const cles: string[] = [];
  let dejaEmis = 0;
  for (const r of depot.rattachements) {
    const cle = cleRattachement(depot.empreinte, r);
    if (existantes.has(cle)) { dejaEmis += 1; continue; }
    nouveaux.push(r);
    cles.push(cle);
  }
  return { nouveaux, cles, dejaEmis };
}

export function composerCharge(depot: PieceDeposeeInput, plan: PlanEmission): ChargePieceDeposee {
  return {
    v: VERSION_CHARGE,
    blobId: depot.blobId,
    empreinte: depot.empreinte,
    nomFichier: nomPourRegistre(depot.nomFichier, depot.confidentialite),
    mime: depot.mime,
    taille: depot.taille,
    source: depot.source,
    confidentialite: depot.confidentialite,
    rattachements: plan.nouveaux,
    cles: plan.cles,
  };
}

/** Les clés d'idempotence d'une charge déjà inscrite — tolérant : une charge illisible n'en porte aucune. */
export function clesDeCharge(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const cles = (payload as { cles?: unknown }).cles;
  return Array.isArray(cles) ? cles.filter((c): c is string => typeof c === "string") : [];
}

/**
 * RELIT une charge `PIECE_DEPOSEE` pour un consommateur — `null` si elle n'est pas lisible ou
 * d'une version inconnue. Le consommateur ne devine jamais une forme.
 */
export function lireChargePieceDeposee(payload: unknown): ChargePieceDeposee | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Partial<ChargePieceDeposee>;
  if (p.v !== VERSION_CHARGE) return null;
  if (typeof p.blobId !== "string" || typeof p.empreinte !== "string" || !EMPREINTE_RE.test(p.empreinte)) return null;
  if (!Array.isArray(p.rattachements) || !Array.isArray(p.cles)) return null;
  if (!(SOURCES_DEPOT as readonly string[]).includes(p.source as string)) return null;
  if (!(CONFIDENTIALITES as readonly string[]).includes(p.confidentialite as string)) return null;
  return p as ChargePieceDeposee;
}
