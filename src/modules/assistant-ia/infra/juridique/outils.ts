import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { journaliserGeste } from "@/platform/ia/hors-requete";
import { dossiersJuridiques, piecesJuridiquesLisibles } from "@/lib/actions/internes/legal/registre-lecture";
import { octetsDuFichier, peutVoirAuDrive } from "@/lib/actions/internes/documents/fichiers-lus";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { familleDe, niveauEcheance, replierTexte, type NatureRegistre } from "../../domaine/juridique/classement";
import { pagesDemandees } from "../../domaine/juridique/pdf";
import { resoudrePiece } from "../operations/pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T1 — LES LECTURES ET L'ASSEMBLAGE DU DOMAINE « DOCUMENTS » (décision 0051).
 *
 *   • `registre_juridique` — « donne-moi le dernier contrat de X », « quelles pièces expirent ce trimestre ? », « qu'y a-t-il
 *     dans le dossier Baux ? ». La porte est celle de l'écran : le module (Juridique, Finances pour la chaîne d'achat),
 *     l'entité, les LECTEURS DÉSIGNÉS (`legalReaderWhere` puis `accesAuxPiecesLegal`, la règle unitaire). Une pièce qu'on
 *     ne lit pas n'apparaît pas, ni son titre, ni son nom de fichier. Le FICHIER est remis par son lien `/drive/<id>`
 *     (l'écran le montre comme une pièce ouvrable, droits revérifiés — `piecesCitees`), seulement s'il est lisible au Drive.
 *   • `bilan_drive` — « checke le Drive » : doublons (même contenu), fichiers en vrac à la racine, pièces juridiques du
 *     Drive pas encore au registre, et, pour qui lit le Juridique : pièces expirées / à échéance, non classées, sans fichier.
 *   • `assembler_pdf` — fusionner des PDF, extraire des pages, réunir des images en un PDF : un NOUVEAU fichier dans le
 *     Drive (dossier « Atelier »), l'original intact, sous le journal J7 (annulable : le fichier créé est retiré).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const NATURE_FR: Record<string, string> = {
  CONTRACT: "Contrat", QUOTE: "Devis", PURCHASE_ORDER: "Bon de commande", INVOICE: "Facture", CREDIT_NOTE: "Avoir", AMENDMENT: "Avenant",
  AGREEMENT: "Convention", NDA: "Confidentialité", INSURANCE: "Assurance", LICENSE: "Agrément / licence", LEASE: "Bail", OTHER: "Autre",
};
const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const def = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ name, description, input_schema: { type: "object", properties, ...(required.length ? { required } : {}) } }) as PowerTool["def"];
const chaine = (e: Record<string, unknown>, k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : typeof e[k] === "number" ? String(e[k]) : "");

const ouvreLeRegistre = (u: CurrentUser) => userCan(u, "LEGAL", "VIEW") || userCan(u, "FINANCES", "VIEW");

const piecesLisibles = piecesJuridiquesLisibles;

async function lienFichier(user: CurrentUser, nodeId: string | null): Promise<string | null> {
  if (!nodeId) return null;
  return (await peutVoirAuDrive(user, nodeId)) ? `/drive/${nodeId}` : null;
}

