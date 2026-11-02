/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DOCUMENTS LONGS, VUS D'ADAM — lire un PDF de cinq cents pages (natif, puis OCR sur les
 * pages qui le demandent), et construire un deck vérifié dans le Drive.
 *
 * Même dessein que `sheets.ts` : résoudre la cible par le port (donc sous `canViewDrive`),
 * appeler les modules purs (`artifact/pdf/read.ts`, `artifact/decks/build.ts`), et porter ici la
 * seule logique qui connaît l'infrastructure — le moteur d'OCR de l'ERP.
 *
 * ── L'OCR, BORNÉ ET DIT ─────────────────────────────────────────────────────────────────
 *
 * Une page scannée coûte deux à cinq secondes de Tesseract (ou un appel Mistral). On n'océrise
 * que les pages DEMANDÉES qui n'ont pas de texte natif, dans une limite par appel
 * (`OCR_PAGES_MAX`), et la réponse dit ce qui a été océrisé, ce qui ne l'a pas été, et avec
 * quelle confiance. Les pages sont EXTRAITES dans un PDF autonome avant l'OCR : on n'envoie
 * jamais les cinq cents pages pour en lire trois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { CurrentUser } from "@/lib/session";
import type { FicheDocument } from "@/lib/artifact/ports";
import { chercherDansPdf, extrairePages, lireTextePdf, planPdf, type PageTexte } from "@/lib/artifact/pdf/read";
import { construireDeckVerifie, type SpecDeck, type VerificationDeck } from "@/lib/artifact/decks/build";
import { MIME_PPTX } from "@/lib/artifact/adapters/pptx/adapter";
import { ocrDocument } from "@/lib/regulatory/intelligence/ocr/ocr-engine";
import { portsArtefact } from "@/platform/ia/artifact/ports";

export const OCR_PAGES_MAX = 12;

export type Resolution = { ok: true; fiche: FicheDocument; version: number } | { ok: false; motif: string; candidats?: { nodeId: string; nom: string; format: string | null }[] };

export async function resoudrePdf(user: CurrentUser, cible: { nodeId?: string | null; nom?: string | null; version?: number | null }): Promise<Resolution> {
  const estPdf = (f: FicheDocument) => f.format === "PDF" || /\.pdf$/i.test(f.nom);
  if (cible.nodeId) {
    const fiche = await portsArtefact.documents.decrire(user.id, cible.nodeId);
    if (!fiche) return { ok: false, motif: "Ce document n'existe pas, ou vous n'y avez pas accès." };
    if (!estPdf(fiche)) return { ok: false, motif: `« ${fiche.nom} » n'est pas un PDF.` };
    return { ok: true, fiche, version: cible.version ?? fiche.version };
  }
  const nom = (cible.nom ?? "").trim();
  if (!nom) return { ok: false, motif: "Dites-moi quel PDF : son nom, ou son identifiant Drive." };
  const trouves = (await portsArtefact.documents.chercher(user.id, nom, 8)).filter(estPdf);
  if (trouves.length === 0) return { ok: false, motif: `Aucun PDF nommé « ${nom} » dans ce que vous pouvez voir.` };
  const exact = trouves.filter((f) => f.nom.toLowerCase() === nom.toLowerCase() || f.nom.toLowerCase().replace(/\.pdf$/i, "") === nom.toLowerCase());
  const retenu = exact.length === 1 ? exact[0] : trouves.length === 1 ? trouves[0] : null;
  if (!retenu) return { ok: false, motif: `${trouves.length} PDF correspondent à « ${nom} » : lequel ?`, candidats: trouves.map((f) => ({ nodeId: f.nodeId, nom: f.nom, format: f.format })) };
  return { ok: true, fiche: retenu, version: cible.version ?? retenu.version };
}

export type PageLue = Omit<PageTexte, "methode"> & {
  methode: "natif" | "vide" | "ocr";
  /** Confiance du moteur d'OCR (0–100) quand la page a été océrisée. */
  confiance?: number;
};

/**
 * LIT un PDF : le texte natif des pages demandées, puis l'OCR des pages muettes (au plus
 * `OCR_PAGES_MAX` par appel, si `ocr` n'est pas désactivé). Ou CHERCHE une expression dans tout
 * le document. Ou rend le PLAN.
 */
