import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/http/content-disposition";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { extensionDejaCompressee, lireQualite, type EstimationTelechargement, type Qualite } from "@/lib/compression/politique";
import { obtenirReduction } from "@/lib/compression/reduction-cache";
import { ecrireZip, enFluxWeb, ErreurZipLimite, LIMITE_ZIP_OCTETS, type EntreeZip, type NiveauZip } from "@/lib/compression/zip-ecriture";

/**
 * LA PORTE UNIQUE DU TÉLÉCHARGEMENT — le seul endroit qui lit `?qualite=` et le seul qui décide
 * de ce que reçoit le navigateur (§118.58 : l'endroit où TOUTES les instances passent).
 *
 *   ?qualite=max      (défaut) l'ORIGINAL : exactement les octets déposés. Sans le paramètre,
 *                     rien ne change pour personne — liens, aperçus, favoris, e-mails.
 *   ?qualite=reduite  la version « taille réduite », SI elle existe et est réellement plus petite ;
 *                     sinon l'original, avec `X-Qualite: max` — jamais une erreur, jamais un gonflement.
 *   ?qualite=estimer  JSON : tailles réelles des deux versions (ce que lit le bouton avant d'offrir le choix).
 *
 * Les DROITS ne se jouent pas ici : la route les a vérifiés avant d'appeler la porte, avec ses
 * règles propres, et les mêmes pour les trois qualités. La version réduite n'ajoute aucun accès.
 */

export interface FichierServi {
  nom: string;
  mime: string;
  /** Octets de l'ORIGINAL (décompressés si stockés compressés). `null` : introuvable. */
  charger: () => Promise<Buffer | null>;
  /** Empreinte SHA-256 de l'original (`FileBlob.sha256`), quand on la connaît : rendue en en-tête, et clé du cache. */
  empreinte?: string | null;
  /** Taille connue sans lire (base) — le profil statique est jugé avec, avant de charger. */
  taille?: number | null;
}

export interface OptionsPorte {
  qualite: Qualite;
  /** `dl=1` : téléchargement ; sinon aperçu en ligne (l'original, toujours). */
  telecharger: boolean;
  /** Appelé une fois, juste avant la réponse, avec la qualité RÉELLEMENT servie — c'est ce qu'on trace à l'audit. */
  journaliser?: (qualiteServie: "max" | "reduite") => Promise<void> | void;
  /** En-têtes propres à la route (ex. `Cache-Control: private, no-store`). */
  entetes?: Record<string, string>;
  /** Fichier volumineux déposé en direct : adresse signée vers le bucket. L'original SEUL (il ne transite pas par ce serveur). */
  redirection?: () => string | null;
  /** `false` : jamais de version réduite pour cette pièce (pièce juridique, signée…) — la raison s'affiche. */
  reductionAutorisee?: { oui: true } | { oui: false; raison: string };
}

/** Lit `?qualite=` — la seule lecture du paramètre dans tout le dépôt (un cliquet le tient). */
export function qualiteDeLaRequete(req: { nextUrl: { searchParams: URLSearchParams } }): Qualite {
  return lireQualite(req.nextUrl.searchParams.get("qualite"));
}

export async function repondreFichier(f: FichierServi, o: OptionsPorte): Promise<NextResponse> {
  const autorise = o.reductionAutorisee ?? { oui: true as const };
  const directRedirect = o.redirection?.() ?? null;

  // ───── estimer : les tailles réelles, pour que le bouton n'offre que ce qui existe
  if (o.qualite === "estimer") {
    const taille = f.taille ?? 0;
    const nonReduite = (raison: string, tailleMax = taille): NextResponse =>
      NextResponse.json({ max: { taille: tailleMax, nom: f.nom }, reduite: null, raison } satisfies EstimationTelechargement, { headers: { "Cache-Control": "private, no-store" } });
    if (!autorise.oui) return nonReduite(autorise.raison);
    if (directRedirect) return nonReduite("Fichier volumineux déposé directement : original seulement.");
    const r = await obtenirReduction({ empreinte: f.empreinte ?? null, nom: f.nom, mime: f.mime, taille: f.taille ?? null, charger: f.charger }, { avecOctets: false });
    if (!r.ok) return nonReduite(r.raison);
    const original = f.taille ?? 0;
    const body: EstimationTelechargement = {
      max: { taille: original, nom: f.nom },
      reduite: { taille: r.octets.length, nom: r.nom, gain: original > 0 ? 1 - r.octets.length / original : 0, methode: r.methode },
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
  }

  // ───── réduite : seulement si elle existe ; sinon l'original, dit
  if (o.qualite === "reduite" && autorise.oui && !directRedirect) {
    const r = await obtenirReduction({ empreinte: f.empreinte ?? null, nom: f.nom, mime: f.mime, taille: f.taille ?? null, charger: f.charger }, { avecOctets: true });
    if (r.ok) {
      await o.journaliser?.("reduite");
      return new NextResponse(new Uint8Array(r.octets), {
        headers: {
          "Content-Type": r.mime,
          "Content-Disposition": contentDisposition(r.nom, o.telecharger ? "attachment" : "inline"),
          ...entetesAntiExecution(r.mime),
          "Content-Length": String(r.octets.length),
          "X-Qualite": "reduite",
          "X-Reduction": encodeURIComponent(r.methode),
          ...(f.taille ? { "X-Taille-Originale": String(f.taille) } : {}),
          "Cache-Control": "private, no-store",
          ...o.entetes,
        },
      });
    }
    // Pas de version réduite : on sert l'original (ci-dessous) et on le dit.
    return servirOriginal(f, o, directRedirect, { "X-Qualite-Raison": encodeURIComponent(r.raison) });
  }

  return servirOriginal(f, o, directRedirect, {});
}

async function servirOriginal(f: FichierServi, o: OptionsPorte, directRedirect: string | null, extra: Record<string, string>): Promise<NextResponse> {
  if (directRedirect) {
    await o.journaliser?.("max");
    return NextResponse.redirect(directRedirect, { status: 302, headers: { "Cache-Control": "private, no-store" } });
  }
  const octets = await f.charger();
  if (!octets) return new NextResponse(null, { status: 404 });
  await o.journaliser?.("max");
  return new NextResponse(new Uint8Array(octets), {
    headers: {
      "Content-Type": f.mime,
      "Content-Disposition": contentDisposition(f.nom, o.telecharger ? "attachment" : "inline"),
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(f.mime),
      "Content-Length": String(octets.length),
      "X-Qualite": "max",
      // L'empreinte du fichier d'origine : qui reçoit les octets peut vérifier qu'ils sont ceux qui ont été déposés.
      ...(f.empreinte ? { "X-Empreinte-SHA256": f.empreinte } : {}),
      ...extra,
      ...o.entetes,
    },
  });
}

// ─────────────────────────────── archives : dossier, sélection ──────────────────────────────

/**
 * Une archive ZIP streamée. `max` = AUCUNE compression (chaque fichier, octet pour octet) ;
 * `reduite` = deflate 9 sans gonflement. `estimer` n'a de sens que pour l'appelant, qui sait ce
 * que l'archive contient : il passe par `repondreEstimationArchive`.
 */
export async function repondreArchive(
  nomArchive: string,
  entrees: AsyncIterable<EntreeZip> | Iterable<EntreeZip>,
  qualite: Qualite,
  opts: { journaliser?: (q: "max" | "reduite") => Promise<void> | void; octetsTotal?: number } = {},
): Promise<NextResponse> {
  const niveau: NiveauZip = qualite === "reduite" ? "max" : "stocke";
  if (opts.octetsTotal !== undefined && opts.octetsTotal > LIMITE_ZIP_OCTETS) {
    return NextResponse.json({ error: "Sélection trop volumineuse pour une archive (4 Go au plus). Téléchargez par sous-dossiers." }, { status: 413 });
  }
  await opts.journaliser?.(qualite === "reduite" ? "reduite" : "max");
  const flux = enFluxWeb(ecrireZip(entrees, niveau));
  return new NextResponse(flux, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(nomArchive, "attachment"),
      "X-Qualite": qualite === "reduite" ? "reduite" : "max",
      "Cache-Control": "private, no-store",
    },
  });
}

