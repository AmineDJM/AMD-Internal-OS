import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { openSecret, sealSecret } from "@/lib/crypto/secret-box";
import { lireTexteOuOcr, type LectureFichier, type MoteurOcr } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE UNE PIÈCE UNE FOIS — par l'empreinte de ses OCTETS, jamais par son nom (lot D2-A, P6).
 *
 * Un devis arrive trois fois : en pièce jointe d'un courriel, rescanné sous « scan_0042.pdf »,
 * renvoyé par l'assistante sous « Devis Kwality.pdf ». C'est la même pièce, et elle ne se lit —
 * ni ne se paie, quand l'OCR ou le modèle coûte — qu'une fois. La clé est le SHA-256 des octets
 * et la version du lecteur (`LecturePiece`, unique sur ce couple) : un nom de fichier ne désigne
 * rien, deux octets différents sous le même nom sont deux pièces.
 *
 * ── RÉSERVER AVANT DE LIRE (§118.65) ─────────────────────────────────────────────────────
 *
 * « Regarder si elle est lue, sinon la lire » laisse deux dépôts simultanés lire tous les deux :
 * chacun regarde avant que l'autre ait écrit. On RÉSERVE d'abord, en une instruction —
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` sur la clé unique — et seul celui qui a inséré lit ;
 * les autres attendent son issue (au plus 20 s), puis la partagent. Une réservation abandonnée
 * (processus tombé en pleine lecture) se reprend passé 5 minutes, SOUS CONDITION : deux reprises
 * simultanées ne lisent pas deux fois. Et la conclusion d'une lecture est elle-même conditionnelle
 * sur le jeton de SA tentative (l'horodatage posé à la réservation ou à la reprise) : un lecteur
 * qu'on croyait mort et qui finit après coup n'écrase pas la lecture de celui qui l'a remplacé.
 *
 * ── CE QUI EST UN ACQUIS, ET CE QUI N'EN EST PAS UN (§118.105a) ──────────────────────────
 *
 * Une lecture qui a abouti (`LUE`) est un acquis : elle ne se refait jamais en silence — relire
 * avec d'autres règles passe par une nouvelle version du lecteur. Une lecture dont l'OCR a LEVÉ,
 * ou dont le lecteur a planté (`ECHOUEE`), n'est pas un fait sur la PIÈCE mais sur le moteur, ce
 * jour-là : la garder comme une lecture rendrait l'échec permanent pour ces octets. L'appel SUIVANT
 * qui la trouve la retente donc, sous condition. Celui qui ATTENDAIT cette tentative, lui, en
 * partage l'issue — sans quoi deux dépôts simultanés d'un scan illisible feraient tourner le
 * moteur deux fois. Un texte qui ne se déchiffre plus (clé changée) n'est pas davantage un acquis :
 * il se relit, sous la même condition.
 *
 * ── LE TEXTE EST SCELLÉ ──────────────────────────────────────────────────────────────────
 *
 * Une facture porte un RIB, un devis des conditions commerciales : le texte lu dort chiffré
 * (`sealSecret`, AES-256-GCM authentifié), jamais en clair dans une colonne qu'une sauvegarde
 * expose. Partager une lecture entre personnes ne fuit rien : pour obtenir celle d'une pièce, il
 * faut en fournir les octets — c'est-à-dire déjà la tenir.
 *
 * ── CE QUE CE MODULE NE FAIT PAS ─────────────────────────────────────────────────────────
 *
 * Il ne contrôle aucun droit (c'est la porte de la CIBLE, dans chaque action), ne refuse ni
 * taille ni format (le service de lecture le dit), ne repère ni en-tête ni total, n'appelle aucun
 * modèle. Il lit, il garde, il partage. L'OCR est LOCAL par défaut (`cloud` faux sauf demande
 * expresse) : rien ne sort de l'ERP sans qu'un appelant l'ait décidé.
 *
 * Ce que la base ne garde pas, faute de colonne : la RAISON précise d'un échec d'OCR (`raisonOcr`)
 * — elle n'est rendue qu'à l'appel qui a lu ; un appel servi par une lecture existante sait qu'il
 * y a eu échec (`ocrEchoue`), pas pourquoi.
 *
 * Serveur seulement, hors carte (comme `quality/`) ; jamais un point d'entrée : l'identité arrive
 * de l'appelant qui l'a vérifiée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * La version du LECTEUR : texte natif, OCR, règles de lecture. La monter, c'est demander que les
 * pièces se relisent avec les règles du jour — jamais en silence, puisqu'une nouvelle version est
 * une nouvelle clé.
 */
export const VERSION_LECTEUR = 1;

/** Ce qu'un appel attend au plus l'issue d'une lecture lancée par un autre. */
const ATTENTE_MAX_MS = 20_000;
/** Au-delà, une réservation `EN_COURS` est tenue pour abandonnée (processus tombé en pleine lecture). */
const PERIME_APRES_MS = 5 * 60_000;
/** Pas de l'attente : relire la ligne, pas plus souvent. */
const INTERVALLE_MS = 250;

/** UNE LECTURE CONCLUE — ce que la ligne `LecturePiece` porte, et le texte lu, déchiffré. */
export interface LectureDePiece {
  id: string;
  empreinte: string;
  versionLecteur: number;
  /** `LUE` : un acquis. `ECHOUEE` : l'OCR a levé — le texte rendu est le texte natif seul. */
  etat: "LUE" | "ECHOUEE";
  /** Vrai : CET appel a fait tourner le lecteur. Faux : il a été servi par la lecture d'un autre. */
  luParCetAppel: boolean;
  /** L'extension sous laquelle la pièce a été LUE — celle de l'appel qui a lu, pas forcément la vôtre. */
  extension: string;
  taille: number;
  texte: string;
  methode: "texte" | "ocr";
  confiance: number | null;
  aRelire: boolean;
  ocrTente: boolean;
  ocrEchoue: boolean;
  /** Pourquoi l'OCR n'a pas lu — connue du seul appel qui a lu (`luParCetAppel`) : la base ne la garde pas. */
  raisonOcr: string | null;
  pagesLues: number | null;
  pagesTotal: number | null;
  caracteres: number;
  tronque: boolean;
  moteur: string | null;
}

export type ResultatLecture =
  | { ok: true; lecture: LectureDePiece }
  | {
      ok: false;
      /** `EN_COURS` : un autre appel lit encore cette pièce. `ECHEC` : le lecteur lui-même a planté. */
      code: "EN_COURS" | "ECHEC";
      message: string;
      lectureId: string;
    };

/** Ce qu'un banc injecte : le moteur OCR (jamais de vrai moteur dans un test) et les délais. */
export interface DependancesLecture {
  ocr?: MoteurOcr;
  attenteMaxMs?: number;
  perimeApresMs?: number;
  intervalleMs?: number;
}

/** L'empreinte d'une pièce : le SHA-256 de ses octets, en hexadécimal — le format de `FileBlob.sha256`. */
export function empreinteDe(octets: Uint8Array): string {
  return createHash("sha256").update(octets).digest("hex");
}

const normaliserExtension = (ext: string): string => ext.trim().toLowerCase().replace(/^\.+/, "");

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PHRASE_EN_COURS =
  "Cette pièce est déjà en cours de lecture — relancez dans quelques secondes : elle ne sera pas lue une seconde fois, son résultat vous sera rendu.";
const PHRASE_ECHEC_PARTAGE =
  "La lecture de cette pièce a échoué pendant que vous l'attendiez — relancez-la ; si l'échec revient, saisissez la pièce depuis le papier.";
const PHRASE_INDECHIFFRABLE =
  "Le texte lu de cette pièce ne se déchiffre pas sur ce serveur (clé de chiffrement différente) — relancez la lecture.";

function phraseEchec(err: unknown): string {
  const brut = (err instanceof Error ? err.message : String(err ?? "")).replace(/\s+/g, " ").trim();
  const raison = brut ? ` (${brut.length > 200 ? `${brut.slice(0, 200)}…` : brut})` : "";
  return `La lecture de cette pièce a échoué${raison} — relancez-la ; si l'échec revient, saisissez la pièce depuis le papier.`;
}