export async function lirePdfDrive(
  user: CurrentUser,
  cible: { nodeId?: string | null; nom?: string | null; version?: number | null },
  demande: { mode: "lire" | "chercher" | "plan"; pages?: string | number[] | null; requete?: string | null; ocr?: boolean; max?: number },
): Promise<
  | { ok: false; motif: string; candidats?: { nodeId: string; nom: string; format: string | null }[] }
  | { ok: true; document: { nodeId: string; nom: string; version: number; pages: number }; mode: "lire"; pages: PageLue[]; sansTexte: number[]; ocr: { faites: number[]; nonFaites: number[]; moteur: string | null }; tronque: boolean; ms: number }
  | { ok: true; document: { nodeId: string; nom: string; version: number; pages: number }; mode: "chercher"; occurrences: { page: number; extrait: string }[]; pagesTouchees: number[]; pagesSansTexte: number; tronque: boolean; ms: number }
  | { ok: true; document: { nodeId: string; nom: string; version: number; pages: number }; mode: "plan"; plan: { titre: string; page: number | null; niveau: number }[] }
> {
  const r = await resoudrePdf(user, cible);
  if (!r.ok) return r;
  const octets = await portsArtefact.documents.lire(user.id, r.fiche.nodeId, r.version);
  if (!octets) return { ok: false, motif: `Impossible de lire « ${r.fiche.nom} » (version ${r.version}).` };
  const doc = (pages: number) => ({ nodeId: r.fiche.nodeId, nom: r.fiche.nom, version: r.version, pages });

  if (demande.mode === "plan") {
    const p = await planPdf(octets);
    return { ok: true, document: doc(p.total), mode: "plan", plan: p.entrees };
  }
  if (demande.mode === "chercher") {
    const c = await chercherDansPdf(octets, demande.requete ?? "", { max: demande.max ?? 30 });
    return { ok: true, document: doc(c.total), mode: "chercher", occurrences: c.occurrences, pagesTouchees: c.pagesTouchees, pagesSansTexte: c.pagesSansTexte, tronque: c.tronque, ms: c.ms };
  }

  const debut = Date.now();
  const lecture = await lireTextePdf(octets, { pages: demande.pages, max: demande.max ?? 40 });
  const pages: PageLue[] = lecture.pages.map((p) => ({ ...p }));
  const ocr = { faites: [] as number[], nonFaites: [] as number[], moteur: null as string | null };
  if (demande.ocr !== false && lecture.sansTexte.length > 0) {
    const aFaire = lecture.sansTexte.slice(0, OCR_PAGES_MAX);
    ocr.nonFaites = lecture.sansTexte.slice(OCR_PAGES_MAX);
    try {
      const sous = await extrairePages(octets, aFaire);
      const resultat = await ocrDocument({ ext: "pdf", buffer: sous, maxPages: aFaire.length });
      ocr.moteur = resultat.engine;
      resultat.pages.forEach((op, i) => {
        const n = aFaire[i];
        const cible = pages.find((p) => p.n === n);
        if (!cible) return;
        if (op.text.trim()) { cible.texte = op.text.trim(); cible.caracteres = cible.texte.length; cible.methode = "ocr"; cible.confiance = op.confidence; ocr.faites.push(n); }
        else ocr.nonFaites.push(n);
      });
    } catch (e) {
      console.error("[pdf_read] OCR indisponible :", e instanceof Error ? e.message : e);
      ocr.nonFaites = [...aFaire, ...ocr.nonFaites];
    }
  }
  return { ok: true, document: doc(lecture.total), mode: "lire", pages, sansTexte: lecture.sansTexte, ocr, tronque: lecture.tronque, ms: Date.now() - debut };
}

/** CONSTRUIT un deck vérifié et l'écrit dans le Drive personnel — rien n'est écrit si la vérification échoue. */
export async function construireDeckDrive(
  user: CurrentUser, opts: { nom: string; spec: SpecDeck; dossier?: string },
): Promise<{ ok: true; nodeId: string; nom: string; version: number; verification: VerificationDeck; taille: number; ms: number } | { ok: false; motif: string; verification?: VerificationDeck }> {
  const nom = /\.pptx$/i.test(opts.nom.trim()) ? opts.nom.trim() : `${opts.nom.trim() || opts.spec.titre || "Présentation Adam"}.pptx`;
  let construit;
  try {
    construit = await construireDeckVerifie({ ...opts.spec, auteur: opts.spec.auteur ?? user.name ?? "Adam" });
  } catch (e) {
    return { ok: false, motif: `Spécification invalide : ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!construit.verification.ok) {
    return { ok: false, motif: `Le deck n'a pas été écrit : ${construit.verification.bloquants.slice(0, 6).join(" ; ")}`, verification: construit.verification };
  }
  const cree = await portsArtefact.documents.creerFichier(user.id, { nom, octets: construit.octets, mime: MIME_PPTX, dossier: opts.dossier });
  await portsArtefact.audit.tracer({ userId: user.id, action: "deck_build", cible: cree.nodeId, detail: `deck construit et contrôlé : ${construit.verification.diapos} diapositive(s), ${construit.verification.avertissements.length} avertissement(s)` });
  return { ok: true, nodeId: cree.nodeId, nom, version: cree.version, verification: construit.verification, taille: construit.octets.length, ms: construit.ms };
}
