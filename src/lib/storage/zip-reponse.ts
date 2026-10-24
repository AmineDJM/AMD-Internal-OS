import { Readable } from "stream";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getBlob, cleObjetDirect } from "@/lib/drive-storage";
import { getObjectRange } from "@/lib/storage/object-storage";
import {
  debutDonneesEntree, ErreurZip, fluxEntreeZip, fluxOctets, listerZip, lireEntreeZip, sourceTampon,
  type EntreeZip, type SourceZip,
} from "@/lib/storage/zip-lecteur";
import { cleCacheApercu, lirePlage, passeParLeCache, serviePlages } from "@/lib/storage/zip-apercu-regles";
import { adresseApercu, apercuDisponible, assurerApercu, etatApercu } from "@/lib/storage/zip-apercu";
import { mimeFromName } from "@/lib/regulatory-drive-mirror";
import { contentDisposition } from "@/lib/http/content-disposition";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SERVIR UNE ENTRÉE D'ARCHIVE — la même réponse pour les documents (Regulatory…) et le Drive.
 *
 * « J'ai essayé d'ouvrir un fichier dans un dossier depuis Regulatory et aussi depuis le Drive, mais des fois ça
 * s'affiche comme ça : {"ok":false,"error":"Cette entrée est trop volumineuse…"} » (Direction, 06/10). Deux défauts :
 *   • une grosse entrée était REFUSÉE (au-delà de 200 Mo décompressés) : elle se sert maintenant EN FLUX, par plages,
 *     sans jamais tenir en mémoire (`fluxEntreeZip`) ;
 *   • un refus s'affichait en JSON brut dans l'aperçu : une demande d'ENTRÉE reçoit désormais une phrase lisible
 *     (`text/plain`), jamais du JSON.
 *
 * Puis « je ne veux pas ce ressenti d'expérience » (Direction, 06/10) — un PDF de 488 Mo s'affichait au bout de
 * longues secondes. Trois voies, de la plus rapide à la plus simple :
 *   1. grosse entrée COMPRESSÉE d'une archive du bucket → extraite une fois dans le bucket (`zip-apercu`), puis
 *      redirection vers une adresse signée : le bucket sert les plages, la première page s'affiche aussitôt ;
 *   2. entrée STOCKÉE d'une archive du bucket → c'est une tranche de l'archive : servie PAR PLAGES (206) ;
 *   3. le reste (petite entrée, archive chiffrée en base) → d'un bloc, ou en flux.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une archive stockée en base est lue en mémoire : on la borne (au-delà, elle est dans le bucket). */
export const MAX_ARCHIVE_EN_MEMOIRE = 400 * 1024 * 1024;
/** Au-delà, l'entrée se sert en flux plutôt que d'un bloc. */
const SEUIL_FLUX = 32 * 1024 * 1024;

/** Ces types s'exécuteraient dans notre origine s'ils étaient servis tels quels : on les montre en texte. */
const TYPES_ACTIFS = /\.(html?|xhtml|svg|xml|xsl|xslt)$/i;

/** Une archive, et — si elle est un objet DIRECT du bucket — sa clé (plages, cache d'aperçu). */
export interface SourceArchive extends SourceZip { cleObjet: string | null }

/** La source d'une archive à partir de son blob : par plages dans le bucket, sinon en mémoire (bornée). */
export async function sourceDuBlob(blobId: string, taille: number): Promise<SourceArchive | { erreur: string; status: number }> {
  const cle = await cleObjetDirect(blobId);
  if (cle) return { taille, cleObjet: cle, lire: (debut, longueur) => getObjectRange(cle, debut, longueur) };
  if (taille > MAX_ARCHIVE_EN_MEMOIRE) {
    return { erreur: `Archive trop volumineuse pour l'aperçu (${Math.round(taille / 1024 / 1024)} Mo). Téléchargez-la pour l'ouvrir.`, status: 413 };
  }
  const octets = await getBlob(blobId);
  if (!octets) return { erreur: "Contenu indisponible.", status: 404 };
  return { ...sourceTampon(octets), cleObjet: null };
}

/** La source d'une archive déposée comme `Document` (sa clé de stockage). */
export async function sourceDuFichierStocke(fileKey: string): Promise<SourceArchive | { erreur: string; status: number }> {
  const stocke = await prisma.storedFile.findUnique({ where: { key: fileKey }, select: { blobId: true, size: true } });
  if (!stocke) return { erreur: "Contenu indisponible.", status: 404 };
  return sourceDuBlob(stocke.blobId, stocke.size);
}

/**
 * La table des matières, MÉMORISÉE pour une archive du bucket (un objet ne change jamais sous sa clé) : l'aperçu
 * d'une entrée enchaîne les requêtes (préparation, plages du lecteur PDF) — relire à chaque fois le répertoire
 * central d'une archive CTD de dix mille entrées coûterait plus que l'entrée elle-même.
 */