async function registreJuridique(user: CurrentUser, e: Record<string, unknown>): Promise<string> {
  if (!ouvreLeRegistre(user)) {
    return JSON.stringify({ statut: "REFUS", raison: "Le registre juridique ne vous est pas ouvert (module Juridique). Rien n'est listé — demandez à la juriste ou à la Direction." });
  }
  const recherche = chaine(e, "recherche");
  const partie = chaine(e, "partie");
  const dossier = chaine(e, "dossier");
  const famille = chaine(e, "nature") ? familleDe(chaine(e, "nature")) : null;
  const echeance = chaine(e, "echeance");
  const joursEcheance = /expir/i.test(echeance) ? 0 : Number(echeance.replace(/\D/g, "")) || null;
  const maintenant = new Date();
  const ET: object[] = [];
  if (famille) ET.push({ kind: famille.nature as NatureRegistre });
  if (echeance) {
    ET.push(joursEcheance === 0
      ? { endDate: { lt: maintenant }, status: { in: ["ACTIVE", "EXPIRED"] } }
      : { endDate: { gte: maintenant, lte: new Date(maintenant.getTime() + (joursEcheance ?? 90) * 86_400_000) }, status: "ACTIVE" });
  }
  if (!chaine(e, "inclureAnnulees")) ET.push({ status: { not: "CANCELLED" } });
  // Partie, dossier, mots : comparés SANS ACCENTS par le code (« agrements », « siege ») — Postgres ne les replie pas.
  const mots = replierTexte(recherche).split(/[^a-z0-9]+/).filter((m) => m.length >= 3).slice(0, 6);
  const filtre = partie || dossier || mots.length;
  const rows = (await piecesLisibles(user, { AND: ET }, filtre ? 1500 : 60)).filter((r) => {
    if (partie && !replierTexte(r.counterparty ?? "").includes(replierTexte(partie))) return false;
    if (dossier && !replierTexte(r.folder?.name ?? "non classe").includes(replierTexte(dossier))) return false;
    const tout = replierTexte(`${r.title} ${r.counterparty ?? ""} ${r.reference ?? ""} ${r.notes ?? ""} ${r.folder?.name ?? ""}`);
    return mots.every((m) => tout.includes(m));
  });
  const dernier = /^(oui|true|1)$/i.test(chaine(e, "dernier"));
  const choisies = dernier ? rows.slice(0, 1) : rows.slice(0, Math.min(Number(chaine(e, "limite")) || 25, 40));
  const pieces = await Promise.all(choisies.map(async (r) => {
    const n = niveauEcheance(r.endDate, maintenant);
    return {
      titre: r.title, nature: NATURE_FR[r.kind] ?? r.kind, partie: r.counterparty, entite: r.company?.name ?? null, dossier: r.folder?.name ?? "Non classé",
      reference: r.reference, debut: jour(r.startDate), echeance: jour(r.endDate), statut: r.status,
      alerte: n.niveau === "EXPIRE" ? `expirée depuis ${-n.jours!} j` : n.niveau === "IMMINENT" || n.niveau === "PROCHE" ? `expire dans ${n.jours} j` : null,
      montant: r.amount == null ? null : Number(r.amount), fiche: `/legal/${r.id}`,
      fichier: r.driveNode && !r.driveNode.isTrashed ? r.driveNode.name : null, lien: r.driveNode?.isTrashed ? null : await lienFichier(user, r.driveNodeId),
    };
  }));
  const dossiers = !recherche && !partie && !dossier && !famille && !echeance
    ? (await dossiersJuridiques(user)).sort((a, b) => a.name.localeCompare(b.name, "fr"))
    : [];
  return JSON.stringify({
    total: rows.length, affichees: pieces.length, pieces,
    ...(dossiers.length ? { dossiers: dossiers.map((d) => d.name) } : {}),
    consigne: pieces.length
      ? "Réponds avec ces pièces (tableau si plusieurs : titre, partie, échéance, dossier). Pour DONNER un fichier, recopie son `lien` (/drive/…) tel quel dans ta réponse : l'écran le remet comme pièce ouvrable. Une pièce sans `lien` : dis que son fichier n'est pas joint ou pas lisible au Drive."
      : "Aucune pièce lisible ne correspond : dis-le simplement, sans supposer qu'elle existe ailleurs.",
  });
}

