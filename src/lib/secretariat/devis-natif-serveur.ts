import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { moneyEntityOf } from "@/lib/company";
import { enSerie } from "@/lib/refs";
import { etatsDesBC, type EtatBC } from "@/lib/bons-de-commande/etat";
import { emettreDocumentDrive, previsualiserDocument, type ApercuDocument, type DemandeDocument } from "@/platform/in-process/artifact/factory";
import { appliquerCorrections, type SaisieBc } from "@/lib/bons-de-commande/brouillon";
import { prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import {
  lireDevisNatif, bcsAGenerer, tvaParDefaut, totauxDesLignes, enLignesCommerciales,
  type DevisNatif, type DevisDeLaDemande, type BcAGenerer,
} from "@/lib/secretariat/devis-natif";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS NATIFS D'UNE DEMANDE — la LECTURE et les ÉCRITURES (la règle est dans `devis-natif.ts`).
 *
 * Hors d'un fichier « use server » : l'auteur est un ARGUMENT (§118.153) — exporté d'un tel fichier,
 * ce serait un point d'entrée où n'importe qui écrirait au nom de n'importe qui. Les gardes (qui
 * retranscrit, qui retient, qui génère) vivent dans les actions (`secretariat-devis-actions.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un devis de la demande, tel que la fiche le montre. */
export interface DevisLu extends DevisDeLaDemande {
  montant: number | null;
  creeLe: Date;
  /** Le fichier du fournisseur (le premier joint à la pièce), à ouvrir à côté des lignes. */
  fichier: { id: string; name: string } | null;
}

export interface LectureDevisDemande {
  devis: DevisLu[];
  /** Les BC de la demande, avec leur état lu à la source (`etatsDesBC`). */
  bcs: EtatBC[];
  /** Les BC EN VIE (non annulés) — ceux qui « commandent » une ligne. */
  bcsActifs: Set<string>;
  /** Les BC à générer maintenant, un par fournisseur. */
  aGenerer: BcAGenerer[];
}

export async function devisDeLaDemande(requestId: string): Promise<LectureDevisDemande> {
  const [quotes, orders] = await Promise.all([
    prisma.legalDocument.findMany({
      where: { sourceType: "ADMIN_REQUEST", sourceId: requestId, kind: "QUOTE" },
      select: { id: true, reference: true, title: true, status: true, custom: true, amount: true, createdAt: true, counterparty: true, counterpartyIds: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.legalDocument.findMany({
      where: { sourceType: "ADMIN_REQUEST", sourceId: requestId, kind: "PURCHASE_ORDER" },
      select: { id: true }, orderBy: { createdAt: "asc" },
    }),
  ]);
  const fichiers = quotes.length
    ? await prisma.document.findMany({
        where: { entityType: "LEGAL_DOCUMENT", entityId: { in: quotes.map((q) => q.id) } },
        select: { id: true, name: true, entityId: true }, orderBy: { createdAt: "asc" },
      })
    : [];
  const premierFichier = new Map<string, { id: string; name: string }>();
  for (const f of fichiers) if (f.entityId && !premierFichier.has(f.entityId)) premierFichier.set(f.entityId, { id: f.id, name: f.name });
  const etats = await etatsDesBC(orders.map((o) => o.id));
  const bcs = orders.map((o) => etats.get(o.id)).filter((e): e is EtatBC => Boolean(e));
  const bcsActifs = new Set(bcs.filter((b) => !b.annule).map((b) => b.id));
  const devis: DevisLu[] = quotes.map((q) => ({
    id: q.id, reference: q.reference, titre: q.title, annule: q.status === "CANCELLED",
    natif: lireDevisNatif(q.custom) ?? devisPasEncoreRetranscrit(q),
    montant: q.amount != null ? Number(q.amount) : null,
    creeLe: q.createdAt,
    fichier: premierFichier.get(q.id) ?? null,
  }));
  return { devis, bcs, bcsActifs, aGenerer: bcsAGenerer(devis, bcsActifs) };
}

/** Un devis déposé, pas encore retranscrit : son fournisseur vient de la pièce, il n'a aucune ligne. */
function devisPasEncoreRetranscrit(q: { counterparty: string | null; counterpartyIds: string[] }): DevisNatif {
  return { v: 1, version: 0, fournisseurId: q.counterpartyIds[0] ?? null, fournisseur: q.counterparty ?? "", date: null, lignes: [], saisiPar: null, saisiLe: null };
}

/** Un identifiant de ligne — stable d'une retranscription à l'autre. */
export const nouvelIdDeLigne = (): string => randomUUID().slice(0, 12);

/**
 * ÉCRIRE `custom.devisNatif` — et ELLE SEULE, sous VERROU DE VERSION. `jsonb_set` ne touche que sa
 * clé, sur la valeur présente en base (`custom.fabrique`, `custom.intelligence` restent) ; la
 * condition sur la version relue fait qu'une écriture concurrente n'est jamais recouverte : elle
 * rend `false`, et l'appelant relit. Le montant de la pièce suit le total TTC des lignes.
 */
export async function ecrireDevisNatif(docId: string, versionLue: number, devis: DevisNatif, opts: { userId: string; montant: number | null }): Promise<boolean> {
  const valeur = JSON.stringify(devis);
  const n = await prisma.$executeRaw`UPDATE "LegalDocument"
    SET custom = jsonb_set(CASE WHEN jsonb_typeof(custom) = 'object' THEN custom ELSE '{}'::jsonb END, '{devisNatif}', ${valeur}::jsonb, true),
        "amount" = ${opts.montant}::numeric,
        "updatedAt" = now(), "updatedById" = ${opts.userId}
    WHERE id = ${docId} AND COALESCE((custom->'devisNatif'->>'version')::int, 0) = ${versionLue}`;
  return n > 0;
}

/** Une file par devis : deux gestes sur les mêmes lignes passent l'un après l'autre dans ce processus. */
export const fileDuDevis = (docId: string) => `secretariat-devis:${docId}`;

/** Relit les lignes d'un devis (dans sa file) — `null` si la pièce n'est plus un devis de cette demande. */
export async function devisNatifDe(docId: string, requestId: string): Promise<{ doc: { id: string; reference: string | null; title: string; status: string }; natif: DevisNatif | null } | null> {
  const doc = await prisma.legalDocument.findFirst({
    where: { id: docId, kind: "QUOTE", sourceType: "ADMIN_REQUEST", sourceId: requestId },
    select: { id: true, reference: true, title: true, status: true, custom: true },
  });
  if (!doc) return null;
  return { doc: { id: doc.id, reference: doc.reference, title: doc.title, status: doc.status }, natif: lireDevisNatif(doc.custom) };
}

// ─────────────────────────── Générer le BC d'un fournisseur ───────────────────────────

/** Le fournisseur tel que le BC l'imprime : la fiche de l'annuaire quand le devis la désigne, sinon le nom. */
async function tiersDuFournisseur(g: Pick<BcAGenerer, "fournisseurId" | "fournisseur">) {
  if (g.fournisseurId) {
    const f = await prisma.companyContact.findUnique({
      where: { id: g.fournisseurId },
      select: { name: true, address: true, city: true, wilaya: true, rc: true, nif: true, rib: true, phone: true, email: true },
    });
    if (f) {
      const adresse = [f.address, [f.city, f.wilaya].filter(Boolean).join(", ")].filter((x) => x && x.trim()).join("\n") || null;
      return { nom: f.name, adresse, rc: f.rc, nif: f.nif, rib: f.rib, telephone: f.phone, email: f.email };
    }
  }
  return { nom: g.fournisseur };
}

export type ResultatGeneration =
  | { ok: true; bcId: string; reference: string; totalTtc: number; reserve: string | null; dejaEmis: boolean }
  | { ok: false; error: string };

type DemandeDuBC = { id: string; reference: string; title: string; companyId: string | null; requesterId: string | null; assignedToId: string | null };

/**
 * LA DEMANDE DE LA FABRIQUE POUR LE BC D'UN FOURNISSEUR — la MÊME pour l'aperçu et pour l'émission (§118.5) : les lignes
 * retenues, le fournisseur de l'annuaire, les devis amont ; puis, PAR-DESSUS, ce que le demandeur a corrigé dans l'aperçu
 * (`appliquerCorrections` — fournisseur, lignes, dates, paiement, TVA, remises, taxes, livraison, contact, notes, papier,
 * émetteur, signataire, mentions). Rien n'est lu de l'écran ici : la saisie arrive DÉJÀ lue (`lireSaisieDuComposeur`).
 */
async function composerDemandeDuBC(demande: DemandeDuBC, g: BcAGenerer, societe: string, saisie: SaisieBc | null): Promise<DemandeDocument> {
  const refs = g.devis.map((d) => d.reference?.trim()).filter((x): x is string => Boolean(x));
  const duDevis: DemandeDocument = {
    type: "BON_DE_COMMANDE",
    societe,
    tiers: await tiersDuFournisseur(g),
    lignes: enLignesCommerciales(g.lignes),
    tvaDefaut: tvaParDefaut(g.lignes),
    referenceAmont: refs.length ? refs.join(", ") : null,
    referenceAmontDate: g.devis[0]?.date ?? null,
    objet: `${demande.reference} — ${demande.title}`,
    chainFromId: g.devis[0].id,
    dossier: `Bureau du secrétariat/${demande.reference}`,
  };
  if (!saisie) return duDevis;
  const { lignes, ...corrections } = saisie;
  return { ...appliquerCorrections(duDevis, corrections), ...(lignes && lignes.length > 0 ? { lignes } : {}) };
}

/** Le fournisseur à commander et la société qui commande — les refus communs à l'aperçu et à l'émission. */
async function cadreDuBC(demande: DemandeDuBC, cle: string, lu?: LectureDevisDemande): Promise<{ ok: true; g: BcAGenerer; societe: string } | { ok: false; error: string }> {
  const g = (lu ?? await devisDeLaDemande(demande.id)).aGenerer.find((x) => x.cle === cle);
  if (!g) return { ok: false, error: "Rien à commander chez ce fournisseur : aucune ligne retenue qui ne soit déjà portée par un bon de commande. Rechargez la fiche." };
  if (!g.fournisseur.trim()) return { ok: false, error: "Le fournisseur de ce devis n'est pas nommé : l'assistante doit le choisir dans l'annuaire avant la génération." };
  const societe = demande.companyId ?? (demande.requesterId ? await moneyEntityOf(demande.requesterId) : null);
  if (!societe) return { ok: false, error: "Cette demande n'est rattachée à aucune société : le bon de commande ne sait pas au nom de qui commander." };
  return { ok: true, g, societe };
}

const delegationDuBC = (demande: DemandeDuBC, g: BcAGenerer): string => {
  const refs = g.devis.map((d) => d.reference?.trim()).filter((x): x is string => Boolean(x));
  return `${demande.reference} — bon de commande composé d'après les lignes retenues par le demandeur sur ${g.devis.length > 1 ? `les devis ${refs.join(", ") || "de la demande"}` : `le devis ${refs[0] ?? "de la demande"}`} (${g.fournisseur})`;
};