/** Au-delà, compresser le dossier pour en MESURER la taille coûterait presque autant que le téléchargement : on dit « taille non estimée ». */
const MAX_ESTIMATION_ARCHIVE = 128 * 1024 * 1024;
const TTL_ESTIMATION_MS = 15 * 60_000;
const estimations = new Map<string, { taille: number; expire: number }>();

/** Surcoût EXACT d'une archive « stockée » : en-tête local + entrée centrale par fichier, plus la fin. */
export function surcoutZip(noms: string[]): number {
  return 22 + noms.reduce((s, n) => s + 30 + 46 + 2 * Buffer.byteLength(n, "utf8"), 0);
}

/**
 * `?qualite=estimer` pour une ARCHIVE. L'original (qualité maximale, non compressé) a une taille
 * exacte, connue sans rien lire. La version réduite n'est offerte que si au moins un fichier peut
 * rétrécir (les JPEG, ZIP, DOCX, MP4… ne le peuvent pas) ; sa taille n'est mesurée — en compressant
 * pour de bon — que sous 128 Mo, sinon elle est dite « non estimée ».
 */
export async function repondreEstimationArchive(a: {
  nomArchive: string;
  noms: string[];
  octetsTotal: number;
  /** Identifiant stable du contenu (les blobs, dans l'ordre) : deux estimations du même contenu n'en font qu'une. */
  cle: string;
  entrees: () => AsyncIterable<EntreeZip>;
}): Promise<NextResponse> {
  const max = { taille: a.octetsTotal + surcoutZip(a.noms), nom: a.nomArchive };
  const entetes = { "Cache-Control": "private, no-store" };
  if (a.noms.every(extensionDejaCompressee)) {
    return NextResponse.json({ max, reduite: null, raison: "Déjà optimisé : ces fichiers sont déjà compressés." } satisfies EstimationTelechargement, { headers: entetes });
  }
  const base = { nom: a.nomArchive, methode: "archive ZIP compressée (deflate 9)" };
  if (a.octetsTotal > MAX_ESTIMATION_ARCHIVE) {
    return NextResponse.json({ max, reduite: { ...base, taille: null, gain: null } } satisfies EstimationTelechargement, { headers: entetes });
  }
  const connue = estimations.get(a.cle);
  let taille: number;
  if (connue && connue.expire > Date.now()) taille = connue.taille;
  else {
    taille = 0;
    for await (const b of ecrireZip(a.entrees(), "max")) taille += b.length;
    estimations.set(a.cle, { taille, expire: Date.now() + TTL_ESTIMATION_MS });
    if (estimations.size > 200) estimations.delete(estimations.keys().next().value as string);
  }
  // Même exigence que pour un fichier : une version « réduite » qui n'économise pas 10 % n'est pas offerte.
  if (taille > max.taille * 0.9) {
    return NextResponse.json({ max, reduite: null, raison: "Déjà optimisé : la compression n'économiserait presque rien." } satisfies EstimationTelechargement, { headers: entetes });
  }
  return NextResponse.json({ max, reduite: { ...base, taille, gain: 1 - taille / max.taille } } satisfies EstimationTelechargement, { headers: entetes });
}

export { ErreurZipLimite };