type Ligne = NonNullable<Awaited<ReturnType<typeof charger>>>;

function charger(empreinte: string) {
  return prisma.lecturePiece.findUnique({ where: { empreinte_versionLecteur: { empreinte, versionLecteur: VERSION_LECTEUR } } });
}

/** Le texte gardé, déchiffré : `""` quand rien n'a été lu, `null` quand il ne se déchiffre plus. */
function ouvrir(texteScelle: string | null): string | null {
  return texteScelle ? openSecret(texteScelle) : "";
}

/**
 * Le texte d'une lecture DÉJÀ FAITE, par son identifiant — `null` si elle n'existe plus ou ne se déchiffre plus.
 * Serveur seulement : sert à recopier ce qu'une pièce lue avant une évolution du lecteur imprime (ex. l'identité de
 * l'émetteur), sans relire le fichier ni défaire ce qu'une personne a validé.
 */
export async function texteDeLaLecture(lectureId: string): Promise<string | null> {
  const l = await prisma.lecturePiece.findUnique({ where: { id: lectureId }, select: { texteScelle: true } });
  if (!l) return null;
  return ouvrir(l.texteScelle);
}

function versLecture(ligne: Ligne, texte: string, luParCetAppel: boolean, raisonOcr: string | null): LectureDePiece {
  return {
    id: ligne.id, empreinte: ligne.empreinte, versionLecteur: ligne.versionLecteur,
    etat: ligne.etat === "LUE" ? "LUE" : "ECHOUEE",
    luParCetAppel, extension: ligne.extension, taille: ligne.taille, texte,
    methode: ligne.methode === "ocr" ? "ocr" : "texte",
    confiance: ligne.confiance, aRelire: ligne.aRelire, ocrTente: ligne.ocrTente, ocrEchoue: ligne.ocrEchoue,
    raisonOcr, pagesLues: ligne.pagesLues, pagesTotal: ligne.pagesTotal, caracteres: ligne.caracteres,
    tronque: ligne.tronque, moteur: ligne.moteur,
  };
}