const tables = new Map<string, { at: number; table: Promise<{ entrees: EntreeZip[]; tronque: boolean }> }>();
const TABLE_TTL_MS = 10 * 60_000;
export function listerArchive(source: SourceArchive): Promise<{ entrees: EntreeZip[]; tronque: boolean }> {
  if (!source.cleObjet) return listerZip(source);
  const cle = source.cleObjet;
  const connue = tables.get(cle);
  if (connue && Date.now() - connue.at < TABLE_TTL_MS) return connue.table;
  const table = listerZip(source);
  tables.set(cle, { at: Date.now(), table });
  table.catch(() => tables.delete(cle));
  if (tables.size > 20) tables.delete(tables.keys().next().value as string);
  return table;
}

/** Un refus lisible DANS l'aperçu (une iframe montre du texte, pas un objet JSON). */
export function refusLisible(message: string, status: number): Response {
  return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

const nomDe = (entree: EntreeZip) => entree.chemin.split("/").pop() || "fichier";
const typeDe = (nom: string) => (TYPES_ACTIFS.test(nom) ? "text/plain; charset=utf-8" : mimeFromName(nom));

/** UNE entrée — en ligne, ou en pièce jointe (`dl`) ; `plage` = l'en-tête `Range` de la requête. */
export async function reponseEntreeZip(source: SourceArchive, entree: EntreeZip, dl: boolean, plage: string | null = null): Promise<Response> {
  const nom = nomDe(entree);
  const type = typeDe(nom);
  const headers: Record<string, string> = {
    "Content-Type": type,
    // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
    ...entetesAntiExecution(type),
    "Content-Disposition": contentDisposition(nom, dl ? "attachment" : "inline"),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };

  // 1. Grosse entrée compressée : servie par le bucket, après UNE extraction. Un téléchargement n'attend pas
  //    l'extraction (il part en flux), mais profite d'une extraction déjà faite (reprise possible).
  if (passeParLeCache(source.cleObjet, entree)) {
    const cle = cleCacheApercu(source.cleObjet!, entree);
    try {
      if (!dl) await assurerApercu(cle, source, entree, type);
      if (!dl || (await apercuDisponible(cle, entree.taille))) {
        const url = adresseApercu(cle, nom, type, dl);
        if (url) return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
      }
    } catch (e) {
      if (e instanceof ErreurZip) throw e;
      // Panne du stockage : l'aperçu ne doit pas en dépendre — on retombe sur le flux.
    }
  }

  // 2. Entrée stockée d'une archive du bucket : une tranche de l'archive, servie par plages.
  if (serviePlages(source.cleObjet, entree)) {
    if (entree.chiffree) throw new ErreurZip("Cette entrée est protégée par un mot de passe — téléchargez l'archive pour l'ouvrir.");
    const p = lirePlage(plage, entree.taille);
    if (p === "hors-limites") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${entree.taille}`, "Cache-Control": "private, no-store" } });
    }
    const debut = await debutDonneesEntree(source, entree);
    const [de, longueur] = p ? [p.debut, p.fin - p.debut + 1] : [0, entree.taille];
    const flux = fluxOctets(source, debut + de, longueur);
    return new Response(Readable.toWeb(flux) as unknown as ReadableStream<Uint8Array>, {
      status: p ? 206 : 200,
      headers: {
        ...headers, "Accept-Ranges": "bytes", "Content-Length": String(longueur),
        ...(p ? { "Content-Range": `bytes ${p.debut}-${p.fin}/${entree.taille}` } : {}),
      },
    });
  }

  // 3. D'un bloc si elle est petite, en flux sinon.
  if (entree.taille <= SEUIL_FLUX) {
    const octets = await lireEntreeZip(source, entree);
    return new Response(new Uint8Array(octets), { headers: { ...headers, "Content-Length": String(octets.length) } });
  }
  const flux = await fluxEntreeZip(source, entree);
  return new Response(Readable.toWeb(flux) as unknown as ReadableStream<Uint8Array>, { headers: { ...headers, "Content-Length": String(entree.taille) } });
}

/**
 * PRÉCHAUFFAGE (`?prechauffer=1`) — la visionneuse le demande au SURVOL et à la sélection d'une grosse entrée :
 * l'extraction démarre avant même le clic. Réponse JSON :
 *  - 202 `{ pret: false, octets, total }` : extraction en cours (la visionneuse affiche la progression) ;
 *  - 200 `{ pret: true }` : l'aperçu peut se charger (prêt, sans objet, ou en échec — l'entrée dira alors pourquoi).
 */
export async function reponsePrechauffage(source: SourceArchive, entree: EntreeZip): Promise<Response> {
  const sansCache = { "Cache-Control": "private, no-store" };
  if (entree.dossier || !passeParLeCache(source.cleObjet, entree)) return NextResponse.json({ ok: true, pret: true }, { headers: sansCache });
  const etat = await etatApercu(cleCacheApercu(source.cleObjet!, entree), source, entree, typeDe(nomDe(entree)));
  if (etat.pret || etat.echec) return NextResponse.json({ ok: true, pret: true }, { headers: sansCache });
  return NextResponse.json({ ok: true, pret: false, octets: etat.octets, total: etat.total }, { status: 202, headers: sansCache });
}