async function bilanDrive(user: CurrentUser): Promise<string> {
  const maintenant = new Date();
  const fichiers = await prisma.driveNode.findMany({
    where: { ownerId: user.id, type: "FILE", isTrashed: false },
    select: { id: true, name: true, parentId: true, size: true, updatedAt: true },
    orderBy: { updatedAt: "desc" }, take: 2000,
  });
  // La DERNIÈRE version de chaque fichier (une lecture à plat, croissante : la plus récente l'emporte).
  const derniere = new Map((await prisma.fileVersion.findMany({ where: { nodeId: { in: fichiers.map((f) => f.id) } }, orderBy: { version: "asc" }, select: { nodeId: true, blobId: true } }))
    .map((v) => [v.nodeId, v.blobId]));
  const parBlob = new Map<string, typeof fichiers>();
  for (const f of fichiers) { const b = derniere.get(f.id); if (b) parBlob.set(b, [...(parBlob.get(b) ?? []), f]); }
  const doublons = [...parBlob.values()].filter((g) => g.length > 1).slice(0, 20).map((g) => ({ fichiers: g.map((f) => f.name), liens: g.map((f) => `/drive/${f.id}`), aGarder: g[g.length - 1]!.name }));
  const enVrac = fichiers.filter((f) => !f.parentId);
  const auRegistre = new Set((await prisma.legalDocument.findMany({ where: { driveNodeId: { in: fichiers.map((f) => f.id) } }, select: { driveNodeId: true } })).map((d) => d.driveNodeId));
  const aRanger = fichiers.filter((f) => !auRegistre.has(f.id)).map((f) => ({ f, fam: familleDe(f.name) }))
    .filter((x) => x.fam && !["QUOTE", "INVOICE", "PURCHASE_ORDER", "CREDIT_NOTE"].includes(x.fam.nature))
    .slice(0, 30).map((x) => ({ fichier: x.f.name, lien: `/drive/${x.f.id}`, nature: x.fam!.libelle, dossierPropose: x.fam!.dossier }));
  const sortie: Record<string, unknown> = {
    drive: {
      fichiers: fichiers.length, doublons, doublonsTotal: [...parBlob.values()].filter((g) => g.length > 1).length,
      aLaRacine: enVrac.length, exemplesALaRacine: enVrac.slice(0, 10).map((f) => f.name),
      piecesJuridiquesARanger: aRanger,
    },
  };
  if (ouvreLeRegistre(user)) {
    const pieces = await piecesLisibles(user, { status: { in: ["ACTIVE", "EXPIRED"] } }, 400);
    const lignes = pieces.map((r) => ({ r, n: niveauEcheance(r.endDate, maintenant) }));
    const resume = (xs: typeof lignes) => xs.slice(0, 15).map(({ r, n }) => ({ titre: r.title, partie: r.counterparty, echeance: jour(r.endDate), jours: n.jours, fiche: `/legal/${r.id}` }));
    sortie.juridique = {
      pieces: pieces.length,
      expirees: resume(lignes.filter((l) => l.n.niveau === "EXPIRE")), expireesTotal: lignes.filter((l) => l.n.niveau === "EXPIRE").length,
      aEcheance30j: resume(lignes.filter((l) => l.n.niveau === "IMMINENT")), aEcheance90j: resume(lignes.filter((l) => l.n.niveau === "PROCHE")),
      nonClassees: pieces.filter((r) => !r.folder).slice(0, 15).map((r) => r.title), nonClasseesTotal: pieces.filter((r) => !r.folder).length,
      sansFichier: pieces.filter((r) => !r.driveNodeId || r.driveNode?.isTrashed).slice(0, 15).map((r) => r.title),
    };
  }
  return JSON.stringify({
    ...sortie,
    consigne: "Fais un BILAN clair par rubrique (doublons, en vrac, à ranger au Juridique, expirées, à échéance, non classées, sans fichier), chiffres d'abord. "
      + "Propose les gestes utiles (ranger_au_juridique pour les pièces à ranger ; modifier_fiche_juridique pour une échéance) sans les faire sans accord. Rien n'a été modifié.",
  });
}

// ─────────────────────────────── Assembler des PDF ───────────────────────────────

const octetsDe = octetsDuFichier;