/**
 * L'APERÇU DU BC D'UN FOURNISSEUR (Direction, 14/10/2026 — « Je veux l'aperçu obligatoire ») — la pièce telle qu'elle serait émise,
 * composée À BLANC : aucun numéro consommé, rien au registre ni au Drive, RIEN d'écrit sur la demande. `saisie` : ce que le
 * composeur montre (absente à l'ouverture : la pièce telle que les devis la donnent).
 */
export async function apercuBCDuFournisseur(
  user: CurrentUser, demande: DemandeDuBC, cle: string, saisie: SaisieBc | null, opts: { avecPdf?: boolean } = {},
): Promise<{ ok: true; r: ApercuDocument; demande: DemandeDocument } | { ok: false; error: string }> {
  const c = await cadreDuBC(demande, cle);
  if (!c.ok) return c;
  const dem = await composerDemandeDuBC(demande, c.g, c.societe, saisie);
  const r = await previsualiserDocument(user, dem, {
    avecPdf: opts.avecPdf, delegation: `${delegationDuBC(demande, c.g)} — aperçu relu par le demandeur`, numeroAffiche: "À attribuer à la validation",
  });
  if (!r.ok) return { ok: false, error: r.motif };
  return { ok: true, r, demande: dem };
}

/**
 * GÉNÉRER LE BON DE COMMANDE D'UN FOURNISSEUR — par la FABRIQUE (même numérotation, même papier
 * en-tête, même Word et PDF que les BC des Finances et d'Ad & Pro), sous DÉLÉGATION de la demande :
 * le demandeur n'a pas Legal, c'est sa demande — gérée par le secrétariat, ses lignes retenues par
 * lui — qui l'autorise à commander au nom de la société DE LA DEMANDE. La fabrique pose la porte
 * du BC (`aiguillerBC` : centre de validations au-dessus de son seuil, sinon la signature).
 *
 * Il n'est émis QUE depuis son aperçu (Direction, 14/10/2026) : `saisie` est ce que le demandeur a relu et corrigé dans le
 * composeur, et c'est elle qui part — `numeroChoisi` : la référence choisie au registre commun NNN/DG/AAAA.
 *
 * Les lignes retenues sont marquées « portées par ce BC » dans chacun de leurs devis, sous le verrou
 * de version de chaque devis. L'appelant a vérifié QUI génère et l'état de la demande.
 */