/**
 * RÉSERVER : une instruction, et la ligne rendue dit qui a la main. Deux appels simultanés ne
 * peuvent pas lire « libre » tous les deux — la clé unique en départage un, l'autre ne reçoit rien.
 * L'horodatage posé est le JETON de la tentative.
 */
async function reserver(empreinte: string, ext: string, taille: number, userId: string | null): Promise<{ id: string; jeton: Date } | null> {
  const maintenant = new Date();
  const lignes = await prisma.$queryRaw<{ id: string; updatedAt: Date }[]>`
    INSERT INTO "LecturePiece" ("id", "empreinte", "versionLecteur", "etat", "extension", "taille", "creeParId", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${empreinte}, ${VERSION_LECTEUR}, 'EN_COURS', ${ext}, ${taille}, ${userId},
            ${maintenant}::timestamptz AT TIME ZONE 'UTC', ${maintenant}::timestamptz AT TIME ZONE 'UTC')
    ON CONFLICT ("empreinte", "versionLecteur") DO NOTHING
    RETURNING "id", "updatedAt"`;
  const l = lignes[0];
  return l ? { id: l.id, jeton: l.updatedAt } : null;
}

/**
 * RETENTER une lecture qui n'est pas un acquis (`ECHOUEE`, ou `LUE` au texte indéchiffrable) :
 * seulement si la ligne est EXACTEMENT celle qu'on a lue — deux retentatives simultanées ne lisent
 * pas deux fois, la seconde trouve la ligne déjà reprise.
 */
async function retenter(ligne: Ligne, ext: string): Promise<{ id: string; jeton: Date } | null> {
  const jeton = new Date();
  const r = await prisma.lecturePiece.updateMany({
    where: { id: ligne.id, etat: ligne.etat, updatedAt: ligne.updatedAt },
    data: { etat: "EN_COURS", extension: ext, updatedAt: jeton },
  });
  return r.count === 1 ? { id: ligne.id, jeton } : null;
}

/**
 * REPRENDRE une réservation abandonnée — sous condition : encore `EN_COURS`, et encore périmée.
 * La première reprise rajeunit la ligne ; la seconde, qui l'avait lue périmée elle aussi, ne la
 * trouve plus telle et attend.
 */
async function reprendrePerimee(id: string, ext: string, limite: Date): Promise<{ id: string; jeton: Date } | null> {
  const jeton = new Date();
  const r = await prisma.lecturePiece.updateMany({
    where: { id, etat: "EN_COURS", updatedAt: { lt: limite } },
    data: { extension: ext, updatedAt: jeton },
  });
  return r.count === 1 ? { id, jeton } : null;
}

/**
 * LIRE et CONCLURE la tentative qu'on tient. `null` : la tentative ne nous appartient plus (on
 * l'a crue morte et quelqu'un l'a reprise) — rien n'est écrit, l'appelant attend l'issue de l'autre.
 */