/** Fusionne / extrait (mupdf, greffe de pages) ou réunit des images (pdfkit). Pur octets → octets. */
export async function produirePdf(action: "fusionner" | "extraire" | "images_en_pdf", sources: { nom: string; octets: Buffer; mime: string }[], pages: string): Promise<Buffer | { erreur: string }> {
  if (action === "images_en_pdf") {
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument({ autoFirstPage: false });
    const morceaux: Buffer[] = [];
    doc.on("data", (c: Buffer) => morceaux.push(c));
    const fini = new Promise<void>((ok) => doc.on("end", () => ok()));
    for (const s of sources) {
      if (!/^image\/(png|jpe?g)$/i.test(s.mime) && !/\.(png|jpe?g)$/i.test(s.nom)) return { erreur: `« ${s.nom} » n'est pas une image PNG ou JPEG.` };
      doc.addPage({ size: "A4", margin: 28 });
      doc.image(s.octets, { fit: [539, 786], align: "center", valign: "center" });
    }
    doc.end();
    await fini;
    return Buffer.concat(morceaux);
  }
  const mupdf = await import("mupdf");
  const dst = new mupdf.PDFDocument();
  try {
    for (const s of sources) {
      if (!s.octets.subarray(0, 5).toString("latin1").startsWith("%PDF")) return { erreur: `« ${s.nom} » n'est pas un PDF (convertis-le d'abord avec convertir_document).` };
      const src = new mupdf.PDFDocument(new Uint8Array(s.octets));
      const n = src.countPages();
      const choix = action === "extraire" ? pagesDemandees(pages, n) : Array.from({ length: n }, (_, i) => i);
      if ("erreur" in choix) return { erreur: `« ${s.nom} » : ${choix.erreur}` };
      for (const i of choix) dst.graftPage(-1, src, i);
      (src as unknown as { destroy?: () => void }).destroy?.();
    }
    const buf = dst.saveToBuffer("garbage");
    return Buffer.from(buf.asUint8Array());
  } finally {
    (dst as unknown as { destroy?: () => void }).destroy?.();
  }
}

async function assemblerPdf(user: CurrentUser, e: Record<string, unknown>): Promise<string> {
  const action = chaine(e, "action") as "fusionner" | "extraire" | "images_en_pdf";
  if (!["fusionner", "extraire", "images_en_pdf"].includes(action)) return JSON.stringify({ statut: "INCOMPLET", raison: "`action` : fusionner, extraire ou images_en_pdf." });
  const refs = Array.isArray(e.documents) ? (e.documents as unknown[]).map(String) : chaine(e, "documents").split(/[;\n]|,(?=\s*\S+\.[a-z]{2,4}\b)/).map((x) => x.trim()).filter(Boolean);
  if (!refs.length) return JSON.stringify({ statut: "INCOMPLET", raison: "Nomme le ou les documents." });
  if (action === "fusionner" && refs.length < 2) return JSON.stringify({ statut: "INCOMPLET", raison: "Une fusion demande au moins deux PDF." });
  if (action === "extraire" && !chaine(e, "pages")) return JSON.stringify({ statut: "INCOMPLET", raison: "Quelles pages extraire (ex. « 1-3, 7 ») ?" });
  const sources: { nom: string; octets: Buffer; mime: string }[] = [];
  for (const ref of refs.slice(0, 20)) {
    const p = await resoudrePiece(user, ref);
    if ("erreur" in p) return JSON.stringify({ statut: "REFUS", raison: `« ${ref} » : ${p.erreur}` });
    const octets = await octetsDe(user, p.id);
    if (!octets) return JSON.stringify({ statut: "REFUS", raison: `« ${p.nom} » : contenu illisible ou inaccessible.` });
    const n = await prisma.driveNode.findUnique({ where: { id: p.id }, select: { mimeType: true } });
    sources.push({ nom: p.nom, octets, mime: n?.mimeType ?? "" });
  }
  const pdf = await produirePdf(action, sources, chaine(e, "pages"));
  // Une demande impossible (page hors document, fichier non PDF) : le fichier désigné EST le bon — on le dit et on s'arrête,
  // sans demander « s'agit-il d'un autre fichier ? » (banc T1, DOC-21).
  if ("erreur" in pdf) return JSON.stringify({ statut: "REFUS", raison: pdf.erreur, fichier: sources.map((x) => x.nom).join(", "), consigne: "Dis la raison en une phrase et ce que la personne peut demander à la place (les pages qui existent). Ne pose pas de question : le fichier désigné est le bon, rien n'a été créé." });
  const base = chaine(e, "nom").replace(/\.pdf$/i, "") || (action === "fusionner" ? `Fusion — ${sources.map((s) => s.nom.replace(/\.[a-z]+$/i, "")).join(" + ")}` : action === "extraire" ? `${sources[0]!.nom.replace(/\.[a-z]+$/i, "")} — pages ${chaine(e, "pages")}` : `${sources[0]!.nom.replace(/\.[a-z]+$/i, "")} (images)`);
  const nom = `${base.slice(0, 150)}.pdf`;
  const { resultat, gesteId } = await journaliserGeste(user, { origine: "carte", capaciteId: "outil:assembler_pdf", libelle: `PDF assemblé — ${nom}` },
    async () => portsArtefact.documents.creerFichier(user.id, { nom, octets: pdf, mime: "application/pdf", dossier: "Atelier" }));
  return JSON.stringify({
    statut: "FAIT", fichier: nom, lien: `/drive/${resultat.nodeId}`, octets: pdf.length, ...(gesteId ? { annulable: true } : {}),
    consigne: "Le PDF est créé dans le Drive (dossier « Atelier »), les originaux sont intacts. Recopie le `lien` tel quel pour le remettre. Il s'annule depuis « Ce que l'assistant a fait ».",
  });
}



