import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enSerie } from "@/lib/refs";
import { disponibiliteLecturePieces, synthetiserDocumentLegal, CARACTERES_MIN } from "@/lib/lecture-pieces-ia";
import { lireFichierUneFois, type LectureDePiece } from "@/lib/pieces-lues/lecture-fichier";
import { moteurLuna } from "@/lib/pieces-lues/moteur-luna";
import { moteurParDefaut } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import { repererEntetes } from "@/lib/pieces-lues/entetes";
import { identiteEmetteurDuTexte, type IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";
import { candidatsFournisseur, normaliserNif, type IdentifiantsDuGroupe } from "@/lib/pieces-lues/fournisseur";
import { noteDeMethode, refusFormatDePiece, refusTailleDePiece } from "@/lib/pieces-lues/phrases";
import { annuaireDeLecture } from "@/lib/pieces-lues/service";
import { FORMATS_LUS, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/formats";
import { syntheseGardee, type NatureLegaleLue, type SyntheseLegale } from "@/lib/pieces-lues/synthese-legale";
import { phraseDeLecture, preremplirDocumentLegal, type EtatLuna, type PrerempliDocumentLegal } from "@/lib/pieces-lues/prerempli-document-legal";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { libelleAmont } from "@/lib/queries/legal-chain";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE LA PIÈCE D'UN NOUVEAU DOCUMENT LEGAL — pour préremplir sa saisie. Serveur.
 *
 * Le même lecteur que les pièces commerciales (`lireFichierUneFois` : une fois par empreinte, Luna
 * pour un scan quand la pièce peut sortir, le moteur local sinon), le même repérage (`entetes.ts`),
 * le même annuaire (`annuaireDeLecture`). Ce qui change, c'est ce qu'on demande au modèle : pas des
 * lignes, que n'ont ni un contrat ni un bail, mais la synthèse d'un document légal
 * (`synthetiserDocumentLegal`). Elle se GARDE sur la lecture, comme les lignes : une fois par
 * empreinte, la première fait foi — rouvrir la même pièce ne coûte rien et ne renvoie rien.
 *
 * ── CE QUI NE SORT PAS DE L'ERP ─────────────────────────────────────────────────────────────
 *
 * La personne dit, AVANT la lecture, que la pièce est confidentielle : ses lecteurs se choisissent
 * dans le formulaire, qui ne s'ouvre qu'après. Confidentielle, rien ne part — ni le scan vers Luna,
 * ni le texte vers le modèle —, et une synthèse gardée pour les MÊMES octets dans un autre contexte
 * n'est pas montrée non plus : « lecture locale seulement » se dit, et se tient.
 *
 * Rien n'est écrit dans une table métier : la seule écriture est le cache de la lecture.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LectureDocumentLegal {
  nomFichier: string;
  empreinte: string;
  /** Comment la pièce a été lue — la phrase en tête du formulaire. */
  phrase: string;
  /** La coupe du texte montré à Luna, quand il y en a eu une. */
  coupe: string | null;
  prerempli: PrerempliDocumentLegal;
}

export type ResultatLectureDocument = { ok: true; lecture: LectureDocumentLegal } | { ok: false; error: string };

const NOM_MAX = 200;
const PHRASE_VIDE = "Fichier vide : il n'y a rien à lire.";

function extensionDe(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i >= 0 ? nom.slice(i + 1).trim().toLowerCase() : "";
}

/** Les raisons sociales du groupe, pour que Luna nomme l'AUTRE partie — jamais l'une des nôtres. */
async function nosSocietes(): Promise<string[]> {
  const societes = await prisma.company.findMany({
    where: { isActive: true },
    select: { name: true, shortName: true, legalIdentity: { select: { legalName: true } } },
  });
  return [...new Set(societes.flatMap((s) => [s.name, s.shortName, s.legalIdentity?.legalName]).filter((n): n is string => Boolean(n?.trim())))];
}

/** La synthèse : gardée, demandée à Luna, ou absente — et pourquoi. */
async function syntheseDe(
  l: LectureDePiece,
  e: { confidentielle: boolean; nomFichier: string; noteMethode: string; userId: string },
): Promise<{ synthese: SyntheseLegale | null; luna: EtatLuna; erreur: string | null; coupe: string | null }> {
  if (l.ocrEchoue || l.texte.replace(/\s+/g, "").length < CARACTERES_MIN) return { synthese: null, luna: "ILLISIBLE", erreur: null, coupe: null };
  if (e.confidentielle) return { synthese: null, luna: "CONFIDENTIELLE", erreur: null, coupe: null };
  return enSerie(`lecture-legale-modele:${l.id}`, async () => {
    const ligne = await prisma.lecturePiece.findUnique({ where: { id: l.id }, select: { syntheseLegale: true } });
    const gardee = syntheseGardee(ligne?.syntheseLegale ?? null);
    // Une synthèse FAITE est un acquis : la servir ne coûte rien et n'envoie rien, même si la lecture a été coupée depuis.
    if (gardee) return { synthese: gardee, luna: "LUE" as const, erreur: null, coupe: null };
    const r = await synthetiserDocumentLegal({
      texte: l.texte, noteMethode: e.noteMethode, nomFichier: e.nomFichier, confidentielle: false, userId: e.userId,
      nosSocietes: await nosSocietes(),
    });
    if (!r.ok) {
      const luna: EtatLuna = r.raison === "IA_COUPEE" || r.raison === "DESACTIVEE" || r.raison === "NON_CONFIGUREE" ? r.raison : "ECHEC";
      return { synthese: null, luna, erreur: r.error, coupe: null };
    }
    // GARDÉE SOUS CONDITION : la première fait foi, une seconde ne l'écrase pas.
    const ecrite = await prisma.lecturePiece.updateMany({
      where: { id: l.id, etat: "LUE", syntheseLegale: { equals: Prisma.DbNull } },
      data: { syntheseLegale: r.synthese as unknown as Prisma.InputJsonValue, synthesePar: r.modele ?? "modèle non nommé" },
    }).catch((err) => { console.error("[document légal] synthèse non gardée (non bloquant)", l.id, err); return { count: 0 }; });
    const synthese = ecrite.count === 1
      ? r.synthese
      : syntheseGardee((await prisma.lecturePiece.findUnique({ where: { id: l.id }, select: { syntheseLegale: true } }))?.syntheseLegale ?? null) ?? r.synthese;
    return { synthese, luna: "LUE" as const, erreur: null, coupe: r.coupe?.phrase ?? null };
  });
}

/**
 * LE BON DE COMMANDE QUE LA FACTURE CITE (« Réf. votre BC n° … ») — dans le périmètre Legal de la personne, et UN
 * seul : deux BC du même numéro, et rien n'est choisi.
 */
async function bcCite(user: CurrentUser, numeros: string[]): Promise<{ id: string; label: string; numero: string } | null> {
  if (numeros.length === 0) return null;
  const { where } = await perimetreLegal(user);
  if (!where) return null;
  const trouves = await prisma.legalDocument.findMany({
    where: {
      AND: [where, {
        kind: "PURCHASE_ORDER", status: { not: "CANCELLED" },
        OR: numeros.map((n) => ({ reference: { equals: n, mode: "insensitive" as const } })),
      }],
    },
    select: { id: true, kind: true, reference: true, title: true },
    take: 2,
  });
  if (trouves.length !== 1) return null;
  const [bc] = trouves;
  return { id: bc.id, label: libelleAmont({ kind: String(bc.kind), reference: bc.reference, title: bc.title }), numero: bc.reference ?? numeros[0] };
}

/** L'émetteur n'est l'une de nos sociétés que par son NIF — un nom ne le prouve pas. */
const emetteurDuGroupe = (emetteur: IdentiteEmetteur, groupe: IdentifiantsDuGroupe): boolean => {
  const nif = normaliserNif(emetteur.nif);
  return Boolean(nif && (groupe.nifs ?? []).map(normaliserNif).includes(nif));
};

export async function lireDocumentLegal(args: {
  user: CurrentUser;
  octets: Buffer;
  nomFichier: string;
  confidentielle: boolean;
  natureImposee: NatureLegaleLue | null;
}): Promise<ResultatLectureDocument> {
  const { user, octets } = args;
  const nomFichier = (args.nomFichier ?? "").trim().slice(0, NOM_MAX);
  const ext = extensionDe(nomFichier);
  if (!(FORMATS_LUS as readonly string[]).includes(ext)) return { ok: false, error: refusFormatDePiece(ext, FORMATS_LUS) };
  if (octets.length === 0) return { ok: false, error: PHRASE_VIDE };
  if (octets.length > TAILLE_MAX_OCTETS) return { ok: false, error: refusTailleDePiece(octets.length, TAILLE_MAX_OCTETS) };

  // UN SCAN SE LIT PAR LUNA (§118.200) quand la pièce peut sortir et que la lecture par l'IA est ouverte ; sinon par
  // le moteur LOCAL — jamais par un OCR externe.
  const parLuna = !args.confidentielle && (await disponibiliteLecturePieces()).disponible;
  const lu = await lireFichierUneFois({ octets, ext, cloud: false, maxPages: PAGES_MAX, userId: user.id },
    parLuna ? { ocr: moteurLuna(moteurParDefaut) } : {});
  if (!lu.ok) return { ok: false, error: lu.message };
  const l = lu.lecture;

  const entetes = repererEntetes(l.texte);
  const emetteur = identiteEmetteurDuTexte(l.texte);
  const noteMethode = noteDeMethode({
    methode: l.methode, confiance: l.confiance, aRelire: l.aRelire, ocrTente: l.ocrTente, ocrEchoue: l.ocrEchoue,
    raisonOcr: l.raisonOcr, pagesLues: l.pagesLues, pagesTotal: l.pagesTotal, tronque: l.tronque, moteur: l.moteur, caracteres: l.caracteres,
  });
  const [s, { annuaireVisible, groupe }] = await Promise.all([
    syntheseDe(l, { confidentielle: args.confidentielle, nomFichier, noteMethode, userId: user.id }),
    annuaireDeLecture(user.id),
  ]);

  // LA PARTIE EN FACE : tous les identifiants lus (règles, émetteur, Luna) — l'annuaire tranche, le groupe est écarté.
  const duGroupe = emetteurDuGroupe(emetteur, groupe);
  const fournisseur = candidatsFournisseur({
    nom: s.synthese?.contrepartie.nom ?? (duGroupe ? null : emetteur.nom),
    nifs: [s.synthese?.contrepartie.nif ?? null, emetteur.nif, ...entetes.nif.map((r) => r.valeur)],
    rcs: [s.synthese?.contrepartie.rc ?? null, emetteur.rc, ...entetes.rc.map((r) => r.valeur)],
  }, annuaireVisible, groupe);

  const facture = args.natureImposee === "INVOICE" || entetes.type === "FACTURE";
  const numerosBc = facture ? [...new Set(entetes.references.filter((r) => r.type === "BON_DE_COMMANDE").map((r) => r.numero))] : [];

  const prerempli = preremplirDocumentLegal({
    entetes, synthese: s.synthese, emetteur, fournisseur, groupe,
    bcSuivi: await bcCite(user, numerosBc),
    natureImposee: args.natureImposee,
  });
  return {
    ok: true,
    lecture: {
      nomFichier,
      empreinte: l.empreinte,
      phrase: phraseDeLecture({ scan: l.methode === "ocr", parLuna, luna: s.luna, erreurLuna: s.erreur }),
      coupe: s.coupe,
      prerempli,
    },
  };
}