async function lireEtConclure(
  tenue: { id: string; jeton: Date },
  args: { empreinte: string; octets: Buffer; ext: string; cloud: boolean; maxPages?: number },
  ocr: MoteurOcr | undefined,
): Promise<ResultatLecture | null> {
  // La tentative est encore la NÔTRE : toujours en cours, et sous notre jeton.
  const encoreLaNotre = { id: tenue.id, etat: "EN_COURS", updatedAt: tenue.jeton };
  let lu: LectureFichier;
  try {
    lu = await lireTexteOuOcr(args.ext, args.octets, { ocr, cloud: args.cloud, maxPages: args.maxPages });
  } catch (err) {
    // Le lecteur lui-même a planté : la tentative se conclut en échec — les appels qui l'attendent
    // sont libérés au lieu d'attendre une réservation que personne ne conclura —, et le suivant retentera.
    const r = await prisma.lecturePiece.updateMany({
      where: encoreLaNotre,
      data: {
        etat: "ECHOUEE", extension: args.ext, taille: args.octets.length, methode: null, moteur: null, confiance: null,
        aRelire: false, ocrTente: false, ocrEchoue: false, pagesLues: null, pagesTotal: null, caracteres: 0,
        tronque: false, texteScelle: null, updatedAt: new Date(),
      },
    });
    if (r.count === 0) return null;
    return { ok: false, code: "ECHEC", message: phraseEchec(err), lectureId: tenue.id };
  }

  // L'OCR a levé : on garde ce qui a été lu (le texte natif), mais ce n'est pas un acquis.
  const etat: "LUE" | "ECHOUEE" = lu.ocrEchoue ? "ECHOUEE" : "LUE";
  const faits = {
    extension: args.ext, taille: args.octets.length,
    methode: lu.methode, moteur: lu.moteur, confiance: lu.confiance, aRelire: lu.aRelire,
    ocrTente: lu.ocrTente, ocrEchoue: lu.ocrEchoue, pagesLues: lu.pagesLues, pagesTotal: lu.pagesTotal,
    caracteres: lu.texte.length, tronque: lu.tronque,
  };
  const r = await prisma.lecturePiece.updateMany({
    where: encoreLaNotre,
    data: { etat, ...faits, texteScelle: lu.texte ? sealSecret(lu.texte) : null, updatedAt: new Date() },
  });
  if (r.count === 0) return null;
  return {
    ok: true,
    lecture: {
      id: tenue.id, empreinte: args.empreinte, versionLecteur: VERSION_LECTEUR, etat, luParCetAppel: true,
      texte: lu.texte, raisonOcr: lu.raisonOcr, ...faits,
    },
  };
}

/**
 * LIRE CETTE PIÈCE, UNE FOIS. Rend la lecture conclue (la sienne, ou celle d'un autre appel), ou
 * dit pourquoi il n'y en a pas encore : une autre lecture en cours au-delà de l'attente, ou un
 * lecteur qui a planté. `cloud` n'autorise l'OCR externe que s'il vaut EXACTEMENT `true`.
 */
export async function lireFichierUneFois(
  args: { octets: Buffer; ext: string; cloud?: boolean; maxPages?: number; userId?: string | null },
  deps: DependancesLecture = {},
): Promise<ResultatLecture> {
  const ext = normaliserExtension(args.ext);
  const empreinte = empreinteDe(args.octets);
  const lecture = { empreinte, octets: args.octets, ext, cloud: args.cloud === true, maxPages: args.maxPages };
  const attenteMax = deps.attenteMaxMs ?? ATTENTE_MAX_MS;
  const perime = deps.perimeApresMs ?? PERIME_APRES_MS;
  const intervalle = deps.intervalleMs ?? INTERVALLE_MS;
  let debut = Date.now();
  // Vrai dès qu'on sait qu'une AUTRE tentative est en cours : son issue, quelle qu'elle soit, est
  // la nôtre — on ne la refait pas.
  let attendAutrui = false;

  let tenue = await reserver(empreinte, ext, args.octets.length, args.userId ?? null);
  for (;;) {
    if (tenue) {
      const issue = await lireEtConclure(tenue, lecture, deps.ocr);
      if (issue) return issue;
      // Dépossédé : quelqu'un d'autre lit cette pièce — l'attente de SON issue commence maintenant.
      tenue = null;
      attendAutrui = true;
      debut = Date.now();
      continue;
    }

    const ligne = await charger(empreinte);
    if (!ligne) {
      // La ligne a disparu entre-temps (purge) : on réserve à nouveau.
      tenue = await reserver(empreinte, ext, args.octets.length, args.userId ?? null);
      continue;
    }

    if (ligne.etat === "LUE") {
      const texte = ouvrir(ligne.texteScelle);
      if (texte !== null) return { ok: true, lecture: versLecture(ligne, texte, false, null) };
      if (attendAutrui) return { ok: false, code: "ECHEC", message: PHRASE_INDECHIFFRABLE, lectureId: ligne.id };
      tenue = await retenter(ligne, ext);
      if (tenue) continue;
      attendAutrui = true;
    } else if (ligne.etat === "ECHOUEE") {
      if (attendAutrui) {
        if (ligne.methode === null) return { ok: false, code: "ECHEC", message: PHRASE_ECHEC_PARTAGE, lectureId: ligne.id };
        return { ok: true, lecture: versLecture(ligne, ouvrir(ligne.texteScelle) ?? "", false, null) };
      }
      tenue = await retenter(ligne, ext);
      if (tenue) continue;
      attendAutrui = true;
    } else {
      attendAutrui = true;
      const limite = new Date(Date.now() - perime);
      if (ligne.updatedAt < limite) {
        tenue = await reprendrePerimee(ligne.id, ext, limite);
        if (tenue) continue;
      }
    }

    if (Date.now() - debut >= attenteMax) return { ok: false, code: "EN_COURS", message: PHRASE_EN_COURS, lectureId: ligne.id };
    await dormir(intervalle);
  }
}