export function outilsDocumentsT1(user: CurrentUser): PowerTool[] {
  const aSoi = (u: CurrentUser) => u.id === user.id;
  return [
    {
      def: def("registre_juridique",
        "LIT le REGISTRE JURIDIQUE (contrats, avenants, agréments, AMM, statuts, PV, assurances, baux, conventions…) que la personne peut ouvrir : "
        + "recherche par mot, partie, nature, dossier ; échéances (« expirees », « 30 », « 90 » jours) ; `dernier: oui` pour LA pièce la plus récente "
        + "(« donne-moi le dernier contrat de X »). Rend les fiches, leurs dossiers, et le LIEN du fichier à remettre.",
        {
          recherche: { type: "string" }, partie: { type: "string" }, nature: { type: "string", description: "contrat, avenant, agrément, AMM, statuts, assurance, bail…" },
          dossier: { type: "string" }, echeance: { type: "string", description: "« expirees », ou un nombre de jours (30, 90…)." },
          dernier: { type: "string", description: "« oui » : seulement la plus récente." }, limite: { type: "string" },
        }),
      allowed: aSoi, label: "Registre juridique lu",
      run: async (e, u) => registreJuridique(u, e ?? {}),
    },
    {
      def: def("bilan_drive",
        "CHECKE LE DRIVE de la personne : doublons (même contenu), fichiers en vrac à la racine, pièces juridiques pas encore rangées au registre ; et, si elle lit "
        + "le Juridique : pièces expirées, à échéance (30 / 90 j), non classées, sans fichier. Lecture seule.", {}),
      allowed: aSoi, label: "Drive vérifié",
      run: async (_e, u) => bilanDrive(u),
    },
    {
      def: def("assembler_pdf",
        "ASSEMBLE des PDF : `fusionner` plusieurs PDF en un (dans l'ordre donné), `extraire` des pages d'un PDF (« 1-3, 7 ») en un nouveau PDF, "
        + "`images_en_pdf` réunir des images (PNG/JPEG) en un PDF. Crée un NOUVEAU fichier dans le Drive (dossier « Atelier ») ; les originaux restent intacts. "
        + "Pour Word/Excel ↔ PDF, utilise convertir_document.",
        {
          action: { type: "string", enum: ["fusionner", "extraire", "images_en_pdf"] },
          documents: { type: "array", items: { type: "string" }, description: "Noms ou identifiants Drive, dans l'ordre." },
          pages: { type: "string", description: "Pour `extraire` : « 1-3, 7 »." },
          nom: { type: "string", description: "Nom du fichier produit (facultatif)." },
        }, ["action", "documents"]),
      allowed: aSoi, label: "PDF assemblé",
      run: async (e, u) => assemblerPdf(u, e ?? {}),
    },
  ];
}