export async function genererBCDuFournisseur(
  user: CurrentUser,
  demande: DemandeDuBC,
  cle: string,
  saisie: SaisieBc,
  numeroChoisi: string | null = null,
): Promise<ResultatGeneration> {
  return enSerie(`secretariat-bc:${demande.id}`, async () => {
    const c = await cadreDuBC(demande, cle);
    if (!c.ok) return c;
    const { g, societe } = c;
    const dem = await composerDemandeDuBC(demande, g, societe, saisie);
    const r = await emettreDocumentDrive(user, { ...dem, ...(numeroChoisi ? { numeroChoisi } : {}) }, {
      source: { type: "ADMIN_REQUEST", id: demande.id },
      delegation: `${delegationDuBC(demande, g)}, aperçu validé par le demandeur`,
    });
    if (!r.ok) return { ok: false, error: r.motif + (r.bloquants?.length ? ` — ${r.bloquants.slice(0, 3).join(" ; ")}` : "") };

    // LES LIGNES COMMANDÉES — chaque devis sous sa file et son verrou ; une version qui a bougé est relue une fois.
    const parDevis = new Map<string, Set<string>>();
    for (const l of g.lignes) parDevis.set(l.devisId, (parDevis.get(l.devisId) ?? new Set()).add(l.id));
    for (const [devisId, lignes] of parDevis) {
      await enSerie(fileDuDevis(devisId), async () => {
        for (let essai = 0; essai < 3; essai += 1) {
          const d = await devisNatifDe(devisId, demande.id);
          if (!d?.natif) return;
          const apres: DevisNatif = { ...d.natif, version: d.natif.version + 1, lignes: d.natif.lignes.map((l) => (lignes.has(l.id) ? { ...l, bcId: r.legalDocumentId } : l)) };
          if (await ecrireDevisNatif(devisId, d.natif.version, apres, { userId: user.id, montant: totauxDesLignes(apres.lignes).ttc })) return;
        }
      });
    }

    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: demande.id,
      summary: `Bon de commande ${r.reference} généré pour ${g.fournisseur}, aperçu validé par le demandeur — ${Math.round(r.totaux.totalTtc).toLocaleString("fr-FR")} DZD TTC (${g.lignes.length} ligne${g.lignes.length > 1 ? "s" : ""} retenue${g.lignes.length > 1 ? "s" : ""})`,
    });
    // L'ASSISTANTE LE VOIT : c'est elle qui suit la demande jusqu'au bout.
    await prevenirLeSecretariat(demande.assignedToId, {
      type: "GENERIC", title: "Bon de commande généré par le demandeur",
      body: `${demande.reference} — ${r.reference} (${g.fournisseur})`, link: `/demandes/${demande.id}`,
    }, user.id);
    return { ok: true, bcId: r.legalDocumentId, reference: r.reference, totalTtc: r.totaux.totalTtc, reserve: r.reserveBonDeCommande, dejaEmis: r.dejaEmis };
  });
}
